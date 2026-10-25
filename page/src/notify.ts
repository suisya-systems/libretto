// ブラウザの通知 B と、画面を閉じていても届く通知 C の登録（docs/implementation.md 6.8 (2)(6)(12)）。
// B は画面を開いているあいだ、SSE の notice をサービスワーカーに渡して出す。見ているか・同じ知らせが出ているかは
// サービスワーカーが端末の全部のタブを見て決める（public/sw.js）。C はホストが配信元へ送り、同じ出し方で出る
import { Notice, PushStatus } from '@libretto/shared/api'
import { navigate } from 'wouter/use-browser-location'
import { listen } from './load.ts'

// ページを開くたびの印。SSE の URL と「見ている」の POST に付け、ホストがタブごとに数える
export const TAB = Math.random().toString(36).slice(2)

// この端末の状態。on 以外は通知しない
export type DeviceState = 'on' | 'off' | 'denied' | 'insecure' | 'homescreen' | 'unavailable'
// iPhone・iPad の Safari は、ホーム画面に追加して開いたときだけ通知を使える（iPadOS は Mac の顔をする）
const ios = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export function deviceState(): DeviceState {
  // http:// の Tailscale のアドレスなど（127.0.0.1 は安全な起点に入る）
  if (!window.isSecureContext) return 'insecure'
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return ios() ? 'homescreen' : 'unavailable'
  const p = Notification.permission
  return p === 'granted' ? 'on' : p === 'denied' ? 'denied' : 'off'
}
// 画面を閉じたあとの通知に対応しているブラウザか
export const pushable = () => 'PushManager' in window

const bytes = (b64url: string) =>
  Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))

// この端末の登録をホストに渡す。許可したとき・SSE がつながるたび（登録の入れ替わり・ペアリングし直しを拾う）
export async function syncPush(): Promise<boolean> {
  if (deviceState() !== 'on' || !pushable()) return false
  try {
    const status = PushStatus.parse(await (await fetch('/api/devices/push')).json())
    const key = bytes(status.publicKey)
    const pm = (await navigator.serviceWorker.ready).pushManager
    let sub = await pm.getSubscription()
    // ホストの鍵が変わっていれば作り直す（前の鍵の登録には送れない）
    const was = sub?.options.applicationServerKey
    if (sub && (!was || String(new Uint8Array(was)) !== String(key))) {
      await sub.unsubscribe()
      sub = null
    }
    sub ??= await pm.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    const res = await fetch('/api/devices/push', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    })
    return res.ok
  } catch {
    return false
  }
}

// 本人が「この端末に通知する」を押したときだけ許可を求める（勝手に許可の画面を出さない）
export async function enable(): Promise<DeviceState> {
  const s = deviceState()
  if (s === 'off' || s === 'denied') await Notification.requestPermission()
  await syncPush()
  return deviceState()
}

// 前に出して見ているか（6.8 (2)）。変わるたびと、SSE がつながるたびにホストへ
function presence() {
  const visible = document.visibilityState === 'visible' && document.hasFocus()
  void fetch('/api/devices/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tab: TAB, visible }),
  }).catch(() => {})
}

export function startNotify() {
  document.addEventListener('visibilitychange', presence)
  for (const ev of ['focus', 'blur']) window.addEventListener(ev, presence)
  listen((s) => {
    if (s.event !== 'open') return
    presence()
    void syncPush()
  })
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  // 通知を押した: サービスワーカーが開いているタブに面を開かせる
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; path?: string }>) => {
    if (e.data?.type === 'open' && e.data.path?.startsWith('/')) navigate(e.data.path)
  })
  listen((s) => {
    if (s.event !== 'notice' || deviceState() !== 'on') return
    const n = Notice.safeParse(s.data)
    if (!n.success || !n.data.outside) return
    void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'notice', notice: n.data }))
  })
}
