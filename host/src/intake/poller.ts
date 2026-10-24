// 拾い上げ（docs/implementation.md 4.5・6.4 (3)）。Gmail のラベルの付いたスレッドを候補にする（T1）。時刻のカーソルは持たない。
// 同時に 1 本。runs で起こすので、STOP の間は起きず、すべて停止で切れる
import { transition } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { jst } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { type Runs, Stopped } from '../runs.ts'
import { draftCard, flagInstructions, toCardContent } from './card.ts'
import { labelId, readThread, threadIds } from './gmail.ts'
import type { Google, GoogleFail } from './google.ts'

export const RUN_KEY = '拾い上げ'
const PER_RUN = 20 // 1 回に読むスレッドの数。残りは次の回（6.4 (3)）
export const POLL_MS = 15 * 60_000

type Deps = {
  home: string
  ledger: Ledger
  google: Google
  invoke: (job: Job) => Promise<Outcome>
  runs: Runs
  label: () => string
  candidatesChanged: () => void
  connectionsChanged: () => void
  log: (line: string) => void
  now?: () => Date
}

export type Poller = ReturnType<typeof createPoller>

export function createPoller(d: Deps) {
  const now = d.now ?? (() => new Date())
  let running: Promise<void> | undefined
  let lastAt: string | undefined
  let startedAt = 0
  let labelFound: boolean | undefined
  let problem: 'rate_limited' | 'network' | undefined

  // 失敗は連携の欄に出す。auth_expired は google の側が覚える
  const failed = (f: GoogleFail) => {
    if (f.why === 'rate_limited' || f.why === 'network') problem = f.why
    else if (f.why === 'rejected') problem = 'network'
  }

  async function once(signal: AbortSignal) {
    const g = d.google
    const generation = g.generation()
    const account = g.status().email ?? ''
    const label = await labelId(g, d.label(), signal)
    if (!label.ok) return failed(label)
    labelFound = !!label.id
    if (!label.id) return
    const listed = await threadIds(g, label.id, signal)
    if (!listed.ok) return failed(listed)

    const fresh: string[] = []
    for (const id of listed.ids) {
      const candidateId = `gmail:${id}`
      const c = d.ledger.getCandidate(candidateId)
      if (!c) fresh.push(id)
      // 推測で先に出ていた候補にラベルが付いた: 1 件のまま由来を合図に（設計書 4.2.2）
      else if (c.origin === '推測' && c.status === 'presented') {
        d.ledger.transaction(() =>
          d.ledger.appendCandidateEvent(
            { type: 'promoted_to_signal', candidateId, signal: 'gmail_label' },
            { status: 'presented', origin: '合図' },
          ),
        )
        d.candidatesChanged()
      }
    }
    // 古い順に PER_RUN 件まで（一覧は新しい順で返る）
    for (const id of fresh.reverse().slice(0, PER_RUN)) {
      if (signal.aborted || g.generation() !== generation) return
      const r = await readThread(g, id, account, signal)
      if (!r.ok) return failed(r)
      const t = r.thread
      const deps = { home: d.home, invoke: d.invoke, signal }
      const flagged = await flagInstructions(deps, t.subject, t.body)
      if (flagged === 'stopped') return
      const drafted = await draftCard(deps, t)
      if (!drafted.ok && drafted.stopped) return
      if (g.generation() !== generation) return
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
      })
      d.candidatesChanged()
    }
    problem = undefined
    lastAt = jst(now())
  }

  // 走っていれば同じ回に乗る。連携していない・止まっている間は何もしない
  function run(): Promise<void> {
    if (running) return running
    if (d.google.status().state !== 'connected') return Promise.resolve()
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
    }),
  }
}
