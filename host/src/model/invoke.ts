// モデル呼び出しのアダプタ 1 つ（docs/implementation.md 6.1・6.1.1）。費用の予約と精算、出力の検査と 1 回の言い直しはここだけ
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { type Ledger, NON_CASE_COSTS } from '../ledger/ledger.ts'
import { type Family, modelFor, type Role } from './roles.ts'

export type Material = { name: string; text: string } | { name: string; file: string; mime: string }

export type Job = {
  role: Role
  caseId: string // 案件の無い呼び出しは '推測' / '点検'
  instruction: string
  materials: Material[]
  workdir?: string
  access: 'none' | 'read' | 'write' | 'search' // search は WebSearch だけ（6.3.3 (2)）
  output:
    | { kind: 'text' }
    | { kind: 'json'; schema: z.ZodType; accept?: (value: unknown) => string[] }
    | { kind: 'files'; expect: string[] }
  limits: { maxYen: number; timeoutMs: number }
  signal: AbortSignal
  fallback?: true // 別系統の代わりに受け皿の表（roles.ts の FALLBACK）で呼ぶ（6.2.2 (3)）
  onReply?: (text: string) => void // 言い直しの前の回も含め、返ってきた文ごとに呼ぶ（canary を見る。8.10 (1)）
}

export type CapScope = '案件' | '全体' | '呼び出し'
type Meta = { costYen: number; family: Family; model: string }
export type Outcome =
  | ({ ok: true; text: string; json?: unknown; files?: string[] } & Meta)
  | ({ ok: false; kind: 'timeout' | 'invalid_output' | 'stopped'; detail: string } & Meta)
  // why は runner が待つかを決める印（6.1.2 (3)）。detail は同じ固定の文言
  | ({ ok: false; kind: 'unavailable'; why?: Why; detail: string } & Meta)
  | ({ ok: false; kind: 'budget'; scope: CapScope; detail: string } & Meta)

// limit は 1 日の呼び出しの上限で送らなかった（invoke だけが付ける。7.6 (4)）
export type Why = 'auth_expired' | 'rate_limited' | 'limit'

// 中身（claude-cli / openai / jev / fake）が返す生の結果。costYen は null = 不明、0 = 実額 0（6.1.1 (3)）
export type Call = Pick<Job, 'role' | 'caseId' | 'instruction' | 'materials' | 'access'> & {
  callId: string // 結果のファイルの名前（9.4 (7)）
  workdir?: string
  family: Family
  model: string
  maxYen: number
  signal: AbortSignal
}
export type Reply =
  | { text: string; costYen: number | null; files?: string[] }
  | { fail: 'unavailable'; why?: Why; costYen: number | null }
  | { fail: 'budget'; costYen: number | null }
export type Backend = (call: Call) => Promise<Reply>

// 役割の JSON で、任意の欄の null を「欄が無い」と読む（モデルは無い欄を null で書きがち。6.2.2 (3)）
export const withoutNulls = <T extends z.ZodType>(schema: T) =>
  z.preprocess(function drop(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(drop)
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== null)
          .map(([k, x]) => [k, drop(x)]),
      )
    return v
  }, schema)

