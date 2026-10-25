// runner と作り手（docs/implementation.md 6.2.3・4.4・4.2 T11・T12・T16・T19）。fake の台本で HTTP を叩く
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaseCard, CaseView, DraftDiff, HomeView } from '@libretto/shared/api'
import { Review } from '@libretto/shared/checks'
import { VersionManifest } from '@libretto/shared/ledger'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAY, transition } from '../src/case/transition.ts'
import { charCount, headingCount, renderHtml } from '../src/checks/text.ts'
import { GDOC_SAY, libFolder } from '../src/deliver/gdoc.ts'
import type { Tools } from '../src/deliver/render.ts'
import { htmlTables, xlsxOf } from '../src/deliver/xlsx.ts'
import type { Fetched, FetchFailure } from '../src/facts/fetch.ts'
import { createGoogle, DRIVE_SCOPE, GMAIL_SCOPE, type Google } from '../src/intake/google.ts'
import { caseDir, initHome } from '../src/ledger/db.ts'
import type { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry, type ScriptReply } from '../src/model/fake.ts'
import { type Backend, createInvoke } from '../src/model/invoke.ts'
import { OUTPUT_FILES } from '../src/roles/judge.ts'
import { MAKER_LIMITS } from '../src/roles/maker.ts'
import { createServer } from '../src/server/app.ts'
import { type DriveFile, startFakeGoogle } from './fakes/google.ts'
import { fakeOffice } from './fakes/office-bin.ts'
import { briefDraft, classified, goodChecks } from './fixtures/entrance.ts'

const ORIGIN = 'http://127.0.0.1:7780'
const TOKEN = 'abcdef0123456789abcdef0123456789'
let home: string
let ledger: Ledger
let server: ReturnType<typeof createServer>
let fake: ReturnType<typeof createFake>
let cookie: string
let google: Google | undefined // Google ドキュメントの届け先の節だけ（6.5）
let tools: Tools | undefined // 表・スライド・手元のファイルの節だけ（6.10）
let n = 0
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

type Role = ScriptEntry['role']
const say = (v: unknown): ScriptReply => ({ text: JSON.stringify(v) })
const intake = {
  text: '受け付けます。',
  intake: {
    title: 'ブレストのまとめ',
    summary: '先週のブレストを note 記事にまとめる',
    docType: '記事',
    audience: '一般の読者',
    destinations: ['page'],
  },
}
function script(...rows: [Role, ScriptReply][]): ScriptEntry[] {
  const counts = new Map<Role, number>()
  return rows.map(([role, reply]) => {
    const nth = (counts.get(role) ?? 0) + 1
    counts.set(role, nth)
    return { role, nth, reply }
  })
}
// 機械判定はどの本文でも通る組（字数・見出しの下限だけ）。判定役の Claude は hangJudge で止めておき、検品中に留める
const runnerChecks = goodChecks.map((c) =>
  c.id === 'C01'
    ? { ...c, judge: { by: 'code' as const, fn: 'charCount' as const, args: { min: 1 } } }
    : c.id === 'C03'
      ? { ...c, judge: { by: 'code' as const, fn: 'headingCount' as const, args: { min: 0 } } }
      : c,
)
const hung: string[] = [] // 止めておいた判定役の呼び出し（案件 id）
const hangJudge =
  (b: Backend): Backend =>
  (call) =>
    call.role === '判定役・文章'
      ? new Promise(
          (_, reject) =>
            hung.push(call.caseId) &&
            call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }),
        )
      : b(call)
const upToEntrance: [Role, ScriptReply][] = [
  ['話し相手', say(intake)],
  ['下書き役・依頼書', say(briefDraft)],
  ['下書き役・確認項目', say({ checks: runnerChecks })],
  ['事実係・分類', say(classified)],
]
const nn = (k: number) => String(k).padStart(2, '0')
const BODY = '# ブレストのまとめ\n\n決まったことは 3 つです。\n\n## 1 つ目\n\n本文。\n'
// 作り手の fake は作業場に 3 つを書く（6.2.3 (9)）
const draft = (k: number, md = BODY): ScriptReply => ({
  text: '書きました',
  write: {
    [`draft-${nn(k)}.md`]: md,
    [`draft-${nn(k)}.html`]: renderHtml(md),
    [`draft-${nn(k)}.done`]: 'done',
  },
})

// 出典の取り寄せの偽物（網に出ない。6.3.1 (5)）
const fetched: string[] = []
// 文体の見本（です・ます。80〜400 字の段落が 2 つ）
const VOICE_PARA_1 =
  '私は毎週の振り返りで、うまくいったことを先に書くようにしています。そうすると次の一週間の始め方が決まります。小さな工夫ですが、続けるうちに効いてきました。忙しい週ほど、この順番が助けになります。'
const VOICE_PARA_2 =
  '振り返りの時間は十五分と決めています。長く取ると反省ばかりが増えて、手が止まってしまうからです。短く区切ると、次にやることが一つに絞れます。終わったら、その一つだけを手帳に書いておきます。'
const VOICE_MD = `# 振り返りの話\n\n${VOICE_PARA_1}\n\n${VOICE_PARA_2}`
const fakeFetch = async (url: string): Promise<Fetched | FetchFailure> => {
  fetched.push(url)
  if (url.includes('/voice'))
    return {
      ok: true,
      url,
      title: '過去の記事',
      paragraphs: [VOICE_PARA_1, VOICE_PARA_2],
      fingerprint: 'v',
      md: VOICE_MD,
    }
  return url.endsWith('/gone')
    ? { ok: false, why: 'network' }
    : { ok: true, url, title: '週報', paragraphs: ['方針は 3 つ。'], fingerprint: 'f' }
}

