// 途中で落ちた呼び出しの精算（docs/implementation.md 9.4 (7)）
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/ledger/db.ts'
import { type Hold, Ledger, type NewCase } from '../src/ledger/ledger.ts'
import { createClaudeCli, resultYen } from '../src/model/claude-cli.ts'
import { callFile, createInvoke } from '../src/model/invoke.ts'
import { settleOrphans } from '../src/model/orphans.ts'
import { COST_UNKNOWN, toCard } from '../src/server/views.ts'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))

const newCase = (caseId: string): NewCase => ({
  eventId: `${caseId}:created`,
  caseId,
  title: '記事',
  state: '入口待ち',
  turn: 'libretto',
  step: '依頼書と確認項目を書いています',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  docType: '記事',
  destination: [{ kind: 'paste' }],
})
const hold = (callId: string, caseId: string, holdYen: number): Hold & { caseCapYen: null; monthCapYen: null } => ({
  callId,
  caseId,
  role: '作り手',
  family: 'claude',
  model: 'm',
  holdYen,
  caseCapYen: null,
  monthCapYen: null,
})
// 結果のファイル: 1 行目に為替、2 行目から CLI の標準出力
const result = (rate: number, usd: unknown) =>
  `${JSON.stringify({ usdJpy: rate })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '本文', total_cost_usd: usd })}`

let now: Date
let db: ReturnType<typeof openDb>
let ledger: Ledger
let dir: string
beforeEach(() => {
  now = new Date('2026-10-23T03:00:00Z')
  db = openDb(':memory:')
  ledger = new Ledger(db, () => now)
  dir = mkdtempSync(join(tmpdir(), 'libretto-calls-'))
  ledger.insertCase(newCase('c1'))
})

describe('拾う範囲', () => {
  it('charge の無い hold を全部。止めた案件・推測・点検・前の月も含み、精算済みは含まない', () => {
    ledger.insertCase(newCase('c2'))
    now = new Date('2026-09-10T03:00:00Z')
    ledger.reserveCost(hold('old', 'c1', 10))
    now = new Date('2026-10-23T03:00:00Z')
    ledger.reserveCost(hold('k1', 'c2', 20))
    ledger.appendTransition({
      eventId: 'e1',
      caseId: 'c2',
      from: '入口待ち',
      to: '停止',
      event: 'stop.case',
      by: '本人',
      turn: '本人',
      step: '止めました',
    })
    ledger.reserveCost(hold('k2', '推測', 30))
    ledger.reserveCost(hold('k3', '点検', 40))
    ledger.reserveCost(hold('done', 'c1', 50))
    ledger.recordCharge({ callId: 'done', yen: 1 })
    expect(ledger.listUnsettledHolds()).toEqual([
      { callId: 'old', caseId: 'c1', holdYen: 10 },
      { callId: 'k1', caseId: 'c2', holdYen: 20 },
      { callId: 'k2', caseId: '推測', holdYen: 30 },
      { callId: 'k3', caseId: '点検', holdYen: 40 },
    ])
  })
})

describe('精算と記録のトランザクション', () => {
  it('charge と記録を 1 回で書き、二度目は拒んで何も足さない', () => {
    ledger.reserveCost(hold('k1', 'c1', 100))
    ledger.settleOrphan({ callId: 'k1', yen: 100, source: '予約' })
    expect(ledger.caseCostYen('c1')).toBe(100)
    expect(ledger.costUnknown('c1')).toBe(true)
    expect(() => ledger.settleOrphan({ callId: 'k1', yen: 100, source: '予約' })).toThrow(/UNIQUE/)
    expect(ledger.listCosts('c1').filter((c) => c.type === 'charge')).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM cost_recoveries').get()).toEqual({ n: 1 })
  })

  it('記録が書けなければ charge も巻き戻り、未精算のまま残る', () => {
    ledger.reserveCost(hold('k1', 'c1', 100))
    db.prepare(`INSERT INTO cost_recoveries (call_id, case_id, source, at) VALUES ('k1', 'c1', '結果', ?)`).run(
      '2026-10-23T12:00:00.000+09:00',
    )
    expect(() => ledger.settleOrphan({ callId: 'k1', yen: 5, source: '結果' })).toThrow(/UNIQUE/)
    expect(ledger.listUnsettledHolds().map((h) => h.callId)).toEqual(['k1'])
  })

  it('記録は追記専用', () => {
    ledger.reserveCost(hold('k1', 'c1', 100))
    ledger.settleOrphan({ callId: 'k1', yen: 100, source: '予約' })
    expect(() => db.prepare(`UPDATE cost_recoveries SET source = '結果'`).run()).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM cost_recoveries').run()).toThrow(/append-only/)
  })
})

