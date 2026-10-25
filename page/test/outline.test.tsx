// @vitest-environment jsdom
// 構成案の面（承認待ち kind=構成案。docs/implementation.md 6.12 (3)）
import type { CaseView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutlineFace } from '../src/faces/Outline.tsx'
import { W } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-24T01:05:00.000Z'
const base: CaseView = {
  id: 'c1',
  title: 'ブレストのまとめ',
  state: '承認待ち',
  turn: '本人',
  step: '構成案を確認してください',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 0,
  revision: 7,
  costYen: 120,
  costCapYen: 1500,
  approvalKind: '構成案',
  outlineFingerprint: 'ol1',
  outline:
    '# ブレストのまとめ\n\n## 決まったこと\n\n- 3 つの方針\n- <b>そのまま</b>の文字\n\n## その理由\n\n短い説明。\n',
  materials: [],
  versions: [],
  rounds: { series: 1, used: 0, max: 3 },
  deliveryPlan: {
    targets: [{ kind: 'page', shared: false }],
    fingerprint: 'p',
    visibility: 'あなただけ',
    overwrites: false,
    quotesOthers: false,
  },
  destinationChoices: ['page', 'paste'],
  deliveries: [],
  events: [
    { at, type: 'created', to: '入口待ち' },
    { at, type: 'transition', from: '下書き中', to: '承認待ち', event: 'outline.done', by: 'libretto' },
  ],
}

const sent: Record<string, unknown>[] = []
beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path !== '/api/cases/c1/actions') throw new Error(`unexpected ${path}`)
    sent.push(JSON.parse(String(init.body)))
    return new Response('{"state":"下書き中","turn":"libretto","revision":8,"replayed":false}')
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render(c: CaseView, stopped = false) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<OutlineFace c={c} reload={() => {}} stopped={stopped} />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  return {
    el,
    button,
    text: () => el.textContent ?? '',
    click: (b: Element | undefined) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('構成案の面', () => {
  it('構成案の見出しと箇条書きを文字のまま出し、履歴に「構成案ができました」', async () => {
    const r = await render(base)
    expect(r.text()).toContain('構成案を確認してください')
    expect([...r.el.querySelectorAll('.outline-body h2')].map((h) => h.textContent)).toEqual([
      '決まったこと',
      'その理由',
    ])
    expect(r.el.querySelector('.outline-body b')).toBeNull()
    expect(r.text()).toContain('<b>そのまま</b>の文字')
    expect(r.text()).toContain(W['event.outline.done'])
    r.done()
  })
  it('「この構成で」は指紋を添えて outline.approve（指示なし）', async () => {
    const r = await render(base)
    await r.click(r.button(W['outline.ok']))
    expect(sent).toEqual([
      expect.objectContaining({ type: 'outline.approve', expectedRevision: 7, outlineFingerprint: 'ol1' }),
    ])
    expect(sent[0]).not.toHaveProperty('note')
    r.done()
  })
  it('変えてほしいところを書くと note 付きで送る。空のままは送れない', async () => {
    const r = await render(base)
    await r.click(r.button(W['outline.change']))
    const send = r.button(W['outline.changeSend'])
    expect(send?.disabled).toBe(true)
    const ta = r.el.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      ta,
      ' 2 つ目と 3 つ目を入れ替えて ',
    )
    await act(async () => ta.dispatchEvent(new Event('input', { bubbles: true })))
    await r.click(r.button(W['outline.changeSend']))
    expect(sent[0]).toMatchObject({ type: 'outline.approve', note: '2 つ目と 3 つ目を入れ替えて' })
    r.done()
  })
  it('全部止めている間と、指紋が無いときは押せない', async () => {
    const r = await render(base, true)
    expect(r.button(W['outline.ok'])?.disabled).toBe(true)
    r.done()
    const { outlineFingerprint: _, ...noFp } = base
    const r2 = await render(noFp)
    expect(r2.button(W['outline.ok'])?.disabled).toBe(true)
    r2.done()
  })
})
