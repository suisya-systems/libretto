// 表・スライド・手元のファイルと見た目の判定（docs/implementation.md 6.8）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEST_TARGET, mixesTables } from '@libretto/shared/api'
import type { Check } from '@libretto/shared/checks'
import { describe, expect, it } from 'vitest'
import { withHostItems } from '../src/checks/host-items.ts'
import { roundTrip, runCode } from '../src/checks/judgeable.ts'
import { renderHtml } from '../src/checks/text.ts'
import { xml, zip } from '../src/deliver/docx.ts'
import { pptxOf, pptxText, slidesOf } from '../src/deliver/pptx.ts'
import { blankPgm, MAX_PAGES, preflight, renderer, ToolFailure } from '../src/deliver/render.ts'
import { compareTables, formulaKey, htmlTables, mdTables, xlsxOf, xlsxSheets } from '../src/deliver/xlsx.ts'
import type { Job, Outcome } from '../src/model/invoke.ts'
import { destChoices, destViolations } from '../src/roles/conversation.ts'
import { formatChecks, judge, NO_PAGES, TOO_MANY_PAGES } from '../src/roles/judge.ts'
import { makerInstruction, SLIDES_RULE, shapeOf, TABLES_RULE, TABLES_VALUES_RULE } from '../src/roles/maker.ts'
import { fakeOffice } from './fakes/office-bin.ts'

// 偽の soffice / pdftoppm は /bin/sh の小さな起動口で起こす（Windows では起こせないので、使うテストは飛ばす）
const win = process.platform === 'win32'

const TABLE_MD = `# 売上の表

## 地域別

| 地域 | 売上 |
| --- | --- |
| 東 | 120 |
| **西** | 80 |
| 合計 | =SUM(B2:B3) |
`
const TABLE_HTML =
  '<h1>売上の表</h1><h2>地域別</h2><table><tr><th>地域</th><th>売上</th></tr><tr><td>東</td><td>120</td></tr><tr><td><strong>西</strong></td><td>80</td></tr><tr><td>合計</td><td>=SUM(B2:B3)</td></tr></table>'
const SLIDE_MD = `# 四半期の報告

2026 年 第 3 四半期

## 売上

売上は**前年より**増えました。出典は[白書](https://example.com/a)です。

- 東: 120
- 西: 80

## 次の手

1. 採用
2. 広告
`

describe('表（6.8 (1)(2)）', () => {
  it('HTML の table と Markdown の表が同じ表になり、xlsx に書いて読み戻すと同じセル', () => {
    const fromHtml = htmlTables(TABLE_HTML)
    expect(fromHtml).toEqual([
      {
        name: '地域別',
        head: true,
        rows: [
          ['地域', '売上'],
          ['東', '120'],
          ['西', '80'],
          ['合計', '=SUM(B2:B3)'],
        ],
      },
    ])
    expect(compareTables(mdTables(TABLE_MD), fromHtml)).toEqual({ cells: 0, tables: 0 })
    const x = xlsxOf(fromHtml)
    expect(xlsxOf(fromHtml).equals(x)).toBe(true) // 同じ入力から同じバイト列
    const back = xlsxSheets(x)
    expect(back).toMatchObject({ formulas: 1, errors: 0 })
    expect(back.tables[0]?.name).toBe('地域別')
    expect(compareTables(fromHtml, back.tables)).toEqual({ cells: 0, tables: 0 })
  })

  it('食い違ったセルと表の数を数える。式は字の値と引用符の中を変えずに比べる', () => {
    const t = htmlTables(TABLE_HTML)
    const changed = [
      {
        ...t[0],
        rows: [
          ['地域', '売上'],
          ['東', '121'],
        ],
      } as (typeof t)[number],
    ]
    expect(compareTables(t, changed)).toEqual({ cells: 5, tables: 0 }) // 違う 1 つと、無い 2 行の 4 つ
    expect(compareTables(t, [])).toMatchObject({ tables: 1 })
    expect(formulaKey('=sum( b2 : b3 )')).toBe(formulaKey('=SUM(B2:B3)'))
    expect(formulaKey('="a b"')).not.toBe(formulaKey('="ab"'))
    expect(formulaKey("='My Sheet'!A1")).not.toBe(formulaKey("='MySheet'!A1"))
    expect(
      compareTables([{ name: '', head: false, rows: [['12']] }], [{ name: '', head: false, rows: [['12.0']] }]),
    ).toEqual({
      cells: 0,
      tables: 0,
    })
  })

  it('sharedStrings とエラーのセル（Google の書き出しの形）も読む', () => {
    const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const buf = zip([
      [
        'xl/workbook.xml',
        Buffer.from(
          xml(`<workbook xmlns="${M}"><sheets><sheet name="表" sheetId="1" r:id="rId3"/></sheets></workbook>`),
        ),
      ],
      [
        'xl/_rels/workbook.xml.rels',
        Buffer.from(xml('<Relationships><Relationship Id="rId3" Target="/xl/worksheets/sheet1.xml"/></Relationships>')),
      ],
      [
        'xl/sharedStrings.xml',
        Buffer.from(xml(`<sst xmlns="${M}"><si><t>東</t></si><si><r><t>合</t></r><r><t>計</t></r></si></sst>`)),
      ],
      [
        'xl/worksheets/sheet1.xml',
        Buffer.from(
          xml(
            `<worksheet xmlns="${M}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>120</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="e"><f>B1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>`,
          ),
        ),
      ],
    ])
    expect(xlsxSheets(buf)).toEqual({
      tables: [{ name: '表', head: false, rows: [['東', '120'], [], ['合計', '=B1/0']] }],
      formulas: 1,
      errors: 1,
    })
  })
})

