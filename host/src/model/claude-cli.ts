// claude -p を子プロセスで起こす中身（docs/implementation.md 6.1・6.1.2・8.3・8.5）。費用の予約・検査・言い直しは invoke の側
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { type Backend, type Call, callFile, type Reply } from './invoke.ts'
import type { Sandbox } from './sandbox.ts'

type Opts = {
  usdJpy: () => number // 呼び出しの頭で 1 回だけ読む（6.1.2 (5)）
  callsDir: string // 結果のファイルの置き場（9.4 (7)）
  command?: string[] // 起こす命令の先頭。省けば claude を探す
  sandbox?: Sandbox // 作り手（access: write）を srt で包む（8.9 (2)）
  blocked?: () => string | undefined // 理由があれば Claude を起こさない（版の下限。8.9 (5)）
  env?: NodeJS.ProcessEnv // 許可一覧で絞る元。既定は process.env
  killGraceMs?: number // SIGTERM から SIGKILL まで（8.5）
  log?: (line: string) => void
}

// access ごとの道具（6.1.2 (4)）
// search は WebSearch だけ。WebFetch は手元から取りに行くので渡さない（6.3.3 (2)）
const TOOLS = { none: '', read: 'Read,Glob,Grep', write: 'Read,Write,Edit,Glob,Grep', search: 'WebSearch' } as const

// 子に渡す環境変数の許可一覧（6.1.2 (1)）
const ENV_COMMON = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
]
const ENV_POSIX = ['HOME', 'USER', 'TMPDIR']
const ENV_WIN = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'HOMEDRIVE', 'HOMEPATH']

// Windows は名前の大小を区別せずに拾う（Path と PATH）
export function allowedEnv(env: NodeJS.ProcessEnv, platform = process.platform): Record<string, string> {
  const names = [...ENV_COMMON, ...(platform === 'win32' ? ENV_WIN : ENV_POSIX)]
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    const name = names.find((n) => (platform === 'win32' ? n.toUpperCase() === k.toUpperCase() : n === k))
    if (name && v !== undefined) out[name] = v
  }
  return out
}

// POSIX は spawn が PATH から探す。Windows は claude.exe、無ければ npm の claude.cmd の行き先を起こす（.cmd はシェル無しで起こせない）
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'win32') return ['claude']
  const dirs = (allowedEnv(env).PATH ?? '').split(delimiter).filter(Boolean)
  for (const d of dirs) if (existsSync(join(d, 'claude.exe'))) return [join(d, 'claude.exe')]
  for (const d of dirs) {
    const cmd = join(d, 'claude.cmd')
    if (!existsSync(cmd)) continue
    // npm の shim は最後の "%dp0%\…" が行き先（前の方は node.exe の有無の確かめ）
    const target = [...readFileSync(cmd, 'utf8').matchAll(/"%~?dp0%?\\([^"]+)"/g)].at(-1)?.[1]
    if (!target) continue
    const full = join(d, target)
    if (full.endsWith('.js')) return [process.execPath, full]
    if (full.toLowerCase().endsWith('.exe')) return [full]
  }
  return ['claude.exe']
}

const inside = (dir: string, file: string) => {
  const r = relative(resolve(dir), resolve(file))
  return r !== '' && r.split(sep)[0] !== '..' && !isAbsolute(r)
}

// 指示と材料を標準入力の 1 つの文書にする（6.1.2 (4)）
export function stdinText(call: Pick<Call, 'instruction' | 'materials' | 'access' | 'workdir'>): string {
  const parts = [call.instruction]
  for (const m of call.materials) {
    if ('text' in m) {
      parts.push(`<材料 name="${m.name}">\n${m.text}\n</材料>`)
      continue
    }
    if (call.access === 'none' || call.access === 'search' || !call.workdir || !inside(call.workdir, m.file))
      throw new Error(`claude-cli: file material ${m.name} must be inside workdir with access read/write`)
    parts.push(`<ファイル name="${m.name}" path="${resolve(m.file)}" mime="${m.mime}" />`)
  }
  return parts.join('\n\n')
}

// 未ログイン・ログインの期限切れは api_error_status が null で、文でしか分からない（実機の 2.1.309 / 2.1.226。6.1.2 (7)）
// ponytail: CLI の文言に頼る。文言が変われば ただの unavailable に落ちる（止まる側に倒れる）。状態の欄が出たらそちらへ
const loginFailed = (j: Record<string, unknown>) =>
  j.terminal_reason === 'api_error' &&
  typeof j.result === 'string' &&
  /Not logged in|Failed to authenticate|\/login/.test(j.result)

