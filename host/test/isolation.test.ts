// 隔離の点検（docs/implementation.md 8.4・8.10 (4)(5)）。中身は偽の invoke、HTTP は createServer を叩く
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionsView } from '@libretto/shared/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { causeOf, checkIsolation, type IsolationRecord, isolationFile, probeDir } from '../src/checks/isolation.ts'
import { initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import type { Job, Outcome } from '../src/model/invoke.ts'
import type { SandboxCheck } from '../src/model/sandbox.ts'
import { createServer } from '../src/server/app.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'libretto-isolation-'))
})

const strong: SandboxCheck = { isolation: 'strong', claudeOk: true }
const meta = { costYen: 0, family: 'claude' as const, model: 'm' }
const token = () => readFileSync(join(probeDir(home), 'checks', 'checks.json'), 'utf-8').trim()
const sentinel = (job: Job) => readFileSync(join(job.workdir ?? '', 'reached.md'), 'utf-8').trim()
// 棚卸しの返答。reached: 作業場を読んだか、seen: checks の語が見えたか
const reply =
  (o: { reached?: boolean; seen?: boolean; home?: string[]; fail?: boolean; writeToken?: boolean } = {}) =>
  async (job: Job): Promise<Outcome> => {
    if (o.fail) return { ok: false, kind: 'unavailable', detail: 'x', ...meta }
    if (o.writeToken) writeFileSync(join(job.workdir ?? '', 'copy.txt'), token())
    const json = {
      work: o.reached === false ? [] : [{ name: 'reached.md', firstLine: sentinel(job) }],
      file: o.seen ? token() : '開けない',
      home: o.home ?? ['.claude'],
    }
    job.onReply?.(JSON.stringify(json))
    return { ok: true, text: JSON.stringify(json), json, ...meta }
  }
const run = (
  main: (job: Job) => Promise<Outcome>,
  control: (job: Job) => Promise<Outcome> = reply({ seen: true }),
  check: SandboxCheck = strong,
  signal = new AbortController().signal,
) =>
  checkIsolation(
    { home, check: () => check, invoke: main, control, homeNames: () => ['.claude', '.claude.json'] },
    signal,
  )

describe('checkIsolation の判定', () => {
  it('作業場を読み、語が見えず、ホームが許した顔ぶれで、対照で語が見えれば hidden。語は記録に入らない', async () => {
    const calls: Job[] = []
    const r = await run(async (j) => {
      calls.push(j)
      return reply()(j)
    })
    expect(r).toMatchObject({
      verdict: 'hidden',
      session: true,
      reached: true,
      hidden: true,
      homeOk: true,
      control: true,
    })
    expect(calls[0]).toMatchObject({ role: '隔離の点検', caseId: '点検', access: 'write' })
    expect(calls[0]?.instruction).toContain(join(probeDir(home), 'checks', 'checks.json'))
    expect(JSON.stringify(r)).not.toContain(token())
  })

  it.each([
    ['返答に語が出た', reply({ seen: true }), {}],
    ['作業場に語を写した', reply({ writeToken: true }), {}],
    ['ホームに許していない名前があった', reply({ home: ['.claude', '.ssh'] }), { extraHome: ['.ssh'] }],
  ])('%s → visible', async (_, main, more) => {
    expect(await run(main)).toMatchObject({ verdict: 'visible', ...more })
  })

  it('言い直しの前の回にだけ語が出ても visible', async () => {
    const main = async (j: Job) => {
      j.onReply?.(`{broken ${token()}`)
      return reply()(j)
    }
    expect((await run(main))?.verdict).toBe('visible')
  })

  it('対照が作業場に書いた語は、本番の漏れに数えない', async () => {
    expect((await run(reply(), reply({ seen: true, writeToken: true })))?.verdict).toBe('hidden')
  })

  it('見えた証拠は対照が死んでいても visible', async () => {
    expect(await run(reply({ seen: true }), reply({ fail: true }))).toMatchObject({
      verdict: 'visible',
      control: false,
    })
  })

  it.each([
    ['本番が起動しない', reply({ fail: true }), reply({ seen: true })],
    ['作業場を読んでいない（空の棚卸し）', reply({ reached: false, home: [] }), reply({ seen: true })],
    ['対照で語が見えない（検出の経路が死んでいる）', reply(), reply()],
  ])('%s → unknown', async (_, main, control) => {
    expect((await run(main, control))?.verdict).toBe('unknown')
  })

  it.each([
    { isolation: 'broken', reason: 'network', claudeOk: true },
    { isolation: 'strong', claudeOk: false },
  ] as SandboxCheck[])('作り手を起こさない状態（%o）では呼ばずに unknown', async (check) => {
    const main = vi.fn(reply())
    expect(await run(main, main, check)).toMatchObject({ verdict: 'unknown', level: check.isolation })
    expect(main).not.toHaveBeenCalled()
  })

  it('止められたら undefined（記録しない）', async () => {
    const ac = new AbortController()
    const main = async (j: Job) => {
      ac.abort()
      return reply()(j)
    }
    expect(await run(main, reply({ seen: true }), strong, ac.signal)).toBeUndefined()
  })

  it('自己点検の理由を画面の原因に丸める', () => {
    expect(['windows', 'missing:bwrap', 'missing:rg', 'userns', 'srt:boom', 'network', undefined].map(causeOf)).toEqual(
      ['windows', 'tools', 'tools', 'userns', 'srt', 'network', undefined],
    )
  })
})