describe('settleOrphans', () => {
  it('結果のファイルの額は 1 行目の為替で換算し、無い・書きかけ・壊れたものは予約の額', () => {
    for (const k of ['ok', 'zero', 'partial', 'header', 'rate', 'negative', 'missing'])
      ledger.reserveCost(hold(k, 'c1', 100))
    writeFileSync(callFile(dir, 'ok'), result(120, 0.5))
    writeFileSync(callFile(dir, 'zero'), result(120, 0))
    writeFileSync(callFile(dir, 'partial'), `${JSON.stringify({ usdJpy: 120 })}\n{"type":"result","subtype":"succ`)
    writeFileSync(callFile(dir, 'header'), '{"usdJpy":12')
    writeFileSync(callFile(dir, 'rate'), result(0, 0.5))
    writeFileSync(callFile(dir, 'negative'), result(120, -1))
    writeFileSync(join(dir, 'stray.json'), 'x')

    expect(settleOrphans(ledger, dir)).toEqual({ result: 2, hold: 5 })
    const charges = Object.fromEntries(
      ledger.listCosts('c1').flatMap((c) => (c.type === 'charge' ? [[c.callId, c.yen]] : [])),
    )
    expect(charges).toEqual({ ok: 60, zero: 0, partial: 100, header: 100, rate: 100, negative: 100, missing: 100 })
    expect(readdirSync(dir)).toEqual([])
    expect(
      db.prepare('SELECT call_id, source FROM cost_recoveries ORDER BY call_id').all() as { source: string }[],
    ).toEqual(
      expect.arrayContaining([
        { call_id: 'ok', source: '結果' },
        { call_id: 'zero', source: '結果' },
        { call_id: 'missing', source: '予約' },
      ]),
    )
    // 二度目は何もしない
    expect(settleOrphans(ledger, dir)).toEqual({ result: 0, hold: 0 })
    expect(ledger.caseCostYen('c1')).toBe(560)
  })

  it('精算が翌月でも、計上月は hold の月のまま', () => {
    now = new Date('2026-09-30T14:59:59.999Z') // JST 9 月 30 日 23:59:59.999
    ledger.reserveCost(hold('k1', '推測', 100))
    now = new Date('2026-10-23T03:00:00Z')
    writeFileSync(callFile(dir, 'k1'), result(100, 0.1))
    settleOrphans(ledger, dir)
    expect(ledger.monthCostYen(new Date('2026-09-15T00:00:00Z'))).toBe(10)
    expect(ledger.monthCostYen(now)).toBe(0)
  })
})

describe('費用の欄の 1 行', () => {
  it('予約の額で確定した呼び出しがある案件だけ costNote を出す', () => {
    ledger.insertCase(newCase('c2'))
    ledger.reserveCost(hold('k1', 'c1', 100))
    ledger.reserveCost(hold('k2', 'c2', 100))
    writeFileSync(callFile(dir, 'k2'), result(150, 0.01))
    settleOrphans(ledger, dir)
    expect(toCard(ledger, ledger.getCase('c1') as never).costNote).toBe(COST_UNKNOWN)
    expect(toCard(ledger, ledger.getCase('c2') as never)).not.toHaveProperty('costNote')
  })
})

describe('claude-cli の結果のファイル', () => {
  it('CLI の標準出力は 1 行目の為替の後ろに入り、invoke は精算のあとに消す', async () => {
    let seen: string | undefined
    const cli = createClaudeCli({
      usdJpy: () => 150,
      callsDir: dir,
      command: [process.execPath, FAKE],
      log: () => {},
    })
    const invoke = createInvoke({
      ledger,
      backends: {
        // 精算の前（中身が返った直後）のファイルを覗く
        claude: async (call) => {
          const r = await cli(call)
          seen = readFileSync(callFile(dir, call.callId), 'utf8')
          expect(resultYen(callFile(dir, call.callId))).toBeCloseTo(0.3)
          return r
        },
      },
      caps: () => ({ caseCapYen: null, monthCapYen: null }),
      onCostCap: () => {},
      log: () => {},
      newCallId: () => 'call-1',
      callsDir: dir,
    })
    const out = await invoke({
      role: '話し相手',
      caseId: 'c1',
      instruction: JSON.stringify({ mode: 'ok', cost: 0.002 }),
      materials: [],
      access: 'none',
      output: { kind: 'text' },
      limits: { maxYen: 100, timeoutMs: 30_000 },
      signal: new AbortController().signal,
    })
    expect(out).toMatchObject({ ok: true, text: 'ok' })
    expect(out.costYen).toBeCloseTo(0.3)
    const [first, rest] = (seen as string).split('\n')
    expect(JSON.parse(first as string)).toEqual({ usdJpy: 150 })
    expect(JSON.parse(rest as string)).toMatchObject({ type: 'result', total_cost_usd: 0.002 })
    expect(existsSync(callFile(dir, 'call-1'))).toBe(false)
    expect(ledger.listUnsettledHolds()).toEqual([])
  })
})