// 結果の器（type: 'result' の JSON）。読めなければ undefined
function parseResult(out: string): Record<string, unknown> | undefined {
  try {
    const r: unknown = JSON.parse(out)
    return typeof r === 'object' && r !== null && (r as { type?: unknown }).type === 'result'
      ? (r as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// JSON の費用。欠け・数でない・負は null（6.1.2 (5)）
function yenOf(j: Record<string, unknown>, rate: number): number | null {
  const usd = j.total_cost_usd
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd * rate : null
}

// 結果のファイル（9.4 (7)）: 1 行目はホストが起こす前に書く為替、2 行目から CLI の標準出力そのまま
const header = (rate: number) => `${JSON.stringify({ usdJpy: rate })}\n`
const body = (text: string) => text.slice(text.indexOf('\n') + 1)

// 再起動の精算で読む額。ファイルが無い・書きかけ・壊れている・費用が読めないなら null（予約の額で確定する）
export function resultYen(file: string): number | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  let rate: unknown
  try {
    rate = JSON.parse(text.slice(0, nl)).usdJpy
  } catch {
    return null
  }
  if (!(typeof rate === 'number' && Number.isFinite(rate) && rate > 0)) return null
  const j = parseResult(body(text))
  return j ? yenOf(j, rate) : null
}

// CLI の JSON → Reply（6.1.2 (5) の表を上から）
function toReply(out: string, code: number | null, rate: number, log: (l: string) => void): Reply {
  const j = parseResult(out)
  if (!j) throw new Error(`claude-cli: no result JSON (exit ${code}): ${out.slice(0, 500)}`)
  const costYen = yenOf(j, rate)
  const ok = j.subtype === 'success' && j.is_error === false && typeof j.result === 'string' && code === 0
  if (ok) return { text: j.result as string, costYen }
  log(
    `claude-cli: ${String(j.subtype)} status=${String(j.api_error_status)} exit=${code}: ${JSON.stringify(j.result ?? j.errors ?? '').slice(0, 500)}`,
  )
  if (j.subtype === 'error_max_budget_usd') return { fail: 'budget', costYen }
  const status = j.api_error_status
  if (status === 401 || status === 403 || loginFailed(j)) return { fail: 'unavailable', why: 'auth_expired', costYen }
  if (status === 429 || status === 529) return { fail: 'unavailable', why: 'rate_limited', costYen }
  return { fail: 'unavailable', costYen }
}

// 作業場のファイル → 大きさと更新時刻。差分で「今回書いたもの」を出す（6.1.2 (6)）
async function snapshot(dir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const full = join(e.parentPath, e.name)
    const s = await stat(full)
    m.set(relative(dir, full).split(sep).join('/'), `${s.size}:${s.mtimeMs}`)
  }
  return m
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const posix = process.platform !== 'win32'

// POSIX はプロセスグループごと（6.1.2 (2)）
function kill(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0): boolean {
  try {
    process.kill(-pid, sig)
    return true
  } catch {
    return false // ESRCH: グループが空
  }
}

// Windows はプロセスツリーごと。終わるまで待ち、起こせない・失敗したら log に書く（例外にしない）
function treeKill(pid: number, log: (l: string) => void): Promise<void> {
  const exe = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill'
  return new Promise((done) => {
    const k = spawn(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    k.on('error', (e) => {
      log(`claude-cli: taskkill failed: ${e.message}`)
      done()
    })
    k.on('exit', (code) => {
      if (code !== 0) log(`claude-cli: taskkill exit ${code}`)
      done()
    })
  })
}

// ホストが落ちたら子のグループを消す見張り（8.9 (6)）。握ったパイプが閉じる = ホストが死んだ
// dash の kill は -- を受けないので、負の数でグループを指す
const guard = (pgid: number) => {
  const g = spawn('/bin/sh', ['-c', 'trap "" INT TERM HUP; read _; kill -9 -"$1"', 'guard', String(pgid)], {
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  g.stdin.on('error', () => {})
  g.on('error', () => {})
  return g
}

type Run = {
  cwd: string
  env: Record<string, string>
  input: string
  signal: AbortSignal
  grace: number
  outFile: string
}

// 子孫まで終わってから決着する。止められたら signal.reason で拒否
async function runChild(
  argv: string[],
  o: Run,
  log: (l: string) => void,
): Promise<{ out: string; code: number | null }> {
  const [cmd = '', ...args] = argv
  // 標準出力は結果のファイルへ直に。ホストが落ちても子は最後まで書ける（9.4 (7)）
  const fd = openSync(o.outFile, 'a')
  const child = (() => {
    try {
      // 記述子を渡す stdio は型の重ね定義に無いので、形をここで決める
      return spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env,
        detached: posix,
        windowsHide: true,
        stdio: ['pipe', fd, 'pipe'],
      }) as ChildProcessByStdio<Writable, null, Readable>
    } finally {
      closeSync(fd) // 子は自分の写しを持つ
    }
  })()
  const closed = once(child, 'close').catch(() => undefined)
  const watch = posix && child.pid ? guard(child.pid) : undefined
  const err: Buffer[] = []
  child.stderr.on('data', (b: Buffer) => err.push(b))
  child.stdin.on('error', () => {}) // 読まずに終わった子への EPIPE
  child.stdin.end(o.input, 'utf8')

  let timer: NodeJS.Timeout | undefined
  let killing: Promise<void> | undefined
  const stop = () => {
    const pid = child.pid
    if (!pid) return
    // Windows は穏やかに止める手段が無いので、先頭が生きているうちにツリーごと終わらせる
    if (!posix) {
      killing = treeKill(pid, log)
      return
    }
    kill(pid, 'SIGTERM')
    timer = setTimeout(() => kill(pid, 'SIGKILL'), o.grace)
  }
  o.signal.addEventListener('abort', stop, { once: true })
  if (o.signal.aborted) stop()

  try {
    const [code] = (await once(child, 'exit')) as [number | null]
    // 正常に終わっても残った子はグループごと消し、空になるまで待つ
    if (posix && child.pid) {
      kill(child.pid, 'SIGKILL')
      let i = 0
      while (kill(child.pid, 0) && ++i < 100) await sleep(20)
      if (i >= 100) log(`claude-cli: process group ${child.pid} still alive`)
    }
    if (killing) await Promise.race([killing, sleep(o.grace + 5000)])
    // 子孫が標準出力を握ったままでも待ち続けない
    await Promise.race([closed, sleep(2000)])
    if (o.signal.aborted) throw o.signal.reason
    if (code !== 0) log(`claude-cli: exit ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`)
    return { out: body(readFileSync(o.outFile, 'utf8')), code }
  } finally {
    watch?.kill('SIGKILL')
    clearTimeout(timer)
    o.signal.removeEventListener('abort', stop)
  }
}

export function createClaudeCli(opts: Opts): Backend {
  const log = opts.log ?? ((line: string) => console.error(line))
  return async (call) => {
    const rate = opts.usdJpy()
    if (!(Number.isFinite(rate) && rate > 0)) throw new Error(`claude-cli: bad usdJpy ${rate}`)
    // 起こさなかった呼び出しは費用 0（予約の全額で数えない）
    const why = opts.blocked?.()
    if (why) {
      log(`claude-cli: not started: ${why}`)
      return { fail: 'unavailable', costYen: 0 }
    }
    const input = stdinText(call)
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      call.model,
      '--max-budget-usd',
      String(call.maxYen / rate),
      '--no-session-persistence',
      '--tools',
      TOOLS[call.access],
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
    ]
    // none・search は空の一時ディレクトリで起こす（cwd から上の CLAUDE.md を読ませない）
    const scratch = call.access === 'none' || call.access === 'search'
    const cwd = scratch ? await mkdtemp(join(tmpdir(), 'libretto-')) : call.workdir
    if (!cwd) throw new Error(`claude-cli: access ${call.access} needs workdir`)
    let boxed: Awaited<ReturnType<Sandbox['prepare']>> | undefined
    if (call.access === 'write' && opts.sandbox) {
      try {
        boxed = await opts.sandbox.prepare(cwd, args, opts.env ?? process.env)
      } catch (e) {
        log(`claude-cli: not started: ${(e as Error).message}`)
        return { fail: 'unavailable', costYen: 0 }
      }
    }
    try {
      const before = call.access === 'write' ? await snapshot(cwd) : undefined
      const argv = boxed?.argv ?? [...(opts.command ?? resolveClaude(opts.env)), ...args]
      const env = boxed?.env ?? allowedEnv(opts.env ?? process.env)
      // 為替は起こす前に書く。精算（invoke）が済むまでファイルは消さない（9.4 (7)）
      const outFile = callFile(opts.callsDir, call.callId)
      writeFileSync(outFile, header(rate), { mode: 0o600 })
      const { out, code } = await runChild(
        argv,
        { cwd, env, input, signal: call.signal, grace: opts.killGraceMs ?? 5000, outFile },
        log,
      )
      const reply = toReply(out, code, rate, log)
      if (!before || !('text' in reply)) return reply
      const after = await snapshot(cwd)
      return { ...reply, files: [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k) }
    } finally {
      await boxed?.cleanup()
      if (scratch) await rm(cwd, { recursive: true, force: true })
    }
  }
}
