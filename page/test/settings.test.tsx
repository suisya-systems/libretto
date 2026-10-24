// @vitest-environment jsdom
// 設定の面の API キーの節（画面 7。docs/implementation.md 6.1.3 (6)・設計書 D17）
import type { ApiKeyStatus } from '@libretto/shared/api'
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
let respond: (method: string) => Response
const sent: { method: string; path: string; body?: unknown }[] = []

beforeEach(() => {
  sent.length = 0
  keys = unset
  respond = () => new Response('{}')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/settings/keys')
      return new Response(JSON.stringify({ openai: keys, jev: { kind: 'jev', set: false } }))
    if (path === '/api/settings/keys/openai' && init.method) {
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
    for (const s of [W['settings.openai.label'], W['settings.key.unset'], W['settings.key.unsetNote']])
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
    expect(r.text()).not.toContain(W['settings.key.unsetNote'])
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
    expect(document.querySelector('.dialog')?.textContent).toContain(W['settings.key.deleteBody'])
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
