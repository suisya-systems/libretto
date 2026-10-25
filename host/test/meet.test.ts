// Meet の会議メモ（docs/implementation.md 6.7）。偽の Google の会議メモと fake の台本で、拾い上げと候補の操作を通す
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionsView, HomeView } from '@libretto/shared/api'
import { Intake } from '@libretto/shared/ledger'
import { afterEach, describe, expect, it } from 'vitest'
import { createGoogle, DRIVE_SCOPE, GMAIL_SCOPE, MEET_SCOPE } from '../src/intake/google.ts'
import {
  actionItems,
  confidenceOf,
  MEET_EXAMPLE,
  MEET_INSTRUCTION,
  MeetDraft,
  meetCandidateId,
  meetViolations,
  parseTitle,
} from '../src/intake/meet.ts'
import { caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { type Backend, type Call, createInvoke, type Reply } from '../src/model/invoke.ts'
import { COOKIE, createServer } from '../src/server/app.ts'
import { startFakeGoogle } from './fakes/google.ts'
import { briefDraft, classified, goodChecks } from './fixtures/entrance.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const OUTSIDE = '節の外だけにある印-9c1e'
const ITEM_MARK = '項目だけにある印-4a7b'
let home: string
let ledger: Ledger
let g: Awaited<ReturnType<typeof startFakeGoogle>>
let server: ReturnType<typeof createServer>
let cookie: string
let calls: Call[]
let clock: Date
let meetReply: (call: Call) => Reply

const say = (v: unknown): Reply => ({ text: JSON.stringify(v), costYen: 0 })
const pick = (n: number, mine: '本人' | '曖昧', over: Partial<MeetDraft['items'][number]> = {}) => ({
  ...(MEET_EXAMPLE.items[0] as MeetDraft['items'][number]),
  n,
  mine,
  ...over,
})

async function setup(o: { scope?: string; script?: ScriptEntry[] } = {}) {
  home = mkdtempSync(join(tmpdir(), 'libretto-meet-'))
  clock = new Date('2026-10-24T03:00:00Z')
  ledger = initHome(home, () => clock)
  g = await startFakeGoogle()
  g.state.scope = o.scope ?? `${GMAIL_SCOPE} ${DRIVE_SCOPE} ${MEET_SCOPE}`
  calls = []
  meetReply = () => say({ items: [] })
  const fake = createFake(o.script ?? [])
  const backend: Backend = async (call) => {
    calls.push(call)
    if (call.instruction === MEET_INSTRUCTION) return meetReply(call)
    return fake.backend(call)
  }
  const invoke = createInvoke({
    ledger,
    backends: { claude: backend, openai: backend, jev: backend },
    caps: () => ({ caseCapYen: null, monthCapYen: null }),
    onCostCap: () => {},
  })
  const google = createGoogle({
    home,
    config: { clientId: 'cid', clientSecret: 'csecret' },
    redirectUri: `${ORIGIN}/oauth/google/callback`,
    endpoints: g.endpoints,
    now: () => clock,
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
    google,
    now: () => clock,
    log: () => {},
    runsWaitMs: 50,
  })
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
  expect(cookie.startsWith(`${COOKIE}=`)).toBe(true)
  const start = await send('POST', '/api/connections/google/start')
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')
  await server.app.request(`/oauth/google/callback?state=${state}&code=good-code`)
  await server.poller.run()
}
afterEach(async () => {
  ledger?.close()
  await g?.close()
})

const get = (path: string) => server.app.request(path, { headers: { cookie } })
const send = (method: string, path: string, body?: unknown) =>
  server.app.request(path, {
    method,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
const home_ = async () => HomeView.parse(await (await get('/api/home')).json())
const connections = async () => ConnectionsView.parse(await (await get('/api/connections')).json())
const meetCalls = () => calls.filter((c) => c.instruction === MEET_INSTRUCTION)
const material = (c: Call | undefined, name: string) =>
  c?.materials.find((m) => m.name === name && 'text' in m) as { text: string } | undefined
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  )
}

const NOTE_TEXT = (items: string[]) =>
  [
    '📝 メモ',
    'まとめ',
    `新サービスの紹介について話しました。${OUTSIDE}`,
    '詳細',
    `* 山田: 来週までに資料が要る。${OUTSIDE}`,
    '推奨される次のステップ',
    ...items.map((x) => `* ${x}`),
    '',
    'Gemini が作成したメモは不正確な場合があります。',
  ].join('\n')
// 会議メモを足す。作られてから 1 時間（書き足しの途中ではない）
function note(id: string, items: string[], o: { name?: string; text?: string; modified?: string } = {}) {
  const created = new Date(clock.getTime() - 3_600_000).toISOString()
  g.notes.set(id, {
    id,
    name: o.name ?? 'ブレスト - 2026/10/24 11:00 JST - Gemini によるメモ',
    createdTime: created,
    modifiedTime: o.modified ?? created,
    text: o.text ?? NOTE_TEXT(items),
  })
}
const MINE = `[岩間 涼] 紹介資料の作成: 岩間 涼 が来週の定例までに新サービスの紹介資料を作る。${ITEM_MARK}`
const OTHERS = '[山田 花子] 会議室の予約: 山田 花子 が来週の会議室を予約する。'
const VAGUE = '[チーム] 議事録の共有: チームで議事録を関係者に共有する。'

describe('会議メモの読み取り（6.7 (2)(3)）', () => {
  it('題名の形に合うものだけ。会議名と日時を題名から取る', () => {
    expect(parseTitle('ブレスト - 2026/10/21 11:59 JST - Gemini によるメモ', '2026-10-21T02:59:00Z')).toEqual({
      meeting: 'ブレスト',
      heldAt: '2026-10-21T11:59:00.000+09:00',
    })
    expect(parseTitle('Weekly - 2026/10/21 11:59 PDT - Notes by Gemini', '2026-10-21T18:59:00Z')?.heldAt).toBe(
      '2026-10-22T03:59:00.000+09:00',
    )
    expect(parseTitle('Gemini によるメモ の使い方', '2026-10-21T02:59:00Z')).toBeUndefined()
  })
  it('節が無ければ undefined、節が空・「ありません」だけなら []、項目は節の中だけ', () => {
    expect(actionItems('まとめ\n話しました')).toBeUndefined()
    expect(actionItems('推奨される次のステップ\n\nGemini が作成したメモ')).toEqual({ items: [], truncated: false })
    expect(actionItems('次のステップ:\n* ありません\n')).toEqual({ items: [], truncated: false })
    expect(actionItems(NOTE_TEXT([MINE, OTHERS]))).toEqual({ items: [MINE, OTHERS], truncated: false })
    expect(actionItems(`Suggested next steps\n${'- x\n'.repeat(51)}`)?.truncated).toBe(true)
    // 項目の中の「Gemini」では節を切らず、末尾の注意書きで切る
    const g1 = '[岩間 涼] Gemini の評価レポートを作る'
    expect(actionItems(NOTE_TEXT([g1, MINE]))?.items).toEqual([g1, MINE])
  })
  it('確信度: 名前かアドレス全体が項目にあれば高、モデルが本人と言っただけなら中、曖昧は低', () => {
    const me = { email: 'me@example.com', name: '岩間 涼' }
    expect(confidenceOf('本人', MINE, me)).toBe('高')
    expect(confidenceOf('本人', '[me@example.com] 資料を作る', { email: 'me@example.com' })).toBe('高')
    expect(confidenceOf('本人', '[me] 資料を作る', { email: 'me@example.com' })).toBe('中')
    expect(confidenceOf('曖昧', MINE, me)).toBe('低')
  })
  it('出力の例は型と受け入れ規則に通り、無い番号・重なった番号は落ちる', () => {
    expect(MeetDraft.parse(MEET_EXAMPLE)).toEqual(MEET_EXAMPLE)
    expect(meetViolations(MEET_EXAMPLE, 2, ['page', 'paste'])).toEqual([])
    expect(meetViolations(MEET_EXAMPLE, 1, ['page', 'paste'])).toHaveLength(1)
    expect(meetViolations({ items: [pick(1, '本人'), pick(1, '曖昧')] }, 2, ['page', 'paste'])).toHaveLength(1)
  })
  it('候補 id は項目の文の空白を詰めた指紋', () => {
    expect(meetCandidateId('f1', 'a b')).toBe(meetCandidateId('f1', 'ab'))
    expect(meetCandidateId('f1', 'a')).toMatch(/^meet:f1:[0-9a-f]{12}$/)
    // 300 字を超える項目も全文で見分ける
    const long = 'あ'.repeat(300)
    expect(actionItems(NOTE_TEXT([`${long}い`, `${long}う`]))?.items).toEqual([`${long}い`, `${long}う`])
  })
})

describe('拾い上げ（6.7 (2)(3)(5)）', () => {
  it('本人担当は会議・高、曖昧は推測・低、ほかの人は出さない。節の外はモデルに渡さず、本文を保存しない', async () => {
    await setup()
    note('f1', [MINE, OTHERS, VAGUE])
    meetReply = () => say({ items: [pick(1, '本人'), pick(3, '曖昧', { why: '担当がチームです' })] })
    await server.poller.run()
    const v = await home_()
    expect(v.candidates.meeting).toHaveLength(1)
    expect(v.candidates.meeting[0]).toMatchObject({
      id: meetCandidateId('f1', MINE),
      source: 'meet',
      origin: '会議',
      confidence: '高',
      subject: 'ブレスト',
      from: '岩間 涼',
      receivedAt: '2026-10-24T11:00:00.000+09:00',
      link: 'https://docs.google.com/document/d/f1/edit',
    })
    expect(v.candidates.inferred.low).toMatchObject([{ origin: '推測', confidence: '低', reason: '担当がチームです' }])
    expect(v.meetNotes).toEqual([])
    const c = meetCalls()[0]
    expect(JSON.parse(material(c, '本人')?.text ?? '{}')).toEqual({ email: 'me@example.com', name: '岩間 涼' })
    expect(material(c, '外部資料（会議メモの行動項目）')?.text).toBe(`1. ${MINE}\n2. ${OTHERS}\n3. ${VAGUE}`)
    expect(JSON.stringify(calls.map((x) => x.materials))).not.toContain(OUTSIDE)
    for (const f of allFiles(home)) {
      expect(readFileSync(f).includes(Buffer.from(OUTSIDE)), f).toBe(false)
      expect(readFileSync(f).includes(Buffer.from(ITEM_MARK)), f).toBe(false)
    }
    // 同じ版はもう読まない
    await server.poller.run()
    expect(meetCalls()).toHaveLength(1)
  })

  it('「行動項目なし」「見つけられません」「あなたが担当の行動項目なし」を分けて出す。節が無い・空ならモデルを呼ばない', async () => {
    await setup()
    note('f1', [])
    note('f2', [], { text: 'まとめ\n話しました' })
    note('f3', [OTHERS], { name: '定例 - 2026/10/24 10:00 JST - Gemini によるメモ' })
    await server.poller.run()
    expect(meetCalls()).toHaveLength(1)
    const r = Object.fromEntries((await home_()).meetNotes.map((n) => [n.link.split('/')[5], n.result]))
    expect(r).toEqual({ f1: 'none', f2: 'unreadable', f3: 'notMine' })
  })

  it('書き出しを断られたメモは「見つけられません」にして、後ろのメモを止めない', async () => {
    await setup()
    note('f1', [MINE])
    note('f2', [MINE], { name: '定例 - 2026/10/24 10:00 JST - Gemini によるメモ' })
    g.state.fail = {
      status: 403,
      body: '{"error":{"errors":[{"reason":"cannotDownloadFile"}]}}',
      times: 1,
      path: /\/f1\/export$/,
    }
    meetReply = () => say({ items: [pick(1, '本人')] })
    await server.poller.run()
    const v = await home_()
    expect(v.meetNotes.map((n) => [n.link.split('/')[5], n.result])).toEqual([['f1', 'unreadable']])
    expect(v.candidates.meeting.map((c) => c.id)).toEqual([meetCandidateId('f2', MINE)])
  })

  it('題名の形に合わないもの・書き足しの途中（10 分以内）は読まない。一覧の窓は 14 日', async () => {
    await setup()
    note('f1', [MINE], { name: 'Gemini によるメモ の使い方' })
    note('f2', [MINE], { modified: new Date(clock.getTime() - 60_000).toISOString() })
    await server.poller.run()
    expect(g.seen.some((s) => s.path.includes('/export'))).toBe(false)
    const list = g.seen.find((s) => s.path.startsWith('/drive/v3/files?'))
    expect(new URL(`http://x${list?.path}`).searchParams.get('q')).toBe(
      "mimeType='application/vnd.google-apps.document' and trashed=false and createdTime > '2026-10-10T03:00:00.000Z'",
    )
  })

  it('書き足されたら読み直し、増えた項目だけを出す。見送った項目は出し直さない', async () => {
    await setup()
    note('f1', [MINE])
    meetReply = () => say({ items: [pick(1, '本人')] })
    await server.poller.run()
    const first = meetCandidateId('f1', MINE)
    expect(
      (await send('POST', `/api/candidates/${first}/actions`, { type: 'dismiss', reason: 'もう済んだ' })).status,
    ).toBe(200)
    const added = '[岩間 涼] 報告メモ: 岩間 涼 が結果をメモにまとめる。'
    note('f1', [MINE, added], { modified: new Date(clock.getTime() - 20 * 60_000).toISOString() })
    meetReply = () => say({ items: [pick(1, '本人'), pick(2, '本人')] })
    await server.poller.run()
    expect(meetCalls()).toHaveLength(2)
    expect((await home_()).candidates.meeting.map((c) => c.id)).toEqual([meetCandidateId('f1', added)])
  })

  it('モデルが失敗したら記録せず次の回にもう一度。3 回続いたらその版は飛ばす', async () => {
    await setup()
    note('f1', [MINE])
    meetReply = () => ({ text: 'JSON ではない', costYen: 0 })
    for (let i = 0; i < 4; i++) await server.poller.run()
    expect(meetCalls().length).toBe(6) // 1 回に言い直しを含めて 2 回呼ぶ × 3 回
    expect((await home_()).meetNotes).toEqual([])
  })

  it('Meet のファイルの許可が無い連携では一覧を呼ばず、設定に連携し直しを促す', async () => {
    await setup({ scope: `${GMAIL_SCOPE} ${DRIVE_SCOPE}` })
    note('f1', [MINE])
    await server.poller.run()
    expect(g.seen.some((s) => s.path.startsWith('/drive/v3/files?'))).toBe(false)
    expect((await connections()).google).toMatchObject({ meet: false, docs: true })
  })

  it('Drive API が無効なら meetProblem: api_disabled', async () => {
    await setup()
    g.state.fail = {
      status: 403,
      body: JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }] } }),
      times: 5,
      path: /^\/drive\/v3\/files$/,
    }
    await server.poller.run()
    expect((await connections()).google).toMatchObject({ meet: true, meetProblem: 'api_disabled' })
  })
})

