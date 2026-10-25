// Slack の合図（docs/implementation.md 6.6）。偽の Slack と fake の台本で HTTP を叩く
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionsView, HomeView } from '@libretto/shared/api'
import { Intake } from '@libretto/shared/ledger'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_EXAMPLE, CARD_FALLBACK_SLACK, CARD_INSTRUCTION, type CardDraft } from '../src/intake/card.ts'
import { createGoogle } from '../src/intake/google.ts'
import { createSlack, plain, SLACK_SCOPES } from '../src/intake/slack.ts'
import { caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { allowedEnv } from '../src/model/claude-cli.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { type Backend, type Call, createInvoke, type Reply } from '../src/model/invoke.ts'
import { denyRules, srtSettings } from '../src/model/sandbox.ts'
import { COOKIE, createServer } from '../src/server/app.ts'
import { ME, reacted, startFakeSlack } from './fakes/slack.ts'
import { briefDraft, classified, goodChecks } from './fixtures/entrance.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const SECRET = '投稿だけにある印-5c8e2a'
const FILED = 'ファイルだけにある印-9d1f3b'
let home: string
let ledger: Ledger
let s: Awaited<ReturnType<typeof startFakeSlack>>
let server: ReturnType<typeof createServer>
let cookie: string
let calls: Call[]
let talkReply: ((call: Call) => Reply) | undefined
let cardReply: (call: Call) => Reply

const draft = (over: Partial<CardDraft> = {}) => ({ ...CARD_EXAMPLE, attachmentsNeeded: [], ...over })
const say = (v: unknown): Reply => ({ text: JSON.stringify(v), costYen: 0 })

async function setup(o: { script?: ScriptEntry[]; token?: string | undefined } = {}) {
  home = mkdtempSync(join(tmpdir(), 'libretto-slack-'))
  const clock = new Date('2026-10-25T03:00:00Z')
  ledger = initHome(home, () => clock)
  s = await startFakeSlack()
  s.state.channels.set('C1', { name: 'general' })
  s.state.users.set('U0ALICE', '佐藤 アリス')
  calls = []
  talkReply = undefined
  cardReply = () => say(draft())
  const fake = createFake(o.script ?? [])
  const backend: Backend = async (call) => {
    calls.push(call)
    if (call.instruction === CARD_INSTRUCTION) return cardReply(call)
    if (call.role === '話し相手' && talkReply) return talkReply(call)
    return fake.backend(call)
  }
  const invoke = createInvoke({
    ledger,
    backends: { claude: backend, openai: backend, jev: backend },
    caps: () => ({ caseCapYen: null, monthCapYen: null }),
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
    // Google は設定なし（Slack だけで取り込む）
    google: createGoogle({ home, redirectUri: `${ORIGIN}/oauth/google/callback` }),
    slack: createSlack({ token: 'token' in o ? o.token : 'xoxp-good', api: s.api }),
    now: () => clock,
    log: () => {},
    runsWaitMs: 50,
  })
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
  expect(cookie.startsWith(`${COOKIE}=`)).toBe(true)
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
const connections = async () => ConnectionsView.parse(await (await get('/api/connections')).json())
const home_ = async () => HomeView.parse(await (await get('/api/home')).json())
const cardCalls = () => calls.filter((c) => c.instruction === CARD_INSTRUCTION)
const material = (c: Call | undefined, name: string) =>
  c?.materials.find((m) => m.name === name && 'text' in m) as { text: string } | undefined
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  )
}
let rid = 0
async function talk(candidateId: string, text: string) {
  const view = (await (await get(`/api/conversation?candidateId=${candidateId}`)).json()) as {
    messages: { seq: number }[]
  }
  await send('POST', '/api/conversation/messages', {
    requestId: `00000000-0000-4000-8000-${String(++rid).padStart(12, '0')}`,
    lastSeq: view.messages.at(-1)?.seq ?? 0,
    candidateId,
    text,
  })
  await server.conversation.settled()
}
// Slack の ts（秒。n 分ずつ進む）
const ts = (n: number) => `${1793000000 + n * 60}.000100`

