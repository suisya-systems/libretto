// 本物の LibreOffice と poppler での確かめ（docs/implementation.md 6.8 (3)(5)）。モデルを呼ばず、網に出ない
//   npm run verify:files -- [出力のフォルダ]
// 見本の pptx / docx / xlsx を作り、pptx と docx をページの画像にして空白を数え、xlsx の式を計算し直してエラーを数える。
// 画像と計算し直した xlsx は出力のフォルダ（既定は一時フォルダ）に残すので、目でも確かめられる
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHtml } from '../src/checks/text.ts'
import { docxOf } from '../src/deliver/docx.ts'
import { pptxOf } from '../src/deliver/pptx.ts'
import { preflight, renderer } from '../src/deliver/render.ts'
import { htmlTables, xlsxOf, xlsxSheets } from '../src/deliver/xlsx.ts'

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  console.log('usage: npm run verify:files -- [out-dir]')
  console.log('  renders sample pptx/docx with soffice and pdftoppm, and recalculates a sample xlsx')
  process.exit(0)
}
const out = arg ?? mkdtempSync(join(tmpdir(), 'libretto-files-'))
const tools = await preflight({
  soffice: process.env.LIBRETTO_SOFFICE ?? 'soffice',
  pdftoppm: process.env.LIBRETTO_PDFTOPPM ?? 'pdftoppm',
})
console.log(`soffice: ${tools.soffice ?? 'missing'}`)
console.log(`pdftoppm: ${tools.pdftoppm ?? 'missing'}`)
if (!tools.soffice || !tools.pdftoppm) process.exit(1)

const md = `# 四半期の報告\n\n2026 年 第 3 四半期\n\n## 売上\n\n売上は**前年より**増えました。出典は[白書](https://example.com/a)です。\n\n- 東: 120\n- 西: 80\n\n## 次の手\n\n1. 採用\n2. 広告\n`
const html = renderHtml(md)
const table =
  '<h2>地域別</h2><table><tr><th>地域</th><th>売上</th></tr><tr><td>東</td><td>120</td></tr><tr><td>西</td><td>80</td></tr><tr><td>合計</td><td>=SUM(B2:B3)</td></tr><tr><td>割合</td><td>=B2/0</td></tr></table>'
const files = { pptx: pptxOf(html), docx: docxOf(html), xlsx: xlsxOf(htmlTables(table)) }
for (const [ext, buf] of Object.entries(files)) writeFileSync(join(out, `sample.${ext}`), buf)

const r = renderer(tools, out, new AbortController().signal)
for (const ext of ['pptx', 'docx'] as const) {
  const pages = await r.pages(files[ext], ext)
  console.log(`${ext}: ${pages.length} pages, blank ${pages.filter((p) => p.blank).length} (want 3 / 0 for pptx)`)
  for (const p of pages) console.log(`  ${p.png}`)
}
const re = xlsxSheets(await r.recalc(files.xlsx))
console.log(`xlsx: formulas ${re.formulas}, errors ${re.errors} (want 2 / 1)`)
console.log(`out: ${out}`)
