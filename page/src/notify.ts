// ブラウザの通知 B（docs/implementation.md 6.8 (2)(6)）。画面を開いているあいだ、SSE の notice をサービスワーカーに渡して出す。
// 見ているか・同じ知らせが出ているかはサービスワーカーが端末の全部のタブを見て決める（public/sw.js）
import { Notice } from '@libretto/shared/api'
import { navigate } from 'wouter/use-browser-location'
import { listen } from './load.ts'

// この端末の状態。on 以外は通知しない
export type DeviceState = 'on' | 'off' | 'denied' | 'insecure' | 'unavailable'
export function deviceState(): DeviceState {
  // http:// の Tailscale のアドレスなど（127.0.0.1 は安全な起点に入る）
  if (!window.isSecureContext) return 'insecure'
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'unavailable'
  const p = Notification.permission
  return p === 'granted' ? 'on' : p === 'denied' ? 'denied' : 'off'
}

// 本人が「この端末に通知する」を押したときだけ許可を求める（勝手に許可の画面を出さない）
export async function enable(): Promise<DeviceState> {
  const s = deviceState()
  if (s === 'off' || s === 'denied') await Notification.requestPermission()
  return deviceState()
}

export function startNotify() {
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
