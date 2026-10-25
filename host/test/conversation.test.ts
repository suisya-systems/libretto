// 話し相手と会話欄（docs/implementation.md 6.2.1）。fake の台本で HTTP を叩く
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationView } from '@libretto/shared/api'
import { Intake } from '@libretto/shared/ledger'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markerCheck } from '../src/facts/markers.ts'
import { caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry, type ScriptReply } from '../src/model/fake.ts'
import { createInvoke } from '../src/model/invoke.ts'
import { RETRY, replyViolations, TALK } from '../src/roles/conversation.ts'
import { COOKIE, createServer } from '../src/server/app.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const CLI_MARKERS = /claude|anthropic|openai|gpt|codex|prompt|branch|commit|\bPR\b|\bCI\b|model|holdout|scenario/i
let home: string
let ledger: Ledger
let server: ReturnType<typeof createServer>
let fake: ReturnType<typeof createFake>
let cookie: string
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const question = {
  text: '誰に読んでもらう記事ですか？',
  choices: [
    { id: 'a', label: '社内の人', recommended: false, why: '前提を省いて書きます' },
    { id: 'b', label: '一般の読者', recommended: true, why: 'note に載せるなら前提なしで読めるように書きます' },
  ],
}
const done = {
  text: '「ブレストのまとめ」として受け付けます。依頼書とチェック項目ができたら確認をお願いします。',
  intake: {
    title: 'ブレストのまとめ',
    summary: '先週のブレストを note 記事にまとめる',
    docType: '記事',
    audience: '一般の読者',
    destinations: ['paste', 'page', 'paste'],
    deadline: '今週中',
  },
}
const material = (call: { materials: { name: string }[] } | undefined, name: string) =>
  (call?.materials.find((m) => m.name === name) as { text: string } | undefined)?.text ?? ''
const say = (v: unknown): ScriptReply => ({ text: JSON.stringify(v) })
const talk = (...replies: ScriptReply[]): ScriptEntry[] =>
  replies.map((reply, i) => ({ role: '話し相手', nth: i + 1, reply }))

async function setup(script: ScriptEntry[]) {
  home = mkdtempSync(join(tmpdir(), 'libretto-conv-'))
  ledger = initHome(home)
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir)
  writeFileSync(join(staticDir, 'index.html'), '<div></div>')
  fake = createFake(script)
  const invoke = createInvoke({
    ledger,
    backends: { claude: fake.backend },
    caps: () => ({ caseCapYen: 1500, monthCapYen: null }),
    onCostCap: () => {},
    log: () => {},
    retryWaitMs: 0,
  })
  server = createServer({ home, ledger, origins: [ORIGIN], staticDir, invoke, log: () => {}, runsWaitMs: 50 })
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname, { method: 'POST' })
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
}
afterEach(async () => {
  await server?.runs.abortAll()
  ledger?.close()
})
// T5 の後に入口の段取りが起こす依頼書の下書き役は、止めるまで返さない（ここでは会話だけを見る）
const drafting = (n = 1): ScriptEntry[] =>
  Array.from({ length: n }, (_, i) => ({ role: '下書き役・依頼書', nth: i + 1, reply: { fail: 'hang' } }))

