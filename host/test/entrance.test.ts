// 入口の段取りと入口の面の API（docs/implementation.md 6.2.2・4.2 T5〜T9・T6b）。fake の台本で HTTP を叩く
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaseView, ConversationView } from '@libretto/shared/api'
import { BriefFile, ChecksFile, Intake, UndecidedFile } from '@libretto/shared/ledger'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STEP, transition } from '../src/case/transition.ts'
import { caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry, type ScriptReply } from '../src/model/fake.ts'
import { type Backend, createInvoke } from '../src/model/invoke.ts'
import { setKey } from '../src/model/keys.ts'
import { TALK } from '../src/roles/conversation.ts'
import { COOKIE, createServer } from '../src/server/app.ts'
import { briefDraft, classified, goodChecks } from './fixtures/entrance.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const TOKEN = 'abcdef0123456789abcdef0123456789'
const CLI_MARKERS = /claude|anthropic|openai|gpt|codex|prompt|branch|commit|\bPR\b|\bCI\b|model|holdout|scenario/i
let home: string
let ledger: Ledger
let server: ReturnType<typeof createServer>
let fake: ReturnType<typeof createFake>
let cookie: string
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const say = (v: unknown): ScriptReply => ({ text: JSON.stringify(v) })
const done = {
  text: '「ブレストのまとめ」として受け付けます。',
  intake: {
    title: 'ブレストのまとめ',
    summary: '先週のブレストを note 記事にまとめる',
    docType: '記事',
    audience: '一般の読者',
    destinations: ['paste', 'page'],
  },
}
type Role = ScriptEntry['role']
// 役割ごとに nth を数えて台本を並べる
function script(...rows: [Role, ScriptReply][]): ScriptEntry[] {
  const counts = new Map<Role, number>()
  return rows.map(([role, reply]) => {
    const nth = (counts.get(role) ?? 0) + 1
    counts.set(role, nth)
    return { role, nth, reply }
  })
}
const entranceOk = (): [Role, ScriptReply][] => [
  ['下書き役・依頼書', say(briefDraft)],
  ['下書き役・確認項目', say({ checks: goodChecks })],
  ['事実係・分類', say(classified)],
]

async function setup(
  entries: ScriptEntry[],
  wrap: (b: Backend) => Backend = (b) => b,
  openaiKey = false,
  jevKey = false,
) {
  n = 0
  home = mkdtempSync(join(tmpdir(), 'libretto-entrance-'))
  ledger = initHome(home)
  if (openaiKey) setKey(home, 'openai', 'sk-test-0123456789')
  if (jevKey) setKey(home, 'jev', 'jev-test-0123456789')
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<div></div>')
  fake = createFake(entries)
  const invoke = createInvoke({
    ledger,
    backends: { claude: wrap(fake.backend), openai: wrap(fake.backend), jev: wrap(fake.backend) },
    caps: () => ({ caseCapYen: 1500, monthCapYen: null }),
    onCostCap: () => {},
    log: () => {},
    retryWaitMs: 0,
    jobsDir: (id) => join(caseDir(home, id), 'jobs'),
  })
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke,
    log: () => {},
    runsWaitMs: 50,
    token: () => TOKEN,
  })
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
}
afterEach(async () => {
  await server?.runs.abortAll()
  ledger?.close()
})

const get = (path: string) => server.app.request(path, { headers: { cookie } })
const postJson = (path: string, body: unknown) =>
  server.app.request(path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const caseView = async (id: string) => CaseView.parse(await (await get(`/api/cases/${id}`)).json())
const act = (id: string, body: Record<string, unknown>) =>
  postJson(`/api/cases/${id}/actions`, { eventId: uuid(), ...body })
const waitTurn = (id: string, turn: '本人' | 'libretto' = '本人') =>
  vi.waitFor(() => expect(ledger.getCase(id)?.turn).toBe(turn), { timeout: 2000, interval: 5 })
const callsOf = (role: Role) => fake.calls.filter((c) => c.role === role)
const material = (call: { materials: { name: string }[] } | undefined, name: string) =>
  (call?.materials.find((m) => m.name === name) as { text: string } | undefined)?.text

// 会話で依頼して案件を作る（T5）
async function request(): Promise<string> {
  await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: 0, text: '記事にして' })
  await server.conversation.settled()
  const id = ledger.lastMessage('lobby')?.caseId
  if (!id) throw new Error('no case')
  return id
}
const approve = async (id: string, answers: Record<string, unknown>, eventId = uuid()) => {
  const v = await caseView(id)
  return postJson(`/api/cases/${id}/actions`, {
    eventId,
    type: 'entrance.approve',
    expectedRevision: v.revision,
    answers,
    mode: '確認しながら',
    setFingerprint: v.entrance?.setFingerprint,
  })
}
const file = <T>(id: string, name: string, schema: { parse: (v: unknown) => T }) =>
  schema.parse(JSON.parse(readFileSync(join(caseDir(home, id), name), 'utf-8')))

