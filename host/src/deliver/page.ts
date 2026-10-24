// 版のあるページ（docs/implementation.md 5.6・6.2.8 (1)）。作り手の HTML から h1〜h6・p・li のブロックだけを取り出して組み直す。
// ブロックの外の字は出さない（見える字を全部 pageRoundTrip が数えるブロックに入れる）。字は全部エスケープし直す
import { decode, escapeHtml } from '../checks/text.ts'

type Kind = 'h1' | 'h2' | 'h3' | 'p' | 'li'
type Block = { kind: Kind; list?: 'ul' | 'ol'; html: string }

const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li'])
// 中身ごと捨てる
const DROP = new Set([
  'script',
  'style',
  'head',
  'title',
  'template',
  'iframe',
  'object',
  'svg',
  'math',
  'noscript',
  'textarea',
  'select',
])
// ブロックの中で残す強調（属性なし）と、出典のリンク（http / https の href だけ。6.3.1 (11)）
type Inline = 'strong' | 'em' | 'a'
const INLINE: Record<string, Inline> = { strong: 'strong', b: 'strong', em: 'em', i: 'em', a: 'a' }
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
export function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(decode(raw).trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}
export const anchor = (href: string) => `<a href="${escapeHtml(href)}" rel="noopener noreferrer">`
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g

export function pageBlocks(html: string): Block[] {
  const out: Block[] = []
  const lists: ('ul' | 'ol')[] = []
  let drop: string | undefined
  let block: { kind: Kind; list?: 'ul' | 'ol'; depth: number; parts: string[]; open: Inline[] } | undefined
  const flush = () => {
    if (!block) return
    const inner =
      block.parts.join('') +
      [...block.open]
        .reverse()
        .map((t) => `</${t}>`)
        .join('')
    // 字の無いブロック（空の p など）は出さない
    if (inner.replace(/<[^>]*>/g, '').trim())
      out.push({ kind: block.kind, ...(block.list && { list: block.list }), html: inner.trim() })
    block = undefined
  }
  const text = (s: string) => {
    if (!drop && block && s) block.parts.push(escapeHtml(decode(s)))
  }
  let at = 0
  for (const m of html.matchAll(TOKEN)) {
    text(html.slice(at, m.index))
    at = m.index + m[0].length
    const name = m[2]?.toLowerCase()
    if (!name) continue // 注釈・doctype
    const close = m[1] === '/'
    if (drop) {
      if (close && name === drop) drop = undefined
      continue
    }
    if (DROP.has(name)) {
      if (!close && !m[0].endsWith('/>')) drop = name
      continue
    }
    if (name === 'ul' || name === 'ol') {
      if (close) lists.pop()
      else lists.push(name)
      continue
    }
    if (BLOCK.has(name)) {
      if (close) {
        // 入れ子の箇条書きの </li> では閉じない（開いたときと同じ深さの </li> だけが閉じる）
        const same = block?.kind === 'li' ? name === 'li' && lists.length === block.depth : block?.kind === name
        if (block && (same || (block.kind === 'h3' && /^h[3-6]$/.test(name)))) flush()
        continue
      }
      // 段落・見出しは次のブロックで閉じる。li の中の p と、li の中の入れ子の箇条書きの li は li の字に入れる
      if (block?.kind === 'li' && (name !== 'li' || lists.length > block.depth)) continue
      flush()
      const kind = (/^h[4-6]$/.test(name) ? 'h3' : name) as Kind
      block = {
        kind,
        ...(kind === 'li' && { list: lists.at(-1) ?? 'ul' }),
        depth: lists.length,
        parts: [],
        open: [],
      }
      continue
    }
    if (!block) continue
    if (name === 'br') {
      block.parts.push('<br>')
      continue
    }
    const tag = INLINE[name]
    if (!tag) continue // ほかのタグはタグだけ捨てて字を残す
    if (!close) {
      let open = `<${tag}>`
      if (tag === 'a') {
        const h = HREF.exec(m[0])
        const href = safeHref(h?.[1] ?? h?.[2] ?? h?.[3])
        if (!href || block.open.includes('a')) continue // 字だけ残す
        open = anchor(href)
      }
      block.open.push(tag)
      block.parts.push(open)
    } else if (block.open.at(-1) === tag) {
      block.open.pop()
      block.parts.push(`</${tag}>`)
    }
  }
  text(html.slice(at))
  flush()
  return out
}

function renderBlocks(blocks: readonly Block[]): string {
  const lines: string[] = []
  let list: 'ul' | 'ol' | undefined
  for (const b of blocks) {
    const want = b.kind === 'li' ? b.list : undefined
    if (list !== want) {
      if (list) lines.push(`</${list}>`)
      if (want) lines.push(`<${want}>`)
      list = want
    }
    lines.push(`<${b.kind}>${b.html}</${b.kind}>`)
  }
  if (list) lines.push(`</${list}>`)
  return lines.join('\n')
}

const DAY = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

// 枠には h*・p・li を使わない（pageRoundTrip が本文のブロックとして数えるため）
export function pageDocument(makerHtml: string, v: { title: string; n: number; at: string }): string {
  const title = escapeHtml(v.title)
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<article>
${renderBlocks(pageBlocks(makerHtml))}
</article>
<footer><span>バージョン ${v.n}</span><span aria-hidden="true">・</span><time datetime="${escapeHtml(v.at)}">${DAY.format(new Date(v.at))}</time></footer>
</main>
</body>
</html>
`
}

const STYLE = `
:root{--ink:#1c1b19;--muted:#6b675f;--line:#e4e1da;--page:#fbfaf7;--accent:#2f4a8a}
@media (prefers-color-scheme:dark){:root{--ink:#ecebe6;--muted:#a8a49b;--line:#3a3833;--page:#191816;--accent:#9fb4ea}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","YuGothic","Noto Sans JP",sans-serif;font-size:17px;line-height:1.95;letter-spacing:.02em;font-feature-settings:"palt" 0;overflow-wrap:anywhere}
main{max-width:40rem;margin:0 auto;padding:4.5rem 1.5rem 3.5rem}
article>:first-child{margin-top:0}
h1,h2,h3{font-family:"Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP",serif;font-weight:600;line-height:1.5;letter-spacing:.03em}
h1{font-size:1.9rem;text-wrap:balance;margin:0 0 2.25rem;padding-bottom:1.25rem;border-bottom:1px solid var(--line)}
h2{font-size:1.35rem;margin:3rem 0 1rem}
h3{font-size:1.1rem;margin:2.25rem 0 .75rem}
p{margin:0 0 1.35em}
ul,ol{margin:0 0 1.35em;padding-left:1.4em}
li{margin:.3em 0}
li::marker{color:var(--muted)}
strong{font-weight:700}
footer{display:flex;gap:.25em;margin-top:4rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem;letter-spacing:.04em}
@media (max-width:480px){body{font-size:16px;line-height:1.9}main{padding:2.5rem 1.25rem 2.5rem}h1{font-size:1.55rem;margin-bottom:1.75rem}h2{font-size:1.2rem;margin-top:2.5rem}}
@media print{body{background:#fff;color:#000}main{padding:0}footer{color:#555}}
`
