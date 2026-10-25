// Google ドキュメントへ変換付きで上げる docx（docs/implementation.md 6.5 (4)）。依存を足さずに書く。
// 中身は版のあるページと同じブロック（作り手の HTML から pageBlocks で取り出したもの）。zip は無圧縮で日時は固定（同じ入力から同じバイト列）
import { crc32, inflateRawSync } from 'node:zlib'
import { decode, escapeHtml } from '../checks/text.ts'
import { pageBlocks, safeHref } from './page.ts'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const HYPERLINK = `${R}/hyperlink`
export const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`

// ブロックの中（エスケープ済みの字・strong・em・a・br）を、字・改行・リンクの開け閉めの列に（docx と pptx で共有。6.8 (2)）
export type Inline =
  | { text: string; b: boolean; i: boolean; link: boolean }
  | { br: true }
  | { open: string } // リンクの行き先（http / https だけ）
  | { close: true }
export function inlines(html: string): Inline[] {
  const out: Inline[] = []
  const on = { b: 0, i: 0 }
  let link = false
  let at = 0
  const text = (s: string) => {
    if (s) out.push({ text: decode(s), b: on.b > 0, i: on.i > 0, link })
  }
  for (const m of html.matchAll(/<(\/?)(strong|em|a|br)\b([^>]*)>/g)) {
    text(html.slice(at, m.index))
    at = m.index + m[0].length
    const close = m[1] === '/'
    if (m[2] === 'br') out.push({ br: true })
    else if (m[2] === 'a') {
      if (!close) {
        const href = safeHref(/href="([^"]*)"/.exec(m[3] as string)?.[1])
        if (href) {
          link = true
          out.push({ open: href })
        }
      } else if (link) {
        link = false
        out.push({ close: true })
      }
    } else on[m[2] === 'strong' ? 'b' : 'i'] += close ? -1 : 1
  }
  text(html.slice(at))
  if (link) out.push({ close: true })
  return out
}

function runs(html: string, link: (href: string) => string): string {
  return inlines(html)
    .map((x) => {
      if ('br' in x) return '<w:r><w:br/></w:r>'
      if ('open' in x) return `<w:hyperlink r:id="${link(x.open)}">`
      if ('close' in x) return '</w:hyperlink>'
      // w:rPr の中は rStyle → b → i の順（OOXML の並び）
      const pr = `${x.link ? '<w:rStyle w:val="Hyperlink"/>' : ''}${x.b ? '<w:b/>' : ''}${x.i ? '<w:i/>' : ''}`
      return `<w:r>${pr && `<w:rPr>${pr}</w:rPr>`}<w:t xml:space="preserve">${escapeHtml(x.text)}</w:t></w:r>`
    })
    .join('')
}

const STYLES = xml(`<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3]
  .map(
    (k) =>
      `<w:style w:type="paragraph" w:styleId="Heading${k}"><w:name w:val="heading ${k}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="${k - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[36, 30, 26][k - 1]}"/></w:rPr></w:style>`,
  )
  .join('\n')}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`)

const LIST_FMT = { ul: ['bullet', '•'], ol: ['decimal', '%1.'] } as const

export function docxOf(makerHtml: string): Buffer {
  const rels: string[] = []
  const link = (href: string) => {
    const id = `rIdL${rels.length + 1}`
    rels.push(`<Relationship Id="${id}" Type="${HYPERLINK}" Target="${escapeHtml(href)}" TargetMode="External"/>`)
    return id
  }
  // 番号付きの箇条書きは、まとまりごとに 1 から数え直す（num を分ける）
  const nums: ('ul' | 'ol')[] = []
  let prev: 'ul' | 'ol' | undefined
  const paras = pageBlocks(makerHtml).map((b) => {
    const list = b.kind === 'li' ? b.list : undefined
    if (list && list !== prev) nums.push(list)
    prev = list
    const pr = list
      ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${nums.length}"/></w:numPr>`
      : b.kind === 'p'
        ? ''
        : `<w:pStyle w:val="Heading${b.kind.slice(1)}"/>`
    return `<w:p>${pr && `<w:pPr>${pr}</w:pPr>`}${runs(b.html, link)}</w:p>`
  })
  const numbering = xml(`<w:numbering xmlns:w="${W}">
${(['ul', 'ol'] as const)
  .map(
    (k, i) =>
      `<w:abstractNum w:abstractNumId="${i}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${LIST_FMT[k][0]}"/><w:lvlText w:val="${LIST_FMT[k][1]}"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`,
  )
  .join('\n')}
${nums.map((k, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${k === 'ul' ? 0 : 1}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join('\n')}
</w:numbering>`)
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`),
    ],
    [
      '_rels/.rels',
      xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    ],
    [
      'word/_rels/document.xml.rels',
      xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/>
<Relationship Id="rIdN" Type="${R}/numbering" Target="numbering.xml"/>
${rels.join('\n')}
</Relationships>`),
    ],
    [
      'word/document.xml',
      xml(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
${paras.join('\n')}
<w:sectPr/></w:body></w:document>`),
    ],
    ['word/styles.xml', STYLES],
    ['word/numbering.xml', numbering],
  ]
  return zip(files.map(([name, body]) => [name, Buffer.from(body, 'utf-8')]))
}

// 無圧縮の zip。日時は 1980-01-01 00:00 に固定
export function zip(entries: [string, Buffer][]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf-8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // 名前は UTF-8
    head.writeUInt16LE(0x21, 12) // 日付 1980-01-01
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(n.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(0x21, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(n.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(head, n, data)
    central.push(dir, n)
    offset += head.length + n.length + data.length
  }
  const size = central.reduce((s, b) => s + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

// zip の 1 つのファイル（無圧縮と deflate）。無ければ undefined
export function unzip(buf: Buffer, name: string): string | undefined {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) return undefined
  let p = buf.readUInt32LE(end + 16)
  for (let k = buf.readUInt16LE(end + 10); k > 0; k--) {
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    const at = buf.readUInt32LE(p + 42)
    if (buf.toString('utf-8', p + 46, p + 46 + nameLen) === name) {
      const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
      const data = buf.subarray(start, start + size)
      return (method === 8 ? inflateRawSync(data) : data).toString('utf-8')
    }
    p += 46 + skip
  }
  return undefined
}

// 文書の段落（字のあるもの）とリンクの行き先を出てくる順に。docsRoundTrip の材料（6.5 (5)）
export type DocText = { units: string[]; links: string[] }
const hrefs = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x)

export function docxText(buf: Buffer): DocText {
  const doc = unzip(buf, 'word/document.xml') ?? ''
  const rels = new Map(
    [...(unzip(buf, 'word/_rels/document.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /\bId="([^"]*)"/.exec(m[0])?.[1],
      decode(/\bTarget="([^"]*)"/.exec(m[0])?.[1] ?? ''),
    ]),
  )
  const units = [...doc.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
    .map((m) =>
      [...(m[1] as string).matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((t) => decode(t[1] as string)).join(''),
    )
    .filter((u) => u.trim())
  const links = hrefs([...doc.matchAll(/<w:hyperlink\b[^>]*\br:id="([^"]*)"/g)].map((m) => safeHref(rels.get(m[1]))))
  return { units, links }
}

// Google の書き出し（text/html）。リンクは google.com/url?q= の転送を外す
export function exportedText(html: string): DocText {
  const body = html.replace(/<(style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
  const units = [...body.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)]
    .map((m) => decode((m[2] as string).replace(/<[^>]*>/g, '')))
    .filter((u) => u.trim())
  const links = hrefs(
    [...body.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => {
      const href = decode(m[1] as string)
      try {
        const u = new URL(href)
        const q = u.hostname === 'www.google.com' && u.pathname === '/url' ? u.searchParams.get('q') : null
        return safeHref(q ?? href)
      } catch {
        return undefined
      }
    }),
  )
  return { units, links }
}
