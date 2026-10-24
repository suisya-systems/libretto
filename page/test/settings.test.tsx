// @vitest-environment jsdom
// 設定の面の API キーの節（画面 7。docs/implementation.md 6.1.3 (6)・設計書 D17）
import type { ApiKeyStatus, ConnectionsView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/faces/Settings.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-test-abcdefgh12345678'
const unset: ApiKeyStatus = { kind: 'openai', set: false }
const set: ApiKeyStatus = { kind: 'openai', set: true, last4: '5678', savedAt: '2026-10-24T17:00:00+09:00' }
let keys: ApiKeyStatus
let conn: ConnectionsView
// Jev の行は既定で設定済み（入力欄とボタンを OpenAI の行だけにする）
let jev: ApiKeyStatus
let respond: (method: string) => Response
const sent: { method: string; path: string; body?: unknown }[] = []
let samples: { id: string; kind: '声の見本'; title: string; where: string }[]
let voiceStatus: number

beforeEach(() => {
  sent.length = 0
  keys = unset
  jev = { kind: 'jev', set: true, last4: 'WXYZ', savedAt: '2026-10-24T17:00:00+09:00' }
  conn = {
    isolation: { level: 'strong', running: false },
    google: { configured: false, state: 'none', label: 'libretto' },
  }
  respond = () => new Response('{}')
  samples = []
  voiceStatus = 200
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/settings/keys') return new Response(JSON.stringify({ openai: keys, jev }))
    if (path === '/api/connections') return new Response(JSON.stringify(conn))
    if (path === '/api/settings/voice-samples') {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        sent.push({ method: 'PUT', path, body })
        if (voiceStatus !== 200) return new Response('{}', { status: voiceStatus })
        samples = body.samples.map((x: { title: string; url: string }, i: number) => ({
          id: `V${i + 1}`,
          kind: '声の見本',
          title: x.title,
          where: x.url,
        }))
      }
      return new Response(JSON.stringify({ samples }))
    }
    if (path === '/api/checks/run' && init.method) {
      sent.push({ method: init.method, path })
      conn = { ...conn, isolation: { ...conn.isolation, running: true } }
      return new Response('{}', { status: 202 })
    }
    if (path.startsWith('/api/connections/google') && init.method) {
      sent.push({ method: init.method, path })
      return respond(init.method)
    }
    if (/^\/api\/settings\/keys\/(openai|jev)$/.test(path) && init.method) {
      sent.push({ method: init.method, path, ...(init.body && { body: JSON.parse(String(init.body)) }) })
      return respond(init.method)
    }
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<Settings />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  const input = () => el.querySelector('.key-form input') as HTMLInputElement | null
  return {
    el,
    text: () => el.textContent ?? '',
    button,
    input,
    type: async (v: string) => {
      const i = input() as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, v)
      await act(async () => i.dispatchEvent(new Event('input', { bubbles: true })))
    },
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('API キーの節', () => {
  it('未設定: 欄の名前・未設定・同じ種類の AI が作ることを出し、伏せた入力欄で保存する', async () => {
    const r = await render()
    for (const s of [W['settings.openai.label'], W['settings.key.unset'], W['settings.openai.unsetNote']])
      expect(r.text()).toContain(s)
    expect(r.input()?.type).toBe('password')
    expect(r.button(W['settings.key.save'])?.disabled).toBe(true)
    await r.type(`  ${KEY}`)
    keys = set
    await r.click(r.button(W['settings.key.save']))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/openai', body: { value: `  ${KEY}` } }])
    // 保存したら値を消し、設定済みを読み直す。値は画面のどこにも残らない
    expect(r.text()).toContain(W['settings.key.saved'])
    expect(r.text()).toContain(w('settings.key.set', { last4: '5678' }))
    expect(r.input()).toBeNull()
    expect(r.el.innerHTML).not.toContain(KEY)
    r.done()
  })

  it('設定済み: 末尾 4 文字と保存した日、入れ直すとやめる', async () => {
    keys = set
    const r = await render()
    expect(r.text()).toContain(w('settings.key.set', { last4: '5678' }))
    expect(r.text()).toContain(w('settings.key.savedAt', { at: '2026/10/24' }))
    expect(r.text()).not.toContain(W['settings.openai.unsetNote'])
    expect(r.input()).toBeNull()
    await r.click(r.button(W['settings.key.replace']))
    expect(r.input()).not.toBeNull()
    await r.click(r.button(W['settings.key.cancel']))
    expect(r.input()).toBeNull()
    r.done()
  })

  it('形の誤り（400）と保存できない（503）を、その行の下に一言で出す', async () => {
    const r = await render()
    await r.type('abc')
    respond = () => new Response('{"reason":"invalid"}', { status: 400 })
    await r.click(r.button(W['settings.key.save']))
    expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.key.invalid'])
    respond = () => new Response('{"reason":"storage"}', { status: 503 })
    await r.click(r.button(W['settings.key.save']))
    expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.key.failed'])
    // 失敗したら入力は残す（貼り直させない）
    expect(r.input()?.value).toBe('abc')
    r.done()
  })

  it('削除は確かめてから DELETE を送る', async () => {
    keys = set
    const r = await render()
    await r.click(r.button(W['settings.key.delete']))
    expect(document.querySelector('.dialog')?.textContent).toContain(W['settings.openai.deleteBody'])
    keys = unset
    await r.click(
      [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === W['settings.key.delete']),
    )
    expect(sent.map((s) => s.method)).toEqual(['DELETE'])
    expect(r.text()).toContain(W['settings.key.deleted'])
    expect(r.text()).toContain(W['settings.key.unset'])
    r.done()
  })
})

describe('動作環境の確認（8.10 (6)）', () => {
  it('しっかり隠せていて、まだ確認していない', async () => {
    const r = await render()
    expect(r.text()).toContain(W['settings.envHeading'])
    expect(r.text()).toContain(W['settings.isolation.strong'])
    expect(r.text()).toContain(W['settings.probe.never'])
    expect(r.el.querySelector('#h-env')?.parentElement?.querySelector('.note-warn, .note-alert')).toBeNull()
    r.done()
  })

  it('弱い: 原因の文を出し、コマンドは code で出す。前回の結果と日時', async () => {
    conn = {
      ...conn,
      isolation: {
        level: 'weak',
        cause: 'tools',
        running: false,
        last: { at: '2026-10-24T05:03:00Z', verdict: 'unknown' },
      },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.isolation.weak'])
    expect(r.el.querySelector('#h-env')?.parentElement?.querySelector('.note-warn code')?.textContent).toBe(
      'apt install bubblewrap socat ripgrep',
    )
    expect(r.text()).toContain(W['settings.probe.unknown'])
    expect(r.text()).toMatch(/2026\/10\/24 \d{2}:03 に確認/)
    r.done()
  })

  it('見えた結果は警告で出す。動かないときは原因を警告で出す', async () => {
    conn = {
      ...conn,
      isolation: {
        level: 'broken',
        cause: 'network',
        running: false,
        last: { at: '2026-10-24T05:03:00Z', verdict: 'visible' },
      },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.isolation.broken'])
    expect(r.el.querySelector('.note-alert[role="alert"]')?.textContent).toBe(W['settings.isolation.why.network'])
    expect(r.text()).toContain(W['settings.probe.visible'])
    expect(r.el.querySelector('.note-alert[role="status"]')?.textContent).toContain(W['settings.probe.visible'])
    r.done()
  })

  it('今すぐ確認: POST して、確認している間は押せない', async () => {
    const r = await render()
    await r.click(r.button(W['settings.probe.run']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/checks/run' }])
    await vi.waitFor(() => expect(r.text()).toContain(W['settings.probe.running']))
    expect(r.button(W['settings.probe.run'])?.disabled).toBe(true)
    r.done()
  })
})

describe('Jev の API キーの行（7.6 (10)）', () => {
  it('未設定: 欄の名前と、判定を同じ種類の AI が行うことを出し、jev に保存する', async () => {
    keys = set
    jev = { kind: 'jev', set: false }
    const r = await render()
    for (const s of [W['settings.jev.label'], W['settings.jev.use'], W['settings.jev.unsetNote']])
      expect(r.text()).toContain(s)
    expect(r.text()).not.toContain(W['settings.openai.unsetNote'])
    await r.type(KEY)
    await r.click(r.button(W['settings.key.save']))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/jev', body: { value: KEY } }])
    r.done()
  })
})

describe('あなたの文体の見本（6.3.2 (10)）', () => {
  const field = (el: HTMLElement, caption: string) =>
    [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(caption))
      ?.querySelector('input') as HTMLInputElement
  const typeIn = async (i: HTMLInputElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, v)
    await act(async () => i.dispatchEvent(new Event('input', { bubbles: true })))
  }

  it('題と URL を登録すると一覧の全体を保存し、外すと除いた一覧を保存する', async () => {
    const v = await render()
    expect(v.text()).toContain(W['settings.voiceHeading'])
    expect(v.text()).toContain(W['settings.voice.empty'])
    expect(v.button(W['settings.voice.add'])?.disabled).toBe(true)
    await typeIn(field(v.el, W['settings.voice.title']), '振り返りの話')
    await typeIn(field(v.el, W['settings.voice.url']), 'https://example.com/a')
    await v.click(v.button(W['settings.voice.add']))
    expect(sent.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/settings/voice-samples',
      body: { samples: [{ title: '振り返りの話', url: 'https://example.com/a' }] },
    })
    expect(v.text()).toContain(W['settings.voice.saved'])
    expect(v.text()).toContain('https://example.com/a')
    const remove = v.el.querySelector(`[aria-label="${w('settings.voice.removeLabel', { title: '振り返りの話' })}"]`)
    await v.click(remove)
    expect(sent.at(-1)?.body).toEqual({ samples: [] })
    v.done()
  })

  it('形の誤りは入れ直しを促し、5 件あれば登録の欄を出さない', async () => {
    voiceStatus = 400
    const v = await render()
    await typeIn(field(v.el, W['settings.voice.title']), 't')
    await typeIn(field(v.el, W['settings.voice.url']), 'ftp://example.com')
    await v.click(v.button(W['settings.voice.add']))
    expect(v.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.voice.invalid'])
    v.done()

    samples = Array.from({ length: 5 }, (_, i) => ({
      id: `V${i + 1}`,
      kind: '声の見本' as const,
      title: `t${i}`,
      where: `https://example.com/${i}`,
    }))
    const full = await render()
    expect(full.text()).toContain(W['settings.voice.max'])
    expect(full.button(W['settings.voice.add'])).toBeUndefined()
    full.done()
  })
})

describe('連携の節（Google。6.4 (7)）', () => {
  const google = (g: Partial<ConnectionsView['google']>) => {
    conn = { ...conn, google: { configured: true, state: 'none', label: 'libretto', ...g } }
  }
  const row = (el: HTMLElement) => el.querySelector('#h-link')?.parentElement as HTMLElement

  it('設定が無い: 設定がないことと入れ方を出し、連携するは出さない', async () => {
    const r = await render()
    const g = row(r.el)
    expect(g.textContent).toContain(W['settings.google.unconfigured'])
    expect(g.querySelector('.note-warn code')?.textContent).toBe('.env.local')
    expect(r.button(W['settings.google.connect'])).toBeUndefined()
    r.done()
  })

  it('未連携: できることの文・目印・PC で行う注記。連携するで始めて、返った URL へ移る', async () => {
    google({})
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, search: '', pathname: '/settings' })
    respond = () => new Response(JSON.stringify({ url: 'https://accounts.example/auth?x=1' }))
    const r = await render()
    const g = row(r.el)
    for (const s of [W['settings.google.use'], W['settings.google.none'], W['settings.google.pcNote']])
      expect(g.textContent).toContain(s)
    expect(g.textContent).toContain(w('settings.google.signal', { label: 'libretto' }))
    await r.click(r.button(W['settings.google.connect']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/connections/google/start' }])
    expect(assign).toHaveBeenCalledWith('https://accounts.example/auth?x=1')
    r.done()
  })

  it('連携済み: アドレス・ラベルが無い注記・混雑の注記。解除は確かめてから DELETE', async () => {
    google({ state: 'connected', email: 'me@example.com', labelFound: false, problem: 'rate_limited' })
    respond = () => new Response(null, { status: 204 })
    const r = await render()
    const g = row(r.el)
    expect(g.textContent).toContain(w('settings.google.as', { email: 'me@example.com' }))
    expect(g.textContent).toContain(w('settings.google.labelMissing', { label: 'libretto' }))
    expect(g.textContent).toContain(W['settings.google.problem.rate_limited'])
    expect(r.button(W['settings.google.connect'])).toBeUndefined()
    await r.click(r.button(W['settings.google.disconnect']))
    const dialog = document.querySelector('.dialog') as HTMLElement
    expect(dialog.textContent).toContain(W['settings.google.disconnectBody'])
    await r.click(r.button(W['settings.google.disconnect']) && [...dialog.querySelectorAll('button')].at(-1))
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/connections/google' }])
    r.done()
  })

  it('切れた: 連携し直す注記を出し、もう一度連携すると解除の両方を出す', async () => {
    google({ state: 'expired', email: 'me@example.com' })
    const r = await render()
    expect(row(r.el).textContent).toContain(W['settings.google.expiredNote'])
    expect(r.button(W['settings.google.connect'])).toBeDefined()
    expect(r.button(W['settings.google.disconnect'])).toBeDefined()
    r.done()
  })

  it('戻りの 1 行は 1 回だけ出し、URL から消す', async () => {
    google({ state: 'connected', email: 'me@example.com' })
    window.history.replaceState(null, '', '/settings?google=connected')
    const r = await render()
    expect(row(r.el).textContent).toContain(W['settings.google.result.connected'])
    expect(window.location.search).toBe('')
    r.done()
  })
})
