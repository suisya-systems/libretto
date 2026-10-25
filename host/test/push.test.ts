// 画面を閉じていても届く通知（docs/implementation.md 6.8 (6)(13)）。偽の配信元（プロセス内の HTTP サーバー）に送り、
// 端末の鍵で本文を復号して確かめる。登録が無い（404 / 410）・混んでいる（429）・届かない・外した端末・見ている端末
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Input, transition } from '../src/case/transition.ts'
import { initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createServer } from '../src/server/app.ts'
import { createPush } from '../src/server/push.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const b64 = (b: Buffer) => b.toString('base64url')

// 偽の配信元。返す status を順に積む（空なら 201）
let fake: Server
let base: string
let got: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[]
let replies: number[]
beforeEach(async () => {
  got = []
  replies = []
  fake = createHttp((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      got.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(replies.shift() ?? 201).end()
    })
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
})
afterEach(() => new Promise<void>((r) => fake.close(() => r())))
// https://push.test/... を偽の配信元へ（配信元は https だけ受け付ける）
const pushFetch: typeof fetch = (url, init) => fetch(String(url).replace('https://push.test', base), init)

// ブラウザの側の鍵（PushSubscription の p256dh と auth）
function browser(path = '/sub/a') {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const sub = { endpoint: `https://push.test${path}`, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } }
  // aes128gcm（RFC 8188・8291）を端末の鍵で解く
  const decrypt = (body: Buffer) => {
    const salt = body.subarray(0, 16)
    const idlen = body[20] as number
    const serverKey = body.subarray(21, 21 + idlen)
    const data = body.subarray(21 + idlen)
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), serverKey])
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverKey), auth, info, 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(data.subarray(-16))
    const plain = Buffer.concat([d.update(data.subarray(0, -16)), d.final()])
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf-8'))
  }
  return { sub, decrypt }
}

let home: string
let ledger: Ledger
let clock: Date
let server: ReturnType<typeof createServer>
beforeEach(() => {
  clock = new Date('2026-10-23T03:00:00Z')
  home = mkdtempSync(join(tmpdir(), 'libretto-push-'))
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '')
  ledger = initHome(home, () => clock)
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke: () => Promise.reject(new Error('no model')),
    now: () => clock,
    log: () => {},
    pushFetch,
  })
})
afterEach(() => ledger.close())

async function pair() {
  const { url } = server.issuePairing('t')
  const cookie = ((await server.app.request(new URL(url).pathname)).headers.get('set-cookie') ?? '').split(
    ';',
  )[0] as string
  return { cookie, origin: ORIGIN, 'content-type': 'application/json' }
}
const subscribe = (headers: Record<string, string>, sub: unknown) =>
  server.app.request('/api/devices/push', { method: 'PUT', headers, body: JSON.stringify(sub) })
const status = async (headers: Record<string, string>) =>
  (await server.app.request('/api/devices/push', { headers })).json()

// 費用上限で止まった（画面の外へ出す知らせ）
let k = 0
function stopped(caseId = `c${++k}`) {
  for (const ev of [
    {
      type: 'conversation.request',
      eventId: `${caseId}:req`,
      caseId,
      title: '週報',
      mode: 'おまかせ',
      docType: '記事',
      destination: [{ kind: 'paste' }],
    },
    { type: 'cost.cap', by: '費用', caseId, eventId: `${caseId}:cap`, scope: '案件', callId: 'k' },
  ])
    expect(transition(ledger, ev as Input)).toMatchObject({ ok: true })
}
const MIN = 60_000

