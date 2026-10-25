// お知らせの Slack の DM（docs/implementation.md 6.8 (8)(12)）。偽の Slack と偽の時計で、ボットトークンの欄・確かめ・2 分のまとめ・送り直し
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionsView, type DeliveryTarget, type Notice } from '@libretto/shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Input, transition } from '../src/case/transition.ts'
import { createSlack } from '../src/intake/slack.ts'
import { initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { readKey, setKey } from '../src/model/keys.ts'
import { createServer } from '../src/server/app.ts'
import { SLACK_DM, slackDmText } from '../src/server/slack-dm.ts'
import { ME, startFakeSlack } from './fakes/slack.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const TAILNET = 'https://libretto.example.ts.net'
const MIN = 60_000
let home: string
let ledger: Ledger
let clock: Date
let s: Awaited<ReturnType<typeof startFakeSlack>>
let server: ReturnType<typeof createServer>
let cookie: string
let n = 0

async function setup(o: { user?: boolean; bot?: boolean; origins?: string[] } = {}) {
  home = mkdtempSync(join(tmpdir(), 'libretto-slack-dm-'))
  clock = new Date('2026-10-25T03:00:00Z')
  ledger = initHome(home, () => clock)
  if (o.user !== false) setKey(home, 'slack', 'xoxp-good')
  if (o.bot) setKey(home, 'slackBot', 'xoxb-good')
  s = await startFakeSlack()
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '')
  server = createServer({
    home,
    ledger,
    origins: o.origins ?? [ORIGIN],
    staticDir,
    invoke: () => Promise.reject(new Error('no model')),
    slack: createSlack({ token: () => readKey(home, 'slack'), api: s.api }),
    slackBot: createSlack({ token: () => readKey(home, 'slackBot'), api: s.api }),
    now: () => clock,
    log: () => {},
  })
  const { url } = server.issuePairing('テスト')
  cookie = ((await server.app.request(new URL(url).pathname)).headers.get('set-cookie') ?? '').split(';')[0] as string
}
afterEach(async () => {
  ledger?.close()
  await s?.close()
})

