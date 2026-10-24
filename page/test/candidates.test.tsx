// @vitest-environment jsdom
// ホームの「依頼の候補」の欄（docs/implementation.md 6.4 (5)(7)）
import type { CandidateCard, HomeView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = { stopped: false, storageOk: true, signIn: false, isolation: 'strong' as const }
const card: CandidateCard = {
  id: 'gmail:t1',
  source: 'gmail',
  origin: '合図',
  aiInstructionFlag: true,
  subject: '新サービスの紹介資料のお願い',
  from: '山田 花子',
  receivedAt: '2026-10-24T10:05:00.000+09:00',
  link: 'https://mail.google.com/mail/?authuser=me%40example.com#all/t1',
  summary: '来週の定例で使う、新サービスの紹介資料をまとめる',
  proposal: { docType: 'スライド', destination: [{ kind: 'page', shared: false }] },
  attachmentsNeeded: ['サービス概要.pdf'],
  attachments: ['サービス概要.pdf', 'ロゴ.png'],
}
const view = (over: Partial<HomeView> = {}): HomeView => ({
  yourTurn: [],
  notices: [],
  candidates: { signal: [card], meeting: [], inferred: { high: [], mid: [], low: [] } },
  autoStarted: [],
  active: [],
  defaults: { 会話: '確認しながら', gmail: '確認しながら', slack: '確認しながら', meet: '確認しながら' },
  intake: { connected: true, running: false, lastAt: '2026-10-24T10:15:00.000+09:00' },
  host,
  ...over,
})

let home: HomeView
const sent: { method: string; path: string; body?: unknown }[] = []
let answer: (path: string) => Response
beforeEach(() => {
  sent.length = 0
  home = view()
  answer = () => new Response('{}')
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (init.method) {
      sent.push({ method: init.method, path, ...(init.body && { body: JSON.parse(String(init.body)) }) })
      return answer(path)
    }
    if (path === '/api/host') return new Response(JSON.stringify(host))
    if (path === '/api/home') return new Response(JSON.stringify(home))
    if (path.startsWith('/api/conversation')) return new Response(JSON.stringify({ messages: [], pending: false }))
    if (path.startsWith('/api/cases/')) return new Response('{}', { status: 404 })
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function render() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<App />))
  const button = (label: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement
  const click = async (b: Element | null | undefined) => {
    await act(async () => (b as HTMLElement).click())
  }
  return {
    el,
    text: () => el.textContent ?? '',
    button,
    click,
    done: () => act(() => root.unmount()),
  }
}

describe('依頼の候補（6.4 (7)）', () => {
  it('カード: ラベルのしるし・差出人・件名・頼まれていそうなこと・作るものと保存先・添付と AI への指示の注記・メールへのリンク', async () => {
    const r = await render()
    const c = r.el.querySelector('.cand') as HTMLElement
    expect(c.textContent).toContain(W['cand.mark.gmail'])
    expect(c.textContent).toContain('山田 花子')
    expect(c.querySelector('h3')?.textContent).toBe(card.subject)
    expect(c.textContent).toContain(card.summary)
    expect(c.textContent).toContain(w('cand.make', { doc: 'スライド', dest: W['dest.page'] }))
    expect(c.textContent).toContain(w('cand.attach', { names: 'サービス概要.pdf' }))
    expect(c.textContent).toContain(W['cand.aiNote'])
    const a = c.querySelector('a') as HTMLAnchorElement
    expect(a.href).toBe(card.link)
    expect(a.rel).toContain('noopener')
    expect(r.text()).toContain(w('count', { n: 1 }))
    r.done()
  })

  it('進める: 候補の操作を送り、作った案件の面へ移る', async () => {
    answer = () => new Response(JSON.stringify({ caseId: 'c9' }))
    const r = await render()
    await r.click(r.button(W['cand.proceed']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/candidates/gmail%3At1/actions', body: { type: 'proceed' } }])
    expect(window.location.pathname).toBe('/cases/c9')
    r.done()
  })

  it('見送る: 理由は 3 つで、選ぶまで見送れない。選んだ理由を送る', async () => {
    const r = await render()
    await r.click(r.button(W['cand.dismiss']))
    const dialog = document.querySelector('.dialog') as HTMLElement
    const labels = [...dialog.querySelectorAll('.radio-label')].map((x) => x.textContent)
    expect(labels).toEqual(['依頼ではない', '自分の仕事ではない', 'もう済んだ'])
    const confirm = r.button(W['cand.dismiss'], dialog)
    expect(confirm.disabled).toBe(true)
    await r.click(dialog.querySelectorAll('[role=radio]')[2])
    expect(r.button(W['cand.dismiss'], dialog).disabled).toBe(false)
    await r.click(r.button(W['cand.dismiss'], dialog))
    expect(sent).toEqual([
      { method: 'POST', path: '/api/candidates/gmail%3At1/actions', body: { type: 'dismiss', reason: 'もう済んだ' } },
    ])
    r.done()
  })

  it('もう進んでいた（409）は 1 行で知らせ、取り直す', async () => {
    answer = () => new Response('{}', { status: 409 })
    const r = await render()
    await r.click(r.button(W['cand.proceed']))
    expect(r.text()).toContain(W['action.moved'])
    r.done()
  })

  it('内容を修正: カードの下に候補の中の会話を開き、送ると candidateId 付きで送る', async () => {
    answer = () => new Response(JSON.stringify({ seq: 1, replayed: false }), { status: 202 })
    const r = await render()
    await r.click(r.button(W['cand.change']))
    const chat = r.el.querySelector('.cand .chat') as HTMLElement
    expect(chat.textContent).toContain(W['cand.talkHeading'])
    const area = chat.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, 'スライドにして')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await r.click(chat.querySelector('button[type=submit]'))
    expect(sent.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/conversation/messages',
      body: { candidateId: 'gmail:t1', text: 'スライドにして', lastSeq: 0 },
    })
    expect(r.el.querySelectorAll('textarea')).toHaveLength(2) // ホームの依頼の欄とは別
    r.done()
  })

  it('連携していて候補が無ければ、空の 1 行と「今すぐ取り込む」。押すと取り込みを送る', async () => {
    home = view({ candidates: { signal: [], meeting: [], inferred: { high: [], mid: [], low: [] } } })
    answer = () => new Response('{}', { status: 202 })
    const r = await render()
    expect(r.text()).toContain(W['home.candEmpty'])
    await r.click(r.button(W['home.candRefresh']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/intake/refresh' }])
    r.done()
  })

  it('連携しておらず候補も無ければ、欄ごと出さない', async () => {
    home = view({
      candidates: { signal: [], meeting: [], inferred: { high: [], mid: [], low: [] } },
      intake: { connected: false, running: false },
    })
    const r = await render()
    expect(r.text()).not.toContain(W['home.candHeading'])
    r.done()
  })
})
