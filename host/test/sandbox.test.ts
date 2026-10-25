import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createClaudeCli } from '../src/model/claude-cli.ts'
import type { Call } from '../src/model/invoke.ts'
import { setKey } from '../src/model/keys.ts'
import {
  checkSandbox,
  checkSignIn,
  createSandbox,
  denyRules,
  homeNamesOf,
  MIN_CLAUDE,
  rulePath,
  type SandboxCheck,
  SRT_DOMAINS,
  srtSettings,
} from '../src/model/sandbox.ts'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const FAKE_SRT = [process.execPath, fileURLToPath(new URL('./fake-srt.mjs', import.meta.url))]
const CRASH_HOST = fileURLToPath(new URL('./fixtures/crash-host.ts', import.meta.url))
const win = process.platform === 'win32'
let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'libretto-sandbox-test-')))
})

const under = (root: string, p: string) => {
  const r = relative(resolve(root), resolve(p))
  return r === '' || (r.split(sep)[0] !== '..' && !r.startsWith('/'))
}
const strong: SandboxCheck = { isolation: 'strong', claudeOk: true }
const waitFor = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('srtSettings（8.3・8.6・8.9 (3)）', () => {
  const user = '/home/u'
  const home = '/home/u/libretto'
  const work = `${home}/cases/c1/work`
  const s = srtSettings({
    home,
    userHome: user,
    configDir: '/opt/claude-config',
    work,
    tmp: '/tmp/libretto-maker-x',
    claude: '/home/u/.local/share/claude/versions/2.1.310',
    node: '/usr/bin/node',
    srtVendor: '/home/u/app/node_modules/@anthropic-ai/sandbox-runtime/vendor',
    credentials: '/home/u/.claude/.credentials.json',
  })
  const readable = (p: string) =>
    !s.filesystem.denyRead.some((d) => under(d, p)) || s.filesystem.allowRead.some((a) => under(a, p))

  it('8.6 の「読めない」列のパスは、どれも denyRead の下にあり allowRead の下に無い', () => {
    for (const p of [
      `${home}/cases/c1/versions/01/draft-01.md`,
      `${home}/cases/c1/versions/01/manifest.json`,
      `${home}/cases/c1/checks/checks.json`,
      `${home}/cases/c1/review-01-a.json`,
      `${home}/cases/c1/facts.json`,
      `${home}/cases/c1/undecided.json`,
      `${home}/cases/c1/jobs/作り手-1.json`,
      `${home}/cases/c1/maker.json`,
      `${home}/cases/c2/work/brief.md`,
      `${home}/libretto.db`,
      `${home}/libretto.db-wal`,
      `${home}/libretto.db-shm`,
      `${home}/.env.local`,
      `${home}/api-keys.json`,
      `${home}/calls/x.json`,
      `${user}/.ssh/id_ed25519`,
      `${user}/.claude/projects/x.jsonl`,
      '/opt/claude-config/projects/x.jsonl',
    ])
      expect(readable(p), p).toBe(false)
  })

  it('作業場は読めて書ける。書けるのは作業場と一時だけ。網は 3 つだけ', () => {
    expect(readable(`${work}/brief.md`)).toBe(true)
    expect(readable(`${user}/.claude/.credentials.json`)).toBe(true)
    expect(s.filesystem.allowWrite).toEqual([work, '/tmp/libretto-maker-x'])
    expect(s.network.allowedDomains).toEqual(SRT_DOMAINS)
    expect(s).not.toHaveProperty('ripgrep')
  })

  it('npm で入れた claude（JS）はパッケージのディレクトリを読めるようにする', () => {
    const pkg = '/home/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code'
    const r = srtSettings({
      home,
      userHome: user,
      configDir: `${user}/.claude`,
      work,
      tmp: '/t',
      claude: `${pkg}/cli.js`,
      node: '/n',
      srtVendor: '/v',
    })
    expect(r.filesystem.allowRead).toContain(pkg)
  })

  it('rg が無く claude が単体なら、claude を ripgrep として起こす', () => {
    const r = srtSettings({
      home,
      userHome: user,
      configDir: `${user}/.claude`,
      work,
      tmp: '/t',
      claude: '/c',
      node: '/n',
      srtVendor: '/v',
      rgArgv0: true,
    })
    expect(r.ripgrep).toEqual({ command: '/c', argv0: 'rg' })
    expect(r.filesystem.allowRead).not.toContain(undefined)
  })
})