const get = (path: string) => server.app.request(path, { headers: { cookie } })
const send = (method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
const dm = async () => ConnectionsView.parse(await (await get('/api/connections')).json()).slackDm.state
const settled = (state: string) => vi.waitFor(async () => expect(await dm()).toBe(state))

const paste: DeliveryTarget = { kind: 'paste' }
const run = (ev: Record<string, unknown>) => expect(transition(ledger, ev as Input)).toMatchObject({ ok: true })
const request = (caseId: string, title: string, mode = 'おまかせ') =>
  run({ type: 'conversation.request', eventId: `e${++n}`, caseId, title, mode, docType: '記事', destination: [paste] })
// 費用の上限で中止（本人の操作でないので画面の外へ出す）
const stop = (caseId: string) =>
  run({ type: 'cost.cap', by: '費用', caseId, eventId: `${caseId}:cost.cap:${++n}`, scope: '案件', callId: 'k' })
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

describe('ボットトークンの欄と確かめ（6.8 (7)(8)）', () => {
  it('xoxb- で始まらない値は 400 で保存しない。保存すると Slack で確かめて「通知します」、消すと無し', async () => {
    await setup()
    expect(await dm()).toBe('none')
    expect((await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxp-good-user' })).status).toBe(400)
    expect(readKey(home, 'slackBot')).toBeUndefined()
    const put = await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxb-good' })
    expect(put.status).toBe(200)
    expect(await put.text()).not.toContain('xoxb-good')
    await settled('on')
    expect(s.seen.filter((x) => x.method === 'auth.test').map((x) => x.auth)).toContain('Bearer xoxb-good')
    expect((await send('DELETE', '/api/settings/keys/slackBot')).status).toBe(200)
    expect(await dm()).toBe('none')
  })

  it('権限 chat:write が無い・受け付けないトークンは、それぞれの文の状態にする', async () => {
    await setup()
    s.state.botScopes = []
    await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxb-good' })
    await settled('missingScope')
    await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxb-revoked' })
    await settled('rejected')
  })

  it('取り込みのユーザートークンが無ければ相手が分からない。入れると通知します', async () => {
    await setup({ user: false })
    await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxb-good' })
    await settled('noUser')
    await send('PUT', '/api/settings/keys/slack', { value: 'xoxp-good' })
    await settled('on')
  })

  it('Slack に届かなければ何も出さない（まだ確かめられていない）', async () => {
    await setup()
    s.state.fail.set('auth.test', { status: 503 })
    await send('PUT', '/api/settings/keys/slackBot', { value: 'xoxb-good' })
    await settled('unchecked')
  })
})

describe('送り出し（6.8 (3)(4)(5)）', () => {
  it('2 分のあいだに出た知らせを 1 通にまとめ、ユーザートークンの本人へ送る', async () => {
    await setup({ bot: true, origins: [ORIGIN, TAILNET] })
    request('c1', '週報')
    request('c2', '月報')
    stop('c1')
    await server.notices.flush()
    later(MIN)
    stop('c2')
    await server.notices.flush()
    expect(s.state.posts).toEqual([]) // 1 通目から 2 分たっていない
    later(MIN)
    await server.notices.flush()
    expect(s.state.posts).toHaveLength(1)
    expect(s.state.posts[0]?.channel).toBe(ME)
    expect(s.state.posts[0]?.text.split('\n')).toEqual([
      `『週報』は、費用の上限に達したので中止しました。新しい依頼として出し直せます <${TAILNET}/cases/c1|開く>`,
      `『月報』は、費用の上限に達したので中止しました。新しい依頼として出し直せます <${TAILNET}/cases/c2|開く>`,
    ])
    later(5 * MIN)
    await server.notices.flush()
    expect(s.state.posts).toHaveLength(1)
  })

  it('2 分のあいだに本人が答えた確認待ちは送らない', async () => {
    await setup({ bot: true })
    request('c1', '週報', '確認しながら')
    run({
      type: 'entrance.drafted',
      caseId: 'c1',
      by: 'libretto',
      eventId: `e${++n}`,
      expectedRevision: ledger.getCase('c1')?.revision,
      setFingerprint: 'set1',
    })
    await server.notices.flush()
    run({
      type: 'cancel',
      caseId: 'c1',
      by: '本人',
      eventId: `e${++n}`,
      expectedRevision: ledger.getCase('c1')?.revision,
    })
    later(2 * MIN)
    await server.notices.flush()
    expect(s.state.posts).toEqual([])
  })

  it('Slack が混んでいれば時刻どおりに送り直す。権限が無ければ落として設定に出す', async () => {
    await setup({ bot: true })
    request('c1', '週報')
    stop('c1')
    later(2 * MIN)
    s.state.fail.set('chat.postMessage', { error: 'internal_error' })
    await server.notices.flush()
    expect(s.state.posts).toEqual([])
    s.state.fail.delete('chat.postMessage')
    later(MIN)
    await server.notices.flush()
    expect(s.state.posts).toHaveLength(1)

    request('c2', '月報')
    stop('c2')
    later(2 * MIN)
    s.state.botScopes = []
    await server.notices.flush()
    expect(s.state.posts).toHaveLength(1)
    expect(await dm()).toBe('missingScope')
    expect(ledger.dueDeliveries(new Date(clock.getTime() + 365 * 24 * 60 * MIN))).toEqual([])
  })

  it('ボットトークンが無ければ Slack の送り先を書かない', async () => {
    await setup()
    request('c1', '週報')
    stop('c1')
    later(2 * MIN)
    await server.notices.flush()
    expect(ledger.dueDeliveries(clock)).toEqual([])
    expect(s.seen.filter((x) => x.method === 'chat.postMessage')).toEqual([])
  })
})

describe('Slack の DM の文（6.8 (3)）', () => {
  const notice = (i: number, text = `『題${i}』を保存しました。開いて確かめられます`): Notice => ({
    id: i,
    at: '2026-10-25T12:00:00.000+09:00',
    caseId: `c${i}`,
    text,
    kind: 'done',
    path: i === 0 ? '/' : `/cases/c${i}`,
    outside: true,
  })
  it('HTTPS の起点が無ければリンクを付けず、画面を開く 1 行を足す。記号を逃がす', () => {
    expect(slackDmText([notice(1, '『A <b> & C』を保存しました')], undefined)).toBe(
      `『A &lt;b&gt; &amp; C』を保存しました\n${SLACK_DM.openApp}`,
    )
    expect(slackDmText([notice(0, '依頼の候補が 2 件届きました')], TAILNET)).toBe(
      `依頼の候補が 2 件届きました <${TAILNET}/|開く>`,
    )
  })
  it('21 行目からは数だけにする', () => {
    const lines = slackDmText(
      Array.from({ length: 23 }, (_, i) => notice(i + 1)),
      TAILNET,
    ).split('\n')
    expect(lines).toHaveLength(21)
    expect(lines.at(-1)).toBe('ほか 3 件は libretto のお知らせ欄で見られます')
  })
})
