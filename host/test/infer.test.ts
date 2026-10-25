// 推測の分類と抑え方（docs/implementation.md 6.9）。偽の Google・偽の Slack と fake の台本で HTTP を叩く
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateActionResult, ConnectionsView, HomeView } from '@libretto/shared/api'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_EXAMPLE, CARD_INSTRUCTION } from '../src/intake/card.ts'
import {
  CLASSIFY_INSTRUCTION,
  combine,
  JEV_QUESTION,
  JEV_REASON,
  type Level,
  prefilter,
  Verdict,
} from '../src/intake/classify.ts'
import { parseThread } from '../src/intake/gmail.ts'
import { createGoogle } from '../src/intake/google.ts'
import { gmailQuery } from '../src/intake/infer.ts'
import { createSlack } from '../src/intake/slack.ts'
import { initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { type Backend, type Call, createInvoke, type Reply } from '../src/model/invoke.ts'
import { readKey, setKey } from '../src/model/keys.ts'
import { COOKIE, createServer } from '../src/server/app.ts'
import { message, startFakeGoogle } from './fakes/google.ts'
import { ME, reacted, startFakeSlack } from './fakes/slack.ts'

describe('合成 combine（設計書 5.7.3・6.9 (3)）', () => {
  const rows: [Level, number | undefined, Level][] = [
    ['高', undefined, '高'],
    ['なし', undefined, 'なし'],
    ['高', 0.9, '高'],
    ['高', 0.5, '中'],
    ['高', 0.1, '中'],
    ['低', 0.7, '中'],
    ['なし', 0.95, '中'],
    ['中', 0.1, '中'],
    ['低', 0.1, '低'],
    ['なし', 0.3, '低'],
    ['なし', 0.29, 'なし'],
  ]
  for (const [h, j, want] of rows)
    it(`Haiku ${h} × Jev ${j ?? '答え無し'} → ${want}`, () => expect(combine(h, j)).toBe(want))
})

describe('前さばき prefilter（6.9 (2)）', () => {
  const m = { self: false, bulk: false, senderKey: 'hanako@example.com' }
  it('ふつうのメールは通す。依頼の語の有無は見ない', () => expect(prefilter(m)).toBe(true))
  it('本人が始めた・自動送信は落とす', () => {
    expect(prefilter({ ...m, self: true })).toBe(false)
    expect(prefilter({ ...m, bulk: true })).toBe(false)
  })
  it('返事を受けない差出人は落とす。名前の一部に含むだけなら通す', () => {
    for (const a of ['noreply@x.jp', 'no-reply+abc@x.jp', 'do-not-reply@x.jp', 'MAILER-DAEMON@x.jp', 'postmaster@x.jp'])
      expect(prefilter({ ...m, senderKey: a })).toBe(false)
    expect(prefilter({ ...m, senderKey: 'noreplyman.tanaka@x.jp' })).toBe(true)
  })
  it('自動送信の見出し: List-Unsubscribe・Auto-Submitted（no 以外）・Precedence', () => {
    const t = (headers: { name: string; value: string }[]) =>
      parseThread(
        { id: 't', messages: [message({ id: 'm', from: 'a@x.jp', text: 'x', at: 1, headers })] },
        'me@example.com',
      ).bulk
    expect(t([])).toBe(false)
    expect(t([{ name: 'List-Unsubscribe', value: '<mailto:u@x.jp>' }])).toBe(true)
    expect(t([{ name: 'Auto-Submitted', value: 'auto-generated' }])).toBe(true)
    expect(t([{ name: 'Auto-Submitted', value: 'no' }])).toBe(false)
    expect(t([{ name: 'Precedence', value: 'bulk' }])).toBe(true)
  })
  it('受信箱のクエリは除外した差出人を外す（6.9 (5)）', () => {
    expect(gmailQuery(7, ['a@x.jp', 'bad "x'])).toBe(
      'in:inbox category:primary newer_than:7d {to:me cc:me} -from:me -from:a@x.jp',
    )
  })
  it('分類の指示の例は型に通る', () =>
    expect(Verdict.parse(JSON.parse(/\{.*\}$/.exec(CLASSIFY_INSTRUCTION)?.[0] ?? ''))).toBeTruthy())
})

// --- HTTP

const ORIGIN = 'http://127.0.0.1:7780'
const SECRET = '本文だけにある印-a91c'
let home: string
let ledger: Ledger
let g: Awaited<ReturnType<typeof startFakeGoogle>>
let s: Awaited<ReturnType<typeof startFakeSlack>> | undefined
let server: ReturnType<typeof createServer>
let cookie: string
let calls: Call[]
let clock: Date
// 件名（Slack はチャンネル名＋本文）で Haiku の段を決める。既定は高
let levelOf: (call: Call) => { level: Level; reason: string } | 'fail'
let noul = 0.5

const say = (v: unknown): Reply => ({ text: JSON.stringify(v), costYen: 0 })
const material = (c: Call, name: string) => (c.materials.find((m) => m.name === name) as { text: string }).text

async function setup(o: { slack?: boolean; jev?: boolean; monthCapYen?: number; settings?: object } = {}) {
  home = mkdtempSync(join(tmpdir(), 'libretto-infer-'))
  clock = new Date('2026-10-24T03:00:00Z')
  ledger = initHome(home, () => clock)
  if (o.jev) setKey(home, 'jev', 'jev-key-0123456789')
  if (o.settings) writeFileSync(join(home, 'settings.json'), JSON.stringify({ inference: o.settings }))
  g = await startFakeGoogle()
  s = undefined
  if (o.slack) {
    setKey(home, 'slack', 'xoxp-good')
    s = await startFakeSlack()
    s.state.channels.set('C1', { name: 'general' })
    s.state.channels.set('C2', { name: 'docs' })
    s.state.channels.set('D1', { is_im: true })
    s.state.users.set('U0ALICE', '佐藤 アリス')
  }
  calls = []
  levelOf = () => ({ level: '高', reason: '「資料を」という文があります' })
  noul = 0.5
  const backend: Backend = async (call) => {
    calls.push(call)
    if (call.instruction === CLASSIFY_INSTRUCTION) {
      const v = levelOf(call)
      return v === 'fail' ? { text: 'こわれた', costYen: 0 } : say(v)
    }
    if (call.instruction === CARD_INSTRUCTION) return say({ ...CARD_EXAMPLE, attachmentsNeeded: [] })
    if (call.model === 'jev') {
      const qs = Object.keys(JSON.parse(call.instruction) as Record<string, string>)
      return say({ answers: Object.fromEntries(qs.map((q) => [q, q === 'R' ? noul : 0])) })
    }
    throw new Error(`unexpected call ${call.role}`)
  }
  const invoke = createInvoke({
    ledger,
    backends: { claude: backend, openai: backend, jev: backend },
    caps: () => ({ caseCapYen: null, monthCapYen: o.monthCapYen ?? null }),
    onCostCap: () => {},
  })
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<div></div>')
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke,
    google: createGoogle({
      home,
      config: { clientId: 'cid', clientSecret: 'csecret' },
      redirectUri: `${ORIGIN}/oauth/google/callback`,
      endpoints: g.endpoints,
      now: () => clock,
    }),
    ...(s && { slack: createSlack({ token: () => readKey(home, 'slack'), api: (s as { api: string }).api }) }),
    now: () => clock,
    log: () => {},
    runsWaitMs: 50,
  })
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname, { method: 'POST' })
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
  expect(cookie.startsWith(`${COOKIE}=`)).toBe(true)
  const start = await send('POST', '/api/connections/google/start')
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
  await server.app.request(`/oauth/google/callback?state=${state}&code=good-code`)
  await server.poller.run()
  calls = []
}
afterEach(async () => {
  ledger?.close()
  await g?.close()
  await s?.close()
})