// `{` から対応する `}` の位置（文字列の中の括弧は数えない）。閉じなければ -1
function closing(s: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

// 出力の中の JSON の候補（6.2.2 (3)・GitHub #65）。全体が JSON ならそれだけ。
// そうでなければ前から `{` ごとに対応する `}` までを読み、読めたらその後ろから続ける（前置きの文・``` の位置・後ろの注記によらない）
function jsonCandidates(text: string): unknown[] {
  try {
    return [JSON.parse(text)]
  } catch {}
  const found: unknown[] = []
  let i = text.indexOf('{')
  while (i !== -1) {
    const end = closing(text, i)
    if (end !== -1)
      try {
        found.push(JSON.parse(text.slice(i, end + 1)))
        i = text.indexOf('{', end + 1)
        continue
      } catch {}
    i = text.indexOf('{', i + 1)
  }
  return found
}

// 呼び出しの結果のファイル（9.4 (7)）。中身が書き、invoke が精算のあとに消す
export const callFile = (dir: string, callId: string) => join(dir, `${callId}.json`)

// 状態機械には { type: 'cost.cap', by: '費用', ...これ } で渡す（6.1.1 (1)）
export type CostCapNotice = { caseId: string; scope: CapScope; callId: string; eventId: string }

// 本人に見える失敗の文は固定（6.1.1 (6)）。生の文は log にだけ書く
export const DETAIL = {
  timeout: '時間切れで止まりました',
  budget: '費用の上限に達しました',
  unavailable: 'つながりませんでした',
  invalid_output: '出力を受け取れませんでした',
  stopped: '止めました',
} as const

type Deps = {
  ledger: Ledger
  backends: Partial<Record<Family, Backend>>
  caps: () => { caseCapYen: number | null; monthCapYen: number | null }
  onCostCap: (n: CostCapNotice) => void | Promise<void>
  log?: (line: string) => void
  newCallId?: () => string
  callsDir?: string // 結果のファイルの置き場。精算のあとに消す（9.4 (7)）
  // 開発の確かめ用（実ホストの確認で検査に落ちた理由を見る）。設定したときだけ、呼び出しごとの生の出力と違反をここに書く。
  // 既定は書かない（logs/ に本文を書かない。9.1）
  debugDir?: string
  settleMs?: number // 止めた後に中身の決着（子孫の終了まで）を待つ上限（6.1.2 (2)）
  retryWaitMs?: number // 混雑の再試行の前に待つ時間（6.1.2 (3)）
  jobsDir?: (caseId: string) => string // 役割に渡した Job の記録の置き場（8.4・8.10 (3)）
  // 系統ごとの混雑の再試行の回数と待ち時間。既定は 1 回・retryWaitMs、jev は 2 回・1 秒（7.6 (2)）
  retry?: Partial<Record<Family, { times: number; waitMs: number }>>
  dailyLimits?: Partial<Record<Family, number>> // 系統ごとの 1 日の呼び出しの上限（7.6 (4)）
}

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')

// cases/<id>/jobs/<role>-<n>.json。instruction の全文と、材料の名前・大きさ・sha256 だけ（本文は入れない。8.4）
function recordJob(dir: string, job: Job, now: Date) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const n = readdirSync(dir).filter((f) => f.startsWith(`${job.role}-`)).length + 1
  const record = {
    role: job.role,
    at: now.toISOString(),
    access: job.access,
    output: job.output.kind,
    instruction: job.instruction,
    materials: job.materials.map((m) =>
      'text' in m
        ? { name: m.name, chars: m.text.length, sha256: sha(m.text) }
        : { name: m.name, mime: m.mime, bytes: statSync(m.file).size, sha256: sha(readFileSync(m.file)) },
    ),
  }
  writeFileSync(join(dir, `${job.role}-${n}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

type Ended = Reply | { fail: 'stopped' | 'timeout'; costYen: null }

const abortOf = (s: AbortSignal) =>
  new Promise<never>((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }))
const sleep = (ms: number, s?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (s?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    s?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export function createInvoke(deps: Deps) {
  const log = deps.log ?? ((line: string) => console.error(line))
  const newCallId = deps.newCallId ?? randomUUID
  const settleMs = deps.settleMs ?? 10_000
  const retryWaitMs = deps.retryWaitMs ?? 60_000
  const retryOf = (f: Family) =>
    deps.retry?.[f] ?? (f === 'jev' ? { times: 2, waitMs: 1_000 } : { times: 1, waitMs: retryWaitMs })

  // 中身の例外・停止・時間切れを結果に写す。例外は投げない
  async function run(backend: Backend, call: Omit<Call, 'signal'>, job: Job): Promise<Ended> {
    const timeout = AbortSignal.timeout(job.limits.timeoutMs)
    const signal = AbortSignal.any([job.signal, timeout])
    let pending: Promise<Reply> | undefined
    try {
      signal.throwIfAborted()
      pending = backend({ ...call, signal })
      return await Promise.race([pending, abortOf(signal)])
    } catch (e) {
      // 止めたらプロセスが終わりきるまで待つ。ただし中身が signal を無視しても settleMs より長くは待たない
      if (signal.aborted && pending) {
        const settled = await Promise.race([
          pending.then(
            () => true,
            () => true,
          ),
          sleep(settleMs).then(() => false),
        ])
        if (!settled) log(`invoke ${job.role} ${call.family}: backend did not settle in ${settleMs}ms`)
      }
      if (job.signal.aborted) return { fail: 'stopped', costYen: null }
      if (timeout.aborted) return { fail: 'timeout', costYen: null }
      log(`invoke ${job.role} ${call.family}: ${e instanceof Error ? e.stack : String(e)}`)
      return { fail: 'unavailable', costYen: null }
    }
  }

  // 違反の一覧。空なら受け入れ（6.1.1 (4)）
  function check(job: Job, reply: { text: string; files?: string[] }): { errors: string[]; json?: unknown } {
    const out = job.output
    if (out.kind === 'text') return { errors: [] }
    if (out.kind === 'files') {
      const missing = out.expect.filter((f) => !reply.files?.includes(f))
      return { errors: missing.map((f) => `書かれていないファイル: ${f}`) }
    }
    // 囲みや前後の文があっても JSON を読む（言い直しの 1 回を形の違いで使わない）
    const found = jsonCandidates(reply.text.trim())
    // パーサーの文は出力の一部を含むので書かない（logs/ に他人の文が残らないように。6.4 (3)）
    if (!found.length) return { errors: ['JSON として読めません'] }
    // 型に合う候補が 1 つならそれ。2 つ以上はどれが答えか決めずに言い直し。どれも合わなければいちばん大きい候補の違反を返す
    const results = found.map((v) => ({ r: out.schema.safeParse(v), size: JSON.stringify(v)?.length ?? 0 }))
    const valid = results.filter((x) => x.r.success)
    if (valid.length > 1)
      return { errors: ['型に合う JSON が 2 つ以上あります。答えの JSON を 1 つだけ返してください'] }
    const parsed = (valid[0] ?? results.reduce((a, b) => (b.size > a.size ? b : a))).r
    if (!parsed.success)
      return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(全体)'}: ${i.message}`) }
    const errors = out.accept?.(parsed.data) ?? []
    return errors.length ? { errors } : { errors, json: parsed.data }
  }

  return async function invoke(job: Job): Promise<Outcome> {
    const { family, model } = modelFor(job.role, job.fallback)
    const backend = deps.backends[family]
    if (!backend) throw new Error(`no backend for ${family}`)
    const { maxYen } = job.limits
    let costYen = 0
    let materials = job.materials
    let retried = 0
    const retry = retryOf(family)
    const daily = deps.dailyLimits?.[family]
    // 中身の files は呼び出しごとの差分（6.1.2 (6)）。言い直しで足りない分だけ書けば揃うよう、この invoke の中で合わせる
    const written = new Set<string>()
    // 書けなければ例外のまま上へ（保存の帯。8.10 (3)）
    if (deps.jobsDir && !NON_CASE_COSTS.includes(job.caseId)) recordJob(deps.jobsDir(job.caseId), job, new Date())

    const capped = async (scope: CapScope, callId: string): Promise<Outcome> => {
      // 発火はアダプタだけ。案件の無い呼び出しは通知しない（6.1.1 (1)）
      if (!NON_CASE_COSTS.includes(job.caseId))
        await deps.onCostCap({ caseId: job.caseId, scope, callId, eventId: `${job.caseId}:cost.cap:${callId}` })
      return { ok: false, kind: 'budget', scope, detail: DETAIL.budget, costYen, family, model }
    }

    // 1 回目と言い直しの 1 回（と混雑の再試行 1 回）。呼び出しごとに別の callId で予約・精算する（6.1.1 (2)・6.1.2 (3)）
    for (let attempt = 1; ; attempt++) {
      // 止めた後は予約しない（呼んでいない呼び出しに費用を付けず、上限の通知も出さない）
      if (job.signal.aborted) return { ok: false, kind: 'stopped', detail: DETAIL.stopped, costYen, family, model }
      const callId = newCallId()
      const reserved = deps.ledger.reserveCost({
        callId,
        caseId: job.caseId,
        role: job.role,
        family,
        model,
        holdYen: maxYen,
        ...deps.caps(),
        ...(daily !== undefined && { daily }),
      })
      // 1 日の上限は案件を止めず、送らなかったことだけを返す（呼ぶ側が受け皿に回す。7.6 (4)）
      if (!reserved.ok) {
        if (reserved.scope === '1日')
          return { ok: false, kind: 'unavailable', why: 'limit', detail: DETAIL.unavailable, costYen, family, model }
        return capped(reserved.scope, callId)
      }

      const call = {
        callId,
        role: job.role,
        caseId: job.caseId,
        instruction: job.instruction,
        materials,
        access: job.access,
        family,
        model,
        maxYen,
        ...(job.workdir !== undefined && { workdir: job.workdir }),
      }
      const ended = await run(backend, call, job)
      // どの終わり方でも精算する。不明は予約の全額。失敗したら例外のまま上へ（6.1.1 (3)）
      const yen = ended.costYen ?? maxYen
      deps.ledger.recordCharge({ callId, yen })
      costYen += yen
      // 精算をコミットしてから消す。消し損ねは次の起動で掃除する（9.4 (7)）
      if (deps.callsDir) {
        try {
          rmSync(callFile(deps.callsDir, callId), { force: true })
        } catch (e) {
          log(`invoke: could not remove result file ${callId}: ${(e as Error).message}`)
        }
      }

      if ('fail' in ended) {
        if (ended.fail === 'budget') return capped('呼び出し', callId)
        if ('why' in ended && ended.why === 'rate_limited' && retried < retry.times) {
          retried++
          attempt--
          await sleep(retry.waitMs, job.signal)
          continue
        }
        const why = 'why' in ended && ended.why ? { why: ended.why } : {}
        return { ok: false, kind: ended.fail, ...why, detail: DETAIL[ended.fail], costYen, family, model }
      }
      job.onReply?.(ended.text)
      for (const f of ended.files ?? []) written.add(f)
      const files = ended.files || written.size ? [...written] : undefined
      const { errors, json } = check(job, { text: ended.text, ...(files && { files }) })
      if (deps.debugDir) {
        try {
          mkdirSync(deps.debugDir, { recursive: true })
          writeFileSync(
            join(deps.debugDir, `${job.caseId}-${job.role}-${callId}.json`),
            JSON.stringify({ role: job.role, attempt, errors, text: ended.text }, null, 2),
          )
        } catch (e) {
          log(`invoke: could not write debug output: ${(e as Error).message}`)
        }
      }
      if (!errors.length) {
        return {
          ok: true,
          text: ended.text,
          ...(json !== undefined && { json }),
          ...(files && { files }),
          costYen,
          family,
          model,
        }
      }
      if (attempt === 2) {
        log(`invoke ${job.role}: invalid output: ${errors.join(' / ')}`)
        return { ok: false, kind: 'invalid_output', detail: DETAIL.invalid_output, costYen, family, model }
      }
      // 同じ入力＋前の出力＋エラーで 1 回だけ
      materials = [
        ...job.materials,
        { name: '前の出力', text: ended.text },
        { name: '直すところ', text: errors.join('\n') },
      ]
    }
  }
}
