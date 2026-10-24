// Jev の Noul をまとめて送る入口（docs/implementation.md 7.6 (3)）。Jev を使う役割は全部ここを通す
import { z } from 'zod'
import { DETAIL, type Job, type Outcome } from './invoke.ts'
import { keyStatus } from './keys.ts'

// 判定不能の帯（7.3）。noul ≥ high → はい、≤ low → いいえ、間 → 別の読み手に回す。見直しは 7.6 (11)
export const BAND = { low: 0.35, high: 0.65 } as const
export const JEV_LIMITS = { maxYen: 1, timeoutMs: 10_000 }
// オーナー判断（2026-10-24）: Jev はとても安いので 2 万回程度でよい（7.6 (4)）
export const JEV_DAILY_LIMIT = 20_000
const MAX_STATE = 2000 // 1 要求の state の字数（7.4）
const MAX_QUESTIONS = 20
const PARALLEL = 4

export const yesOf = (noul: number | undefined): boolean | null =>
  noul === undefined ? null : noul >= BAND.high ? true : noul <= BAND.low ? false : null

// questions は qid → instructions。qid は全部の群を通して一意
export type NoulGroup = { state: Record<string, string>; questions: Record<string, string> }
type Failure = Extract<Outcome, { ok: false }>
// partial = 失敗した要求（1 日の上限を含む）が 1 つ以上ある
export type Asked = { ok: true; answers: Map<string, number>; partial: boolean } | { ok: false; out: Failure }

const Answers = z.object({ answers: z.record(z.string(), z.number().min(0).max(1)) })
const chars = (state: Record<string, string>) => Object.values(state).reduce((n, t) => n + [...t].length, 0)

export async function askNoul(
  d: { home: string; invoke: (job: Job) => Promise<Outcome> },
  a: { caseId: string; role: '判定役・命題' | '事実係・命題'; groups: readonly NoulGroup[]; signal: AbortSignal },
): Promise<Asked> {
  const ids = a.groups.flatMap((g) => Object.keys(g.questions))
  if (new Set(ids).size !== ids.length) throw new Error('askNoul: qid must be unique across groups')
  const answers = new Map<string, number>()
  if (!keyStatus(d.home, 'jev').set) return { ok: true, answers, partial: false }

  // 2,000 字を超える state は送らない（答え無し = 呼ぶ側が別の読み手に回す）。質問は 20 個ずつ
  const queue = a.groups
    .filter((g) => chars(g.state) <= MAX_STATE)
    .flatMap((g) => {
      const qs = Object.entries(g.questions)
      return Array.from({ length: Math.ceil(qs.length / MAX_QUESTIONS) }, (_, i) => ({
        state: g.state,
        questions: Object.fromEntries(qs.slice(i * MAX_QUESTIONS, (i + 1) * MAX_QUESTIONS)),
      }))
    })
  // 止めた・上限なら残りを送らず、動いている要求の決着を待つ
  const ac = new AbortController()
  const signal = AbortSignal.any([a.signal, ac.signal])
  let stop: Failure | undefined
  let partial = false
  let limited = false
  const worker = async () => {
    for (let r = queue.shift(); r && !stop && !limited && !signal.aborted; r = queue.shift()) {
      const out = await d.invoke({
        role: a.role,
        caseId: a.caseId,
        instruction: JSON.stringify(r.questions),
        materials: Object.entries(r.state).map(([name, text]) => ({ name, text })),
        access: 'none',
        output: { kind: 'json', schema: Answers },
        limits: JEV_LIMITS,
        signal,
      })
      if (out.ok) for (const [q, n] of Object.entries((out.json as z.infer<typeof Answers>).answers)) answers.set(q, n)
      else if (out.kind === 'stopped' || out.kind === 'budget') {
        stop ??= out
        ac.abort()
      } else {
        partial = true
        if (out.kind === 'unavailable' && out.why === 'limit') limited = true
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  if (stop) return { ok: false, out: stop }
  // 1 つも送らないうちに止められた
  if (a.signal.aborted)
    return {
      ok: false,
      out: { ok: false, kind: 'stopped', detail: DETAIL.stopped, costYen: 0, family: 'jev', model: 'jev' },
    }
  return { ok: true, answers, partial }
}
