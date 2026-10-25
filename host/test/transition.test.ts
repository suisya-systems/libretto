import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryTarget } from '@libretto/shared/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CUT_LEAD,
  type Input,
  planFingerprint,
  type Result,
  renderDecisions,
  SAY,
  STEP,
  transition,
  writeDecisionsMd,
} from '../src/case/transition.ts'
import { openDb } from '../src/ledger/db.ts'
import { derivedEventId, Ledger } from '../src/ledger/ledger.ts'

let ledger: Ledger
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
beforeEach(() => {
  ledger = new Ledger(openDb(':memory:'), () => new Date('2026-10-23T03:00:00Z'))
})

const get = (caseId = 'c1') => ledger.getCase(caseId) ?? expect.unreachable()
const run = (ev: Record<string, unknown>) => transition(ledger, ev as Input)
// 本人の操作と内部イベント。expectedRevision は今の値（古い画面・古い仕事は明示して渡す）
const person = (type: string, rest: Record<string, unknown> = {}, caseId = 'c1') =>
  run({ type, caseId, by: '本人', eventId: id(), expectedRevision: get(caseId).revision, ...rest })
const host = (type: string, rest: Record<string, unknown> = {}, caseId = 'c1') =>
  run({ type, caseId, by: 'libretto', eventId: id(), expectedRevision: get(caseId).revision, ...rest })
const ok = (r: Result) => {
  expect(r).toMatchObject({ ok: true })
  return r
}
const events = (caseId = 'c1') => ledger.listCaseEvents(caseId)
const last = (caseId = 'c1') => events(caseId).at(-1)

const paste: DeliveryTarget = { kind: 'paste' }
const page: DeliveryTarget = { kind: 'page', shared: false }

// --- 案件を目的の状態まで進める道
function request(mode: '確認しながら' | 'おまかせ' = '確認しながら', destination = [paste], caseId = 'c1') {
  ok(run({ type: 'conversation.request', eventId: id(), caseId, title: '記事', mode, docType: '記事', destination }))
}
const drafted = () => ok(host('entrance.drafted', { setFingerprint: 'set1' }))
const approveEntrance = () => ok(person('entrance.approve', { answers: {}, mode: get().mode, setFingerprint: 'set1' }))
const ready = () => ok(host('materials.ready'))
const draft = () => ok(host('draft.done', { n: get().version + 1, versionFingerprint: `v${get().version + 1}` }))
const review = (pass: boolean) => ok(host(pass ? 'review.pass' : 'review.fail', { n: get().version }))
// 印は HTTP が今の版の判定から ctx で渡す（6.3.1 (9)）
const mark = (claimId: string) => ({ claimId, text: `主張 ${claimId}`, where: '冒頭の 1 段落目' })
const approveFinal = (marks: Record<string, '印のまま' | '削る'> = {}) =>
  ok(
    transition(
      ledger,
      {
        type: 'approval.ok',
        caseId: 'c1',
        by: '本人',
        eventId: id(),
        expectedRevision: get().revision,
        marks,
        versionFingerprint: get().versionFingerprint,
      } as Input,
      { marks: Object.keys(marks).map(mark) },
    ),
  )
const checked = () => ok(host('format.checked', { n: get().version, outputFingerprint: `o${get().version}` }))
const send = () => {
  const eventId = id()
  ok(
    run({
      type: 'delivery.send',
      caseId: 'c1',
      by: '本人',
      eventId,
      expectedRevision: get().revision,
      planFingerprint: planFingerprint(get()),
    }),
  )
  return eventId
}
const attempt = (type: string, attemptId: string, rest: Record<string, unknown> = {}) =>
  run({ type, caseId: 'c1', by: 'libretto', eventId: id(), attemptId, ...rest })

function toDrafting(mode: '確認しながら' | 'おまかせ' = '確認しながら', destination = [paste]) {
  request(mode, destination)
  drafted()
  approveEntrance()
  ready()
}
function toFinalApproval(destination = [paste]) {
  toDrafting('確認しながら', destination)
  draft()
  review(true)
}
function toConfirmSave(destination = [paste]) {
  toFinalApproval(destination)
  approveFinal()
  checked()
}
function toSending(destination = [paste]) {
  toConfirmSave(destination)
  return send()
}

// --- 候補
const candidate = (candidateId = 'gmail:t1', extra: Record<string, unknown> = {}) =>
  run({
    type: 'candidate.presented',
    candidate: {
      candidateId,
      source: 'gmail',
      origin: '合図',
      aiInstructionFlag: false,
      senderKey: 'a@example.com',
      ...extra,
    },
    card: {
      subject: '来週の記事',
      from: 'A',
      receivedAt: '2026-10-22',
      link: 'https://mail.example/t1',
      summary: '記事を書いてほしい',
      proposal: { docType: '記事', destination: [paste] },
    },
  })

