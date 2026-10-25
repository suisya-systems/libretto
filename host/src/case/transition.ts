// 状態機械（docs/implementation.md 4.2・4.6）。遷移はここだけが行い、1 遷移 1 トランザクション（4.1）。
// ファイルの読み書き・仕事の起動・セッションの終了・STOP は呼ぶ側（runner と HTTP）が行う
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Answer, CaseAction, CaseState, DeliveryTarget, Mode, Origin } from '@libretto/shared/api'
import type { Escalate, Mark } from '@libretto/shared/checks'
import type {
  ApprovalRecord,
  CandidateRecord,
  CaseRecord,
  DecisionRecord,
  DeliveryRecord,
} from '@libretto/shared/ledger'
import {
  type CardContent,
  derivedEventId,
  type Ledger,
  type NewCandidate,
  type NewCase,
  type TransitionInput,
} from '../ledger/ledger.ts'
import type { CostCapNotice } from '../model/invoke.ts'

export const MAX_ROUNDS = 3
// 「削る」の作り手への指示の頭（6.3.1 (9)）
export const CUT_LEAD = '次の主張を削ってください。文ごと削るか、出典を示せる言い方に直してください:'

// 本人に見える 1 行。ui-wording.md の「画面での言葉」で書く（4.1）
export const STEP = {
  drafting: '依頼書とチェック項目を書いています',
  entranceFailed: '依頼書とチェック項目を整えられませんでした',
  entrance: '依頼内容を確認してください',
  autoEntrance: '自動で進めています',
  materials: '資料を集めています',
  waitMaterials: '資料を貼り付けてください',
  writing: '下書きを書いています',
  checking: 'チェックしています',
  outline: '構成案を確認してください',
  final: '最終版を確認してください',
  tailoring: '保存先の形に整えています',
  confirmSave: '保存先を確認してください',
  saving: '保存しています',
  done: '完了しました',
  stopped: '中止しました',
  cancelled: '取り消しました',
} as const
export const SAY = {
  autoStarted: '自動で開始しました',
  roundLimit: '修正の往復が 3 回に達したので中止しました',
  stuck: '同じ項目が 2 回続けて直らなかったので中止しました',
  unjudgeable: '残った項目を AI では確かめられないので中止しました',
  saveFailed: '保存できなかったので中止しました',
  toolFailed: '動作環境の不具合で中止しました',
  costCap: '費用の上限に達したので中止しました',
  isolationLeaked: 'ライターにチェック項目が見えたおそれがあるので中止しました',
} as const

const LIMIT_SAY = { 往復上限: SAY.roundLimit, 直らない: SAY.stuck, 判定できない: SAY.unjudgeable } as const

// 非終端で、仕事が動きうる状態（T27・T29・T30）。T27b・T28 はこれに送付中を足す
const ACTIVE: readonly CaseState[] = ['入口待ち', '材料待ち', '下書き中', '検品中', '承認待ち', '送付確認待ち']
const STOPPABLE: readonly CaseState[] = [...ACTIVE, '送付中']

// --- 入力