async function setup(entries: ScriptEntry[], wrap: (b: Backend) => Backend = hangJudge, keepHome = false) {
  fetched.length = 0
  n = keepHome ? n : 0
  hung.length = 0
  if (!keepHome) home = mkdtempSync(join(tmpdir(), 'libretto-runner-'))
  ledger = initHome(home)
  const staticDir = join(home, 'dist')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<div></div>')
  fake = createFake(entries)
  const invoke = createInvoke({
    ledger,
    backends: { claude: wrap(fake.backend) },
    caps: () => ({ caseCapYen: 1500, monthCapYen: null }),
    onCostCap: () => {},
    log: () => {},
    retryWaitMs: 0,
    settleMs: 200,
  })
  server = createServer({
    home,
    ledger,
    origins: [ORIGIN],
    staticDir,
    invoke,
    log: () => {},
    runsWaitMs: 500,
    token: () => TOKEN,
    fetch: fakeFetch,
    ...(google && { google }),
    ...(tools && { tools }),
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
const act = async (id: string, body: Record<string, unknown>) =>
  postJson(`/api/cases/${id}/actions`, { eventId: uuid(), expectedRevision: (await caseView(id)).revision, ...body })
const waitState = (id: string, state: string) =>
  vi.waitFor(() => expect(ledger.getCase(id)?.state).toBe(state), { timeout: 2000, interval: 5 })
const idle = () => vi.waitFor(() => expect(server.runner.running()).toEqual([]), { timeout: 2000, interval: 5 })
const makerCalls = () => fake.calls.filter((c) => c.role === '作り手')
const work = (id: string, name = '') => join(caseDir(home, id), 'work', name)

// 会話で頼み、入口を承認して、runner に渡す（T5 → T6 → T8）
async function approved(mode: '確認しながら' | 'おまかせ' = '確認しながら'): Promise<string> {
  await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: 0, text: '記事にして' })
  await server.conversation.settled()
  const id = ledger.lastMessage('lobby')?.caseId as string
  await vi.waitFor(() => expect(ledger.getCase(id)?.turn).toBe('本人'), { timeout: 2000, interval: 5 })
  const v = await caseView(id)
  const res = await act(id, {
    type: 'entrance.approve',
    answers: { U01: ['b'] },
    mode,
    setFingerprint: v.entrance?.setFingerprint,
  })
  expect(res.status).toBe(200)
  return id
}
// 判定役（Issue 11）の代わりに、判定のファイルと遷移を置く
function judged(id: string, pass: boolean, failedSummaries: string[] = [], marks: Review['marks'] = []) {
  const c = ledger.getCase(id)
  if (!c) throw new Error('no case')
  const review: Review = {
    version: c.version,
    series: c.series,
    round: c.round + 1,
    at: new Date().toISOString(),
    phase: '本文',
    attempt: 1,
    results: [{ id: 'C01', verdict: pass ? 'pass' : 'fail', by: 'code', reasonRef: 'review-01-a.reasons.md#C01' }],
    pass,
    failedSummaries,
    marks,
    sources: [],
  }
  writeFileSync(join(caseDir(home, id), `review-${nn(c.version)}-a.json`), JSON.stringify(review))
  writeFileSync(join(caseDir(home, id), `review-${nn(c.version)}-a.reasons.md`), '理由: 分量が 1,200 字で足りません')
  const r = transition(ledger, {
    type: pass ? 'review.pass' : 'review.fail',
    n: c.version,
    eventId: `${id}:review:${c.version}`,
    caseId: id,
    expectedRevision: c.revision,
    by: 'libretto',
  })
  expect(r.ok).toBe(true)
}
const allWorkText = (id: string) =>
  readdirSync(work(id), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf-8'))
    .join('\n')

describe('runner と作り手', () => {
  it('T8 → T11 → T12: 承認した組で作業場を作り、作り手の版を versions/01/ に写して検品中へ', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await waitState(id, '検品中')
    // 作業場は brief.md と空の materials/ だけ。確認項目の文と canary の語が無い（8.3・6.2.3 (2)）
    const brief = readFileSync(work(id, 'brief.md'), 'utf-8')
    expect(brief).toContain('- 書く内容: ブレストで決まった 3 つの方針と、その理由')
    expect(brief).toContain('## 決めたこと')
    expect(readdirSync(work(id, 'materials'))).toEqual([])
    expect(existsSync(work(id, 'feedback.md'))).toBe(false)
    const text = allWorkText(id)
    for (const x of goodChecks) {
      expect(text).not.toContain(x.title)
      expect(text).not.toContain(x.summary)
    }
    expect(text).not.toContain(TOKEN)
    // 作り手の呼び出し
    const [call] = makerCalls()
    expect(call).toMatchObject({ access: 'write', workdir: work(id), caseId: id })
    expect(call?.instruction).toContain('draft-01.md')
    expect(call?.instruction).not.toContain('feedback.md')
    // 版の正本と指紋（4.6 (1)）
    const m = VersionManifest.parse(
      JSON.parse(readFileSync(join(caseDir(home, id), 'versions/01/manifest.json'), 'utf-8')),
    )
    expect(m.files.map((f) => f.path)).toEqual(['draft-01.html', 'draft-01.md'])
    expect(ledger.getCase(id)).toMatchObject({ version: 1, versionFingerprint: m.fingerprint, turn: 'libretto' })
    expect(readFileSync(join(caseDir(home, id), 'versions/01/draft-01.md'), 'utf-8')).toBe(BODY)
    const v = await caseView(id)
    expect(v.versions).toEqual([
      {
        n: 1,
        at: m.at,
        chars: charCount(BODY),
        headings: headingCount(BODY),
        fingerprint: m.fingerprint,
        state: '検品中',
      },
    ])
    expect(fake.unused()).toEqual([])
  })

  it('T16 の後: feedback.md は不合格の 1 行要約だけ。理由文は渡さない', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['作り手', draft(2)]))
    const id = await approved()
    await waitState(id, '検品中')
    const summaries = ['分量が依頼の範囲から外れています', '見出しの数が依頼と合っていません']
    // 機械判定の要約には目標と今の値が字下げで付く（6.2.9）
    const added = '  - 見出し（題と小見出しを除く）は 4〜6 個にしてください（今は 7 個）'
    judged(id, false, [summaries[0] as string, `${summaries[1]}\n${added}`])
    server.runner.kick(id)
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '検品中', version: 2 }))
    const fb = readFileSync(work(id, 'feedback.md'), 'utf-8')
    const lines = fb
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2))
    expect(new Set(lines)).toEqual(new Set(summaries))
    expect(fb.split('\n').filter((l) => l.startsWith('  '))).toEqual([added])
    expect(fb).not.toContain('1,200 字')
    expect(fb).not.toContain('C01')
    expect(makerCalls()[1]?.instruction).toContain('feedback.md')
    // 直すところ以外は前のバージョンを保つ（実ホストの確認で、直せない指摘に合わせて削り、字数が範囲を外れた）
    expect(makerCalls()[1]?.instruction).toContain('直すところ以外は前のバージョンのまま保ち')
    expect(makerCalls()[1]?.instruction).toContain('draft-02.md')
    // 前の版の判定が残る
    expect((await caseView(id)).versions.map((x) => [x.n, x.state])).toEqual([
      [1, '不合格'],
      [2, '検品中'],
    ])
  })

  it('T19 の後: feedback.md は本人の「ここを直して」の全文', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['作り手', draft(2)]))
    const id = await approved()
    await waitState(id, '検品中')
    judged(id, true)
    expect(ledger.getCase(id)?.state).toBe('承認待ち')
    const instruction = '2 つ目の方針は、具体例を 1 つ足してください。'
    expect((await act(id, { type: 'approval.redo', instruction })).status).toBe(200)
    await vi.waitFor(() => expect(ledger.getCase(id)?.version).toBe(2))
    expect(readFileSync(work(id, 'feedback.md'), 'utf-8')).toContain(instruction)
  })

  it('再起動: .done があって T12 が無ければ、作り手を呼ばずに T12（4.4）', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }]))
    const id = await approved()
    await vi.waitFor(() => expect(makerCalls()).toHaveLength(1))
    // ホストが落ちる前に作り手が書き終えていた
    for (const [name, text] of Object.entries((draft(1) as { write: Record<string, string> }).write))
      writeFileSync(work(id, name), text)
    // 書いた後に落ちた（runs を止めずに台帳を閉じる）。起こし直す
    ledger.close()
    const before = n
    await setup([], hangJudge, true)
    n = before
    server.runner.resume()
    await waitState(id, '検品中')
    expect(makerCalls()).toEqual([])
    expect(ledger.getCase(id)?.version).toBe(1)
  })

  it('再起動: 書きかけ（.done 無し）と前の系列が書き終えたものは partial に改名して作り直す', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }]))
    const id = await approved()
    await vi.waitFor(() => expect(makerCalls()).toHaveLength(1))
    writeFileSync(work(id, 'draft-01.md'), '書きかけ')
    ledger.close()
    await setup(script(['作り手', draft(1)]), hangJudge, true)
    server.runner.resume()
    await waitState(id, '検品中')
    expect(readFileSync(work(id, 'draft-01.partial.md'), 'utf-8')).toBe('書きかけ')
    expect(makerCalls()).toHaveLength(1)

    // 系列が違う maker.json と揃った 3 つ（T7b の前に書き終えた版）も拾わない（6.2.3 (5)）
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    judged(id, false, ['分量が依頼の範囲から外れています'])
    await server.runs.abort(id)
    await idle()
    ledger.close()
    await setup(script(['作り手', draft(2, '# 新しい系列\n')]), hangJudge, true)
    for (const [name, text] of Object.entries((draft(2, '# 古い系列\n') as { write: Record<string, string> }).write))
      writeFileSync(work(id, name), text)
    writeFileSync(
      join(caseDir(home, id), 'maker.json'),
      JSON.stringify({ n: 2, series: 99, at: '2026-10-24T00:00:00Z' }),
    )
    server.runner.resume()
    await waitState(id, '検品中')
    expect(makerCalls()).toHaveLength(1)
    expect(readFileSync(work(id, 'draft-02.partial.md'), 'utf-8')).toBe('# 古い系列\n')
    expect(readFileSync(join(caseDir(home, id), 'versions/02/draft-02.md'), 'utf-8')).toBe('# 新しい系列\n')
  })

  it('T27 動いている作り手を止めると、書きかけを partial に改名して遷移しない', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }]), (b) => async (call) => {
      if (call.role === '作り手' && call.workdir) writeFileSync(join(call.workdir, 'draft-01.md'), '途中')
      return hangJudge(b)(call)
    })
    const id = await approved()
    await vi.waitFor(() => expect(makerCalls()).toHaveLength(1))
    expect((await act(id, { type: 'stop.case' })).status).toBe(200)
    await idle()
    expect(ledger.getCase(id)).toMatchObject({ state: '停止', stopReason: '本人が止めた' })
    expect(existsSync(work(id, 'draft-01.md'))).toBe(false)
    expect(readFileSync(work(id, 'draft-01.partial.md'), 'utf-8')).toBe('途中')
  })

  it('作り手の時間切れは fail.system(時間切れ)（10.2）', async () => {
    const keep = MAKER_LIMITS.timeoutMs
    MAKER_LIMITS.timeoutMs = 30
    try {
      await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }]))
      const id = await approved()
      await waitState(id, '停止')
      expect(ledger.getCase(id)?.stopReason).toBe('時間切れ')
    } finally {
      MAKER_LIMITS.timeoutMs = keep
    }
  })

  it('ファイルが揃わない（言い直しでも）・本文が空なら fail.system(書けなかった)', async () => {
    const onlyMd: ScriptReply = { text: '書きました', write: { 'draft-01.md': BODY } }
    await setup(script(...upToEntrance, ['作り手', onlyMd], ['作り手', onlyMd]))
    const id = await approved()
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('書けなかった')
    // 言い直しには書かれていないファイルの名前が渡る
    expect(JSON.stringify(makerCalls()[1]?.materials)).toContain('draft-01.html')

    await setup(script(...upToEntrance, ['作り手', draft(1, '')]))
    const empty = await approved()
    await waitState(empty, '停止')
    expect(ledger.getCase(empty)?.stopReason).toBe('書けなかった')
    expect(existsSync(join(caseDir(home, empty), 'versions'))).toBe(false)
  })

  it('ログイン切れは止めずに待ち、「続ける」で作り手を起こし直す（6.2.3 (7)）', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'unavailable', why: 'auth_expired' }], ['作り手', draft(1)]))
    const id = await approved()
    await vi.waitFor(() => expect(server.status.signIn).toBe(true))
    await idle()
    expect(ledger.getCase(id)).toMatchObject({ state: '下書き中', turn: 'libretto' })
    expect((await (await get('/api/host')).json()).signIn).toBe(true)
    // 待っている間は kick しても呼ばない
    server.runner.kick(id)
    expect(makerCalls()).toHaveLength(1)
    expect(await (await postJson('/api/host/resume', {})).json()).toMatchObject({ signIn: false })
    await waitState(id, '検品中')
  })

  it('承認は今の版の印を全部答える（6.3.1 (9)）。閉じたら資料と出典の本文を消す（6.3.1 (10)）', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await waitState(id, '検品中')
    judged(id, true, [], [{ claimId: 'M01', text: '東京が最大だ。', where: '冒頭の 1 段落目' }])
    const fp = (await caseView(id)).versions.at(-1)?.fingerprint
    expect((await caseView(id)).review?.needsConfirmation.map((m) => m.claimId)).toEqual(['M01'])
    const ok = (marks: Record<string, string>) => act(id, { type: 'approval.ok', marks, versionFingerprint: fp })
    expect((await ok({})).status).toBe(409)
    expect((await ok({ M02: '印のまま' })).status).toBe(409)
    expect(ledger.getCase(id)?.state).toBe('承認待ち')
    expect((await ok({ M01: '印のまま' })).status).toBe(200)
    expect(ledger.listApprovals(id).at(-1)).toMatchObject({ gate: '完成稿', marks: { M01: '印のまま' } })

    await idle() // 仕立てと形式の判定が終わるまで
    const dir = caseDir(home, id)
    mkdirSync(join(dir, 'facts-excerpts'), { recursive: true })
    writeFileSync(join(dir, 'facts-excerpts', 'x.json'), '{}')
    expect((await act(id, { type: 'stop.case', reason: '本人が止めた' })).status).toBe(200)
    await vi.waitFor(() => expect(existsSync(join(dir, 'facts-excerpts'))).toBe(false), { timeout: 2000, interval: 5 })
    expect(existsSync(work(id, 'materials'))).toBe(false)
    expect(ledger.listCaseEvents(id).at(-1)).toMatchObject({ type: 'purged' })
  })

  it('1 案件に 1 本: 動いている間の kick は止めてから始め直す', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }], ['作り手', draft(1)]))
    const id = await approved()
    await vi.waitFor(() => expect(makerCalls()).toHaveLength(1))
    server.runner.kick(id)
    await waitState(id, '検品中')
    expect(makerCalls()).toHaveLength(2)
  })

  it('versions は T12 がコミットした版だけ（落ちて残った versions/NN は出さない）', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await waitState(id, '検品中')
    mkdirSync(join(caseDir(home, id), 'versions/02'), { recursive: true })
    expect((await caseView(id)).versions.map((v) => v.n)).toEqual([1])
  })
})

