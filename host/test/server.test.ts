import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaseView, HomeView, Settings } from '@libretto/shared/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transition } from '../src/case/transition.ts'
import { initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { readKey } from '../src/model/keys.ts'
import { createRuns, Stopped } from '../src/runs.ts'
import { COOKIE, createServer, SESSION_DAYS } from '../src/server/app.ts'
import { createHub } from '../src/server/sse.ts'
import { stopFile, writeStopFile } from '../src/server/stop.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const win = process.platform === 'win32'
let home: string
let ledger: Ledger
let clock: Date
let server: ReturnType<typeof createServer>
let cookie: string
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'libretto-server-'))
  clock = new Date('2026-10-23T03:00:00Z')
  ledger = initHome(home, () => clock)
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<div id="app"></div>')
  writeFileSync(join(staticDir, 'app.js'), 'console.log(1)')
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke: () => Promise.reject(new Error('no model in this test')),
    now: () => clock,
    log: () => {},
    runsWaitMs: 50,
  })
  cookie = await pair()
})
afterEach(() => {
  chmodSync(home, 0o700)
  ledger.close()
})

async function pair(headers: Record<string, string> = {}) {
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname, { headers })
  expect(res.status).toBe(303)
  const set = res.headers.get('set-cookie') ?? ''
  expect(set.startsWith(`${COOKIE}=`)).toBe(true)
  return set.split(';')[0] as string
}
const get = (path: string, c = cookie) => server.app.request(path, { headers: { cookie: c } })
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  server.app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
function request(caseId = 'c1') {
  transition(ledger, {
    type: 'conversation.request',
    eventId: id(),
    caseId,
    title: '記事',
    mode: '確認しながら',
    docType: '記事',
    destination: [{ kind: 'paste' }],
  })
}
const action = (type: string, rest: Record<string, unknown> = {}, caseId = 'c1') =>
  send('POST', `/api/cases/${caseId}/actions`, {
    type,
    eventId: id(),
    expectedRevision: ledger.getCase(caseId)?.revision,
    ...rest,
  })

describe('ペアリングと Cookie（5.4・5.7 (1)）', () => {
  it('Cookie は Path=/・HttpOnly・SameSite=Lax・Max-Age=400 日。HTTP では Secure を付けない', async () => {
    const { url } = server.issuePairing('スマホ')
    const res = await server.app.request(new URL(url).pathname)
    const set = res.headers.get('set-cookie') ?? ''
    expect(set).toMatch(/Path=\//)
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/SameSite=Lax/)
    expect(set).toContain(`Max-Age=${SESSION_DAYS * 86_400}`)
    expect(set).not.toMatch(/Secure/)
    expect(res.headers.get('location')).toBe('/')
  })
  it('HTTPS の後ろ（X-Forwarded-Proto: https）では Secure', async () => {
    const { url } = server.issuePairing('スマホ')
    const res = await server.app.request(new URL(url).pathname, { headers: { 'x-forwarded-proto': 'https' } })
    expect(res.headers.get('set-cookie')).toMatch(/Secure/)
  })
  it('トークンは使い切りで、10 分で失効する', async () => {
    const { url } = server.issuePairing('スマホ')
    const path = new URL(url).pathname
    expect((await server.app.request(path)).status).toBe(303)
    expect((await server.app.request(path)).status).toBe(410)
    const other = new URL(server.issuePairing('もう 1 台').url).pathname
    clock = new Date(clock.getTime() + 10 * 60_000)
    expect((await server.app.request(other)).status).toBe(410)
  })
  it('起動時の URL は pairing.txt に書き、使ったら消す', async () => {
    server.issuePairing('最初の端末', true)
    const url = readFileSync(join(home, 'pairing.txt'), 'utf-8').trim()
    await server.app.request(new URL(url).pathname)
    expect(existsSync(join(home, 'pairing.txt'))).toBe(false)
  })
  it('台帳には Cookie の値ではなく sha256 を書く', () => {
    const value = cookie.split('=')[1] as string
    expect(ledger.sessionCreatedAt(value)).toBeUndefined()
    expect(ledger.sessionCreatedAt(createHash('sha256').update(value).digest('hex'))).toBeDefined()
  })
  it('400 日を過ぎたセッション・外したセッションは 401', async () => {
    expect((await get('/api/home')).status).toBe(200)
    clock = new Date(clock.getTime() + SESSION_DAYS * 86_400_000)
    expect((await get('/api/home')).status).toBe(401)
    clock = new Date('2026-10-23T03:00:00Z')
    const sid = createHash('sha256')
      .update(cookie.split('=')[1] as string)
      .digest('hex')
    expect((await send('DELETE', `/api/devices/${sid}`)).status).toBe(204)
    expect((await get('/api/home')).status).toBe(401)
  })
  it('POST /api/devices は新しい URL を 1 回分出す', async () => {
    const res = await send('POST', '/api/devices', { label: 'スマホ' })
    const { url } = await res.json()
    expect((await server.app.request(new URL(url).pathname)).status).toBe(303)
  })
})

