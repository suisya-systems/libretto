// @vitest-environment jsdom
// ホームの空の面と、読めないときに空の一覧を出さないこと（docs/implementation.md 5.8 (3)）
import type { HomeView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { W } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = { stopped: false, storageOk: true, signIn: false, isolation: 'strong' as const }
const empty: HomeView = {
  yourTurn: [],
  notices: [],
  candidates: { signal: [], meeting: [], inferred: { high: [], mid: [], low: [] } },
  autoStarted: [],
  active: [],
  defaults: { 会話: '確認しながら', gmail: '確認しながら', slack: '確認しながら', meet: 'おまかせ' },
  meetNotes: [],
  intake: { connected: false, running: false },
  host,
}

let replies: Record<string, () => Response | Promise<never>>
const sent: { method: string; path: string }[] = []
beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (init.method) sent.push({ method: init.method, path })
    // 会話欄は既定で空（会話欄の中身は chat.test.tsx）
    const r = replies[path] ?? (path === '/api/conversation' ? json({ messages: [], pending: false }) : undefined)
    if (!r) throw new Error(`unexpected ${path}`)
    return r()
  })
})
afterEach(() => vi.unstubAllGlobals())

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status })

async function render() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<App />))
  return {
    text: () => el.textContent ?? '',
    el,
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('ホーム', () => {
  it('空の面: 確認待ちが無いことと、各欄が空であることを言う。候補の欄は出さない', async () => {
    replies = { '/api/host': json(host), '/api/home': json(empty) }
    const p = await render()
    for (const k of [
      'home.noTurn',
      'home.noTurnLead',
      'home.autoEmpty',
      'home.activeEmpty',
      'home.noticeEmpty',
    ] as const)
      expect(p.text()).toContain(W[k])
    expect(p.text()).not.toContain('依頼の候補')
    // 会話欄は入力でき、空のままでは送れない
    expect(p.el.querySelector('#ask')?.hasAttribute('disabled')).toBe(false)
    expect(p.el.querySelector('.chat-form button[type=submit]')?.hasAttribute('disabled')).toBe(true)
    expect(p.text()).toContain('おまかせ')
    p.done()
  })

  it('お知らせ欄の 1 行は、その知らせの面へのリンク（6.8 (3)）', async () => {
    const notice = {
      id: 3,
      at: '2026-10-25T09:30:00.000+09:00',
      caseId: 'c1',
      kind: 'your_turn',
      text: '『週報』を保存する前の確認です。保存先と公開範囲を確かめてください',
      path: '/cases/c1/deliver',
      outside: true,
    } as const
    replies = { '/api/host': json(host), '/api/home': json({ ...empty, notices: [notice] }) }
    const p = await render()
    const a = [...p.el.querySelectorAll('.notices a')]
    expect(a.map((x) => [x.getAttribute('href'), x.textContent])).toEqual([['/cases/c1/deliver', notice.text]])
    expect(p.el.querySelector('.notices time')?.textContent).toBe('09:30')
    p.done()
  })

  it('つながっていない端末: ナビも空の一覧も出さず、つなぎ方を出す', async () => {
    replies = { '/api/host': json({ reason: 'not_paired' }, 401), '/api/home': json({ reason: 'not_paired' }, 401) }
    const p = await render()
    expect(p.text()).toContain(W['pair.title'])
    expect(p.text()).not.toContain(W['home.activeEmpty'])
    expect(p.el.querySelector('nav')).toBeNull()
    p.done()
  })

  it('ホストにつながらない: 空の一覧ではなく、つながらないことともう一度読み込むを出す', async () => {
    replies = { '/api/host': json(host), '/api/home': () => Promise.reject(new TypeError('network')) }
    const p = await render()
    expect(p.text()).toContain(W['load.offline'])
    expect(p.text()).toContain(W['load.retry'])
    expect(p.text()).not.toContain(W['home.activeEmpty'])
    p.done()
  })

  it('止まっているかが読めないときは帯ともう一度読み込むを出す', async () => {
    replies = { '/api/host': json({}, 500), '/api/home': json(empty) }
    const p = await render()
    expect(p.text()).toContain(W['load.failed'])
    replies['/api/host'] = json({ stopped: true, storageOk: true, signIn: false, isolation: 'strong' })
    const retry = [...p.el.querySelectorAll('button')].find((b) => b.textContent === W['load.retry'])
    await act(async () => retry?.click())
    expect(p.text()).toContain(W['band.stopped'])
    expect(p.text()).not.toContain(W['load.failed'])
    p.done()
  })

  it('止まっているときは帯を出し、解除を送れる', async () => {
    replies = {
      '/api/host': json({ stopped: true, storageOk: false, signIn: false, isolation: 'strong' }),
      '/api/home': json(empty),
      '/api/stop': json({ stopped: false, storageOk: true, signIn: false, isolation: 'strong' }),
    }
    const p = await render()
    expect(p.text()).toContain(W['band.stopped'])
    expect(p.text()).toContain(W['band.storage'])
    // 止まっている間は会話欄に送れない（6.2.1 (9)）
    expect(p.text()).toContain(W['chat.stopped'])
    expect(p.el.querySelector('#ask')?.hasAttribute('disabled')).toBe(true)
    const release = [...p.el.querySelectorAll('button')].find((b) => b.textContent === W['band.release'])
    await act(async () => release?.click())
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/stop' }])
    p.done()
  })
  it('ログイン切れの帯を出し、「続ける」で待ちを下ろす（6.2.3 (7)）', async () => {
    replies = {
      '/api/host': json({ ...host, signIn: true }),
      '/api/home': json(empty),
      '/api/host/resume': json(host),
    }
    const p = await render()
    expect(p.text()).toContain(W['band.signIn'])
    replies['/api/host'] = json(host)
    const resume = [...p.el.querySelectorAll('button')].find((b) => b.textContent === W['band.signInResume'])
    await act(async () => resume?.click())
    expect(sent).toEqual([{ method: 'POST', path: '/api/host/resume' }])
    expect(p.text()).not.toContain(W['band.signIn'])
    p.done()
  })
})
