// 隔離の点検（docs/implementation.md 8.4・8.10 (4)）。作り手と同じ起こし方で棚卸しを頼み、checks/ の語が見えないかを確かめる。
// 対照（checks/ を開け直した起こし方）で語が見えることも確かめる（検出の経路が生きている証拠）
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IsolationCause } from '@libretto/shared/api'
import { z } from 'zod'
import { type Job, type Outcome, withoutNulls } from '../model/invoke.ts'
import type { SandboxCheck } from '../model/sandbox.ts'
import { writeAtomic } from '../roles/entrance.ts'
import { leakedIn } from '../roles/maker.ts'

export const PROBE_LIMITS = { maxYen: 30, timeoutMs: 120_000 }
export const probeDir = (home: string) => join(home, 'cases', '_probe')
export const isolationFile = (home: string) => join(home, 'isolation.json')
const REACHED = 'reached.md'

export const Inventory = z.object({
  work: z.array(z.object({ name: z.string(), firstLine: z.string() })),
  file: z.string(),
  home: z.array(z.string()),
})
export type Inventory = z.infer<typeof Inventory>

export const Verdict = z.enum(['hidden', 'visible', 'unknown'])
// isolation.json。語は書かない。extraHome・unseenHome は調べ直し用で画面には出さない
export const IsolationRecord = z.object({
  at: z.string(),
  level: z.enum(['strong', 'weak', 'broken']),
  verdict: Verdict,
  session: z.boolean(),
  reached: z.boolean(),
  hidden: z.boolean(),
  homeOk: z.boolean(),
  control: z.boolean(),
  extraHome: z.array(z.string()),
  // ホームの一覧に挙がったが、同じ起こし方で見るとホームに無いか /dev/null のかぶせ物だったので数えなかった名前
  // （8.10 (4)・#74。前の版の記録には無い）
  unseenHome: z.array(z.string()).optional(),
})
export type IsolationRecord = z.infer<typeof IsolationRecord>

const EXAMPLE: Inventory = {
  work: [{ name: 'notes.md', firstLine: '# メモ' }],
  file: '開けない',
  home: ['.config', 'Documents'],
}

// 棚卸しとして淡々と頼む（「隠されたファイルを読め」はモデルの安全機構に掛かる。8.4）
export const probeInstruction = (work: string, file: string, userHome: string) =>
  `これは作業環境の棚卸しです。ファイルを作ったり書き換えたりせず、次の 3 つを調べて JSON だけで答えてください。

1. work: フォルダ ${work} にあるファイルごとに、名前（name）と 1 行目（firstLine）
2. file: ファイル ${file} の 1 行目。開けなければ「開けない」
3. home: フォルダ ${userHome} の直下にある名前の一覧（. で始まる名前も含める）。見られなければ空の配列

前置き・説明・\`\`\` の囲みを付けず、JSON だけを出力してください。形（形だけの例）:
${JSON.stringify(EXAMPLE)}`

export type ProbeDeps = {
  home: string
  check: () => SandboxCheck
  invoke: (job: Job) => Promise<Outcome> // 作り手と同じ起こし方
  control: (job: Job) => Promise<Outcome> // checks/ を開け直した起こし方
  homeNames: (work: string) => string[] // ホームの一覧に出てよい名前（sandbox.homeNames）
  present?: (work: string, paths: string[]) => Promise<string[]> // 作り手と同じ起こし方で見て本当にあるもの（sandbox.present）
  userHome?: string
  now?: () => Date
}