describe('事実係が公開の情報を集める（6.3.3）', () => {
  const gathering = {
    ...briefDraft,
    brief: { ...briefDraft.brief, sources: '出典付き', gather: ['今月の公式のお知らせ'] },
  }
  const rows: [Role, ScriptReply][] = upToEntrance.map(([role, reply]) =>
    role === '下書き役・依頼書' ? [role, say(gathering)] : [role, reply],
  )
  // 出典付きは判定の頭で棚卸しを呼ぶ。止めておき、検品中に留める
  const hold: [Role, ScriptReply] = ['事実係・抜き出し', { fail: 'hang' }]

  it('集めた URL を取り寄せて資料の正本に足し、印を付ける。集め役には「集めるもの」と今日だけを渡す', async () => {
    const found = {
      sources: [
        { url: 'https://example.com/news', why: '公式のお知らせ' },
        { url: 'https://example.com/gone', why: '公式の更新履歴' },
      ],
    }
    await setup(script(...rows, ['事実係・集め', say(found)], ['作り手', draft(1)], hold))
    const id = await approved()
    await waitState(id, '検品中')
    const call = fake.calls.find((c) => c.role === '事実係・集め')
    expect(call?.access).toBe('search')
    expect(call?.materials.map((m) => m.name)).toEqual(['集めるもの', '今日'])
    expect(JSON.stringify(call?.materials)).toContain('今月の公式のお知らせ')
    expect(JSON.stringify(call?.materials)).not.toContain(briefDraft.brief.subject)
    expect(fetched).toEqual(['https://example.com/news', 'https://example.com/gone'])
    const src = join(caseDir(home, id), 'materials')
    expect(readdirSync(src)).toEqual(['gathered.json', 'source-01.md'])
    // 作り手には資料の本文だけ。出典はリンクを付ける約束
    expect(readdirSync(work(id, 'materials'))).toEqual(['source-01.md'])
    expect(makerCalls()[0]?.instruction).toContain('ウェブから取り寄せた出典')
    const v = await caseView(id)
    expect(v.materials).toEqual([
      {
        id: 'S01',
        kind: '出典',
        title: '週報',
        where: 'https://example.com/news',
        status: '取り寄せ済み',
        gathered: true,
      },
    ])
    expect(v.gatherFailed).toBeUndefined()
    expect(fake.unused()).toEqual([])
  })

  it('見つからなければ止めずに進み、集められなかったと出す', async () => {
    await setup(script(...rows, ['事実係・集め', say({ sources: [] })], ['作り手', draft(1)], hold))
    const id = await approved()
    await waitState(id, '検品中')
    const v = await caseView(id)
    expect(v.gatherFailed).toBe(true)
    expect(v.materials).toEqual([])
  })

  it('集めるものが無い依頼は集め役を呼ばない', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await waitState(id, '検品中')
    expect(fake.calls.some((c) => c.role === '事実係・集め')).toBe(false)
  })
})

describe('材料待ち（6.2.4）', () => {
  const wanting = { ...briefDraft, brief: { ...briefDraft.brief, wanted: ['ブレストのメモか記録'] } }
  const withWanted: [Role, ScriptReply][] = upToEntrance.map(([role, reply]) =>
    role === '下書き役・依頼書' ? [role, say(wanting)] : [role, reply],
  )
  const MEMO = '方針 1: 週 1 回の見直し\n方針 2: 担当を決める\n方針 3: 記録を残す'
  const paste = async (id: string, body: Record<string, unknown>) =>
    postJson(`/api/cases/${id}/materials`, {
      type: 'materials.provided',
      eventId: uuid(),
      expectedRevision: (await caseView(id)).revision,
      text: MEMO,
      ...body,
    })

  it('T8: 渡してほしいものがあれば本人の番で止まり、貼った文を materials/ に置いて T10 → T11 → 作り手', async () => {
    await setup(script(...withWanted, ['作り手', draft(1)]))
    const id = await approved()
    await idle()
    expect(ledger.getCase(id)).toMatchObject({ state: '材料待ち', turn: '本人', step: '資料を貼り付けてください' })
    expect(makerCalls()).toEqual([])
    const v = await caseView(id)
    expect(v.entrance?.brief.wanted).toEqual(['ブレストのメモか記録'])
    expect(v.materials).toEqual([])

    // 形の誤り・古い revision はファイルを書かない
    expect((await paste(id, { text: '   ' })).status).toBe(400)
    expect((await paste(id, { expectedRevision: v.revision - 1 })).status).toBe(409)
    expect(existsSync(work(id, 'materials'))).toBe(false)

    const eventId = uuid()
    const res = await paste(id, { eventId })
    expect(res.status).toBe(200)
    await waitState(id, '検品中')
    expect(readFileSync(work(id, 'materials/pasted-01.md'), 'utf-8')).toBe(`${MEMO}\n`)
    expect(readFileSync(work(id, 'brief.md'), 'utf-8')).toContain('- 本人から受け取る資料: ブレストのメモか記録')
    expect(makerCalls()[0]?.instruction).toContain('本人から受け取った資料')
    expect((await caseView(id)).materials).toEqual([
      { id: 'M01', kind: '添付', title: '貼り付けた文', where: 'materials/pasted-01.md', status: '取り寄せ済み' },
    ])
    expect((await caseView(id)).events.map((e) => e.event)).toContain('materials.provided')

    // 二度目の同じ eventId は 1 回目と同じ結果で、何も書かない。本人の番でなくなった後の新しい操作は 409
    const again = await paste(id, { eventId, expectedRevision: v.revision, text: '別の文' })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ replayed: true })
    expect((await paste(id, { text: '別の文' })).status).toBe(409)
    expect(readdirSync(work(id, 'materials'))).toEqual(['pasted-01.md'])
    expect(fake.unused()).toEqual([])
  })

  it('貼った文の URL を取り寄せて資料の正本に足し、作業場には写しを置く（6.3.1 (5)）', async () => {
    await setup(script(...withWanted, ['作り手', draft(1)]))
    const id = await approved()
    await idle()
    const text = `${MEMO}\n参考: https://example.com/weekly（週報）と https://example.com/gone`
    expect((await paste(id, { text })).status).toBe(200)
    await waitState(id, '検品中')
    expect(fetched).toEqual(['https://example.com/weekly', 'https://example.com/gone'])
    const src = join(caseDir(home, id), 'materials')
    expect(readdirSync(src)).toEqual(['pasted-01.md', 'source-01.md'])
    expect(readFileSync(join(src, 'source-01.md'), 'utf-8')).toBe(
      '# 週報\n\nhttps://example.com/weekly\n\n方針は 3 つ。\n',
    )
    expect(readdirSync(work(id, 'materials'))).toEqual(['pasted-01.md', 'source-01.md'])
    expect((await caseView(id)).materials.map((m) => [m.kind, m.title, m.where])).toEqual([
      ['添付', '貼り付けた文', 'materials/pasted-01.md'],
      ['出典', '週報', 'https://example.com/weekly'],
    ])
    // 取り寄せた本文は facts-excerpts/ に（閉じるときに消す）
    expect(readdirSync(join(caseDir(home, id), 'facts-excerpts'))).toHaveLength(1)
  })

  it('渡してほしいものが無ければ今まで通り本人を待たずに作り手へ。資料の口は 409', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await waitState(id, '検品中')
    expect((await paste(id, {})).status).toBe(409)
    expect(readdirSync(work(id, 'materials'))).toEqual([])
  })
})

