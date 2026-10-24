// 実モデル検証（docs/implementation.md 11.3 (2)・docs/verification/README.md）。sandbox の外で `npm run verify:live`
// 検証用の家で本物のホスト（host/src/index.ts）を子プロセスで起こし、止まったら <家>/verification.md に記録の下書きを書く
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { initHome, monthCapFromEnv } from '../src/ledger/db.ts'
import { jst } from '../src/ledger/ledger.ts'
import { resolveClaude } from '../src/model/claude-cli.ts'
import { checkSandbox } from '../src/model/sandbox.ts'
import { facts, monthOf, type Notebook, refusal, renderRecord } from './verify-record.ts'

const DEFAULT_CAP_YEN = 3000
const repo = fileURLToPath(new URL('../..', import.meta.url))
const die = (line: string): never => {
  console.error(`verify:live: ${line}`)
  process.exit(1)
}

const { values } = parseArgs({
  options: { home: { type: 'string' }, cap: { type: 'string' }, report: { type: 'boolean' } },
})
if (values.cap !== undefined && !/^[1-9]\d*$/.test(values.cap)) die(`--cap must be a positive integer: ${values.cap}`)
const cap = monthCapFromEnv({ LIBRETTO_MONTH_CAP_YEN: values.cap })
const now = new Date()

let home: string
let nb: Notebook
if (values.home) {
  home = resolve(values.home)
  const file = join(home, 'verify.json')
  if (!existsSync(file)) die(`not a verification home (no verify.json): ${home}`)
  nb = JSON.parse(readFileSync(file, 'utf-8')) as Notebook
} else {
  if (values.report) die('--report needs --home <dir>')
  const no = refusal(undefined, now)
  if (no) die(no)
  const root = join(homedir(), 'libretto-verify')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  home = mkdtempSync(join(root, `${jst(now).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-`))
  nb = { startedAt: jst(now), month: monthOf(now), capYen: cap ?? DEFAULT_CAP_YEN, sessions: [] }
}
const debugDir = join(home, 'debug')

function writeRecord() {
  const ledger = initHome(home)
  try {
    const template = readFileSync(join(repo, 'docs/verification/template.md'), 'utf-8')
    writeFileSync(join(home, 'verification.md'), renderRecord(template, facts(ledger, nb, debugDir)))
  } finally {
    ledger.close()
  }
  console.log(`verify:live: record draft: ${join(home, 'verification.md')}`)
}

if (values.report) {
  writeRecord()
  process.exit(0)
}
if (values.home) {
  const no = refusal(nb, now)
  if (no) die(no)
}

// 起こす前の自己点検。claude が使えない・隔離が壊れているなら、費用を使う前に止める（作り手で必ず落ちる）
const check = await checkSandbox({ home, claude: resolveClaude() })
if (!check.claudeOk) die(`Claude Code is not usable (version ${check.claudeVersion ?? 'unknown'}). Sign in and retry.`)
if (check.isolation === 'broken') die(`the sandbox is broken (${check.reason ?? ''}).`)
if (check.isolation === 'weak') console.error(`verify:live: isolation is weak (${check.reason ?? ''}). Continuing.`)

const capYen = cap ?? nb.capYen
nb.capYen = capYen
const rev = spawnSync('git', ['describe', '--always', '--dirty', '--abbrev=7'], { cwd: repo, encoding: 'utf-8' })
nb.sessions.push({
  at: jst(new Date()),
  rev: rev.stdout.trim() || 'unknown',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  isolation: `${check.isolation}${check.reason ? ` (${check.reason})` : ''}`,
  claude: check.claudeVersion ?? 'unknown',
  capYen,
})
writeFileSync(join(home, 'verify.json'), `${JSON.stringify(nb, null, 2)}\n`)
console.log(`verify:live: home ${home} / cap ${capYen} yen / Ctrl-C to stop and write the record draft`)

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', join(repo, 'host/src/index.ts')],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      LIBRETTO_HOME: home,
      LIBRETTO_DEBUG_DIR: debugDir,
      LIBRETTO_MONTH_CAP_YEN: String(capYen),
    },
  },
)
// Ctrl-C は端末が子にも届ける。こちらは子の終わり（台帳を閉じた後）を待って記録を書く
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => {
  writeRecord()
  process.exit(code ?? 0)
})
