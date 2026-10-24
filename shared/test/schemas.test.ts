import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import * as api from '../src/api.ts'
import { Review } from '../src/checks.ts'
import { BriefFile, CaseEvent, CaseRecord, UndecidedFile } from '../src/ledger.ts'

const card = {
  id: 'c1',
  title: '記事',
  state: '入口待ち',
  turn: 'libretto',
  step: '依頼書と確認項目を書いています',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 0,
  revision: 1,
  costYen: 0,
  costCapYen: 1500,
}
const view = {
  ...card,
  materials: [],
  versions: [],
  rounds: { series: 1, used: 0, max: 3 },
  deliveryPlan: {
    targets: [{ kind: 'paste' }],
    fingerprint: 'f',
    visibility: 'あなただけ',
    overwrites: false,
    quotesOthers: false,
  },
  deliveries: [],
  events: [],
}
const entrance = {
  brief: {
    docType: '記事',
    subject: 'ブレストで決まった 3 つの方針と、その理由',
    audience: '一般の読者',
    destinations: [{ kind: 'page', shared: false }],
    shape: '2,500 字前後',
    materials: [],
    voice: '合わせる',
    sources: '出典付き',
    mustNot: ['社名の実名'],
  },
  assumptions: [],
  undecided: {
    items: [
      {
        id: 'u1',
        question: '読者は？',
        options: [
          { id: 'a', label: '社内' },
          { id: 'b', label: '一般' },
        ],
        multiple: false,
        recommended: ['b'],
      },
    ],
    mismatches: [],
  },
  setFingerprint: 's',
  checks: { count: 0, byCategory: {}, family: '同系統', items: [] },
}

describe('CaseView（5.3.2）', () => {
  it('入口の組が無いあいだ（T6 より前）も通る', () => {
    expect(api.CaseView.safeParse(view).success).toBe(true)
  })
  it('入口の組があれば通り、組の欄が欠けると落ちる', () => {
    expect(api.CaseView.safeParse({ ...view, entrance }).success).toBe(true)
    const { setFingerprint: _, ...broken } = entrance
    expect(api.CaseView.safeParse({ ...view, entrance: broken }).success).toBe(false)
  })
  it('承認待ちの種別は 2 つだけ', () => {
    expect(api.CaseCard.safeParse({ ...card, state: '承認待ち', approvalKind: '構成案' }).success).toBe(true)
    expect(api.CaseCard.safeParse({ ...card, state: '承認待ち', approvalKind: '下書き' }).success).toBe(false)
  })
  it('おすすめが選択肢に無い Undecided は落ちる', () => {
    expect(api.Undecided.safeParse({ ...entrance.undecided.items[0], recommended: ['z'] }).success).toBe(false)
  })
  it('1 つだけの問いはおすすめも答えも 1 件。全部選べる問いは複数。任せるは選択肢の id にできない（6.2.6 (2)）', () => {
    const u = entrance.undecided.items[0] as api.Undecided
    const ok = (v: object) => api.Undecided.safeParse({ ...u, ...v }).success
    expect(ok({ recommended: ['a', 'b'] })).toBe(false)
    expect(ok({ multiple: true, recommended: ['a', 'b'] })).toBe(true)
    expect(ok({ multiple: true, recommended: [] })).toBe(false)
    expect(ok({ multiple: true, recommended: ['a', 'a'] })).toBe(false)
    expect(ok({ answer: ['a', 'b'] })).toBe(false)
    expect(ok({ multiple: true, answer: ['a', 'b'] })).toBe(true)
    expect(ok({ answer: '任せる' })).toBe(true)
    expect(ok({ answer: 'a' })).toBe(false)
    expect(
      ok({
        options: [
          { id: '任せる', label: 'x' },
          { id: 'b', label: 'y' },
        ],
      }),
    ).toBe(false)
  })
})