const get = (path: string) => server.app.request(path, { headers: { cookie } })
const send = (method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
const connections = async () => ConnectionsView.parse(await (await get('/api/connections')).json())
const home_ = async () => HomeView.parse(await (await get('/api/home')).json())
const classifyCalls = () => calls.filter((c) => c.instruction === CLASSIFY_INSTRUCTION)
const jevCalls = () => calls.filter((c) => c.model === 'jev')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  )

let at = Date.parse('2026-10-23T01:00:00Z')
// 受信箱のメインに届いた、本人宛てのスレッド
function mail(id: string, o: { from?: string; text?: string; headers?: { name: string; value: string }[] } = {}) {
  at += 60_000
  return {
    id,
    historyId: 'h1',
    messages: [
      message({
        id: `${id}-m1`,
        from: o.from ?? '"山田 花子" <Hanako@Example.com>',
        to: 'me@example.com',
        subject: `${id} の件`,
        text: o.text ?? `${id} の本文。${SECRET}`,
        at,
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
        ...(o.headers && { headers: o.headers }),
      }),
    ],
  }
}

describe('推測の回（6.9 (3)(4)(5)）', () => {
  it('高・中・低は可能性と理由の候補、なしは差出人も件名も残さない。再分類しない', async () => {
    await setup()
    const by: Record<string, Level> = { 'a の件': '高', 'b の件': '中', 'c の件': '低', 'd の件': 'なし' }
    levelOf = (c) => ({ level: by[material(c, '件名')] as Level, reason: `${material(c, '件名')}の理由` })
    for (const id of ['a', 'b', 'c']) g.toInbox(mail(id))
    g.toInbox(mail('d', { from: '"秘密の人" <secret.person@example.com>' }))
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(4)
    // 本文は資料の枠で全部を渡す
    expect(material(classifyCalls()[0] as Call, '外部資料（メール）')).toContain(SECRET)
    const h = await home_()
    expect(h.candidates.inferred.high.map((c) => [c.id, c.reason])).toEqual([['gmail:a', 'a の件の理由']])
    expect(h.candidates.inferred.mid.map((c) => c.id)).toEqual(['gmail:b'])
    expect(h.candidates.inferred.low.map((c) => c.id)).toEqual(['gmail:c'])
    expect(ledger.getCandidate('gmail:a')).toMatchObject({ origin: '推測', confidence: '高' })
    expect(ledger.getCandidate('gmail:d')).toMatchObject({ status: 'not_request', senderKey: '', origin: '推測' })
    expect(ledger.listCandidateEvents('gmail:d')).toMatchObject([
      { type: 'not_request', source: 'gmail', historyId: 'h1' },
    ])
    expect(ledger.classifiedCount(clock)).toBe(4)
    for (const f of files(home))
      for (const x of ['secret.person', '秘密の人', 'd の件', SECRET])
        expect(readFileSync(f).includes(Buffer.from(x))).toBe(false)
    calls = []
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(0)
  })

  it('「頼んでいない」スレッドに返信が来たら（historyId が変わったら）分類し直す', async () => {
    await setup()
    levelOf = () => ({ level: 'なし', reason: '頼んでいません' })
    const t = mail('a')
    g.toInbox(t)
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')?.status).toBe('not_request')
    t.historyId = 'h2'
    levelOf = () => ({ level: '中', reason: '返信で頼んでいます' })
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')).toMatchObject({ status: 'presented', origin: '推測', confidence: '中' })
    expect(ledger.classifiedCount(clock)).toBe(2) // 1 回の分類に 1 行（item_id = 候補 id@historyId）
  })

  it('前さばきで落としたものはモデルを呼ばず、1 日の上限も使わない', async () => {
    await setup()
    g.toInbox(mail('a', { headers: [{ name: 'List-Unsubscribe', value: '<mailto:u@x.jp>' }] }))
    g.toInbox(mail('b', { from: 'no-reply@shop.example' }))
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(0)
    expect(ledger.listCandidateEvents('gmail:a')).toMatchObject([{ type: 'not_request', prefiltered: true }])
    expect(ledger.getCandidate('gmail:b')?.status).toBe('not_request')
    expect(ledger.classifiedCount(clock)).toBe(0)
  })

  it('除外した差出人は読まない（クエリで外し、読んでも書かない）', async () => {
    await setup()
    ledger.addSuppression('sender', 'hanako@example.com', '拾わなくてよい', 'hanako@example.com')
    g.toInbox(mail('a'))
    await server.poller.run()
    expect(g.seen.some((x) => x.path.includes('-from%3Ahanako%40example.com') || x.path.includes('-from:hanako'))).toBe(
      true,
    )
    expect(classifyCalls()).toHaveLength(0)
    expect(ledger.getCandidate('gmail:a')).toBeUndefined()
  })

  it('1 日の上限で止まり、見られなかった数を出す。翌日（JST）に続きを見る', async () => {
    await setup({ settings: { gmailDays: 7, slackChannels: [], dailyLimit: 2, showLow: true, useJev: true } })
    for (const id of ['a', 'b', 'c', 'd']) g.toInbox(mail(id))
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(2)
    expect((await connections()).inference).toMatchObject({ classifiedToday: 2, dailyLimit: 2, skippedToday: 2 })
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(2)
    clock = new Date('2026-10-24T15:00:00Z') // JST の翌日 0 時
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(4)
    expect((await connections()).inference.skippedToday).toBeUndefined()
  })

  it('1 回に読むのは 20 件まで。古い順', async () => {
    await setup()
    for (let i = 0; i < 25; i++) g.toInbox(mail(`t${String(i).padStart(2, '0')}`))
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(20)
    expect(material(classifyCalls()[0] as Call, '件名')).toBe('t00 の件')
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(25)
  })

  it('全体の費用上限では推測だけ止まり、何も書かない。ラベルの候補は出る', async () => {
    await setup({ monthCapYen: 5 })
    g.toInbox(mail('a'))
    g.add(mail('b'))
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')).toBeUndefined()
    expect(ledger.getCandidate('gmail:b')).toMatchObject({ origin: '合図', status: 'presented' })
    expect(ledger.classifiedCount(clock)).toBe(0)
  })

  it('出力が通らない件は書かずに次の回へ回す', async () => {
    await setup()
    levelOf = () => 'fail'
    g.toInbox(mail('a'))
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')).toBeUndefined()
    levelOf = () => ({ level: '低', reason: '理由' })
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')?.confidence).toBe('低')
  })

  it('Jev: 件名と最新のメッセージの先頭 600 字を送り、Haiku と合わせる。なしでも Jev が拾えば固定の理由', async () => {
    await setup({ jev: true })
    levelOf = () => ({ level: 'なし', reason: '頼んでいません' })
    noul = 0.9
    const t = mail('a')
    at += 60_000
    t.messages.push(
      message({
        id: 'a-m2',
        from: 'Hanako@Example.com',
        to: 'me@example.com',
        text: `返信: 来週までに記事をお願いします。${'あ'.repeat(800)}`,
        at,
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
      }),
    )
    g.toInbox(t)
    await server.poller.run()
    const ask = jevCalls().find((c) => c.instruction.includes(JEV_QUESTION)) as Call
    expect(material(ask, '件名')).toBe('a の件')
    expect(material(ask, '本文').startsWith('返信: 来週までに')).toBe(true)
    expect([...material(ask, '本文')].length).toBe(600)
    expect(ledger.getCandidate('gmail:a')?.confidence).toBe('中')
    expect(ledger.getCandidateCard('gmail:a')?.reason).toBe(JEV_REASON)
  })

  it('Jev を使わない設定なら、分類にも「AI への指示」の検出にも Jev を呼ばない', async () => {
    await setup({
      jev: true,
      settings: { gmailDays: 7, slackChannels: [], dailyLimit: 300, showLow: true, useJev: false },
    })
    g.toInbox(mail('a'))
    await server.poller.run()
    expect(ledger.getCandidate('gmail:a')?.confidence).toBe('高')
    expect(jevCalls()).toHaveLength(0)
  })
})

