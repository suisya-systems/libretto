import { Role } from '@libretto/shared/ledger'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDb } from '../src/ledger/db.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { type CostCapNotice, createInvoke, DETAIL, type Job } from '../src/model/invoke.ts'
import { MODEL_BY_ROLE, modelFor } from '../src/model/roles.ts'

let ledger: Ledger
let notices: CostCapNotice[]
let logs: string[]
let caps: { caseCapYen: number | null; monthCapYen: number | null }
let ids: number

beforeEach(() => {
  ledger = new Ledger(openDb(':memory:'), () => new Date('2026-10-23T03:00:00Z'))
  ledger.insertCase({
    eventId: 'c1:created',
    caseId: 'c1',
    title: '記事',
    state: '入口待ち',
    turn: 'libretto',
    step: '',
    mode: '確認しながら',
    origin: { kind: '会話' },
    auto: false,
    docType: '記事',
    destination: [{ kind: 'paste' }],
  })
  notices = []
  logs = []
  caps = { caseCapYen: null, monthCapYen: null }
  ids = 0
})

function setup(script: ScriptEntry[], over: Partial<Parameters<typeof createInvoke>[0]> = {}) {
  const fake = createFake(script)
  const invoke = createInvoke({
    ledger,
    backends: { claude: fake.backend, openai: fake.backend, jev: fake.backend },
    caps: () => caps,
    onCostCap: (n) => {
      notices.push(n)
    },
    log: (l) => logs.push(l),
    newCallId: () => `k${++ids}`,
    ...over,
  })
  return { fake, invoke }
}

const job = (over: Partial<Job> = {}): Job => ({
  role: '下書き役・依頼書',
  caseId: 'c1',
  instruction: '依頼書を書く',
  materials: [],
  access: 'none',
  output: { kind: 'text' },
  limits: { maxYen: 100, timeoutMs: 1000 },
  signal: new AbortController().signal,
  ...over,
})
const R = '下書き役・依頼書' as const
const Out = z.object({ title: z.string() })
const costs = () =>
  ledger
    .listCosts('c1')
    .map((c) => [
      c.type,
      'callId' in c ? c.callId : '',
      c.type === 'hold' ? c.holdYen : c.type === 'charge' ? c.yen : 0,
    ])

// 11.2 の「出さない語」
const CLI_MARKERS = /claude|anthropic|openai|gpt|codex|prompt|branch|commit|\bPR\b|\bCI\b|model|holdout|scenario/i

describe('roles.ts', () => {
  it('全部の役割に系統とモデルがあり、表に無い役割は例外', () => {
    expect(Object.keys(MODEL_BY_ROLE).sort()).toEqual([...Role.options].sort())
    expect(modelFor('判定役・命題').family).toBe('jev')
    expect(() => modelFor('清書係')).toThrow(/no model/)
  })
})

describe('invoke: 費用の予約と精算（6.1.1 (2)(3)）', () => {
  it('呼ぶ前に hold、終わったら同じ callId で charge', async () => {
    const { invoke } = setup([{ role: R, nth: 1, reply: { text: 'こんにちは', costYen: 12 } }])
    expect(await invoke(job())).toMatchObject({ ok: true, text: 'こんにちは', costYen: 12, family: 'claude' })
    expect(costs()).toEqual([
      ['hold', 'k1', 100],
      ['charge', 'k1', 12],
    ])
  })

  it('実額 0 は 0、不明は予約の全額で精算する', async () => {
    const { invoke } = setup([
      { role: R, nth: 1, reply: { text: 'a', costYen: 0 } },
      { role: R, nth: 2, reply: { text: 'b', costYen: null } },
    ])
    expect((await invoke(job())).costYen).toBe(0)
    expect((await invoke(job())).costYen).toBe(100)
    expect(ledger.caseCostYen('c1')).toBe(100)
  })

  it('時間切れ・停止・中身の例外でも予約の全額で精算し、detail は固定の文言', async () => {
    const ac = new AbortController()
    const { invoke } = setup([
      { role: R, nth: 1, reply: { fail: 'hang' } },
      { role: R, nth: 2, reply: { fail: 'hang' } },
    ])
    expect(await invoke(job({ limits: { maxYen: 100, timeoutMs: 20 } }))).toMatchObject({
      ok: false,
      kind: 'timeout',
      costYen: 100,
      detail: DETAIL.timeout,
    })
    const stopping = invoke(job({ signal: ac.signal }))
    ac.abort()
    expect(await stopping).toMatchObject({ ok: false, kind: 'stopped', costYen: 100 })
    // 台本に無い 3 回目 = 中身の例外
    expect(await invoke(job())).toMatchObject({ ok: false, kind: 'unavailable', costYen: 100 })
    expect(logs.join('\n')).toMatch(/no script/)
    expect(ledger.caseCostYen('c1')).toBe(300)
    expect(costs().filter(([t]) => t === 'charge')).toHaveLength(3)
  })

  it('止めた後の呼び出しは予約せず、費用も上限の通知も出さない', async () => {
    caps = { caseCapYen: 0, monthCapYen: null }
    const ac = new AbortController()
    ac.abort()
    const { invoke, fake } = setup([])
    expect(await invoke(job({ signal: ac.signal }))).toMatchObject({ ok: false, kind: 'stopped', costYen: 0 })
    expect(fake.calls).toHaveLength(0)
    expect(notices).toEqual([])
    expect(costs()).toEqual([])
  })

  it('精算に失敗したら正常の結果にせず例外で終わる', async () => {
    ledger.recordCharge = () => {
      throw new Error('disk full')
    }
    const { invoke } = setup([{ role: R, nth: 1, reply: { text: 'a' } }])
    await expect(invoke(job())).rejects.toThrow(/disk full/)
  })
})

