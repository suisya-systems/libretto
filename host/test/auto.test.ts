// おまかせの止める理由と入口の既定（docs/implementation.md 6.11 (1)(4)）
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CaseRecord } from '@libretto/shared/ledger'
import { describe, expect, it } from 'vitest'
import { holdOf, quotesOthers } from '../src/case/auto.ts'
import { caseDir } from '../src/ledger/db.ts'
import { autoSince, ENTRANCE_DEFAULTS, entranceDefaults, saveEntranceDefaults } from '../src/settings.ts'

const home = () => mkdtempSync(join(tmpdir(), 'libretto-auto-'))
const rec = (over: Partial<CaseRecord> = {}) =>
  ({
    caseId: 'c1',
    version: 1,
    mode: 'おまかせ',
    origin: { kind: '会話' },
    destination: [{ kind: 'page', shared: false }],
    ...over,
  }) as CaseRecord
function withDraft(h: string, md: string, materials: Record<string, string> = {}) {
  const dir = join(caseDir(h, 'c1'), 'versions', '01')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'draft-01.md'), md)
  const m = join(caseDir(h, 'c1'), 'materials')
  mkdirSync(m, { recursive: true })
  for (const [f, t] of Object.entries(materials)) writeFileSync(join(m, f), t)
}

describe('ほかの人の言葉の引用（6.11 (4)）', () => {
  it('会話の案件は、かぎ括弧の中が資料に 4 字以上そのままあるときだけ', () => {
    const h = home()
    withDraft(h, '# 題\n\n「おまかせ」で頼むと「来週までに出します」と返ってきた。\n', {
      'pasted-01.md': '部長の返事: 来週までに出します',
    })
    expect(quotesOthers(h, rec())).toBe(true)
    // 3 字までは偶然の一致とみなす。資料に無い文も引用ではない
    withDraft(h, '# 題\n\n「全部」で頼み、「ここだけの話」と書いた。\n', { 'pasted-01.md': '全部で頼んだ記録' })
    expect(quotesOthers(h, rec())).toBe(false)
  })
  it('引用のブロック（行頭の >）は引用', () => {
    const h = home()
    withDraft(h, '# 題\n\n> だれかの言葉\n')
    expect(quotesOthers(h, rec())).toBe(true)
  })
  it('取り込み元の案件は、かぎ括弧が 1 つでもあれば引用とみなす', () => {
    const h = home()
    withDraft(h, '# 題\n\n「中止」と言った。\n')
    expect(quotesOthers(h, rec({ origin: { kind: '合図', source: 'gmail' } }))).toBe(true)
    expect(quotesOthers(h, rec())).toBe(false)
  })
  it('止める理由: ほかの人に見えるかもしれない保存先が先。確認しながらは止めない', () => {
    const h = home()
    withDraft(h, '# 題\n\n本文。\n')
    expect(holdOf(h, rec({ destination: [{ kind: 'gdoc', folderId: 'abc' }] }))).toBe('見える')
    expect(holdOf(h, rec({ destination: [{ kind: 'gdoc', folderId: 'libretto' }] }))).toBeUndefined()
    expect(holdOf(h, rec({ mode: '確認しながら', destination: [{ kind: 'page', shared: true }] }))).toBeUndefined()
  })
})

describe('入口の既定（6.11 (1)）', () => {
  it('既定は全部「確認しながら」。おまかせにした時刻を覚え、変えなければ保ち、戻せば消す', () => {
    const h = home()
    expect(entranceDefaults(h)).toEqual(ENTRANCE_DEFAULTS)
    saveEntranceDefaults(h, { ...ENTRANCE_DEFAULTS, gmail: 'おまかせ' }, 't1')
    saveEntranceDefaults(h, { ...ENTRANCE_DEFAULTS, gmail: 'おまかせ', slack: 'おまかせ' }, 't2')
    expect(autoSince(h)).toEqual({ gmail: 't1', slack: 't2' })
    saveEntranceDefaults(h, { ...ENTRANCE_DEFAULTS, slack: 'おまかせ' }, 't3')
    expect(autoSince(h)).toEqual({ slack: 't2' })
    expect(entranceDefaults(h).slack).toBe('おまかせ')
  })
})