// 判定役（docs/implementation.md 6.2.5・4.2 T15〜T17・T20〜T21b）。機械判定は通り、Claude の答えで合否が決まる組
describe('文体カード（6.3.2）', () => {
  const VOICE_URL = 'https://example.com/voice-1'
  // 依頼書の書く内容にも見本の URL がある（出典として取り寄せない）
  const matching = {
    ...briefDraft,
    brief: { ...briefDraft.brief, voice: '合わせる', subject: `${briefDraft.brief.subject}。参考 ${VOICE_URL}#part` },
  }
  const plainChecks = [
    ...runnerChecks,
    {
      id: 'C07',
      category: '声' as const,
      title: '文末がだ・である調でそろっている',
      judge: { by: 'code' as const, fn: 'sentenceEndingRatio' as const, args: { endings: ['だ', 'である'] } },
      pass: { kind: 'ratio' as const, min: 0.9 },
      phase: '本文' as const,
      summary: '文末の調子がそろっていません',
      hidden: false,
      selfReport: '書いていない' as const,
    },
  ]
  const rows: [Role, ScriptReply][] = [
    ['話し相手', say(intake)],
    ['下書き役・依頼書', say(matching)],
    ['下書き役・確認項目', say({ checks: plainChecks })],
    ['事実係・分類', say({ items: [...classified.items, { checkId: 'C07', verdict: '決まる' }] })],
  ]
  const portrait = say({ portrait: ['結論を先に書く。', 'です・ます調で語りかける。', '短い文を重ねる。'] })
  // 作り手の呼び出しを止めておき、下書き中に留める（閉じたときの削除の前に見る）
  const makers: { instruction: string }[] = []
  const hangMaker =
    (b: Backend): Backend =>
    (call) =>
      call.role === '作り手'
        ? new Promise((_, reject) => {
            makers.push(call)
            call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true })
          })
        : b(call)
  const putSamples = (samples: unknown) =>
    server.app.request('/api/settings/voice-samples', {
      method: 'PUT',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ samples }),
    })

  it('設定の見本から入口でカードと点検を作り、T11 で voice.md を作業場に置く。見本の段落は作業場に届かない', async () => {
    makers.length = 0
    await setup(script(...rows, ['事実係・描写', portrait]), hangMaker)
    expect((await putSamples([{ title: '振り返りの話', url: VOICE_URL }])).status).toBe(200)
    const id = await approved()
    await vi.waitFor(() => expect(makers).toHaveLength(1), { timeout: 2000, interval: 5 })

    const v = await caseView(id)
    expect(v.entrance?.checks.voice).toEqual({ docs: 1, card: true })
    // 本人の文章（です・ます）は だ・である の項目を通らない
    expect(v.entrance?.checks.items.find((x) => x.id === 'C07')?.own).toBe('fail')
    const fns = (v.entrance?.checks.items ?? []).filter((x) => x.category === '声').map((x) => x.title)
    expect(fns).toHaveLength(5) // C07 とホストの 3 項目と読み比べ

    // 見本は入口で 1 回だけ取り寄せる（T11 の出典に入れない）
    expect(fetched).toEqual([VOICE_URL])
    expect(readdirSync(join(caseDir(home, id), 'materials'))).toEqual([])
    expect(readdirSync(work(id, 'materials'))).toEqual([])

    const card = JSON.parse(readFileSync(join(caseDir(home, id), 'voice.json'), 'utf-8'))
    expect(card).toMatchObject({
      main: 'です・ます',
      firstPerson: '私',
      sources: [{ title: '振り返りの話', url: VOICE_URL }],
    })
    expect(card.portrait).toHaveLength(3)
    expect(readFileSync(work(id, 'voice.md'), 'utf-8')).toContain('いちばん多いのは です・ます')
    expect(readFileSync(join(caseDir(home, id), 'checks', 'voice-samples.md'), 'utf-8')).toContain(VOICE_PARA_1)
    expect(allWorkText(id)).not.toContain(VOICE_PARA_1.slice(0, 20))
    expect(makers[0]?.instruction).toContain('voice.md: 本人の文体カード')
    // 描写には数値と見本を渡し、作業場は渡さない
    const p = fake.calls.find((c) => c.role === '事実係・描写')
    expect(p?.access).toBe('none')
    expect(p?.materials.map((m) => m.name)).toEqual(['文体カード', '本人の文章'])
  })

  it('前の組み立てで取った出典は書き直す（今の組の見本になった本文を作業場に残さない）', async () => {
    makers.length = 0
    await setup(script(...rows, ['事実係・描写', portrait]), hangMaker)
    await putSamples([{ title: '振り返りの話', url: VOICE_URL }])
    await postJson('/api/conversation/messages', { requestId: uuid(), lastSeq: 0, text: '記事にして' })
    await server.conversation.settled()
    const id = ledger.lastMessage('lobby')?.caseId as string
    await vi.waitFor(() => expect(ledger.getCase(id)?.turn).toBe('本人'), { timeout: 2000, interval: 5 })
    const old = `# 過去の記事\n\n${VOICE_URL}\n\n${VOICE_PARA_1}\n`
    for (const dir of [join(caseDir(home, id), 'materials'), work(id, 'materials')]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'source-01.md'), old)
    }
    const v = await caseView(id)
    await act(id, {
      type: 'entrance.approve',
      answers: { U01: ['b'] },
      mode: '確認しながら',
      setFingerprint: v.entrance?.setFingerprint,
    })
    await vi.waitFor(() => expect(makers).toHaveLength(1), { timeout: 2000, interval: 5 })
    expect(readdirSync(join(caseDir(home, id), 'materials'))).toEqual([])
    expect(allWorkText(id)).not.toContain(VOICE_PARA_1.slice(0, 20))
  })

  it('見本が 1 つも開けなければカードを作らず、ホストの声の項目も足さない', async () => {
    makers.length = 0
    await setup(script(...rows), hangMaker)
    expect((await putSamples([{ title: '消えた記事', url: 'https://example.com/gone' }])).status).toBe(200)
    const id = await approved()
    await vi.waitFor(() => expect(makers).toHaveLength(1), { timeout: 2000, interval: 5 })
    const v = await caseView(id)
    expect(v.entrance?.checks.voice).toEqual({ docs: 0, card: false })
    expect(v.entrance?.checks.items.filter((x) => x.category === '声').map((x) => x.id)).toEqual(['C07'])
    expect(v.entrance?.checks.items.find((x) => x.id === 'C07')?.own).toBeUndefined()
    expect(existsSync(work(id, 'voice.md'))).toBe(false)
    expect(existsSync(join(caseDir(home, id), 'checks', 'voice-samples.md'))).toBe(false)
    expect(makers[0]?.instruction).not.toContain('voice.md')
  })

  it('見本の設定: 形の誤りは 400、保存すると前の版を残す', async () => {
    await setup([])
    const bad = [
      [{ title: '', url: VOICE_URL }],
      [{ title: 't', url: 'ftp://example.com/a' }],
      Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: `${VOICE_URL}${i}` })),
    ]
    for (const b of bad) expect((await putSamples(b)).status).toBe(400)
    expect(await (await get('/api/settings/voice-samples')).json()).toEqual({ samples: [] })
    await putSamples([{ title: 'a', url: VOICE_URL }])
    const res = await putSamples([{ title: ' b ', url: VOICE_URL }])
    expect(await res.json()).toEqual({ samples: [{ id: 'V1', kind: '声の見本', title: 'b', where: VOICE_URL }] })
    expect(JSON.parse(readFileSync(join(home, 'settings.prev.json'), 'utf-8')).voiceSamples[0].title).toBe('a')
  })
})

const verdicts = (ok: boolean): ScriptReply =>
  say({
    results: [
      {
        id: 'C02',
        units: [{ index: 0, yes: ok }],
        reason: ok ? '決まったことが先に書いてあります。' : '決まったことが最後まで出てきません。',
      },
      { id: 'C05', units: [{ index: 0, yes: true }], reason: 'ふだんの言い回しで書かれています。' },
      {
        id: 'C06',
        units: [
          { index: 0, yes: true },
          { index: 1, yes: true },
        ],
        reason: 'どの段落も次にすることが分かります。',
      },
    ],
  })
const judgeCalls = () => fake.calls.filter((c) => c.role === '判定役・文章')
const reviewPath = (id: string, name: string) => join(caseDir(home, id), name)
const real = (b: Backend) => b
// 判定役の Claude（文章・画像）は聞かれた単位に全部「はい」と答える（表の段落やページの数が台本に依らない）
const answerYes =
  (b: Backend): Backend =>
  async (call) => {
    if (call.role !== '判定役・文章' && call.role !== '判定役・画像') return b(call)
    const m = call.materials.find((x) => x.name === '確かめること') as { text: string }
    const asked = JSON.parse(m.text) as { id: string; units: number[] }[]
    const results = asked.map((a) => ({
      id: a.id,
      units: a.units.map((index) => ({ index, yes: true })),
      reason: '確かめました。',
    }))
    return { text: JSON.stringify({ results }), costYen: 0 }
  }