describe('入口の段取り', () => {
  it('T5 の後に依頼書 → 確認項目（言い直しで 7.2 に通る）→ 照合 → T6。組がファイルと応答に揃う', async () => {
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        // 1 回目は 4 件で 7.2 に落ちる
        ['下書き役・確認項目', say({ checks: goodChecks.slice(0, 4) })],
        ['下書き役・確認項目', say({ checks: goodChecks })],
        ['事実係・分類', say(classified)],
      ),
    )
    const id = await request()
    await waitTurn(id)
    const c = ledger.getCase(id)
    expect(c).toMatchObject({ state: '入口待ち', turn: '本人', step: STEP.entrance, revision: 1 })
    expect(fake.unused()).toEqual([])
    // 言い直しには違反の一覧が渡る
    expect(material(callsOf('下書き役・確認項目')[1], '直すところ')).toContain('5〜40')

    const v = await caseView(id)
    const e = v.entrance
    expect(e?.setFingerprint).toBe(c?.setFingerprint)
    // docType・保存先はホストが案件の行から
    expect(e?.brief).toMatchObject({
      docType: '記事',
      destinations: c?.destination,
      audience: '一般の読者。前提知識なし',
    })
    expect(e?.assumptions).toEqual(briefDraft.assumptions)
    expect(e?.undecided.items.map((u) => [u.id, u.recommended])).toEqual([['U01', ['a', 'b']]])
    expect(e?.undecided.mismatches).toEqual([
      { checkId: 'C03', briefSays: '依頼書は見出しの数を決めていません', checkExpects: '見出しは 4〜5 個' },
    ])
    // 下書き役 6 件 + canary + 形式 2 件（paste・page）。同系統と少数派
    expect(e?.checks).toMatchObject({ count: 9, family: '同系統' })
    expect(e?.checks.items.filter((x) => x.minority).map((x) => x.id)).toEqual(['C02', 'C05', 'C06'])
    expect(e?.checks.items.find((x) => x.isolation)).toMatchObject({ id: 'C07', title: '隔離の点検' })
    // canary の語は応答に出ない。ファイルにはある
    const raw = await (await get(`/api/cases/${id}`)).text()
    expect(raw).not.toContain(TOKEN)
    expect(readFileSync(join(caseDir(home, id), 'checks', 'checks.json'), 'utf-8')).toContain(TOKEN)
    for (const f of ['brief.md', 'undecided.md', 'checks/checks.md'])
      expect(existsSync(join(caseDir(home, id), f))).toBe(true)
    expect(readFileSync(join(caseDir(home, id), 'checks', 'checks.md'), 'utf-8')).not.toContain(TOKEN)
  })

  it('確認項目の下書き役には依頼書の形だけが渡り、受け皿（同系統）で呼ぶ', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk()))
    const id = await request()
    await waitTurn(id)
    const call = callsOf('下書き役・確認項目')[0]
    // 鍵が無いので別系統を呼ばずに同系統。少数派の指示付き（6.1.3 (5)）
    expect(callsOf('下書き役・確認項目')).toHaveLength(1)
    expect(call?.family).toBe('claude')
    expect(call?.instruction).toContain('少数派の項目を 3 件以上')
    expect((await caseView(id)).entrance?.checks).toMatchObject({ family: '同系統', fallback: 'no_key' })
    const all = JSON.stringify(call?.materials) + (call?.instruction ?? '')
    for (const s of [
      'ブレストで決まった 3 つの方針',
      '一般の読者。前提知識なし',
      '社名の実名',
      '文末はです・ます',
      'note の読者に合わせる',
    ])
      expect(all).not.toContain(s)
    expect(JSON.parse(material(call, '依頼書の形') ?? '{}')).toEqual({
      docType: '記事',
      destinations: [{ kind: 'paste' }, { kind: 'page', shared: false }],
      shape: '2,500 字前後、見出し 4〜5',
      voice: '合わせない',
      sources: '出典なし',
    })
    // 照合には下書き役の項目だけ（canary・形式の項目は渡さない）
    const listed = JSON.parse(material(callsOf('事実係・分類')[0], 'チェック項目') ?? '[]')
    expect(listed.map((x: { id: string }) => x.id)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06'])
    expect(JSON.stringify(listed)).not.toContain('summary')
    // 費用は案件に付く
    expect(
      ledger
        .listCosts(id)
        .filter((x) => x.type === 'hold')
        .map((x) => x.role),
    ).toEqual(['下書き役・依頼書', '下書き役・確認項目', '事実係・分類'])
  })

  it('T8 入口の承認: 答えと承認版の指紋をトランザクションの前にファイルへ。二度目は同じ結果で書き直さない', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk(), ['作り手', { fail: 'hang' }]))
    const id = await request()
    await waitTurn(id)
    // 答えが足りない・選択肢に無い → 400。承認されない
    expect((await approve(id, {})).status).toBe(400)
    expect((await approve(id, { U01: 'b' })).status).toBe(400) // 前の形の文字列は受けない
    expect((await approve(id, { U01: ['z'] })).status).toBe(400)
    expect((await approve(id, { U01: [] })).status).toBe(400)
    expect(ledger.getCase(id)?.state).toBe('入口待ち')

    const eventId = uuid()
    const res = await approve(id, { U01: ['b'] }, eventId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: '材料待ち', turn: 'libretto' })
    // runner が作業場を組み立てて下書きへ進める（6.2.3 (2)）
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '下書き中', turn: 'libretto' }))
    const fp = ledger.getCase(id)?.setFingerprint
    const brief = file(id, 'brief.json', BriefFile)
    expect(brief).toMatchObject({
      approvedFingerprint: fp,
      decisions: [
        { undecidedId: 'U01', answer: ['b'], label: '読み終えた人に何を持ち帰ってほしいですか？ → 次に試すこと' },
      ],
    })
    expect(file(id, 'undecided.json', UndecidedFile).answers).toEqual({ U01: ['b'] })
    expect(file(id, 'checks/checks.json', ChecksFile).approvedFingerprint).toBe(fp)
    expect(readFileSync(join(caseDir(home, id), 'brief.md'), 'utf-8')).toContain('## 決めたこと')
    // 応答の答えは承認の後に出る
    expect((await caseView(id)).entrance?.undecided.items[0]?.answer).toEqual(['b'])

    // 応答が失われた再送: 状態はもう進んでいるが、同じ結果を返し、ファイルを書き直さない
    const before = readFileSync(join(caseDir(home, id), 'brief.json'), 'utf-8')
    const again = await postJson(`/api/cases/${id}/actions`, {
      eventId,
      type: 'entrance.approve',
      expectedRevision: 1,
      answers: { U01: ['a'] },
      mode: '確認しながら',
      setFingerprint: fp,
    })
    expect(again.status).toBe(200)
    expect((await again.json()).replayed).toBe(true)
    expect(readFileSync(join(caseDir(home, id), 'brief.json'), 'utf-8')).toBe(before)
  })

  it('全部選べる問いと 1 つだけの問い: おすすめが複数、答えは選択肢の並び順の文で brief.md の「決めたこと」に出る（6.2.6）', async () => {
    const many = {
      checkId: 'C04',
      verdict: '決まらない',
      question: '語り口の目安はどうしますか？',
      options: [
        { id: 'a', label: '過去の文章を渡してもらう' },
        { id: 'b', label: '丁寧で柔らかい調子にする' },
        { id: 'c', label: '落ち着いた書き言葉にする' },
      ],
      multiple: true,
      recommended: ['a', 'b'],
    }
    const one = {
      checkId: 'C05',
      verdict: '決まらない',
      question: 'どのくらいの長さにしますか？',
      options: [
        { id: 'a', label: '1,000 字ほど' },
        { id: 'b', label: '3,000 字ほど' },
      ],
      multiple: false,
      recommended: ['a'],
    }
    const items = classified.items.map((i) => (i.checkId === 'C04' ? many : i.checkId === 'C05' ? one : i))
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ['下書き役・確認項目', say({ checks: goodChecks })],
        ['事実係・分類', say({ items })],
        ['作り手', { fail: 'hang' }],
      ),
    )
    const id = await request()
    await waitTurn(id)
    expect((await caseView(id)).entrance?.undecided.items[1]).toMatchObject({
      id: 'U02',
      multiple: true,
      recommended: ['a', 'b'],
    })
    const rest = { U01: '任せる', U03: ['a'] }
    expect((await approve(id, { ...rest, U02: ['a', 'z'] })).status).toBe(400)
    expect((await approve(id, { ...rest, U02: ['a', 'a'] })).status).toBe(400)
    expect((await approve(id, { ...rest, U02: ['a'], U03: ['a', 'b'] })).status).toBe(400) // 1 つだけの問いに 2 件

    const res = await approve(id, { U01: '任せる', U02: ['b', 'a'], U03: ['a'] })
    expect(res.status).toBe(200)
    const label = '語り口の目安はどうしますか？ → 過去の文章を渡してもらう、丁寧で柔らかい調子にする'
    expect(file(id, 'brief.json', BriefFile).decisions[1]).toEqual({ undecidedId: 'U02', answer: ['b', 'a'], label })
    const md = readFileSync(join(caseDir(home, id), 'brief.md'), 'utf-8')
    expect(md).toContain(`- ${label}`)
    expect(md).toContain('→ おまかせする')
    expect(readFileSync(join(caseDir(home, id), 'undecided.md'), 'utf-8')).toContain(
      '語り口の目安はどうしますか？（当てはまるものを全部）',
    )
    expect(ledger.listDecisions(id).at(-1)?.text).toBe('U01: 任せる\nU02: b、a\nU03: a')
  })

  it('T7 直して出し直す: 2 回目の組は v2 のファイル。前の依頼書と本人の指示が下書き役に渡る', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk(), ...entranceOk()))
    const id = await request()
    await waitTurn(id)
    const first = (await caseView(id)).entrance?.setFingerprint
    const res = await act(id, { type: 'entrance.revise', expectedRevision: 1, note: '読者を社内の人に' })
    expect(res.status).toBe(200)
    await waitTurn(id)
    const second = callsOf('下書き役・依頼書')[1]
    expect(material(second, '本人の指示')).toBe(JSON.stringify('読者を社内の人に'))
    expect(material(second, '前の依頼書')).toContain('一般の読者。前提知識なし')
    expect(material(callsOf('下書き役・確認項目')[1], '前のチェック項目')).not.toContain(TOKEN)
    for (const f of ['brief.v2.json', 'undecided.v2.json', 'checks/checks.v2.json', 'brief.json'])
      expect(existsSync(join(caseDir(home, id), f))).toBe(true)
    const v = await caseView(id)
    expect(v.revision).toBe(3)
    expect(v.entrance?.setFingerprint).toBe(ledger.getCase(id)?.setFingerprint)
    // 中身が同じ組でも指紋は台帳の今の組を指す（canary の語が同じなので同じ指紋になる）
    expect(v.entrance?.setFingerprint).toBe(first)
  })

  it('T6b 検査に 2 回とも落ちたら turn=本人 で「整えられませんでした」。出し直せる', async () => {
    const bad = say({ checks: goodChecks.slice(0, 3) })
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ['下書き役・確認項目', bad],
        ['下書き役・確認項目', bad],
        ...entranceOk(),
      ),
    )
    const id = await request()
    await waitTurn(id)
    expect(ledger.getCase(id)).toMatchObject({ state: '入口待ち', turn: '本人', step: STEP.entranceFailed })
    expect((await caseView(id)).entrance).toBeUndefined()
    expect((await act(id, { type: 'entrance.revise', expectedRevision: 1, note: 'もう一度' })).status).toBe(200)
    await waitTurn(id)
    expect(ledger.getCase(id)?.step).toBe(STEP.entrance)
    expect(existsSync(join(caseDir(home, id), 'brief.json'))).toBe(true)
  })

  it('つながらないときは止める（T27b）。止めたら画面に知らせる', async () => {
    await setup(script(['話し相手', say(done)], ['下書き役・依頼書', { fail: 'unavailable' }]))
    const seen: string[] = []
    server.hub.subscribe((m) => {
      if (m.event === 'case.changed') seen.push(JSON.parse(m.data).state)
    })
    const id = await request()
    await vi.waitFor(() => expect(ledger.getCase(id)?.state).toBe('停止'))
    expect(ledger.getCase(id)?.stopReason).toBe('つながらない')
    expect(seen).toContain('停止')
  })

  it('ログインが切れたときは止めずに待ち、「続ける」で流し直す（6.2.3 (7)）', async () => {
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', { fail: 'unavailable', why: 'auth_expired' }],
        ...entranceOk(),
      ),
    )
    const id = await request()
    await vi.waitFor(() => expect(server.entrance.running()).toEqual([]))
    expect(ledger.getCase(id)).toMatchObject({ state: '入口待ち', turn: 'libretto' })
    expect(server.status.signIn).toBe(true)
    // 待っている間は起動の起こし直しでも呼ばない
    server.runner.resume()
    expect(server.entrance.running()).toEqual([])
    expect(await (await postJson('/api/host/resume', {})).json()).toMatchObject({ signIn: false })
    await waitTurn(id)
  })

  it('T31 新しい入口として出し直す: intake を写し、元の依頼書を材料に。2 回続けて出し直しても動く', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk(), ...entranceOk(), ...entranceOk()))
    const a = await request()
    await waitTurn(a)
    const restart = async (id: string) => {
      const v = await caseView(id)
      expect((await act(id, { type: 'stop.case', expectedRevision: v.revision })).status).toBe(200)
      const r = await act(id, { type: 'restart_as_new', expectedRevision: v.revision + 1 })
      const next = (await r.json()).newCaseId as string
      await waitTurn(next)
      return next
    }
    const b = await restart(a)
    expect(file(b, 'intake.json', Intake)).toMatchObject({ parentCaseId: a, summary: done.intake.summary })
    expect(material(callsOf('下書き役・依頼書')[1], '前の依頼書')).toContain('一般の読者。前提知識なし')
    const c = await restart(b)
    expect(file(c, 'intake.json', Intake)).toMatchObject({ parentCaseId: b, heard: { audience: '一般の読者' } })
  })

  it('起動時に入口待ちで libretto の番の案件を流し直す', async () => {
    await setup(script(...entranceOk()))
    const id = 'c-boot'
    mkdirSync(caseDir(home, id), { recursive: true })
    writeFileSync(
      join(caseDir(home, id), 'intake.json'),
      JSON.stringify({ origin: { kind: '会話' }, summary: 'まとめ', materials: [] }),
    )
    transition(ledger, {
      type: 'conversation.request',
      eventId: 'boot',
      caseId: id,
      title: 'まとめ',
      mode: '確認しながら',
      docType: '記事',
      destination: [{ kind: 'page', shared: false }],
    })
    server.runner.resume()
    await waitTurn(id)
  })

  it('動いている間の出し直し（自動で入った案件）は、動いている方を止めて新しい revision で始め直す', async () => {
    await setup(script(['下書き役・依頼書', { fail: 'hang' }], ...entranceOk()))
    const id = 'c-auto'
    mkdirSync(caseDir(home, id), { recursive: true })
    writeFileSync(
      join(caseDir(home, id), 'intake.json'),
      JSON.stringify({ origin: { kind: '会話' }, summary: 'x', materials: [] }),
    )
    ledger.insertCase({
      eventId: 'auto',
      caseId: id,
      title: 'x',
      state: '入口待ち',
      turn: 'libretto',
      step: STEP.drafting,
      mode: 'おまかせ',
      origin: { kind: '合図', source: 'gmail' },
      auto: true,
      docType: '記事',
      destination: [{ kind: 'page', shared: false }],
    })
    server.entrance.kick(id)
    await vi.waitFor(() => expect(callsOf('下書き役・依頼書')).toHaveLength(1))
    expect((await act(id, { type: 'entrance.revise', expectedRevision: 0, note: '短く' })).status).toBe(200)
    // 自動で入った案件は T6 の後も turn=libretto（T8 の自動発火は Issue 25）
    await vi.waitFor(() => expect(ledger.getCase(id)?.setFingerprint).toBeDefined())
    expect(ledger.getCase(id)).toMatchObject({ turn: 'libretto', step: STEP.autoEntrance, revision: 2 })
    expect(material(callsOf('下書き役・依頼書')[1], '本人の指示')).toBe(JSON.stringify('短く'))
  })
})

