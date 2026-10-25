// ホストが作って返す文（STEP・SAY）が docs/ui-wording.md の全文と一致する（docs/implementation.md 5.8 (4)）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NOTICE, SAY, STEP } from '../src/case/transition.ts'
import { TALK } from '../src/roles/conversation.ts'
import { SLACK_DM } from '../src/server/slack-dm.ts'

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
  it('NOTICE の 13 個（出来事・キー・文・開く面の表）', () => {
    const rest = md.slice(md.indexOf('**お知らせの 1 行'))
    const body = rest.slice(0, rest.indexOf('\n\n', rest.indexOf('|')))
    const rows = [...body.matchAll(/^\| [^|]+ \| `([^`]+)` \| ([^|]+) \| [^|]+ \|$/gm)]
    expect(Object.keys(NOTICE)).toHaveLength(13)
    expect(Object.fromEntries(rows.map((m) => [m[1], m[2]]))).toEqual(NOTICE)
  })
  it('Slack の DM に足す 3 個', () => {
    expect(table('**Slack の DM に足す文')).toEqual(SLACK_DM)
  })
  it('TALK の 7 個', () => {
    expect(Object.keys(TALK)).toHaveLength(7)
    expect(table('**話し相手の代わりに会話欄に書く 1 行')).toEqual(TALK)
  })
})
