// 作り手を srt で包む（docs/implementation.md 8.3・8.5・8.6・8.9）。案件ごとの設定・CLI の拒否規則・起動時の自己点検
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { allowedEnv } from './claude-cli.ts'

export const SRT_VERSION = '0.0.81' // host/package.json と同じ版（8.9 (1)）
export const MIN_CLAUDE = '2.1.309' // 6.1.2 (7)
export const SRT_DOMAINS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com']

export type Isolation = 'strong' | 'weak' | 'broken'
export type SandboxCheck = { isolation: Isolation; reason?: string; claudeVersion?: string; claudeOk: boolean }

const srtPkg = () => dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json'))
export const srtCommand = () => [process.execPath, join(srtPkg(), 'dist', 'cli.js')]

// POSIX の PATH から探す（sandbox の中の PATH はホームの下を見せないので、実体のパスで起こす）
export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const d of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(d, name)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {}
  }
  return undefined
}

// 単体の実行ファイル（公式のインストーラの claude）か。JS の shim は Node が要る
const isScript = (file: string) => /\.(c|m)?js$/.test(file)

// 実体のパス。~/.local/bin/claude は版のディレクトリへの symlink（8.9 (3)）
const realExe = (cmd: string, env: NodeJS.ProcessEnv) => {
  const p = /[\\/]/.test(cmd) ? cmd : onPath(cmd, env)
  return p && existsSync(p) ? realpathSync(p) : cmd
}

// Claude Code の規則の絶対パスは // で始める。Windows の C:\a\b は //c/a/b（8.9 (4)）
export const rulePath = (p: string) => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  return m ? `//${m[1]?.toLowerCase()}/${m[2]?.replaceAll('\\', '/')}` : `/${p}`
}

// 作り手の CLI に --settings で渡す読み取り拒否（8.5 の並び＋ undecided・jobs・calls。8.9 (4)）。configDir は claude の設定の置き場
export function denyRules(home: string, configDir: string): string[] {
  const h = rulePath(home)
  return [
    `Read(${h}/cases/**/checks/**)`,
    `Read(${h}/cases/**/review-*)`,
    `Read(${h}/cases/**/facts*)`,
    `Read(${h}/cases/**/undecided*)`,
    `Read(${h}/cases/**/jobs/**)`,
    `Read(${h}/cases/**/versions/**)`,
    `Read(${h}/libretto.db*)`,
    `Read(${h}/.env*)`,
    `Read(${h}/api-keys.json)`,
    `Read(${h}/calls/**)`,
    `Read(${rulePath(configDir)}/**)`,
  ]
}

export type SettingsInput = {
  home: string // LIBRETTO_HOME
  userHome: string
  configDir: string // claude の設定の置き場（CLAUDE_CONFIG_DIR か ~/.claude）。ホームの外でも拒否する
  work: string
  tmp: string // 呼び出しごとの一時
  claude: string // claude の実体
  node: string
  srtVendor: string
  credentials?: string | undefined
  rgArgv0?: boolean // rg が無く、claude を ripgrep として起こす
  rg?: string | undefined
  reopen?: string[] // 隔離の点検の対照で開け直すディレクトリ（8.10 (4)）
}

// 案件ごとの srt の設定（8.3・8.9 (3)）。純関数
export function srtSettings(i: SettingsInput) {
  return {
    filesystem: {
      denyRead: [i.userHome, i.home, i.configDir],
      // npm で入れた claude（JS）はパッケージのディレクトリごと要る
      allowRead: [
        i.work,
        isScript(i.claude) ? dirname(i.claude) : i.claude,
        i.node,
        i.srtVendor,
        ...(i.credentials ? [i.credentials] : []),
        i.tmp,
        ...(i.reopen ?? []),
      ],
      allowWrite: [i.work, i.tmp],
      denyWrite: [],
    },
    network: { allowedDomains: SRT_DOMAINS, deniedDomains: [] },
    ...(i.rgArgv0 && { ripgrep: { command: i.rg ?? i.claude, argv0: 'rg' } }),
  }
}

// claude の設定の置き場。子に渡す CLAUDE_CONFIG_DIR があればそれ（8.9 (3)）
const configDirOf = (env: Record<string, string>, userHome: string) =>
  env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude')
const credentialsOf = (configDir: string) => {
  const f = join(configDir, '.credentials.json')
  return existsSync(f) ? f : undefined
}

