// 本文の読み方（docs/implementation.md 6.2.5 (2)(7)）。判定・画面の字数・差分・承認の面の本文が同じ読み方を使う
export type Block = { kind: 'heading'; level: number; text: string } | { kind: 'para'; lines: string[]; list: boolean }

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

// 空行で区切ったまとまりが 1 ブロック。見出しの行はそれだけで 1 ブロック
export function blocks(md: string): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'para', lines: para, list: para.every((l) => LIST_ITEM.test(l)) })
    para = []
  }
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      flush()
      out.push({ kind: 'heading', level: (h[1] as string).length, text: (h[2] as string).trim() })
    } else if (line.trim() === '') flush()
    else para.push(line)
  }
  flush()
  return out
}

// 行頭の記号・強調・コード・リンクの URL を外した文字
export function plain(line: string): string {
  return line
    .replace(LIST_ITEM, '')
    .replace(/^\s*>\s?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
}
const blockText = (b: Block) => (b.kind === 'heading' ? plain(b.text) : b.lines.map(plain).join('\n'))
const squeeze = (s: string) => s.normalize('NFKC').replace(/\s+/g, '')
const length = (s: string) => [...squeeze(s)].length

// 字数 = 見出しと段落の文字から記号と空白を除いたコードポイントの数
export const charCount = (md: string) => blocks(md).reduce((n, b) => n + length(blockText(b)), 0)

// 見出しの読み方（6.2.5 (2)）。先頭が # でレベル 1 がそれ 1 つなら題。依頼の「見出し」は題を除いた一番上のレベルの見出し
// （その下の小見出しは見出しに数えず、段落は上の見出しの節に入れる）
type Heading = Extract<Block, { kind: 'heading' }>
function outline(md: string) {
  const bs = blocks(md)
  const hs = bs.filter((x): x is Heading => x.kind === 'heading')
  const first = bs[0]
  const title = first?.kind === 'heading' && first.level === 1 && hs.filter((h) => h.level === 1).length === 1
  const body = title ? bs.slice(1) : bs
  const levels = body.flatMap((x) => (x.kind === 'heading' ? [x.level] : []))
  return { body, top: levels.length ? Math.min(...levels) : undefined }
}

// level を書けばそのレベルだけ。書かなければ題を除いた一番上のレベルの見出しの数
export function headingCount(md: string, level?: number): number {
  if (level !== undefined) return blocks(md).filter((x) => x.kind === 'heading' && x.level === level).length
  const { body, top } = outline(md)
  return body.filter((x) => x.kind === 'heading' && x.level === top).length
}

export const paragraphs = (md: string) => blocks(md).filter((b) => b.kind === 'para')

// 節 = 一番上のレベルの見出し 1 つと、次の同じレベルの見出しまでの段落（小見出しの下の段落も含む）。
// 最初の見出しより前（題の下の前置き）は節に入れない。見出しの無い本文は全体で 1 節。空の節は「段落 0」として残す
export type Section = { heading: string; paras: string[] }
export function sections(md: string): Section[] {
  const { body, top } = outline(md)
  if (top === undefined) {
    const paras = body.flatMap((x) => (x.kind === 'para' ? [blockText(x)] : []))
    return paras.length ? [{ heading: '', paras }] : []
  }
  const out: Section[] = []
  for (const x of body) {
    if (x.kind === 'heading' && x.level === top) out.push({ heading: plain(x.text), paras: [] })
    else if (x.kind === 'para') out.at(-1)?.paras.push(blockText(x))
  }
  return out
}

// 段落の単位（属する節の見出し付き）
export function paragraphUnits(md: string): { heading: string; text: string }[] {
  let heading = ''
  const out: { heading: string; text: string }[] = []
  for (const b of blocks(md)) {
    if (b.kind === 'heading') heading = plain(b.text)
    else out.push({ heading, text: blockText(b) })
  }
  return out
}

// 文 = 段落の中を 。！？!? と改行で切ったもの
export function sentences(md: string): string[] {
  return (
    paragraphs(md)
      .flatMap((b) => b.lines.map(plain))
      // 句点の後の閉じ括弧は前の文に付ける（「例です。」で 1 文）
      .flatMap((l) => l.match(/[^。！？!?]*[。！？!?]+[」』）)"”']*|[^。！？!?]+$/g) ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
  )
}
export const sentenceLength = length
// 文末の記号と閉じ括弧を除いた末尾
export const ending = (s: string) => s.replace(/[\s。！？!?」』）)"”']+$/u, '')

// --- 比べるためのブロック列（pageRoundTrip・差分）

// 本文: 見出し・段落・箇条書きの項目ごと
export function compareUnits(md: string): string[] {
  return blocks(md).flatMap((b) =>
    b.kind === 'heading' ? [plain(b.text)] : b.list ? b.lines.map(plain) : [b.lines.map(plain).join('')],
  )
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITY[e.toLowerCase()] ?? m
  })

// ページ: h1〜h6・p・li ごとに、タグを外して文字参照を戻したもの
export function pageUnits(html: string): string[] {
  return [...html.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((m) =>
    decode((m[2] as string).replace(/<[^>]*>/g, '')),
  )
}

export const sameText = (a: string, b: string) => squeeze(a) === squeeze(b)

// 最長共通部分列で並べた操作の列（差分と pageRoundTrip の数え方）
export function align<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean) {
  const m = a.length
  const n = b.length
  const t = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      (t[i] as number[])[j] = eq(a[i] as T, b[j] as T)
        ? ((t[i + 1] as number[])[j + 1] as number) + 1
        : Math.max((t[i + 1] as number[])[j] as number, (t[i] as number[])[j + 1] as number)
  const ops: ({ op: 'same'; a: T; b: T } | { op: 'removed'; a: T } | { op: 'added'; b: T })[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && eq(a[i] as T, b[j] as T)) ops.push({ op: 'same', a: a[i++] as T, b: b[j++] as T })
    else if (j < n && (i === m || ((t[i] as number[])[j + 1] as number) >= ((t[i + 1] as number[])[j] as number)))
      ops.push({ op: 'added', b: b[j++] as T })
    else ops.push({ op: 'removed', a: a[i++] as T })
  }
  return ops
}

// --- 承認の面に出す本文（6.2.5 (7)）。判定した Markdown から組み立て、文字は全部エスケープする

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
// 強調（**）と出典のリンク（http / https。6.3.1 (11)）だけ残す
const LINK_MD = /(!?)\[([^\]]*)\]\(([^)\s]*)\)/g
const linkify = (s: string) => {
  let out = ''
  let at = 0
  for (const m of s.matchAll(LINK_MD)) {
    out += escapeHtml(s.slice(at, m.index))
    const text = escapeHtml(m[2] as string)
    out +=
      !m[1] && /^https?:\/\//i.test(m[3] as string)
        ? `<a href="${escapeHtml(m[3] as string)}" rel="noopener noreferrer" target="_blank">${text}</a>`
        : text
    at = m.index + m[0].length
  }
  return out + escapeHtml(s.slice(at))
}
const inline = (s: string) =>
  linkify(
    s
      .replace(LIST_ITEM, '')
      .replace(/^\s*>\s?/, '')
      .replace(/__|~~|`/g, ''),
  ).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

export function renderHtml(md: string): string {
  return blocks(md)
    .map((b) => {
      if (b.kind === 'heading') {
        const h = `h${Math.min(b.level, 3)}`
        return `<${h}>${inline(b.text)}</${h}>`
      }
      if (b.list) {
        const tag = /^\s*\d/.test(b.lines[0] as string) ? 'ol' : 'ul'
        return `<${tag}>${b.lines.map((l) => `<li>${inline(l)}</li>`).join('')}</${tag}>`
      }
      return `<p>${b.lines.map(inline).join('<br>')}</p>`
    })
    .join('\n')
}

// --- 2 版の変更点（5.2 の diff。6.2.5 (7)）。同じブロックは返さない。間に挟まった消えた・増えたは前から順に組にして changed

export type Change = { kind: 'added' | 'removed' | 'changed'; before?: string; after?: string }
const displayUnits = (md: string) =>
  blocks(md).map((b) => (b.kind === 'heading' ? plain(b.text) : b.lines.map(plain).join('\n')))

export function diff(from: string, to: string): Change[] {
  const out: Change[] = []
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    const n = Math.min(removed.length, added.length)
    for (let i = 0; i < n; i++) out.push({ kind: 'changed', before: removed[i] as string, after: added[i] as string })
    for (const before of removed.slice(n)) out.push({ kind: 'removed', before })
    for (const after of added.slice(n)) out.push({ kind: 'added', after })
    removed = []
    added = []
  }
  for (const o of align(displayUnits(from), displayUnits(to), (a, b) => a === b)) {
    if (o.op === 'same') flush()
    else if (o.op === 'removed') removed.push(o.a)
    else added.push(o.b)
  }
  flush()
  return out
}
