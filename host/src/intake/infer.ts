// 推測の回（docs/implementation.md 6.9）。Gmail の受信箱と、Slack の本人宛てメンション・選んだチャンネルから、
// 文書づくりを頼まれていそうなものを可能性と理由付きの候補にする。頼んでいないものは id と判定だけを残す（設計書 10.2）
import type { DestChoice, InferenceSettings } from '@libretto/shared/api'
import { transition } from '../case/transition.ts'
import { detectInstructions, JEV_HEAD, ruleHit } from '../facts/instructions.ts'
import { jst, type Ledger } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { type CardSource, draftCard, toCardContent } from './card.ts'
import { classifyCandidate, type Incoming, prefilter } from './classify.ts'
import { inboxThreads, readThread } from './gmail.ts'
import type { Google } from './google.ts'
import { history, mentions, type Names, type RawMessage, readPost, type Slack, slackCandidateId } from './slack.ts'

const PER_RUN = 20 // 1 回に読んで分類する数（6.9 (5)）
const DAY_MS = 86_400_000
export const SLACK_DAYS = 7

type Item =
  | { source: 'gmail'; id: string; historyId?: string }
  | { source: 'slack'; channel: string; ts: string; message?: RawMessage }

// 受信箱のメイン・本人宛て・本人が送っていない。除外した差出人はクエリでも外す（読んだ後も確かめる）
export function gmailQuery(days: number, suppressed: readonly string[]) {
  const from = suppressed.filter((a) => /^[^\s"(){}]+$/.test(a)).map((a) => `-from:${a}`)
  return ['in:inbox', 'category:primary', `newer_than:${days}d`, '{to:me cc:me}', '-from:me', ...from].join(' ')
}

type Deps = {
  home: string
  ledger: Ledger
  google: Google
  slack?: Slack | undefined
  invoke: (job: Job) => Promise<Outcome>
  settings: () => InferenceSettings
  candidatesChanged: () => void
  now: () => Date
  destChoices: () => DestChoice[] // 今選べる保存先（6.10 (3)）
}

export function createInference(d: Deps) {
  const st: { lastAt?: string; skipped?: { day: string; n: number } | undefined } = {}
  const day = () => jst(d.now()).slice(0, 10)

  // 台帳に無いもの。Gmail の「頼んでいない」は、返信が来た（historyId が変わった）スレッドだけ分類し直す（6.9 (4)）
  function unseen(candidateId: string, historyId?: string) {
    const c = d.ledger.getCandidate(candidateId)
    if (!c) return true
    return c.status === 'not_request' && !!historyId && d.ledger.notRequestHistory(candidateId) !== historyId
  }

  async function gmailItems(set: InferenceSettings, senders: string[], signal: AbortSignal): Promise<Item[]> {
    if (d.google.status().state !== 'connected') return []
    const r = await inboxThreads(d.google, gmailQuery(set.gmailDays, senders), signal)
    if (!r.ok) return []
    // 古い順（一覧は新しい順で返る）
    return r.threads
      .filter((t) => unseen(`gmail:${t.id}`, t.historyId))
      .reverse()
      .map((t) => ({ source: 'gmail' as const, id: t.id, ...(t.historyId && { historyId: t.historyId }) }))
  }

  async function slackItems(set: InferenceSettings, s: Slack, channels: Set<string>, signal: AbortSignal) {
    const who = await s.whoami(signal)
    if (!who.ok) return { items: [] as Item[] }
    const oldest = (d.now().getTime() - SLACK_DAYS * DAY_MS) / 1000
    const found = new Map<string, Item & { source: 'slack' }>()
    // 検索の after: はその日を含まないので 1 日前から引き、ts で窓に絞る
    const m = await mentions(s, who.me, jst(new Date((oldest - 86_400) * 1000)).slice(0, 10), signal)
    if (m.ok)
      for (const f of m.found)
        if (Number(f.ts) >= oldest) found.set(slackCandidateId(f.channel, f.ts), { source: 'slack', ...f })
    for (const channel of set.slackChannels) {
      if (channels.has(channel)) continue
      const h = await history(s, channel, String(oldest), signal)
      if (!h.ok) continue
      for (const message of h.messages)
        found.set(slackCandidateId(channel, message.ts), { source: 'slack', channel, ts: message.ts, message })
    }
    const items = [...found]
      .filter(([id, x]) => !channels.has(x.channel) && unseen(id))
      .map(([, x]) => x)
      .sort((a, b) => Number(a.ts) - Number(b.ts))
    return { items, me: who.me }
  }

  // 止めた・費用の上限・1 日の上限で、その件を書かずに回を終える（6.9 (3)(6)）
  async function once(signal: AbortSignal): Promise<void> {
    const set = d.settings()
    if (!set.dailyLimit) return
    const g = d.google
    const generation = g.generation()
    const account = g.status().email ?? ''
    const sup = d.ledger.listSuppressions()
    const channels = new Set(sup.filter((x) => x.kind === 'channel').map((x) => x.value))
    const senders = sup.filter((x) => x.kind === 'sender').map((x) => x.value)

    const gq = await gmailItems(set, senders, signal)
    if (signal.aborted) return
    const sl = d.slack?.configured() ? await slackItems(set, d.slack, channels, signal) : { items: [] }
    if (signal.aborted) return
    // Gmail と Slack を交互に（片方が多くても、もう片方の分まで 1 日の上限を使い切らない。6.9 (5)）
    const queue: Item[] = []
    for (let i = 0; i < Math.max(gq.length, sl.items.length); i++) {
      const a = gq[i]
      const b = sl.items[i]
      if (a) queue.push(a)
      if (b) queue.push(b)
    }

    const names: Names = new Map()
    const dead = new Set<Item['source']>() // 読めなかった取り込み元はこの回はもう読まない
    let read = 0
    for (let i = 0; i < queue.length && read < PER_RUN; i++) {
      if (signal.aborted) return
      const it = queue[i] as Item
      if (dead.has(it.source)) continue
      if (d.ledger.classifiedCount(d.now()) >= set.dailyLimit) {
        st.skipped = { day: day(), n: queue.length - i }
        return
      }
      read++

      let m: Incoming
      let src: CardSource & Parameters<typeof toCardContent>[0]
      let candidateId: string
      let historyId: string | undefined
      let owner: string
      if (it.source === 'gmail') {
        const r = await readThread(g, it.id, account, signal)
        if (g.generation() !== generation) return
        if (!r.ok) {
          dead.add('gmail')
          continue
        }
        const t = r.thread
        if (d.ledger.isSuppressed('sender', t.senderKey)) continue
        m = { source: 'gmail', ...t }
        src = t
        candidateId = `gmail:${it.id}`
        historyId = it.historyId ?? t.historyId
        owner = account
      } else {
        const s = d.slack as Slack
        const r = await readPost(s, sl.me as NonNullable<typeof sl.me>, it.channel, it.ts, it.message, signal, names)
        if (!r.ok) {
          dead.add('slack')
          continue
        }
        const p = r.post
        // 投稿を読めなかった（履歴の権限が無いなど）: 判定を残さず、次の回にもう一度（空の本文で「頼んでいない」にしない）
        if (!p.body.trim()) continue
        m = { source: 'slack', ...p, latest: p.text, self: !p.othersPost, bulk: p.auto }
        src = { ...p, slack: true }
        candidateId = p.candidateId
        owner = sl.me?.userId ?? ''
      }
      const itemId = historyId ? `${candidateId}@${historyId}` : candidateId

      if (!prefilter(m)) {
        d.ledger.insertNotRequest(candidateId, m.source, { ...(historyId && { historyId }), prefiltered: true })
        continue
      }
      const c = await classifyCandidate(m, { home: d.home, invoke: d.invoke, signal, useJev: set.useJev })
      if (!c.ok) {
        if (c.stop) return
        continue // 次の回にもう一度
      }
      if (c.level === 'なし') {
        d.ledger.insertNotRequest(candidateId, m.source, { ...(historyId && { historyId }) }, itemId)
        continue
      }

      // 候補にする: 合図と同じに「AI への指示」の印とカードの要約。Jev に渡すのは件名と最新のメッセージの先頭 600 字
      const deps = { home: d.home, invoke: d.invoke, signal, dests: d.destChoices(), caseId: '推測' }
      const det = await detectInstructions(`${m.subject}\n${m.latest.slice(0, JEV_HEAD)}`, { ...deps, jev: set.useJev })
      if (!det.ok) return
      const flagged = det.flagged || [m.subject, ...m.body.split(/\r?\n/)].some(ruleHit)
      const drafted = await draftCard(deps, src)
      if (!drafted.ok && (drafted.stopped || drafted.budget)) return
      if (signal.aborted || (m.source === 'gmail' && g.generation() !== generation)) return
      d.ledger.transaction(() => {
        const r = transition(d.ledger, {
          type: 'candidate.presented',
          candidate: {
            candidateId,
            source: m.source,
            origin: '推測',
            confidence: c.level as '高' | '中' | '低',
            aiInstructionFlag: flagged,
            senderKey: m.senderKey,
          },
          card: { ...toCardContent(src, drafted.ok ? drafted.draft : undefined, owner), reason: c.reason },
        })
        if (r.ok) d.ledger.recordClassified(itemId)
      })
      d.candidatesChanged()
    }
    st.skipped = undefined
    st.lastAt = jst(d.now())
  }

  return {
    once,
    view: () => ({
      ...(st.lastAt && { lastAt: st.lastAt }),
      ...(st.skipped?.day === day() && { skippedToday: st.skipped.n }),
    }),
  }
}
