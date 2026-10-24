// ホストが作って返す文（STEP・SAY）が docs/ui-wording.md の全文と一致する（docs/implementation.md 5.8 (4)）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAY, STEP } from '../src/case/transition.ts'
import { TALK } from '../src/roles/conversation.ts'

const md = readFileSync(new URL('../../docs/ui-wording.md', import.meta.url), 'utf-8')
// 見出し heading の直後の表の「| `key` | 文 |」の行
const table = (heading: string) => {
  const rest = md.slice(md.indexOf(heading))
  const body = rest.slice(0, rest.indexOf('\n\n', rest.indexOf('|')))
  return Object.fromEntries([...body.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)].map((m) => [m[1], m[2]]))
}

describe('ui-wording.md のホストが作る文', () => {
  it('STEP の 16 個', () => {
    expect(Object.keys(STEP)).toHaveLength(16)
    expect(table('**いまの 1 行')).toEqual(STEP)
  })
  it('SAY の 8 個', () => {
    expect(Object.keys(SAY)).toHaveLength(8)
    expect(table('**会話欄に足す 1 行')).toEqual(SAY)
  })
  it('TALK の 6 個', () => {
    expect(Object.keys(TALK)).toHaveLength(6)
    expect(table('**話し相手の代わりに会話欄に書く 1 行')).toEqual(TALK)
  })
})
