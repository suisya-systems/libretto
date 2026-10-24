// OpenAI の Responses API を fetch で呼ぶ中身（docs/implementation.md 6.1・6.1.3）。費用の予約・検査・言い直しは invoke の側
import { stdinText } from './claude-cli.ts'
import type { Backend, Reply } from './invoke.ts'

type Opts = {
  key: () => string | undefined // 呼び出しのたびに読む（入れ直し・削除が次の呼び出しから効く。6.1.3 (4)）
  usdJpy: () => number // 呼び出しの頭で 1 回だけ読む（6.1.2 (5)）
  baseUrl?: string // テストは偽 OpenAI に差し替える（11.1）
  log?: (line: string) => void
}

// 役割の表の model → API の名前と単価（ドル / 100 万トークン。2026-10-24 の価格表。6.1.3 (1)）
type Price = { input: number; cached: number; write30m: number; write12h: number; output: number }
export const API_MODEL: Record<string, { id: string; usdPerMTok: Price }> = {
  codex: { id: 'gpt-6-astra', usdPerMTok: { input: 10, cached: 1, write30m: 12.5, write12h: 25, output: 50 } },
}
const MIN_OUTPUT_TOKENS = 2000

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

// usage → 円。欠け・数でない・負は null（予約の全額。6.1.3 (3)）
function yenOf(usage: unknown, p: Price, rate: number): number | null {
  const u = obj(usage)
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined || output === undefined) return null
  const d = obj(u.input_tokens_details)
  const w = obj(d.cache_write_tokens_details)
  const cached = num(d.cached_tokens) ?? 0
  const w30 = num(w.ttl_30m_tokens) ?? 0
  const w12 = num(w.ttl_12h_tokens) ?? 0
  const plain = Math.max(0, input - cached - w30 - w12)
  const usd = (plain * p.input + cached * p.cached + w30 * p.write30m + w12 * p.write12h + output * p.output) / 1e6
  return usd * rate
}

// output の message の output_text を順に連結
function textOf(body: Record<string, unknown>): string {
  const out = Array.isArray(body.output) ? body.output : []
  return out
    .flatMap((o) => (obj(o).type === 'message' && Array.isArray(obj(o).content) ? (obj(o).content as unknown[]) : []))
    .map((c) => (obj(c).type === 'output_text' && typeof obj(c).text === 'string' ? (obj(c).text as string) : ''))
    .join('')
}

export function createOpenai(opts: Opts): Backend {
  const log = opts.log ?? ((line: string) => console.error(line))
  const base = opts.baseUrl ?? 'https://api.openai.com'
  return async (call): Promise<Reply> => {
    const m = API_MODEL[call.model]
    if (!m) throw new Error(`openai: no api model for ${call.model}`)
    if (call.access !== 'none' || call.materials.some((x) => !('text' in x)))
      throw new Error('openai: only text materials with access none')
    const rate = opts.usdJpy()
    if (!(Number.isFinite(rate) && rate > 0)) throw new Error(`openai: bad usdJpy ${rate}`)
    const key = opts.key()
    // 送っていないので 0 円（6.1.3 (3)）
    if (!key) return { fail: 'unavailable', costYen: 0 }
    const input = stdinText(call)
    // 入力は 1 字 1 トークン以下と見て、最も高い入力の単価で上に倒す。残りを出力の枠にする（6.1.3 (2)）
    const p = m.usdPerMTok
    const room = call.maxYen / rate - (input.length * p.write30m) / 1e6
    const maxOutput = Math.floor((room / p.output) * 1e6)
    if (maxOutput < MIN_OUTPUT_TOKENS) {
      log(`openai: input too large for maxYen ${call.maxYen} (${input.length} chars)`)
      return { fail: 'unavailable', costYen: 0 }
    }

    let res: Response
    try {
      res = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: m.id,
          input,
          text: { format: { type: 'json_object' } },
          max_output_tokens: maxOutput,
          store: false,
          prompt_cache_options: { mode: 'explicit' },
        }),
        signal: call.signal,
      })
    } catch (e) {
      if (call.signal.aborted) throw call.signal.reason
      // 例外の文に見出し（鍵）が載ることがあるので、元の例外は渡さない（6.1.3 (4)）
      throw new Error(`openai: network ${(e as { cause?: { code?: unknown } }).cause?.code ?? (e as Error).name}`)
    }
    let body: Record<string, unknown> | undefined
    try {
      body = obj(await res.json())
    } catch {
      if (call.signal.aborted) throw call.signal.reason
    }
    if (!res.ok) {
      // message は鍵の伏せ字を含みうるので書かない（6.1.3 (4)）
      const err = obj(body?.error)
      log(`openai: http ${res.status} code=${String(err.code)} type=${String(err.type)}`)
      if (res.status === 429 && err.code === 'insufficient_quota') return { fail: 'unavailable', costYen: 0 }
      if ([429, 500, 503].includes(res.status)) return { fail: 'unavailable', why: 'rate_limited', costYen: 0 }
      return { fail: 'unavailable', costYen: 0 }
    }
    if (!body) {
      log('openai: response body is not JSON')
      return { fail: 'unavailable', costYen: null }
    }
    const costYen = yenOf(body.usage, p, rate)
    const text = textOf(body)
    if (body.status !== 'completed' || !text) {
      log(`openai: status=${String(body.status)} reason=${String(obj(body.incomplete_details).reason)}`)
      return { fail: 'unavailable', costYen }
    }
    return { text, costYen }
  }
}