describe('スライド（6.8 (1)(2)）', () => {
  it('h1 が表紙、h2 ごとに 1 枚。読み戻すと本文の段落とリンクに一致する（slidesRoundTrip）', () => {
    const html = renderHtml(SLIDE_MD)
    expect(slidesOf(html).map((s) => [s.cover, s.body.length])).toEqual([
      [true, 1],
      [false, 3],
      [false, 2],
    ])
    const p = pptxOf(html)
    expect(pptxOf(html).equals(p)).toBe(true)
    expect(pptxText(p).links).toEqual(['https://example.com/a'])
    expect(roundTrip(SLIDE_MD, pptxText(p)).units).toEqual([true])
    // 1 枚落ちたら食い違う
    const short = pptxOf(html.replace(/<h2>次の手<\/h2>[\s\S]*$/, ''))
    expect(roundTrip(SLIDE_MD, pptxText(short))).toMatchObject({ units: [false], measured: { missing: 3 } })
  })
})

describe('描き出し（6.8 (3)(5)）', () => {
  it('PGM の白いページを空白と読む', () => {
    const pgm = (fill: number, ink = 0) => {
      const px = Buffer.alloc(100 * 100, fill)
      px.fill(0, 0, ink)
      return Buffer.concat([Buffer.from('P5\n# c\n100 100\n255\n'), px])
    }
    expect(blankPgm(pgm(255))).toBe(true)
    expect(blankPgm(pgm(255, 5))).toBe(true) // 0.1% 未満のごみ
    expect(blankPgm(pgm(255, 50))).toBe(false)
    expect(() => blankPgm(Buffer.from('nope'))).toThrow(ToolFailure)
  })

  it.skipIf(win)('事前点検: 起こせる道具だけを返す', async () => {
    const t = fakeOffice()
    expect(await preflight(t)).toEqual(t)
    expect(await preflight({ soffice: '/nonexistent/soffice', pdftoppm: t.pdftoppm })).toEqual({ pdftoppm: t.pdftoppm })
  })

  it.skipIf(win)(
    'pptx をページの画像にして空白を見分け、同じ中身は 1 回だけ描き出す。道具が無ければ ToolFailure',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'libretto-render-'))
      const r = renderer(fakeOffice(), root, new AbortController().signal)
      const p = pptxOf(renderHtml(SLIDE_MD))
      const pages = await r.pages(p, 'pptx')
      expect(pages.map((x) => x.blank)).toEqual([false, false, false])
      expect(pages[0]?.png.startsWith(root)).toBe(true)
      expect(r.pages(p, 'pptx')).toBe(r.pages(p, 'pptx'))
      await expect(renderer({}, root, new AbortController().signal).pages(p, 'pptx')).rejects.toBeInstanceOf(
        ToolFailure,
      )
    },
  )
})

const check = (id: string, judge: Check['judge']): Check => ({
  id,
  category: '形式',
  title: 't',
  judge,
  pass: { kind: 'all' },
  phase: '形式',
  summary: 's',
  hidden: false,
  selfReport: '依頼に書いてある',
})

