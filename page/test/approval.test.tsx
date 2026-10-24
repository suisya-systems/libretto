// @vitest-environment jsdom
// 承認の面（画面 4。docs/implementation.md 6.2.5 (8)）
import type { CaseView } from '@libretto/shared/api'
import { JEV_PARTIAL } from '@libretto/shared/checks'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalFace } from '../src/faces/Approval.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-10-24T01:05:00.000Z'
const version = (n: number, state: CaseView['versions'][number]['state']) => ({
  n,
  at,
  chars: 2480,
  headings: 5,
  fingerprint: `f${n}`,
  state,
})
const review = (failed: NonNullable<CaseView['review']>['failed'] = []) => ({
  n: 2,
  passed: 7 - failed.length,
  failed,
  skipped: 0,
  needsConfirmation: [],
  sources: [],
  familyNote: '確認項目は作り手と同じ系統が書きました',
  jevNote: '判定専用モデルは使っていません',
})
const base: CaseView = {
  id: 'c1',
  title: 'ブレストのまとめ',
  state: '承認待ち',
  turn: '本人',
  step: '最終版を確認してください',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 2,
  revision: 9,
  costYen: 640,
  costCapYen: 1500,
  approvalKind: '完成稿',
  materials: [],
  versions: [version(1, '不合格'), version(2, '合格')],
  review: review(),
  rounds: { series: 1, used: 2, max: 3 },
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
    { at, type: 'transition', from: '検品中', to: '承認待ち', event: 'review.pass', by: 'libretto' },
  ],
}