// srt は bridge の Unix ソケットを os.tmpdir() に作る。長い TMPDIR だと 108 バイトの上限で起動に失敗するので外し、/tmp に作らせる。
// 子の TMPDIR は srt が CLAUDE_CODE_TMPDIR から決める（8.9 (3)）
const withoutTmpdir = ({ TMPDIR: _, ...rest }: Record<string, string>) => rest

export type Prepared = { argv: string[]; env: Record<string, string>; cleanup: () => Promise<void> }

export type SandboxOptions = {
  home: string
  check: () => SandboxCheck
  claude: string[] // claude を起こす命令の先頭
  srt?: string[] // テストで偽の srt に替える
  userHome?: string
  rg?: string // ripgrep として起こす claude の実体。既定は claude 自身（偽の CLI で包む確認用）
  reopen?: string[] // 対照: srt の allowRead に足し、CLI の拒否規則を渡さない（8.10 (4)）
}

// ホームの一覧に出てよい名前: allowRead のうちホームの下にあるものの一番上の名前と、CLI が使い捨てのホームに書く .claude.json（8.4・8.10 (4)）
export function homeNamesOf(allowRead: readonly string[], userHome: string): string[] {
  const top = allowRead
    .map((a) => relative(userHome, a))
    // 別のドライブ（Windows）では relative が絶対パスを返すので、ホームの下ではない
    .filter((x) => x && !x.startsWith('..') && !isAbsolute(x))
    .map((x) => x.split(sep)[0] as string)
  return [...new Set([...top, '.claude.json'])]
}

// 作り手 1 回分の起こし方。args は claude の旗。inner を渡すと claude の代わりにそれを動かす（自己点検の網）
export function createSandbox(o: SandboxOptions) {
  const userHome = o.userHome ?? homedir()
  const envOf = (parentEnv: NodeJS.ProcessEnv) => ({
    ...allowedEnv(parentEnv),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  })
  const settingsFor = (work: string, tmp: string, env: Record<string, string>) => {
    const configDir = configDirOf(env, userHome)
    const claude = realExe(o.claude[0] ?? '', env)
    return srtSettings({
      home: o.home,
      userHome,
      configDir,
      work,
      tmp,
      claude,
      node: realpathSync(process.execPath),
      srtVendor: join(srtPkg(), 'vendor'),
      credentials: credentialsOf(configDir),
      rgArgv0: !onPath('rg', env) && !isScript(o.rg ?? claude),
      rg: o.rg,
      ...(o.reopen && { reopen: o.reopen }),
    })
  }
  return {
    // 隔離の点検でホームの一覧と比べる名前（8.10 (4)）
    homeNames(work: string, parentEnv: NodeJS.ProcessEnv = process.env): string[] {
      return homeNamesOf(settingsFor(work, tmpdir(), envOf(parentEnv)).filesystem.allowRead, userHome)
    },
    async prepare(work: string, args: string[], parentEnv: NodeJS.ProcessEnv, inner?: string[]): Promise<Prepared> {
      const c = o.check()
      if (c.isolation === 'broken') throw new Error(`sandbox: isolation broken (${c.reason})`)
      const tmp = await mkdtemp(join(tmpdir(), 'libretto-maker-'))
      const cleanup = () => rm(tmp, { recursive: true, force: true })
      const env = envOf(parentEnv)
      const deny = join(tmp, 'settings.json')
      writeFileSync(deny, JSON.stringify({ permissions: { deny: denyRules(o.home, configDirOf(env, userHome)) } }), {
        mode: 0o600,
      })
      // 対照は CLI の拒否規則を渡さない（strong でも拒否規則が checks/ を拒むので。8.10 (4)）
      const denyArgs = o.reopen ? [] : ['--settings', deny]
      const [, ...rest] = o.claude
      if (c.isolation === 'weak') return { argv: [...o.claude, ...args, ...denyArgs], env, cleanup }
      const body = settingsFor(work, tmp, env)
      const claude = realExe(o.claude[0] ?? '', env)
      const settings = join(tmp, 'srt.json')
      writeFileSync(settings, JSON.stringify(body), { mode: 0o600 })
      // -- が無いと srt が後ろの --version や --settings を自分の旗として読む（8.9 (1)）
      return {
        argv: [
          ...(o.srt ?? srtCommand()),
          '--settings',
          settings,
          '--',
          // JS の claude は shebang の node を sandbox の中の PATH で探せないので、許した Node で起こす
          ...(inner ?? [
            ...(isScript(claude) ? [realpathSync(process.execPath)] : []),
            claude,
            ...rest,
            ...args,
            ...denyArgs,
          ]),
        ],
        env: { ...withoutTmpdir(env), CLAUDE_CODE_TMPDIR: tmp },
        cleanup,
      }
    },
  }
}
export type Sandbox = ReturnType<typeof createSandbox>