describe('Slack の推測（6.9 (5)）', () => {
  const now = () => Date.parse('2026-10-24T03:00:00Z') / 1000
  it('本人宛てメンション（DM は外す）と選んだチャンネル。bot は前さばき。除外したチャンネルは見ない', async () => {
    await setup({
      slack: true,
      settings: { gmailDays: 7, slackChannels: ['C2', 'C3'], dailyLimit: 300, showLow: true, useJev: true },
    })
    const sl = s as NonNullable<typeof s>
    const ts = (h: number) => (now() - h * 3600).toFixed(6)
    sl.state.history.set('C1', [{ ts: ts(5), user: 'U0ALICE', text: `<@${ME}> 資料をお願いします` }])
    sl.state.history.set('D1', [{ ts: ts(4), user: 'U0ALICE', text: `<@${ME}> DM の頼み` }])
    sl.state.history.set('C2', [
      { ts: ts(3), user: 'U0ALICE', text: 'チャンネルの頼み' },
      { ts: ts(2), bot_id: 'B1', text: 'ボットの通知' },
      { ts: ts(24 * 8), user: 'U0ALICE', text: '窓の外' },
    ])
    sl.state.history.set('C3', [{ ts: ts(1), user: 'U0ALICE', text: '除外したチャンネル' }])
    sl.state.mentions = [
      { channel: 'C1', ts: ts(5) },
      { channel: 'D1', ts: ts(4), is_im: true },
    ]
    ledger.addSuppression('channel', 'C3', '拾わなくてよい', '#c3')
    sl.seen.length = 0 // 連携の回（除外の前）の要求を捨てる
    await server.poller.run()
    const subjects = classifyCalls().map((c) => material(c, 'チャンネル'))
    expect(subjects).toEqual(['#general', '#docs'])
    expect(ledger.getCandidate(`slack:C1:${ts(5)}`)).toMatchObject({ origin: '推測', senderKey: 'C1' })
    expect(ledger.getCandidate(`slack:D1:${ts(4)}`)).toBeUndefined()
    expect(ledger.listCandidateEvents(`slack:C2:${ts(2)}`)).toMatchObject([{ type: 'not_request', prefiltered: true }])
    expect(sl.seen.some((x) => x.method === 'conversations.history' && x.params.channel === 'C3')).toBe(false)
  })

  it('メンションの投稿を読めない（履歴の権限が無い）ときは判定を残さず、次の回にもう一度', async () => {
    await setup({ slack: true })
    const sl = s as NonNullable<typeof s>
    const ts = (Date.parse('2026-10-24T01:00:00Z') / 1000).toFixed(6)
    sl.state.mentions = [{ channel: 'C1', ts }]
    sl.state.fail.set('conversations.replies', { error: 'missing_scope', needed: 'channels:history' })
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(0)
    expect(ledger.getCandidate(`slack:C1:${ts}`)).toBeUndefined()
    sl.state.fail.delete('conversations.replies')
    sl.state.history.set('C1', [{ ts, user: 'U0ALICE', text: `<@${ME}> 資料をお願いします` }])
    await server.poller.run()
    expect(ledger.getCandidate(`slack:C1:${ts}`)).toMatchObject({ origin: '推測' })
  })

  it('Jev に渡すのは投稿だけ（スレッドの返信は Haiku にだけ）', async () => {
    await setup({ slack: true, jev: true })
    const sl = s as NonNullable<typeof s>
    const ts = (Date.parse('2026-10-24T01:00:00Z') / 1000).toFixed(6)
    const root = { ts, thread_ts: ts, user: 'U0ALICE', text: `<@${ME}> 確認です` }
    sl.state.history.set('C1', [root])
    sl.state.threads.set(`C1:${ts}`, [root, { ts: `${ts}1`, user: 'U0ALICE', text: '返信の別の頼み' }])
    sl.state.mentions = [{ channel: 'C1', ts }]
    await server.poller.run()
    const ask = jevCalls().find((c) => c.instruction.includes(JEV_QUESTION)) as Call
    expect(material(ask, '本文')).toBe('@本人 確認です')
    expect(material(classifyCalls()[0] as Call, '外部資料（Slack の投稿）')).toContain('返信の別の頼み')
  })

  it('設定の面のチャンネルの候補（DM は出さない）', async () => {
    await setup({ slack: true })
    const r = (await (await get('/api/connections/slack/channels')).json()) as { channels: { id: string }[] }
    expect(r.channels.map((c) => c.id).sort()).toEqual(['C1', 'C2'])
  })
})