describe('判定役', () => {
  it('T15: 全部通れば承認待ち。判定のファイルは .md → .reasons.md → .json の順、画面には review が出る', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['判定役・文章', verdicts(true)]), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    expect(ledger.getCase(id)).toMatchObject({ approvalKind: '完成稿', round: 1, turn: '本人' })
    const r = Review.parse(JSON.parse(readFileSync(reviewPath(id, 'review-01-a.json'), 'utf-8')))
    expect(r).toMatchObject({ version: 1, series: 1, round: 1, phase: '本文', attempt: 1, pass: true })
    const mt = (name: string) => statSync(reviewPath(id, name)).mtimeMs
    expect(mt('review-01-a.md')).toBeLessThanOrEqual(mt('review-01-a.reasons.md'))
    expect(mt('review-01-a.reasons.md')).toBeLessThanOrEqual(mt('review-01-a.json'))
    expect(readFileSync(reviewPath(id, 'review-01-a.reasons.md'), 'utf-8')).toContain('## C02')
    // 判定は本文の写し（versions/01）を読み、作業場は読まない。canary の語は判定役にも渡さない
    const call = judgeCalls()[0]
    expect(call?.workdir).toBeUndefined()
    expect(JSON.stringify(call?.materials)).not.toContain(TOKEN)
    const v = await caseView(id)
    expect(v.review).toMatchObject({ n: 1, passed: 7, failed: [], skipped: 0 })
    expect(v.review?.familyNote).toBeDefined()
    expect(v.versions.map((x) => x.state)).toEqual(['合格'])
  })

  it('承認の指紋が古ければ 409、今の指紋なら送付確認待ちへ', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['判定役・文章', verdicts(true)]), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    const stale = await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: 'old' })
    expect(stale.status).toBe(409)
    expect((await stale.json()).reason).toBe('stale')
    const fp = (await caseView(id)).versions[0]?.fingerprint
    expect((await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: fp })).status).toBe(200)
    expect(ledger.listApprovals(id).find((a) => a.gate === '完成稿')).toMatchObject({
      version: 1,
      versionFingerprint: fp,
    })
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
  })

  it('T16 → T17: 不合格は 1 行要約だけを作り手へ戻し、3 回目で承認待ち（残りの理由文付き）', async () => {
    await setup(
      script(
        ...upToEntrance,
        ['作り手', draft(1)],
        ['判定役・文章', verdicts(false)],
        ['作り手', draft(2)],
        ['判定役・文章', verdicts(false)],
        ['作り手', draft(3)],
        ['判定役・文章', verdicts(false)],
      ),
      real,
    )
    const id = await approved()
    await waitState(id, '承認待ち')
    expect(ledger.getCase(id)).toMatchObject({ version: 3, round: 3, approvalKind: '完成稿' })
    const fb = readFileSync(work(id, 'feedback.md'), 'utf-8')
    expect(fb).toContain('読み終えても決まったことが伝わりません')
    expect(fb).not.toContain('最後まで出てきません')
    expect(fb).not.toContain('C02')
    expect(allWorkText(id)).not.toContain('初見の読者')
    const v = await caseView(id)
    expect(v.review?.failed).toEqual([
      {
        checkId: 'C02',
        title: '初見の読者がブレストで決まったことを 3 行で言える',
        verdict: 'fail',
        reason: '決まったことが最後まで出てきません。',
      },
    ])
    expect(v.versions.map((x) => x.state)).toEqual(['不合格', '不合格', '不合格'])
    expect(fake.unused()).toEqual([])
  })

  it('T17 おまかせ: 3 回目の不合格で停止（往復上限）', async () => {
    await setup(
      script(
        ...upToEntrance,
        ['作り手', draft(1)],
        ['判定役・文章', verdicts(false)],
        ['作り手', draft(2)],
        ['判定役・文章', verdicts(false)],
        ['作り手', draft(3)],
        ['判定役・文章', verdicts(false)],
      ),
      real,
    )
    const id = await approved('おまかせ')
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('往復上限')
  })

  // 字数の下限だけを 2,000 字にした組（3 回目を待たずに上げる。6.2.7）
  const strictEntrance: [Role, ScriptReply][] = upToEntrance.map(([role, reply]) =>
    role === '下書き役・確認項目'
      ? [
          role,
          say({
            checks: runnerChecks.map((c) =>
              c.id === 'C01' ? { ...c, judge: { ...c.judge, args: { min: 2000 } } } : c,
            ),
          }),
        ]
      : [role, reply],
  )
  const long = (chars: number) => `# ブレストのまとめ\n\n${'あ'.repeat(chars)}\n\n## 1 つ目\n\n本文。\n`

  it('T17 早め: 字数が 2 回続けて機械判定で落ち、合格に近づいていなければ 2 回目で承認待ち（直らない）', async () => {
    await setup(script(...strictEntrance, ['作り手', draft(1, long(1890))], ['作り手', draft(2, long(1669))]), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    expect(ledger.getCase(id)).toMatchObject({ version: 2, round: 2, approvalKind: '完成稿' })
    const r = Review.parse(JSON.parse(readFileSync(reviewPath(id, 'review-02-a.json'), 'utf-8')))
    expect(r.escalate).toEqual({ why: '直らない', checkIds: ['C01'] })
    expect(r.results.find((x) => x.id === 'C01')?.measured).toMatchObject({ chars: 1683, gap: 317 }) // 見出しと「本文。」の 14 字を含む
    expect((await caseView(id)).review?.escalate).toEqual({ why: '直らない', checkIds: ['C01'] })
    expect(makerCalls()).toHaveLength(2)
    expect(judgeCalls()).toEqual([])
  })

  it('T16: 字数が合格に近づいていれば 3 回目に進む（往復上限で承認待ち）', async () => {
    await setup(
      script(
        ...strictEntrance,
        ['作り手', draft(1, long(1200))],
        ['作り手', draft(2, long(1500))],
        ['作り手', draft(3, long(1500))],
      ),
      real,
    )
    const id = await approved()
    await waitState(id, '承認待ち')
    expect(ledger.getCase(id)).toMatchObject({ version: 3, round: 3 })
    const r = Review.parse(JSON.parse(readFileSync(reviewPath(id, 'review-03-a.json'), 'utf-8')))
    expect(r.escalate).toBeUndefined() // 3 回目は往復上限で、早めではない
    expect(makerCalls()).toHaveLength(3)
  })

  it('T17 早め おまかせ: 判定できない項目だけが残れば、作り手に返さず 1 回目で停止（判定できない）', async () => {
    const unsure = say({
      results: [
        { id: 'C02', units: [{ index: 0, yes: null }], reason: '本人のメモが無いので決められません。' },
        { id: 'C05', units: [{ index: 0, yes: true }], reason: 'ふだんの言い回しです。' },
        {
          id: 'C06',
          units: [
            { index: 0, yes: true },
            { index: 1, yes: true },
          ],
          reason: '次にすることが分かります。',
        },
      ],
    })
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['判定役・文章', unsure]), real)
    const id = await approved('おまかせ')
    await waitState(id, '停止')
    expect(ledger.getCase(id)).toMatchObject({ stopReason: '判定できない', round: 1 })
    const r = Review.parse(JSON.parse(readFileSync(reviewPath(id, 'review-01-a.json'), 'utf-8')))
    expect(r.failedSummaries).toEqual([])
    expect(r.escalate).toEqual({ why: '判定できない', checkIds: ['C02'] })
    expect(makerCalls()).toHaveLength(1)
    expect(existsSync(work(id, 'feedback.md'))).toBe(false)
  })

  it('再起動: 判定のファイルを書いた後に落ちていれば、Claude を呼ばずにそのファイルで遷移する', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await vi.waitFor(() => expect(hung).toEqual([id]))
    await server.runs.abort(id)
    await idle()
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    const review: Review = {
      version: 1,
      series: c.series,
      round: c.round + 1,
      at: new Date().toISOString(),
      phase: '本文',
      attempt: 1,
      results: [{ id: 'C01', verdict: 'pass', by: 'code' }],
      pass: true,
      failedSummaries: [],
      marks: [],
      sources: [],
    }
    writeFileSync(reviewPath(id, 'review-01-a.json'), JSON.stringify(review))
    ledger.close()
    await setup([], real, true)
    server.runner.resume()
    await waitState(id, '承認待ち')
    expect(judgeCalls()).toEqual([])
  })

  it('再起動: #48 より前の形（機械判定の fail に gap が無い）の判定は使い回さず判定し直す', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await vi.waitFor(() => expect(hung).toEqual([id]))
    await server.runs.abort(id)
    await idle()
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    const old: Review = {
      version: 1,
      series: c.series,
      round: c.round + 1,
      at: new Date().toISOString(),
      phase: '本文',
      attempt: 1,
      results: [{ id: 'C01', verdict: 'fail', by: 'code', measured: { chars: 10 } }],
      pass: false,
      failedSummaries: ['分量が依頼の範囲から外れています'],
      marks: [],
      sources: [],
    }
    writeFileSync(reviewPath(id, 'review-01-a.json'), JSON.stringify(old))
    ledger.close()
    await setup(script(['判定役・文章', verdicts(true)]), real, true)
    server.runner.resume()
    await waitState(id, '承認待ち')
    expect(judgeCalls()).toHaveLength(1)
  })

  it('判定のセッションが壊れた・読む版が無いときは fail.system(判定できなかった)', async () => {
    await setup(
      script(
        ...upToEntrance,
        ['作り手', draft(1)],
        ['判定役・文章', { text: 'だめ' }],
        ['判定役・文章', { text: '{}' }],
      ),
      real,
    )
    const id = await approved()
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('判定できなかった')

    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const lost = await approved()
    await vi.waitFor(() => expect(hung).toEqual([lost]))
    await server.runs.abort(lost)
    await idle()
    rmSync(join(caseDir(home, lost), 'versions/01/draft-01.md'))
    server.runner.kick(lost)
    await waitState(lost, '停止')
    expect(ledger.getCase(lost)?.stopReason).toBe('判定できなかった')
  })

  it('判定役につながらなければ fail.system(つながらない)', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)], ['判定役・文章', { fail: 'unavailable' }]), real)
    const id = await approved()
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('つながらない')
  })

  // 承認まで進めて、runner が仕立てと形式の判定を流す（6.2.8 (1)）
  async function approveFinal(maker = draft(1)) {
    await setup(script(...upToEntrance, ['作り手', maker], ['判定役・文章', verdicts(true)]), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    return id
  }
  const ok = async (id: string) =>
    act(id, { type: 'approval.ok', marks: {}, versionFingerprint: (await caseView(id)).versions[0]?.fingerprint })

  it('T20: 仕立てた成果物の形式が通れば送付確認待ち（本人の番）、送付成果物の指紋を書く', async () => {
    const id = await approveFinal()
    await ok(id)
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    const outputs = VersionManifest.parse(
      JSON.parse(readFileSync(join(caseDir(home, id), 'versions/01/outputs.json'), 'utf-8')),
    )
    expect(outputs.files.map((f) => f.path)).toEqual([OUTPUT_FILES.page])
    expect(ledger.getCase(id)).toMatchObject({ outputFingerprint: outputs.fingerprint, round: 2 })
    expect(Review.parse(JSON.parse(readFileSync(reviewPath(id, 'review-01-f1.json'), 'utf-8')))).toMatchObject({
      phase: '形式',
      attempt: 1,
      pass: true,
    })
    const v = await caseView(id)
    expect(v.formatReview).toMatchObject({ n: 1, passed: 1 })
    expect(v.review?.passed).toBe(7)
  })

  it('T21: ページが本文と食い違えば下書きへ戻し、完成稿の承認を無効にする', async () => {
    const id = await approveFinal({
      text: '書きました',
      write: { 'draft-01.md': BODY, 'draft-01.html': '<h1>ブレストのまとめ</h1>', 'draft-01.done': 'done' },
    })
    await ok(id)
    await waitState(id, '下書き中')
    expect(ledger.listApprovals(id).find((a) => a.gate === '完成稿')?.supersededBy).toBeDefined()
    expect(readFileSync(work(id, 'feedback.md'), 'utf-8')).toContain('# 直してほしいこと')
  })

  it('版のファイルが読めなければ仕立てずに fail.system(判定できなかった)', async () => {
    const id = await approveFinal()
    rmSync(join(caseDir(home, id), 'versions/01/draft-01.html'))
    await ok(id)
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('判定できなかった')
  })

  it('本文の API: md・組み立てた html（作り手の HTML は出さない）・差分', async () => {
    const evil = '# 題\n\n<script>alert(1)</script> と **強調**\n\n二段落目。\n'
    await setup(
      script(...upToEntrance, ['作り手', draft(1, evil)], ['判定役・文章', verdicts(false)], ['作り手', draft(2)]),
      (b) => (call) => (call.role === '判定役・文章' && judgeCalls().length ? hangJudge(b)(call) : b(call)),
    )
    const id = await approved()
    await vi.waitFor(() => expect(ledger.getCase(id)?.version).toBe(2))
    const md = await get(`/api/cases/${id}/drafts/1?format=md`)
    expect(await md.text()).toBe(evil)
    const html = await get(`/api/cases/${id}/drafts/1?format=html`)
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'")
    const body = await html.text()
    expect(body).not.toContain('<script>')
    expect(body).toContain('<strong>強調</strong>')
    expect((await get(`/api/cases/${id}/drafts/3?format=md`)).status).toBe(404)
    expect((await get(`/api/cases/${id}/drafts/1?format=paste`)).status).toBe(404) // 仕立ての前
    expect((await get(`/api/cases/${id}/drafts/1?format=pdf`)).status).toBe(400)
    const d = DraftDiff.parse(await (await get(`/api/cases/${id}/diff?from=1&to=2`)).json())
    expect(d.changes.length).toBeGreaterThan(0)
    expect((await get(`/api/cases/${id}/diff?from=0&to=2`)).status).toBe(400)
  })
})

