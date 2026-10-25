// @vitest-environment jsdom
// ブラウザの通知 B（docs/implementation.md 6.8 (2)(6)(7)）。サービスワーカーの出し方、画面からの渡し方、設定の「お知らせ」の節
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiKeyStatus, ConnectionsView, Notice } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/faces/Settings.tsx'
import { connectEvents } from '../src/load.ts'
import { startNotify } from '../src/notify.ts'
import { W } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notice = (id: number, caseId = 'c1'): Notice => ({
  id,
  at: '2026-10-25T09:00:00.000+09:00',
  caseId,
  kind: 'your_turn',
  text: `知らせ ${id}`,
  path: `/cases/${caseId}`,
  outside: true,
})

// --- public/sw.js を偽の self で動かす
type Shown = { title: string; tag: string; body: string; data: { id: number; caseId?: string }; closed?: boolean }
type Win = { visibilityState: string; focused: boolean; url?: string; sent?: unknown[]; log?: string[]; nav?: boolean }
function worker(windows: Win[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {}
  const shown: Shown[] = []
  const opened: string[] = []
  const self = {
    addEventListener: (t: string, h: (e: unknown) => void) => {
      handlers[t] = h
    },
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () =>
        windows.map((w) => ({
          url: 'http://127.0.0.1:7780/',
          ...w,
          postMessage: (m: unknown) => {
            w.sent = [...(w.sent ?? []), m]
          },
          focus: async () => {
            w.log?.push('focus')
          },
          // 管理下のページだけが持つ想定で、nav のときだけ置く
          ...(w.nav && {
            navigate: async (path: string) => {
              w.log?.push(`navigate ${path}`)
            },
          }),
        })),
      openWindow: async (path: string) => {
        opened.push(path)
      },
    },
    registration: {
      getNotifications: async () =>
        shown.filter((x) => !x.closed).map((x) => ({ ...x, close: () => Object.assign(x, { closed: true }) })),
      showNotification: async (title: string, o: Omit<Shown, 'title'>) => {
        // 同じ tag は置き換え
        for (const x of shown) if (x.tag === o.tag) x.closed = true
        shown.push({ title, ...o })
      },
    },
  }
  new Function('self', readFileSync(join(import.meta.dirname, '../public/sw.js'), 'utf-8'))(self)
  const wait = async (fire: (done: (p: Promise<unknown>) => void) => void) => {
    let p: Promise<unknown> = Promise.resolve()
    fire((x) => {
      p = x
    })
    await p
  }
  return {
    show: (n: Notice) => wait((waitUntil) => handlers.message?.({ data: { type: 'notice', notice: n }, waitUntil })),
    push: (n: unknown) => wait((waitUntil) => handlers.push?.({ data: { json: () => n }, waitUntil })),
    shows: () => shown.length,
    click: (data: unknown) =>
      wait((waitUntil) => handlers.notificationclick?.({ notification: { data, close: () => {} }, waitUntil })),
    open: () => shown.filter((x) => !x.closed),
    opened,
  }
}