describe('案件の中で話す（話して内容を変える）', () => {
  const revise = { text: '読者を社内の人に変えて、依頼書とチェック項目を直します。', revise: '読者を社内の人に変える' }
  const caseTalk = async (id: string, text: string) => {
    const last = ledger.lastMessage(id)?.seq ?? 0
    const res = await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: last, text, caseId: id })
    await server.conversation.settled()
    return res
  }

  it('直す内容がまとまったら T7 と返事の行を一緒に書き、出し直す。依頼書は渡り、チェック項目は渡らない', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk(), ['話し相手', say(revise)], ...entranceOk()))
    const id = await request()
    await waitTurn(id)
    expect((await caseTalk(id, '社内向けにして')).status).toBe(202)
    const conv = ConversationView.parse(await (await get(`/api/conversation?caseId=${id}`)).json())
    expect(conv.messages.map((m) => [m.who, m.text])).toEqual([
      ['本人', '社内向けにして'],
      ['libretto', revise.text],
    ])
    expect(ledger.findEvent(`${id}:conversation.revise:${conv.messages[0]?.seq}`)).toMatchObject({
      type: 'transition',
      event: 'entrance.revise',
    })
    const talk = callsOf('話し相手')[1]
    expect(talk?.caseId).toBe(id)
    expect(material(talk, '依頼書')).toContain('一般の読者。前提知識なし')
    expect(JSON.stringify(talk?.materials)).not.toContain('初見の読者')
    await waitTurn(id)
    expect(material(callsOf('下書き役・依頼書')[1], '本人の指示')).toBe(JSON.stringify('読者を社内の人に変える'))
  })

  it('書いている間は 409 busy、入口を過ぎたら 409 stale', async () => {
    await setup(script(['話し相手', say(done)], ['下書き役・依頼書', { fail: 'hang' }]))
    const id = await request()
    expect((await caseTalk(id, 'x')).status).toBe(409)
    await server.runs.abortAll()
    transition(ledger, { type: 'stop.case', caseId: id, eventId: 'stop', expectedRevision: 0, by: '本人' })
    const res = await caseTalk(id, 'x')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'stale' })
  })

  it('まとまる前に状態が変わっていたら、固定の 1 行を書いて出し直さない', async () => {
    // 案件の中の話し相手の返事は、承認の後まで止めておく
    let open = () => {}
    const gate = new Promise<void>((r) => {
      open = r
    })
    await setup(
      script(['話し相手', say(done)], ...entranceOk(), ['話し相手', say(revise)], ['作り手', { fail: 'hang' }]),
      (b) => async (call) => {
        if (call.role === '話し相手' && call.caseId !== '会話') await gate
        return b(call)
      },
    )
    const id = await request()
    await waitTurn(id)
    const last = ledger.lastMessage(id)?.seq ?? 0
    await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: last, text: '社内向けに', caseId: id })
    expect((await approve(id, { U01: ['a'] })).status).toBe(200)
    open()
    await server.conversation.settled()
    expect(ledger.lastMessage(id)?.text).toBe(TALK.moved)
    expect(ledger.getCase(id)?.state).toBe('下書き中')
  })

  it('本人に見える応答に CLI の語が無い', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk()))
    const id = await request()
    await waitTurn(id)
    const v = await caseView(id)
    const e = v.entrance
    const shown = [
      v.step,
      ...(e?.checks.items.flatMap((x) => [x.title, x.summary]) ?? []),
      ...(e?.undecided.items.map((u) => u.question) ?? []),
    ]
    for (const s of shown) expect(s).not.toMatch(CLI_MARKERS)
    expect(COOKIE).toBe('libretto_session')
  })
})

