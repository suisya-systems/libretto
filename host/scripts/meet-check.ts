// 本物の会議メモの書き出しで切り出しを確かめる（docs/verification/meet.md）。網に出ず、モデルを呼ばず、何も書かない
//   npm run verify:meet -- <書き出した .txt> [--title <題名>] [--name <表示名>] [--email <アドレス>]
// 1 行目にホストが付ける結果（unreadable / none / items）、次に項目ごとの担当と、本人担当としたときの確信度を出す
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { actionItems, assigneeOf, confidenceOf, parseTitle } from '../src/intake/meet.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [file] = positionals
if (!file || values.help) {
  console.log(
    'usage: npm run verify:meet -- <exported.txt> [--title <doc title>] [--name <display name>] [--email <address>]',
  )
  console.log('  runs the host parser on a Gemini notes text/plain export (no network, no model, writes nothing)')
  process.exit(file ? 0 : 2)
}

if (values.title !== undefined) {
  const t = parseTitle(values.title, new Date().toISOString())
  // JST でない題名の日時は、ホストではファイルの createdTime から取る（ここでは今の時刻になる）
  console.log(t ? `title: ok meeting=${t.meeting} heldAt=${t.heldAt}` : 'title: NOT MATCHED (the host skips this note)')
}
const r = actionItems(readFileSync(file, 'utf8'))
if (!r) {
  console.log('result: unreadable (no action-item heading found)')
  process.exit(1)
}
console.log(r.items.length ? `result: items ${r.items.length}${r.truncated ? ' (truncated)' : ''}` : 'result: none')
// 空のアドレスはどの文にも含まれるので、渡されなければ当たらない値にする
const me = { email: values.email ?? '\u0000', name: values.name }
r.items.forEach((x, i) => {
  const who = assigneeOf(x) || '(none)'
  const conf = values.email || values.name ? ` if-mine=${confidenceOf('本人', x, me)}` : ''
  console.log(`${i + 1}. assignee=${who}${conf} | ${x}`)
})