describe('サービスワーカーの出し方', () => {
  it('見出しは libretto、tag は知らせの id。同じ案件の前の通知は閉じる', async () => {
    const sw = worker()
    await sw.show(notice(1))
    await sw.show(notice(2, 'c2'))
    await sw.show(notice(3))
    expect(sw.open().map((x) => [x.title, x.tag, x.body])).toEqual([
      ['libretto', '2', '知らせ 2'],
      ['libretto', '3', '知らせ 3'],
    ])
  })

  it('同じ知らせがもう出ていれば出し直さない。遅れて届いた古い知らせも出さない', async () => {
    const sw = worker()
    await sw.show(notice(5))
    const first = sw.open()[0]
    await sw.show(notice(5))
    await sw.show(notice(4))
    expect(sw.open()).toEqual([first])
  })

  it('同時に届いた同じ案件の知らせも、新しい 1 つだけが残る', async () => {
    const sw = worker()
    await Promise.all([sw.show(notice(1)), sw.show(notice(2))])
    expect(sw.open().map((x) => x.tag)).toEqual(['2'])
  })

  it('この端末のどれかのタブで見ていれば出さない', async () => {
    const sw = worker([
      { visibilityState: 'hidden', focused: false },
      { visibilityState: 'visible', focused: true },
    ])
    await sw.show(notice(1))
    expect(sw.open()).toEqual([])
    // 前に出していても裏にあるだけなら出す
    const bg = worker([{ visibilityState: 'visible', focused: false }])
    await bg.show(notice(1))
    expect(bg.open()).toHaveLength(1)
  })

  it('Web Push は見ていても、同じものが出ていても必ず出す（出ているものを同じ tag で出し直し、鳴り直さない）', async () => {
    const sw = worker([{ visibilityState: 'visible', focused: true }])
    await sw.push(notice(2))
    expect(sw.open().map((x) => x.tag)).toEqual(['2'])
    await sw.push(notice(2))
    await sw.push(notice(1)) // 同じ案件の古いもの
    expect(sw.shows()).toBe(3)
    expect(sw.open().map((x) => [x.tag, x.body])).toEqual([['2', '知らせ 2']])
    await sw.push({ ...notice(3), caseId: 'c2' })
    expect(sw.open().map((x) => x.tag)).toEqual(['2', '3'])
  })

  it('押すと、開いているタブにその面を開かせる。無ければ新しく開く', async () => {
    const tab = { visibilityState: 'hidden', focused: false, sent: [] as unknown[] }
    // 版のあるページのタブは画面のタブに数えない
    const page = { visibilityState: 'visible', focused: true, url: 'http://127.0.0.1:7780/cases/c1/page', sent: [] }
    const sw = worker([page, tab])
    await sw.click({ path: '/cases/c1/deliver' })
    expect(page.sent).toEqual([])
    expect(tab.sent).toEqual([{ type: 'open', path: '/cases/c1/deliver' }])
    await sw.show(notice(1)) // 前に出ているのが版のあるページだけなら通知を出す
    expect(sw.open()).toHaveLength(1)
    const none = worker()
    await none.click({ path: '/' })
    expect(none.opened).toEqual(['/'])
  })

  // 2 回目の通知を押すと、裏で止まっていたページが古い面のまま出た（GitHub #66）
  it('開いているタブは前に出してから、その面を読み込み直させる', async () => {
    const tab: Win = { visibilityState: 'hidden', focused: false, sent: [], log: [], nav: true }
    await worker([tab]).click({ path: '/cases/c1' })
    expect(tab.log).toEqual(['focus', 'navigate /cases/c1'])
    expect(tab.sent).toEqual([])
  })
})

// --- 画面の側
let fire: (event: string, data?: unknown) => void
let posted: unknown[]
let permission: NotificationPermission
let requested: number
let subscribed: unknown[]
function stubBrowser(secure = true, push = false) {
  posted = []
  requested = 0
  subscribed = []
  if (push) vi.stubGlobal('PushManager', class {})
  class FakeSource {
    static CLOSED = 2
    readyState = 0
    handlers = new Map<string, ((e: MessageEvent) => void)[]>()
    constructor() {
      fire = (event, data = {}) => {
        for (const h of this.handlers.get(event) ?? []) h(new MessageEvent(event, { data: JSON.stringify(data) }))
      }
    }
    addEventListener(event: string, h: (e: MessageEvent) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), h])
    }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeSource)
  vi.stubGlobal('isSecureContext', secure)
  vi.stubGlobal('Notification', {
    get permission() {
      return permission
    },
    requestPermission: async () => {
      requested += 1
      permission = 'granted'
      return permission
    },
  })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: async () => ({}),
      addEventListener: () => {},
      ready: Promise.resolve({
        active: { postMessage: (m: unknown) => posted.push(m) },
        pushManager: {
          getSubscription: async () => null,
          subscribe: async (o: unknown) => {
            subscribed.push(o)
            return { toJSON: () => ({ endpoint: 'https://push.test/a', keys: { p256dh: 'p', auth: 'a' } }) }
          },
        },
      }),
    },
  })
}
afterEach(() => vi.unstubAllGlobals())

describe('画面からサービスワーカーへ渡す', () => {
  let disconnect: () => void
  beforeEach(() => {
    permission = 'granted'
    stubBrowser()
    disconnect = connectEvents()
    startNotify()
  })
  afterEach(() => disconnect())

  it('画面の外へ出す知らせだけ、許可があるときだけ渡す', async () => {
    fire('notice', notice(1))
    fire('notice', { ...notice(2), outside: false })
    permission = 'default'
    fire('notice', notice(3))
    await Promise.resolve()
    await Promise.resolve()
    expect(posted).toEqual([{ type: 'notice', notice: notice(1) }])
  })
})