describe('候補の操作（6.7 (4)）', () => {
  it('進める: intake.json の由来は会議、入口の下書き役には行動項目の節だけを渡す。会議のカードは「拾わなくてよい」を受けない', async () => {
    await setup({
      script: [
        { role: '下書き役・依頼書', nth: 1, reply: { text: JSON.stringify(briefDraft) } },
        { role: '下書き役・確認項目', nth: 1, reply: { text: JSON.stringify({ checks: goodChecks }) } },
        { role: '事実係・分類', nth: 1, reply: { text: JSON.stringify(classified) } },
      ],
    })
    note('f1', [MINE, VAGUE])
    meetReply = () => say({ items: [pick(1, '本人'), pick(2, '曖昧')] })
    await server.poller.run()
    const id = meetCandidateId('f1', MINE)
    expect(
      (await send('POST', `/api/candidates/${id}/actions`, { type: 'dismiss', reason: '拾わなくてよい' })).status,
    ).toBe(400)
    const res = await send('POST', `/api/candidates/${id}/actions`, { type: 'proceed' })
    const { caseId } = (await res.json()) as { caseId: string }
    const intake = Intake.parse(JSON.parse(readFileSync(join(caseDir(home, caseId), 'intake.json'), 'utf-8')))
    expect(intake).toMatchObject({
      origin: { kind: '会議', confidence: '高' },
      source: { threadId: 'f1', account: 'me@example.com', subject: 'ブレスト' },
    })
    for (let i = 0; i < 100 && ledger.getCase(caseId)?.turn !== '本人'; i++) await new Promise((r) => setTimeout(r, 20))
    const brief = calls.find((c) => c.role === '下書き役・依頼書')
    const checks = calls.find((c) => c.role === '下書き役・確認項目')
    expect(material(brief, '外部資料（取り込み元の会議メモの行動項目）')?.text).toContain(ITEM_MARK)
    expect(JSON.stringify(brief?.materials)).not.toContain(OUTSIDE)
    expect(JSON.stringify(checks?.materials)).not.toContain(ITEM_MARK)

    // 推測・低のカードは 4 つ目の理由で見送れて、同じ会議の推測はもう出さない
    const low = meetCandidateId('f1', VAGUE)
    expect(
      (await send('POST', `/api/candidates/${low}/actions`, { type: 'dismiss', reason: '拾わなくてよい' })).status,
    ).toBe(200)
    expect(ledger.isSuppressed('sender', 'meet:ブレスト')).toBe(true)
  })
})
