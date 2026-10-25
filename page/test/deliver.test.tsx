// @vitest-environment jsdom
// 送付の面・成果の面・完了した依頼（docs/implementation.md 6.2.8 (6)(7)(9)）
import type { CaseView, DeliveryTarget } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliverFace, ResultFace } from '../src/faces/Deliver.tsx'
import { Done } from '../src/faces/Done.tsx'
import { History } from '../src/faces/Progress.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-24T01:05:00.000Z'
const PASTE = 'ブレストのまとめ\n\n決まったことは 3 つです。\n'
const base: CaseView = {
  id: 'c1',
  title: 'ブレストのまとめ',
  state: '送付確認待ち',
  turn: '本人',
  step: '保存先を確認してください',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 1,
  revision: 12,
  costYen: 640,
  costCapYen: 1500,
  materials: [],
  versions: [{ n: 1, at, chars: 2480, headings: 4, fingerprint: 'f1', state: '承認済み' }],
  formatReview: { n: 1, passed: 2, failed: [], skipped: 0, needsConfirmation: [], sources: [] },
  rounds: { series: 1, used: 2, max: 3 },
  deliveryPlan: {
    targets: [{ kind: 'paste' }, { kind: 'page', shared: false }],
    fingerprint: 'plan-1',
    visibility: 'あなただけ',
    overwrites: false,
    quotesOthers: false,
  },
  destinationChoices: ['page', 'paste'],
  deliveries: [],
  events: [{ at, type: 'created', to: '入口待ち' }],
}
const done: CaseView = {
  ...base,
  state: '完了',
  step: '完了しました',
  doneAt: at,
  deliveries: [
    { attemptId: 'e:0', target: { kind: 'paste' }, version: 1, status: '送付済', visibility: 'あなただけ', at },
    {
      attemptId: 'e:1',
      target: { kind: 'page', shared: false },
      version: 1,
      status: '送付済',
      link: '/cases/c1/page?v=1',
      visibility: 'あなただけ',
      at,
    },
  ],
  events: [
    { at, type: 'created', to: '入口待ち' },
    { at, type: 'transition', from: '送付確認待ち', to: '送付中', event: 'delivery.send', by: '本人' },
    { at, type: 'transition', from: '送付中', to: '完了', event: 'delivery.done', by: 'libretto' },
  ],
}

const sent: Record<string, unknown>[] = []
const fetched: string[] = []
beforeEach(() => {
  sent.length = 0
  fetched.length = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    fetched.push(path)
    if (path === '/api/cases/c1/actions') {
      sent.push(JSON.parse(String(init.body)))
      return new Response('{"state":"送付中","turn":"libretto","revision":13,"replayed":false}')
    }
    if (path === '/api/cases/c1/drafts/1?format=paste') return new Response(PASTE)
    if (path === '/api/cases?state=完了')
      return new Response(
        JSON.stringify([{ ...base, state: '完了', doneAt: at, id: 'c1' }].map(({ deliveryPlan, ...c }) => c)),
      )
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render(node: React.ReactNode) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(node))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  return {
    el,
    text: () => el.textContent ?? '',
    button,
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('送付の面', () => {
  it('何を・どこへ・誰に見えるか、貼り付け用の文のプレビュー', async () => {
    const r = await render(<DeliverFace c={base} reload={() => {}} stopped={false} />)
    for (const s of [
      '保存先を確認してください',
      W['deliver.what'],
      w('card.version', { n: 1 }),
      W['dest.paste'],
      W['dest.page'],
      W['deliver.visibility.あなただけ'],
      W['deliver.checked'],
      W['deliver.pageNote'],
    ])
      expect(r.text()).toContain(s)
    expect(r.el.querySelector('.paste-preview')?.textContent).toBe(PASTE)
    r.done()
  })

  it('「この内容で保存する」は今の revision と DeliveryPlan.fingerprint、「保存しないで戻る」は decline', async () => {
    const r = await render(<DeliverFace c={base} reload={() => {}} stopped={false} />)
    await r.click(r.button(W['deliver.send']))
    expect(sent[0]).toMatchObject({ type: 'delivery.send', expectedRevision: 12, planFingerprint: 'plan-1' })
    await r.click(r.button(W['deliver.decline']))
    expect(sent[1]).toMatchObject({ type: 'delivery.decline', expectedRevision: 12 })
    r.done()
  })

  it('すべて停止しているあいだは押せない', async () => {
    const r = await render(<DeliverFace c={base} reload={() => {}} stopped />)
    expect(r.button(W['deliver.send'])?.disabled).toBe(true)
    expect(r.button(W['deliver.decline'])?.disabled).toBe(true)
    r.done()
  })
})

describe('成果の面', () => {
  it('ページを開く・HTML をダウンロード・本文をコピー', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const r = await render(<ResultFace c={done} reload={() => {}} stopped={false} />)
    expect(r.text()).toContain(W['result.heading'])
    const links = [...r.el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    expect(links).toContainEqual([W['result.openPage'], '/cases/c1/page?v=1'])
    expect(links).toContainEqual([W['result.download'], '/cases/c1/page?v=1&download=1'])
    expect(r.text()).toContain(W['result.downloadNote'])
    await r.click(r.button(W['result.copy']))
    expect(writeText).toHaveBeenCalledWith(PASTE)
    expect(r.button(W['result.copied'])).toBeDefined()
    expect(r.text()).toContain(W['event.delivery.done'])
    r.done()
  })

  it('履歴の「保存しました」に保存先の名前を入れる。文の無い種類と古い行は名前の無い文（#21）', async () => {
    const ev = (target?: DeliveryTarget) =>
      ({
        at,
        type: 'transition',
        from: '送付中',
        to: '送付中',
        event: 'delivery.done',
        by: 'libretto',
        ...(target && { target }),
      }) as const
    const c: CaseView = {
      ...done,
      events: [
        ev({ kind: 'paste' }),
        ev({ kind: 'page', shared: false }),
        ev({ kind: 'gdoc', folderId: 'f' }),
        ev({ kind: 'gsheet', folderId: 'f' }),
        ev(),
      ],
    }
    const r = await render(<History c={c} />)
    const lines = [...r.el.querySelectorAll('.history li span')].map((s) => s.textContent)
    expect(lines).toEqual([
      W['event.delivery.done'],
      W['event.delivery.done'],
      W['event.delivery.done.gdoc'],
      W['event.delivery.done.page'],
      W['event.delivery.done.paste'],
    ])
    r.done()
  })

  it('クリップボードが使えなければ、欄から選んでコピーするよう出す', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const r = await render(<ResultFace c={done} reload={() => {}} stopped={false} />)
    await r.click(r.button(W['result.copy']))
    expect(r.text()).toContain(W['result.copyFailed'])
    r.done()
  })
})

describe('完了した依頼', () => {
  it('題・完了日・開く', async () => {
    const r = await render(<Done />)
    await vi.waitFor(() => expect(r.text()).toContain('ブレストのまとめ'))
    expect(fetched).toContain('/api/cases?state=完了')
    expect(r.el.querySelector('time')?.getAttribute('datetime')).toBe(at)
    expect([...r.el.querySelectorAll('a')].map((a) => a.textContent)).toEqual([W['done.open']])
    r.done()
  })
})