describe('書式（6.6 (4)）', () => {
  it('メンションは名前、チャンネルは #名前、<url|label> は url を残す', () => {
    const names = new Map([['U1', '佐藤']])
    expect(plain('<@U1> さん <#C9|random> の <https://e.x/spec|仕様> と <https://e.x> &lt;a&gt; &amp;', names)).toBe(
      '@佐藤 さん #random の 仕様（https://e.x/spec） と https://e.x <a> &',
    )
  })
})

describe('拾い上げ（6.6 (4)(5)）', () => {
  it('本人が :memo: を付けた投稿を 1 回だけ候補にする。本文は保存せず、ファイルの口は呼ばない', async () => {
    await setup()
    s.state.items = [
      reacted('C1', {
        ts: ts(1),
        user: 'U0ALICE',
        text: `<@${ME}> 来週の紹介資料をお願いします。${SECRET}`,
        permalink: 'https://acme.slack.com/archives/C1/p1',
        files: [{ name: '見積書.xlsx', url_private: `https://files.slack.com/${FILED}` } as never],
      }),
      reacted('C1', { ts: ts(2), user: 'U0ALICE', text: 'ほかの人の :memo:' }, { by: ['U0ALICE'] }),
      reacted('C1', { ts: ts(3), user: 'U0ALICE', text: '本人の別の絵文字' }, { emoji: 'eyes' }),
    ]
    // 1 つの投稿に本人が複数のリアクションを付けると、一覧に重ねて出る
    s.state.items.push(s.state.items[0] as never)
    await server.poller.run()
    await server.poller.run()
    const v = await home_()
    expect(v.intake.connected).toBe(true)
    expect(v.candidates.signal).toHaveLength(1)
    expect(v.candidates.signal[0]).toMatchObject({
      id: `slack:C1:${ts(1)}`,
      source: 'slack',
      origin: '合図',
      subject: '#general',
      from: '佐藤 アリス',
      link: 'https://acme.slack.com/archives/C1/p1',
      attachments: ['見積書.xlsx'],
      othersPost: true,
      receivedAt: '2026-10-26T16:34:20.000+09:00', // ts の秒を時刻に
    })
    expect(cardCalls()).toHaveLength(1)
    const body = material(cardCalls()[0], '外部資料（Slack の投稿）')?.text ?? ''
    expect(body).toContain(SECRET)
    expect(body).toContain('@本人 来週の紹介資料')
    expect(material(cardCalls()[0], 'チャンネル')?.text).toBe('#general')
    expect(JSON.stringify(calls.map((c) => c.materials))).not.toContain(FILED)
    expect(s.seen.some((x) => x.method.startsWith('files.'))).toBe(false)
    expect(ledger.getCandidate(`slack:C1:${ts(1)}`)?.senderKey).toBe('C1')
    for (const f of allFiles(home)) expect(readFileSync(f).includes(Buffer.from(SECRET)), f).toBe(false)
  })

  it('後ろの返信に付けた印の投稿は、長いスレッドでも本文の先頭に残る。permalink が無ければ組む', async () => {
    await setup()
    const parent = ts(1)
    const mark = ts(50)
    const thread = Array.from({ length: 40 }, (_, i) => ({
      ts: ts(i + 1),
      user: 'U0ALICE',
      text: `前置き${'あ'.repeat(800)}`,
      thread_ts: parent,
    }))
    thread.push({ ts: mark, user: ME, text: `これをまとめたい${SECRET}`, thread_ts: parent })
    s.state.threads.set(`C1:${parent}`, thread)
    s.state.items = [reacted('C1', { ts: mark, user: ME, text: `これをまとめたい${SECRET}`, thread_ts: parent })]
    await server.poller.run()
    const body = material(cardCalls()[0], '外部資料（Slack の投稿）')?.text ?? ''
    expect(body.startsWith(`（印を付けた投稿）\n本人: これをまとめたい${SECRET}`)).toBe(true)
    expect(body).toContain('（スレッド）')
    expect(body.length).toBeLessThanOrEqual(20_000)
    const [c] = (await home_()).candidates.signal
    expect(c?.othersPost).toBe(false)
    expect(c?.link).toBe(`https://acme.slack.com/archives/C1/p${mark.replace('.', '')}`)
  })

  it('一覧は先頭の 1 ページと前の回の続きから 4 ページ。続きを回ごとに進めて古いページに届く', async () => {
    await setup()
    s.state.pageSize = 2
    // 13 件のうち、:memo: は先頭と最後（6 ページ目の 1 件目より後ろ）
    s.state.items = Array.from({ length: 13 }, (_, i) =>
      reacted(
        'C1',
        { ts: ts(i + 1), user: 'U0ALICE', text: `投稿${i}` },
        { emoji: i === 0 || i === 12 ? 'memo' : 'eyes' },
      ),
    )
    await server.poller.run()
    expect((await home_()).candidates.signal.map((c) => c.id)).toEqual([`slack:C1:${ts(1)}`])
    expect(s.seen.filter((x) => x.method === 'reactions.list')).toHaveLength(5)
    await server.poller.run()
    expect((await home_()).candidates.signal.map((c) => c.id)).toEqual([`slack:C1:${ts(13)}`, `slack:C1:${ts(1)}`])
  })

  it('1 回に読むのは 20 件まで。残りは次の回', async () => {
    await setup()
    s.state.items = Array.from({ length: 23 }, (_, i) => reacted('C1', { ts: ts(i + 1), user: ME, text: `t${i}` }))
    await server.poller.run()
    expect((await home_()).candidates.signal).toHaveLength(20)
    await server.poller.run()
    expect((await home_()).candidates.signal).toHaveLength(23)
  })

  it('推測で先に出ていた候補に :memo: が付いたら、1 件のまま由来を合図にする', async () => {
    await setup()
    const id = `slack:C1:${ts(1)}`
    ledger.insertCandidate(
      { candidateId: id, source: 'slack', origin: '推測', confidence: '中', aiInstructionFlag: false, senderKey: 'C1' },
      {
        subject: '#general',
        from: '佐藤 アリス',
        receivedAt: '2026-10-24T09:00:00.000+09:00',
        link: 'https://acme.slack.com/',
        reason: '「資料を」という文があります',
        summary: '資料を作る',
        proposal: { docType: '記事', destination: [{ kind: 'page', shared: false }] },
      },
    )
    s.state.items = [reacted('C1', { ts: ts(1), user: 'U0ALICE', text: 'x' })]
    await server.poller.run()
    expect(ledger.getCandidate(id)?.origin).toBe('合図')
    expect(ledger.listCandidateEvents(id).map((e) => e.type)).toEqual(['found', 'presented', 'promoted_to_signal'])
    expect(cardCalls()).toHaveLength(0)
  })

  it('要約に失敗しても候補は出す（Slack の固定の文）。チャンネル名と名前が引けなくても出す', async () => {
    await setup()
    s.state.fail.set('conversations.info', { error: 'missing_scope', needed: 'channels:read' })
    s.state.fail.set('users.info', { error: 'missing_scope', needed: 'users:read' })
    cardReply = () => ({ text: 'JSON ではない', costYen: 0 })
    s.state.items = [reacted('C1', { ts: ts(1), user: 'U0ALICE', text: 'x' })]
    await server.poller.run()
    const [c] = (await home_()).candidates.signal
    expect(c).toMatchObject({ summary: CARD_FALLBACK_SLACK, subject: 'Slack', from: 'Slack のメンバー' })
  })
})

