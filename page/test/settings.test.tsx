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

beforeEach(() => {
  sent.length = 0
  keys = unset
  jev = { kind: 'jev', set: true, last4: 'WXYZ', savedAt: '2026-10-24T17:00:00+09:00' }
  conn = { isolation: { level: 'strong', running: false } }
  respond = () => new Response('{}')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/settings/keys') return new Response(JSON.stringify({ openai: keys, jev }))
    if (path === '/api/connections') return new Response(JSON.stringify(conn))
    if (path === '/api/checks/run' && init.method) {
      sent.push({ method: init.method, path })
      conn = { isolation: { ...conn.isolation, running: true } }
      return new Response('{}', { status: 202 })
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
  const input = () => el.querySelector('input') as HTMLInputElement | null
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
      isolation: {
        level: 'weak',
        cause: 'tools',
        running: false,
        last: { at: '2026-10-24T05:03:00Z', verdict: 'unknown' },
      },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.isolation.weak'])
    expect(r.el.querySelector('.note-warn code')?.textContent).toBe('apt install bubblewrap socat ripgrep')
    expect(r.text()).toContain(W['settings.probe.unknown'])
    expect(r.text()).toMatch(/2026\/10\/24 \d{2}:03 に確認/)
    r.done()
  })

  it('見えた結果は警告で出す。動かないときは原因を警告で出す', async () => {
    conn = {
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