type Person = CaseAction & { caseId: string; by: '本人' }
// 内部イベントの expectedRevision は、その仕事を起こしたときの案件の revision（4.6 (2)）
type Job = { eventId: string; caseId: string; expectedRevision: number; by: 'libretto' }
type Attempt = { eventId: string; caseId: string; by: 'libretto'; attemptId: string }
export type HostEvent =
  | (Job & { type: 'entrance.drafted'; setFingerprint: string })
  | (Job & { type: 'entrance.failed' })
  | (Omit<Job, 'by'> & {
      by: '自動'
      type: 'entrance.approve'
      setFingerprint: string
      answers: Record<string, Answer>
    })
  // 本人が資料を渡す（POST /api/cases/:id/materials）。CaseAction ではないが本人の操作なので revision を確かめる（6.2.4 (3)）
  | { eventId: string; caseId: string; expectedRevision: number; by: '本人'; type: 'materials.provided' }
  | (Job & { type: 'materials.ready' })
  | (Job & { type: 'draft.done'; n: number; versionFingerprint: string })
  | (Job & { type: 'outline.done'; outlineFingerprint: string })
  // escalate: 3 回目を待たずに本人に上げる（判定のファイルの Review.escalate。6.2.7 (2)）
  | (Job & { type: 'review.pass' | 'review.fail' | 'format.failed'; n: number; escalate?: Escalate['why'] })
  | (Job & { type: 'format.checked'; n: number; outputFingerprint: string })
  | (Omit<Job, 'by'> & { by: '自動'; type: 'delivery.send'; planFingerprint: string; quotesOthers: boolean })
  | (Attempt & { type: 'delivery.done'; receiptId: string; link?: string; shareToken?: string })
  // link は作ったと分かっているファイル（照合に落ちた・確かめられないまま止まったものも本人が消せるように。6.5 (6)）
  | (Attempt & { type: 'delivery.mismatch'; link?: string; reason?: string })
  | (Attempt & { type: 'delivery.unknown'; link?: string })
  | (Attempt & { type: 'delivery.failed'; reason: string; link?: string })
  | (Job & { type: 'fail.system'; reason: string })
  // 送付の仕事が出す道具の失敗は revision でなく attempt で確かめる（送付中は届け先ごとに revision が進む。4.6 (2)）
  | (Attempt & { type: 'fail.system'; reason: string })
  // アダプタ（Issue 6）の onCostCap の通知そのまま。eventId = <caseId>:cost.cap:<callId>（4.6 (7)・6.1.1 (1)）
  | (CostCapNotice & { by: '費用'; type: 'cost.cap' })
export type CaseInput = Person | HostEvent

type DismissReason = '依頼ではない' | '自分の仕事ではない' | 'もう済んだ' | '拾わなくてよい'
// 候補の操作は eventId を持たない。二重送信は candidates.status のガードで弾く（5.3.1・4.6 (0)）
export type CandidateInput =
  | { type: 'candidate.presented'; candidate: NewCandidate; card: CardContent }
  | { type: 'candidate.proceed'; candidateId: string; caseId: string; mode: Mode }
  | { type: 'candidate.dismiss'; candidateId: string; reason: DismissReason }
  | {
      type: 'candidate.auto_enter'
      candidateId: string
      caseId: string
      entranceDefault: Mode
      promote?: 'gmail_label' | 'slack_emoji'
    }
export type RequestInput = { type: 'conversation.request' } & Pick<
  NewCase,
  'eventId' | 'caseId' | 'title' | 'mode' | 'docType' | 'destination' | 'deadline'
>
export type Input = CaseInput | CandidateInput | RequestInput | { type: 'stop.all' }

// materialsPending: T8 で承認する組の依頼書に「渡してほしいもの」がある（組を読んだ呼ぶ側が決める。6.2.4 (2)）
// marks = 今の版の本文の判定の「要確認」印（approval.ok で HTTP が渡す。6.3.1 (9)）
export type Ctx = { materialsPending?: boolean; marks?: readonly Mark[] }

export type Result =
  | {
      ok: true
      replayed: boolean
      case?: CaseRecord
      newCaseId?: string
      stopped?: string[]
      askSuppress?: { senderKey: string; count: number }
    }
  | { ok: false; reason: 'stale' | 'invalid_transition'; case?: CaseRecord }
  // conflict: 同じ eventId が別の案件・別のイベントにある（5.3.1 の 400）
  | { ok: false; reason: 'conflict' | 'not_found' }

// --- 指紋（4.6 (1)）

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const targetsFingerprint = (targets: readonly DeliveryTarget[]) => sha256(targets)
// DeliveryPlan.fingerprint = 版・本文の指紋・送付成果物の指紋・届け先の一覧
export const planFingerprint = (c: CaseRecord) =>
  sha256([c.version, c.versionFingerprint ?? null, c.outputFingerprint ?? null, c.destination])
const sameTarget = (a: DeliveryTarget, b: DeliveryTarget) => sha256(a) === sha256(b)
const visibilityOf = (t: DeliveryTarget) =>
  t.kind === 'page' && t.shared ? ('ほかの人にも見える' as const) : ('あなただけ' as const)

// --- 入口