describe('CaseAction（5.3.1）', () => {
  const eventId = '7f1c2a4e-3b5d-4c6e-8f90-1a2b3c4d5e6f'
  const common = { eventId, expectedRevision: 3 }
  it('eventId と expectedRevision があれば通る', () => {
    expect(api.CaseAction.safeParse({ type: 'cancel', ...common }).success).toBe(true)
  })
  it('eventId が無い・UUID でない操作は落ちる', () => {
    expect(api.CaseAction.safeParse({ type: 'cancel', expectedRevision: 3 }).success).toBe(false)
    expect(api.CaseAction.safeParse({ type: 'cancel', expectedRevision: 3, eventId: 'x' }).success).toBe(false)
  })
  it('指紋を持たない操作も expectedRevision が無ければ落ちる（二度押しの予備）', () => {
    const noFingerprint = [
      { type: 'entrance.revise', note: '短く' },
      { type: 'delivery.change', targets: [{ kind: 'paste' }] },
      { type: 'delivery.add', target: { kind: 'paste' } },
      { type: 'delivery.decline' },
      { type: 'share.revoke', shareToken: 't' },
      { type: 'stop.case' },
      { type: 'cancel' },
      { type: 'restart_as_new' },
    ]
    for (const a of noFingerprint) {
      expect(api.CaseAction.safeParse({ ...a, ...common }).success).toBe(true)
      expect(api.CaseAction.safeParse({ ...a, eventId }).success).toBe(false)
    }
  })
  it('全部の type が expectedRevision を必須にしている', () => {
    for (const o of api.CaseAction.options) expect(o.shape.expectedRevision.safeParse(undefined).success).toBe(false)
  })
  it('知らない type は落ちる', () => {
    expect(api.CaseAction.safeParse({ type: 'draft.done', ...common }).success).toBe(false)
  })
})

describe('Review（7.5）', () => {
  const base = {
    version: 1,
    series: 1,
    round: 1,
    at: 't',
    phase: '本文',
    attempt: 1,
    failedSummaries: ['x'],
    marks: [],
    sources: [],
  }
  const results = [
    { id: 'C01', verdict: 'fail', by: 'code', measured: { chars: 1200 } },
    { id: 'C02', verdict: 'skipped', by: 'claude' },
  ]
  it('機械判定で打ち切った結果は skipped を含む全項目で表す', () => {
    expect(Review.safeParse({ ...base, results, pass: false }).success).toBe(true)
  })
  it('skipped が残っているのに合格とは書けない', () => {
    expect(Review.safeParse({ ...base, results, pass: true }).success).toBe(false)
  })
  it('skipped は単位ごとの結果を持たない', () => {
    const bad = [{ id: 'C02', verdict: 'skipped', by: 'jev', units: [{ index: 0, yes: true }] }]
    expect(Review.safeParse({ ...base, results: bad, pass: false }).success).toBe(false)
  })
})

describe('ledger（9.2）', () => {
  it('CaseRecord は revision・candidateId・approvalKind を持ち、costYen を持たない', () => {
    const rec = {
      caseId: 'c1',
      title: '記事',
      state: '承認待ち',
      turn: '本人',
      step: '確認待ち',
      mode: '確認しながら',
      origin: { kind: '合図', source: 'gmail' },
      auto: false,
      docType: '記事',
      destination: [{ kind: 'paste' }],
      candidateId: 'gmail:abc',
      version: 2,
      series: 1,
      round: 1,
      revision: 7,
      approvalKind: '完成稿',
      createdAt: 't',
      updatedAt: 't',
    }
    expect(CaseRecord.safeParse(rec).success).toBe(true)
    expect(Object.keys(CaseRecord.shape)).not.toContain('costYen')
  })
  it('届け先の変更は transition 行の detail に入り、destination_changed は無い', () => {
    const row = { seq: 1, eventId: 'e', caseId: 'c1', at: 't' }
    const t23b = {
      ...row,
      type: 'transition',
      from: '承認待ち',
      to: '承認待ち',
      event: 'delivery.change',
      by: '本人',
      turn: '本人',
      step: '',
      approvalKind: '完成稿',
      destination: [{ kind: 'paste' }],
    }
    expect(CaseEvent.safeParse(t23b).success).toBe(true)
    expect(CaseEvent.safeParse({ ...row, type: 'destination_changed' }).success).toBe(false)
  })
  it('CaseEvent の type と画面の EventRow の type が揃っている', () => {
    expect(CaseEvent.options.map((o) => o.shape.type.value).sort()).toEqual([...api.CaseEventType.options].sort())
  })
})

