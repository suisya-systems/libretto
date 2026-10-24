// claude -p の偽物（docs/implementation.md 6.1.2）。標準入力の 1 行目の JSON で振る舞いを決め、受け取った argv・env・cwd・標準入力を record に書く
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const [head = '{}'] = input.split('\n', 1)
const c = JSON.parse(head)
if (c.record)
  writeFileSync(c.record, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), input }))

const result = (over) => {
  const r = { type: 'result', subtype: 'success', is_error: false, result: c.text ?? 'ok', ...over }
  if ('cost' in c) r.total_cost_usd = c.cost
  process.stdout.write(JSON.stringify(r))
}
// 止める要求を無視する子を 1 つ残す（同じグループ・同じツリー）
const grandchild = () => {
  const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
    stdio: 'inherit',
  })
  writeFileSync(c.pidFile, JSON.stringify({ leader: process.pid, grandchild: g.pid }))
  return g
}

switch (c.mode) {
  case 'ok':
    result({})
    break
  case 'write':
    for (const [name, text] of Object.entries(c.write)) writeFileSync(name, text)
    result({})
    break
  case 'budget':
    result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined, errors: ['budget'] })
    process.exitCode = 1
    break
  case 'status':
    result({ is_error: true, result: 'API Error', api_error_status: c.status })
    process.exitCode = 1
    break
  // 実機（2.1.309 / 2.1.226）の未ログイン・期限切れの形
  case 'nologin':
    result({ is_error: true, result: c.text, api_error_status: null, terminal_reason: 'api_error' })
    process.exitCode = 1
    break
  case 'error':
    result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['boom'] })
    process.exitCode = 1
    break
  case 'exit-mismatch':
    result({})
    process.exitCode = 2
    break
  case 'partial':
    process.stdout.write('{"type":"result","subtype":"succ')
    process.exitCode = 1
    break
  case 'linger':
    grandchild().unref()
    result({})
    break
  case 'hang':
    process.on('SIGTERM', () => {})
    grandchild()
    setInterval(() => {}, 1000)
    break
}