describe('別系統の確認項目（6.1.3 (5)）', () => {
  const MINORITY = '少数派の項目を 3 件以上'
  const noMinority = goodChecks.map(({ minority: _, ...c }) => c)

  it('鍵があれば別系統で書き、少数派を求めない。依頼書の本文は渡らない', async () => {
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ['下書き役・確認項目', say({ checks: noMinority })],
        ['事実係・分類', say(classified)],
      ),
      undefined,
      true,
    )
    const id = await request()
    await waitTurn(id)
    const calls = callsOf('下書き役・確認項目')
    expect(calls.map((c) => [c.family, c.model])).toEqual([['openai', 'codex']])
    expect(calls[0]?.instruction).not.toContain(MINORITY)
    expect(JSON.stringify(calls[0]?.materials)).not.toContain('ブレストで決まった 3 つの方針')
    const e = (await caseView(id)).entrance
    expect(e?.checks.family).toBe('別系統')
    expect(e?.checks.fallback).toBeUndefined()
    expect(file(id, 'checks/checks.json', ChecksFile)).toMatchObject({ family: '別系統' })
    expect(ledger.listCosts(id).find((x) => x.type === 'hold' && x.role === '下書き役・確認項目')).toMatchObject({
      family: 'openai',
    })
  })

  it.each([
    ['つながらない', [{ fail: 'unavailable' }] as ScriptReply[]],
    ['出力が 2 回とも通らない', [{ text: '{broken' }, { text: '{"checks":[]}' }] as ScriptReply[]],
  ])('別系統が%sなら、同系統に少数派の指示を足して書き直す', async (_, bad) => {
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ...bad.map((r): [Role, ScriptReply] => ['下書き役・確認項目', r]),
        ['下書き役・確認項目', say({ checks: goodChecks })],
        ['事実係・分類', say(classified)],
      ),
      undefined,
      true,
    )
    const id = await request()
    await waitTurn(id)
    const calls = callsOf('下書き役・確認項目')
    expect(calls.map((c) => c.family)).toEqual([...bad.map(() => 'openai'), 'claude'])
    expect(calls.at(-1)?.instruction).toContain(MINORITY)
    expect((await caseView(id)).entrance?.checks).toMatchObject({ family: '同系統', fallback: 'unavailable' })
    expect(file(id, 'checks/checks.json', ChecksFile)).toMatchObject({ family: '同系統', fallback: 'unavailable' })
  })

  it('別系統が費用の上限で止まったら、同系統に落とさない', async () => {
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ['下書き役・確認項目', { fail: 'budget' }],
      ),
      undefined,
      true,
    )
    const id = await request()
    await vi.waitFor(() => expect(callsOf('下書き役・確認項目')).toHaveLength(1))
    await server.runs.abortAll()
    expect(callsOf('下書き役・確認項目').map((c) => c.family)).toEqual(['openai'])
    expect(fake.unused()).toEqual([])
    expect(ledger.getCase(id)?.state).toBe('入口待ち')
  })
})