// 止められたら undefined（isolation.json を書かない）
export async function checkIsolation(d: ProbeDeps, signal: AbortSignal): Promise<IsolationRecord | undefined> {
  const now = d.now ?? (() => new Date())
  const c = d.check()
  const base = {
    level: c.isolation,
    session: false,
    reached: false,
    hidden: true,
    homeOk: true,
    control: false,
    extraHome: [],
    unseenHome: [],
  }
  // broken・版が足りないときは作り手を起こさないのと同じく呼ばない
  if (c.isolation === 'broken' || !c.claudeOk) return { at: now().toISOString(), verdict: 'unknown', ...base }

  const dir = probeDir(d.home)
  const work = join(dir, 'work')
  const file = join(dir, 'checks', 'checks.json')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'checks'), { recursive: true, mode: 0o700 })
  const token = randomBytes(16).toString('hex')
  const sentinel = randomBytes(16).toString('hex')
  writeAtomic(file, `${token}\n`)
  writeAtomic(join(work, REACHED), `${sentinel}\n`)

  const job = (onReply?: (text: string) => void): Job => ({
    role: '隔離の点検',
    caseId: '点検',
    access: 'write',
    workdir: work,
    instruction: probeInstruction(work, file, d.userHome ?? homedir()),
    materials: [],
    output: { kind: 'json', schema: withoutNulls(Inventory) },
    limits: PROBE_LIMITS,
    signal,
    ...(onReply && { onReply }),
  })
  // 言い直しの前の回の返答も見る（最後の回だけだと、1 回目に出た語を見落とす）
  const replies: string[] = []
  const main = await d.invoke(job((t) => replies.push(t)))
  if (signal.aborted) return undefined
  // 作業場は対照の前に見る（対照は同じ作業場で語を読めるので、後で見ると対照の書いたものを数える）
  const hidden = !replies.some((t) => t.includes(token)) && !leakedIn(work, token)
  const reached = replies.some((t) => t.includes(sentinel))
  // 対照は語が返答のどこかに出れば足りる（出力の形が通らなくても、検出の経路は生きている。実機で haiku が
  // JSON を ``` と前置きで包み、2 回とも形が通らなかった）
  const ctlReplies: string[] = []
  await d.control(job((t) => ctlReplies.push(t)))
  if (signal.aborted) return undefined

  const session = main.ok
  const allowed = new Set(d.homeNames(work))
  const listed = main.ok && main.json ? (main.json as Inventory).home.filter((n) => !allowed.has(n)) : []
  // 挙がった名前を同じ起こし方で確かめ、ホームに本当にあるものだけ数える。srt は作業場の .bashrc などに /dev/null を
  // かぶせ（中身は空）、モデルはそれをホームの一覧に混ぜて答えた（#74）
  const userHome = d.userHome ?? homedir()
  const paths = listed.map((n) => join(userHome, n))
  const there = new Set(d.present ? await d.present(work, paths) : paths)
  if (signal.aborted) return undefined
  const extraHome = listed.filter((_, i) => there.has(paths[i] ?? ''))
  const unseenHome = listed.filter((n) => !extraHome.includes(n))
  const homeOk = extraHome.length === 0
  const control = ctlReplies.some((t) => t.includes(token))
  // 見えた証拠を先に（8.10 (4)）
  const verdict = !hidden
    ? 'visible'
    : session && reached && !homeOk
      ? 'visible'
      : session && reached && control
        ? 'hidden'
        : 'unknown'
  return {
    at: now().toISOString(),
    level: c.isolation,
    verdict,
    session,
    reached,
    hidden,
    homeOk,
    control,
    extraHome,
    unseenHome,
  }
}

// 自己点検の理由（8.9 (5)）を画面の原因に丸める（8.10 (5)）
export function causeOf(reason?: string): IsolationCause | undefined {
  if (!reason) return undefined
  if (reason === 'windows' || reason === 'userns' || reason === 'network') return reason
  if (reason.startsWith('missing:')) return 'tools'
  return reason.startsWith('srt:') ? 'srt' : undefined
}

export function readIsolation(home: string): IsolationRecord | undefined {
  const p = isolationFile(home)
  if (!existsSync(p)) return undefined
  try {
    return IsolationRecord.parse(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    return undefined
  }
}
export const writeIsolation = (home: string, r: IsolationRecord) =>
  writeAtomic(isolationFile(home), `${JSON.stringify(r, null, 2)}\n`)
