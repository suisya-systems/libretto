// 偽の LibreOffice（soffice）と poppler（pdftoppm）（docs/implementation.md 6.8 (3)）。
// soffice --convert-to pdf: 「PDF」はページごとの白黒を 1 行ずつ書いた字（pptx はスライドの数、字の無いスライドは blank）。
// soffice --convert-to xlsx: 式を「計算し直した」xlsx（/0 を含む式はエラー、ほかは 1）。
// pdftoppm: -gray は PGM（blank は真っ白、ほかは黒い帯）、-png は PNG の代わりの字
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { unzip, xml, zip } from '../../src/deliver/docx.ts'

const [tool, ...args] = process.argv.slice(2)
const after = (flag: string) => args[args.indexOf(flag) + 1] as string

if (tool === 'soffice') {
  if (args[0] === '--version') process.exit(0)
  const to = after('--convert-to')
  const out = after('--outdir')
  const file = args.at(-1) as string
  const buf = readFileSync(file)
  const name = basename(file).replace(/\.[^.]+$/, '')
  mkdirSync(out, { recursive: true })
  if (process.env.FAKE_OFFICE_FAIL) process.exit(1)
  if (to === 'pdf') {
    const pages = file.endsWith('.pptx') ? slidePages(buf) : ['ink']
    writeFileSync(join(out, `${name}.pdf`), pages.join('\n'))
  } else {
    const fs = [...(unzip(buf, 'xl/worksheets/sheet1.xml') ?? '').matchAll(/<f>([^<]*)<\/f>/g)].map(
      (m) => m[1] as string,
    )
    const cells = fs
      .map((f, i) =>
        f.includes('/0')
          ? `<c r="A${i + 1}" t="e"><f>${f}</f><v>#DIV/0!</v></c>`
          : `<c r="A${i + 1}"><f>${f}</f><v>1</v></c>`,
      )
      .join('')
    const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    writeFileSync(
      join(out, `${name}.xlsx`),
      zip([
        [
          'xl/workbook.xml',
          Buffer.from(
            xml(
              `<workbook xmlns="${M}" xmlns:r="${R}"><sheets><sheet name="s" sheetId="1" r:id="r1"/></sheets></workbook>`,
            ),
          ),
        ],
        [
          'xl/_rels/workbook.xml.rels',
          Buffer.from(xml(`<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`)),
        ],
        [
          'xl/worksheets/sheet1.xml',
          Buffer.from(xml(`<worksheet xmlns="${M}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`)),
        ],
      ]),
    )
  }
} else if (tool === 'pdftoppm') {
  if (args[0] === '-v') process.exit(0)
  const [pdf, prefix] = args.slice(-2) as [string, string]
  const pages = readFileSync(pdf, 'utf-8').split('\n')
  pages.forEach((p, i) => {
    if (args.includes('-gray')) {
      const w = 40
      const h = 30
      const px = Buffer.alloc(w * h, 255)
      if (p !== 'blank') px.fill(0, 0, w * 3) // 字の代わりの黒い帯（全体の 1 割）
      writeFileSync(`${prefix}-${i + 1}.pgm`, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), px]))
    } else writeFileSync(`${prefix}-${i + 1}.png`, `page ${i + 1}: ${p}`)
  })
}

// スライドごとに字があれば ink、無ければ blank
function slidePages(buf: Buffer): string[] {
  const n = (unzip(buf, 'ppt/presentation.xml') ?? '').match(/<p:sldId\b/g)?.length ?? 0
  return Array.from({ length: n }, (_, i) =>
    (unzip(buf, `ppt/slides/slide${i + 1}.xml`) ?? '').includes('<a:t>') ? 'ink' : 'blank',
  )
}