describe('経路の順（5.7 (6)）と Origin（5.4）', () => {
  it('Cookie が無い /api/* は 401 の JSON', async () => {
    const res = await get('/api/home', '')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ reason: 'not_paired' })
  })
  it('画面の殻と静的ファイルは Cookie 無しで返す', async () => {
    expect(await (await get('/', '')).text()).toBe('<div id="app"></div>')
    expect(await (await get('/cases/c1', '')).text()).toBe('<div id="app"></div>')
    expect(await (await get('/app.js', '')).text()).toBe('console.log(1)')
  })
  it('未知の /api/* は HTML ではなく 404 の JSON', async () => {
    const res = await get('/api/nothing')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/json/)
  })
  it('/cases/:id/page は Cookie 必須', async () => {
    expect((await get('/cases/c1/page', '')).status).toBe(401)
  })
  it('GET 以外は Origin が完全一致しなければ 403（Cookie があっても）', async () => {
    for (const origin of ['', 'http://127.0.0.1:7780.evil.test', 'http://localhost:7780']) {
      const res = await send('POST', '/api/stop', undefined, { origin })
      expect(res.status).toBe(403)
    }
    expect((await send('DELETE', '/api/settings/keys/openai', undefined, { origin: 'http://evil.test' })).status).toBe(
      403,
    )
    expect(server.status.stopped).toBe(false)
  })
})

describe('GET /api/home・/api/cases/:id', () => {
  it('空のホームが型どおり', async () => {
    const home = HomeView.parse(await (await get('/api/home')).json())
    expect(home.active).toEqual([])
    expect(home.host).toEqual({ stopped: false, storageOk: true, signIn: false, isolation: 'strong' })
  })
  it('案件があれば active と CaseView に出る', async () => {
    request()
    const home = HomeView.parse(await (await get('/api/home')).json())
    expect(home.active.map((c) => c.id)).toEqual(['c1'])
    const view = CaseView.parse(await (await get('/api/cases/c1')).json())
    expect(view).toMatchObject({ id: 'c1', state: '入口待ち', revision: 0, rounds: { series: 1, used: 0, max: 3 } })
    expect((await get('/api/cases/nothing')).status).toBe(404)
  })
})

