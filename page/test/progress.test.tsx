// @vitest-environment jsdom
// 進行の面（画面 3。docs/implementation.md 6.2.3 (8)）
import type { CaseView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgressFace } from '../src/faces/Progress.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-24T01:05:00.000Z'
const base: CaseView = {
  id: 'c1',
  title: 'ブレストのまとめ',
  state: '下書き中',
  turn: 'libretto',
  step: '下書きを書いています',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 0,
  revision: 4,
  costYen: 320,
  costCapYen: 1500,
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
  deliveries: [],
  events: [
    { at, type: 'created', to: '入口待ち' },
    { at, type: 'transition', from: '入口待ち', to: '入口待ち', event: 'entrance.drafted', by: 'libretto' },
    { at, type: 'transition', from: '入口待ち', to: '材料待ち', event: 'entrance.approve', by: '本人' },
    { at, type: 'rejected', event: 'cancel' },
    { at, type: 'transition', from: '材料待ち', to: '下書き中', event: 'materials.ready', by: 'libretto' },
  ],
}
const version = (n: number, state: CaseView['versions'][number]['state']) => ({
  n,
  at,
  chars: 2480,
  headings: 5,
  fingerprint: `f${n}`,
  state,
})

let respond: (body: Record<string, unknown>) => Response
const sent: Record<string, unknown>[] = []
beforeEach(() => {
  sent.length = 0
  respond = () => new Response('{"state":"停止","turn":"本人","revision":5,"replayed":false}')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/cases/c1/actions' || path === '/api/cases/c1/materials') {
      const body = JSON.parse(String(init.body))
      sent.push({ ...body, path })
      return respond(body)
    }
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render(c: CaseView, stopped = false) {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const reload = vi.fn()
  await act(async () => root.render(<ProgressFace c={c} reload={reload} stopped={stopped} />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  return {
    el,
    reload,
    text: () => el.textContent ?? '',
    button,
    steps: () => [...el.querySelectorAll('.step')].map((s) => s.className.replace('step ', '')),
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('進行の面', () => {
  it('下書き中: いまの 1 行・次にすること・段取りの帯・履歴（拒否の行は出さない）', async () => {
    const r = await render(base)
    expect(r.text()).toContain('下書きを書いています')
    expect(r.text()).toContain(W['progress.nextNone'])
    expect(r.text()).toContain(W['progress.redoLater'])
    expect(r.steps()).toEqual(['step-done', 'step-done', 'step-now', 'step-todo', 'step-todo', 'step-todo'])
    expect(r.el.querySelector('[aria-current="step"]')?.textContent).toContain(W['progress.step.draft'])
    expect(r.text()).toContain(W['progress.versionsEmpty'])
    const history = [...r.el.querySelectorAll('.history li span')].map((s) => s.textContent)
    expect(history).toEqual([
      W['event.materials.ready'],
      W['event.entrance.approve'],
      W['event.entrance.drafted'],
      W['event.created'],
    ])
    // 「作り直しを依頼」のボタンは置かない（6.2.3 (8)）。資料が無ければ欄ごと出さない
    expect(r.button('作り直しを依頼')).toBeUndefined()
    expect(r.el.querySelector('#h-materials')).toBeNull()
    r.done()
  })

  it('資料: 出典はリンクで、集めたものに印。集められなかったときは 1 行（6.3.3 (7)）', async () => {
    const r = await render({
      ...base,
      materials: [
        {
          id: 'S01',
          kind: '出典',
          title: 'お知らせ',
          where: 'https://example.com/a',
          status: '取り寄せ済み',
          gathered: true,
        },
        { id: 'S02', kind: '出典', title: '週報', where: 'https://example.com/b', status: '取り寄せ済み' },
      ],
    })
    const links = [...r.el.querySelectorAll('#h-materials ~ ul a')] as HTMLAnchorElement[]
    expect(links.map((a) => [a.href, a.target, a.rel])).toEqual([
      ['https://example.com/a', '_blank', 'noopener noreferrer'],
      ['https://example.com/b', '_blank', 'noopener noreferrer'],
    ])
    expect(r.el.querySelectorAll('#h-materials ~ ul .badge')).toHaveLength(1)
    expect(r.text()).toContain(W['progress.materialGathered'])
    expect(r.text()).not.toContain(W['progress.gatherFailed'])
    r.done()
    const f = await render({ ...base, materials: [], gatherFailed: true })
    expect(f.el.querySelector('#h-materials')).not.toBeNull()
    expect(f.text()).toContain(W['progress.gatherFailed'])
    f.done()
  })

  it('検品中: n 回目のチェックと、前の版の判定。今の版だけ「チェック中」', async () => {
    const r = await render({
      ...base,
      state: '検品中',
      step: 'チェックしています',
      version: 2,
      rounds: { series: 1, used: 1, max: 3 },
      versions: [version(1, '不合格'), version(2, '検品中')],
      review: {
        n: 1,
        passed: 6,
        failed: [{ checkId: 'C01', title: '本文は 2,200〜2,800 字', verdict: 'fail' }],
        skipped: 0,
        needsConfirmation: [],
        sources: [],
      },
    })
    expect(r.text()).toContain(w('progress.round', { n: 2, max: 3 }))
    expect(r.steps()[3]).toBe('step-now')
    const items = [...r.el.querySelectorAll('.version')]
    expect(items.map((v) => v.querySelector('.strong')?.textContent)).toEqual(['バージョン 2', 'バージョン 1'])
    expect(items[0]?.textContent).toContain(W['progress.ver.検品中'])
    expect(items[1]?.textContent).toContain(W['progress.ver.不合格'])
    expect(items[1]?.textContent).toContain('本文は 2,200〜2,800 字')
    expect(items[0]?.textContent).toContain(w('progress.versionSize', { chars: 2480, headings: 5 }))
    r.done()
  })

  it('おまかせでは承認の段に「確認を求めずに進みます」', async () => {
    const r = await render({ ...base, mode: 'おまかせ' })
    expect(r.el.querySelectorAll('.step')[4]?.textContent).toContain(W['progress.stepAuto'])
    r.done()
  })

  it('「この依頼を中止」は確認の後に stop.case を送り、読み直す', async () => {
    const r = await render(base)
    await r.click(r.button(W['progress.stop']))
    expect(sent).toEqual([])
    await r.click([...document.querySelectorAll('.dialog button')].find((b) => b.textContent === W['progress.stop']))
    expect(sent).toMatchObject([{ type: 'stop.case', expectedRevision: 4 }])
    expect(sent[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.reload).toHaveBeenCalled()
    r.done()
  })

  it('すべて停止しているあいだは中止を押せない', async () => {
    const r = await render(base, true)
    expect(r.button(W['progress.stop'])?.disabled).toBe(true)
    r.done()
  })

  it('停止: 止まった理由と、止まった段。「新しい依頼として出し直す」で新しい依頼へ移る', async () => {
    respond = () => new Response('{"state":"停止","turn":"本人","revision":6,"replayed":false,"newCaseId":"c2"}')
    const stoppedCase: CaseView = {
      ...base,
      state: '停止',
      turn: '本人',
      step: '中止しました',
      stopReason: '書けなかった',
      revision: 5,
      events: [
        ...base.events,
        { at, type: 'transition', from: '下書き中', to: '停止', event: 'fail.system', by: 'libretto' },
      ],
    }
    const r = await render(stoppedCase)
    expect(r.text()).toContain(W['progress.stoppedHeading'])
    expect(r.text()).toContain(W['reason.書けなかった'])
    expect(r.steps()).toEqual(['step-done', 'step-done', 'step-halted', 'step-todo', 'step-todo', 'step-todo'])
    expect(r.button(W['progress.stop'])).toBeUndefined()
    await r.click(r.button(W['progress.restart']))
    expect(sent).toMatchObject([{ type: 'restart_as_new', expectedRevision: 5 }])
    await vi.waitFor(() => expect(location.pathname).toBe('/cases/c2'))
    r.done()
  })

  it('停止の理由が表に無いときは「中止しました」', async () => {
    const r = await render({ ...base, state: '停止', turn: '本人', stopReason: '未知の理由' })
    expect(r.el.querySelector('.now-reason')?.textContent).toBe(W['reason.other'])
    r.done()
  })

  it('取り消し: 操作は無い', async () => {
    const r = await render({ ...base, state: '取り消し', turn: '本人', step: '取り消しました' })
    expect(r.text()).toContain(W['progress.cancelledHeading'])
    expect(r.el.querySelectorAll('button')).toHaveLength(0)
    r.done()
  })

  it('材料待ち・本人の番: 渡してほしいものと貼り付けの欄。貼った文を資料の口へ送る（6.2.4 (5)）', async () => {
    const wanting: CaseView = {
      ...base,
      state: '材料待ち',
      turn: '本人',
      step: '資料を貼り付けてください',
      events: base.events.slice(0, 3),
      entrance: {
        brief: {
          docType: '記事',
          subject: 'ブレストで決まった 3 つの方針',
          wanted: ['ブレストのメモか記録'],
          gather: [],
          audience: '一般の読者',
          destinations: [{ kind: 'page', shared: false }],
          shape: '2,000 字前後',
          materials: [],
          voice: '合わせない',
          sources: '出典なし',
          mustNot: [],
        },
        assumptions: [],
        undecided: { items: [], mismatches: [] },
        setFingerprint: 'set1',
        checks: { count: 0, byCategory: {}, family: '同系統', items: [] },
      },
    }
    const r = await render(wanting)
    expect(r.text()).toContain('資料を貼り付けてください')
    expect(r.text()).toContain('ブレストのメモか記録')
    expect(r.text()).not.toContain(W['progress.lead'])
    expect(r.el.querySelector('[aria-current="step"]')?.textContent).toContain(W['progress.stepYours'])
    const send = r.button(W['materials.send'])
    // 空のまま押すと送らずに欄へ移る
    const area = r.el.querySelector('textarea') as HTMLTextAreaElement
    await r.click(send)
    expect(sent).toEqual([])
    expect(document.activeElement).toBe(area)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, ' 方針 1: 見直し ')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(r.text()).toContain(w('materials.count', { n: '9' }))
    await r.click(send)
    expect(sent).toEqual([
      {
        path: '/api/cases/c1/materials',
        type: 'materials.provided',
        expectedRevision: 4,
        text: ' 方針 1: 見直し ',
        eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ])
    expect(r.reload).toHaveBeenCalled()
    // 中止は残す
    expect(r.button(W['progress.stop'])).toBeDefined()
    r.done()
  })
})
