// 受け入れ (5) と帯の見直しの測定（docs/implementation.md 7.6 (11)）。案件フォルダを読むだけ
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bandReport, bandUnits, codexRow, codexVerdict } from '../scripts/measure.ts'
import { goodChecks } from './fixtures/entrance.ts'

const home = () => mkdtempSync(join(tmpdir(), 'libretto-measure-'))
function put(h: string, caseId: string, family: '別系統' | '同系統', verdicts?: string[]) {
  const dir = join(h, 'cases', caseId)
  mkdirSync(join(dir, 'checks'), { recursive: true })
  writeFileSync(join(dir, 'checks', 'checks.json'), JSON.stringify({ checks: goodChecks, family }))
  if (verdicts)
    writeFileSync(
      join(dir, 'review-01-a.json'),
      JSON.stringify({
        version: 1,
        series: 1,
        round: 1,
        at: 'x',
        phase: '本文',
        attempt: 1,
        results: verdicts.map((verdict, i) => ({
          id: `C0${i + 1}`,
          verdict,
          by: 'jev',
          ...(verdict !== 'skipped' && {
            units: [
              { index: 0, yes: true, noul: 0.7 },
              { index: 1, yes: false, noul: 0.5, claude: true },
              { index: 2, yes: null, noul: 0.4, claude: true },
            ],
          }),
        })),
        pass: verdicts.every((v) => v === 'pass'),
        failedSummaries: [],
        marks: [],
        sources: [],
        jevBand: [0.35, 0.65],
      }),
    )
  return dir
}

describe('measure', () => {
  it('codex: 系統・書いていない項目・第 1 版の内訳。確かめていない項目があれば比べない', () => {
    const h = home()
    const a = codexRow(put(h, 'a', '別系統', ['pass', 'fail']))
    const b = codexRow(put(h, 'b', '同系統', ['pass', 'pass']))
    expect(a).toMatchObject({ family: '別系統', checks: 6, firstDraft: { pass: 1, fail: 1, unable: 0, skipped: 0 } })
    expect(a.notWritten).toBe(goodChecks.filter((c) => c.selfReport === '書いていない').length)
    expect(codexVerdict(a, b)).toBeUndefined()
    expect(codexVerdict(b, a)).toContain('系統が違います')
    const c = codexRow(put(h, 'c', '同系統', ['fail', 'skipped']))
    expect(codexVerdict(a, c)).toContain('まだ確かめていない')
    expect(codexVerdict(a, codexRow(put(h, 'd', '同系統')))).toContain('まだありません')
    // 入口に戻って作り直した組があっても、第 1 版を判定した（最初に承認した）組で数える
    const dir = put(h, 'e', '別系統', ['pass', 'fail'])
    writeFileSync(
      join(dir, 'checks', 'checks.json'),
      JSON.stringify({ checks: goodChecks, family: '別系統', approvedFingerprint: 'f1' }),
    )
    writeFileSync(
      join(dir, 'checks', 'checks.v2.json'),
      JSON.stringify({ checks: goodChecks.slice(0, 2), family: '同系統' }),
    )
    expect(codexRow(dir)).toMatchObject({ family: '別系統', checks: 6 })
  })

  it('band: 分布と、Claude が決めた単位だけの一致と、縁の単位', () => {
    const h = home()
    put(h, 'a', '別系統', ['pass'])
    const r = bandReport(bandUnits(h))
    expect(r.total).toBe(3)
    expect(r.bins[14]).toBe(1) // 0.70
    expect(r.decided).toBe(1) // null は数えない
    expect(r.agree).toBe(1) // 0.5 は 0.5 の側が「いいえ」で、Claude も false
    expect(r.edges.map((u) => u.noul)).toEqual([0.7])
  })
})