describe('設定の「お知らせ」の節', () => {
  let prefs: Record<string, boolean>
  let sent: unknown[]
  let quiet: unknown
  let bot: ApiKeyStatus
  let dm: ConnectionsView['slackDm']['state']
  let host: { subscribed: boolean; unreachable: boolean }
  let puts: unknown[]
  const conn: ConnectionsView = {
    isolation: { level: 'strong', running: false },
    google: { configured: false, state: 'none', label: 'libretto', docs: false, meet: false },
    slack: { configured: false, state: 'none', emoji: 'memo', missingScopes: [] },
    slackDm: { state: 'none' },
    tools: { soffice: true, pdftoppm: true },
    env: {
      platform: 'linux',
      port: 7780,
      checking: false,
      checkedAt: '2026-10-24T05:03:00Z',
      ai: { state: 'ok' },
      phone: true,
    },
    inference: { classifiedToday: 0, dailyLimit: 300, recall: { hit: 0, total: 0 }, suppressions: [] },
  }
  beforeEach(() => {
    prefs = { your_turn: true, stopped: true, done: true, auto_started: true, candidates: true, started: false }
    sent = []
    bot = { kind: 'slackBot', set: false }
    dm = 'none'
    host = { subscribed: false, unreachable: false }
    puts = []
    quiet = { quietHours: null }
    vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
      if (path === '/api/settings/quiet-hours') {
        if (init.method === 'PUT') {
          quiet = JSON.parse(String(init.body))
          sent.push(quiet)
        }
        return new Response(JSON.stringify(quiet))
      }
      if (path === '/api/devices/push') {
        if (init.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)))
          host.subscribed = true
          return new Response(null, { status: 204 })
        }
        return new Response(JSON.stringify({ publicKey: Buffer.alloc(65, 4).toString('base64url'), ...host }))
      }
      if (path === '/api/settings/notices') {
        if (init.method === 'PUT') {
          prefs = JSON.parse(String(init.body))
          sent.push(prefs)
        }
        return new Response(JSON.stringify(prefs))
      }
      if (path === '/api/settings/keys')
        return new Response(
          JSON.stringify({
            openai: { kind: 'openai', set: false },
            jev: { kind: 'jev', set: false },
            slack: { kind: 'slack', set: false },
            slackBot: bot,
          }),
        )
      if (path === '/api/settings/keys/slackBot') {
        sent.push({ method: init.method, path, body: init.body && JSON.parse(String(init.body)) })
        return new Response('{}', { status: 400 })
      }
      if (path === '/api/connections') return new Response(JSON.stringify({ ...conn, slackDm: { state: dm } }))
      if (path === '/api/settings/voice-samples') return new Response(JSON.stringify({ samples: [] }))
      if (path === '/api/settings/inference')
        return new Response(
          JSON.stringify({ gmailDays: 7, slackChannels: [], dailyLimit: 300, showLow: true, useJev: true }),
        )
      throw new Error(`unexpected ${path}`)
    })
  })

  async function render() {
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    await act(async () => root.render(<Settings />))
    const section = () => el.querySelector('[aria-labelledby="h-notices"]') as HTMLElement
    return {
      text: () => section().textContent ?? '',
      el: section,
      button: () =>
        [...section().querySelectorAll('button')].find((b) => b.textContent === W['settings.notices.enable']),
      box: (label: string) =>
        [...section().querySelectorAll('label')].find((l) => l.textContent === label)?.querySelector('input'),
      done: () => {
        act(() => root.unmount())
        el.remove()
      },
    }
  }

  it('許可を求めるのは押したときだけ。許可されたら「この端末に通知します」', async () => {
    permission = 'default'
    stubBrowser()
    const p = await render()
    expect(requested).toBe(0)
    expect(p.text()).toContain(W['settings.notices.off'])
    await act(async () => p.button()?.click())
    expect(requested).toBe(1)
    expect(p.text()).toContain(W['settings.notices.on'])
    expect(p.button()).toBeUndefined()
    p.done()
  })

  it('画面を閉じていても届くブラウザでは、許可したときに登録をホストへ渡す。届かなかったら直し方を出す', async () => {
    permission = 'default'
    stubBrowser(true, true)
    const p = await render()
    expect(puts).toEqual([]) // 許可が無いあいだは登録しない
    expect(p.text()).not.toContain(W['settings.notices.openOnly'])
    await act(async () => p.button()?.click())
    expect(subscribed).toEqual([{ userVisibleOnly: true, applicationServerKey: new Uint8Array(65).fill(4) }])
    expect(puts).toEqual([{ endpoint: 'https://push.test/a', keys: { p256dh: 'p', auth: 'a' } }])
    expect(p.text()).toContain(W['settings.notices.on'])
    expect(p.text()).not.toContain(W['settings.notices.openOnly'])
    expect(p.text()).not.toContain(W['settings.notices.unreachable'])
    p.done()
    host.unreachable = true
    const q = await render()
    expect(q.text()).toContain(W['settings.notices.unreachable'])
    q.done()
  })

  it('対応していないブラウザでは、画面を開いているあいだだけと出す', async () => {
    permission = 'granted'
    stubBrowser()
    const p = await render()
    expect(p.text()).toContain(W['settings.notices.openOnly'])
    expect(puts).toEqual([])
    p.done()
  })

  it('iPhone でホーム画面から開いていなければ、ホーム画面に追加する手順を出す', async () => {
    vi.stubGlobal('isSecureContext', true)
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)')
    const p = await render()
    expect(p.text()).toContain(W['settings.notices.unavailable'])
    expect(p.text()).toContain(W['settings.notices.homescreen'])
    expect(p.button()).toBeUndefined()
    p.done()
    ua.mockRestore()
  })

  it('ブラウザで拒んでいれば、直し方を出す', async () => {
    permission = 'denied'
    stubBrowser()
    const p = await render()
    expect(p.text()).toContain(W['settings.notices.off'])
    expect(p.text()).toContain(W['settings.notices.denied'])
    p.done()
  })

  it('http:// の開き方では使えないことと、開き直し方を出す', async () => {
    permission = 'default'
    stubBrowser(false)
    const p = await render()
    expect(p.text()).toContain(W['settings.notices.unavailable'])
    expect(p.text()).toContain(W['settings.notices.insecure'])
    expect(p.button()).toBeUndefined()
    p.done()
  })

  it('出来事ごとの入り切りを保存する。既定では下書きに取りかかったは切ってある', async () => {
    permission = 'granted'
    stubBrowser()
    const p = await render()
    const started = p.box(W['settings.notices.kind.started'])
    expect(started?.checked).toBe(false)
    expect(p.box(W['settings.notices.kind.your_turn'])?.checked).toBe(true)
    await act(async () => started?.click())
    expect(sent).toEqual([{ ...prefs, started: true }])
    expect(p.box(W['settings.notices.kind.started'])?.checked).toBe(true)
    expect(p.text()).toContain(W['settings.notices.saved'])
    p.done()
  })

  it('通知を止める時間帯は既定で無し。入れて保存し、「止めない」で外す（6.8 (14)）', async () => {
    permission = 'granted'
    stubBrowser()
    const p = await render()
    const button = (label: string) => [...p.el().querySelectorAll('button')].find((b) => b.textContent === label)
    expect(p.text()).toContain(W['settings.notices.quietNone'])
    expect(button(W['settings.notices.quietSave'])?.disabled).toBe(true)
    expect(button(W['settings.notices.quietOff'])).toBeUndefined()
    const time = (label: string, value: string) => {
      const input = [...p.el().querySelectorAll('label')]
        .find((l) => l.textContent === label)
        ?.querySelector('input') as HTMLInputElement
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    time(W['settings.notices.quietFrom'], '22:00')
    time(W['settings.notices.quietTo'], '22:00')
    expect(button(W['settings.notices.quietSave'])?.disabled).toBe(true) // 始まりと終わりが同じ
    time(W['settings.notices.quietTo'], '07:00')
    await act(async () => button(W['settings.notices.quietSave'])?.click())
    expect(sent).toEqual([{ quietHours: { from: '22:00', to: '07:00' } }])
    expect(p.text()).toContain('22:00〜07:00 は通知を止めます')
    await act(async () => button(W['settings.notices.quietOff'])?.click())
    expect(sent.at(-1)).toEqual({ quietHours: null })
    expect(p.text()).toContain(W['settings.notices.quietNone'])
    p.done()
  })

  it('Slack の行: 未設定なら貼るものを、xoxp- を貼れば欄の違いを、確かめた結果を出す（6.8 (7)(8)）', async () => {
    permission = 'granted'
    stubBrowser()
    let p = await render()
    expect(p.text()).toContain(W['settings.slackDm.unsetNote'])
    const input = () =>
      document.querySelector(`input[placeholder="${W['settings.slackDm.input']}"]`) as HTMLInputElement
    expect(input().type).toBe('password')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), 'xoxp-user-token')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => input().form?.requestSubmit())
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/slackBot', body: { value: 'xoxp-user-token' } }])
    expect(p.text()).toContain(W['settings.slackDm.invalid'])
    p.done()

    bot = { kind: 'slackBot', set: true, last4: 'good', savedAt: '2026-10-25T21:00:00+09:00' }
    for (const [state, key] of [
      ['on', 'settings.slackDm.on'],
      ['noUser', 'settings.slackDm.noUser'],
      ['missingScope', 'settings.slackDm.missingScope'],
      ['rejected', 'settings.slackDm.rejected'],
    ] as const) {
      dm = state
      p = await render()
      expect(p.text()).toContain(W[key])
      expect(p.text()).toContain(W['settings.slackDm.openNote'])
      p.done()
    }
  })
})