describe('連携の欄（6.6 (2)(7)）', () => {
  it('トークンが無ければ「設定がありません」で、取り込まない', async () => {
    await setup({ token: undefined })
    expect((await connections()).slack).toEqual({ configured: false, state: 'none', emoji: 'memo', missingScopes: [] })
    await server.poller.run()
    expect(s.seen).toEqual([])
    expect((await home_()).intake.connected).toBe(false)
  })

  it('つながっていればワークスペースと名前。足りない権限を名前で出す。トークンは応答に出さない', async () => {
    await setup()
    s.state.scopes = SLACK_SCOPES.filter((x) => x !== 'mpim:history' && x !== 'users:read')
    await server.poller.run()
    const v = await connections()
    expect(v.slack).toMatchObject({
      configured: true,
      state: 'connected',
      team: 'ACME',
      user: 'honnin',
      missingScopes: ['mpim:history', 'users:read'],
    })
    expect(v.slack.lastAt).toBeDefined()
    expect(JSON.stringify(v)).not.toContain('xoxp-good')
    expect(JSON.stringify(v)).not.toContain(ME)
    expect(s.seen.every((x) => x.auth === 'Bearer xoxp-good')).toBe(true)
  })

  it('見出しが無ければ、口の missing_scope で覚えた権限を出す', async () => {
    await setup()
    s.state.scopes = undefined
    s.state.fail.set('reactions.list', { error: 'missing_scope', needed: 'reactions:read' })
    await server.poller.run()
    expect((await connections()).slack.missingScopes).toEqual(['reactions:read'])
  })

  it('トークンが使えなければ「連携し直してください」、混み合っていればその回を飛ばして出す', async () => {
    await setup()
    s.state.token = 'xoxp-other'
    await server.poller.run()
    expect((await connections()).slack.state).toBe('expired')
    s.state.token = 'xoxp-good'
    s.state.fail.set('reactions.list', { status: 429 })
    await server.poller.run()
    const v = (await connections()).slack
    expect(v).toMatchObject({ state: 'connected', problem: 'rate_limited' })
    s.state.fail.clear()
    s.state.items = [reacted('C1', { ts: ts(1), user: ME, text: 'x' })]
    await server.poller.run()
    expect((await connections()).slack.problem).toBeUndefined()
    expect((await home_()).candidates.signal).toHaveLength(1)
  })
})