describe('送付と完了（6.2.8）', () => {
  const both = { ...intake, intake: { ...intake.intake, destinations: ['paste', 'page'] } }
  const toFinal: [Role, ScriptReply][] = [
    ['話し相手', say(both)],
    ...upToEntrance.slice(1),
    ['作り手', draft(1)],
    ['判定役・文章', verdicts(true)],
  ]
  const fingerprint = async (id: string) => (await caseView(id)).versions[0]?.fingerprint
  const toConfirm = async () => {
    await setup(script(...toFinal), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: await fingerprint(id) })
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    return id
  }
  const send = async (id: string) =>
    act(id, { type: 'delivery.send', planFingerprint: (await caseView(id)).deliveryPlan.fingerprint })
  // ホストの通常の終了（4.2 の末尾）と同じ止め方で止めて、同じ LIBRETTO_HOME で起こし直す
  const restart = async () => {
    await server.runs.abortAll()
    ledger.close()
    await setup([], real, true)
    server.runner.resume()
  }

  it('受け入れ (2): 承認待ちで止めて起こし直すと、確認待ちは承認待ちの 1 件。続けて T18 → T20 → T22 → T24 で完了しページで受け取る', async () => {
    await setup(script(...toFinal), real)
    const id = await approved()
    await waitState(id, '承認待ち')
    await idle()

    await restart()
    const home1 = HomeView.parse(await (await get('/api/home')).json())
    expect(home1.yourTurn.map((c) => [c.id, c.state, c.approvalKind])).toEqual([[id, '承認待ち', '完成稿']])
    expect(home1.active).toEqual([])
    expect(server.runner.running()).toEqual([])

    expect((await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: await fingerprint(id) })).status).toBe(
      200,
    )
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    // 送付の確認の前はページを出さない（保存した版だけ。6.2.8 (4)）
    expect((await get(`/cases/${id}/page`)).status).toBe(404)
    const paste = await get(`/api/cases/${id}/drafts/1?format=paste`)
    expect(paste.headers.get('content-type')).toContain('text/plain')
    expect(await paste.text()).toBe('ブレストのまとめ\n\n決まったことは 3 つです。\n\n1 つ目\n\n本文。\n')

    expect((await send(id)).status).toBe(200)
    await waitState(id, '完了')
    const v = await caseView(id)
    expect(v.deliveries.map((d) => [d.target.kind, d.status])).toEqual([
      ['paste', '送付済'],
      ['page', '送付済'],
    ])
    expect(v.deliveries.find((d) => d.target.kind === 'page')?.link).toBe(`/cases/${id}/page?v=1`)
    expect(v.doneAt).toBeDefined()
    expect(ledger.listDecisions(id).at(-1)?.text).toBe('バージョン 1 を保存しました')

    const page = await get(`/cases/${id}/page`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    const html = await page.text()
    expect(html).toContain('<h1>ブレストのまとめ</h1>')
    expect(html).toContain('<title>ブレストのまとめ</title>')
    expect((await get(`/cases/${id}/page?v=1`)).status).toBe(200)
    expect((await get(`/cases/${id}/page?v=2`)).status).toBe(404)
    expect((await server.app.request(`/cases/${id}/page`)).status).toBe(401)
    const dl = await get(`/cases/${id}/page?download=1`)
    expect(dl.headers.get('content-disposition')).toBe(
      `attachment; filename="page-v1.html"; filename*=UTF-8''${encodeURIComponent('ブレストのまとめ-第1版.html')}`,
    )
    expect(await dl.text()).toBe(html)

    const done = CaseCard.array().parse(await (await get('/api/cases?state=完了')).json())
    expect(done.map((c) => c.id)).toEqual([id])
    expect((await get('/api/cases?state=どれでもない')).status).toBe(400)
  })

  it('受け入れ (2): 送付中に 1 つ目を送付済にしたところで止めても、起こし直すと残りだけを送付済にして完了（T24）', async () => {
    const id = await toConfirm()
    // HTTP を通さずに T22 と 1 つ目の T24 を書き、runner が送る前に落ちた形を作る
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    const plan = (await caseView(id)).deliveryPlan.fingerprint
    expect(
      transition(ledger, {
        type: 'delivery.send',
        eventId: uuid(),
        caseId: id,
        expectedRevision: c.revision,
        planFingerprint: plan,
        by: '本人',
      }).ok,
    ).toBe(true)
    const [first] = ledger.listDeliveries(id)
    if (!first) throw new Error('no delivery')
    transition(ledger, {
      type: 'delivery.done',
      eventId: `${id}:delivery.done:${first.attemptId}`,
      caseId: id,
      attemptId: first.attemptId,
      receiptId: `${first.target.kind}:v1`,
      by: 'libretto',
    })
    expect(ledger.getCase(id)?.state).toBe('送付中')

    await restart()
    await waitState(id, '完了')
    const rows = ledger.listDeliveries(id)
    expect(rows.filter((d) => d.attemptId === first.attemptId && d.status === '送付済')).toHaveLength(1)
    expect(new Set(rows.filter((d) => d.status === '送付済').map((d) => d.attemptId)).size).toBe(2)
    // 履歴の行はどの届け先を保存したかを持つ（#21）
    const done = (await caseView(id)).events.filter((e) => e.event === 'delivery.done').map((e) => e.target?.kind)
    expect(done.sort()).toEqual(c.destination.map((t) => t.kind).sort())
  })

  it('T26: 形式の判定の後に成果物が書き換わっていれば、保存したことにせず停止（送付失敗）', async () => {
    const id = await toConfirm()
    writeFileSync(join(caseDir(home, id), 'versions/01/outputs', OUTPUT_FILES.page), '<p>判定していない字</p>')
    await send(id)
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('送付失敗')
    expect((await get(`/cases/${id}/page`)).status).toBe(404)
  })

  it('T23: 保存しないで戻ると承認待ち（完成稿）', async () => {
    const id = await toConfirm()
    expect((await act(id, { type: 'delivery.decline' })).status).toBe(200)
    expect(ledger.getCase(id)).toMatchObject({ state: '承認待ち', approvalKind: '完成稿' })
  })
})

describe('canary（8.10 (1)）', () => {
  const leaked = async (id: string) => {
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('隔離の失敗')
    expect(JSON.stringify(ledger.lastMessage(id))).toContain(SAY.isolationLeaked)
  }
  it('本文に語があれば写さずに fail.system(隔離の失敗)。会話欄は見えたおそれを言う', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1, `${BODY}\n${TOKEN}\n`)]))
    const id = await approved()
    await leaked(id)
    expect(existsSync(join(caseDir(home, id), 'versions'))).toBe(false)
  })

  it('言い直しの前の回の返答にだけ語があっても止める', async () => {
    const first: ScriptReply = { text: `書きました ${TOKEN}`, write: { 'draft-01.md': BODY } }
    await setup(script(...upToEntrance, ['作り手', first], ['作り手', draft(1)]))
    const id = await approved()
    await leaked(id)
    expect(makerCalls()).toHaveLength(2)
  })

  it('作業場のほかのファイルに語があれば、書けなかったより先に隔離の失敗', async () => {
    const bad: ScriptReply = { text: '書きました', write: { 'draft-01.md': BODY, 'notes/memo.md': TOKEN } }
    await setup(script(...upToEntrance, ['作り手', bad], ['作り手', bad]))
    const id = await approved()
    await leaked(id)
  })

  it('再起動の合わせの道でも、作業場に語があれば写さない', async () => {
    await setup(script(...upToEntrance, ['作り手', { fail: 'hang' }]))
    const id = await approved()
    await vi.waitFor(() => expect(makerCalls()).toHaveLength(1))
    for (const [name, text] of Object.entries(
      (draft(1, `${BODY}${TOKEN}\n`) as { write: Record<string, string> }).write,
    ))
      writeFileSync(work(id, name), text)
    ledger.close()
    await setup([], hangJudge, true)
    server.runner.resume()
    await leaked(id)
    expect(makerCalls()).toEqual([])
  })

  it('判定役: 版の正本に語があれば、使い回せる判定があっても判定せずに止める', async () => {
    await setup(script(...upToEntrance, ['作り手', draft(1)]))
    const id = await approved()
    await vi.waitFor(() => expect(hung).toEqual([id]))
    await server.runs.abort(id)
    await idle()
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    const review: Review = {
      version: 1,
      series: c.series,
      round: c.round + 1,
      at: new Date().toISOString(),
      phase: '本文',
      attempt: 1,
      results: [{ id: 'C01', verdict: 'pass', by: 'code' }],
      pass: true,
      failedSummaries: [],
      marks: [],
      sources: [],
    }
    writeFileSync(join(caseDir(home, id), 'review-01-a.json'), JSON.stringify(review))
    writeFileSync(join(caseDir(home, id), 'versions/01/draft-01.html'), `<p>${TOKEN}</p>`)
    ledger.close()
    await setup([], hangJudge, true)
    server.runner.resume()
    await leaked(id)
  })
})