describe('受け入れ (3): 確認項目の下書き役に依頼書の本文が渡っていない（8.4・8.10 (3)）', () => {
  it('1 回目・言い直し・同系統への落ち方のどれにも依頼書の語が無く、jobs/ の記録は名前・大きさ・sha256 だけ', async () => {
    const SECRET = ['依頼書だけの語ア', '依頼書だけの語イ', '依頼書だけの語ウ', '仮定だけの語エ']
    const brief = {
      brief: {
        ...briefDraft.brief,
        subject: `${briefDraft.brief.subject}${SECRET[0]}`,
        audience: `${briefDraft.brief.audience}${SECRET[1]}`,
        mustNot: [...briefDraft.brief.mustNot, SECRET[2] as string],
      },
      assumptions: [{ id: 'A1', text: `文末はです・ます${SECRET[3]}`, why: 'note の読者に合わせる' }],
    }
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(brief)],
        ['下書き役・確認項目', { text: '{broken' }],
        ['下書き役・確認項目', { fail: 'unavailable' }],
        ['下書き役・確認項目', say({ checks: goodChecks })],
        ['事実係・分類', say(classified)],
      ),
      undefined,
      true,
    )
    const id = await request()
    await waitTurn(id)
    // 渡った入力（中身が受け取ったもの）に依頼書・仮定の語が無い
    const calls = callsOf('下書き役・確認項目')
    expect(calls).toHaveLength(3)
    for (const c of calls) for (const s of SECRET) expect(JSON.stringify([c.instruction, c.materials])).not.toContain(s)
    // 語は依頼書の本文に入っている（置き方が効いている）
    expect(readFileSync(join(caseDir(home, id), 'brief.json'), 'utf-8')).toContain(SECRET[0])

    // jobs/: 確認項目の下書き役は Job ごとに 1 件（別系統の 1 回目と言い直しで 1 件、同系統で 1 件）
    const dir = join(caseDir(home, id), 'jobs')
    const names = readdirSync(dir)
      .filter((f) => f.startsWith('下書き役・確認項目-'))
      .sort()
    expect(names).toEqual(['下書き役・確認項目-1.json', '下書き役・確認項目-2.json'])
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    for (const [i, name] of names.entries()) {
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
      const sent = calls[i === 0 ? 0 : 2] as (typeof calls)[number]
      expect(rec.instruction).toBe(sent.instruction)
      for (const s of SECRET) expect(JSON.stringify(rec)).not.toContain(s)
      // 材料は許した顔ぶれだけで、本文は入らず、sha256 は渡したものと一致する
      expect(rec.materials.map((m: { name: string }) => m.name)).toEqual(['依頼', '依頼書の形'])
      for (const m of rec.materials) {
        const text = (sent.materials.find((x) => x.name === m.name) as { text: string }).text
        expect(m).toEqual({ name: m.name, chars: text.length, sha256: sha(text) })
      }
    }
  })
})