// 本人に見える型の欄の名前・型の名前に「出さない語」を使わない（5.1・11.2）
const FORBIDDEN = [
  'claude',
  'anthropic',
  'openai',
  'gpt',
  'codex',
  'prompt',
  'branch',
  'commit',
  'pr',
  'ci',
  'model',
  'holdout',
  'scenario',
]
const words = (name: string) => name.split(/(?<=[a-z0-9])(?=[A-Z])|[^A-Za-z0-9]+/).map((w) => w.toLowerCase())

// レコードのキーは識別子の値なので見ない（11.2）。値の型だけたどる
function fieldNames(schema: z.ZodType, out = new Set<string>()): Set<string> {
  const def = schema.def as unknown as Record<string, unknown> & { type: string }
  const walk = (s: unknown) => fieldNames(s as z.ZodType, out)
  switch (def.type) {
    case 'object':
      for (const [k, v] of Object.entries(def.shape as Record<string, unknown>)) {
        out.add(k)
        walk(v)
      }
      break
    case 'array':
      walk(def.element)
      break
    case 'optional':
    case 'nullable':
      walk(def.innerType)
      break
    case 'union':
      for (const o of def.options as unknown[]) walk(o)
      break
    case 'record':
      walk(def.valueType)
      break
  }
  return out
}

describe('出さない語（11.2）', () => {
  const personFacing = [
    api.CaseView,
    api.HomeView,
    api.Settings,
    api.ActionResult,
    api.ActionRejected,
    api.ConversationView,
    api.ConversationAccepted,
    api.ConversationRejected,
    ...Object.values(api.SseData),
  ]
  const names = new Set(personFacing.flatMap((s) => [...fieldNames(s)]))

  it('欄の名前をたどれている', () => {
    for (const n of ['revision', 'setFingerprint', 'approvalKind', 'byCategory', 'last4', 'replayed'])
      expect(names).toContain(n)
  })
  it('本人に見える型の欄の名前に出さない語が無い', () => {
    expect([...names].filter((n) => words(n).some((w) => FORBIDDEN.includes(w)))).toEqual([])
  })
  it('api.ts の型の名前に出さない語が無い', () => {
    expect(Object.keys(api).filter((n) => words(n).some((w) => FORBIDDEN.includes(w)))).toEqual([])
  })
  it('検査が当たること（対照）', () => {
    expect(words('modelName').some((w) => FORBIDDEN.includes(w))).toBe(true)
    expect(words('openPR').some((w) => FORBIDDEN.includes(w))).toBe(true)
  })
})

describe('入口の組のファイル（6.2.6 (2)）', () => {
  it('前の形（recommended と答えが文字列 1 つ、multiple 無し）も読み、新しい形に直す', () => {
    const old = {
      items: [
        {
          id: 'U01',
          question: '読者は？',
          options: [
            { id: 'a', label: '社内' },
            { id: 'b', label: '一般' },
          ],
          recommended: 'b',
        },
      ],
      mismatches: [],
      answers: { U01: 'a', U02: '任せる' },
    }
    expect(UndecidedFile.parse(old)).toEqual({
      ...old,
      items: [{ ...old.items[0], multiple: false, recommended: ['b'] }],
      answers: { U01: ['a'], U02: '任せる' },
    })
    const d = BriefFile.shape.decisions.element
    expect(d.parse({ undecidedId: 'U01', answer: 'a', label: 'x' }).answer).toEqual(['a'])
    expect(d.parse({ undecidedId: 'U01', answer: '任せる', label: 'x' }).answer).toBe('任せる')
  })
})
