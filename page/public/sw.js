// サービスワーカー（docs/implementation.md 6.8 (2)）。画面から渡されたお知らせをブラウザの通知に出し、押されたら該当の面を開く。
// 画面を閉じていても届く通知（Web Push）も同じ show を通す
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// libretto の画面のタブだけ。版のあるページ（/cases/<id>/page。スクリプトの無い成果）は見ているにも、押した先にも数えない
const windows = () =>
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((ws) => ws.filter((w) => !/^\/cases\/[^/]+\/page$/.test(new URL(w.url).pathname)))

// 届いた push は必ず何か出す（Safari は出さない push が続くと登録を取り消す。6.8 (2)）。見ていても出し、
// 同じものが出ていれば、それを同じ tag で出し直す（置き換わるだけで鳴り直さない）
async function show(n, push = false) {
  // この端末のどれかのタブで見ていれば出さない（タブごとでなく端末ごと）
  if (!push && (await windows()).some((w) => w.visibilityState === 'visible' && w.focused)) return
  const open = await self.registration.getNotifications()
  // 同じ知らせ（同じ tag）はそのまま残す（閉じて出し直すと鳴り直す）。同じ案件の新しい知らせが出ていれば、遅れて届いた古いものは出さない
  const sameCase = (x) => n.caseId && x.data?.caseId === n.caseId
  const shown = open.find((x) => x.tag === String(n.id) || (sameCase(x) && x.data.id > n.id))
  if (shown) {
    if (push)
      await self.registration.showNotification(shown.title, { body: shown.body, tag: shown.tag, data: shown.data })
    return
  }
  for (const x of open) if (sameCase(x)) x.close()
  await self.registration.showNotification('libretto', {
    body: n.text,
    tag: String(n.id),
    data: { id: n.id, caseId: n.caseId, path: n.path },
  })
}

// 1 つずつ出す（同時に届いた同じ案件の知らせが、互いに前の通知を見ないまま 2 つ並ばないように）
let queue = Promise.resolve()
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'notice') return
  queue = queue.then(() => show(e.data.notice)).catch(() => {})
  e.waitUntil(queue)
})

self.addEventListener('push', (e) => {
  let n
  try {
    n = e.data.json()
  } catch {
    n = { id: 0, path: '/', text: '' }
  }
  queue = queue.then(() => show(n, true)).catch(() => {})
  e.waitUntil(queue)
})

// 開いているタブがあればそこで面を開き、無ければ新しく開く
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const path = e.notification.data?.path || '/'
  e.waitUntil(
    windows().then((ws) => {
      const w = ws[0]
      if (!w) return self.clients.openWindow(path)
      w.postMessage({ type: 'open', path })
      return w.focus()
    }),
  )
})
