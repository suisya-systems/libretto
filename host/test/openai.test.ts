// openai の中身を、プロセス内の偽 OpenAI で確かめる（docs/implementation.md 6.1.3・11.1）
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDb } from '../src/ledger/db.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { type Call, createInvoke, type Job } from '../src/model/invoke.ts'
import { createOpenai } from '../src/model/openai.ts'

const KEY = 'sk-test-0123456789abcdWXYZ'
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
let server: Server
let base: string
let handler: Handler
let seen: { url: string | undefined; auth: string | undefined; body: Record<string, unknown> }[]
let logs: string[]

beforeEach(async () => {
  seen = []
  logs = []
  server = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => {
      b += c
    })
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) })
      handler(req, b, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => server.close(() => r())))

const reply = (status: number, body: unknown) =>
  (handler = (_q, _b, res) => res.writeHead(status).end(JSON.stringify(body)))
const ok = (text: string, usage: unknown = { input_tokens: 1000, output_tokens: 2000 }) =>
  reply(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage })

const call = (over: Partial<Call> = {}): Call => ({
  callId: 'k1',
  role: '下書き役・確認項目',
  caseId: 'c1',
  instruction: '確認項目を JSON で',
  materials: [{ name: '依頼', text: '記事を書く' }],
  access: 'none',
  family: 'openai',
  model: 'codex',
  maxYen: 160,
  signal: new AbortController().signal,
  ...over,
})
const backend = (key: () => string | undefined = () => KEY) =>
  createOpenai({ key, usdJpy: () => 150, baseUrl: base, log: (l) => logs.push(l) })