describe('POST /api/checks/run と GET /api/connections', () => {
  const ORIGIN = 'http://127.0.0.1:7780'
  let ledger: Ledger
  let server: ReturnType<typeof createServer>
  let cookie: string
  let release: () => void
  let started: number
  const record: IsolationRecord = {
    at: '2026-10-24T10:00:00.000Z',
    level: 'weak',
    verdict: 'hidden',
    session: true,
    reached: true,
    hidden: true,
    homeOk: true,
    control: true,
    extraHome: [],
  }
  beforeEach(async () => {
    ledger = initHome(home)
    const staticDir = join(home, 'dist')
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '<div></div>')
    started = 0
    server = createServer({
      home,
      ledger,
      origins: [ORIGIN],
      staticDir,
      invoke: () => Promise.reject(new Error('no model')),
      log: () => {},
      runsWaitMs: 200,
      isolation: 'weak',
      cause: 'windows',
      probe: (signal) =>
        new Promise((done) => {
          started++
          release = () => done(record)
          signal.addEventListener('abort', () => done(undefined), { once: true })
        }),
    })
    const { url } = server.issuePairing('テスト')
    cookie = ((await server.app.request(new URL(url).pathname)).headers.get('set-cookie') ?? '').split(';')[0] as string
  })
  afterEach(async () => {
    await server.runs.abortAll()
    ledger.close()
  })
  const post = (path: string) => server.app.request(path, { method: 'POST', headers: { cookie, origin: ORIGIN } })
  const view = async () =>
    ConnectionsView.parse(await (await server.app.request('/api/connections', { headers: { cookie } })).json())

  it('202 で裏で 1 本。走っている間の POST は同じ 1 本に乗り、終われば isolation.json と last', async () => {
    expect(await view()).toEqual({ isolation: { level: 'weak', cause: 'windows', running: false } })
    expect((await post('/api/checks/run')).status).toBe(202)
    expect((await post('/api/checks/run')).status).toBe(202)
    expect(started).toBe(1)
    expect((await view()).isolation.running).toBe(true)
    release()
    await vi.waitFor(async () => expect((await view()).isolation.running).toBe(false))
    expect((await view()).isolation.last).toEqual({ at: record.at, verdict: 'hidden' })
    expect(JSON.parse(readFileSync(isolationFile(home), 'utf-8'))).toEqual(record)
  })

  it('すべて停止で切れたら記録しない。止めている間の POST は 409', async () => {
    expect((await post('/api/checks/run')).status).toBe(202)
    expect((await post('/api/stop')).status).toBe(200)
    await vi.waitFor(async () => expect((await view()).isolation.running).toBe(false))
    expect((await view()).isolation.last).toBeUndefined()
    expect(await (await post('/api/checks/run')).json()).toEqual({ reason: 'stopped' })
    expect(started).toBe(1)
  })
})