describe('自己測定 recall_sample（6.9 (8)）', () => {
  it('範囲の中で合図が付いた新しい候補は「見落とし」、範囲の外は数えない。設定の面に割合', async () => {
    await setup({ settings: { gmailDays: 7, slackChannels: [], dailyLimit: 300, showLow: true, useJev: true } })
    // 範囲の中（受信箱のメイン・本人宛て）だが推測より先にラベル: 推測を止めた回に付いたものとして作る
    ledger.insertNotRequest('gmail:x', 'gmail', { historyId: 'h1' }, 'gmail:x@h1')
    const x = mail('x')
    g.add(x) // ラベルだけ（窓の一覧には出ない）
    const out = {
      id: 'y',
      messages: [message({ id: 'y1', from: 'a@b.jp', text: 'x', at: Date.parse('2026-10-23T00:00:00Z') })],
    }
    g.add(out)
    await server.poller.run()
    expect(ledger.listCandidateEvents('gmail:x').at(-1)).toMatchObject({ type: 'recall_sample', inferredBefore: false })
    expect(ledger.listCandidateEvents('gmail:y').some((e) => e.type === 'recall_sample')).toBe(false)
    expect((await connections()).inference.recall).toEqual({ hit: 0, total: 1 })
  })

  it('範囲の中・行が無い新しい合図も「見落とし」', async () => {
    await setup({ settings: { gmailDays: 7, slackChannels: [], dailyLimit: 1, showLow: true, useJev: true } })
    ledger.recordClassified('既に 1 件') // 今日の上限を使い切った（推測が見られなかった）
    g.add(mail('z'))
    await server.poller.run()
    expect(ledger.listCandidateEvents('gmail:z').at(-1)).toMatchObject({ type: 'recall_sample', inferredBefore: false })
  })
})