const view = async (q = '') => ConversationView.parse(await (await get(`/api/conversation${q}`)).json())
const get = (path: string) => server.app.request(path, { headers: { cookie } })
const post = (body: unknown) =>
  server.app.request('/api/conversation/messages', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
// 画面と同じく、見ている最後の行の seq を添えて送り、返事を待つ
async function send(body: { text: string } | { choiceId: string }, requestId = uuid()) {
  const last = (await view()).messages.at(-1)?.seq ?? 0
  const res = await post({ requestId, lastSeq: last, ...body })
  await server.conversation.settled()
  return res
}

describe('会話欄', () => {
  beforeEach(() => {
    n = 0
  })

  it('質問には選択肢とおすすめが付き、選択肢を押すと次の往復になる', async () => {
    await setup(talk(say(question), say(done)))
    const res = await send({ text: '先週のブレストを note 記事にまとめて' })
    expect(res.status).toBe(202)
    let v = await view()
    expect(v.pending).toBe(false)
    expect(v.messages.map((m) => [m.who, m.text])).toEqual([
      ['本人', '先週のブレストを note 記事にまとめて'],
      ['libretto', question.text],
    ])
    expect(v.messages[1]?.choices?.find((c) => c.recommended)?.label).toBe('一般の読者')

    await send({ choiceId: 'b' })
    v = await view()
    expect(v.messages[2]).toMatchObject({ who: '本人', text: '一般の読者', choiceId: 'b' })
    // 2 回目の話し相手には、前の往復が履歴に、押した選択肢が本人の発話として渡る
    const second = fake.calls[1]
    expect(second?.materials.find((m) => m.name === '本人の発話')).toMatchObject({
      text: '（選択肢を選んだ）一般の読者',
    })
    const history = JSON.parse(material(second, '会話'))
    expect(history.map((h: { who: string }) => h.who)).toEqual(['本人', 'libretto'])
  })

  it('T5 必須項目が揃うと案件を作り、返事の行に案件 id と intake.json が付く', async () => {
    await setup([...talk(say(done)), ...drafting()])
    await send({ text: '先週のブレストを一般向けに note に貼る記事にして、自分用のページも' })
    const v = await view()
    const receipt = v.messages.at(-1)
    expect(receipt).toMatchObject({ who: 'libretto', text: done.text })
    const caseId = receipt?.caseId as string
    const c = ledger.getCase(caseId)
    expect(c).toMatchObject({
      state: '入口待ち',
      turn: 'libretto',
      origin: { kind: '会話' },
      title: 'ブレストのまとめ',
      mode: '確認しながら',
      docType: '記事',
      deadline: '今週中',
      destination: [{ kind: 'paste' }, { kind: 'page', shared: false }],
    })
    expect(ledger.findEvent(`lobby:conversation.request:${v.messages[0]?.seq}`)).toMatchObject({ type: 'created' })
    const intake = Intake.parse(JSON.parse(readFileSync(join(caseDir(home, caseId), 'intake.json'), 'utf-8')))
    expect(intake).toMatchObject({ origin: { kind: '会話' }, conversationRef: { thread: 'lobby', seq: 1 } })
    expect(intake.heard?.audience).toBe('一般の読者')
    expect(existsSync(join(caseDir(home, caseId), 'intake.md'))).toBe(true)
    // ホームの進行中に出る
    const homeView = await (await get('/api/home')).json()
    expect(homeView.active.map((x: { id: string }) => x.id)).toEqual([caseId])
  })

  it('T5 の後の依頼は、前の依頼の会話を履歴に入れない', async () => {
    await setup([...talk(say(done), say(question)), ...drafting()])
    await send({ text: '一つ目' })
    await send({ text: '二つ目の依頼' })
    const history = JSON.parse(material(fake.calls.filter((c) => c.role === '話し相手')[1], '会話'))
    expect(history).toEqual([])
    // 画面には前の依頼の行も残る
    expect((await view()).messages).toHaveLength(4)
  })

  it('知らせ（選択肢も intake も無い）は「？」が無ければ通る', async () => {
    await setup(talk(say({ text: 'ブレストのまとめはいまチェックしています。' })))
    await send({ text: 'あの記事どうなった' })
    expect((await view()).messages.at(-1)).toMatchObject({
      who: 'libretto',
      text: 'ブレストのまとめはいまチェックしています。',
    })
  })

  it('自前点検に落ちたら 1 回だけ言い直させ、直れば通る', async () => {
    const bad = { ...question, text: '読者を確認することができますか？' }
    await setup(talk(say(bad), say(question)))
    await send({ text: '記事にして' })
    expect((await view()).messages.at(-1)?.text).toBe(question.text)
    const fix = fake.calls[1]?.materials.find((m) => m.name === '直すところ') as { text: string }
    expect(fix.text).toContain('することができ')
  })

  it('2 回とも落ちたら失敗の 1 行ともう一度送るを書き、押すと同じ発話で呼び直す', async () => {
    const noChoices = { text: '誰が読みますか？' }
    await setup(talk(say(noChoices), say(noChoices), say(question)))
    await send({ text: '記事にして' })
    let last = (await view()).messages.at(-1)
    expect(last).toMatchObject({ who: 'libretto', text: TALK.failed, choices: [{ id: RETRY, label: TALK.retry }] })

    await send({ choiceId: RETRY })
    const v = await view()
    last = v.messages.at(-1)
    expect(last?.text).toBe(question.text)
    expect(v.messages.map((m) => m.text)).toEqual(['記事にして', TALK.failed, TALK.retry, question.text])
    // 呼び直しは、失敗の行を混ぜずに元の発話で
    const call = fake.calls[2]
    expect(call?.materials.find((m) => m.name === '本人の発話')).toMatchObject({ text: '記事にして' })
    expect(JSON.parse(material(call, '会話'))).toEqual([])
  })

  it('返事が届かなかった本人の行の後も、もう一度送るで呼び直せる', async () => {
    await setup(talk(say(question)))
    ledger.appendMessage({ thread: 'lobby', who: '本人', text: '記事にして' })
    expect((await view()).pending).toBe(false)
    await send({ choiceId: RETRY })
    expect((await view()).messages.at(-1)?.text).toBe(question.text)
  })

  it('同じ requestId の送り直しは呼ばずに 1 回目の seq を返す', async () => {
    await setup(talk(say(question)))
    const id = uuid()
    const first = await (await send({ text: '記事にして' }, id)).json()
    const again = await post({ requestId: id, lastSeq: 0, text: '記事にして' })
    expect(again.status).toBe(202)
    expect(await again.json()).toEqual({ seq: first.seq, replayed: true })
    expect(fake.calls).toHaveLength(1)
    expect((await view()).messages).toHaveLength(2)
  })

  it('古い画面からの送信と、最後の行に無い選択肢は stale', async () => {
    await setup(talk(say(question), say(question)))
    await send({ text: '記事にして' })
    expect(await (await post({ requestId: uuid(), lastSeq: 1, text: 'もう一つ' })).json()).toEqual({ reason: 'stale' })
    const last = (await view()).messages.at(-1)?.seq as number
    expect((await post({ requestId: uuid(), lastSeq: last, choiceId: 'z' })).status).toBe(409)
    expect((await post({ requestId: uuid(), lastSeq: last, choiceId: RETRY })).status).toBe(409)
  })

  it('返事を作っている間は busy で、pending が立つ', async () => {
    await setup([{ role: '話し相手', nth: 1, reply: { fail: 'hang' } }])
    await post({ requestId: uuid(), lastSeq: 0, text: '記事にして' })
    expect((await view()).pending).toBe(true)
    const res = await post({ requestId: uuid(), lastSeq: 1, text: 'もう一つ' })
    expect(await res.json()).toEqual({ reason: 'busy' })
    // 通常の終了（止めていない）で切れたときは何も書かない
    await server.runs.abortAll()
    await server.conversation.settled()
    const v = await view()
    expect(v.pending).toBe(false)
    expect(v.messages).toHaveLength(1)
  })

  it('緊急停止で切れたら停止の 1 行。止まっている間は stopped で本人の行も書かない', async () => {
    await setup([{ role: '話し相手', nth: 1, reply: { fail: 'hang' } }])
    await post({ requestId: uuid(), lastSeq: 0, text: '記事にして' })
    await server.stop.stop()
    await server.conversation.settled()
    expect((await view()).messages.at(-1)).toMatchObject({ who: 'libretto', text: TALK.stopped })
    const res = await post({ requestId: uuid(), lastSeq: 2, text: 'もう一つ' })
    expect(await res.json()).toEqual({ reason: 'stopped' })
    expect((await view()).messages).toHaveLength(2)
  })

  it('費用は「会話」に積み、案件上限とは比べない', async () => {
    await setup(talk({ text: JSON.stringify(question), costYen: 2000 }, say(question)))
    await send({ text: '一回目' })
    await send({ text: '二回目' })
    expect(ledger.listCosts('会話').filter((c) => c.type === 'charge')).toHaveLength(2)
    expect((await view()).messages.at(-1)?.text).toBe(question.text)
  })

  it('無い案件への caseId 付きの発話は 404、GET の空の caseId は lobby', async () => {
    await setup(talk(say(question)))
    expect((await post({ requestId: uuid(), lastSeq: 0, text: 'x', caseId: 'c1' })).status).toBe(404)
    await send({ text: '記事にして' })
    expect((await view('?caseId=')).messages).toHaveLength(2)
    expect((await view('?caseId=nope')).messages).toEqual([])
  })

  it('Origin の無い POST は 403、Cookie の無い GET は 401', async () => {
    await setup([])
    const res = await server.app.request('/api/conversation/messages', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
    expect((await server.app.request('/api/conversation')).status).toBe(401)
    expect(COOKIE).toBe('libretto_session')
  })
})

describe('自前点検（replyViolations）', () => {
  const ok = (r: unknown) => replyViolations(r as Parameters<typeof replyViolations>[0])
  it('質問・完了・知らせの形', () => {
    expect(ok(question)).toEqual([])
    expect(ok(done)).toEqual([])
    expect(ok({ text: '受け付けました。' })).toEqual([])
    expect(ok({ text: '誰が読みますか？' })).toHaveLength(1)
    expect(ok({ ...done, choices: question.choices })).toHaveLength(1)
  })
  it('選択肢の数・おすすめ・why・重なり・retry', () => {
    const c = question.choices
    expect(ok({ ...question, choices: [c[0]] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[0], { ...c[0], id: 'x', label: 'y' }] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[1], { ...c[1], id: 'x', label: 'y' }] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[0], { ...c[1], why: '' }] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[0], { ...c[1], why: 'あ'.repeat(61) }] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[0], { ...c[1], id: 'a' }] })).not.toEqual([])
    expect(ok({ ...question, choices: [c[0], { ...c[1], id: RETRY }] })).not.toEqual([])
  })
})

describe('markerCheck', () => {
  it('直訳調の言い回しを位置付きで返す', () => {
    expect(markerCheck('この点において、確認することができます。')).toEqual({
      hits: [
        { marker: 'において', where: 3 },
        { marker: 'することができ', where: 10 },
      ],
    })
    expect(markerCheck('調査を行い、彼は経験を持っています').hits.map((h) => h.marker)).toEqual([
      'を行う',
      '彼は',
      'を持っている',
    ])
    expect(markerCheck('次のどれにしますか：\n二つ目').hits).toEqual([{ marker: '行末のコロン', where: 9 }])
  })
  it('ふだんの文には当たらない', () => {
    expect(markerCheck('誰に読んでもらう記事ですか？ 一般の読者なら、前提なしで読めるように書けます。').hits).toEqual(
      [],
    )
    expect(markerCheck('時刻は 10:30 です').hits).toEqual([])
  })
})

describe('TALK', () => {
  it('出さない語を含まない', () => {
    for (const s of Object.values(TALK)) expect(s).not.toMatch(CLI_MARKERS)
  })
})
