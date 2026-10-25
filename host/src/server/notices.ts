// お知らせの送り出し（docs/implementation.md 6.8 (2)(4)(5)）。コミットの後に呼ぶ。
// 新しいお知らせを SSE の notice で出し（画面がブラウザの通知 B を出す）、画面の外の送り先の pending を送る。
// 送り先は Web Push（push.ts）。Slack の DM は後の Issue が senders に足す。届いたことを書く前に落ちれば送り直すので、届くのは 1 回以上
import type { Notice, QuietHours } from '@libretto/shared/api'
import { type QuietCounts, quietEndText } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { Hub } from './sse.ts'

// 送り先 1 つに、届けるお知らせをまとめて渡す（Slack の 2 分のまとめが 1 通にできる）。
// gone は登録が無い（404 / 410）。登録を消すのは送り手。retry は 429・5xx・届かない
export type Sender = (target: string, notices: Notice[]) => Promise<'sent' | 'retry' | 'gone'>

const MIN = 60_000
const RETRY_MS = [1 * MIN, 5 * MIN, 30 * MIN] // 4 回目で dropped
const KEEP_MS = 24 * 60 * MIN

// 通知を止める時間帯か（6.8 (4)(14)）。[from, to) を、時間帯 timeZone（既定はホストの OS）の時・分で比べる
export function quietAt(at: Date, q: QuietHours | null, timeZone?: string): boolean {
  if (!q) return false
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    at,
  )
  return q.from < q.to ? q.from <= t && t < q.to : q.from <= t || t < q.to
}

export function createNotices(d: {
  ledger: Ledger
  hub: Hub
  senders?: Record<string, Sender> // 送り先の頭（push / slack）→ 送り手
  holdMs?: Record<string, number> // 送り先の頭 → まとめるあいだ（Slack の DM は 2 分）
  now?: () => Date
  quiet?: () => QuietHours | null // 通知を止める時間帯（settings.json）
  timeZone?: string // テストで渡す。既定はホストの OS
  log?: (line: string) => void
}) {
  const now = d.now ?? (() => new Date())
  const senders = d.senders ?? {}
  const quietNow = () => quietAt(now(), d.quiet?.() ?? null, d.timeZone)
  // 起動より前のお知らせは SSE で出し直さない（SSE の履歴はメモリだけ。5.7 (2)）
  let last = d.ledger.lastNoticeSeq()
  let running: Promise<void> | undefined
  let again = false

  // 確認待ちは、書いた後に案件が動いていれば（本人が答えた）もう出さない（6.8 (4)）
  const stale = (n: Notice) => {
    if (n.kind !== 'your_turn' || !n.caseId) return false
    return d.ledger.getCase(n.caseId)?.revision !== d.ledger.noticeRevision(n.id)
  }

  // 明けの 1 通（6.8 (14)）。止めていたあいだに出さなかった知らせを、案件ごとに最後の 1 行で数える。確認待ちはまだ確認待ちのものだけ、
  // 候補はまだ出したままのものだけ。0 件なら書かない。event_id の quiet:<seq> で同じ分を二度数えない
  function summarize() {
    const held = d.ledger.heldNotices()
    const last = held.at(-1)
    if (!last) return
    const byCase = new Map<string, Notice>()
    const counts: QuietCounts = {}
    for (const n of held)
      if (n.caseId) byCase.set(n.caseId, n)
      else if (n.kind === 'candidates') counts.candidates = (counts.candidates ?? 0) + d.ledger.candidatesStill(n.id)
    for (const n of byCase.values())
      if (n.kind !== 'info' && n.kind !== 'quiet' && n.kind !== 'candidates' && !stale(n))
        counts[n.kind] = (counts[n.kind] ?? 0) + 1
    const text = quietEndText(counts)
    if (text) d.ledger.appendNotice({ eventId: `quiet:${last.id}`, kind: 'quiet', text, path: '/', outside: true })
  }

  async function deliver() {
    // 止める時間帯は送らずに残す。明けたら、止めていたあいだの知らせは明けの 1 通にまとめたので送らない
    if (quietNow()) return
    const at = now()
    const groups = new Map<string, (Notice & { tries: number })[]>()
    for (const { target, held, ...n } of d.ledger.dueDeliveries(at)) {
      if (held || at.getTime() - Date.parse(n.at) > KEEP_MS)
        d.ledger.setDelivery(n.id, target, { status: 'dropped', tries: n.tries })
      else groups.set(target, [...(groups.get(target) ?? []), n])
    }
    for (const [target, due] of groups) {
      if (quietNow()) return // 送っているうちに時間帯に入ったら、残りは明けに
      const head = target.split(':')[0] as string
      // まとめて送る送り先（Slack の DM の 2 分。6.8 (4)）: 初めて送る分は、いちばん古いものから holdMs たつまで残す。送り直しは時刻どおり
      const fresh = due.find((n) => n.tries === 0)
      const hold = d.holdMs?.[head] ?? 0
      const ready = fresh && now().getTime() - Date.parse(fresh.at) < hold ? due.filter((n) => n.tries > 0) : due
      // 確かめ直しは送る直前に（前の送り先を待つあいだに本人が答えうる）
      const rows = ready.filter((n) => {
        if (!stale(n)) return true
        d.ledger.setDelivery(n.id, target, { status: 'dropped', tries: n.tries })
        return false
      })
      if (!rows.length) continue
      const send = senders[head]
      let r: Awaited<ReturnType<Sender>> = 'gone'
      if (send)
        try {
          r = await send(
            target,
            rows.map(({ tries: _, ...n }) => n),
          )
        } catch (e) {
          d.log?.(`notice ${target}: ${e instanceof Error ? e.message : String(e)}`)
          r = 'retry'
        }
      const t = now().getTime()
      for (const n of rows) {
        const tries = n.tries + 1
        if (r === 'retry' && tries <= RETRY_MS.length)
          d.ledger.setDelivery(n.id, target, {
            status: 'pending',
            tries,
            nextAt: new Date(t + (RETRY_MS[tries - 1] as number)),
          })
        else d.ledger.setDelivery(n.id, target, { status: r === 'sent' ? 'sent' : 'dropped', tries })
      }
    }
  }

  // 同時に 1 本。走っている間に呼ばれたら、終わった後にもう 1 回
  function flush(): Promise<void> {
    const quiet = quietNow()
    if (!quiet) summarize()
    for (const n of d.ledger.noticesAfter(last)) {
      last = n.id
      let outside = n.outside && !stale(n)
      if (outside && quiet) {
        d.ledger.holdNotice(n.id)
        outside = false
      }
      d.hub.emit('notice', { ...n, outside }, { replay: false })
    }
    if (running) {
      again = true
      return running
    }
    running = deliver()
      .catch((e) => d.log?.(`notices: ${e instanceof Error ? e.stack : String(e)}`))
      .finally(() => {
        running = undefined
        if (again) {
          again = false
          void flush()
        }
      })
    return running
  }

  return { flush }
}