export function transition(ledger: Ledger, input: Input, ctx: Ctx = {}): Result {
  switch (input.type) {
    case 'candidate.presented':
    case 'candidate.proceed':
    case 'candidate.dismiss':
    case 'candidate.auto_enter':
      return ledger.transaction(() => candidate(ledger, input))
    case 'conversation.request':
      return ledger.transaction(() => request(ledger, input))
    case 'stop.all':
      return ledger.transaction(() => stopAll(ledger))
    default:
      return ledger.transaction(() => caseEvent(ledger, input, ctx))
  }
}

// --- 案件のイベント（T6〜T31）

type Plan = Pick<
  TransitionInput,
  | 'to'
  | 'turn'
  | 'step'
  | 'reason'
  | 'version'
  | 'series'
  | 'round'
  | 'approvalKind'
  | 'mode'
  | 'destination'
  | 'setFingerprint'
  | 'outlineFingerprint'
  | 'versionFingerprint'
  | 'outputFingerprint'
> & { clearOutput?: boolean; after?: () => void; newCaseId?: string }
type Reject = 'stale' | 'invalid_transition'

function caseEvent(ledger: Ledger, ev: CaseInput, ctx: Ctx): Result {
  const c = ledger.getCase(ev.caseId)
  // eventId が先、expectedRevision が後（5.3.1）
  const prior = ledger.findEvent(ev.eventId)
  if (prior) {
    const name = prior.type === 'transition' || prior.type === 'rejected' ? prior.event : prior.type
    if (prior.caseId !== ev.caseId || name !== ev.type) return { ok: false, reason: 'conflict' }
    if (prior.type === 'rejected') return { ok: false, reason: prior.reason, ...(c && { case: c }) }
    const created = ev.type === 'restart_as_new' && ledger.findEvent(derivedEventId(ev.eventId, 'created'))
    return { ok: true, replayed: true, ...(c && { case: c }), ...(created && { newCaseId: created.caseId }) }
  }
  if (!c) return { ok: false, reason: 'not_found' }
  let plan = decide(ledger, c, ev, ctx)
  // 状態の食い違い（invalid_transition）を先に、revision の食い違い（stale）を後に見る
  if (typeof plan !== 'string' && 'expectedRevision' in ev && ev.expectedRevision !== c.revision) plan = 'stale'
  if (typeof plan === 'string') {
    ledger.appendRejected({ eventId: ev.eventId, caseId: c.caseId, event: ev.type, reason: plan })
    return { ok: false, reason: plan, case: c }
  }
  const { clearOutput, after, newCaseId, ...t } = plan
  ledger.appendTransition(
    { ...t, eventId: ev.eventId, caseId: c.caseId, from: c.state, event: ev.type, by: ev.by },
    { clearOutput: clearOutput ?? false },
  )
  after?.()
  return { ok: true, replayed: false, case: ledger.getCase(c.caseId) as CaseRecord, ...(newCaseId && { newCaseId }) }
}

