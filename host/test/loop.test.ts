// ループのテスト（docs/implementation.md 11.1・11.3 (1)）。JSON の台本（test/scripts/）で、index.ts と同じ配線のホストを HTTP で 1 本通す
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaseView } from '@libretto/shared/api'
import { Review } from '@libretto/shared/checks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { facts, type Notebook, refusal } from '../scripts/verify-record.ts'
import { transition } from '../src/case/transition.ts'
import { callsDir, caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { type CostCapNotice, createInvoke } from '../src/model/invoke.ts'
import { settleOrphans } from '../src/model/orphans.ts'
import { createServer } from '../src/server/app.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const TOKEN = 'abcdef0123456789abcdef0123456789'
let home: string
let ledger: Ledger
let server: ReturnType<typeof createServer>
let fake: ReturnType<typeof createFake>
let cookie: string
let caps: { caseCapYen: number | null; monthCapYen: number | null }
let notices: CostCapNotice[]
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./scripts/${name}.json`, import.meta.url), 'utf-8')) as ScriptEntry[]

// index.ts の起動の順: 精算 → STOP の確認 → runner の再開。onCostCap も同じ配線（11.3 (1)）
async function boot() {
  ledger = initHome(home)
  settleOrphans(ledger, callsDir(home))
  const invoke = createInvoke({
    ledger,
    backends: { claude: fake.backend },
    caps: () => caps,
    onCostCap: (c) => {
      notices.push(c)
      const r = transition(ledger, { type: 'cost.cap', by: '費用', ...c })
      if (r.ok && !r.replayed) server.caseChanged(c.caseId)
    },
    callsDir: callsDir(home),
    debugDir: join(home, 'debug'),
    log: () => {},
    retryWaitMs: 0,
    settleMs: 200,
  })
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<div></div>')
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke,
    log: () => {},
    runsWaitMs: 500,
    token: () => TOKEN,
  })
  server.stop.boot()
  server.runner.resume()
  const { url } = server.issuePairing('テスト')
  const res = await server.app.request(new URL(url).pathname, { method: 'POST' })
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string
}
async function start(script: string, c: typeof caps = { caseCapYen: 1500, monthCapYen: null }) {
  n = 0
  caps = c
  notices = []
  home = mkdtempSync(join(tmpdir(), 'libretto-loop-'))
  fake = createFake(load(script))
  await boot()
}
// index.ts の通常の終了と同じ: 動いている仕事を止めて閉じる。同じ fake のまま（nth が続く）起こし直す
async function restart() {
  await server.runs.abortAll()
  ledger.close()
  await boot()
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
const act = async (id: string, body: Record<string, unknown>) =>
  postJson(`/api/cases/${id}/actions`, { eventId: uuid(), expectedRevision: (await caseView(id)).revision, ...body })
const waitState = (id: string, state: string) =>
  vi.waitFor(() => expect(ledger.getCase(id)?.state).toBe(state), { timeout: 3000, interval: 5 })
const idle = () => vi.waitFor(() => expect(server.runner.running()).toEqual([]), { timeout: 2000, interval: 5 })
const callsOf = (role: string) => fake.calls.filter((c) => c.role === role)
const work = (id: string, name: string) => join(caseDir(home, id), 'work', name)
const review = (id: string, name: string) =>
  Review.parse(JSON.parse(readFileSync(join(caseDir(home, id), name), 'utf-8')))
const verdictOf = (r: Review, checkId: string) => r.results.find((x) => x.id === checkId)?.verdict
const notebook: Notebook = { startedAt: '', month: '2026-10', capYen: 3000, sessions: [] }

// 会話で頼み、入口を承認して runner に渡す（T5 → T6 → T8）
async function approved(): Promise<string> {
  await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: 0, text: '先週のブレストを記事にして' })
  await server.conversation.settled()
  const id = ledger.lastMessage('lobby')?.caseId as string
  await vi.waitFor(() => expect(ledger.getCase(id)?.turn).toBe('本人'), { timeout: 2000, interval: 5 })
  const v = await caseView(id)
  const res = await act(id, {
    type: 'entrance.approve',
    answers: { U01: ['b'] },
    mode: '確認しながら',
    setFingerprint: v.entrance?.setFingerprint,
  })
  expect(res.status).toBe(200)
  return id
}

describe('ループ（11.3 (1)）', () => {
  it('loop.json: 機械で不合格 → モデルで不合格 → 下書き中に起こし直して → 合格 → 承認 → 送付 → 完了', async () => {
    await start('loop')
    const id = await approved()

    // 3 回目の作り手が書きかけを置いたところ
    await vi.waitFor(() => expect(callsOf('作り手')).toHaveLength(3), { timeout: 3000, interval: 5 })
    expect(ledger.getCase(id)).toMatchObject({ state: '下書き中', version: 2, round: 2 })
    // 1 回目は機械判定（字数）で落ち、Claude の判定を呼ばない。2 回目は機械が全部通り、Claude の判定が 1 項目落ちる（11.2 の AND）
    const r1 = review(id, 'review-01-a.json')
    expect(r1.pass).toBe(false)
    expect(verdictOf(r1, 'C01')).toBe('fail')
    expect(verdictOf(r1, 'C02')).toBe('skipped')
    const r2 = review(id, 'review-02-a.json')
    expect(r2.pass).toBe(false)
    expect(r2.results.filter((x) => x.by === 'code').every((x) => x.verdict === 'pass')).toBe(true)
    expect(verdictOf(r2, 'C02')).toBe('fail')
    expect(callsOf('判定役・文章')).toHaveLength(1)
    // 作り手に返すのは 1 行要約だけ
    const fb = readFileSync(work(id, 'feedback.md'), 'utf-8')
    expect(fb).toContain('読み終えても決まったことが伝わりません')
    expect(fb).not.toContain('最後まで出てきません')

    await restart()
    await waitState(id, '承認待ち')
    expect(readFileSync(work(id, 'draft-03.partial.md'), 'utf-8')).toBe('# 書きかけ\n')
    expect(readFileSync(join(caseDir(home, id), 'versions/03/draft-03.md'), 'utf-8')).not.toContain('書きかけ')
    const v = await caseView(id)
    expect(v.versions.map((x) => x.state)).toEqual(['不合格', '不合格', '合格'])
    expect(v.review).toMatchObject({ n: 3, failed: [] })

    const fp = v.versions.at(-1)?.fingerprint
    expect((await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: fp })).status).toBe(200)
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    const plan = (await caseView(id)).deliveryPlan.fingerprint
    expect((await act(id, { type: 'delivery.send', planFingerprint: plan })).status).toBe(200)
    await waitState(id, '完了')
    expect((await caseView(id)).versions.map((x) => x.state)).toEqual(['不合格', '不合格', '承認済み'])
    const page = await (await get(`/cases/${id}/page`)).text()
    expect(page).toContain('最後に次に試すことを並べます。')
    expect(fake.unused()).toEqual([])

    // 記録の下書き（11.3 (3)）: 状態と出来事と費用は出て、本文・題・会話・確認項目の文は出ない
    await idle()
    const md = facts(ledger, notebook, join(home, 'debug'))
    expect(md).toContain('- 最後の状態: 完了・版 3')
    expect(md).toContain('| review.fail | 検品中 → 下書き中 | libretto |')
    expect(md).toContain('| 作り手 | 3 | 0 |')
    expect(md).toContain('| 判定役・文章 | 2 | 0 |')
    for (const secret of ['ブレストのまとめ', '先週のブレスト', '決まったことは 3 つです', '初見の読者', '書きかけ'])
      expect(md).not.toContain(secret)
  })

  it.each([
    ['案件', { caseCapYen: 500, monthCapYen: null }],
    ['全体', { caseCapYen: null, monthCapYen: 500 }],
  ] as const)(
    'cost-cap.json: %s上限を超える予約で cost.cap → 停止（費用上限）。判定役は呼ばれない',
    async (scope, c) => {
      await start('cost-cap', c)
      const id = await approved()
      await waitState(id, '停止')
      expect(ledger.getCase(id)?.stopReason).toBe('費用上限')
      expect(notices.map((x) => [x.caseId, x.scope])).toEqual([[id, scope]])
      expect(ledger.caseCostYen(id)).toBe(390)
      expect(callsOf('判定役・文章')).toEqual([])
      expect(fake.unused()).toEqual([])
    },
  )

  it('stop.json: 作り手の最中に止めると停止し、書きかけを版にしない。起こし直しても停止のまま', async () => {
    await start('stop')
    const id = await approved()
    await vi.waitFor(() => expect(callsOf('作り手')).toHaveLength(1), { timeout: 3000, interval: 5 })
    expect((await act(id, { type: 'stop.case', reason: '本人だけが知っている理由' })).status).toBe(200)
    await idle()
    expect(ledger.getCase(id)).toMatchObject({ state: '停止', version: 0 })
    expect(existsSync(work(id, 'draft-01.md'))).toBe(false)
    expect(readFileSync(work(id, 'draft-01.partial.md'), 'utf-8')).toBe('# 書きかけ\n')
    const calls = fake.calls.length

    await restart()
    await idle()
    expect(ledger.getCase(id)?.state).toBe('停止')
    expect(fake.calls).toHaveLength(calls)
    expect(fake.unused()).toEqual([])

    // 本人が「止める」に付けた文は記録に写さない（11.3 (3)）。止めた作り手は予約の額（400 円）で精算される。
    // 落ちて精算されていない予約も予約の額で数える
    ledger.reserveCost({
      callId: 'unsettled',
      caseId: id,
      role: '判定役・文章',
      family: 'claude',
      model: 'x',
      holdYen: 160,
      caseCapYen: null,
      monthCapYen: null,
    })
    // 案件の無い呼び出し（隔離の点検）の費用も数える
    ledger.reserveCost({
      callId: 'probe',
      caseId: '点検',
      role: '作り手',
      family: 'claude',
      model: 'x',
      holdYen: 10,
      caseCapYen: null,
      monthCapYen: null,
    })
    ledger.recordCharge({ callId: 'probe', yen: 3 })
    const md = facts(ledger, notebook, join(home, 'debug'))
    expect(md).toContain('- 使った額: 563.0 円（精算されていない予約 1 件を予約の額で含む）')
    expect(md).toContain('- 最後の状態: 停止（本人が止めた）')
    expect(md).not.toContain('本人だけが知っている理由')
  })
})

describe('verify:live の起こしてよいか（11.3 (2)）', () => {
  const at = (s: string) => new Date(s)
  it('同じ月の家は起こし直せ、別の月の家は断る（全体上限の枠が戻るため）', () => {
    const nb = { ...notebook, month: '2026-10' }
    expect(refusal(nb, at('2026-10-31T23:30:00+09:00'))).toBeUndefined()
    expect(refusal(nb, at('2026-11-01T00:00:00+09:00'))).toMatch(/2026-10/)
  })
  it('新しい検証は、JST の月末まで 2 時間を切っていたら始めない', () => {
    expect(refusal(undefined, at('2026-10-31T21:59:00+09:00'))).toBeUndefined()
    expect(refusal(undefined, at('2026-10-31T22:01:00+09:00'))).toMatch(/2 hours/)
    expect(refusal(undefined, at('2026-11-01T00:00:00+09:00'))).toBeUndefined()
  })
})
