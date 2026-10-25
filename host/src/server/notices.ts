// お知らせの送り出し（docs/implementation.md 6.8 (2)(4)(5)）。コミットの後に呼ぶ。
// 新しいお知らせを SSE の notice で出し（画面がブラウザの通知 B を出す）、画面の外の送り先の pending を送る。
// 送り先（Web Push・Slack の DM）は後の Issue が senders に足す。届いたことを書く前に落ちれば送り直すので、届くのは 1 回以上
import type { Notice } from '@libretto/shared/api'
import type { Ledger } from '../ledger/ledger.ts'
import type { Hub } from './sse.ts'

// 送り先 1 つに、届けるお知らせをまとめて渡す（Slack の 2 分のまとめが 1 通にできる）。
// gone は登録が無い（404 / 410）。登録を消すのは送り手。retry は 429・5xx・届かない
export type Sender = (target: string, notices: Notice[]) => Promise<'sent' | 'retry' | 'gone'>

const MIN = 60_000
const RETRY_MS = [1 * MIN, 5 * MIN, 30 * MIN] // 4 回目で dropped
const KEEP_MS = 24 * 60 * MIN

export function createNotices(d: {
  ledger: Ledger
  hub: Hub
  senders?: Record<string, Sender> // 送り先の頭（push / slack）→ 送り手
  now?: () => Date
  log?: (line: string) => void
}) {
  const now = d.now ?? (() => new Date())
  const senders = d.senders ?? {}
  // 起動より前のお知らせは SSE で出し直さない（SSE の履歴はメモリだけ。5.7 (2)）
  let last = d.ledger.lastNoticeSeq()
  let running: Promise<void> | undefined
  let again = false

  // 確認待ちは、書いた後に案件が動いていれば（本人が答えた）もう出さない（6.8 (4)）
  const stale = (n: Notice) => {
    if (n.kind !== 'your_turn' || !n.caseId) return false
    return d.ledger.getCase(n.caseId)?.revision !== d.ledger.noticeRevision(n.id)
  }

  async function deliver() {
    const at = now()
    const groups = new Map<string, (Notice & { tries: number })[]>()
    for (const { target, ...n } of d.ledger.dueDeliveries(at)) {
      if (at.getTime() - Date.parse(n.at) > KEEP_MS || stale(n))
        d.ledger.setDelivery(n.id, target, { status: 'dropped', tries: n.tries })
      else groups.set(target, [...(groups.get(target) ?? []), n])
    }
    for (const [target, rows] of groups) {
      const send = senders[target.split(':')[0] as string]
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
    for (const n of d.ledger.noticesAfter(last)) {
      last = n.id
      d.hub.emit('notice', { ...n, outside: n.outside && !stale(n) }, { replay: false })
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