describe('invoke: 出力の検査と 1 回の言い直し（6.1.1 (4)）', () => {
  it('壊れた JSON → 言い直しは新しい callId で予約し、前の出力とエラーを渡す', async () => {
    const { invoke, fake } = setup([
      { role: R, nth: 1, reply: { text: '{"title":', costYen: 30 } },
      { role: R, nth: 2, reply: { text: '{"title":"題"}', costYen: 40 } },
    ])
    const out = await invoke(job({ output: { kind: 'json', schema: Out } }))
    expect(out).toMatchObject({ ok: true, json: { title: '題' }, costYen: 70 })
    expect(costs()).toEqual([
      ['hold', 'k1', 100],
      ['charge', 'k1', 30],
      ['hold', 'k2', 100],
      ['charge', 'k2', 40],
    ])
    expect(fake.calls[1]?.instruction).toBe('依頼書を書く')
    expect(fake.calls[1]?.materials.map((m) => m.name)).toEqual(['前の出力', '直すところ'])
    expect(fake.unused()).toEqual([])
  })

  it('zod と受け入れ規則は同じ 1 回を使う（zod で落ち、言い直しが受け入れ規則で落ちれば終わり）', async () => {
    const { invoke, fake } = setup([
      { role: R, nth: 1, reply: { text: '{"x":1}' } },
      { role: R, nth: 2, reply: { text: '{"title":"否定ではない"}' } },
      { role: R, nth: 3, reply: { text: '{"title":"使われない"}' } },
    ])
    const accept = (v: unknown) => ((v as { title: string }).title.includes('ない') ? ['否定語'] : [])
    expect(await invoke(job({ output: { kind: 'json', schema: Out, accept } }))).toMatchObject({
      ok: false,
      kind: 'invalid_output',
      detail: DETAIL.invalid_output,
    })
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.materials.find((m) => m.name === '直すところ')).toMatchObject({
      text: expect.stringMatching(/title/),
    })
  })

  it('受け入れ規則の違反だけでも言い直す', async () => {
    const { invoke, fake } = setup([
      { role: R, nth: 1, reply: { text: '{"title":"ない"}' } },
      { role: R, nth: 2, reply: { text: '{"title":"ある"}' } },
    ])
    const accept = (v: unknown) => ((v as { title: string }).title === 'ない' ? ['否定語があります'] : [])
    expect(await invoke(job({ output: { kind: 'json', schema: Out, accept } }))).toMatchObject({
      ok: true,
      json: { title: 'ある' },
    })
    expect(fake.calls[1]?.materials.at(-1)).toEqual({ name: '直すところ', text: '否定語があります' })
  })

  it('files の欠けも同じ 1 回', async () => {
    const { invoke } = setup([
      { role: '作り手', nth: 1, reply: { text: '', files: [] } },
      { role: '作り手', nth: 2, reply: { text: '', files: ['draft-01.md'] } },
    ])
    const out = await invoke(job({ role: '作り手', output: { kind: 'files', expect: ['draft-01.md'] } }))
    expect(out).toMatchObject({ ok: true, files: ['draft-01.md'] })
  })

  it('言い直しで足りないファイルだけ書けば、前の呼び出しの分と合わせて揃う', async () => {
    const { invoke } = setup([
      { role: '作り手', nth: 1, reply: { text: '', files: ['draft-02.md'] } },
      { role: '作り手', nth: 2, reply: { text: '', files: ['draft-02.done'] } },
    ])
    const out = await invoke(
      job({ role: '作り手', output: { kind: 'files', expect: ['draft-02.md', 'draft-02.done'] } }),
    )
    expect(out).toMatchObject({ ok: true, files: ['draft-02.md', 'draft-02.done'] })
  })
})