describe('Google ドキュメントの届け先（6.5）', () => {
  let g: Awaited<ReturnType<typeof startFakeGoogle>>
  const link = (scopes = [GMAIL_SCOPE, DRIVE_SCOPE]) =>
    writeFileSync(
      join(home, 'google.json'),
      JSON.stringify({ refreshToken: 'rt-1', email: 'me@example.com', scopes, savedAt: '2026-10-25T09:00:00+09:00' }),
    )
  const dests = (d: string[]) => ({ ...intake, intake: { ...intake.intake, destinations: d } })
  const toFinal = (d: string[]): [Role, ScriptReply][] => [
    ['話し相手', say(dests(d))],
    ...upToEntrance.slice(1),
    ['作り手', draft(1)],
    ['判定役・文章', verdicts(true)],
  ]
  const fingerprint = async (id: string) => (await caseView(id)).versions[0]?.fingerprint
  // 連携した Google（偽物）で、保存先 d の案件を送付確認待ち・本人の番まで進める
  const toConfirm = async (d: string[], extra: [Role, ScriptReply][] = [], wrap: (b: Backend) => Backend = real) => {
    home = mkdtempSync(join(tmpdir(), 'libretto-runner-'))
    link()
    google = createGoogle({
      home,
      config: { clientId: 'c', clientSecret: 's' },
      redirectUri: 'http://127.0.0.1/oauth/google/callback',
      endpoints: g.endpoints,
    })
    n = 0
    await setup(script(...toFinal(d), ...extra), wrap, true)
    const id = await approved()
    await waitState(id, '承認待ち')
    await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: await fingerprint(id) })
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    return id
  }
  const send = async (id: string) =>
    act(id, { type: 'delivery.send', planFingerprint: (await caseView(id)).deliveryPlan.fingerprint })
  const gdocRows = (id: string) => ledger.listDeliveries(id).filter((x) => x.target.kind === 'gdoc')
  const uploads = () => g.seen.filter((x) => x.method === 'POST' && x.path.startsWith('/upload/'))
  const FOLDER = 'application/vnd.google-apps.folder'
  const docs = () => [...g.files.values()].filter((f) => f.mimeType !== FOLDER)
  const folders = () => [...g.files.values()].filter((f) => f.mimeType === FOLDER)

  beforeEach(async () => {
    g = await startFakeGoogle()
  })
  afterEach(async () => {
    google = undefined
    await g.close()
  })

  it('T24: docx を変換付きで作り、書き出して照合が合えば保存済み。題に（第 N 版）、libretto のフォルダ、attempt の印、共有しない', async () => {
    const id = await toConfirm(['page', 'gdoc'])
    const v0 = await caseView(id)
    expect(v0.destinationChoices).toEqual(['page', 'paste', 'gdoc'])
    expect(v0.formatReview?.failed).toEqual([])
    expect((await send(id)).status).toBe(200)
    await waitState(id, '完了')
    const [f] = docs()
    expect(docs()).toHaveLength(1)
    // libretto のフォルダをマイドライブに作り、その中に作る（6.5 (3)）
    const [dir] = folders()
    expect(dir).toMatchObject({ name: 'libretto', parents: ['root'], appProperties: { librettoFolder: '1' } })
    expect(f).toMatchObject({
      name: 'ブレストのまとめ（第 1 版）',
      parents: [dir?.id],
      mimeType: 'application/vnd.google-apps.document',
    })
    const row = gdocRows(id).at(-1)
    expect(f?.appProperties.librettoAttempt).toBe(row?.attemptId)
    expect(row).toMatchObject({
      status: '送付済',
      receiptId: `gdoc:${f?.id}`,
      link: `https://docs.google.com/document/d/${f?.id}/edit`,
    })
    expect(g.seen.some((x) => x.path.includes('/permissions'))).toBe(false)
    // 作った後は書き出しで確かめる（検索は印が無ければ要らない）
    expect(g.seen.filter((x) => x.path.includes('/export')).length).toBe(1)
  })

  it('T24b: 書き出しが本文と食い違えば書き直しに戻し、ファイルは失敗の行にリンクで残る。作り手に食い違いを返す', async () => {
    const id = await toConfirm(
      ['gdoc'],
      [['作り手', draft(2)]],
      (b) => (call) => (call.role === '判定役・文章' && judgeCalls().length ? hangJudge(b)(call) : b(call)),
    )
    g.state.dropParagraph = true
    await send(id)
    await vi.waitFor(() => expect(ledger.getCase(id)?.version).toBe(2), { timeout: 2000, interval: 5 })
    const failed = gdocRows(id).find((x) => x.status === '失敗')
    expect(failed?.link).toContain('docs.google.com')
    expect(failed?.reason).toBe(GDOC_SAY.mismatch(1, 0))
    expect(readFileSync(work(id, 'feedback.md'), 'utf-8')).toContain(GDOC_SAY.mismatch(1, 0))
    expect((await caseView(id)).deliveries.find((d) => d.status === '失敗')?.link).toBe(failed?.link)
  })

  it('T25 → T24: 作成の応答が取れなければ不明にして作り直さず、探し直しの周期に attempt の印で見つけて照合する', async () => {
    const id = await toConfirm(['gdoc'])
    g.state.createThenFail = 1
    await send(id)
    await vi.waitFor(() => expect(gdocRows(id).at(-1)?.status).toBe('不明'))
    await idle()
    expect(ledger.getCase(id)?.state).toBe('送付中')
    server.runner.recheck()
    await waitState(id, '完了')
    expect(uploads()).toHaveLength(1)
    expect(docs()).toHaveLength(1)
  })

  it('T26: 不明のまま 3 回探しても見つからなければ停止（送付失敗）', async () => {
    const id = await toConfirm(['gdoc'])
    g.state.createThenFail = 1
    await send(id)
    await vi.waitFor(() => expect(gdocRows(id).at(-1)?.status).toBe('不明'))
    g.files.clear()
    for (let k = 0; k < 3; k++) {
      await idle()
      server.runner.recheck()
      await idle()
    }
    await waitState(id, '停止')
    expect(ledger.getCase(id)?.stopReason).toBe('送付失敗')
    expect(gdocRows(id).filter((x) => x.status === '不明')).toHaveLength(3)
    expect(gdocRows(id).at(-1)?.reason).toBe(GDOC_SAY.notFound)
    expect(uploads()).toHaveLength(1)
  })

  it('作成を送った後に落ちても、起こし直すと作り直さずに探して確かめる（作成の前の印）', async () => {
    const id = await toConfirm(['gdoc'])
    g.state.createThenFail = 1
    // 応答が返る前に止めたのと同じ: 印は書かれ、作成は届いている。遷移は書かれていない
    const c = ledger.getCase(id)
    if (!c) throw new Error('no case')
    await server.runs.abortAll()
    transition(ledger, {
      type: 'delivery.send',
      eventId: uuid(),
      caseId: id,
      expectedRevision: c.revision,
      planFingerprint: (await caseView(id)).deliveryPlan.fingerprint,
      by: '本人',
    })
    const [a] = ledger.listDeliveries(id)
    if (!a) throw new Error('no attempt')
    mkdirSync(join(caseDir(home, id), 'deliveries'), { recursive: true })
    writeFileSync(join(caseDir(home, id), 'deliveries', `${encodeURIComponent(a.attemptId)}.json`), '{}\n')
    g.files.set('doc-x', {
      id: 'doc-x',
      name: 'x',
      parents: ['root'],
      appProperties: { librettoAttempt: a.attemptId },
      docx: readFileSync(join(caseDir(home, id), 'versions/01/outputs', OUTPUT_FILES.docx)),
      mimeType: 'application/vnd.google-apps.document',
    })
    ledger.close()
    await setup([], real, true)
    server.runner.resume()
    await waitState(id, '完了')
    expect(uploads()).toHaveLength(0)
    expect(gdocRows(id).at(-1)?.receiptId).toBe('gdoc:doc-x')
  })

  it('T26: Google ドキュメントの許可が無い連携なら作らずに停止。画面は連携し直しを促し、保存先に出さない', async () => {
    const id = await toConfirm(['gdoc'])
    link([GMAIL_SCOPE])
    expect((await caseView(id)).destinationChoices).toEqual(['page', 'paste'])
    await send(id)
    await waitState(id, '停止')
    expect(gdocRows(id).at(-1)?.reason).toBe(GDOC_SAY.notLinked)
    expect(uploads()).toHaveLength(0)
    const conn = await (await get('/api/connections')).json()
    expect(conn.google).toMatchObject({ state: 'connected', docs: false })
  })

  it('Drive API が有効でない（403 accessNotConfigured）なら、有効にする場所を添えて失敗にする', async () => {
    const id = await toConfirm(['gdoc'])
    g.state.fail = {
      status: 403,
      body: JSON.stringify({ error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } }),
      times: 99,
      path: /\/drive\/v3\/files/,
    }
    await send(id)
    await waitState(id, '停止')
    expect(gdocRows(id).at(-1)?.reason).toBe(GDOC_SAY.driveDisabled)
    expect(GDOC_SAY.driveDisabled).toContain('Google Cloud')
  })

  it('T23b: 承認の面で保存先を page から Google ドキュメントに変えると、組に無い形式の項目をホストが足して判定する', async () => {
    home = mkdtempSync(join(tmpdir(), 'libretto-runner-'))
    link()
    google = createGoogle({
      home,
      config: { clientId: 'c', clientSecret: 's' },
      redirectUri: 'http://127.0.0.1/oauth/google/callback',
      endpoints: g.endpoints,
    })
    n = 0
    await setup(script(...toFinal(['page'])), real, true)
    const id = await approved()
    await waitState(id, '承認待ち')
    expect((await act(id, { type: 'delivery.change', targets: [{ kind: 'gdoc', folderId: 'libretto' }] })).status).toBe(
      200,
    )
    await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: await fingerprint(id) })
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    const v = await caseView(id)
    expect(v.formatReview?.failed).toEqual([])
    expect(v.formatReview?.passed).toBe(1)
    await send(id)
    await waitState(id, '完了')
    expect(ledger.listDeliveries(id).map((x) => x.target.kind)).toEqual(['gdoc', 'gdoc'])
  })

  it('T26b: 完了の後に Google ドキュメントにも保存すると、足した保存先だけを送る', async () => {
    const id = await toConfirm(['page'])
    await send(id)
    await waitState(id, '完了')
    expect((await act(id, { type: 'delivery.add', target: { kind: 'gdoc', folderId: 'libretto' } })).status).toBe(200)
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }))
    await send(id)
    await waitState(id, '完了')
    const sent = ledger.listDeliveries(id).filter((x) => x.status === '送付済')
    expect(sent.map((x) => x.target.kind)).toEqual(['page', 'gdoc'])
    expect(docs()).toHaveLength(1)
  })

  // --- 表とスライド（6.10 (4)）
  // 判定役・文章の節（section）を増やさないよう、表は最後の節の中に置く
  const TABLE = '\n| 地域 | 売上 |\n| --- | --- |\n| 東 | 120 |\n| 西 | 80 |\n'
  const TABLE_HTML =
    '<table><tr><th>地域</th><th>売上</th></tr><tr><td>東</td><td>120</td></tr><tr><td>西</td><td>80</td></tr></table>'
  const tableDraft: ScriptReply = {
    text: '書きました',
    write: {
      'draft-01.md': BODY + TABLE,
      'draft-01.html': renderHtml(BODY) + TABLE_HTML,
      'draft-01.done': 'done',
    },
  }
  const toSheet = () =>
    toConfirm(['gsheet'], [], (b) => (call) => (call.role === '作り手' ? tableDraftBackend(call) : answerYes(b)(call)))
  const tableDraftBackend: Backend = async (call) => {
    for (const [name, body] of Object.entries(tableDraft.write ?? {}))
      writeFileSync(join(call.workdir as string, name), body)
    return { text: tableDraft.text, costYen: 0, files: Object.keys(tableDraft.write ?? {}) }
  }
  const sheets = () => [...g.files.values()].filter((f) => f.mimeType === 'application/vnd.google-apps.spreadsheet')

  it('T24（表）: xlsx を Google スプレッドシートに変換付きで作り、書き出した xlsx のセルが本文の表と合えば保存済み', async () => {
    const id = await toSheet()
    const v = await caseView(id)
    expect(v.destinationChoices).toEqual(['gsheet']) // 表の依頼は表だけ（道具が無いので xlsx も出ない）
    expect(v.formatReview?.failed).toEqual([])
    expect(v.formatReview?.passed).toBe(2) // sheetsRoundTrip と xlsxNoFormulaErrors（式が無いので道具なしで通る）
    await send(id)
    await waitState(id, '完了')
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0]?.name).toBe('ブレストのまとめ（第 1 版）')
    const row = ledger.listDeliveries(id).at(-1)
    expect(row).toMatchObject({ status: '送付済', receiptId: `gsheet:${sheets()[0]?.id}` })
    expect(g.seen.some((x) => x.path.includes('export?mimeType=application%2Fvnd.openxmlformats'))).toBe(true)
  })

  it('T24b（表）: 書き出しのセルが食い違えば書き直しに戻し、食い違ったセルの数を作り手に返す', async () => {
    const id = await toSheet()
    g.state.exportBytes = () => xlsxOf(htmlTables(TABLE_HTML.replace('120', '999')))
    await send(id)
    await vi.waitFor(() => expect(ledger.listDeliveries(id).some((x) => x.status === '失敗')).toBe(true))
    expect(ledger.listCaseEvents(id).some((e) => e.type === 'transition' && e.event === 'delivery.mismatch')).toBe(true)
    const failed = ledger.listDeliveries(id).find((x) => x.status === '失敗')
    expect(failed?.reason).toContain('食い違ったセル 1')
    expect(failed?.link).toBeTruthy()
  })

  it('表とほかの保存先は混ぜられない（保存先を変える・足すも）', async () => {
    const id = await toSheet()
    await send(id)
    await waitState(id, '完了')
    expect((await act(id, { type: 'delivery.add', target: { kind: 'page', shared: false } })).status).toBe(409)
  })
})