function decide(ledger: Ledger, c: CaseRecord, ev: CaseInput, ctx: Ctx): Plan | Reject {
  const is = (...states: CaseState[]) => states.includes(c.state)
  const mine = c.turn === '本人'
  const working = c.turn === 'libretto'
  const say = (text: string) => () => ledger.appendConversation(c.caseId, text)
  const decision = (gate: DecisionRecord['gate'], text: string) => () => ledger.appendDecision(c.caseId, gate, text)
  const supersede =
    (...gates: ApprovalRecord['gate'][]) =>
    () => {
      ledger.supersedeApprovals(c.caseId, gates, ev.eventId)
    }
  const approve = (a: Omit<ApprovalRecord, 'eventId' | 'caseId' | 'at' | 'supersededBy'>) => () =>
    ledger.insertApproval({ ...a, eventId: ev.eventId, caseId: c.caseId })
  const all =
    (...fns: (() => void)[]) =>
    () => {
      for (const f of fns) f()
    }
  const final: Plan = { to: '承認待ち', turn: '本人', step: STEP.final, approvalKind: '完成稿' }
  const stop = (reason: string, after?: () => void): Plan => ({
    to: '停止',
    turn: '本人',
    step: STEP.stopped,
    reason,
    ...(after && { after }),
  })
  // 往復の上限と、3 回目を待たずに上げるとき（T17・T21b）。round は今回の判定を含めた値（4.6 (7)）
  const limit = (round: number, why?: Escalate['why'], after?: () => void): Plan =>
    c.mode === '確認しながら'
      ? { ...final, round, ...(after && { after }) }
      : {
          ...stop(why ?? '往復上限', all(...(after ? [after] : []), say(LIMIT_SAY[why ?? '往復上限']))),
          round,
        }
  // 新しい系列で下書きに戻す（T19。「削る」もここ）
  const redo = (instruction: string): Plan => ({
    to: '下書き中',
    turn: 'libretto',
    step: STEP.writing,
    series: c.series + 1,
    round: 0,
    after: decision('完成稿', instruction),
  })

  switch (ev.type) {
    case 'entrance.drafted': // T6
      if (!is('入口待ち') || !working) return 'invalid_transition'
      return {
        to: '入口待ち',
        turn: c.auto ? 'libretto' : '本人',
        step: c.auto ? STEP.autoEntrance : STEP.entrance,
        setFingerprint: ev.setFingerprint,
      }
    case 'entrance.failed': // T6b。前の組（set_fingerprint）は残る（6.2.2 (1)）
      if (!is('入口待ち') || !working) return 'invalid_transition'
      return { to: '入口待ち', turn: '本人', step: STEP.entranceFailed }
    case 'entrance.revise': // T7・T7b
      if (is('入口待ち') && (mine || c.auto))
        return { to: '入口待ち', turn: 'libretto', step: STEP.drafting, after: decision('入口', ev.note) }
      if (is('材料待ち', '下書き中', '検品中') && c.auto)
        return {
          to: '入口待ち',
          turn: 'libretto',
          step: STEP.drafting,
          series: c.series + 1,
          round: 0,
          after: all(decision('入口', ev.note), supersede('入口')),
        }
      return 'invalid_transition'
    case 'entrance.approve': {
      // T8。おまかせはホストが T6 の後に出す
      const turnOk = ev.by === '本人' ? mine : c.auto && working
      if (!is('入口待ち') || !turnOk || !c.setFingerprint) return 'invalid_transition'
      if (ev.setFingerprint !== c.setFingerprint) return 'stale'
      const answers = Object.entries(ev.answers).map(([id, a]) => `${id}: ${[a].flat().join('、')}`)
      return {
        to: '材料待ち',
        turn: ctx.materialsPending ? '本人' : 'libretto',
        step: ctx.materialsPending ? STEP.waitMaterials : STEP.materials,
        mode: ev.by === '本人' ? ev.mode : c.mode,
        after: all(
          approve({ gate: '入口', by: ev.by, setFingerprint: ev.setFingerprint }),
          ...(answers.length ? [decision('入口', answers.join('\n'))] : []),
        ),
      }
    }
    case 'cancel': // T9・T30
      if (!is(...ACTIVE)) return 'invalid_transition'
      return { to: '取り消し', turn: '本人', step: STEP.cancelled }
    case 'materials.provided': // T10
      if (!is('材料待ち') || !mine) return 'invalid_transition'
      return { to: '材料待ち', turn: 'libretto', step: STEP.materials }
    case 'materials.ready': // T11
      if (!is('材料待ち') || !working) return 'invalid_transition'
      return { to: '下書き中', turn: 'libretto', step: STEP.writing }
    case 'draft.done': // T12
      if (!is('下書き中') || !working) return 'invalid_transition'
      if (ev.n !== c.version + 1) return 'stale'
      return {
        to: '検品中',
        turn: 'libretto',
        step: STEP.checking,
        version: ev.n,
        versionFingerprint: ev.versionFingerprint,
        clearOutput: true,
      }
    case 'outline.done': {
      // T13。構成案ゲートは 1 案件 1 回（4.6 (4)）
      const gateDone = ledger.listApprovals(c.caseId).some((a) => a.gate === '構成案')
      if (!is('下書き中') || !working || c.mode !== '確認しながら' || gateDone) return 'invalid_transition'
      return {
        to: '承認待ち',
        turn: '本人',
        step: STEP.outline,
        approvalKind: '構成案',
        outlineFingerprint: ev.outlineFingerprint,
      }
    }
    case 'outline.approve': // T14
      if (!is('承認待ち') || c.approvalKind !== '構成案') return 'invalid_transition'
      if (ev.outlineFingerprint !== c.outlineFingerprint) return 'stale'
      return {
        to: '下書き中',
        turn: 'libretto',
        step: STEP.writing,
        after: all(
          approve({ gate: '構成案', by: '本人', versionFingerprint: ev.outlineFingerprint }),
          ...(ev.note ? [decision('構成案', ev.note)] : []),
        ),
      }
    case 'review.pass': // T15
    case 'review.fail': {
      // T16・T17
      if (!is('検品中') || !working) return 'invalid_transition'
      if (ev.n !== c.version) return 'stale'
      const round = c.round + 1
      if (ev.type === 'review.pass')
        return c.mode === '確認しながら'
          ? { ...final, round }
          : { to: '送付確認待ち', turn: 'libretto', step: STEP.tailoring, round, clearOutput: true }
      if (round < MAX_ROUNDS && !ev.escalate) return { to: '下書き中', turn: 'libretto', step: STEP.writing, round }
      return limit(round, ev.escalate)
    }
    case 'approval.ok': {
      // T18（「削る」があれば T19）
      if (!is('承認待ち') || c.approvalKind !== '完成稿') return 'invalid_transition'
      if (ev.versionFingerprint !== c.versionFingerprint) return 'stale'
      // 印の答えは今の版の印の全部（別の版の画面からの送信は stale。6.3.1 (9)）
      const marks = ctx.marks ?? []
      const keys = Object.keys(ev.marks)
      if (keys.length !== marks.length || marks.some((m) => !(m.claimId in ev.marks))) return 'stale'
      const cut = marks.filter((m) => ev.marks[m.claimId] === '削る')
      if (cut.length) return redo([CUT_LEAD, ...cut.map((m) => `- 「${m.text}」（${m.where}）`)].join('\n'))
      const kept = Object.fromEntries(Object.keys(ev.marks).map((id) => [id, '印のまま' as const]))
      return {
        to: '送付確認待ち',
        turn: 'libretto',
        step: STEP.tailoring,
        clearOutput: true,
        after: approve({
          gate: '完成稿',
          by: '本人',
          version: c.version,
          versionFingerprint: c.versionFingerprint,
          planFingerprint: targetsFingerprint(c.destination),
          ...(Object.keys(kept).length && { marks: kept }),
        }),
      }
    }
    case 'approval.redo': // T19
      if (!is('承認待ち') || c.approvalKind !== '完成稿') return 'invalid_transition'
      return redo(ev.instruction)
    case 'format.checked': // T20
    case 'format.failed': {
      // T21・T21b
      if (!is('送付確認待ち') || !working) return 'invalid_transition'
      if (ev.n !== c.version) return 'stale'
      const round = c.round + 1
      if (ev.type === 'format.checked')
        return {
          to: '送付確認待ち',
          turn: '本人',
          step: STEP.confirmSave,
          outputFingerprint: ev.outputFingerprint,
          round,
        }
      if (round < MAX_ROUNDS && !ev.escalate)
        return {
          to: '下書き中',
          turn: 'libretto',
          step: STEP.writing,
          round,
          clearOutput: true,
          after: supersede('完成稿'),
        }
      return { ...limit(round, ev.escalate, supersede('完成稿')), clearOutput: true }
    }
    case 'delivery.send': {
      // T22
      if (!is('送付確認待ち') || !mine || !c.outputFingerprint) return 'invalid_transition'
      // おまかせで自走するのは D5 の 3 つを全部満たすときだけ。v1 の届け先は上書きしない（T24b の「次は新しいファイル」）
      if (
        ev.by === '自動' &&
        (c.mode !== 'おまかせ' || ev.quotesOthers || c.destination.some((t) => visibilityOf(t) !== 'あなただけ'))
      )
        return 'invalid_transition'
      if (ev.planFingerprint !== planFingerprint(c)) return 'stale'
      // 同じ版で送付済の届け先は送らない。共有を取り消した届け先も送り直さない（4.6 (3)）
      const sent = [...latestAttempts(ledger, c.caseId).values()].filter(
        (d) => (d.status === '送付済' || d.status === '取り消し') && d.version === c.version,
      )
      // 同じ届け先が一覧に 2 回あっても 1 回だけ送る
      const targets = c.destination.filter(
        (t, i, all) => all.findIndex((u) => sameTarget(u, t)) === i && !sent.some((d) => sameTarget(d.target, t)),
      )
      if (!targets.length) return 'invalid_transition'
      return {
        to: '送付中',
        turn: 'libretto',
        step: STEP.saving,
        after: all(approve({ gate: '送付', by: ev.by, planFingerprint: ev.planFingerprint }), () => {
          targets.forEach((target, k) => {
            ledger.appendDelivery({
              eventId: ev.eventId,
              attemptId: `${ev.eventId}:${k}`,
              caseId: c.caseId,
              target,
              version: c.version,
              status: '送付中',
              visibility: visibilityOf(target),
              overwrites: false,
            })
          })
        }),
      }
    }
    case 'delivery.decline': // T23
      if (!is('送付確認待ち') || !mine) return 'invalid_transition'
      return { ...final, after: decision('送付', 'やめる') }
    case 'delivery.change': // T23b
      if (!is('承認待ち') || c.approvalKind !== '完成稿') return 'invalid_transition'
      return { ...final, destination: ev.targets, clearOutput: true, after: supersede('完成稿') }
    case 'delivery.done': // T24
    case 'delivery.mismatch': // T24b
    case 'delivery.unknown': // T25
    case 'delivery.failed': {
      // T26
      if (!is('送付中')) return 'invalid_transition'
      const current = currentSend(ledger, c.caseId)
      const a = current.get(ev.attemptId)
      // 古い送付回の遅れた通知・済んだ attempt への二度目の通知（4.6 (3)）
      if (!a || (a.status !== '送付中' && a.status !== '不明')) return 'stale'
      const row = (d: Pick<DeliveryRecord, 'status'> & Partial<DeliveryRecord>) => () => {
        const { target, version, visibility, overwrites } = a
        ledger.appendDelivery({
          eventId: ev.eventId,
          attemptId: a.attemptId,
          caseId: c.caseId,
          target,
          version,
          visibility,
          overwrites,
          ...d,
        })
      }
      switch (ev.type) {
        case 'delivery.done': {
          const after = row({
            status: '送付済',
            receiptId: ev.receiptId,
            ...clean({ link: ev.link, shareToken: ev.shareToken }),
          })
          const rest = [...current.values()].some((d) => d.attemptId !== a.attemptId && d.status !== '送付済')
          if (rest) return { to: '送付中', turn: 'libretto', step: STEP.saving, after }
          return {
            to: '完了',
            turn: '本人',
            step: STEP.done,
            after: all(after, decision('送付', `バージョン ${c.version} を保存しました`)),
          }
        }
        case 'delivery.mismatch':
          return {
            to: '下書き中',
            turn: 'libretto',
            step: STEP.writing,
            clearOutput: true,
            after: all(
              row({ status: '失敗', ...clean({ link: ev.link, reason: ev.reason }) }),
              supersede('完成稿', '送付'),
            ),
          }
        case 'delivery.unknown':
          return {
            to: '送付中',
            turn: 'libretto',
            step: STEP.saving,
            after: row({ status: '不明', ...clean({ link: ev.link }) }),
          }
        default:
          return stop(
            '送付失敗',
            all(row({ status: '失敗', reason: ev.reason, ...clean({ link: ev.link }) }), say(SAY.saveFailed)),
          )
      }
    }
    case 'delivery.add': // T26b
      if (!is('完了') || c.destination.some((t) => sameTarget(t, ev.target))) return 'invalid_transition'
      return {
        to: '送付確認待ち',
        turn: 'libretto',
        step: STEP.tailoring,
        destination: [...c.destination, ev.target],
        clearOutput: true,
      }
    case 'share.revoke': {
      // T26c
      if (!is('完了')) return 'invalid_transition'
      const a = [...latestAttempts(ledger, c.caseId).values()].find(
        (d) => d.status === '送付済' && d.shareToken === ev.shareToken,
      )
      if (!a) return 'invalid_transition'
      return {
        to: '完了',
        turn: '本人',
        step: STEP.done,
        after: () => {
          const { attemptId, target, version, visibility, overwrites, shareToken } = a
          ledger.appendDelivery({
            eventId: ev.eventId,
            attemptId,
            caseId: c.caseId,
            target,
            version,
            visibility,
            overwrites,
            status: '取り消し',
            ...clean({ shareToken }),
          })
        },
      }
    }
    case 'stop.case': // T27
      if (!is(...ACTIVE)) return 'invalid_transition'
      return stop(ev.reason ?? '本人が止めた')
    case 'fail.system': // T27b
      if (!is(...STOPPABLE)) return 'invalid_transition'
      if ('attemptId' in ev) {
        const a = is('送付中') && currentSend(ledger, c.caseId).get(ev.attemptId)
        if (!a || (a.status !== '送付中' && a.status !== '不明')) return 'stale'
      }
      // canary を当てた停止だけは、見えたおそれを言う（8.10 (2)）
      return stop(ev.reason, say(ev.reason === '隔離の失敗' ? SAY.isolationLeaked : SAY.toolFailed))
    case 'cost.cap': // T29。revision は確かめない（4.6 (7)）
      if (!is(...ACTIVE)) return 'invalid_transition'
      return stop('費用上限', say(SAY.costCap))
    case 'restart_as_new': {
      // T31。元の案件に transition 行、新しい案件の created 行は派生の event_id（9.4 (4)）
      if (!is('停止')) return 'invalid_transition'
      const newCaseId = randomUUID()
      return {
        to: '停止',
        turn: '本人',
        step: c.step,
        newCaseId,
        after: () => {
          ledger.insertCase({
            eventId: derivedEventId(ev.eventId, 'created'),
            caseId: newCaseId,
            title: c.title,
            state: '入口待ち',
            turn: 'libretto',
            step: STEP.drafting,
            mode: c.mode,
            origin: c.origin,
            auto: false,
            docType: c.docType,
            destination: c.destination,
            parentCaseId: c.caseId,
            ...clean({ deadline: c.deadline }),
          })
        },
      }
    }
  }
}