describe('invoke: 費用上限の通知（6.1.1 (1)）', () => {
  it('案件上限に当たると hold を書かず、中身を呼ばず、通知を 1 回', async () => {
    caps = { caseCapYen: 50, monthCapYen: null }
    const { invoke, fake } = setup([])
    expect(await invoke(job())).toMatchObject({ ok: false, kind: 'budget', scope: '案件', costYen: 0 })
    expect(notices).toEqual([{ caseId: 'c1', scope: '案件', callId: 'k1', eventId: 'c1:cost.cap:k1' }])
    expect(fake.calls).toHaveLength(0)
    expect(costs()).toEqual([])
  })

  it('言い直しの予約が拒まれたら budget。1 回目の費用は残る', async () => {
    caps = { caseCapYen: null, monthCapYen: 150 }
    const { invoke } = setup([{ role: R, nth: 1, reply: { text: '壊れた', costYen: 60 } }])
    expect(await invoke(job({ output: { kind: 'json', schema: Out } }))).toMatchObject({
      ok: false,
      kind: 'budget',
      scope: '全体',
      costYen: 60,
    })
    expect(ledger.caseCostYen('c1')).toBe(60)
    expect(notices).toEqual([{ caseId: 'c1', scope: '全体', callId: 'k2', eventId: 'c1:cost.cap:k2' }])
  })

  it('中身が呼び出しの上限で止めたら scope は「呼び出し」で、予約の全額を精算', async () => {
    const { invoke } = setup([{ role: R, nth: 1, reply: { fail: 'budget' } }])
    expect(await invoke(job())).toMatchObject({ ok: false, kind: 'budget', scope: '呼び出し', costYen: 100 })
    expect(notices).toEqual([{ caseId: 'c1', scope: '呼び出し', callId: 'k1', eventId: 'c1:cost.cap:k1' }])
  })

  it('案件の無い呼び出しは通知しない', async () => {
    // 案件の無い呼び出しは案件上限と比べない（6.2.1 (8)）。全体上限で断られても通知しない
    caps = { caseCapYen: 0, monthCapYen: 0 }
    const { invoke } = setup([])
    expect(await invoke(job({ role: '事実係・分類', caseId: '推測' }))).toMatchObject({ kind: 'budget', scope: '全体' })
    expect(notices).toEqual([])
  })

  it('通知が失敗したら例外で終わる', async () => {
    caps = { caseCapYen: 0, monthCapYen: null }
    const { invoke } = setup([], {
      onCostCap: () => {
        throw new Error('transition failed')
      },
    })
    await expect(invoke(job())).rejects.toThrow(/transition failed/)
  })
})