describe('項目の点検（7.6 (7)）', () => {
  // 項目ごとに 3 つの問いへ答える Jev（全部の qid を 1 つの答えに並べる。送っていない qid は使われない）
  const inspected = (v: (id: string, k: string) => number): ScriptReply =>
    say({
      answers: Object.fromEntries(
        goodChecks.flatMap((c) => ['derivable', 'positive', 'shapeOnly'].map((k) => [`${c.id}:${k}`, v(c.id, k)])),
      ),
    })
  const jevRows = (r: ScriptReply): [Role, ScriptReply][] => goodChecks.map(() => ['事実係・命題', r])

  it('同系統で書き、Jev の鍵があれば点検し、決まらない見込みを分類に渡し、形だけの項目を書く側にも伝わる側に出す', async () => {
    const r = inspected((id, k) =>
      k === 'positive' ? 0.9 : k === 'derivable' ? (id === 'C02' ? 0.2 : 0.8) : id === 'C06' ? 0.9 : 0.1,
    )
    await setup(
      script(
        ['話し相手', say(done)],
        ...entranceOk().slice(0, 2),
        ...jevRows(r),
        entranceOk()[2] as [Role, ScriptReply],
      ),
      undefined,
      false,
      true,
    )
    const id = await request()
    await waitTurn(id)
    const asks = callsOf('事実係・命題')
    expect(asks).toHaveLength(goodChecks.length)
    expect(asks.every((c) => c.family === 'jev')).toBe(true)
    // state は依頼と項目。summary は渡さない
    expect(asks[0]?.materials.map((m) => m.name)).toEqual(['依頼', '項目'])
    expect(JSON.stringify(asks)).not.toContain(goodChecks[0]?.summary)
    expect(material(callsOf('事実係・分類')[0], '依頼から決まらない見込みの項目')).toBe('["C02"]')
    expect(file(id, 'checks/checks.json', ChecksFile)).toMatchObject({ inspected: true, shapeOnly: ['C06'] })
    const items = (await caseView(id)).entrance?.checks.items ?? []
    // ファイルの hidden は変えず、入口の面でだけ書く側にも伝わる側に出す
    expect(file(id, 'checks/checks.json', ChecksFile).checks.find((c) => c.id === 'C06')?.hidden).toBe(true)
    expect(items.find((x) => x.id === 'C06')?.hidden).toBe(false)
    expect(items.find((x) => x.id === 'C05')?.hidden).toBe(true)
  })

  it('肯定形でない見込みの項目があれば、下書き役に 1 回だけ書き直させてもう 1 度点検する', async () => {
    const bad = inspected((id, k) => (k === 'positive' && id === 'C05' ? 0.2 : 0.8))
    const good = inspected(() => 0.8)
    await setup(
      script(
        ['話し相手', say(done)],
        ...entranceOk().slice(0, 2),
        ...jevRows(bad),
        ['下書き役・確認項目', say({ checks: goodChecks })],
        ...jevRows(good),
        entranceOk()[2] as [Role, ScriptReply],
      ),
      undefined,
      false,
      true,
    )
    const id = await request()
    await waitTurn(id)
    const drafts = callsOf('下書き役・確認項目')
    expect(drafts).toHaveLength(2)
    expect(material(drafts[1], '書き直してほしい項目')).toBe('["C05"]')
    expect(JSON.parse(material(drafts[1], '前のチェック項目') ?? '[]')).toHaveLength(goodChecks.length)
    expect(callsOf('事実係・命題')).toHaveLength(goodChecks.length * 2)
    expect(fake.unused()).toEqual([])
  })

  it('Jev の鍵が無い・別系統で書いたときは点検しない', async () => {
    await setup(script(['話し相手', say(done)], ...entranceOk()))
    const id = await request()
    await waitTurn(id)
    expect(callsOf('事実係・命題')).toHaveLength(0)
    expect(file(id, 'checks/checks.json', ChecksFile).inspected).toBeUndefined()

    const noMinority = goodChecks.map(({ minority: _, ...c }) => c)
    await setup(
      script(
        ['話し相手', say(done)],
        ['下書き役・依頼書', say(briefDraft)],
        ['下書き役・確認項目', say({ checks: noMinority })],
        ['事実係・分類', say(classified)],
      ),
      undefined,
      true,
      true,
    )
    const id2 = await request()
    await waitTurn(id2)
    expect(callsOf('事実係・命題')).toHaveLength(0)
  })
})