describe('POST /api/cases/:id/actions（5.2・5.3.1）', () => {
  beforeEach(() => request())
  it('遷移して ActionResult を返し、case.changed を出す', async () => {
    const seen: string[] = []
    server.hub.subscribe((m) => seen.push(`${m.event} ${m.data}`))
    const res = await action('stop.case')
    expect(await res.json()).toEqual({ state: '停止', turn: '本人', revision: 1, replayed: false })
    expect(seen).toEqual(['case.changed {"caseId":"c1","state":"停止","turn":"本人"}'])
  })
  it('同じ eventId の二度目は replayed: true', async () => {
    const body = { type: 'cancel', eventId: id(), expectedRevision: 0 }
    await send('POST', '/api/cases/c1/actions', body)
    const res = await send('POST', '/api/cases/c1/actions', body)
    expect(await res.json()).toMatchObject({ state: '取り消し', replayed: true })
  })
  it('古い revision は 409 stale と今のカード', async () => {
    const res = await send('POST', '/api/cases/c1/actions', { type: 'cancel', eventId: id(), expectedRevision: 5 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: 'stale', current: { id: 'c1', revision: 0 } })
  })
  it('型に合わない本文は 400、別の案件で使った eventId は 400 conflict、無い案件は 404', async () => {
    expect((await send('POST', '/api/cases/c1/actions', { type: 'cancel' })).status).toBe(400)
    request('c2')
    const eventId = id()
    await send('POST', '/api/cases/c1/actions', { type: 'cancel', eventId, expectedRevision: 0 })
    const res = await send('POST', '/api/cases/c2/actions', { type: 'cancel', eventId, expectedRevision: 0 })
    expect(await res.json()).toEqual({ reason: 'conflict' })
    expect((await action('cancel', { expectedRevision: 0 }, 'nothing')).status).toBe(404)
  })
  it('restart_as_new は newCaseId を返し、二度目も同じ id（5.7 (5)）', async () => {
    await action('stop.case')
    const body = { type: 'restart_as_new', eventId: id(), expectedRevision: 1 }
    const first = await (await send('POST', '/api/cases/c1/actions', body)).json()
    expect(first.newCaseId).toEqual(expect.any(String))
    expect(ledger.getCase(first.newCaseId)?.state).toBe('入口待ち')
    const again = await (await send('POST', '/api/cases/c1/actions', body)).json()
    expect(again).toMatchObject({ replayed: true, newCaseId: first.newCaseId })
  })
  it('stop.case は動いている仕事を中断する', async () => {
    const ac = server.runs.open('c1')
    await action('stop.case')
    expect(ac.signal.aborted).toBe(true)
  })
  it('保存に失敗したら 503 と storageOk: false。次に成功したら戻る（5.7 (8)）', async () => {
    const full = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' })
    const spy = vi.spyOn(ledger, 'transaction').mockImplementationOnce(() => {
      throw full
    })
    const res = await action('cancel')
    expect(res.status).toBe(503)
    expect(await (await get('/api/host')).json()).toEqual({
      stopped: false,
      storageOk: false,
      signIn: false,
      isolation: 'strong',
    })
    spy.mockRestore()
    expect((await action('cancel')).status).toBe(200)
    expect(server.status.storageOk).toBe(true)
  })
})

