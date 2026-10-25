// 拾い上げ（docs/implementation.md 4.5・6.4 (3)・6.6 (4)・6.7 (2)・6.9 (1)）。推測（infer.ts）の後に、Gmail のラベルの付いたスレッドと、
// Slack で本人が :memo: を付けた投稿と、会議メモの本人担当の行動項目を候補にする（T1）。
// 時刻のカーソルは持たない。同時に 1 本。runs で起こすので、STOP の間は起きず、すべて停止で切れる
import type { DestChoice, InferenceSettings } from '@libretto/shared/api'
import { transition } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { jst } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { type Runs, Stopped } from '../runs.ts'
import { draftCard, flagInstructions, toCardContent } from './card.ts'
import { labelId, readThread, threadIds } from './gmail.ts'
import type { Google, GoogleFail } from './google.ts'
import { createInference, SLACK_DAYS } from './infer.ts'
import { createMeet, type MeetProblem } from './meet.ts'
import {
  markedBy,
  type Names,
  type RawMessage,
  reactionsPage,
  readPost,
  type Slack,
  type SlackFail,
  slackCandidateId,
} from './slack.ts'

export const RUN_KEY = '拾い上げ'
const PER_RUN = 20 // 1 回に読むスレッド・投稿の数。残りは次の回（6.4 (3)・6.6 (4)）
const SWEEP_PAGES = 4 // 先頭の 1 ページに加えて、前の回の続きから読むリアクションの一覧のページ数（6.6 (4)）
export const POLL_MS = 15 * 60_000
const DAY_MS = 86_400_000

type Deps = {
  home: string
  ledger: Ledger
  google: Google
  slack?: Slack | undefined
  invoke: (job: Job) => Promise<Outcome>
  runs: Runs
  label: () => string
  emoji: () => string
  inference: () => InferenceSettings
  candidatesChanged: () => void
  connectionsChanged: () => void
  log: (line: string) => void
  now?: () => Date
  destChoices: () => DestChoice[] // 今選べる保存先（6.10 (3)）
}

export type Poller = ReturnType<typeof createPoller>
type Problem = 'rate_limited' | 'network' | undefined

