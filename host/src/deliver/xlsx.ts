// 表（docs/implementation.md 6.8 (1)(2)(4)）。作り手の HTML の table 1 つが 1 シート。xlsx は依存を足さずに書く（docx.ts の zip）。
// セルの字が = で始まれば式、数だけなら数、ほかは字。同じ入力から同じバイト列
import { decode, escapeHtml, plain } from '../checks/text.ts'
import { unzip, xml, zip } from './docx.ts'

export type Table = { name: string; rows: string[][]; head: boolean } // head = 1 行目が見出しの行（th / Markdown の表の頭）

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const strip = (s: string) => decode(s.replace(/<[^>]*>/g, '')).trim()

// シート名は 31 字まで、[]:*?/\ は使えない。同じ名前は（2）を付ける
function names(raw: string[]): string[] {
  const seen = new Set<string>()
  return raw.map((r, i) => {
    const base = (r.replace(/[[\]:*?/\\]/g, '_').trim() || `表${i + 1}`).slice(0, 28)
    let n = base
    for (let k = 2; seen.has(n); k++) n = `${base}（${k}）`
    seen.add(n)
    return n
  })
}

export function htmlTables(html: string): Table[] {
  const found = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((m) => {
    const before = html.slice(0, m.index)
    const heading = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)].at(-1)?.[1]
    const trs = [...(m[1] as string).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((t) => t[1] as string)
    const rows = trs.map((tr) =>
      [...tr.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((c) => strip(c[1] as string)),
    )
    return { name: heading ? strip(heading) : '', rows, head: /<th\b/i.test(trs[0] ?? '') }
  })
  const ns = names(found.map((t) => t.name))
  return found.map((t, i) => ({ ...t, name: ns[i] as string }))
}

// Markdown の表（| で区切る）。2 行目の区切りの行（--- | ---）で表と分かる。
// ponytail: セルの中の \| は扱わない（作り手には使わないよう指示する）
const ROW = /^\s*\|.*\|\s*$/
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => plain(c.trim()).trim())
export function mdTables(md: string): Table[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const found: Table[] = []
  let heading = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) heading = plain((h[1] as string).trim())
    if (!ROW.test(line) || !SEP.test(lines[i + 1] ?? '')) continue
    const rows = [cells(line)]
    let j = i + 2
    for (; j < lines.length && ROW.test(lines[j] as string); j++) rows.push(cells(lines[j] as string))
    found.push({ name: heading, rows, head: true })
    i = j - 1
  }
  const ns = names(found.map((t) => t.name))
  return found.map((t, i) => ({ ...t, name: ns[i] as string }))
}

const col = (n: number): string => (n < 26 ? String.fromCharCode(65 + n) : col(Math.floor(n / 26) - 1) + col(n % 26))
const NUMBER = /^-?\d+(\.\d+)?$/

function cell(ref: string, text: string, bold: boolean): string {
  const s = bold ? ' s="1"' : ''
  if (text.startsWith('=') && text.length > 1) return `<c r="${ref}"${s}><f>${escapeHtml(text.slice(1))}</f></c>`
  if (NUMBER.test(text)) return `<c r="${ref}"${s}><v>${text}</v></c>`
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeHtml(text)}</t></is></c>`
}

const STYLES = xml(`<styleSheet xmlns="${MAIN}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`)

export function xlsxOf(tables: readonly Table[]): Buffer {
  const sheets = tables.map((t) =>
    xml(`<worksheet xmlns="${MAIN}"><sheetData>
${t.rows
  .map(
    (row, r) =>
      `<row r="${r + 1}">${row
        .map((text, c) => (text ? cell(`${col(c)}${r + 1}`, text, t.head && r === 0) : ''))
        .join('')}</row>`,
  )
  .join('\n')}
</sheetData></worksheet>`),
  )
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    ],
    [
      '_rels/.rels',
      xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    ],
    [
      'xl/workbook.xml',
      xml(`<workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets>
${tables.map((t, i) => `<sheet name="${escapeHtml(t.name)}" sheetId="${i + 1}" r:id="rIdW${i + 1}"/>`).join('\n')}
</sheets></workbook>`),
    ],
    [
      'xl/_rels/workbook.xml.rels',
      xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>
${sheets.map((_, i) => `<Relationship Id="rIdW${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`),
    ],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, s]),
  ]
  return zip(files.map(([name, body]) => [name, Buffer.from(body, 'utf-8')]))
}

