import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/ledger/db.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { allowedEnv, createClaudeCli, resolveClaude, stdinText } from '../src/model/claude-cli.ts'
import { type Call, createInvoke } from '../src/model/invoke.ts'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const win = process.platform === 'win32'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'libretto-cli-test-'))
})

const backend = (over: Partial<Parameters<typeof createClaudeCli>[0]> = {}) =>
  createClaudeCli({
    usdJpy: () => 150,
    callsDir: dir,
    command: [process.execPath, FAKE],
    killGraceMs: 200,
    log: () => {},
    ...over,
  })

// 1 行目が偽の CLI への指示（fake-claude.mjs）
const call = (control: object, over: Partial<Call> = {}): Call => ({
  callId: randomUUID(),
  role: '下書き役・依頼書',
  caseId: 'c1',
  instruction: JSON.stringify(control),
  materials: [],
  access: 'none',
  family: 'claude',
  model: 'claude-opus-5-5',
  maxYen: 150,
  signal: new AbortController().signal,
  ...over,
})

type Record = { argv: string[]; env: NodeJS.ProcessEnv; cwd: string; input: string }
const record = () => JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as Record
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (f: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !f(); ) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('claude-cli: 起こし方（6.1.2 (1)(4)）', () => {
  it('旗の組・空文字の引数・許可した環境変数だけ・空の一時 cwd・標準入力の材料', async () => {
    const env = { PATH: process.env.PATH, LANG: 'ja_JP.UTF-8', HOME: '/h', OPENAI_API_KEY: 'sk-x', SECRET: 's' }
    const r = await backend({ env })(
      call(
        { mode: 'ok', record: join(dir, 'record.json'), cost: 0.01, text: '本文' },
        { materials: [{ name: '依頼', text: 'ここに材料' }] },
      ),
    )
    expect(r).toEqual({ text: '本文', costYen: 1.5 })
    const rec = record()
    expect(rec.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--max-budget-usd',
      '1',
      '--no-session-persistence',
      '--tools',
      '',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
    ])
    expect(rec.env.LANG).toBe('ja_JP.UTF-8')
    expect(rec.env.OPENAI_API_KEY).toBeUndefined()
    expect(rec.env.SECRET).toBeUndefined()
    expect(rec.input).toContain('<材料 name="依頼">\nここに材料\n</材料>')
    // none の cwd は呼び出しごとの一時ディレクトリで、終わったら消える
    expect(rec.cwd).not.toBe(process.cwd())
    expect(existsSync(rec.cwd)).toBe(false)
  })

  it('write は空白と日本語を含む作業場で起こし、今回書いたファイルだけを files に返す', async () => {
    const work = join(dir, '作業 場')
    mkdirSync(work)
    writeFileSync(join(work, 'draft-01.md'), '前の版')
    const r = await backend()(
      call(
        {
          mode: 'write',
          record: join(dir, 'record.json'),
          cost: 0,
          write: { 'draft-02.md': '新しい版', 'draft-02.done': '{}' },
        },
        { access: 'write', workdir: work },
      ),
    )
    expect(r).toMatchObject({ text: 'ok', costYen: 0 })
    expect('files' in r && r.files?.sort()).toEqual(['draft-02.done', 'draft-02.md'])
    const rec = record()
    expect(realpathSync(rec.cwd)).toBe(realpathSync(work))
    expect(rec.argv[rec.argv.indexOf('--tools') + 1]).toBe('Read,Write,Edit,Glob,Grep')
  })

  it('read の道具は読むものだけ。workdir が無ければ起こさない', async () => {
    await backend()(call({ mode: 'ok', record: join(dir, 'record.json') }, { access: 'read', workdir: dir }))
    expect(record().argv[record().argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    await expect(backend()(call({ mode: 'ok' }, { access: 'read' }))).rejects.toThrow(/needs workdir/)
  })

  it('search の道具は WebSearch だけ（WebFetch は渡さない）。空の一時ディレクトリで起こす（6.3.3 (2)）', async () => {
    await backend()(call({ mode: 'ok', record: join(dir, 'record.json') }, { access: 'search', workdir: dir }))
    const rec = record()
    expect(rec.argv[rec.argv.indexOf('--tools') + 1]).toBe('WebSearch')
    // 呼び出しの後に消える一時ディレクトリ（作業場ではない）
    expect(rec.cwd).not.toBe(dir)
    expect(existsSync(rec.cwd)).toBe(false)
  })

  it('ファイルの材料は read / write で作業場の中にあるときだけ', () => {
    const file = join(dir, 'p.png')
    const m = [{ name: '画像', file, mime: 'image/png' }]
    expect(stdinText({ instruction: 'i', materials: m, access: 'read', workdir: dir })).toContain(
      `<ファイル name="画像" path="${file}" mime="image/png" />`,
    )
    expect(() => stdinText({ instruction: 'i', materials: m, access: 'none' })).toThrow()
    expect(() => stdinText({ instruction: 'i', materials: m, access: 'read', workdir: join(dir, 'sub') })).toThrow()
  })

  it('Windows の環境変数は名前の大小を区別せず許可一覧で拾う', () => {
    const env = {
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      userprofile: 'C:\\Users\\a',
      HOME: '/h',
      OPENAI_API_KEY: 'k',
    }
    expect(allowedEnv(env, 'win32')).toEqual({
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\a',
    })
    expect(allowedEnv(env, 'linux')).toEqual({ HOME: '/h' })
  })

  it.skipIf(!win)('Windows: claude.exe を先に、無ければ npm の claude.cmd の行き先を Node で起こす', () => {
    const npm = join(dir, 'npm')
    mkdirSync(join(npm, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true })
    writeFileSync(
      join(npm, 'claude.cmd'),
      '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    )
    expect(resolveClaude({ PATH: npm })).toEqual([
      process.execPath,
      join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ])
    const exe = join(dir, 'exe')
    mkdirSync(exe)
    writeFileSync(join(exe, 'claude.exe'), '')
    expect(resolveClaude({ PATH: `${npm};${exe}` })).toEqual([join(exe, 'claude.exe')])
  })

  it.skipIf(win)('POSIX は PATH の claude をそのまま起こす', () => {
    expect(resolveClaude()).toEqual(['claude'])
  })
})

describe('claude-cli: JSON → Reply（6.1.2 (5)）', () => {
  it('費用: 欠け・数でない・負は null、0 は 0', async () => {
    const b = backend()
    expect(await b(call({ mode: 'ok' }))).toEqual({ text: 'ok', costYen: null })
    expect(await b(call({ mode: 'ok', cost: 'x' }))).toEqual({ text: 'ok', costYen: null })
    expect(await b(call({ mode: 'ok', cost: -1 }))).toEqual({ text: 'ok', costYen: null })
    expect(await b(call({ mode: 'ok', cost: 0 }))).toEqual({ text: 'ok', costYen: 0 })
  })

  it('予算で止まった・認証切れ・混雑・実行の失敗は JSON から読み、終了コードより先', async () => {
    const b = backend()
    expect(await b(call({ mode: 'budget', cost: 0.02 }))).toEqual({ fail: 'budget', costYen: 3 })
    expect(await b(call({ mode: 'status', status: 401, cost: 0 }))).toEqual({
      fail: 'unavailable',
      why: 'auth_expired',
      costYen: 0,
    })
    expect(await b(call({ mode: 'status', status: 529 }))).toEqual({
      fail: 'unavailable',
      why: 'rate_limited',
      costYen: null,
    })
    expect(await b(call({ mode: 'error', cost: 0.01 }))).toEqual({ fail: 'unavailable', costYen: 1.5 })
  })

  it('未ログイン・ログインの期限切れは api_error_status が null でも auth_expired', async () => {
    const b = backend()
    for (const text of [
      'Not logged in · Please run /login',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    ])
      expect(await b(call({ mode: 'nologin', text, cost: 0 }))).toEqual({
        fail: 'unavailable',
        why: 'auth_expired',
        costYen: 0,
      })
    expect(await b(call({ mode: 'nologin', text: 'Overloaded' }))).toEqual({ fail: 'unavailable', costYen: null })
  })

  it('JSON が成功でも終了コードが 0 でなければ成功にしない', async () => {
    expect(await backend()(call({ mode: 'exit-mismatch' }))).toEqual({ fail: 'unavailable', costYen: null })
  })

  it('途中で切れた出力（外側の JSON の破損）と、起こせない命令は例外', async () => {
    await expect(backend()(call({ mode: 'partial' }))).rejects.toThrow(/no result JSON/)
    await expect(backend({ command: [join(dir, 'no-such-claude')] })(call({ mode: 'ok' }))).rejects.toThrow()
  })
})

describe('claude-cli: 止めたときの終わり（6.1.2 (2)）', () => {
  it('終了要求を無視する CLI と子も、決着の前に全部終わっている', async () => {
    const ac = new AbortController()
    const pidFile = join(dir, 'pids.json')
    const pending = backend()(call({ mode: 'hang', pidFile }, { signal: ac.signal }))
    await waitFor(() => existsSync(pidFile))
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { leader: number; grandchild: number }
    ac.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow('stopped')
    expect(alive(pids.leader)).toBe(false)
    expect(alive(pids.grandchild)).toBe(false)
  })

  it.skipIf(win)('POSIX: 正常に終わった CLI が残した子もグループごと消す', async () => {
    const pidFile = join(dir, 'pids.json')
    expect(await backend()(call({ mode: 'linger', pidFile }))).toMatchObject({ text: 'ok' })
    const { grandchild } = JSON.parse(readFileSync(pidFile, 'utf8')) as { grandchild: number }
    expect(alive(grandchild)).toBe(false)
  })

  it('invoke は止めたあと、プロセスが終わりきってから stopped を返す', async () => {
    const ledger = new Ledger(openDb(':memory:'), () => new Date('2026-10-23T03:00:00Z'))
    const invoke = createInvoke({
      ledger,
      backends: { claude: backend() },
      caps: () => ({ caseCapYen: null, monthCapYen: null }),
      onCostCap: () => {},
      log: () => {},
    })
    const ac = new AbortController()
    const pidFile = join(dir, 'pids.json')
    const pending = invoke({
      role: '話し相手',
      caseId: '推測',
      instruction: JSON.stringify({ mode: 'hang', pidFile }),
      materials: [],
      access: 'none',
      output: { kind: 'text' },
      limits: { maxYen: 100, timeoutMs: 30_000 },
      signal: ac.signal,
    })
    await waitFor(() => existsSync(pidFile))
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { leader: number; grandchild: number }
    ac.abort()
    expect(await pending).toMatchObject({ ok: false, kind: 'stopped', costYen: 100 })
    expect(alive(pids.leader)).toBe(false)
    expect(alive(pids.grandchild)).toBe(false)
  })
})