describe('候補の操作（6.6 (6)）', () => {
  it('進める: intake.json は Slack の由来。入口の依頼書の下書き役にだけ本文を読み直して渡す', async () => {
    await setup({
      script: [
        { role: '下書き役・依頼書', nth: 1, reply: { text: JSON.stringify(briefDraft) } },
        { role: '下書き役・確認項目', nth: 1, reply: { text: JSON.stringify({ checks: goodChecks }) } },
        { role: '事実係・分類', nth: 1, reply: { text: JSON.stringify(classified) } },
      ],
    })
    s.state.items = [reacted('C1', { ts: ts(1), user: 'U0ALICE', text: `紹介資料をお願いします${SECRET}` })]
    s.state.threads.set(`C1:${ts(1)}`, [{ ts: ts(1), user: 'U0ALICE', text: `紹介資料をお願いします${SECRET}` }])
    await server.poller.run()
    const id = `slack:C1:${ts(1)}`
    const res = await send('POST', `/api/candidates/${id}/actions`, { type: 'proceed' })
    expect(res.status).toBe(200)
    const { caseId } = (await res.json()) as { caseId: string }
    const intake = Intake.parse(JSON.parse(readFileSync(join(caseDir(home, caseId), 'intake.json'), 'utf-8')))
    expect(intake).toMatchObject({
      origin: { kind: '合図', source: 'slack' },
      source: { candidateId: id, threadId: `C1:${ts(1)}`, account: ME, subject: '#general', from: '佐藤 アリス' },
    })
    expect(ledger.getCase(caseId)).toMatchObject({ state: '入口待ち', mode: '確認しながら' })
    for (let i = 0; i < 100 && ledger.getCase(caseId)?.turn !== '本人'; i++) await new Promise((r) => setTimeout(r, 20))
    const brief = calls.find((c) => c.role === '下書き役・依頼書')
    const checks = calls.find((c) => c.role === '下書き役・確認項目')
    expect(material(brief, '外部資料（取り込み元の Slack の投稿）')?.text).toContain(SECRET)
    expect(JSON.stringify(checks?.materials)).not.toContain(SECRET)
    for (const f of allFiles(home)) expect(readFileSync(f).includes(Buffer.from(SECRET)), f).toBe(false)
  })

  it('内容を修正: スレッドの返信に付けた印でも、読み直した本文に印の投稿が入る', async () => {
    await setup()
    const parent = ts(1)
    const reply = ts(2)
    s.state.threads.set(`C1:${parent}`, [
      { ts: parent, user: 'U0ALICE', text: '親の投稿', thread_ts: parent },
      { ts: reply, user: 'U0ALICE', text: `返信の依頼${SECRET}`, thread_ts: parent },
    ])
    s.state.items = [reacted('C1', { ts: reply, user: 'U0ALICE', text: `返信の依頼${SECRET}`, thread_ts: parent })]
    await server.poller.run()
    const seen: Call[] = []
    talkReply = (call) => {
      seen.push(call)
      return say({ text: 'どう変えたいかを教えてください。' })
    }
    await talk(`slack:C1:${reply}`, '短く')
    const body = material(seen[0], '外部資料（Slack の投稿）')?.text ?? ''
    expect(body.startsWith(`（印を付けた投稿）\n佐藤 アリス: 返信の依頼${SECRET}`)).toBe(true)
    expect(body).toContain('親の投稿')
  })

  it('見送る: リアクションのカードは 3 つの理由だけ', async () => {
    await setup()
    s.state.items = [reacted('C1', { ts: ts(1), user: ME, text: 'x' })]
    await server.poller.run()
    const id = `slack:C1:${ts(1)}`
    expect(
      (await send('POST', `/api/candidates/${id}/actions`, { type: 'dismiss', reason: '拾わなくてよい' })).status,
    ).toBe(400)
    expect(
      (await send('POST', `/api/candidates/${id}/actions`, { type: 'dismiss', reason: 'もう済んだ' })).status,
    ).toBe(200)
    await server.poller.run()
    expect((await home_()).candidates.signal).toEqual([])
  })

  it('内容を修正: 会話の間だけ投稿を読み直して渡す。トークンの本人が違えば渡さない', async () => {
    await setup()
    s.state.items = [reacted('C1', { ts: ts(1), user: 'U0ALICE', text: `紹介資料${SECRET}` })]
    s.state.threads.set(`C1:${ts(1)}`, [{ ts: ts(1), user: 'U0ALICE', text: `紹介資料${SECRET}` }])
    await server.poller.run()
    const seen: Call[] = []
    talkReply = (call) => {
      seen.push(call)
      return say({ text: 'どう変えたいかを教えてください。' })
    }
    const id = `slack:C1:${ts(1)}`
    await talk(id, '短く')
    expect(material(seen[0], '外部資料（Slack の投稿）')?.text).toContain(SECRET)
    s.state.userId = 'U0SOMEONE'
    await talk(id, 'もっと短く')
    expect(seen).toHaveLength(2)
    expect(material(seen[1], '外部資料（Slack の投稿）')).toBeUndefined()
  })
})

describe('トークンを作り手に渡さない（6.6 (2)）', () => {
  it('環境変数の許可一覧に入らず、.env.local は srt と CLI の両方で読めない', () => {
    expect(allowedEnv({ PATH: '/bin', LIBRETTO_SLACK_USER_TOKEN: 'xoxp-x' }, 'linux')).toEqual({ PATH: '/bin' })
    const env = '/opt/libretto/.env.local'
    expect(denyRules('/home/u/libretto', '/home/u/.claude', [env])).toContain(`Read(/${env})`)
    const st = srtSettings({
      home: '/home/u/libretto',
      userHome: '/home/u',
      configDir: '/home/u/.claude',
      work: '/home/u/libretto/cases/c1/work',
      tmp: '/tmp/x',
      claude: '/usr/bin/claude',
      node: '/usr/bin/node',
      srtVendor: '/opt/libretto/node_modules/@anthropic-ai/sandbox-runtime/vendor',
      secrets: [env],
    })
    expect(st.filesystem.denyRead).toContain(env)
  })
})
