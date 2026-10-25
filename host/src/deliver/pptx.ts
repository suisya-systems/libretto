// スライド（docs/implementation.md 6.10 (1)(2)(4)）。作り手の HTML のブロック（pageBlocks）から組む: h1 が表紙、h2 ごとに 1 枚。
// pptx は依存を足さずに書く（docx.ts の zip）。16:9、題と本文のテキストボックスだけ。同じ入力から同じバイト列
import { decode, escapeHtml } from '../checks/text.ts'
import { type DocText, inlines, unzip, xml, zip } from './docx.ts'
import { pageBlocks, safeHref } from './page.ts'

type Block = ReturnType<typeof pageBlocks>[number]
export type Slide = { title?: Block; body: Block[]; cover: boolean }

export function slidesOf(makerHtml: string): Slide[] {
  const out: Slide[] = []
  for (const b of pageBlocks(makerHtml)) {
    if (b.kind === 'h1' && !out.length) out.push({ title: b, body: [], cover: true })
    else if (b.kind === 'h1' || b.kind === 'h2') out.push({ title: b, body: [], cover: false })
    else {
      if (!out.length) out.push({ body: [], cover: false })
      ;(out.at(-1) as Slide).body.push(b)
    }
  }
  return out
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`
const W = 12192000
const H = 6858000
const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

// a:rPr の中は hlinkClick が最後（OOXML の並び）
function runs(html: string, size: number, bold: boolean, link: (href: string) => string): string {
  let href: string | undefined
  return inlines(html)
    .map((x) => {
      if ('br' in x) return '<a:br/>'
      if ('open' in x) {
        href = link(x.open)
        return ''
      }
      if ('close' in x) {
        href = undefined
        return ''
      }
      const b = bold || x.b ? ' b="1"' : ''
      const i = x.i ? ' i="1"' : ''
      const click = x.link && href ? `<a:hlinkClick r:id="${href}"/>` : ''
      return `<a:r><a:rPr lang="ja-JP" sz="${size}"${b}${i}${click ? `>${click}</a:rPr>` : '/>'}<a:t>${escapeHtml(x.text)}</a:t></a:r>`
    })
    .join('')
}

function para(b: Block, size: number, link: (href: string) => string): string {
  const pr =
    b.kind === 'li'
      ? `<a:pPr marL="342900" indent="-342900">${b.list === 'ol' ? '<a:buAutoNum type="arabicPeriod"/>' : '<a:buChar char="•"/>'}</a:pPr>`
      : '<a:pPr><a:buNone/></a:pPr>'
  return `<a:p>${pr}${runs(b.html, size, b.kind === 'h3', link)}</a:p>`
}

function box(id: number, name: string, y: number, h: number, paras: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="${y}"/><a:ext cx="${W - 1219200}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" rIns="0"/><a:lstStyle/>${paras}</p:txBody></p:sp>`
}