describe('形式の機械判定（6.8 (3)）', () => {
  const signal = new AbortController().signal
  it.skipIf(win)('xlsxNoFormulaErrors: 式が無ければ道具なしで合格、あれば計算し直してエラーを数える', async () => {
    const c = check('C01', { by: 'code', fn: 'xlsxNoFormulaErrors', args: {} })
    const values = xlsxOf([{ name: 'a', head: true, rows: [['a'], ['1']] }])
    expect(await runCode(c, { md: '', files: { xlsx: values } })).toMatchObject({ units: [true] })
    const render = renderer(fakeOffice(), mkdtempSync(join(tmpdir(), 'libretto-render-')), signal)
    const bad = xlsxOf([{ name: 'a', head: false, rows: [['=1/0', '=1+1']] }])
    expect(await runCode(c, { md: '', files: { xlsx: bad }, render })).toMatchObject({
      units: [false],
      measured: { formulas: 2, errors: 1 },
    })
    const good = xlsxOf([{ name: 'a', head: false, rows: [['=1+1']] }])
    expect(await runCode(c, { md: '', files: { xlsx: good }, render })).toMatchObject({ units: [true] })
    await expect(
      runCode(c, { md: '', files: { xlsx: bad }, render: renderer({}, tmpdir(), signal) }),
    ).rejects.toBeInstanceOf(ToolFailure)
  })

  it('sheetsRoundTrip: 本文の表と同じなら合格、表が無い本文・食い違い・書き出しのエラーは落ちる', async () => {
    const c = check('C01', { by: 'code', fn: 'sheetsRoundTrip', args: {} })
    const sheets = xlsxSheets(xlsxOf(htmlTables(TABLE_HTML)))
    expect(await runCode(c, { md: TABLE_MD, sheets })).toMatchObject({ units: [true] })
    expect(
      await runCode(c, { md: '# 表なし\n\n本文。', sheets: { tables: [], formulas: 0, errors: 0 } }),
    ).toMatchObject({
      units: [false],
      measured: { tables: 1 },
    })
    expect(await runCode(c, { md: TABLE_MD.replace('120', '121'), sheets })).toMatchObject({
      units: [false],
      measured: { cells: 1 },
    })
    expect(await runCode(c, { md: TABLE_MD, sheets: { ...sheets, errors: 2 } })).toMatchObject({ units: [false] })
  })

  it.skipIf(win)('pptxNoBlankPages: 空白のページがあれば落ちる', async () => {
    const c = check('C01', { by: 'code', fn: 'pptxNoBlankPages', args: {} })
    const render = renderer(fakeOffice(), mkdtempSync(join(tmpdir(), 'libretto-render-')), signal)
    const pptx = pptxOf(renderHtml(SLIDE_MD))
    expect(await runCode(c, { md: '', files: { pptx }, render })).toMatchObject({ units: [true, true, true] })
    const blank = {
      ...render,
      pages: async () => [
        { png: 'a', blank: false },
        { png: 'b', blank: true },
      ],
    }
    expect(await runCode(c, { md: '', files: { pptx }, render: blank })).toMatchObject({ units: [true, false] })
  })
})