const clean = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }

// attempt ごとの最新の行
function latestAttempts(ledger: Ledger, caseId: string) {
  const m = new Map<string, DeliveryRecord>()
  for (const d of ledger.listDeliveries(caseId)) m.set(d.attemptId, d)
  return m
}

// 今の送付回（最後の gate=送付 の承認）の attempt と、その最新の行（4.6 (3)）
export function currentSend(ledger: Ledger, caseId: string) {
  const send = ledger
    .listApprovals(caseId)
    .filter((a) => a.gate === '送付')
    .at(-1)
  const rows = ledger.listDeliveries(caseId)
  const ids = new Set(rows.filter((d) => send && d.eventId === send.eventId).map((d) => d.attemptId))
  return new Map([...latestAttempts(ledger, caseId)].filter(([id]) => ids.has(id)))
}

// --- 候補（T1〜T4。案件は T2・T4 で作る。4.6 (0)）

function candidate(ledger: Ledger, ev: CandidateInput): Result {
  if (ev.type === 'candidate.presented') {
    // 重複は拒否ではなく、記録もしない（拾い上げは同じ候補を何度も見る）
    if (ledger.getCandidate(ev.candidate.candidateId)) return { ok: false, reason: 'invalid_transition' }
    ledger.insertCandidate(ev.candidate, ev.card)
    return { ok: true, replayed: false }
  }
  let cand = ledger.getCandidate(ev.candidateId)
  if (!cand) return { ok: false, reason: 'not_found' }
  // 案件を作った後の proceed の二度目は、作った案件を返す（5.3.1）
  if (ev.type === 'candidate.proceed' && cand.status === 'proceeded' && cand.caseId)
    return { ok: true, replayed: true, case: ledger.getCase(cand.caseId) as CaseRecord }
  const reject = (): Result => {
    ledger.appendCandidateEvent({
      type: 'rejected',
      candidateId: ev.candidateId,
      event: ev.type,
      status: cand?.status ?? '',
    })
    return { ok: false, reason: 'invalid_transition' }
  }
  if (cand.status !== 'presented') return reject()

  if (ev.type === 'candidate.dismiss') {
    const { candidateId, senderKey, source } = cand
    ledger.appendCandidateEvent({ type: 'dismissed', candidateId, reason: ev.reason }, { status: 'dismissed' })
    ledger.deleteCandidateCard(candidateId)
    ledger.deleteMessages(candidateId) // 候補の中の会話（6.4 (5)）
    if (ev.reason === '拾わなくてよい')
      ledger.addSuppression(source === 'slack' ? 'channel' : 'sender', senderKey, ev.reason)
    const count = ev.reason === '依頼ではない' ? ledger.countDismissed(senderKey, ev.reason) : 0
    return { ok: true, replayed: false, ...(count >= 3 && { askSuppress: { senderKey, count } }) }
  }

  const auto = ev.type === 'candidate.auto_enter'
  if (auto) {
    if (ev.promote && cand.origin === '推測') {
      ledger.appendCandidateEvent(
        { type: 'promoted_to_signal', candidateId: cand.candidateId, signal: ev.promote },
        { status: 'presented', origin: '合図' },
      )
      cand = ledger.getCandidate(cand.candidateId) as CandidateRecord
    }
    // 合図（会議の「会議」を含む）で、AI への指示の印が無く、入口の既定がおまかせ
    if (ev.entranceDefault !== 'おまかせ' || cand.origin === '推測' || cand.aiInstructionFlag) return reject()
  }
  const card = ledger.getCandidateCard(cand.candidateId)
  if (!card) throw new Error(`no card for candidate ${cand.candidateId}`)
  const created = ledger.insertCase({
    eventId: `${cand.candidateId}:${ev.type}`,
    caseId: ev.caseId,
    title: card.subject,
    state: '入口待ち',
    turn: 'libretto',
    step: STEP.drafting,
    mode: auto ? 'おまかせ' : ev.mode,
    origin: originOf(cand, card),
    auto,
    docType: card.proposal.docType,
    destination: card.proposal.destination,
    candidateId: cand.candidateId,
  })
  const status = auto ? 'auto_entered' : 'proceeded'
  ledger.appendCandidateEvent(
    { type: status, candidateId: cand.candidateId, caseId: ev.caseId },
    { status, caseId: ev.caseId },
  )
  if (auto) ledger.appendConversation(ev.caseId, SAY.autoStarted)
  return { ok: true, replayed: false, case: created }
}