describe('openai の中身', () => {
  it('Responses API に JSON モード・store なし・出力の枠付きで送り、usage から円にする', async () => {
    ok('{"checks":[]}')
    const r = await backend()(call())
    // 1000 × 10 + 2000 × 50 = 110,000 ドル / 100 万 → 0.11 ドル × 150
    expect(r).toEqual({ text: '{"checks":[]}', costYen: expect.closeTo(16.5, 6) })
    const s = seen[0]
    expect(s?.url).toBe('/v1/responses')
    expect(s?.auth).toBe(`Bearer ${KEY}`)
    expect(s?.body).toMatchObject({
      model: 'gpt-6-astra',
      text: { format: { type: 'json_object' } },
      store: false,
      prompt_cache_options: { mode: 'explicit' },
    })
    expect(s?.body.input).toContain('<材料 name="依頼">\n記事を書く\n</材料>')
    // 入力の上限 × 12.5 ＋ 出力の枠 × 50 が予約額（160 円 = 1.0667 ドル）に収まる
    const input = String(s?.body.input).length
    const max = s?.body.max_output_tokens as number
    expect((input * 12.5 + max * 50) / 1e6).toBeLessThanOrEqual(160 / 150)
    expect(max).toBeGreaterThan(15_000)
  })

  it('キャッシュの読み・書きを別の単価で数え、usage が欠ければ null', async () => {
    ok('{}', {
      input_tokens: 1000,
      output_tokens: 0,
      input_tokens_details: {
        cached_tokens: 200,
        cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 100 },
      },
    })
    // 400 × 10 + 200 × 1 + 300 × 12.5 + 100 × 25 = 10,450
    expect(await backend()(call())).toMatchObject({ costYen: expect.closeTo((10_450 / 1e6) * 150, 9) })
    ok('{}', { input_tokens: -1, output_tokens: 3 })
    expect(await backend()(call())).toMatchObject({ costYen: null })
  })

  it('失敗の状態コードごとに unavailable。混雑だけ rate_limited。log に鍵と message を書かない', async () => {
    const cases: [number, unknown, object][] = [
      [401, { error: { message: `Incorrect API key provided: sk-tes***WXYZ`, code: 'invalid_api_key' } }, {}],
      [429, { error: { message: 'quota', code: 'insufficient_quota', type: 'insufficient_quota' } }, {}],
      [429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, { why: 'rate_limited' }],
      [500, { error: { message: 'oops' } }, { why: 'rate_limited' }],
      [503, 'not json', { why: 'rate_limited' }],
      [400, { error: { message: 'bad' } }, {}],
    ]
    for (const [status, body, extra] of cases) {
      reply(status, body)
      expect(await backend()(call())).toEqual({ fail: 'unavailable', costYen: 0, ...extra })
    }
    expect(logs.join('\n')).toContain('http 401 code=invalid_api_key')
    expect(logs.join('\n')).not.toMatch(/WXYZ|Incorrect|quota provided|slow down/)
  })

  it('completed でない・文が無い・本文が JSON でないなら unavailable', async () => {
    reply(200, {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    expect(await backend()(call())).toMatchObject({ fail: 'unavailable', costYen: expect.any(Number) })
    ok('')
    expect(await backend()(call())).toMatchObject({ fail: 'unavailable' })
    handler = (_q, _b, res) => res.writeHead(200).end('{broken')
    expect(await backend()(call())).toEqual({ fail: 'unavailable', costYen: null })
  })

  it('鍵が無い・入力が大きすぎるときは送らずに 0 円', async () => {
    ok('{}')
    expect(await backend(() => undefined)(call())).toEqual({ fail: 'unavailable', costYen: 0 })
    expect(await backend()(call({ materials: [{ name: '依頼', text: 'あ'.repeat(90_000) }] }))).toEqual({
      fail: 'unavailable',
      costYen: 0,
    })
    expect(seen).toEqual([])
  })

  it('ファイルの材料と access none 以外は受けない', async () => {
    await expect(backend()(call({ access: 'read', workdir: '/w' }))).rejects.toThrow('openai:')
    await expect(backend()(call({ materials: [{ name: 'f', file: '/w/a.png', mime: 'image/png' }] }))).rejects.toThrow()
  })

  it('止めたら signal の理由で拒否する', async () => {
    handler = () => {} // 返さない
    const ac = new AbortController()
    const p = backend()(call({ signal: ac.signal }))
    await new Promise((r) => setTimeout(r, 20))
    ac.abort(new Error('stop'))
    await expect(p).rejects.toThrow('stop')
  })
})

describe('invoke を通した openai', () => {
  let ledger: Ledger
  beforeEach(() => {
    ledger = new Ledger(openDb(':memory:'), () => new Date('2026-10-23T03:00:00Z'))
    ledger.insertCase({
      eventId: 'c1:created',
      caseId: 'c1',
      title: '記事',
      state: '入口待ち',
      turn: 'libretto',
      step: '',
      mode: '確認しながら',
      origin: { kind: '会話' },
      auto: false,
      docType: '記事',
      destination: [{ kind: 'paste' }],
    })
  })
  const job: Job = {
    role: '下書き役・確認項目',
    caseId: 'c1',
    instruction: '確認項目を JSON で',
    materials: [],
    access: 'none',
    output: { kind: 'json', schema: z.object({ checks: z.array(z.unknown()) }) },
    limits: { maxYen: 160, timeoutMs: 5000 },
    signal: new AbortController().signal,
  }
  let n = 0
  const make = (key: () => string | undefined, url = base) =>
    createInvoke({
      ledger,
      backends: { openai: createOpenai({ key, usdJpy: () => 150, baseUrl: url, log: (l) => logs.push(l) }) },
      caps: () => ({ caseCapYen: null, monthCapYen: null }),
      onCostCap: () => {},
      log: (l) => logs.push(l),
      newCallId: () => `k${++n}`,
      retryWaitMs: 1,
    })

  it('混雑なら 1 回だけ再試行し、費用の行は openai の系統で残る', async () => {
    let n = 0
    handler = (_q, _b, res) => {
      n++
      if (n === 1) res.writeHead(429).end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))
      else
        res.writeHead(200).end(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"checks":[]}' }] }],
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        )
    }
    const out = await make(() => KEY)(job)
    expect(out).toMatchObject({ ok: true, json: { checks: [] }, family: 'openai', model: 'codex', costYen: 0 })
    expect(ledger.listCosts('c1').filter((c) => c.type === 'hold')).toMatchObject([
      { family: 'openai' },
      { family: 'openai' },
    ])
  })

  it('再試行の待ちのあいだに鍵を消したら、2 回目は送らず 0 円で精算する', async () => {
    reply(429, { error: { code: 'rate_limit_exceeded' } })
    let k: string | undefined = KEY
    const invoke = make(() => {
      const v = k
      k = undefined
      return v
    })
    expect(await invoke(job)).toMatchObject({ ok: false, kind: 'unavailable', costYen: 0 })
    expect(seen).toHaveLength(1)
    expect(ledger.listCosts('c1').filter((c) => c.type === 'charge')).toMatchObject([{ yen: 0 }, { yen: 0 }])
  })

  it('網の失敗と、見出しに置けない文字の鍵でも、log に鍵が出ない', async () => {
    const bad = 'sk-\u0000secretSECRET9876'
    await make(() => bad)(job)
    const closed = `http://127.0.0.1:1`
    await make(() => KEY, closed)(job)
    const all = logs.join('\n')
    expect(all).toContain('openai: network')
    expect(all).not.toContain('secretSECRET')
    expect(all).not.toContain(KEY)
  })
})