describe('denyRules（8.5・8.9 (4)）', () => {
  it('絶対パスは // で始め、Windows のドライブは //c/… に直す', () => {
    expect(rulePath('/home/u/libretto')).toBe('//home/u/libretto')
    expect(rulePath('C:\\Users\\u\\libretto')).toBe('//c/Users/u/libretto')
  })

  it('8.6 の読めないものを全部覆う', () => {
    const r = denyRules('/home/u/libretto', '/home/u/.claude')
    for (const x of [
      'Read(//home/u/libretto/cases/**/checks/**)',
      'Read(//home/u/libretto/cases/**/review-*)',
      'Read(//home/u/libretto/cases/**/facts*)',
      'Read(//home/u/libretto/cases/**/undecided*)',
      'Read(//home/u/libretto/cases/**/jobs/**)',
      'Read(//home/u/libretto/cases/**/versions/**)',
      'Read(//home/u/libretto/libretto.db*)',
      'Read(//home/u/libretto/.env*)',
      'Read(//home/u/libretto/api-keys.json)',
      'Read(//home/u/libretto/calls/**)',
      'Read(//home/u/.claude/**)',
    ])
      expect(r).toContain(x)
    expect(r.every((x) => x.startsWith('Read(//'))).toBe(true)
  })
})

describe('createSandbox.prepare（8.9 (1)(3)(4)）', () => {
  const work = () => {
    const w = join(dir, 'home', 'cases', 'c1', 'work')
    mkdirSync(w, { recursive: true })
    return w
  }

  it('強い隔離: srt の後に -- を置き、claude の実体・旗・拒否規則の順に並べる', async () => {
    const box = createSandbox({
      home: join(dir, 'home'),
      claude: [process.execPath, FAKE],
      srt: FAKE_SRT,
      check: () => strong,
    })
    const p = await box.prepare(work(), ['-p', '--tools', ''], { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x' })
    const at = p.argv.indexOf('--')
    expect(p.argv.slice(0, at)).toEqual([...FAKE_SRT, '--settings', expect.stringMatching(/srt\.json$/)])
    expect(p.argv.slice(at + 1)).toEqual([
      realpathSync(process.execPath),
      FAKE,
      '-p',
      '--tools',
      '',
      '--settings',
      expect.stringMatching(/settings\.json$/),
    ])
    const srt = JSON.parse(readFileSync(p.argv[at - 1] ?? '', 'utf8'))
    expect(srt.filesystem.allowWrite[0]).toBe(work())
    const deny = JSON.parse(readFileSync(p.argv.at(-1) ?? '', 'utf8'))
    expect(deny.permissions.deny).toEqual(denyRules(join(dir, 'home'), join(homedir(), '.claude')))
    expect(p.env.CLAUDE_CODE_TMPDIR).toBe(srt.filesystem.allowWrite[1])
    expect(p.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(p.env).not.toHaveProperty('OPENAI_API_KEY')
    await p.cleanup()
    expect(existsSync(p.env.CLAUDE_CODE_TMPDIR ?? '')).toBe(false)
  })

  it('JS の claude は許した Node で起こす（shebang の node を sandbox の中で探さない）', async () => {
    const box = createSandbox({ home: join(dir, 'home'), claude: [FAKE], srt: FAKE_SRT, check: () => strong })
    const p = await box.prepare(work(), ['-p'], { PATH: '/usr/bin' })
    expect(p.argv.slice(p.argv.indexOf('--') + 1, p.argv.indexOf('--') + 4)).toEqual([
      realpathSync(process.execPath),
      realpathSync(FAKE),
      '-p',
    ])
    await p.cleanup()
  })

  it('CLAUDE_CONFIG_DIR がホームの外でも、その置き場を拒否してログイン情報だけを戻す', async () => {
    const config = join(dir, 'claude-config')
    mkdirSync(config)
    writeFileSync(join(config, '.credentials.json'), '{}')
    const box = createSandbox({
      home: join(dir, 'home'),
      claude: [process.execPath, FAKE],
      srt: FAKE_SRT,
      check: () => strong,
    })
    const p = await box.prepare(work(), [], { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: config })
    const at = p.argv.indexOf('--')
    const srt = JSON.parse(readFileSync(p.argv[at - 1] ?? '', 'utf8'))
    expect(srt.filesystem.denyRead).toContain(config)
    expect(srt.filesystem.allowRead).toContain(join(config, '.credentials.json'))
    const deny = JSON.parse(readFileSync(p.argv.at(-1) ?? '', 'utf8'))
    expect(deny.permissions.deny).toContain(`Read(${rulePath(config)}/**)`)
    expect(p.env).not.toHaveProperty('TMPDIR')
    await p.cleanup()
  })

  it('弱い隔離: srt で包まず、拒否規則だけを渡す', async () => {
    const box = createSandbox({
      home: join(dir, 'home'),
      claude: ['claude.exe'],
      check: () => ({ isolation: 'weak', reason: 'windows', claudeOk: true }),
    })
    const p = await box.prepare(work(), ['-p'], {})
    expect(p.argv).toEqual(['claude.exe', '-p', '--settings', expect.stringMatching(/settings\.json$/)])
    await p.cleanup()
  })

  it('壊れた隔離では作り手を起こさない。費用 0 の unavailable（8.9 (5)）', async () => {
    const box = createSandbox({
      home: join(dir, 'home'),
      claude: [process.execPath, FAKE],
      check: () => ({ isolation: 'broken', reason: 'network', claudeOk: true }),
    })
    await expect(box.prepare(work(), [], {})).rejects.toThrow(/broken/)
    const w = work()
    const backend = createClaudeCli({ usdJpy: () => 150, callsDir: dir, sandbox: box, log: () => {} })
    const reply = await backend(makerCall(w, { mode: 'write', write: { 'draft-01.md': 'x' } }))
    expect(reply).toEqual({ fail: 'unavailable', costYen: 0 })
    expect(existsSync(join(w, 'draft-01.md'))).toBe(false)
  })
})

const makerCall = (workdir: string, control: object): Call => ({
  callId: randomUUID(),
  role: '作り手',
  caseId: 'c1',
  instruction: JSON.stringify(control),
  materials: [],
  access: 'write',
  workdir,
  family: 'claude',
  model: 'claude-opus-5-5',
  maxYen: 150,
  signal: new AbortController().signal,
})

describe('claude-cli と srt（8.9 (2)）', () => {
  it('作り手は srt を通して起こし、書いたファイルを返す。拒否規則の旗が claude に届く', async () => {
    const w = join(dir, 'work')
    mkdirSync(w)
    const box = createSandbox({ home: dir, claude: [process.execPath, FAKE], srt: FAKE_SRT, check: () => strong })
    const backend = createClaudeCli({ usdJpy: () => 150, callsDir: dir, sandbox: box, log: () => {} })
    const record = join(dir, 'record.json')
    const reply = await backend(makerCall(w, { mode: 'write', write: { 'draft-01.md': '本文' }, record }))
    expect(reply).toMatchObject({ text: 'ok', files: ['draft-01.md'] })
    const argv = (JSON.parse(readFileSync(record, 'utf8')) as { argv: string[] }).argv
    expect(argv.slice(-2)).toEqual(['--settings', expect.stringMatching(/settings\.json$/)])
  })

  it('作り手以外は包まない', async () => {
    const box = createSandbox({
      home: dir,
      claude: [process.execPath, FAKE],
      srt: FAKE_SRT,
      check: () => ({ isolation: 'broken', claudeOk: true }),
    })
    const backend = createClaudeCli({
      usdJpy: () => 150,
      callsDir: dir,
      command: [process.execPath, FAKE],
      sandbox: box,
      log: () => {},
    })
    const reply = await backend({ ...makerCall(dir, { mode: 'ok' }), role: '話し相手', access: 'none' })
    expect(reply).toMatchObject({ text: 'ok' })
  })

  it('版が下限未満なら Claude を起こさない。費用 0', async () => {
    const record = join(dir, 'record.json')
    const backend = createClaudeCli({
      usdJpy: () => 150,
      callsDir: dir,
      command: [process.execPath, FAKE],
      blocked: () => 'old',
      log: () => {},
    })
    const reply = await backend({ ...makerCall(dir, { mode: 'ok', record }), access: 'none' })
    expect(reply).toEqual({ fail: 'unavailable', costYen: 0 })
    expect(existsSync(record)).toBe(false)
  })
})

describe('checkSandbox（8.9 (5)）', () => {
  // 版を出すだけの偽の claude
  const versionScript = (v: string) => {
    const f = join(dir, `claude-${v}.mjs`)
    writeFileSync(f, `console.log('${v} (Claude Code)')`)
    return [process.execPath, f]
  }
  // bwrap・socat・rg の名前だけある PATH
  const toolsPath = () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const t of ['bwrap', 'socat', 'rg']) {
      writeFileSync(join(bin, t), '#!/bin/sh\nexit 0\n')
      chmodSync(join(bin, t), 0o755)
    }
    return bin
  }
  const base = (over: Partial<Parameters<typeof checkSandbox>[0]> = {}) =>
    checkSandbox({
      home: join(dir, 'home'),
      claude: versionScript('2.1.310'),
      srt: FAKE_SRT,
      timeoutMs: 10_000,
      ...over,
    })

  it('版は隔離と独立に読む。素の Windows は弱い隔離でも下限を見る', async () => {
    expect(await base({ platform: 'win32', claude: versionScript('2.1.226') })).toEqual({
      isolation: 'weak',
      reason: 'windows',
      claudeVersion: '2.1.226',
      claudeOk: false,
    })
    expect(await base({ platform: 'win32', claude: versionScript(MIN_CLAUDE) })).toMatchObject({ claudeOk: true })
    expect(await base({ platform: 'win32', claude: [process.execPath, '-e', 'process.exit(3)'] })).toEqual({
      isolation: 'weak',
      reason: 'windows',
      claudeOk: false,
    })
  })

  it.skipIf(win)('Linux で道具が無い・名前空間が作れないときは弱い隔離', async () => {
    expect(await base({ platform: 'linux', env: { PATH: join(dir, 'empty') } })).toMatchObject({
      isolation: 'weak',
      reason: 'missing:bwrap',
    })
    expect(await base({ platform: 'linux', env: { PATH: toolsPath() }, bwrapWorks: async () => false })).toMatchObject({
      isolation: 'weak',
      reason: 'userns',
      claudeOk: true,
    })
  })

  it.skipIf(win)('道具があるのに srt が動かない・網に出られないときは壊れた隔離', async () => {
    const env = { PATH: toolsPath() }
    const failing = join(dir, 'fail-srt.mjs')
    writeFileSync(failing, "console.error('bwrap: setting up uid map: Permission denied'); process.exit(1)")
    expect(
      await base({ platform: 'linux', env, bwrapWorks: async () => true, srt: [process.execPath, failing] }),
    ).toMatchObject({ isolation: 'broken', reason: expect.stringMatching(/^srt:bwrap/) })
    // proxy が無い → CONNECT できない
    expect(await base({ platform: 'linux', env, bwrapWorks: async () => true })).toMatchObject({
      isolation: 'broken',
      reason: 'network',
    })
  })

  it.skipIf(win)('srt の中から proxy に CONNECT できれば強い隔離', async () => {
    const proxy = createServer()
    const seen: string[] = []
    proxy.on('connect', (req, socket) => {
      seen.push(req.url ?? '')
      socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
    const { port } = proxy.address() as { port: number }
    try {
      const r = await base({
        platform: 'linux',
        env: { PATH: toolsPath(), HTTPS_PROXY: `http://127.0.0.1:${port}` },
        bwrapWorks: async () => true,
      })
      expect(r).toEqual({ isolation: 'strong', claudeVersion: '2.1.310', claudeOk: true })
      expect(seen).toEqual(['api.anthropic.com:443'])
    } finally {
      proxy.close()
    }
  })
})

describe.skipIf(win)('ホストが落ちたら作り手が残らない（8.9 (6)）', () => {
  it('ホストを SIGKILL すると、見張りが CLI と孫まで消す', async () => {
    const pidFile = join(dir, 'pids.json')
    const host = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', CRASH_HOST, FAKE, dir, JSON.stringify({ mode: 'hang', pidFile })],
      { stdio: 'ignore' },
    )
    await waitFor(() => existsSync(pidFile), 10_000)
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { leader: number; grandchild: number }
    expect(alive(pids.leader) && alive(pids.grandchild)).toBe(true)
    host.kill('SIGKILL')
    await waitFor(() => !alive(pids.leader) && !alive(pids.grandchild))
    expect(alive(pids.leader)).toBe(false)
    expect(alive(pids.grandchild)).toBe(false)
  }, 20_000)
})

describe('API キーのファイルと隔離（6.1.3 (4)）', () => {
  it('keys.ts が実際に書くファイルは、作り手の denyRead と拒否規則で塞がれている', () => {
    const KEY = 'sk-test-linking-0123456789'
    const home = join(dir, 'libretto')
    mkdirSync(home)
    setKey(home, 'openai', KEY)
    // 鍵の値を含むファイルを、ホームの下から実際に探す（keys.ts の置き場が変わっても見つける）
    const found = readdirSync(home, { recursive: true, encoding: 'utf8' })
      .map((f) => join(home, f))
      .filter((p) => statSync(p).isFile() && readFileSync(p, 'utf8').includes(KEY))
    expect(found).toHaveLength(1)
    const file = found[0] as string
    const s = srtSettings({
      home,
      userHome: dir,
      configDir: join(dir, '.claude'),
      work: join(home, 'cases', 'c1', 'work'),
      tmp: join(dir, 'tmp'),
      claude: join(dir, 'claude'),
      node: process.execPath,
      srtVendor: join(dir, 'vendor'),
    })
    expect(s.filesystem.denyRead.some((d) => under(d, file))).toBe(true)
    expect(s.filesystem.allowRead.some((a) => under(a, file))).toBe(false)
    expect(denyRules(home, join(dir, '.claude'))).toContain(`Read(${rulePath(file)})`)
  })
})

describe('隔離の点検の対照と、ホームに出てよい名前（8.10 (4)）', () => {
  const strongCheck: SandboxCheck = { isolation: 'strong', claudeOk: true }
  it('対照: strong は allowRead に足し、どの水準でも CLI の拒否規則を渡さない', async () => {
    const w = join(dir, 'home', 'cases', '_probe', 'work')
    const checks = join(dir, 'home', 'cases', '_probe', 'checks')
    mkdirSync(w, { recursive: true })
    mkdirSync(checks, { recursive: true })
    const box = createSandbox({
      home: join(dir, 'home'),
      claude: [process.execPath, FAKE],
      srt: FAKE_SRT,
      check: () => strongCheck,
      reopen: [checks],
    })
    const p = await box.prepare(w, ['-p'], { PATH: '/usr/bin' })
    const at = p.argv.indexOf('--')
    const srt = JSON.parse(readFileSync(p.argv[at - 1] ?? '', 'utf8'))
    expect(srt.filesystem.allowRead).toContain(checks)
    expect(p.argv.slice(at + 1)).toEqual([realpathSync(process.execPath), FAKE, '-p'])
    await p.cleanup()
    const weak = createSandbox({
      home: join(dir, 'home'),
      claude: ['claude.exe'],
      check: () => ({ isolation: 'weak', reason: 'windows', claudeOk: true }),
      reopen: [checks],
    })
    const q = await weak.prepare(w, ['-p'], {})
    expect(q.argv).toEqual(['claude.exe', '-p'])
    await q.cleanup()
  })

  it.skipIf(win)(
    'present: 同じ起こし方で見て、無いものと文字デバイス（/dev/null のかぶせ物）を除く。strong でなければ全部',
    async () => {
      const file = join(dir, 'real')
      writeFileSync(file, 'x')
      const paths = [file, join(dir, 'absent'), '/dev/null']
      const w = join(dir, 'w')
      mkdirSync(w)
      const box = createSandbox({ home: join(dir, 'home'), claude: [FAKE], srt: FAKE_SRT, check: () => strong })
      expect(await box.present(w, paths)).toEqual([file])
      const weak = createSandbox({
        home: join(dir, 'home'),
        claude: [FAKE],
        check: () => ({ isolation: 'weak', reason: 'userns', claudeOk: true }),
      })
      expect(await weak.present(w, paths)).toEqual(paths)
    },
  )

  it('ホームの下の allowRead の一番上の名前と .claude.json だけ', () => {
    const h = join(dir, 'u')
    expect(
      homeNamesOf(
        [
          join(h, '.claude', '.credentials.json'),
          join(h, '.local', 'share', 'claude'),
          '/usr/bin/node',
          join(dir, 'x'),
        ],
        h,
      ).sort(),
    ).toEqual(['.claude', '.claude.json', '.local'])
  })
})

describe('checkSignIn（6.13 (2)）', () => {
  // claude の代わりに、auth status の JSON を出す node（後ろに付く auth status は -e では読まれない）
  const say = (out: string) => [process.execPath, '-e', `process.stdout.write(${JSON.stringify(out)})`]
  it('loggedIn を返し、読めなければ undefined（確かめられない）', async () => {
    expect(await checkSignIn(say('{"loggedIn":true}'))).toBe(true)
    expect(await checkSignIn(say('{"loggedIn":false}'))).toBe(false)
    expect(await checkSignIn(say('error: unknown command'))).toBeUndefined()
    expect(await checkSignIn(['libretto-no-such-claude'])).toBeUndefined()
  })
})