function originOf(c: CandidateRecord, card: CardContent): Origin {
  if (c.origin === '合図') return { kind: '合図', source: c.source }
  const confidence = c.confidence
  if (!confidence) throw new Error(`candidate ${c.candidateId} has no confidence`)
  if (c.origin === '会議') return { kind: '会議', confidence }
  return { kind: '推測', source: c.source, confidence, reason: card.reason ?? '' }
}

// --- T5

function request(ledger: Ledger, ev: RequestInput): Result {
  const prior = ledger.findEvent(ev.eventId)
  if (prior) {
    if (prior.type !== 'created' || prior.caseId !== ev.caseId) return { ok: false, reason: 'conflict' }
    return { ok: true, replayed: true, case: ledger.getCase(ev.caseId) as CaseRecord }
  }
  const { type: _, ...rest } = ev
  const created = ledger.insertCase({
    ...rest,
    state: '入口待ち',
    turn: 'libretto',
    step: STEP.drafting,
    origin: { kind: '会話' },
    auto: false,
  })
  return { ok: true, replayed: false, case: created }
}

// --- T28。非終端の全案件を 1 つのトランザクションで止める。STOP ファイルとセッションの終了は呼ぶ側

function stopAll(ledger: Ledger): Result {
  const stopped = ledger.listCases(STOPPABLE).map((c) => {
    ledger.appendTransition({
      eventId: randomUUID(),
      caseId: c.caseId,
      from: c.state,
      to: '停止',
      event: 'stop.all',
      by: '停止',
      turn: '本人',
      step: STEP.stopped,
      reason: '緊急停止',
    })
    return c.caseId
  })
  return { ok: true, replayed: false, stopped }
}

// --- decisions.md（コミットの後に decisions の表から作り直す描き出し。9.3）

export const renderDecisions = (rows: readonly DecisionRecord[]) =>
  rows.map((d) => `## ${d.at} ${d.gate}\n\n${d.text}\n`).join('\n')

export function writeDecisionsMd(caseDir: string, ledger: Ledger, caseId: string) {
  writeFileSync(join(caseDir, 'decisions.md'), renderDecisions(ledger.listDecisions(caseId)), 'utf-8')
}