export function createPoller(d: Deps) {
  const now = d.now ?? (() => new Date())
  let running: Promise<void> | undefined
  let lastAt: string | undefined
  let startedAt = 0
  let labelFound: boolean | undefined
  let problem: 'rate_limited' | 'network' | 'api_disabled' | undefined
  // Drive は連携のたびに 1 度だけ先に問い合わせ、無効と分かったあいだは毎回見直す（直したら消える）
  let docsProblem: 'api_disabled' | undefined
  let docsCheckedAt = -1
  const sl: { lastAt?: string; problem: Problem; sweep?: string | undefined } = { problem: undefined }
  const mt: { lastAt?: string; problem?: MeetProblem | undefined } = {}
  const meet = createMeet({ ...d, now })
  const inference = createInference({ ...d, settings: d.inference, now })

  // 失敗は連携の欄に出す。auth_expired は google / slack の側が覚える
  const why = (f: GoogleFail | SlackFail): Problem =>
    f.why === 'rate_limited' || f.why === 'network' ? f.why : f.why === 'rejected' ? 'network' : undefined
  const failed = (f: GoogleFail) => {
    // API が有効でない（Gmail だけ）はそのまま出す
    problem = f.why === 'api_disabled' ? 'api_disabled' : (why(f) ?? problem)
  }
  const slackFailed = (f: SlackFail) => {
    // 権限が足りない（missing_scope）は slack の側が名前で覚える
    if (f.why !== 'rejected') sl.problem = why(f) ?? sl.problem
  }

  // 推測で先に出ていた候補に合図が付いた: 1 件のまま由来を合図に（設計書 4.2.2）。推測が先に見つけていたので
  // 自己測定は「見つけていた」（6.9 (8)）。新しいもの・推測が「頼んでいない」としたものは true（合図として出す）
  function fresh(candidateId: string, signal: 'gmail_label' | 'slack_emoji'): boolean {
    const c = d.ledger.getCandidate(candidateId)
    if (!c || c.status === 'not_request') return true
    if (c.origin !== '推測') return false
    const sample = { type: 'recall_sample' as const, candidateId, signalAt: jst(now()), inferredBefore: true }
    if (c.status === 'presented') {
      d.ledger.transaction(() => {
        d.ledger.appendCandidateEvent(
          { type: 'promoted_to_signal', candidateId, signal },
          { status: 'presented', origin: '合図' },
        )
        if (!d.ledger.hasRecallSample(candidateId)) d.ledger.appendCandidateEvent(sample)
      })
      d.candidatesChanged()
    } else if (!d.ledger.hasRecallSample(candidateId)) d.ledger.appendCandidateEvent(sample) // 見送った・進めた
    return false
  }

  // 新しい合図が推測の範囲の中か（自己測定の分母。6.9 (8)）。推測が「頼んでいない」とした行は範囲の中
  const recallIf = (candidateId: string, inScope: boolean) => {
    const was = d.ledger.getCandidate(candidateId)?.status === 'not_request'
    return was || (inScope && d.inference().dailyLimit > 0) ? { recall: { signalAt: jst(now()) } } : {}
  }

  async function gmailOnce(signal: AbortSignal) {
    const g = d.google
    const generation = g.generation()
    const account = g.status().email ?? ''
    if (g.status().docs && (docsCheckedAt !== generation || docsProblem)) {
      const r = await g.drive('/drive/v3/about?fields=kind', {}, signal)
      if (g.generation() !== generation) return
      // 届かないなど決め手の無い失敗では、前の判断も「確かめた」印も変えない（次の回にもう一度）
      if (r.ok || r.why === 'api_disabled') {
        docsCheckedAt = generation
        docsProblem = r.ok ? undefined : 'api_disabled'
      }
    }
    const label = await labelId(g, d.label(), signal)
    if (!label.ok) return failed(label)
    labelFound = !!label.id
    if (!label.id) return
    const listed = await threadIds(g, label.id, signal)
    if (!listed.ok) return failed(listed)

    const ids = listed.ids.filter((id) => fresh(`gmail:${id}`, 'gmail_label'))
    // 古い順に PER_RUN 件まで（一覧は新しい順で返る）
    for (const id of ids.reverse().slice(0, PER_RUN)) {
      if (signal.aborted || g.generation() !== generation) return
      const r = await readThread(g, id, account, signal)
      if (!r.ok) return failed(r)
      const t = r.thread
      const deps = { home: d.home, invoke: d.invoke, signal, dests: d.destChoices() }
      const flagged = await flagInstructions(deps, t.subject, t.body)
      if (flagged === 'stopped') return
      const drafted = await draftCard(deps, t)
      if (!drafted.ok && drafted.stopped) return
      if (g.generation() !== generation) return
      const set = d.inference()
      const inScope =
        t.primary &&
        t.toMe &&
        !t.self &&
        t.lastMs >= now().getTime() - set.gmailDays * DAY_MS &&
        !d.ledger.isSuppressed('sender', t.senderKey)
      transition(d.ledger, {
        type: 'candidate.presented',
        candidate: {
          candidateId: `gmail:${id}`,
          source: 'gmail',
          origin: '合図',
          aiInstructionFlag: flagged,
          senderKey: t.senderKey,
        },
        card: toCardContent(t, drafted.ok ? drafted.draft : undefined, account),
        ...recallIf(`gmail:${id}`, inScope),
      })
      d.candidatesChanged()
    }
    problem = undefined
    lastAt = jst(now())
  }

  async function slackOnce(s: Slack, signal: AbortSignal) {
    const who = await s.whoami(signal)
    if (!who.ok) return slackFailed(who)
    const me = who.me
    const emoji = d.emoji()
    // 先頭の 1 ページと、前の回の続きから SWEEP_PAGES ページ。最後まで行ったら次の回は先頭の続きから（6.6 (4)）
    const first = await reactionsPage(s, undefined, signal)
    if (!first.ok) return slackFailed(first)
    const items = [...first.items]
    let cursor = sl.sweep ?? first.next
    for (let i = 0; i < SWEEP_PAGES && cursor; i++) {
      const p = await reactionsPage(s, cursor, signal)
      if (!p.ok) {
        // 古くなった続きの位置は捨てて、次の回は先頭の続きから
        if (p.why === 'rejected') cursor = undefined
        else return slackFailed(p)
        break
      }
      items.push(...p.items)
      cursor = p.next
    }
    sl.sweep = cursor

    // 同じ投稿は一覧に何度か出る（1 つの投稿に本人が複数のリアクション）。候補 id で重ねる
    const found = new Map<string, { channel: string; message: RawMessage }>()
    for (const it of items) {
      if (it.type !== 'message' || !it.channel || !it.message || !markedBy(it.message, emoji, me.userId)) continue
      const id = slackCandidateId(it.channel, it.message.ts)
      if (!found.has(id) && fresh(id, 'slack_emoji')) found.set(id, { channel: it.channel, message: it.message })
    }
    // 古い順に PER_RUN 件まで（ts の小さい順）
    const names: Names = new Map() // 同じ人を回の中で何度も引かない（6.6 (4)）
    const queue = [...found.values()].sort((a, b) => Number(a.message.ts) - Number(b.message.ts)).slice(0, PER_RUN)
    for (const { channel, message } of queue) {
      if (signal.aborted) return
      const r = await readPost(s, me, channel, message.ts, message, signal, names)
      if (!r.ok) return slackFailed(r)
      const p = r.post
      const deps = { home: d.home, invoke: d.invoke, signal, dests: d.destChoices() }
      const flagged = await flagInstructions(deps, p.subject, p.body)
      if (flagged === 'stopped') return
      const drafted = await draftCard(deps, { ...p, slack: true })
      if (!drafted.ok && drafted.stopped) return
      // 要約を待つ間にトークンを入れ直された・消された（その回は止めてある）: 前のトークンで読んだ投稿を出さない
      if (signal.aborted) return
      // チャンネル（DM でない）で、選んだチャンネルか本人宛てのメンション（検索の権限があるとき）、7 日の中、除外していない
      const set = d.inference()
      const mentioned =
        (message.text ?? '').includes(`<@${me.userId}>`) && !s.status().missingScopes.includes('search:read')
      const inScope =
        p.subject.startsWith('#') &&
        (set.slackChannels.includes(channel) || mentioned) &&
        Number(message.ts) * 1000 >= now().getTime() - SLACK_DAYS * DAY_MS &&
        !d.ledger.isSuppressed('channel', channel)
      transition(d.ledger, {
        type: 'candidate.presented',
        candidate: {
          candidateId: p.candidateId,
          source: 'slack',
          origin: '合図',
          aiInstructionFlag: flagged,
          senderKey: p.senderKey,
        },
        card: toCardContent(p, drafted.ok ? drafted.draft : undefined, me.userId),
        ...recallIf(p.candidateId, inScope),
      })
      d.candidatesChanged()
    }
    sl.problem = undefined
    sl.lastAt = jst(now())
  }

  // 会議メモは連携に Meet のファイルの許可があるときだけ（6.7 (1)）
  async function meetOnce(signal: AbortSignal) {
    const r = await meet.once(signal)
    if (r === 'stopped') return
    mt.problem = r
    if (!r) mt.lastAt = jst(now())
  }

  // 推測の後に Gmail、Slack、会議メモ。どれかの失敗はほかを止めない（6.6 (4)・6.7 (2)・6.9 (1)）。推測を先に見るのは、
  // 届いたばかりのものを推測が見てから合図を見るため（自己測定。6.9 (1)）
  async function once(signal: AbortSignal) {
    const google = () => d.google.status()
    try {
      await inference.once(signal)
    } catch (e) {
      if (signal.aborted) return
      d.log(`inference: ${e instanceof Error ? e.stack : String(e)}`)
    }
    if (signal.aborted) return
    if (google().state === 'connected') await gmailOnce(signal)
    if (d.slack?.configured() && !signal.aborted) await slackOnce(d.slack, signal)
    if (google().state === 'connected' && google().meet && !signal.aborted) await meetOnce(signal)
  }

  // 走っていれば同じ回に乗る。どちらもつながっていない・止まっている間は何もしない
  function run(): Promise<void> {
    if (running) return running
    if (d.google.status().state !== 'connected' && !d.slack?.configured()) return Promise.resolve()
    let ac: AbortController
    try {
      ac = d.runs.open(RUN_KEY)
    } catch (e) {
      if (e instanceof Stopped) return Promise.resolve()
      throw e
    }
    startedAt = now().getTime()
    running = once(ac.signal)
      .catch((e) => {
        if (!ac.signal.aborted) d.log(`intake: ${e instanceof Error ? e.stack : String(e)}`)
      })
      .finally(() => {
        d.runs.close(RUN_KEY, ac)
        running = undefined
        d.connectionsChanged()
        d.candidatesChanged()
      })
    d.runs.watch(RUN_KEY, running)
    d.connectionsChanged()
    return running
  }

  return {
    run,
    // 画面を開いたとき。前の回から minMs たっていれば起こす
    maybe(minMs = 60_000) {
      if (now().getTime() - startedAt >= minMs) void run()
    },
    view: () => ({
      running: !!running,
      ...(lastAt && { lastAt }),
      ...(labelFound !== undefined && { labelFound }),
      ...(problem && { problem }),
      ...(docsProblem && { docsProblem }),
    }),
    slackView: () => ({ ...(sl.lastAt && { lastAt: sl.lastAt }), ...(sl.problem && { problem: sl.problem }) }),
    inferenceView: () => inference.view(),
    meetView: () => ({ ...(mt.lastAt && { meetLastAt: mt.lastAt }), ...(mt.problem && { meetProblem: mt.problem }) }),
  }
}