let respond: (body: Record<string, unknown>) => Response
const sent: Record<string, unknown>[] = []
const fetched: string[] = []
beforeEach(() => {
  sent.length = 0
  fetched.length = 0
  respond = () => new Response('{"state":"送付確認待ち","turn":"libretto","revision":10,"replayed":false}')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    fetched.push(path)
    if (path === '/api/cases/c1/actions') {
      const body = JSON.parse(String(init.body))
      sent.push(body)
      return respond(body)
    }
    if (path.startsWith('/api/cases/c1/drafts/')) return new Response('<h1>題</h1><p>本文です。</p>')
    if (path.startsWith('/api/cases/c1/diff'))
      return new Response(JSON.stringify({ changes: [{ kind: 'changed', before: '前の文', after: '新しい文' }] }))
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

async function render(c: CaseView, stopped = false, isolation?: 'strong' | 'weak' | 'broken') {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const reload = vi.fn()
  await act(async () => root.render(<ApprovalFace c={c} reload={reload} stopped={stopped} isolation={isolation} />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  return {
    el,
    reload,
    text: () => el.textContent ?? '',
    button,
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('承認の面', () => {
  it('全部通った: 本文（組み立てた HTML）と「すべて通りました」、注記', async () => {
    const r = await render(base)
    expect(r.text()).toContain('最終版を確認してください')
    expect(r.text()).toContain(w('approval.allPassed', { n: 7 }))
    expect(fetched).toContain('/api/cases/c1/drafts/2?format=html')
    expect(r.el.querySelector('.doc-body h1')?.textContent).toBe('題')
    expect(r.text()).toContain(W['approval.sameFamily'])
    expect(r.text()).toContain(W['approval.noJudgeModel'])
    // 判定の注記の文はホストの文ではなく画面の文
    expect(r.text()).not.toContain('確認項目は作り手と同じ系統が書きました')
    r.done()
  })

  it('判定専用の AI が確かめた数と、確信が低く回した数を 1 行で出す。一部つながらなかった注記（7.6 (6)）', async () => {
    const { jevNote: _, ...rest } = review()
    const r = await render({
      ...base,
      review: { ...rest, jev: { units: 12, unsure: 1 }, jevNote: JEV_PARTIAL },
    })
    expect(r.text()).toContain(w('approval.judgeModel', { units: 12 }))
    expect(r.text()).toContain(w('approval.judgeModelUnsure', { unsure: 1 }))
    expect(r.text()).toContain(W['approval.judgeModelPartial'])
    expect(r.text()).not.toContain(W['approval.noJudgeModel'])
    r.done()
    const r2 = await render({ ...base, review: { ...rest, jev: { units: 3, unsure: 0 } } })
    expect(r2.text()).toContain(w('approval.judgeModel', { units: 3 }))
    expect(r2.text()).not.toContain(w('approval.judgeModelUnsure', { unsure: 0 }))
    r2.done()
  })

  it('残りあり（往復上限）: 件数・項目・理由文。形式の不合格も並ぶ', async () => {
    const r = await render({
      ...base,
      review: review([
        {
          checkId: 'C02',
          title: '初見の読者が決まったことを言える',
          verdict: 'fail',
          reason: '結論が最後に出てきます。',
        },
      ]),
      formatReview: {
        ...review([{ checkId: 'C08', title: 'Web ページに本文がそのまま出る', verdict: 'fail' }]),
        passed: 0,
      },
    })
    expect(r.text()).toContain(w('approval.remaining', { n: 2 }))
    expect(r.text()).toContain(W['approval.remainingLead'])
    const items = [...r.el.querySelectorAll('.result')].map((x) => x.textContent)
    expect(items[0]).toContain('結論が最後に出てきます。')
    expect(items[1]).toContain(W['approval.format'])
    r.done()
  })

  it('出典が見つからなかった文ごとに「【要確認】を付けて残す / この文を削る」を選び、全部の答えを送る。削るがあればボタンの文が替わる（6.3.1 (9)）', async () => {
    const r = await render({
      ...base,
      review: {
        ...review(),
        needsConfirmation: [
          { claimId: 'M01', text: '東京が最大の拠点だ。', where: '見出し「題」の 2 段落目' },
          { claimId: 'M02', text: '昨年は 3 回あった。', where: '冒頭の 1 段落目' },
        ],
      },
    })
    expect(r.text()).toContain(W['approval.marksHeading'])
    expect(r.text()).toContain('見出し「題」の 2 段落目')
    const radios = [...r.el.querySelectorAll('.fact-mark')].map((li) => [...li.querySelectorAll('[role="radio"]')])
    expect(radios.map((x) => x.length)).toEqual([2, 2])
    await r.click(radios[1]?.[1])
    expect(r.button(W['approval.ok'])).toBeUndefined()
    await r.click(r.button(W['approval.okCut']))
    expect(sent).toMatchObject([{ type: 'approval.ok', marks: { M01: '印のまま', M02: '削る' } }])
    r.done()
  })

  it('出典ごとのチェックの結果と主張の件数。リンクは新しいタブ（6.3.1 (11)）', async () => {
    const r = await render({
      ...base,
      review: {
        ...review(),
        sources: [
          { ref: 'https://example.com/a', title: '調査 A', verdict: '支持', claimIds: ['K01', 'K02'] },
          { ref: 'https://example.com/b', title: '調査 B', verdict: '開けない', claimIds: ['K03'] },
        ],
      },
    })
    const items = [...r.el.querySelectorAll('.source')]
    expect(items.map((x) => x.textContent)).toEqual([
      `調査 A（${W['approval.sourceOpens']}）${W['approval.source.支持']}${w('approval.sourceClaims', { n: 2 })}`,
      `調査 B（${W['approval.sourceOpens']}）${W['approval.source.開けない']}${w('approval.sourceClaims', { n: 1 })}`,
    ])
    const a = items[0]?.querySelector('a')
    expect([a?.getAttribute('href'), a?.getAttribute('target'), a?.getAttribute('rel')]).toEqual([
      'https://example.com/a',
      '_blank',
      'noopener noreferrer',
    ])
    expect(r.text()).not.toContain(W['approval.marksHeading'])
    r.done()
  })

  it('文体の比べ: 文末・一文の長さ・一人称・読み比べを、あなたとこの版で並べる（6.3.2 (9)）', async () => {
    const r = await render({
      ...base,
      review: {
        ...review(),
        voiceMatch: {
          endings: { main: 'です・ます', you: 0.92, draft: 0.5, ok: false },
          sentenceLength: { you: 38, draft: 41.5, ok: true },
          firstPerson: { you: '私', draft: '私', ok: true },
          readAlike: null,
        },
      },
    })
    expect(r.text()).toContain(W['approval.voiceHeading'])
    const rows = [...r.el.querySelectorAll('.voice-match tbody tr')].map((tr) =>
      [...tr.children].map((c) => c.textContent),
    )
    expect(rows).toEqual([
      [w('approval.voice.endings', { main: 'です・ます' }), '92%', '50%', W['approval.voice.ok.false']],
      [
        W['approval.voice.sentenceLength'],
        w('approval.voice.chars', { n: 38 }),
        w('approval.voice.chars', { n: 42 }),
        W['approval.voice.ok.true'],
      ],
      [W['approval.voice.firstPerson'], '私', '私', W['approval.voice.ok.true']],
      [W['approval.voice.readAlike'], W['approval.voice.readAlikeNote'], W['approval.voice.ok.null']],
    ])
    r.done()
    const plain = await render(base)
    expect(plain.text()).not.toContain(W['approval.voiceHeading'])
    plain.done()
  })

  it('「これで承認する」は見ている版の指紋を approval.ok に添えて送る', async () => {
    const r = await render(base)
    await r.click(r.button(W['approval.ok']))
    expect(sent).toMatchObject([{ type: 'approval.ok', expectedRevision: 9, marks: {}, versionFingerprint: 'f2' }])
    expect(sent[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.reload).toHaveBeenCalled()
    r.done()
  })

  it('409 は「もう進んでいます。読み直します」', async () => {
    respond = () => new Response('{"reason":"stale"}', { status: 409 })
    const r = await render(base)
    await r.click(r.button(W['approval.ok']))
    expect(r.text()).toContain(W['action.moved'])
    expect(r.reload).toHaveBeenCalled()
    r.done()
  })

  it('「直してほしいことを伝える」は書いた文を approval.redo で送る', async () => {
    respond = () => new Response('{"state":"下書き中","turn":"libretto","revision":10,"replayed":false}')
    const r = await render(base)
    await r.click(r.button(W['approval.redo']))
    const send = r.button(W['approval.redoSend'])
    expect(send?.disabled).toBe(true)
    const area = r.el.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(area, '2 つ目の方針に例を足して')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await r.click(r.button(W['approval.redoSend']))
    expect(sent).toMatchObject([
      { type: 'approval.redo', expectedRevision: 9, instruction: '2 つ目の方針に例を足して' },
    ])
    r.done()
  })

  it('前のバージョンとの違いに切り替えられる（2 版目から）', async () => {
    const r = await render(base)
    await r.click(r.button(W['approval.diffTab']))
    expect(r.el.querySelector('.diff-changed del')?.textContent).toBe('前の文')
    expect(r.el.querySelector('.diff-changed ins')?.textContent).toBe('新しい文')
    r.done()
    const one = await render({ ...base, version: 1, versions: [version(1, '合格')] })
    expect(one.button(W['approval.diffTab'])).toBeUndefined()
    one.done()
  })

  it('すべて停止しているあいだは押せない', async () => {
    const r = await render(base, true)
    expect(r.button(W['approval.ok'])?.disabled).toBe(true)
    expect(r.button(W['approval.redo'])?.disabled).toBe(true)
    r.done()
  })

  it('3 回目を待たずに上げた（直らない）: なぜ今あなたの番かの 1 行と、直らなかった項目の印', async () => {
    const r = await render({
      ...base,
      review: {
        ...review([
          { checkId: 'C01', title: '本文は 2,000 字以上', verdict: 'fail' },
          { checkId: 'C02', title: '決まったことが先に出る', verdict: 'unable' },
        ]),
        escalate: { why: '直らない', checkIds: ['C01'] },
      },
    })
    expect(r.text()).toContain(W['approval.early.直らない'])
    const items = [...r.el.querySelectorAll('.result')]
    expect(items[0]?.querySelector('.b-alert')?.textContent).toBe(W['approval.stuck'])
    expect(items[1]?.textContent).not.toContain(W['approval.stuck'])
    expect(items[1]?.textContent).toContain(W['approval.unable'])
    r.done()
  })

  it('3 回目を待たずに上げた（判定できない）: 1 行は出し、「2 回続けて」の印は付けない', async () => {
    const r = await render({
      ...base,
      rounds: { series: 1, used: 1, max: 3 },
      review: {
        ...review([{ checkId: 'C02', title: '決まったことが先に出る', verdict: 'unable' }]),
        escalate: { why: '判定できない', checkIds: ['C02'] },
      },
    })
    expect(r.text()).toContain(W['approval.early.判定できない'])
    expect(r.text()).not.toContain(W['approval.stuck'])
    r.done()
  })

  it('往復上限で上がったとき（escalate が無い）は早めの 1 行を出さない', async () => {
    const r = await render({ ...base, review: review([{ checkId: 'C01', title: 't', verdict: 'fail' }]) })
    expect(r.text()).not.toContain(W['approval.early.直らない'])
    expect(r.text()).not.toContain(W['approval.early.判定できない'])
    r.done()
  })

  it('履歴: 不合格の 1 行は行き先で替わる（書き直し・確認・中止）', async () => {
    const ev = (to: CaseView['state']) =>
      ({ at, type: 'transition', from: '検品中', to, event: 'review.fail', by: 'libretto' }) as const
    const r = await render({ ...base, events: [ev('下書き中'), ev('承認待ち'), ev('停止')] })
    const lines = [...r.el.querySelectorAll('.history li span')].map((x) => x.textContent)
    expect(lines).toEqual([W['event.review.fail.stop'], W['event.review.fail.up'], W['event.review.fail']])
    r.done()
  })

  it('残りの件数は直しきれなかった項目だけ。まだ確かめていない項目は別の印で数える', async () => {
    const r = await render({
      ...base,
      review: {
        ...review([{ checkId: 'C01', title: '本文は 1,700〜2,300 字', verdict: 'fail' }]),
        passed: 6,
        skipped: 11,
      },
    })
    expect(r.text()).toContain(w('approval.remaining', { n: 1 }))
    expect(r.text()).toContain(w('approval.skipped', { n: 11 }))
    r.done()
  })
})

describe('チェック項目を隠す仕組みの帯（8.10 (6)）', () => {
  it('動かないときは下書きが始まらないことを警告の帯で出す', async () => {
    const r = await render({ ...base, version: 1, versions: [version(1, '合格')] }, false, 'broken')
    const band = r.el.querySelector('.band-stopped[role="alert"]')
    expect(band?.textContent).toContain(W['band.isolationBroken'])
    expect(band?.textContent).toContain(W['band.isolationLink'])
    expect(r.text()).not.toContain(W['band.isolationWeak'])
    r.done()
  })
})
