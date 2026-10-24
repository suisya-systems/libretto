// 貼り付け用の文（docs/implementation.md 6.2.8 (1)）。判定した本文から字だけにする。
// 表・脚注・HTML のタグは崩さずに残す（pasteSafe が落として作り手に返す）
import { plain as bare, blocks } from '../checks/text.ts'

// 出典のリンクは「題（URL）」にして残す（6.3.1 (11)）。記号の掃除は URL に当てない
const LINK = /(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const plain = (l: string) => {
  let out = ''
  let at = 0
  for (const m of l.matchAll(LINK)) {
    out += `${bare(l.slice(at, m.index))}${bare(m[1] as string)}（${m[2]}）`
    at = m.index + m[0].length
  }
  return out + bare(l.slice(at))
}

export function pasteText(md: string): string {
  const out = blocks(md).map((b) => {
    if (b.kind === 'heading') return plain(b.text)
    if (!b.list) return b.lines.map(plain).join('\n')
    const ordered = /^\s*\d/.test(b.lines[0] as string)
    return b.lines.map((l, i) => `${ordered ? `${i + 1}. ` : '・'}${plain(l)}`).join('\n')
  })
  return `${out.join('\n\n')}\n`
}
