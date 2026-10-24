// 貼り付け用の文（docs/implementation.md 6.2.8 (1)）。判定した本文から字だけにする。
// 表・脚注・HTML のタグは崩さずに残す（pasteSafe が落として作り手に返す）
import { plain as bare, blocks } from '../checks/text.ts'

// 出典のリンクは「題（URL）」にして残す（6.3.1 (11)）
const plain = (l: string) => bare(l.replace(/(?<!!)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）'))

export function pasteText(md: string): string {
  const out = blocks(md).map((b) => {
    if (b.kind === 'heading') return plain(b.text)
    if (!b.list) return b.lines.map(plain).join('\n')
    const ordered = /^\s*\d/.test(b.lines[0] as string)
    return b.lines.map((l, i) => `${ordered ? `${i + 1}. ` : '・'}${plain(l)}`).join('\n')
  })
  return `${out.join('\n\n')}\n`
}