describe('登録と送る（6.8 (6)(13)）', () => {
  it('公開鍵は初めて要るときに作り 0600 で持つ。登録した端末に、暗号化して VAPID で署名して送る', async () => {
    const headers = await pair()
    const s1 = await status(headers)
    expect(s1).toMatchObject({ subscribed: false, unreachable: false })
    expect(Buffer.from(s1.publicKey, 'base64url')).toHaveLength(65)
    if (process.platform !== 'win32') expect(statSync(join(home, 'push-keys.json')).mode & 0o777).toBe(0o600)
    expect((await status(headers)).publicKey).toBe(s1.publicKey) // 作り直さない

    const { sub, decrypt } = browser()
    expect((await subscribe(headers, { ...sub, endpoint: 'http://push.test/x' })).status).toBe(400) // https だけ
    expect((await subscribe(headers, sub)).status).toBe(204)
    expect(await status(headers)).toMatchObject({ subscribed: true })

    stopped()
    await server.notices.flush()
    expect(got).toHaveLength(1)
    const r = got[0] ?? expect.unreachable()
    expect(r.path).toBe('/sub/a')
    expect(r.headers['content-encoding']).toBe('aes128gcm')
    expect(r.headers.ttl).toBe(String(24 * 60 * 60))
    expect(r.headers.authorization).toMatch(new RegExp(`^vapid t=.+, k=${s1.publicKey}$`))
    expect(decrypt(r.body)).toEqual({
      id: 1,
      caseId: 'c1',
      path: '/cases/c1',
      text: expect.stringContaining('『週報』'),
    })
  })

  it('404 / 410 は登録を消して送らない。429 は送り直し、届かなければ設定に出す', async () => {
    const headers = await pair()
    await status(headers)
    await subscribe(headers, browser().sub)
    replies = [429]
    stopped()
    await server.notices.flush()
    expect(got).toHaveLength(1)
    expect(ledger.dueDeliveries(new Date(clock.getTime() + MIN))).toMatchObject([{ tries: 1 }])

    clock = new Date(clock.getTime() + MIN)
    replies = [410]
    await server.notices.flush()
    expect(got).toHaveLength(2)
    expect(await status(headers)).toMatchObject({ subscribed: false })
    expect(ledger.dueDeliveries(new Date(clock.getTime() + 60 * MIN))).toEqual([])

    // 届かない（配信元に出られない）は送り直し、設定に出す。届いたら下ろす
    await subscribe(headers, browser('/sub/b').sub)
    fake.close()
    stopped()
    await server.notices.flush()
    expect(await status(headers)).toMatchObject({ unreachable: true })
    expect(ledger.dueDeliveries(new Date(clock.getTime() + MIN))).toMatchObject([{ tries: 1 }])
  })

  it('外した端末・ペアリングし直した前の端末には送らない', async () => {
    const a = await pair()
    await status(a)
    const { sub } = browser()
    await subscribe(a, sub)
    const sidA = ledger.pushSessions()[0] ?? expect.unreachable()
    // 同じブラウザでペアリングし直して登録すると、前の端末の登録は消える
    const b = await pair()
    await subscribe(b, sub)
    expect(ledger.pushSessions()).toHaveLength(1)
    expect(ledger.pushSessions()[0]).not.toBe(sidA)

    stopped() // 送り残しを作ってから外す
    const sidB = ledger.pushSessions()[0] ?? expect.unreachable()
    expect((await server.app.request(`/api/devices/${sidB}`, { method: 'DELETE', headers: a })).status).toBe(204)
    expect(ledger.pushSessions()).toEqual([])
    await server.notices.flush()
    expect(got).toEqual([])
    expect(ledger.dueDeliveries(new Date(clock.getTime() + 60 * MIN))).toEqual([])
  })

  it('400 日を過ぎた端末には送らず、登録を消す', async () => {
    const headers = await pair()
    await status(headers)
    await subscribe(headers, browser().sub)
    clock = new Date(clock.getTime() + 400 * 86_400_000 - MIN)
    stopped()
    clock = new Date(clock.getTime() + 2 * MIN)
    await server.notices.flush()
    expect(got).toEqual([])
    expect(ledger.pushSessions()).toEqual([])
  })
})

describe('見ている端末（6.8 (2)）', () => {
  it('つながっているタブが見ていれば送らない。切れたら見ていない。切れた後に届いた POST では生き返らない', async () => {
    const sent: string[] = []
    const push = createPush({
      home,
      ledger,
      valid: () => true,
      fetch: async (url) => {
        sent.push(String(url))
        return new Response(null, { status: 201 })
      },
    })
    ledger.putPushSubscription('s1', { endpoint: 'https://push.test/a', ...browser().sub.keys })
    const n = { id: 1, at: '', text: 't', kind: 'done' as const, path: '/', outside: true }
    push.presence.set('s1', 'tab', 1, true) // つながっていないタブ
    expect(await push.sender('push:s1', [n])).toBe('sent')
    expect(sent).toHaveLength(1)

    const away = push.presence.connect('s1', 'tab')
    const other = push.presence.connect('s1', 'back') // 裏のタブ
    push.presence.set('s1', 'tab', 2, true)
    push.presence.set('s1', 'back', 3, false)
    expect(await push.sender('push:s1', [n])).toBe('sent')
    expect(sent).toHaveLength(1)
    // 遅れて届いた前の POST（番号が古い）では上書きしない
    push.presence.set('s1', 'tab', 1, false)
    expect(await push.sender('push:s1', [n])).toBe('sent')
    expect(sent).toHaveLength(1)

    // つなぎ直し: 新しいつなぎの後に前のつなぎの切れが届いても、新しいほうを消さない
    const again = push.presence.connect('s1', 'tab')
    away()
    push.presence.set('s1', 'tab', 4, true)
    expect(await push.sender('push:s1', [n])).toBe('sent')
    expect(sent).toHaveLength(1)

    again()
    push.presence.set('s1', 'tab', 5, true)
    expect(await push.sender('push:s1', [n])).toBe('sent')
    expect(sent).toHaveLength(2)
    other()
  })

  it('送っている間に外した送り先は、遅れて返った結果で pending に戻らない', () => {
    ledger.putPushSubscription('s1', { endpoint: 'https://push.test/a', ...browser().sub.keys })
    ledger.noticeRoute = { on: () => true, targets: () => ['push:s1'] }
    stopped()
    ledger.deletePushSubscription('s1')
    ledger.setDelivery(1, 'push:s1', { status: 'pending', tries: 1, nextAt: clock })
    expect(ledger.dueDeliveries(new Date(clock.getTime() + 60 * MIN))).toEqual([])
  })
})