describe('緊急停止（5.7 (3)）', () => {
  beforeEach(() => request())
  it('POST /api/stop: 新しい実行を断り、実行中を中断し、STOP を書き、全案件を停止', async () => {
    const ac = server.runs.open('c1')
    const res = await send('POST', '/api/stop')
    expect(await res.json()).toEqual({ stopped: true, storageOk: true, signIn: false, isolation: 'strong' })
    expect(ac.signal.aborted).toBe(true)
    expect(() => server.runs.open('c1')).toThrow(Stopped)
    expect(existsSync(stopFile(home))).toBe(true)
    expect(ledger.getCase('c1')).toMatchObject({ state: '停止', stopReason: '緊急停止' })
  })
  // chmod で書けなくするのは POSIX だけ（Windows はディレクトリの権限ビットで作成を止められない）。止める順序は OS に依らない
  it.skipIf(win)('STOP ファイルが書けなくても止まる（保存できない帯を立てる）', async () => {
    chmodSync(home, 0o500) // 新しいファイルを作れない。データベースは既存のファイルなので書ける
    const ac = server.runs.open('c1')
    expect((await send('POST', '/api/stop')).status).toBe(503)
    expect(server.status).toEqual({ stopped: true, storageOk: false, signIn: false, isolation: 'strong' })
    expect(ac.signal.aborted).toBe(true)
    expect(() => server.runs.open('c2')).toThrow(Stopped)
    expect(ledger.getCase('c1')?.state).toBe('停止')
    request('c3') // ほかの書き込みが通っても、STOP が保存できるまで帯は下ろさない
    expect((await action('cancel', {}, 'c3')).status).toBe(200)
    expect(server.status.storageOk).toBe(false)
    chmodSync(home, 0o700)
    await server.stop.tick(true) // 再処理で STOP を書き、帯を下ろす
    expect(existsSync(stopFile(home))).toBe(true)
    expect(server.status.storageOk).toBe(true)
  })
  it('停止の遷移が保存できなくても止まり、30 秒ごとの再処理で遷移する', async () => {
    const full = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' })
    const spy = vi.spyOn(ledger, 'transaction').mockImplementation(() => {
      throw full
    })
    const ac = server.runs.open('c1')
    await send('POST', '/api/stop')
    expect(server.status).toEqual({ stopped: true, storageOk: false, signIn: false, isolation: 'strong' })
    expect(ac.signal.aborted).toBe(true)
    spy.mockRestore()
    // 遷移が残っている間は解けない
    const blocked = vi.spyOn(ledger, 'transaction').mockImplementation(() => {
      throw full
    })
    expect((await send('DELETE', '/api/stop')).status).toBe(503)
    expect(server.status.stopped).toBe(true)
    blocked.mockRestore()
    await server.stop.tick(false)
    expect(ledger.getCase('c1')?.state).toBe('入口待ち') // 2 秒の見回りでは再処理しない
    await server.stop.tick(true)
    expect(ledger.getCase('c1')?.state).toBe('停止')
    expect(server.status.storageOk).toBe(true)
  })
  it('外からの STOP（libretto stop）は見回りで検知し、検知の前でも新しい実行を断る', async () => {
    const ac = server.runs.open('c1')
    writeStopFile(home)
    expect(() => server.runs.open('c2')).toThrow(Stopped)
    await server.stop.tick(false)
    expect(server.status.stopped).toBe(true)
    expect(ac.signal.aborted).toBe(true)
    expect(ledger.getCase('c1')?.state).toBe('停止')
  })
  it('見回りの前に外から置かれた STOP は、解く前に効かせる', async () => {
    const ac = server.runs.open('c1')
    writeStopFile(home)
    expect((await send('DELETE', '/api/stop')).status).toBe(200)
    expect(ac.signal.aborted).toBe(true)
    expect(ledger.getCase('c1')?.state).toBe('停止')
    expect(existsSync(stopFile(home))).toBe(false)
  })
  it('起動時に STOP があれば止まった状態で始め、残りの案件を止める', () => {
    writeStopFile(home)
    server.stop.boot()
    expect(server.status.stopped).toBe(true)
    expect(ledger.getCase('c1')?.state).toBe('停止')
  })
  it('DELETE /api/stop は STOP を消してから解く。案件は再開しない', async () => {
    await send('POST', '/api/stop')
    const res = await send('DELETE', '/api/stop')
    expect(await res.json()).toEqual({ stopped: false, storageOk: true, signIn: false, isolation: 'strong' })
    expect(existsSync(stopFile(home))).toBe(false)
    expect(ledger.getCase('c1')?.state).toBe('停止')
    expect(() => server.runs.open('c1')).not.toThrow()
  })
  it('host.changed を出す', async () => {
    const seen: string[] = []
    server.hub.subscribe((m) => seen.push(`${m.event} ${m.data}`))
    await send('POST', '/api/stop')
    expect(seen).toContain('host.changed {"stopped":true,"storageOk":true,"signIn":false,"isolation":"strong"}')
  })
})

describe('実行の登録簿（5.7 (4)）', () => {
  it('abort は watch された終わりを待つ。待ち切れなければ案件の id を返す', async () => {
    const runs = createRuns(() => false, 50)
    const ac = runs.open('c1')
    let exit = () => {}
    runs.watch('c1', new Promise<void>((r) => (exit = r)))
    const waiting = runs.abort('c1')
    expect(ac.signal.aborted).toBe(true)
    exit()
    expect(await waiting).toEqual([])
    runs.open('c2')
    runs.watch('c2', new Promise(() => {}))
    expect(await runs.abortAll()).toEqual(['c2'])
  })
})

