// Jev（TypeSafe）の Noul を fetch で呼ぶ中身（docs/implementation.md 7.4・7.6 (1)）。費用の予約・時間切れ・再試行は invoke の側。
// materials を state に、instruction（{ qid: instructions } の JSON）を questions にする。文章は state にだけ置く
import type { Backend, Reply } from './invoke.ts'

type Opts = {
  key: () => string | undefined // 呼び出しのたびに読む（6.1.3 (4)）
  usdJpy: () => number
  baseUrl?: string // テストは偽 TypeSafe に差し替える（11.1）
  log?: (line: string) => void
}

// 役割の表の model → API の名前
export const API_MODEL: Record<string, string> = { jev: 'jev-latest' }
const USD_PER_MTOK = 0.042 // 設計書 5.7.1
const OVERHEAD_TOKENS = 256
const ANSWER_TOKENS = 32 // 質問 1 つの答えの枠

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
// usage（input_tokens / output_tokens。2026-10-24 に本物で確かめた形）→ 円。欠ければ undefined（見積もりで精算する）
const usageYen = (usage: unknown, rate: number) => {
  const u = obj(usage)
  const i = count(u.input_tokens)
  const o = count(u.output_tokens)
  return i === undefined || o === undefined ? undefined : ((i + o) * USD_PER_MTOK * rate) / 1e6
}

// 送る前の見積もり。1 トークンは 1 バイト以上なので上に倒れる（7.6 (1)。本物で実額の 1.64 倍）。予約を超えないかの検査と、usage が無いときの精算に使う
export const estimateYen = (body: string, questions: number, rate: number) =>
  ((Buffer.byteLength(body, 'utf8') + OVERHEAD_TOKENS + ANSWER_TOKENS * questions) * USD_PER_MTOK * rate) / 1e6

export function createJev(opts: Opts): Backend {
  const log = opts.log ?? ((line: string) => console.error(line))
  const base = opts.baseUrl ?? 'https://api.typesafe.ai'
  return async (call): Promise<Reply> => {
    const model = API_MODEL[call.model]
    if (!model) throw new Error(`jev: no api model for ${call.model}`)
    if (call.access !== 'none' || call.materials.some((x) => !('text' in x)))
      throw new Error('jev: only text materials with access none')
    const asked = JSON.parse(call.instruction) as Record<string, string>
    const qids = Object.keys(asked)
    if (!qids.length || qids.some((q) => typeof asked[q] !== 'string')) throw new Error('jev: bad questions')
    const rate = opts.usdJpy()
    if (!(Number.isFinite(rate) && rate > 0)) throw new Error(`jev: bad usdJpy ${rate}`)
    const key = opts.key()
    if (!key) return { fail: 'unavailable', costYen: 0 }
    const body = JSON.stringify({
      model,
      state: Object.fromEntries(call.materials.map((m) => [m.name, 'text' in m ? m.text : ''])),
      questions: Object.fromEntries(qids.map((q) => [q, { type: 'noul', instructions: asked[q] }])),
    })
    const yen = estimateYen(body, qids.length, rate)
    // 予約を超える要求は送らない（invoke は返した額をそのまま精算する。7.6 (1)）
    if (yen > call.maxYen) {
      log(`jev: request too large for maxYen ${call.maxYen}`)
      return { fail: 'unavailable', costYen: 0 }
    }

    let res: Response
    try {
      res = await fetch(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: call.signal,
      })
    } catch (e) {
      if (call.signal.aborted) throw call.signal.reason
      // 例外の文に見出し（鍵）が載ることがあるので、元の例外は渡さない（6.1.3 (4)）
      throw new Error(`jev: network ${(e as { cause?: { code?: unknown } }).cause?.code ?? (e as Error).name}`)
    }
    let json: Record<string, unknown> | undefined
    try {
      json = obj(await res.json())
    } catch {
      if (call.signal.aborted) throw call.signal.reason
    }
    if (!res.ok) {
      log(`jev: http ${res.status}`)
      if (res.status === 429 || res.status === 529) return { fail: 'unavailable', why: 'rate_limited', costYen: 0 }
      return { fail: 'unavailable', costYen: 0 }
    }
    // 送った qid が全部そろい、0〜1 の数のときだけ成功。そろわなければ言い直さない（7.6 (1)）
    const answers = obj(json?.answers)
    const noul = qids.map((q) => obj(answers[q]).noul)
    if (noul.some((n) => typeof n !== 'number' || !(n >= 0 && n <= 1))) {
      log('jev: answers are missing or out of range')
      return { fail: 'unavailable', costYen: usageYen(json?.usage, rate) ?? yen }
    }
    return {
      text: JSON.stringify({ answers: Object.fromEntries(qids.map((q, i) => [q, noul[i]])) }),
      costYen: usageYen(json?.usage, rate) ?? yen,
    }
  }
}