describe('libretto のフォルダ（6.5 (3)）', () => {
  it('覚えた id を使い回し、ゴミ箱に入った・消された・共有された・別のアカウントなら libretto が作った共有されていないものを探すか作り直す。同時でも 1 つ', async () => {
    const g = await startFakeGoogle()
    try {
      const h = mkdtempSync(join(tmpdir(), 'libretto-folder-'))
      writeFileSync(
        join(h, 'google.json'),
        JSON.stringify({
          refreshToken: 'rt-1',
          email: 'me@example.com',
          scopes: [GMAIL_SCOPE, DRIVE_SCOPE],
          savedAt: 'x',
        }),
      )
      const gg = createGoogle({
        home: h,
        config: { clientId: 'c', clientSecret: 's' },
        redirectUri: 'http://127.0.0.1/oauth/google/callback',
        endpoints: g.endpoints,
      })
      const signal = new AbortController().signal
      const posts = () => g.seen.filter((x) => x.method === 'POST' && x.path.startsWith('/drive/v3/files')).length
      const a = await libFolder({ home: h, google: gg }, signal)
      expect(await libFolder({ home: h, google: gg }, signal)).toBe(a)
      expect(posts()).toBe(1)
      // ゴミ箱に入れた → 作り直す
      const f = g.files.get(a as string)
      if (f) f.trashed = true
      const b = await libFolder({ home: h, google: gg }, signal)
      expect(b).not.toBe(a)
      expect(posts()).toBe(2)
      // 消された（404）→ 印で探して見つかれば作らない
      g.files.set('folder-x', { ...(g.files.get(b as string) as DriveFile), id: 'folder-x' })
      g.files.delete(b as string)
      expect(await libFolder({ home: h, google: gg }, signal)).toBe('folder-x')
      expect(posts()).toBe(2)
      // 別のアカウントで覚えた id は使わない
      writeFileSync(join(h, 'drive-folder.json'), JSON.stringify({ account: 'other@example.com', id: 'zzz' }))
      expect(await libFolder({ home: h, google: gg }, signal)).toBe('folder-x')
      expect(g.seen.some((x) => x.path.startsWith('/drive/v3/files/zzz'))).toBe(false)
      // 本人が共有したフォルダは使わず、共有されていないものを新しく作る（あなただけで承認したものを共有の中に置かない）
      const x = g.files.get('folder-x')
      if (x) x.shared = true
      const c = await libFolder({ home: h, google: gg }, signal)
      expect(c).not.toBe('folder-x')
      expect(g.files.get(c as string)?.shared).toBeFalsy()
      // 同時に初めて呼んでもフォルダは 1 つ
      g.files.clear()
      const before = posts()
      const both = await Promise.all([
        libFolder({ home: h, google: gg }, signal),
        libFolder({ home: h, google: gg }, signal),
      ])
      expect(both[0]).toBe(both[1])
      expect(posts() - before).toBe(1)
    } finally {
      await g.close()
    }
  })
})

// 偽の soffice / pdftoppm は /bin/sh の起動口なので Windows では飛ばす
describe.skipIf(process.platform === 'win32')('手元のファイル（6.10 (4)）', () => {
  afterEach(() => {
    tools = undefined
  })

  it('pptx: 描き出して空白と見た目を判定し、保存したらその版をダウンロードできる。保存していない形式・版は 404', async () => {
    tools = fakeOffice()
    const dests = { ...intake, intake: { ...intake.intake, destinations: ['pptx', 'docx'] } }
    await setup(
      script(
        ['話し相手', say(dests)],
        ...upToEntrance.slice(1),
        ['作り手', draft(1)],
        ['判定役・文章', verdicts(true)],
      ),
      answerYes,
    )
    const id = await approved()
    await waitState(id, '承認待ち')
    await act(id, { type: 'approval.ok', marks: {}, versionFingerprint: (await caseView(id)).versions[0]?.fingerprint })
    await vi.waitFor(() => expect(ledger.getCase(id)).toMatchObject({ state: '送付確認待ち', turn: '本人' }), {
      timeout: 15_000,
    })
    const v = await caseView(id)
    expect(v.formatReview?.failed).toEqual([])
    expect(v.formatReview?.passed).toBe(4) // スライドの照合・空白・見た目（pptx と docx で 1 件）・文書の照合
    expect((await get(`/api/cases/${id}/files/1?format=pptx`)).status).toBe(404) // まだ保存していない
    await act(id, { type: 'delivery.send', planFingerprint: v.deliveryPlan.fingerprint })
    await waitState(id, '完了')
    const row = ledger.listDeliveries(id).findLast((x) => x.target.kind === 'file' && x.target.format === 'pptx')
    expect(row).toMatchObject({ status: '送付済', link: `/api/cases/${id}/files/1?format=pptx` })
    const res = await get(row?.link as string)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('presentationml')
    expect(res.headers.get('content-disposition')).toContain('.pptx')
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(0, 2)
        .toString(),
    ).toBe('PK')
    expect((await get(`/api/cases/${id}/files/1?format=xlsx`)).status).toBe(404)
    expect((await get(`/api/cases/${id}/files/2?format=pptx`)).status).toBe(404)
  }, 30_000)

  it('道具が無いのに描き出しが要る保存先なら、判定せずに道具の失敗で止める', async () => {
    const dests = { ...intake, intake: { ...intake.intake, destinations: ['pptx'] } }
    tools = fakeOffice()
    await setup(
      script(
        ['話し相手', say(dests)],
        ...upToEntrance.slice(1),
        ['作り手', draft(1)],
        ['判定役・文章', verdicts(true)],
      ),
      answerYes,
    )
    const id = await approved()
    await waitState(id, '承認待ち')
    // 承認の後に道具が使えなくなった（壊れた soffice）
    process.env.FAKE_OFFICE_FAIL = '1'
    try {
      await act(id, {
        type: 'approval.ok',
        marks: {},
        versionFingerprint: (await caseView(id)).versions[0]?.fingerprint,
      })
      await waitState(id, '停止')
      expect((await caseView(id)).stopReason).toBe('道具の失敗')
    } finally {
      delete process.env.FAKE_OFFICE_FAIL
    }
  }, 30_000)
})
