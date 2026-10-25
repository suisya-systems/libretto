// 画面を閉じていても届く通知 C（docs/implementation.md 6.8 (2)(6)(12)）。送り先 push:<sessionId> の送り手と、端末ごとの「見ている」。
// 暗号化と VAPID の署名は web-push で組み、送るのは fetch（sendNotification は https モジュール固定で、偽の配信元に向けられない）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'
import { z } from 'zod'
import type { Ledger } from '../ledger/ledger.ts'
import { writeSecret } from '../model/keys.ts'
import type { Sender } from './notices.ts'

// 配信元が困ったときの連絡先（RFC 8292）。127.0.0.1 や https://localhost は Safari の配信元が受け付けない
const SUBJECT = 'https://github.com/suisya-systems/libretto'
const TTL = 24 * 60 * 60 // 送り残しを捨てる 24 時間（6.8 (5)）と同じ

const Keys = z.object({ publicKey: z.string(), privateKey: z.string() })
// VAPID の鍵の組。初めて要るときに作り、<home>/push-keys.json（0600）に持つ（6.8 (2)）
export function vapidKeys(home: string): z.infer<typeof Keys> {
  const p = join(home, 'push-keys.json')
  try {
    return Keys.parse(JSON.parse(readFileSync(p, 'utf-8')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const k = webpush.generateVAPIDKeys()
  writeSecret(p, JSON.stringify(k))
  return k
}

export function createPush(d: {
  home: string
  ledger: Ledger
  valid: (sessionId: string) => boolean // 外していない・400 日以内（6.8 (6)）
  fetch?: typeof fetch
  log?: (line: string) => void
}) {
  const send = d.fetch ?? fetch
  // 端末 → タブ → 見ているか。SSE がつながっているタブだけ（切れたら見ていない。遅れて届いた POST で生き返らせない）
  const tabs = new Map<string, Map<string, { conn: object; visible: boolean }>>()
  // 配信元に届かなかった端末（ホストの外向きの通信。(7) の文）。届いたら下ろす
  const down = new Set<string>()

  const presence = {
    connect(sessionId: string, tab: string) {
      const conn = {}
      const m = tabs.get(sessionId) ?? new Map()
      tabs.set(sessionId, m.set(tab, { conn, visible: false }))
      return () => {
        if (m.get(tab)?.conn === conn) m.delete(tab)
      }
    },
    set(sessionId: string, tab: string, visible: boolean) {
      const t = tabs.get(sessionId)?.get(tab)
      if (t) t.visible = visible
    },
  }
  const watching = (sessionId: string) => [...(tabs.get(sessionId)?.values() ?? [])].some((t) => t.visible)

  const sender: Sender = async (target, notices) => {
    const sessionId = target.slice('push:'.length)
    for (const n of notices) {
      // 1 通ごとに確かめ直す（送っている間に端末を外した・登録し直した）
      if (!d.valid(sessionId)) {
        d.ledger.deletePushSubscription(sessionId)
        return 'gone'
      }
      const sub = d.ledger.pushSubscription(sessionId)
      if (!sub) return 'gone'
      if (watching(sessionId)) return 'sent' // 見ている端末には画面がブラウザの通知 B を出す
      const r = webpush.generateRequestDetails(
        sub,
        JSON.stringify({ id: n.id, caseId: n.caseId, path: n.path, text: n.text }),
        { vapidDetails: { subject: SUBJECT, ...vapidKeys(d.home) }, TTL },
      )
      let res: Response
      try {
        res = await send(r.endpoint, { method: r.method, headers: r.headers, body: new Uint8Array(r.body) })
      } catch (e) {
        down.add(sessionId)
        d.log?.(`push ${sessionId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
        return 'retry'
      }
      down.delete(sessionId)
      // 404 / 410 は登録が無い。401 / 403 は署名の側の問題（時計のずれなど）なので登録は消さずに送り直す
      if (res.status === 404 || res.status === 410) {
        d.ledger.deletePushSubscription(sessionId, sub.endpoint)
        return 'gone'
      }
      if (!res.ok) {
        d.log?.(`push ${sessionId.slice(0, 8)}: ${res.status}`)
        return 'retry' // 送れた分は同じ tag で置き換わる（届くのは 1 回以上）
      }
    }
    return 'sent'
  }

  return { sender, presence, unreachable: (sessionId: string) => down.has(sessionId) }
}