describe('見た目の判定（6.8 (3)）', () => {
  const looks = withHostItems([], [{ kind: 'file', format: 'pptx' }], 'x'.repeat(32)).find(
    (c) => c.judge.by === 'claude',
  ) as Check
  const brief = {
    docType: '資料',
    subject: 's',
    wanted: [],
    gather: [],
    audience: '社内',
    destinations: [{ kind: 'file', format: 'pptx' }],
    shape: '3 枚',
    materials: [],
    voice: '合わせない',
    sources: '出典なし',
    mustNot: [],
    assumptions: [],
    decisions: [],
  } as unknown as Parameters<typeof judge>[0]['brief']
  const signal = new AbortController().signal
  const base = (pptx: Buffer, root: string) => ({
    caseId: 'c',
    phase: '形式' as const,
    checks: [looks],
    input: { md: SLIDE_MD, files: { pptx }, render: renderer(fakeOffice(), root, signal) },
    brief,
    family: '別系統' as const,
    signal,
  })

  it.skipIf(win)('ページごとの画像を「判定役・画像」にファイルで渡し、ページを単位に集計する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'libretto-render-'))
    const jobs: Job[] = []
    const invoke = async (job: Job): Promise<Outcome> => {
      jobs.push(job)
      const reply = {
        results: [
          {
            id: looks.id,
            units: [0, 1, 2].map((index) => ({ index, yes: index !== 1 })),
            reason: '2 枚目の箇条書きが枠からはみ出しています。',
          },
        ],
      }
      if (job.output.kind === 'json') expect(job.output.accept?.(reply)).toEqual([])
      return { ok: true, text: '', json: reply, costYen: 1, family: 'claude', model: 'm' }
    }
    const r = await judge(base(pptxOf(renderHtml(SLIDE_MD)), root), invoke)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ role: '判定役・画像', access: 'read', workdir: root })
    expect(jobs[0]?.materials.filter((m) => 'file' in m)).toHaveLength(3)
    expect(r.ok && r.judged.body.results[0]).toMatchObject({ verdict: 'fail', by: 'claude' })
    expect(r.ok && r.judged.reasons[looks.id]).toContain('はみ出し')
  })

  it.skipIf(win)(`ページが無い・${MAX_PAGES} ページを超えるときは聞かずに判定できない`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'libretto-render-'))
    const invoke = async (): Promise<Outcome> => {
      throw new Error('should not ask')
    }
    const many = pptxOf(`<h1>題</h1>${Array.from({ length: MAX_PAGES }, (_, i) => `<h2>${i}</h2>`).join('')}`)
    const r = await judge(base(many, root), invoke)
    expect(r.ok && r.judged.body.results[0]?.verdict).toBe('unable')
    expect(r.ok && r.judged.reasons[looks.id]).toBe(TOO_MANY_PAGES)
    const none = await judge({ ...base(many, root), input: { md: SLIDE_MD } }, invoke)
    expect(none.ok && none.judged.reasons[looks.id]).toBe(NO_PAGES)
  })
})

describe('保存先の選び方と形式の項目（6.8 (1)(3)）', () => {
  it('Google の連携と道具の有無で選べる種類が決まる', () => {
    expect(destChoices({ google: false, files: false })).toEqual(['page', 'paste'])
    expect(destChoices({ google: true, files: false })).toEqual(['page', 'paste', 'gdoc', 'gsheet'])
    expect(destChoices({ google: true, files: true })).toEqual([
      'page',
      'paste',
      'gdoc',
      'gsheet',
      'gslide',
      'pptx',
      'xlsx',
      'docx',
    ])
  })

  it('表とほかの保存先は混ぜない', () => {
    const all = destChoices({ google: true, files: true })
    expect(destViolations(['gsheet', 'xlsx'], all)).toEqual([])
    expect(destViolations(['gsheet', 'page'], all)).toHaveLength(1)
    expect(mixesTables([DEST_TARGET.pptx, DEST_TARGET.docx])).toBe(false)
    expect(mixesTables([DEST_TARGET.xlsx, DEST_TARGET.paste])).toBe(true)
  })

  it('同じ関数を使う保存先（gsheet と xlsx）を足しても形式の項目は 1 件。足りない項目だけ続きの id で足す', () => {
    const set = withHostItems([], [DEST_TARGET.gsheet], 'x'.repeat(32))
    expect(formatChecks(set, [DEST_TARGET.gsheet, DEST_TARGET.xlsx]).map((c) => c.id)).toEqual(['C02', 'C03'])
    const slides = formatChecks(set, [DEST_TARGET.pptx])
    expect(slides.map((c) => [c.id, c.judge.by === 'code' ? c.judge.fn : c.judge.by])).toEqual([
      ['C04', 'slidesRoundTrip'],
      ['C05', 'pptxNoBlankPages'],
      ['C06', 'claude'],
    ])
  })

  it('作り手への指示: スライドと表の形は保存先にあるときだけ。LibreOffice が無ければ式を使わない', () => {
    expect(shapeOf([DEST_TARGET.page], true)).toEqual({})
    expect(shapeOf([DEST_TARGET.gslide], true)).toEqual({ slides: true })
    expect(shapeOf([DEST_TARGET.gsheet], false)).toEqual({ tables: 'values' })
    const sheet = makerInstruction('/w', 1, false, false, false, { tables: 'formulas' })
    expect(sheet).toContain(TABLES_RULE)
    expect(sheet).toContain('表（table / tr / th / td）')
    expect(makerInstruction('/w', 1, false, false, false, { tables: 'values' })).toContain(TABLES_VALUES_RULE)
    expect(makerInstruction('/w', 1, false, false, false, { slides: true })).toContain(SLIDES_RULE)
    expect(makerInstruction('/w', 1, false)).not.toContain('table')
  })
})