describe('見送りの学習と画面（6.9 (7)(10)）', () => {
  it('続いて 3 回目の「依頼ではない」で askSuppress を返し、除外して戻せる', async () => {
    await setup()
    levelOf = () => ({ level: '中', reason: '理由' })
    for (const id of ['a', 'b', 'c']) g.toInbox(mail(id))
    await server.poller.run()
    const dismiss = async (id: string) =>
      CandidateActionResult.parse(
        await (
          await send('POST', `/api/candidates/gmail:${id}/actions`, { type: 'dismiss', reason: '依頼ではない' })
        ).json(),
      )
    expect(await dismiss('a')).toEqual({})
    expect(await dismiss('b')).toEqual({})
    const third = await dismiss('c')
    expect(third.askSuppress).toEqual({
      kind: 'sender',
      value: 'hanako@example.com',
      label: 'hanako@example.com',
      count: 3,
    })
    const add = await send('POST', '/api/suppressions', third.askSuppress)
    const { id } = (await add.json()) as { id: number }
    expect((await connections()).inference.suppressions).toMatchObject([
      { id, kind: 'sender', label: 'hanako@example.com' },
    ])
    expect(ledger.isSuppressed('sender', 'hanako@example.com')).toBe(true)
    expect((await send('DELETE', `/api/suppressions/${id}`)).status).toBe(204)
    expect((await send('DELETE', `/api/suppressions/${id}`)).status).toBe(404)
    expect(ledger.isSuppressed('sender', 'hanako@example.com')).toBe(false)
  })

  it('低をまとめて見送る（推測・低だけ）。低を出さない設定なら欄に出さない', async () => {
    await setup()
    levelOf = (c) => ({ level: material(c, '件名') === 'a の件' ? '高' : '低', reason: '理由' })
    for (const id of ['a', 'b', 'c']) g.toInbox(mail(id))
    await server.poller.run()
    expect((await home_()).candidates.inferred.low).toHaveLength(2)
    const r = await send('POST', '/api/candidates/dismiss-low', { ids: ['gmail:a', 'gmail:b', 'gmail:c'] })
    expect(await r.json()).toEqual({ dismissed: 2 })
    expect(ledger.getCandidate('gmail:a')?.status).toBe('presented')
    expect(ledger.listCandidateEvents('gmail:b').at(-1)).toMatchObject({ type: 'dismissed', reason: '依頼ではない' })

    g.toInbox(mail('d'))
    await server.poller.run()
    expect((await home_()).candidates.inferred.low).toHaveLength(1)
    const bad = await send('PUT', '/api/settings/inference', { gmailDays: 5 })
    expect(bad.status).toBe(400)
    const put = { gmailDays: 3, slackChannels: [], dailyLimit: 300, showLow: false, useJev: true }
    expect(await (await send('PUT', '/api/settings/inference', put)).json()).toEqual(put)
    expect(await (await get('/api/settings/inference')).json()).toEqual(put)
    expect((await home_()).candidates.inferred.low).toHaveLength(0)
    expect(ledger.getCandidate('gmail:d')?.status).toBe('presented') // 台帳には残る
  })

  it('上限 0 で自動検出を止める', async () => {
    await setup({ settings: { gmailDays: 7, slackChannels: [], dailyLimit: 0, showLow: true, useJev: true } })
    g.toInbox(mail('a'))
    await server.poller.run()
    expect(classifyCalls()).toHaveLength(0)
    expect(g.seen.some((x) => x.path.includes('q='))).toBe(false)
  })
})

it('ラベルの付いた候補の自己測定は Slack も同じ（選んだチャンネルの合図は範囲の中）', async () => {
  await setup({
    slack: true,
    settings: { gmailDays: 7, slackChannels: ['C1'], dailyLimit: 300, showLow: true, useJev: true },
  })
  const sl = s as NonNullable<typeof s>
  const ts = (Date.parse('2026-10-24T02:00:00Z') / 1000).toFixed(6)
  sl.state.items = [reacted('C1', { ts, user: 'U0ALICE', text: '頼みます' })]
  levelOf = () => 'fail' // 推測は分類できず、合図が先に出る
  sl.state.history.set('C1', [{ ts, user: 'U0ALICE', text: '頼みます' }])
  await server.poller.run()
  expect(ledger.listCandidateEvents(`slack:C1:${ts}`).at(-1)).toMatchObject({
    type: 'recall_sample',
    inferredBefore: false,
  })
})