describe('SSE（5.7 (2)）', () => {
  it('送り直せるのは今の起動で、保持の範囲にある id だけ', () => {
    const hub = createHub(2)
    expect(hub.since(undefined)).toBeUndefined()
    const start = hub.lastId()
    hub.emit('candidates.changed', {})
    hub.emit('candidates.changed', {})
    expect(hub.since(start)?.length).toBe(2)
    hub.emit('candidates.changed', {})
    expect(hub.since(start)).toBeUndefined() // 保持より古い
    expect(hub.since(hub.lastId())).toEqual([])
    expect(hub.since('00000000:1')).toBeUndefined() // 別の起動
    expect(hub.since('garbage')).toBeUndefined()
  })
  async function firstChunk(headers: Record<string, string>) {
    const ctl = new AbortController()
    const res = await server.app.request('/api/events', { headers: { cookie, ...headers }, signal: ctl.signal })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const { value } = await reader.read()
    ctl.abort()
    await reader.cancel()
    return new TextDecoder().decode(value)
  }
  it('Last-Event-ID が無ければ最初に resync', async () => {
    expect(await firstChunk({})).toMatch(/event: resync/)
  })
  it('外した端末のつなぎは、次の合図で切る', async () => {
    const res = await server.app.request('/api/events', { headers: { cookie } })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read() // resync
    const sid = createHash('sha256')
      .update(cookie.split('=')[1] as string)
      .digest('hex')
    ledger.appendSession('revoked', sid)
    server.hub.emit('candidates.changed', {})
    expect((await reader.read()).done).toBe(true)
  })
  it('今の起動の id なら、その後のイベントを送り直す', async () => {
    const lastId = server.hub.lastId()
    server.hub.emit('candidates.changed', {})
    expect(await firstChunk({ 'last-event-id': lastId })).toMatch(/event: candidates.changed/)
  })
})

describe('API キー（5.2・5.7 (7)(9)）', () => {
  const KEY = 'sk-test-abcdefgh12345678'
  it('PUT は last4 だけを返し、0600 の api-keys.json に書く', async () => {
    const seen: string[] = []
    server.hub.subscribe((m) => seen.push(m.data))
    const res = await send('PUT', '/api/settings/keys/openai', { value: `  ${KEY}\n` })
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ kind: 'openai', set: true, last4: '5678' })
    expect(text).not.toContain(KEY)
    expect(seen.join()).not.toContain(KEY)
    expect(readKey(home, 'openai')).toBe(KEY)
    // 0600 は POSIX だけ。素の Windows はプロファイルの既定の権限に任せる（9.2）
    if (!win) expect(statSync(join(home, 'api-keys.json')).mode & 0o777).toBe(0o600)
  })
  it('GET は両方の状態を末尾 4 文字だけで返す。Cookie が無ければ通さない', async () => {
    await send('PUT', '/api/settings/keys/openai', { value: KEY })
    const res = await send('GET', '/api/settings/keys')
    const text = await res.text()
    expect(Settings.shape.apiKeys.parse(JSON.parse(text))).toEqual({
      openai: { kind: 'openai', set: true, last4: '5678', savedAt: expect.any(String) },
      jev: { kind: 'jev', set: false },
      slack: { kind: 'slack', set: false },
    })
    expect(text).not.toContain(KEY)
    expect((await server.app.request('/api/settings/keys')).status).toBe(401)
  })
  it('8 文字未満・空白入り・印字できない文字入りは 400 で保存しない。応答に値を入れない', async () => {
    for (const value of ['', 'abcdefg', 'abcd efgh', 'abcd\u0000efgh', 'abcdefgh\u3042']) {
      const res = await send('PUT', '/api/settings/keys/jev', { value })
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain(value || '""')
    }
    expect(readKey(home, 'jev')).toBeUndefined()
  })
  it('DELETE で消える。未知の kind は 404', async () => {
    await send('PUT', '/api/settings/keys/jev', { value: KEY })
    expect(await (await send('DELETE', '/api/settings/keys/jev')).json()).toEqual({ kind: 'jev', set: false })
    expect(readKey(home, 'jev')).toBeUndefined()
    expect((await send('PUT', '/api/settings/keys/other', { value: KEY })).status).toBe(404)
  })
})