// --- 読み戻し（仕立てた xlsx・LibreOffice で計算し直した xlsx・Google の書き出しの xlsx を同じ関数で読む）

export type Sheets = { tables: Table[]; formulas: number; errors: number }
const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1]
const texts = (s: string) => [...s.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => decode(m[1] as string)).join('')
const ERROR_VALUE = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|ERROR!?|SPILL!|CALC!)/

export function xlsxSheets(buf: Buffer): Sheets {
  const book = unzip(buf, 'xl/workbook.xml') ?? ''
  const rels = new Map(
    [...(unzip(buf, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], 'Id'),
      attr(m[0], 'Target') ?? '',
    ]),
  )
  const shared = [...(unzip(buf, 'xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    texts(m[1] as string),
  )
  let formulas = 0
  let errors = 0
  const tables = [...book.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(attr(m[0], 'r:id')) ?? ''
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
    const sheet = unzip(buf, path) ?? ''
    const rows: string[][] = []
    for (const c of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = /^([A-Z]+)(\d+)$/.exec(attr(c[1] as string, 'r') ?? '')
      if (!at) continue
      const r = Number(at[2]) - 1
      const k = [...(at[1] as string)].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
      const body = c[2] ?? ''
      const t = attr(c[1] as string, 't')
      const f = /<f\b[^>]*>([^<]*)<\/f>/.exec(body)?.[1]
      const v = decode(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? '')
      if (f !== undefined || /<f\b/.test(body)) formulas++
      if (t === 'e' || (f !== undefined && ERROR_VALUE.test(v))) errors++
      const value = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? texts(body) : v
      const text = f !== undefined ? `=${decode(f)}` : value
      if (!text) continue
      const row = rows[r] ?? []
      row[k] = text
      rows[r] = row
    }
    const dense = Array.from(rows, (row) => Array.from(row ?? [], (x) => x ?? ''))
    return { name: decode(attr(m[0], 'name') ?? ''), rows: dense, head: false }
  })
  return { tables, formulas, errors }
}

// 式は字の値と引用符の中を変えずに、外の空白を外して大文字にする（"a b" と "ab" は違う式のまま）
export function formulaKey(f: string): string {
  let out = ''
  let quote: string | undefined
  for (const ch of f) {
    if (quote) {
      out += ch
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
    } else if (!/\s/.test(ch)) out += ch.toUpperCase()
  }
  return out
}
const cellKey = (s: string) => {
  const t = s.trim()
  if (t.startsWith('=')) return formulaKey(t)
  if (NUMBER.test(t)) return String(Number(t))
  return t.replace(/\s+/g, ' ')
}

// 表ごと・セルごとに比べる（行の終わりの空のセルは数えない）。食い違ったセルの数と、表の数の差
export function compareTables(want: readonly Table[], got: readonly Table[]): { cells: number; tables: number } {
  let cells = 0
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const a = want[i]?.rows ?? []
    const b = got[i]?.rows ?? []
    for (let r = 0; r < Math.max(a.length, b.length); r++) {
      const x = a[r] ?? []
      const y = b[r] ?? []
      for (let k = 0; k < Math.max(x.length, y.length); k++) if (cellKey(x[k] ?? '') !== cellKey(y[k] ?? '')) cells++
    }
  }
  return { cells, tables: Math.abs(want.length - got.length) }
}
