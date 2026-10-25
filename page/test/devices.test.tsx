// @vitest-environment jsdom
// 設定の面の端末の節（docs/implementation.md 6.12 (5)）
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceSection } from '../src/faces/Devices.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let devices: { id: string; label: string; at: string; current: boolean }[]
let pairingUrl: string
const sent: { method: string; path: string; body?: unknown }[] = []
beforeEach(() => {
  sent.length = 0
  devices = [
    { id: 'me', label: '最初の端末', at: '2026-10-20T10:00:00+09:00', current: true },
    { id: 'phone', label: '私のスマホ', at: '2026-10-21T10:00:00+09:00', current: false },
  ]
  pairingUrl = 'https://pc.example.ts.net/pair/abc'
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    if (path === '/api/devices' && method === 'GET') return new Response(JSON.stringify({ devices }))
    sent.push({ method, path, ...(init.body && { body: JSON.parse(String(init.body)) }) })
    if (path === '/api/devices')
      return new Response(JSON.stringify({ url: pairingUrl, expiresAt: '2026-10-24T01:15:00.000Z' }))
    if (path.startsWith('/api/devices/')) {
      devices = devices.filter((d) => `/api/devices/${d.id}` !== path)
      return new Response(null, { status: 204 })
    }
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<DeviceSection />))
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined
  return {
    el,
    button,
    text: () => el.textContent ?? '',
    click: (b: Element | undefined) => act(async () => (b as HTMLElement).click()),
    type: async (v: string) => {
      const i = el.querySelector('input') as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, v)
      await act(async () => i.dispatchEvent(new Event('input', { bubbles: true })))
    },
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('端末の節', () => {
  it('一覧にこの端末の印。この端末には「外す」を出さない', async () => {
    const r = await render()
    expect(r.text()).toContain('最初の端末')
    expect(r.text()).toContain(W['settings.devices.current'])
    const removes = [...r.el.querySelectorAll('button')].filter((b) => b.textContent === W['settings.devices.remove'])
    expect(removes.map((b) => b.getAttribute('aria-label'))).toEqual([
      w('settings.devices.removeLabel', { label: '私のスマホ' }),
    ])
    r.done()
  })
  it('外すは確かめてから DELETE を送り、一覧を読み直す', async () => {
    const r = await render()
    await r.click(
      r.el.querySelector(`button[aria-label="${w('settings.devices.removeLabel', { label: '私のスマホ' })}"]`) ??
        undefined,
    )
    const confirm = [...document.querySelectorAll('.dialog button')].find(
      (b) => b.textContent === W['settings.devices.remove'],
    )
    await r.click(confirm)
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/devices/phone' }])
    await vi.waitFor(() => expect(r.text()).not.toContain('私のスマホ'))
    r.done()
  })
  it('別の端末を追加する: 名前を入れて追加用のアドレスと期限を出す', async () => {
    const r = await render()
    await r.click(r.button(W['settings.devices.add']))
    expect(r.button(W['settings.devices.issue'])?.disabled).toBe(true)
    await r.type('  会社の PC ')
    await r.click(r.button(W['settings.devices.issue']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/devices', body: { label: '会社の PC' } }])
    expect(r.el.querySelector('.device-url')?.textContent).toBe(pairingUrl)
    expect(r.text()).toContain(W['settings.devices.urlLead'])
    expect(r.text()).not.toContain(W['settings.devices.local'])
    r.done()
  })
  it('この PC の中でしか開けないアドレスなら、スマホから開く手順を添える', async () => {
    pairingUrl = 'http://127.0.0.1:7780/pair/abc'
    const r = await render()
    await r.click(r.button(W['settings.devices.add']))
    await r.type('スマホ')
    await r.click(r.button(W['settings.devices.issue']))
    expect(r.text()).toContain(W['settings.devices.local'])
    r.done()
  })
})