describe('認証切れ・混雑・止めたあとの決着（6.1.2 (2)(3)）', () => {
  const RL = { fail: 'unavailable', why: 'rate_limited' } as const

  it('混雑は待ってから 1 回だけ、別の callId で予約・精算して呼び直す', async () => {
    const { invoke } = setup(
      [
        { role: R, nth: 1, reply: RL },
        { role: R, nth: 2, reply: { text: 'ok', costYen: 7 } },
      ],
      { retryWaitMs: 1 },
    )
    expect(await invoke(job())).toMatchObject({ ok: true, costYen: 107 })
    expect(costs()).toEqual([
      ['hold', 'k1', 100],
      ['charge', 'k1', 100],
      ['hold', 'k2', 100],
      ['charge', 'k2', 7],
    ])
  })

  it('再試行も混雑なら why 付きの unavailable。言い直しの 1 回とは別に数える', async () => {
    const { invoke, fake } = setup(
      [
        { role: R, nth: 1, reply: RL },
        { role: R, nth: 2, reply: RL },
      ],
      { retryWaitMs: 1 },
    )
    expect(await invoke(job())).toMatchObject({ ok: false, kind: 'unavailable', why: 'rate_limited' })
    expect(fake.calls).toHaveLength(2)

    const second = setup(
      [
        { role: R, nth: 1, reply: RL },
        { role: R, nth: 2, reply: { text: '{', costYen: 0 } },
        { role: R, nth: 3, reply: { text: '{"title":"t"}', costYen: 0 } },
      ],
      { retryWaitMs: 1 },
    )
    expect(await second.invoke(job({ output: { kind: 'json', schema: Out } }))).toMatchObject({ ok: true })
  })

  it('混雑の待ちのあいだに止めたら、予約せずに stopped', async () => {
    const ac = new AbortController()
    const { invoke, fake } = setup([{ role: R, nth: 1, reply: RL }], { retryWaitMs: 60_000 })
    const pending = invoke(job({ signal: ac.signal }))
    await new Promise((r) => setTimeout(r, 10))
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, kind: 'stopped', costYen: 100 })
    expect(fake.calls).toHaveLength(1)
    expect(costs()).toHaveLength(2)
  })

  it('混雑の結果と同時に止められていたら、待たずに stopped', async () => {
    const ac = new AbortController()
    const { invoke } = setup([], {
      backends: {
        claude: async () => {
          ac.abort()
          return { ...RL, costYen: 0 }
        },
      },
      retryWaitMs: 60_000,
    })
    const started = Date.now()
    expect(await invoke(job({ signal: ac.signal }))).toMatchObject({ kind: 'stopped' })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('認証切れは再試行せず、why をそのまま返す', async () => {
    const { invoke, fake } = setup([{ role: R, nth: 1, reply: { fail: 'unavailable', why: 'auth_expired' } }])
    expect(await invoke(job())).toMatchObject({
      ok: false,
      kind: 'unavailable',
      why: 'auth_expired',
      detail: DETAIL.unavailable,
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('止めたら中身の決着を待つ。signal を無視する中身は settleMs で見切る', async () => {
    let settled = false
    const slow = setup([], {
      backends: {
        claude: (c) =>
          new Promise((_, reject) =>
            c.signal.addEventListener('abort', () =>
              setTimeout(() => {
                settled = true
                reject(c.signal.reason)
              }, 30),
            ),
          ),
      },
    })
    const ac = new AbortController()
    const p = slow.invoke(job({ signal: ac.signal }))
    ac.abort()
    expect(await p).toMatchObject({ kind: 'stopped' })
    expect(settled).toBe(true)

    const deaf = setup([], { backends: { claude: () => new Promise(() => {}) }, settleMs: 20 })
    expect(await deaf.invoke(job({ limits: { maxYen: 100, timeoutMs: 10 } }))).toMatchObject({ kind: 'timeout' })
    expect(logs.join('\n')).toMatch(/did not settle/)
  })
})

describe('CLI の語の遮断（6.1.1 (6)）', () => {
  it('失敗の detail は固定の文言で、中身の生の文を含まない', async () => {
    const { invoke } = setup([], {
      backends: {
        claude: async () => {
          throw new Error('claude: prompt too long (model opus)')
        },
      },
    })
    const out = await invoke(job())
    expect(out).toMatchObject({ ok: false, kind: 'unavailable', detail: DETAIL.unavailable })
    expect(logs.join('\n')).toMatch(/prompt too long/)
    for (const d of Object.values(DETAIL)) expect(d).not.toMatch(CLI_MARKERS)
  })
})

describe('JSON の読み取りの形の違い（6.2.2 (3)）', () => {
  it('全体を ``` で囲んだ JSON は言い直しを使わずに読む。受け皿の表で呼ぶ', async () => {
    const { invoke, fake } = setup([
      { role: '下書き役・確認項目', nth: 1, reply: { text: '```json\n{"title":"x"}\n```' } },
    ])
    const out = await invoke(job({ role: '下書き役・確認項目', fallback: true, output: { kind: 'json', schema: Out } }))
    expect(out).toMatchObject({ ok: true, json: { title: 'x' }, family: 'claude' })
    expect(fake.calls).toHaveLength(1)
  })
})
