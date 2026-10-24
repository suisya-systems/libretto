// @vitest-environment jsdom
// 会話欄（docs/implementation.md 6.2.1 (2)(3)(9)）
import type { ConversationMessage, ConversationView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from '../src/faces/Chat.tsx'
import { W } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-24T10:00:00.000+09:00'
const you = (seq: number, text: string, choiceId?: string): ConversationMessage => ({
  seq,
  thread: 'lobby',
  who: '本人',
  text,
  ...(choiceId && { choiceId }),
  at,
})
const asked: ConversationMessage = {
  seq: 2,
  thread: 'lobby',
  who: 'libretto',
  text: '誰に読んでもらう記事ですか？',
  choices: [
    { id: 'a', label: '社内の人', recommended: false, why: '前提を省いて書きます' },
    { id: 'b', label: '一般の読者', recommended: true, why: '前提なしで読めるように書きます' },
  ],
  at,
}

let conv: ConversationView
let post: () => Response | Promise<never>
const sent: Record<string, unknown>[] = []
beforeEach(() => {
  sent.length = 0
  post = () => new Response('{"seq":3,"replayed":false}', { status: 202 })
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/conversation') return new Response(JSON.stringify(conv))
    if (path === '/api/conversation/messages') {
      sent.push(JSON.parse(String(init.body)))
      return post()
    }
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render(stopped = false) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<Chat stopped={stopped} />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement
  const type = async (text: string) => {
    const ta = el.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, text)
    await act(async () => ta.dispatchEvent(new Event('input', { bubbles: true })))
    return ta
  }
  return {
    el,
    text: () => el.textContent ?? '',
    button,
    type,
    click: (b: HTMLElement) => act(async () => b.click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('会話欄', () => {
  it('質問の選択肢に、おすすめの印と 1 行が付き、押すと最後の行の seq を添えて送る', async () => {
    conv = { messages: [you(1, '記事にして'), asked], pending: false }
    const p = await render()
    const rec = p.button('一般の読者')
    expect(rec.textContent).toContain(W['chat.recommended'])
    expect(p.text()).toContain('前提なしで読めるように書きます')
    expect(p.button('社内の人').textContent).not.toContain(W['chat.recommended'])
    await p.click(rec)
    expect(sent).toEqual([{ choiceId: 'b', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), lastSeq: 2 }])
    p.done()
  })

  it('答えた質問の選択肢は押せず、選んだものに印が残る', async () => {
    conv = { messages: [you(1, '記事にして'), asked, you(3, '一般の読者', 'b')], pending: true }
    const p = await render()
    expect(p.button('一般の読者').disabled).toBe(true)
    expect(p.button('一般の読者').getAttribute('aria-pressed')).toBe('true')
    expect(p.button('一般の読者').textContent).toContain(W['chat.chosen'])
    expect(p.button('社内の人').getAttribute('aria-pressed')).toBe('false')
    // 返事を作っている間は「返事を書いています」で、送れない
    expect(p.text()).toContain(W['chat.thinking'])
    await p.type('追加')
    expect(p.button(W['chat.send']).disabled).toBe(true)
    p.done()
  })

  it('最初は「依頼する」で、Ctrl + Enter で送り、届いたら入力を消す', async () => {
    conv = { messages: [], pending: false }
    const p = await render()
    expect(p.button(W['home.askButton'])).toBeTruthy()
    const ta = await p.type('先週のブレストを記事に')
    await act(async () =>
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })),
    )
    expect(sent).toEqual([{ text: '先週のブレストを記事に', requestId: expect.any(String), lastSeq: 0 }])
    expect(ta.value).toBe('')
    p.done()
  })

  it('Enter だけでは送らない', async () => {
    conv = { messages: [], pending: false }
    const p = await render()
    const ta = await p.type('途中')
    await act(async () => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(sent).toEqual([])
    p.done()
  })

  it('送れなかったら入力を残して伝え、もう一度押すと同じ requestId で送る', async () => {
    conv = { messages: [], pending: false }
    post = () => Promise.reject(new TypeError('network'))
    const p = await render()
    const ta = await p.type('記事にして')
    await p.click(p.button(W['home.askButton']))
    expect(p.text()).toContain(W['band.sendFailed'])
    expect(ta.value).toBe('記事にして')
    post = () => new Response('{"seq":1,"replayed":true}', { status: 202 })
    await p.click(p.button(W['home.askButton']))
    expect(sent).toHaveLength(2)
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId)
    expect(p.text()).not.toContain(W['band.sendFailed'])
    p.done()
  })

  it('返事が届かなかったときは、もう一度送るを出す', async () => {
    conv = { messages: [you(1, '記事にして')], pending: false }
    const p = await render()
    expect(p.text()).toContain(W['chat.noReply'])
    await p.click(p.button(W['chat.retry']))
    expect(sent[0]).toMatchObject({ choiceId: 'retry', lastSeq: 1 })
    p.done()
  })

  it('受け付けた返事には依頼内容を見るのリンクが付き、次の依頼は「依頼する」から', async () => {
    conv = {
      messages: [you(1, '記事にして'), { ...asked, choices: undefined, text: '受け付けました。', caseId: 'c9' }],
      pending: false,
    }
    const p = await render()
    const link = [...p.el.querySelectorAll('a')].find((a) => a.textContent === W['chat.openCase'])
    expect(link?.getAttribute('href')).toBe('/cases/c9')
    expect(p.button(W['home.askButton'])).toBeTruthy()
    p.done()
  })

  it('止まっている間は送れないことを出し、入力も押せない', async () => {
    conv = { messages: [you(1, '記事にして'), asked], pending: false }
    const p = await render(true)
    expect(p.text()).toContain(W['chat.stopped'])
    expect((p.el.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true)
    expect(p.button('一般の読者').disabled).toBe(true)
    p.done()
  })
})

describe('会話欄（読めない・長さ）', () => {
  it('履歴が読めないときは、もう一度読み込むを出す', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }))
    const p = await render()
    expect(p.text()).toContain(W['load.failed'])
    expect(p.button(W['load.retry'])).toBeTruthy()
    p.done()
  })
  it('入力は 2,000 字まで', async () => {
    conv = { messages: [], pending: false }
    const p = await render()
    expect(p.el.querySelector('textarea')?.maxLength).toBe(2000)
    p.done()
  })
})