describe('候補（4.6 (0)）', () => {
  it('T1 （無し） candidate.presented → 候補（案件は作らない）', () => {
    ok(candidate())
    expect(ledger.getCandidate('gmail:t1')).toMatchObject({ status: 'presented' })
    expect(ledger.getCandidateCard('gmail:t1')).toMatchObject({ subject: '来週の記事' })
    expect(ledger.listCandidateEvents('gmail:t1').map((e) => e.type)).toEqual(['found', 'presented'])
    expect(ledger.listCases()).toEqual([])
    // 重複は拒否ではなく、記録もしない
    expect(candidate()).toEqual({ ok: false, reason: 'invalid_transition' })
    expect(ledger.listCandidateEvents('gmail:t1')).toHaveLength(2)
  })

  it('T2 候補 candidate.proceed → 入口待ち（ここで案件を作る）。二度目は作った案件を返す', () => {
    candidate()
    const r = ok(run({ type: 'candidate.proceed', candidateId: 'gmail:t1', caseId: 'c1', mode: '確認しながら' }))
    expect(r).toMatchObject({
      replayed: false,
      case: { caseId: 'c1', state: '入口待ち', turn: 'libretto', revision: 0 },
    })
    expect(get()).toMatchObject({
      candidateId: 'gmail:t1',
      origin: { kind: '合図', source: 'gmail' },
      auto: false,
      title: '来週の記事',
    })
    expect(events()).toEqual([expect.objectContaining({ type: 'created', eventId: 'gmail:t1:candidate.proceed' })])
    expect(ledger.getCandidate('gmail:t1')).toMatchObject({ status: 'proceeded', caseId: 'c1' })
    const again = run({ type: 'candidate.proceed', candidateId: 'gmail:t1', caseId: 'c2', mode: '確認しながら' })
    expect(again).toMatchObject({ ok: true, replayed: true, case: { caseId: 'c1' } })
    expect(ledger.listCases()).toHaveLength(1)
  })

  it('T3 候補 candidate.dismiss → 見送り（カードを消し、拾わなくてよいなら除外）', () => {
    candidate()
    ok(run({ type: 'candidate.dismiss', candidateId: 'gmail:t1', reason: '拾わなくてよい' }))
    expect(ledger.getCandidate('gmail:t1')).toMatchObject({ status: 'dismissed' })
    expect(ledger.getCandidateCard('gmail:t1')).toBeUndefined()
    expect(ledger.listCases()).toEqual([])
    // 見送った候補への操作は rejected の行で残す
    expect(run({ type: 'candidate.proceed', candidateId: 'gmail:t1', caseId: 'c1', mode: 'おまかせ' })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
    expect(ledger.listCandidateEvents('gmail:t1').at(-1)).toMatchObject({
      type: 'rejected',
      event: 'candidate.proceed',
      status: 'dismissed',
    })
  })

  it('T3 「依頼ではない」が同じ差出人で 3 回目なら ask_suppress を返す', () => {
    const results = ['gmail:a', 'gmail:b', 'gmail:c'].map((cid) => {
      candidate(cid)
      return run({ type: 'candidate.dismiss', candidateId: cid, reason: '依頼ではない' })
    })
    expect(results[1]).not.toHaveProperty('askSuppress')
    expect(results[2]).toMatchObject({ askSuppress: { senderKey: 'a@example.com', count: 3 } })
  })

  it('T4 候補 candidate.auto_enter → 入口待ち（おまかせ・auto）。推測は合図に昇格させてから', () => {
    candidate('gmail:t1', { origin: '推測', confidence: '高' })
    const auto = (rest: Record<string, unknown>) =>
      run({ type: 'candidate.auto_enter', candidateId: 'gmail:t1', caseId: 'c1', entranceDefault: 'おまかせ', ...rest })
    expect(auto({})).toMatchObject({ ok: false, reason: 'invalid_transition' })
    ok(auto({ promote: 'gmail_label' }))
    expect(get()).toMatchObject({ state: '入口待ち', mode: 'おまかせ', auto: true, origin: { kind: '合図' } })
    expect(events()[0]).toMatchObject({ eventId: 'gmail:t1:candidate.auto_enter' })
    expect(ledger.listCandidateEvents('gmail:t1').map((e) => e.type)).toEqual([
      'found',
      'presented',
      'rejected',
      'promoted_to_signal',
      'auto_entered',
    ])
    expect(ledger.listConversation('c1')).toEqual(['自動で開始しました'])
  })

  it('T4 入口の既定が確認しながら・AI への指示の印があるときは自動で入れない', () => {
    candidate('gmail:a')
    candidate('gmail:b', { aiInstructionFlag: true })
    const auto = (cid: string, entranceDefault: string) =>
      run({ type: 'candidate.auto_enter', candidateId: cid, caseId: cid, entranceDefault })
    expect(auto('gmail:a', '確認しながら')).toMatchObject({ ok: false })
    expect(auto('gmail:b', 'おまかせ')).toMatchObject({ ok: false })
    expect(ledger.listCases()).toEqual([])
  })
})

describe('入口（T5〜T9）', () => {
  it('T5 （無し） conversation.request → 入口待ち（由来=会話）', () => {
    request()
    expect(get()).toMatchObject({ state: '入口待ち', turn: 'libretto', origin: { kind: '会話' }, revision: 0 })
  })

  it('T6 入口待ち entrance.drafted → 入口待ち（turn=本人、組の指紋）。auto なら turn=libretto のまま', () => {
    request()
    drafted()
    expect(get()).toMatchObject({ state: '入口待ち', turn: '本人', setFingerprint: 'set1', revision: 1 })
    candidate()
    ok(run({ type: 'candidate.auto_enter', candidateId: 'gmail:t1', caseId: 'c2', entranceDefault: 'おまかせ' }))
    ok(host('entrance.drafted', { setFingerprint: 's2' }, 'c2'))
    expect(get('c2')).toMatchObject({ turn: 'libretto', setFingerprint: 's2' })
  })

  it('T6b 入口待ち entrance.failed → 入口待ち（turn=本人）。前の組は残り、古い仕事のものは stale', () => {
    request()
    ok(host('entrance.failed'))
    expect(get()).toMatchObject({ state: '入口待ち', turn: '本人', step: STEP.entranceFailed, revision: 1 })
    expect(get().setFingerprint).toBeUndefined()
    // 本人は出し直せる。出し直しの後の失敗でも前の組は残る
    ok(person('entrance.revise', { note: '読者を社内に' }))
    expect(host('entrance.failed', { expectedRevision: 0 })).toMatchObject({ ok: false, reason: 'stale' })
    ok(host('entrance.drafted', { setFingerprint: 'set1' }))
    ok(person('entrance.revise', { note: 'もう一度' }))
    ok(host('entrance.failed'))
    expect(get()).toMatchObject({ turn: '本人', setFingerprint: 'set1' })
    // turn=本人 のときは受けない
    expect(host('entrance.failed')).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T7 入口待ち entrance.revise → 入口待ち（turn=libretto）。古い entrance.drafted は stale', () => {
    request()
    const startedAt = get().revision
    drafted()
    ok(person('entrance.revise', { note: '読み手を部長に' }))
    expect(get()).toMatchObject({ state: '入口待ち', turn: 'libretto' })
    expect(ledger.listDecisions('c1')).toEqual([expect.objectContaining({ gate: '入口', text: '読み手を部長に' })])
    // 出し直しの前に起こした仕事の結果（4.6 (2)）
    const old = run({
      type: 'entrance.drafted',
      caseId: 'c1',
      by: 'libretto',
      eventId: id(),
      expectedRevision: startedAt,
      setFingerprint: 'x',
    })
    expect(old).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('T7b 下書き中 entrance.revise（自動で入った案件）→ 入口待ち、新しい系列、入口の承認を無効に', () => {
    candidate()
    ok(run({ type: 'candidate.auto_enter', candidateId: 'gmail:t1', caseId: 'c1', entranceDefault: 'おまかせ' }))
    drafted()
    ok(
      run({
        type: 'entrance.approve',
        caseId: 'c1',
        by: '自動',
        eventId: id(),
        expectedRevision: get().revision,
        setFingerprint: 'set1',
        answers: { u1: '任せる' },
      }),
    )
    ready()
    ok(person('entrance.revise', { note: 'やっぱり短く' }))
    expect(get()).toMatchObject({ state: '入口待ち', turn: 'libretto', series: 2, round: 0 })
    expect(ledger.listApprovals('c1')).toEqual([
      expect.objectContaining({ gate: '入口', by: '自動', supersededBy: last()?.eventId }),
    ])
  })

  it('T7b 自動で入っていない案件の下書き中には効かない', () => {
    toDrafting()
    expect(person('entrance.revise', { note: 'x' })).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T8 入口待ち entrance.approve → 材料待ち（承認と答えと mode を同じトランザクションで）', () => {
    request()
    drafted()
    ok(person('entrance.approve', { answers: { u1: 'a', u2: '任せる' }, mode: 'おまかせ', setFingerprint: 'set1' }))
    expect(get()).toMatchObject({ state: '材料待ち', turn: 'libretto', mode: 'おまかせ' })
    expect(ledger.listApprovals('c1')).toEqual([
      expect.objectContaining({ gate: '入口', by: '本人', setFingerprint: 'set1' }),
    ])
    expect(ledger.listDecisions('c1')[0]).toMatchObject({ gate: '入口', text: 'u1: a\nu2: 任せる' })
  })

  it('T8 組の指紋が今の組と違えば stale。添付が未着なら turn=本人', () => {
    request()
    drafted()
    expect(person('entrance.approve', { answers: {}, mode: '確認しながら', setFingerprint: 'old' })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    const r = transition(
      ledger,
      {
        type: 'entrance.approve',
        caseId: 'c1',
        by: '本人',
        eventId: id(),
        expectedRevision: get().revision,
        answers: {},
        mode: '確認しながら',
        setFingerprint: 'set1',
      },
      { materialsPending: true },
    )
    expect(r).toMatchObject({ ok: true, case: { state: '材料待ち', turn: '本人' } })
  })

  it('T8 おまかせはホストが by=自動 で出す（auto の案件だけ）', () => {
    request()
    drafted()
    const auto = run({
      type: 'entrance.approve',
      caseId: 'c1',
      by: '自動',
      eventId: id(),
      expectedRevision: get().revision,
      setFingerprint: 'set1',
      answers: {},
    })
    expect(auto).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T9 入口待ち cancel → 取り消し', () => {
    request()
    ok(person('cancel'))
    expect(get()).toMatchObject({ state: '取り消し', turn: '本人' })
  })
})

describe('材料と下書き（T10〜T14）', () => {
  it('T10 材料待ち materials.provided → 材料待ち（turn=libretto）', () => {
    request()
    drafted()
    transition(
      ledger,
      {
        type: 'entrance.approve',
        caseId: 'c1',
        by: '本人',
        eventId: id(),
        expectedRevision: get().revision,
        answers: {},
        mode: '確認しながら',
        setFingerprint: 'set1',
      },
      { materialsPending: true },
    )
    expect(get()).toMatchObject({ state: '材料待ち', turn: '本人', step: STEP.waitMaterials })
    // 本人の操作なので revision を確かめる（6.2.4 (3)）
    const provided = (expectedRevision: number) =>
      run({ type: 'materials.provided', caseId: 'c1', by: '本人', eventId: id(), expectedRevision })
    expect(provided(get().revision - 1)).toMatchObject({ ok: false, reason: 'stale' })
    ok(provided(get().revision))
    expect(get()).toMatchObject({ state: '材料待ち', turn: 'libretto', step: STEP.materials })
    // turn=libretto の間は受けない
    expect(provided(get().revision)).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T11 材料待ち materials.ready → 下書き中', () => {
    toDrafting()
    expect(get()).toMatchObject({ state: '下書き中', turn: 'libretto' })
  })

  it('T12 下書き中 draft.done(n) → 検品中（版と本文の指紋）。版の番号が飛べば stale', () => {
    toDrafting()
    expect(host('draft.done', { n: 2, versionFingerprint: 'v2' })).toMatchObject({ ok: false, reason: 'stale' })
    draft()
    expect(get()).toMatchObject({ state: '検品中', version: 1, versionFingerprint: 'v1' })
    expect(last()).toMatchObject({ type: 'transition', version: 1, versionFingerprint: 'v1' })
  })

  it('T13 下書き中 outline.done → 承認待ち（kind=構成案）。おまかせでは出さない', () => {
    toDrafting()
    ok(host('outline.done', { outlineFingerprint: 'ol1' }))
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '構成案', outlineFingerprint: 'ol1', turn: '本人' })
  })

  it('T13 おまかせ・構成案ゲートが済んだ案件では outline.done を拒む', () => {
    toDrafting('おまかせ')
    expect(host('outline.done', { outlineFingerprint: 'ol1' })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
  })

  it('T14 承認待ち（構成案）outline.approve → 下書き中（構成案の承認を記録。2 回目のゲートは無い）', () => {
    toDrafting()
    ok(host('outline.done', { outlineFingerprint: 'ol1' }))
    expect(person('outline.approve', { outlineFingerprint: 'old' })).toMatchObject({ ok: false, reason: 'stale' })
    ok(person('outline.approve', { outlineFingerprint: 'ol1', note: '2 と 3 を入れ替えて' }))
    expect(get()).toMatchObject({ state: '下書き中' })
    expect(get()).not.toHaveProperty('approvalKind')
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ gate: '構成案', versionFingerprint: 'ol1' })
    expect(ledger.listDecisions('c1').at(-1)).toMatchObject({ gate: '構成案', text: '2 と 3 を入れ替えて' })
    expect(host('outline.done', { outlineFingerprint: 'ol2' })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
  })
})

describe('検品と承認（T15〜T19）', () => {
  it('T15 検品中 review.pass（確認しながら）→ 承認待ち（kind=完成稿）', () => {
    toFinalApproval()
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '完成稿', round: 1, turn: '本人' })
  })

  it('T15 検品中 review.pass（おまかせ）→ 送付確認待ち', () => {
    toDrafting('おまかせ')
    draft()
    review(true)
    expect(get()).toMatchObject({ state: '送付確認待ち', turn: 'libretto' })
  })

  it('T16 検品中 review.fail 往復<3 → 下書き中（往復を数える）', () => {
    toDrafting()
    draft()
    review(false)
    expect(get()).toMatchObject({ state: '下書き中', round: 1 })
    expect(host('review.fail', { n: 1 })).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T17 検品中 review.fail 3 回目（確認しながら）→ 承認待ち（kind=完成稿）', () => {
    toDrafting()
    for (const _ of [1, 2]) {
      draft()
      review(false)
    }
    draft()
    review(false)
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '完成稿', round: 3 })
  })

  it('T17 検品中 review.fail 3 回目（おまかせ）→ 停止（往復上限）', () => {
    toDrafting('おまかせ')
    for (const _ of [1, 2, 3]) {
      draft()
      review(false)
    }
    expect(get()).toMatchObject({ state: '停止', stopReason: '往復上限', round: 3 })
    expect(ledger.listConversation('c1')).toHaveLength(1)
  })

  it('T17 検品中 review.fail 2 回目 escalate=直らない（確認しながら）→ 3 回目を待たずに承認待ち', () => {
    toDrafting()
    draft()
    review(false)
    draft()
    ok(host('review.fail', { n: 2, escalate: '直らない' }))
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '完成稿', round: 2 })
    expect(get()).not.toHaveProperty('stopReason')
  })

  it('T17 検品中 review.fail escalate（おまかせ）→ 停止（reason は escalate の値）', () => {
    toDrafting('おまかせ')
    draft()
    ok(host('review.fail', { n: 1, escalate: '判定できない' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '判定できない', round: 1 })
    expect(ledger.listConversation('c1')).toEqual([SAY.unjudgeable])
  })

  it('T18 承認待ち（完成稿）approval.ok → 送付確認待ち（本文の指紋・届け先の指紋・印を記録）', () => {
    toFinalApproval()
    expect(person('approval.ok', { marks: {}, versionFingerprint: 'old' })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    approveFinal({ k1: '印のまま' })
    expect(get()).toMatchObject({ state: '送付確認待ち', turn: 'libretto' })
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({
      gate: '完成稿',
      version: 1,
      versionFingerprint: 'v1',
      marks: { k1: '印のまま' },
    })
    expect(ledger.listApprovals('c1').at(-1)?.planFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('T18 「削る」が 1 つでもあれば T19 として新しい系列で直す', () => {
    toFinalApproval()
    approveFinal({ k1: '印のまま', k2: '削る' })
    expect(get()).toMatchObject({ state: '下書き中', series: 2, round: 0 })
    expect(ledger.listApprovals('c1').filter((a) => a.gate === '完成稿')).toEqual([])
    expect(ledger.listDecisions('c1').at(-1)).toMatchObject({
      gate: '完成稿',
      text: `${CUT_LEAD}\n- 「主張 k2」（冒頭の 1 段落目）`,
    })
  })

  it('T18 印の答えが今の版の印の全部でなければ stale（別の版の画面からの送信。6.3.1 (9)）', () => {
    toFinalApproval()
    const send = (marks: Record<string, string>, ctx: string[]) =>
      transition(
        ledger,
        {
          type: 'approval.ok',
          caseId: 'c1',
          by: '本人',
          eventId: id(),
          expectedRevision: get().revision,
          marks,
          versionFingerprint: get().versionFingerprint,
        } as Input,
        { marks: ctx.map(mark) },
      )
    expect(send({}, ['M01'])).toMatchObject({ ok: false, reason: 'stale' })
    expect(send({ M01: '印のまま', M02: '削る' }, ['M01'])).toMatchObject({ ok: false, reason: 'stale' })
    expect(send({ M02: '印のまま' }, ['M01'])).toMatchObject({ ok: false, reason: 'stale' })
    expect(get().state).toBe('承認待ち')
    ok(send({ M01: '印のまま' }, ['M01']))
  })

  it('T19 承認待ち（完成稿）approval.redo → 下書き中（新しい系列、往復 0、指示は全文）', () => {
    toFinalApproval()
    ok(person('approval.redo', { instruction: '冒頭をもっと短く' }))
    expect(get()).toMatchObject({ state: '下書き中', series: 2, round: 0 })
    expect(ledger.listDecisions('c1').at(-1)).toMatchObject({ text: '冒頭をもっと短く' })
  })
})

describe('仕立てと送付（T20〜T26c）', () => {
  it('T20 送付確認待ち format.checked → 送付確認待ち（turn=本人、送付成果物の指紋、往復を数える）', () => {
    toConfirmSave()
    expect(get()).toMatchObject({ state: '送付確認待ち', turn: '本人', outputFingerprint: 'o1', round: 2 })
  })

  it('T21 送付確認待ち format.failed 往復<3 → 下書き中（完成稿の承認を無効に）', () => {
    toFinalApproval()
    approveFinal()
    ok(host('format.failed', { n: 1 }))
    expect(get()).toMatchObject({ state: '下書き中', round: 2 })
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ gate: '完成稿', supersededBy: last()?.eventId })
  })

  it('T21b 送付確認待ち format.failed 3 回目（本文 2 回＋形式 1 回）→ 承認待ち', () => {
    toDrafting()
    draft()
    review(false)
    draft()
    review(true)
    approveFinal()
    ok(host('format.failed', { n: 2 }))
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '完成稿', round: 3 })
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ gate: '完成稿', supersededBy: last()?.eventId })
  })

  it('T21b 送付確認待ち format.failed escalate（おまかせ）→ 往復<3 でも停止', () => {
    toDrafting('おまかせ')
    draft()
    review(true)
    ok(host('format.failed', { n: 1, escalate: '判定できない' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '判定できない', round: 2 })
  })

  it('T22 送付確認待ち delivery.send → 送付中（送付の承認と、届け先ごとの attempt）', () => {
    toConfirmSave([paste, page])
    expect(person('delivery.send', { planFingerprint: 'old' })).toMatchObject({ ok: false, reason: 'stale' })
    const sendId = send()
    expect(get()).toMatchObject({ state: '送付中', turn: 'libretto' })
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ gate: '送付', eventId: sendId, by: '本人' })
    expect(ledger.listDeliveries('c1')).toEqual([
      expect.objectContaining({ attemptId: `${sendId}:0`, target: paste, status: '送付中', version: 1 }),
      expect.objectContaining({ attemptId: `${sendId}:1`, target: page, status: '送付中', visibility: 'あなただけ' }),
    ])
  })

  it('T22 形式の判定の前（送付成果物の指紋が無い）は送れない', () => {
    toFinalApproval()
    approveFinal()
    expect(person('delivery.send', { planFingerprint: planFingerprint(get()) })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
  })

  it('T22 おまかせの自動発火は、他人に見える届け先・他人の発言の引用があれば止まる', () => {
    toDrafting('おまかせ', [{ kind: 'page', shared: true }])
    draft()
    review(true)
    checked()
    const auto = (quotesOthers: boolean) =>
      run({
        type: 'delivery.send',
        caseId: 'c1',
        by: '自動',
        eventId: id(),
        expectedRevision: get().revision,
        planFingerprint: planFingerprint(get()),
        quotesOthers,
      })
    expect(auto(false)).toMatchObject({ ok: false, reason: 'invalid_transition' })
    expect(get()).toMatchObject({ state: '送付確認待ち', turn: '本人' })
  })

  it('T22 おまかせで自分だけの届け先・引用なしなら自動で送る', () => {
    toDrafting('おまかせ')
    draft()
    review(true)
    checked()
    const auto = (quotesOthers: boolean) =>
      run({
        type: 'delivery.send',
        caseId: 'c1',
        by: '自動',
        eventId: id(),
        expectedRevision: get().revision,
        planFingerprint: planFingerprint(get()),
        quotesOthers,
      })
    expect(auto(true)).toMatchObject({ ok: false })
    ok(auto(false))
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ gate: '送付', by: '自動' })
  })

  it('T23 送付確認待ち delivery.decline → 承認待ち（完成稿の承認は残る）', () => {
    toConfirmSave()
    ok(person('delivery.decline'))
    expect(get()).toMatchObject({ state: '承認待ち', approvalKind: '完成稿' })
    expect(ledger.listApprovals('c1').at(-1)).not.toHaveProperty('supersededBy')
  })

  it('T23b 承認待ち delivery.change → 承認待ち（届け先を書き換え、完成稿の承認を無効に）', () => {
    toConfirmSave()
    ok(person('delivery.decline'))
    ok(person('delivery.change', { targets: [page] }))
    expect(get()).toMatchObject({ state: '承認待ち', destination: [page] })
    expect(get()).not.toHaveProperty('outputFingerprint')
    expect(last()).toMatchObject({ destination: [page] })
    expect(ledger.listApprovals('c1').at(-1)).toMatchObject({ supersededBy: last()?.eventId })
  })

  it('T22 一覧に同じ届け先が 2 回あっても attempt は 1 つ', () => {
    toConfirmSave([paste, paste, page])
    const sendId = send()
    expect(
      ledger
        .listDeliveries('c1')
        .filter((d) => d.eventId === sendId)
        .map((d) => d.target),
    ).toEqual([paste, page])
  })

  it('T24 送付中 delivery.done → 一部なら送付中、今の送付回が全部送付済なら完了', () => {
    const sendId = toSending([paste, page])
    ok(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0' }))
    expect(get()).toMatchObject({ state: '送付中' })
    // 済んだ attempt への二度目の通知は stale
    expect(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0' })).toMatchObject({ ok: false, reason: 'stale' })
    ok(attempt('delivery.done', `${sendId}:1`, { receiptId: 'r1', link: 'https://page' }))
    expect(get()).toMatchObject({ state: '完了' })
    expect(ledger.listDecisions('c1').at(-1)).toMatchObject({ gate: '送付' })
    // 一部・完了のどちらの行にも保存した届け先 1 つを残し、案件の届け先一覧は変えない（#21）
    const done = ledger.listCaseEvents('c1').filter((e) => e.type === 'transition' && e.event === 'delivery.done')
    expect(done.map((e) => e.type === 'transition' && e.target)).toEqual([paste, page])
    expect(get().destination).toEqual([paste, page])
  })

  it('T24b 送付中 delivery.mismatch → 下書き中（失敗の行、完成稿と送付の承認を無効に）。古い送付回の通知は stale', () => {
    const sendId = toSending([paste, page])
    ok(attempt('delivery.mismatch', `${sendId}:0`, { link: 'https://docs/x' }))
    expect(get()).toMatchObject({ state: '下書き中' })
    expect(ledger.listDeliveries('c1').at(-1)).toMatchObject({ status: '失敗', link: 'https://docs/x' })
    expect(
      ledger
        .listApprovals('c1')
        .filter((a) => !a.supersededBy)
        .map((a) => a.gate),
    ).toEqual(['入口'])
    // 直した版を送り直す。前の送付回の遅れた通知は今の送付回のものではない
    draft()
    review(true)
    approveFinal()
    checked()
    const second = send()
    expect(ledger.listDeliveries('c1').filter((d) => d.eventId === second)).toHaveLength(2)
    expect(attempt('delivery.done', `${sendId}:1`, { receiptId: 'late' })).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('T25 送付中 delivery.unknown → 送付中（不明）。見つかれば T24', () => {
    const sendId = toSending()
    ok(attempt('delivery.unknown', `${sendId}:0`))
    expect(ledger.listDeliveries('c1').at(-1)).toMatchObject({ status: '不明' })
    ok(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0' }))
    expect(get()).toMatchObject({ state: '完了' })
  })

  it('T26 送付中 delivery.failed → 停止（送付失敗）', () => {
    const sendId = toSending()
    ok(attempt('delivery.failed', `${sendId}:0`, { reason: '届け先が拒否' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '送付失敗' })
    expect(ledger.listDeliveries('c1').at(-1)).toMatchObject({ status: '失敗', reason: '届け先が拒否' })
    expect(ledger.listConversation('c1')).toHaveLength(1)
  })

  it('T26b 完了 delivery.add → 送付確認待ち。次の送付は足した届け先だけ', () => {
    const sendId = toSending()
    ok(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0' }))
    expect(person('delivery.add', { target: paste })).toMatchObject({ ok: false, reason: 'invalid_transition' })
    ok(person('delivery.add', { target: page }))
    expect(get()).toMatchObject({ state: '送付確認待ち', turn: 'libretto', destination: [paste, page] })
    checked()
    const second = send()
    expect(ledger.listDeliveries('c1').filter((d) => d.eventId === second)).toEqual([
      expect.objectContaining({ target: page, attemptId: `${second}:0` }),
    ])
    ok(attempt('delivery.done', `${second}:0`, { receiptId: 'r1' }))
    expect(get()).toMatchObject({ state: '完了' })
  })

  it('T26c 完了 share.revoke → 完了（取り消しの行）', () => {
    const sendId = toSending([{ kind: 'page', shared: true }])
    ok(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0', shareToken: 'tok' }))
    expect(person('share.revoke', { shareToken: 'nope' })).toMatchObject({ ok: false, reason: 'invalid_transition' })
    ok(person('share.revoke', { shareToken: 'tok' }))
    expect(get()).toMatchObject({ state: '完了' })
    expect(ledger.listDeliveries('c1').at(-1)).toMatchObject({ status: '取り消し', shareToken: 'tok' })
    // 届け先を足しても、取り消した共有は送り直さない
    ok(person('delivery.add', { target: paste }))
    checked()
    const second = send()
    expect(ledger.listDeliveries('c1').filter((d) => d.eventId === second)).toEqual([
      expect.objectContaining({ target: paste }),
    ])
  })
})

describe('止める・取り消す・出し直す（T27〜T31）', () => {
  it('T27 下書き中 stop.case → 停止', () => {
    toDrafting()
    ok(person('stop.case', { reason: '急ぎではなくなった' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '急ぎではなくなった', turn: '本人' })
  })

  it('T27 送付中の stop.case は拒む', () => {
    toSending()
    expect(person('stop.case')).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T27b 送付中 fail.system → 停止（道具の失敗）', () => {
    toSending()
    ok(host('fail.system', { reason: '描き出しの道具の失敗' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '描き出しの道具の失敗' })
    expect(ledger.listConversation('c1')).toHaveLength(1)
  })

  it('T27b 送付の仕事の fail.system は attempt で確かめる（他の届け先の通知で revision が進んでも効く）', () => {
    const sendId = toSending([paste, page])
    ok(attempt('delivery.done', `${sendId}:0`, { receiptId: 'r0' }))
    expect(attempt('fail.system', `${sendId}:0`, { reason: 'x' })).toMatchObject({ ok: false, reason: 'stale' })
    ok(attempt('fail.system', `${sendId}:1`, { reason: '隔離の失敗' }))
    expect(get()).toMatchObject({ state: '停止', stopReason: '隔離の失敗' })
  })

  it('T28 stop.all → 非終端の全案件を停止（終端は触らない）', () => {
    request('確認しながら', [paste], 'c1')
    request('確認しながら', [paste], 'c2')
    request('確認しながら', [paste], 'c3')
    ok(person('cancel', {}, 'c3'))
    const r = transition(ledger, { type: 'stop.all' })
    expect(r).toMatchObject({ ok: true, stopped: expect.arrayContaining(['c1', 'c2']) })
    expect(get('c1')).toMatchObject({ state: '停止', stopReason: '緊急停止' })
    expect(get('c3')).toMatchObject({ state: '取り消し' })
    expect(last('c2')).toMatchObject({ event: 'stop.all', by: '停止' })
  })

  it('T29 検品中 cost.cap → 停止（費用上限）。同じ呼び出しの二度目は 1 回に畳む', () => {
    toDrafting()
    draft()
    const ev = {
      type: 'cost.cap',
      caseId: 'c1',
      by: '費用',
      eventId: 'c1:cost.cap:call1',
      scope: '呼び出し',
      callId: 'call1',
    }
    ok(run(ev))
    expect(get()).toMatchObject({ state: '停止', stopReason: '費用上限' })
    expect(run(ev)).toMatchObject({ ok: true, replayed: true })
    // 停止の後に別の呼び出しから届いた cost.cap は表に無い組
    expect(run({ ...ev, eventId: 'c1:cost.cap:call2', callId: 'call2' })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
  })

  it('T29 送付中の cost.cap は拒む', () => {
    toSending()
    const r = run({ type: 'cost.cap', caseId: 'c1', by: '費用', eventId: 'c1:cost.cap:x', scope: '案件', callId: 'x' })
    expect(r).toMatchObject({ ok: false, reason: 'invalid_transition' })
  })

  it('T30 下書き中 cancel → 取り消し', () => {
    toDrafting()
    ok(person('cancel'))
    expect(get()).toMatchObject({ state: '取り消し' })
  })

  it('T31 停止 restart_as_new → 元は停止のまま revision を進め、新しい案件が入口待ち', () => {
    toDrafting()
    ok(person('stop.case'))
    const before = get().revision
    const eventId = id()
    const r = run({ type: 'restart_as_new', caseId: 'c1', by: '本人', eventId, expectedRevision: before })
    expect(r).toMatchObject({ ok: true, case: { state: '停止', revision: before + 1 } })
    const newCaseId = (r as { newCaseId: string }).newCaseId
    expect(get(newCaseId)).toMatchObject({ state: '入口待ち', title: '記事', revision: 0 })
    expect(events(newCaseId)[0]).toMatchObject({
      type: 'created',
      eventId: derivedEventId(eventId, 'created'),
      parentCaseId: 'c1',
    })
    // 再送は同じ新しい案件を返し、同じ画面からの 2 回目は stale
    expect(run({ type: 'restart_as_new', caseId: 'c1', by: '本人', eventId, expectedRevision: before })).toMatchObject({
      replayed: true,
      newCaseId,
    })
    expect(
      run({ type: 'restart_as_new', caseId: 'c1', by: '本人', eventId: id(), expectedRevision: before }),
    ).toMatchObject({ ok: false, reason: 'stale' })
    expect(ledger.listCases()).toHaveLength(2)
  })
})

describe('拒否・再送・巻き戻し', () => {
  it('表に無い組は rejected の行だけを残し、案件は変わらない', () => {
    toFinalApproval()
    const before = get()
    expect(host('draft.done', { n: 2, versionFingerprint: 'v2' })).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
    expect(get()).toEqual(before)
    expect(last()).toMatchObject({
      type: 'rejected',
      state: '承認待ち',
      event: 'draft.done',
      reason: 'invalid_transition',
    })
  })

  it('expectedRevision が古ければ stale を記録する。止まった案件は invalid_transition（stale より先）', () => {
    toDrafting()
    const stale = run({ type: 'stop.case', caseId: 'c1', by: '本人', eventId: id(), expectedRevision: 0 })
    expect(stale).toMatchObject({ ok: false, reason: 'stale', case: { state: '下書き中' } })
    ok(person('stop.case'))
    expect(run({ type: 'stop.case', caseId: 'c1', by: '本人', eventId: id(), expectedRevision: 0 })).toMatchObject({
      reason: 'invalid_transition',
    })
  })

  it('同じ eventId の再送は 1 回目と同じ結果（遷移は replayed、拒否は同じ理由）', () => {
    toFinalApproval()
    const ev = {
      type: 'approval.redo',
      caseId: 'c1',
      by: '本人',
      eventId: id(),
      expectedRevision: get().revision,
      instruction: 'x',
    }
    ok(run(ev))
    const rev = get().revision
    expect(run(ev)).toMatchObject({ ok: true, replayed: true, case: { revision: rev } })
    const bad = { ...ev, eventId: id(), type: 'cancel', expectedRevision: 0 }
    expect(run(bad)).toMatchObject({ ok: false, reason: 'stale' })
    expect(run(bad)).toMatchObject({ ok: false, reason: 'stale' })
    expect(events().filter((e) => e.type === 'rejected')).toHaveLength(1)
    expect(ledger.listDecisions('c1')).toHaveLength(1)
  })

  it('同じ eventId が別の案件・別の type にあれば conflict', () => {
    request('確認しながら', [paste], 'c1')
    request('確認しながら', [paste], 'c2')
    const eventId = id()
    ok(run({ type: 'cancel', caseId: 'c1', by: '本人', eventId, expectedRevision: 0 }))
    expect(run({ type: 'cancel', caseId: 'c2', by: '本人', eventId, expectedRevision: 0 })).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(run({ type: 'stop.case', caseId: 'c1', by: '本人', eventId, expectedRevision: 0 })).toEqual({
      ok: false,
      reason: 'conflict',
    })
    const req = {
      type: 'conversation.request',
      eventId: id(),
      caseId: 'c3',
      title: 't',
      mode: 'おまかせ',
      docType: 'メモ',
      destination: [paste],
    }
    ok(run(req))
    expect(run(req)).toMatchObject({ ok: true, replayed: true })
    expect(run({ ...req, caseId: 'c4' })).toEqual({ ok: false, reason: 'conflict' })
    expect(get('c2')).toMatchObject({ state: '入口待ち' })
  })

  it('案件が無ければ not_found（何も書かない）', () => {
    expect(run({ type: 'cancel', caseId: 'nope', by: '本人', eventId: id(), expectedRevision: 0 })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('付随の行が途中で失敗したら、遷移も含めて全部巻き戻る（T8）', () => {
    request()
    drafted()
    const before = get()
    const count = events().length
    vi.spyOn(ledger, 'appendDecision').mockImplementation(() => {
      throw new Error('disk')
    })
    expect(() =>
      person('entrance.approve', { answers: { u1: 'a' }, mode: 'おまかせ', setFingerprint: 'set1' }),
    ).toThrow('disk')
    expect(get()).toEqual(before)
    expect(events()).toHaveLength(count)
    expect(ledger.listApprovals('c1')).toEqual([])
  })

  it('T31 の 2 案件は原子的（新しい案件が作れなければ元の案件も進まない）', () => {
    toDrafting()
    ok(person('stop.case'))
    const before = get()
    vi.spyOn(ledger, 'insertCase').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => person('restart_as_new')).toThrow('boom')
    expect(get()).toEqual(before)
    expect(ledger.listCases()).toHaveLength(1)
  })

  it('出来事を順にたどった指紋と往復の値は、今の案件の行と一致する（9.1）', () => {
    toConfirmSave()
    const t = events().filter((e) => e.type === 'transition')
    const lastOf = <K extends string>(k: K) =>
      t
        .map((e) => (e as Record<string, unknown>)[k])
        .filter((v) => v !== undefined)
        .at(-1)
    expect(lastOf('versionFingerprint')).toBe(get().versionFingerprint)
    expect(lastOf('outputFingerprint')).toBe(get().outputFingerprint)
    expect(lastOf('round')).toBe(get().round)
    expect(t).toHaveLength(get().revision)
  })
})

describe('decisions.md の描き出し', () => {
  it('decisions の表から作り直す', () => {
    toFinalApproval()
    ok(person('approval.redo', { instruction: '冒頭を短く' }))
    const dir = mkdtempSync(join(tmpdir(), 'libretto-'))
    writeDecisionsMd(dir, ledger, 'c1')
    const md = readFileSync(join(dir, 'decisions.md'), 'utf-8')
    expect(md).toBe(renderDecisions(ledger.listDecisions('c1')))
    expect(md).toContain('## 2026-10-23T12:00:00.000+09:00 完成稿\n\n冒頭を短く\n')
  })
})
