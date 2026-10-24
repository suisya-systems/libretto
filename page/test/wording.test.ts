// wording.ts が docs/ui-wording.md の「画面が wording.ts で引くラベル」と一致し、出さない語を含まない（5.5・5.8 (4)・11.2）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STATE, W } from '../src/wording.ts'

const md = readFileSync(new URL('../../docs/ui-wording.md', import.meta.url), 'utf-8')
const labels = md.slice(md.indexOf('### 画面が `wording.ts` で引くラベル'))
const rows = (re: RegExp) => Object.fromEntries([...labels.matchAll(re)].map((m) => [m[1], m[2]]))
const CLI_MARKERS = /claude|anthropic|openai|gpt|codex|prompt|branch|commit|\bPR\b|\bCI\b|model|holdout|scenario/i

describe('wording.ts', () => {
  it('ラベルが ui-wording.md の表と一致する', () => {
    expect(rows(/^\| `([^`]+)` \| (.+) \|$/gm)).toEqual(W)
  })
  it('ステータスが ui-wording.md の表と一致する', () => {
    const states = labels.slice(0, labels.indexOf('**ナビと枠**'))
    const table = Object.fromEntries([...states.matchAll(/^\| ([^|`\s]+) \| ([^|]+) \|$/gm)].map((m) => [m[1], m[2]]))
    delete table.設計書での言葉
    expect(table).toEqual(STATE)
  })
  it('出さない語を含まない。欄の名前としてオーナーが承認したキーだけ許す（11.2）', () => {
    const allowed: string[] = ['settings.openai.label']
    const rest = Object.entries(W).filter(([k]) => !allowed.includes(k))
    for (const s of [...rest.map(([, v]) => v), ...Object.values(STATE)]) expect(s).not.toMatch(CLI_MARKERS)
  })
})