type Ran = { code: number; out: string; err: string }
const run = (argv: string[], env: Record<string, string>, timeout: number, cwd?: string) =>
  new Promise<Ran>((done) => {
    const [cmd = '', ...args] = argv
    execFile(cmd, args, { env, timeout, cwd, windowsHide: true }, (e, out, err) =>
      done({
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        out: String(out),
        err: String(err || e?.message || ''),
      }),
    )
  })

const versionOf = (s: string) => /^\s*(\d+)\.(\d+)\.(\d+)/.exec(s)
export const atLeast = (v: string, min: string) => {
  const a = versionOf(v)?.slice(1).map(Number)
  const b = versionOf(min)?.slice(1).map(Number) ?? []
  if (!a) return false
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

// srt が渡す HTTPS_PROXY に CONNECT して 200 を見る（名前解決は proxy の側。Node の fetch は proxy を見ない。8.9 (5)）
export const NET_PROBE = `const u=new URL(process.env.HTTPS_PROXY||process.env.https_proxy||'');const h={};if(u.username)h['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64');const r=require('node:http').request({host:u.hostname,port:u.port,method:'CONNECT',path:'api.anthropic.com:443',headers:h});r.on('connect',(s,k)=>{k.destroy();process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(10000,()=>process.exit(1));r.end()`

export type CheckOptions = {
  home: string
  claude: string[]
  env?: NodeJS.ProcessEnv
  srt?: string[]
  platform?: NodeJS.Platform
  bwrapWorks?: () => Promise<boolean> // テストで替える
  timeoutMs?: number
  userHome?: string
}

// 起動時の自己点検（8.9 (5)）。版と隔離を独立に見る
export async function checkSandbox(o: CheckOptions): Promise<SandboxCheck> {
  const env = allowedEnv(o.env ?? process.env)
  const timeout = o.timeoutMs ?? 30_000
  const v = await run([...o.claude, '--version'], env, timeout)
  const claudeVersion = v.code === 0 ? versionOf(v.out)?.slice(1).join('.') : undefined
  const claudeOk = claudeVersion !== undefined && atLeast(claudeVersion, MIN_CLAUDE)
  const done = (isolation: Isolation, reason?: string): SandboxCheck => ({
    isolation,
    ...(reason && { reason }),
    ...(claudeVersion && { claudeVersion }),
    claudeOk,
  })
  const platform = o.platform ?? process.platform
  if (platform === 'win32') return done('weak', 'windows')
  if (platform === 'linux') {
    for (const t of ['bwrap', 'socat']) if (!onPath(t, env)) return done('weak', `missing:${t}`)
    if (!onPath('rg', env) && isScript(realExe(o.claude[0] ?? '', env))) return done('weak', 'missing:rg')
    const bwrap =
      o.bwrapWorks ??
      (async () => (await run(['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', 'true'], env, timeout)).code === 0)
    if (!(await bwrap())) return done('weak', 'userns')
  }
  const work = join(o.home, 'sandbox-probe', 'work')
  mkdirSync(work, { recursive: true, mode: 0o700 })
  const box = createSandbox({
    home: o.home,
    claude: o.claude,
    check: () => done('strong'),
    ...(o.srt && { srt: o.srt }),
    ...(o.userHome && { userHome: o.userHome }),
  })
  const probe = async (args: string[], inner?: string[]) => {
    const p = await box.prepare(work, args, o.env ?? process.env, inner)
    try {
      return await run(p.argv, p.env, timeout, work)
    } finally {
      await p.cleanup()
    }
  }
  const wrapped = await probe(['--version'])
  if (wrapped.code !== 0 || !versionOf(wrapped.out)) return done('broken', `srt:${wrapped.err.slice(0, 200)}`)
  const net = await probe([], [realpathSync(process.execPath), '-e', NET_PROBE])
  if (net.code !== 0) return done('broken', 'network')
  return done('strong')
}