function slideXml(s: Slide, link: (href: string) => string): string {
  const shapes: string[] = []
  if (s.title) {
    const size = s.cover ? 4000 : 2800
    const t = `<a:p><a:pPr><a:buNone/></a:pPr>${runs(s.title.html, size, true, link)}</a:p>`
    shapes.push(s.cover ? box(2, 'Title', 2286000, 1371600, t) : box(2, 'Title', 457200, 1005840, t))
  }
  if (s.body.length) {
    const ps = s.body.map((b) => para(b, s.cover ? 2000 : 1800, link)).join('')
    shapes.push(s.cover ? box(3, 'Subtitle', 3749040, 1371600, ps) : box(3, 'Body', 1600200, 4800600, ps))
  }
  return xml(
    `<p:sld ${NS}><p:cSld><p:spTree>${EMPTY_TREE}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
  )
}

const rel = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${escapeHtml(target)}"${external ? ' TargetMode="External"' : ''}/>`
const rels = (xs: string[]) =>
  xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${xs.join('\n')}
</Relationships>`)

const THEME = xml(`<a:theme xmlns:a="${A}" name="libretto"><a:themeElements>
<a:clrScheme name="libretto"><a:dk1><a:srgbClr val="1C1B19"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2F4A8A"/></a:dk2><a:lt2><a:srgbClr val="FBFAF7"/></a:lt2><a:accent1><a:srgbClr val="2F4A8A"/></a:accent1><a:accent2><a:srgbClr val="6B675F"/></a:accent2><a:accent3><a:srgbClr val="9FB4EA"/></a:accent3><a:accent4><a:srgbClr val="B5651D"/></a:accent4><a:accent5><a:srgbClr val="3A7D44"/></a:accent5><a:accent6><a:srgbClr val="8A2F4A"/></a:accent6><a:hlink><a:srgbClr val="1155CC"/></a:hlink><a:folHlink><a:srgbClr val="6B4A8A"/></a:folHlink></a:clrScheme>
<a:fontScheme name="libretto"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Noto Sans JP"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Noto Sans JP"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="libretto"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`)

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

export function pptxOf(makerHtml: string): Buffer {
  const slides = slidesOf(makerHtml)
  const parts: [string, string][] = []
  slides.forEach((s, i) => {
    const links: string[] = []
    const link = (href: string) => {
      const id = `rIdL${links.length + 1}`
      links.push(rel(id, 'hyperlink', href, true))
      return id
    }
    parts.push([`ppt/slides/slide${i + 1}.xml`, slideXml(s, link)])
    parts.push([
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      rels([rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'), ...links]),
    ])
  })
  const ct = (part: string, type: string) =>
    `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${ct('ppt/presentation.xml', 'presentationml.presentation.main')}
${ct('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster')}
${ct('ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout')}
${ct('ppt/theme/theme1.xml', 'theme')}
${slides.map((_, i) => ct(`ppt/slides/slide${i + 1}.xml`, 'presentationml.slide')).join('\n')}
</Types>`),
    ],
    ['_rels/.rels', rels([rel('rId1', 'officeDocument', 'ppt/presentation.xml')])],
    [
      'ppt/presentation.xml',
      xml(
        `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${slides
          .map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`)
          .join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
      ),
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      rels([
        rel('rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'),
        rel('rIdT', 'theme', 'theme/theme1.xml'),
        ...slides.map((_, i) => rel(`rIdS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`)),
      ]),
    ],
    [
      'ppt/slideMasters/slideMaster1.xml',
      xml(
        `<p:sldMaster ${NS}><p:cSld><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
      ),
    ],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      rels([
        rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
        rel('rId2', 'theme', '../theme/theme1.xml'),
      ]),
    ],
    [
      'ppt/slideLayouts/slideLayout1.xml',
      xml(
        `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      ),
    ],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      rels([rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')]),
    ],
    ['ppt/theme/theme1.xml', THEME],
    ...parts,
  ]
  return zip(files.map(([name, body]) => [name, Buffer.from(body, 'utf-8')]))
}

// スライドの段落（字のあるもの）とリンクの行き先を、スライドの順・図形の順に。slidesRoundTrip の材料（6.10 (3)(4)）。
// 仕立てた pptx と Google の書き出しの pptx を同じ関数で読む
const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1]
export function pptxText(buf: Buffer): DocText {
  const pres = unzip(buf, 'ppt/presentation.xml') ?? ''
  const relsOf = (path: string) =>
    new Map(
      [...(unzip(buf, path) ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
        attr(m[0], 'Id'),
        decode(attr(m[0], 'Target') ?? ''),
      ]),
    )
  const top = relsOf('ppt/_rels/presentation.xml.rels')
  const units: string[] = []
  const links: string[] = []
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const target = top.get(attr(m[0], 'r:id')) ?? ''
    const path = target.startsWith('/') ? target.slice(1) : `ppt/${target}`
    const name = path.split('/').at(-1) as string
    const slide = unzip(buf, path) ?? ''
    const own = relsOf(`${path.slice(0, -name.length)}_rels/${name}.rels`)
    for (const p of slide.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const t = [...(p[1] as string).matchAll(/<a:t\b[^>]*>([^<]*)<\/a:t>/g)]
        .map((x) => decode(x[1] as string))
        .join('')
      if (t.trim()) units.push(t)
      // 続いた run の同じ行き先（強調で分かれた 1 つのリンク）は 1 つに数える
      let prev: string | undefined
      for (const r of (p[1] as string).matchAll(/<a:r>[\s\S]*?<\/a:r>/g)) {
        const id = /<a:hlinkClick\b[^>]*\br:id="([^"]*)"/.exec(r[0])?.[1]
        const href = id ? safeHref(own.get(id)) : undefined
        if (href && href !== prev) links.push(href)
        prev = href
      }
    }
  }
  return { units, links }
}
