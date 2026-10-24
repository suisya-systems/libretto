// cases / case_events / costs と付随の表の読み書きと集計（9.2・9.4・4.6 (6)）。接続と生の行はこのクラスの外に出さない（9.4 (3)）
import {
  CandidateCard,
  type CaseState,
  type Choice,
  ConversationMessage,
  Notice,
  type Turn,
} from '@libretto/shared/api'
import {
  ApprovalRecord,
  CandidateEvent,
  CandidateRecord,
  CaseEvent,
  CaseRecord,
  CostRecord,
  type DecisionGate,
  DecisionRecord,
  DeliveryRecord,
} from '@libretto/shared/ledger'
import type Database from 'better-sqlite3'
import type { z } from 'zod'

const HOUR = 3_600_000

// 9.1 の時刻の形 YYYY-MM-DDTHH:MM:SS.sss+09:00
export const jst = (d: Date) => new Date(d.getTime() + 9 * HOUR).toISOString().replace('Z', '+09:00')

// JST の暦月・日の範囲 [start, end)（9.4 (2)）
export function jstMonth(d: Date): [string, string] {
  const j = new Date(d.getTime() + 9 * HOUR)
  const at = (m: number) => jst(new Date(Date.UTC(j.getUTCFullYear(), m, 1) - 9 * HOUR))
  return [at(j.getUTCMonth()), at(j.getUTCMonth() + 1)]
}
export function jstDay(d: Date): [string, string] {
  const j = new Date(d.getTime() + 9 * HOUR)
  const at = (n: number) => jst(new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), n) - 9 * HOUR))
  return [at(j.getUTCDate()), at(j.getUTCDate() + 1)]
}

// 1 つの操作で書く 2 行目以降の event_id（9.4 (4)）
export const derivedEventId = (eventId: string, kind: 'created') => `${eventId}#${kind}`

type Transition = Extract<CaseEvent, { type: 'transition' }>
type EventInput = { [K in CaseEvent['type']]: Omit<Extract<CaseEvent, { type: K }>, 'seq' | 'at'> }[CaseEvent['type']]
export type NewCase = Pick<
  CaseRecord,
  'caseId' | 'title' | 'state' | 'turn' | 'step' | 'mode' | 'origin' | 'auto' | 'docType' | 'destination'
> &
  Partial<Pick<CaseRecord, 'deadline' | 'candidateId'>> & { eventId: string; parentCaseId?: string }
// 候補カードの中身（消せる行。9.1）
export const CardContent = CandidateCard.omit({
  id: true,
  source: true,
  origin: true,
  confidence: true,
  aiInstructionFlag: true,
})
export type CardContent = z.infer<typeof CardContent>
export type NewCandidate = Omit<CandidateRecord, 'status' | 'caseId' | 'updatedAt'>
type CandidateEventInput = {
  [K in CandidateEvent['type']]: Omit<Extract<CandidateEvent, { type: K }>, 'seq' | 'at'>
}[CandidateEvent['type']]
export type NewApproval = Omit<ApprovalRecord, 'at' | 'supersededBy'>
export type NewDelivery = Omit<DeliveryRecord, 'seq' | 'at'>
export type TransitionInput = Omit<Transition, 'seq' | 'at' | 'type'>
export type Hold = Pick<
  Extract<CostRecord, { type: 'hold' }>,
  'callId' | 'caseId' | 'role' | 'family' | 'model' | 'holdYen'
>
// daily は系統ごとの 1 日（JST）の呼び出しの数の上限（hold 行の数。docs/implementation.md 7.6 (4)）
export type Reserve = Hold & { caseCapYen: number | null; monthCapYen: number | null; daily?: number }
export type Charge = Pick<Extract<CostRecord, { type: 'charge' }>, 'callId' | 'yen' | 'tokensIn' | 'tokensOut'>

// 生の行（snake_case・0/1・JSON 文字列・null）
type Row = Record<string, unknown>
const EVENT_COLUMNS = {
  from: 'from_state',
  to: 'to_state',
  event: 'event',
  by: 'by',
  turn: 'turn',
  step: 'step',
  reason: 'reason',
  version: 'version',
  series: 'series',
  round: 'round',
} as const
export const NON_CASE_COSTS: readonly string[] = ['推測', '点検', '会話', '拾い上げ'] // 拾い上げは候補カードの要約（6.4 (4)）

// null の列は欄を省く（9.2 の「行と型の境界」）
const clean = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined))
function bool(v: unknown) {
  if (v !== 0 && v !== 1) throw new Error(`not a 0/1 column: ${String(v)}`)
  return v === 1
}
// 書く前に読み出し形で検査する（読めない費用の行を書かない。NaN・Infinity・小数のトークン数も落ちる）
const checkCost = (r: Row) => CostRecord.parse({ ...r, seq: 0, at: '' })

const toCase = (r: Row) =>
  CaseRecord.parse(
    clean({
      caseId: r.case_id,
      title: r.title,
      state: r.state,
      turn: r.turn,
      step: r.step,
      mode: r.mode,
      origin: JSON.parse(r.origin as string),
      auto: bool(r.auto),
      docType: r.doc_type,
      destination: JSON.parse(r.destination as string),
      deadline: r.deadline,
      candidateId: r.candidate_id,
      version: r.version,
      series: r.series,
      round: r.round,
      revision: r.revision,
      approvalKind: r.approval_kind,
      stopReason: r.stop_reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      setFingerprint: r.set_fingerprint,
      outlineFingerprint: r.outline_fingerprint,
      versionFingerprint: r.version_fingerprint,
      outputFingerprint: r.output_fingerprint,
    }),
  )

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string))
const toCard = (r: Row) =>
  CardContent.parse(
    clean({
      subject: r.subject,
      from: r.from_name,
      receivedAt: r.received_at,
      link: r.link,
      reason: r.reason,
      summary: r.summary,
      proposal: JSON.parse(r.proposal as string),
      attachmentsNeeded: json(r.attachments_needed),
      attachments: json(r.attachments),
      account: r.account,
    }),
  )
const cardCols = (k: CardContent) =>
  [
    k.subject,
    k.from,
    k.receivedAt,
    k.link,
    k.reason ?? null,
    k.summary,
    JSON.stringify(k.proposal),
    k.attachmentsNeeded ? JSON.stringify(k.attachmentsNeeded) : null,
    k.attachments ? JSON.stringify(k.attachments) : null,
    k.account ?? null,
  ] as const

const toCandidate = (r: Row) =>
  CandidateRecord.parse(
    clean({
      candidateId: r.candidate_id,
      source: r.source,
      origin: r.origin,
      confidence: r.confidence,
      aiInstructionFlag: bool(r.ai_instruction_flag),
      senderKey: r.sender_key,
      status: r.status,
      caseId: r.case_id,
      updatedAt: r.updated_at,
    }),
  )

const toApproval = (r: Row) =>
  ApprovalRecord.parse(
    clean({
      eventId: r.event_id,
      caseId: r.case_id,
      gate: r.gate,
      by: r.by,
      version: r.version,
      versionFingerprint: r.version_fingerprint,
      setFingerprint: r.set_fingerprint,
      planFingerprint: r.plan_fingerprint,
      marks: r.marks === null ? null : JSON.parse(r.marks as string),
      supersededBy: r.superseded_by,
      at: r.at,
    }),
  )

const toDelivery = (r: Row) =>
  DeliveryRecord.parse(
    clean({
      seq: r.seq,
      eventId: r.event_id,
      attemptId: r.attempt_id,
      caseId: r.case_id,
      target: JSON.parse(r.target as string),
      version: r.version,
      status: r.status,
      receiptId: r.receipt_id,
      link: r.link,
      shareToken: r.share_token,
      visibility: r.visibility,
      overwrites: bool(r.overwrites),
      reason: r.detail === null ? null : JSON.parse(r.detail as string).reason,
      at: r.at,
    }),
  )

function toEvent(r: Row) {
  const cols = Object.fromEntries(Object.entries(EVENT_COLUMNS).map(([k, c]) => [k, r[c]]))
  const detail = r.detail === null ? {} : JSON.parse(r.detail as string)
  return CaseEvent.parse(
    clean({ ...detail, ...cols, seq: r.seq, eventId: r.event_id, caseId: r.case_id, type: r.type, at: r.at }),
  )
}

const toCost = (r: Row) =>
  CostRecord.parse(
    clean({
      seq: r.seq,
      type: r.type,
      callId: r.call_id,
      caseId: r.case_id,
      role: r.role,
      family: r.family,
      model: r.model,
      yen: r.yen,
      holdYen: r.hold_yen,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      itemId: r.item_id,
      at: r.at,
    }),
  )

// 1 呼び出しの額 = charge があれば charge、無ければ hold の全額。期間で絞るのは hold だけ（9.4 (2)）
const SUM_CALLS = `SELECT COALESCE(SUM(COALESCE(c.yen, h.hold_yen)), 0) AS yen
  FROM costs h LEFT JOIN costs c ON c.type = 'charge' AND c.call_id = h.call_id
  WHERE h.type = 'hold'`

export class Ledger {
  readonly #db: Database.Database
  readonly #now: () => Date

  constructor(db: Database.Database, now: () => Date = () => new Date()) {
    this.#db = db
    this.#now = now
  }

  close() {
    this.#db.close()
  }

  // 同期の fn だけ。中の書き込みは全部 1 つの BEGIN IMMEDIATE に入り、例外で全部巻き戻る（9.4 (3)）
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn).immediate()
  }

  // --- cases / case_events

  getCase(caseId: string): CaseRecord | undefined {
    const r = this.#db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId) as Row | undefined
    return r && toCase(r)
  }

  listCases(states?: readonly CaseState[]): CaseRecord[] {
    const rows = states
      ? this.#db
          .prepare(`SELECT * FROM cases WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY updated_at DESC`)
          .all(...states)
      : this.#db.prepare('SELECT * FROM cases ORDER BY updated_at DESC').all()
    return (rows as Row[]).map(toCase)
  }

  findEvent(eventId: string): CaseEvent | undefined {
    const r = this.#db.prepare('SELECT * FROM case_events WHERE event_id = ?').get(eventId) as Row | undefined
    return r && toEvent(r)
  }

  listCaseEvents(caseId: string): CaseEvent[] {
    const rows = this.#db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY seq').all(caseId) as Row[]
    return rows.map(toEvent)
  }

  // cases の行と created 行を 1 回で（revision は 0）
  insertCase(c: NewCase): CaseRecord {
    return this.transaction(() => {
      const at = jst(this.#now())
      const { eventId, state, ...rest } = c
      const record = CaseRecord.parse({
        ...rest,
        state,
        version: 0,
        series: 1,
        round: 0,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      })
      this.#db
        .prepare(
          `INSERT INTO cases (case_id, title, state, turn, step, mode, origin, auto, doc_type, destination, deadline, candidate_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.caseId,
          record.title,
          record.state,
          record.turn,
          record.step,
          record.mode,
          JSON.stringify(record.origin),
          record.auto ? 1 : 0,
          record.docType,
          JSON.stringify(record.destination),
          record.deadline ?? null,
          record.candidateId ?? null,
          at,
          at,
        )
      const { caseId, title, origin, auto, mode, docType, destination, turn, step, deadline, candidateId } = record
      const { parentCaseId } = c
      this.#appendEvent(
        {
          type: 'created',
          eventId,
          caseId,
          to: state,
          turn,
          step,
          title,
          origin,
          auto,
          mode,
          docType,
          destination,
          ...clean({ deadline, candidateId, parentCaseId }),
        },
        at,
      )
      return record
    })
  }

  // 案件の行の書き換えと transition 行を 1 回で。片方だけを書く関数は置かない（9.4 (3)）
  // clearOutput: 送付成果物の指紋を空にする（仕立て直しが要る遷移。4.6 (1)）
  appendTransition(t: TransitionInput, { clearOutput = false } = {}): CaseRecord {
    return this.transaction(() => {
      if (t.to === '承認待ち' && !t.approvalKind) throw new Error('approvalKind is required for 承認待ち')
      if (t.to !== '承認待ち' && t.approvalKind) throw new Error('approvalKind is only for 承認待ち')
      const at = jst(this.#now())
      this.#appendEvent({ ...t, type: 'transition' }, at)
      const changed = this.#db
        .prepare(
          `UPDATE cases SET state = @to, turn = @turn, step = @step,
             version = COALESCE(@version, version), series = COALESCE(@series, series), round = COALESCE(@round, round),
             approval_kind = @approvalKind, mode = COALESCE(@mode, mode), destination = COALESCE(@destination, destination),
             stop_reason = CASE WHEN @to = '停止' AND @reason IS NOT NULL THEN @reason ELSE stop_reason END,
             set_fingerprint = COALESCE(@setFingerprint, set_fingerprint),
             outline_fingerprint = COALESCE(@outlineFingerprint, outline_fingerprint),
             version_fingerprint = COALESCE(@versionFingerprint, version_fingerprint),
             output_fingerprint = CASE WHEN @clearOutput THEN NULL ELSE COALESCE(@outputFingerprint, output_fingerprint) END,
             revision = revision + 1, updated_at = @at
           WHERE case_id = @caseId AND state = @from`,
        )
        .run({
          caseId: t.caseId,
          from: t.from,
          to: t.to,
          turn: t.turn,
          step: t.step,
          version: t.version ?? null,
          series: t.series ?? null,
          round: t.round ?? null,
          approvalKind: t.approvalKind ?? null,
          mode: t.mode ?? null,
          destination: t.destination ? JSON.stringify(t.destination) : null,
          reason: t.reason ?? null,
          setFingerprint: t.setFingerprint ?? null,
          outlineFingerprint: t.outlineFingerprint ?? null,
          versionFingerprint: t.versionFingerprint ?? null,
          outputFingerprint: t.outputFingerprint ?? null,
          clearOutput: clearOutput ? 1 : 0,
          at,
        }).changes
      if (changed !== 1) throw new Error(`case ${t.caseId} is not in state ${t.from}`)
      return this.getCase(t.caseId) as CaseRecord
    })
  }

  // 拒否の記録だけを書く（4.1）。state は今の行から取る
  appendRejected(r: { eventId: string; caseId: string; event: string; reason: 'invalid_transition' | 'stale' }) {
    return this.transaction(() => {
      const c = this.getCase(r.caseId)
      if (!c) throw new Error(`no case ${r.caseId}`)
      this.#appendEvent({ ...r, type: 'rejected', state: c.state }, jst(this.#now()))
    })
  }

  changeMode(eventId: string, caseId: string, mode: CaseRecord['mode']) {
    this.#changeColumn({ type: 'mode_changed', eventId, caseId, mode }, 'mode', mode)
  }

  changeTitle(eventId: string, caseId: string, title: string) {
    this.#changeColumn({ type: 'title_changed', eventId, caseId, title }, 'title', title)
  }

  recordPurged(eventId: string, caseId: string, paths: string[]) {
    this.transaction(() => this.#appendEvent({ type: 'purged', eventId, caseId, paths }, jst(this.#now())))
  }

  #changeColumn(ev: EventInput, column: 'mode' | 'title', value: string) {
    this.transaction(() => {
      const at = jst(this.#now())
      this.#appendEvent(ev, at)
      this.#db.prepare(`UPDATE cases SET ${column} = ?, updated_at = ? WHERE case_id = ?`).run(value, at, ev.caseId)
    })
  }

  // 書く前に読み出し形で検査する（読めない行を書かない）。列のある欄は列、残りは detail（9.2）
  #appendEvent(ev: EventInput, at: string) {
    const { eventId, caseId, type, ...fields } = CaseEvent.parse({ ...ev, seq: 0, at }) as Row
    delete fields.seq
    delete fields.at
    const cols: Row = {}
    for (const [k, c] of Object.entries(EVENT_COLUMNS)) {
      cols[c] = fields[k] ?? null
      delete fields[k]
    }
    this.#db
      .prepare(
        `INSERT INTO case_events (event_id, case_id, type, from_state, to_state, event, by, turn, step, reason, version, series, round, detail, at)
         VALUES (@eventId, @caseId, @type, @from_state, @to_state, @event, @by, @turn, @step, @reason, @version, @series, @round, @detail, @at)`,
      )
      .run({ ...cols, eventId, caseId, type, detail: Object.keys(fields).length ? JSON.stringify(fields) : null, at })
  }

  // --- candidates（T1〜T4。4.6 (0)）

  // candidates の行（presented）・found と presented の出来事・カードの中身を 1 回で
  insertCandidate(c: NewCandidate, card: CardContent) {
    this.transaction(() => {
      const at = jst(this.#now())
      const { candidateId, source, origin, confidence, aiInstructionFlag, senderKey } = CandidateRecord.parse({
        ...c,
        status: 'presented',
        updatedAt: at,
      })
      const k = CardContent.parse(card)
      this.#db
        .prepare(
          `INSERT INTO candidates (candidate_id, source, origin, confidence, ai_instruction_flag, sender_key, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'presented', ?)`,
        )
        .run(candidateId, source, origin, confidence ?? null, aiInstructionFlag ? 1 : 0, senderKey, at)
      this.#appendCandidateEvent(
        { type: 'found', candidateId, source, origin, aiInstructionFlag, senderKey, ...clean({ confidence }) },
        at,
      )
      this.#appendCandidateEvent({ type: 'presented', candidateId }, at)
      this.#db
        .prepare(
          `INSERT INTO candidate_cards (candidate_id, subject, from_name, received_at, link, reason, summary, proposal, attachments_needed, attachments, account)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(candidateId, ...cardCols(k))
    })
  }

  // 「内容を修正」（6.4 (5)）。カードの中身を書き換え、proposal_changed を足す。行が無ければ false
  updateCandidateCard(candidateId: string, card: CardContent): boolean {
    return this.transaction(() => {
      const k = CardContent.parse(card)
      const r = this.#db
        .prepare(
          `UPDATE candidate_cards SET subject = ?, from_name = ?, received_at = ?, link = ?, reason = ?, summary = ?,
             proposal = ?, attachments_needed = ?, attachments = ?, account = ? WHERE candidate_id = ?`,
        )
        .run(...cardCols(k), candidateId)
      if (!r.changes) return false
      this.#appendCandidateEvent({ type: 'proposal_changed', candidateId }, jst(this.#now()))
      return true
    })
  }

  // ホームの候補の欄（5.2）。出したまま（presented）のものを新しい順に
  listPresentedCandidates(): { candidate: CandidateRecord; card: CardContent }[] {
    const rows = this.#db
      .prepare(
        `SELECT c.*, k.* FROM candidates c JOIN candidate_cards k ON k.candidate_id = c.candidate_id
         WHERE c.status = 'presented' ORDER BY k.received_at DESC, c.candidate_id`,
      )
      .all() as Row[]
    return rows.map((r) => ({ candidate: toCandidate(r), card: toCard(r) }))
  }

  getCandidate(candidateId: string): CandidateRecord | undefined {
    const r = this.#db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(candidateId) as Row | undefined
    return r && toCandidate(r)
  }

  getCandidateCard(candidateId: string): CardContent | undefined {
    const r = this.#db.prepare('SELECT * FROM candidate_cards WHERE candidate_id = ?').get(candidateId) as
      | Row
      | undefined
    return r && toCard(r)
  }

  // 出来事を 1 行足し、status が変わる出来事なら candidates の行も同じトランザクションで書き換える
  appendCandidateEvent(
    ev: CandidateEventInput,
    change?: { status: CandidateRecord['status']; caseId?: string; origin?: CandidateRecord['origin'] },
  ) {
    this.transaction(() => {
      const at = jst(this.#now())
      this.#appendCandidateEvent(ev, at)
      if (!change) return
      this.#db
        .prepare(
          `UPDATE candidates SET status = ?, case_id = COALESCE(?, case_id), origin = COALESCE(?, origin), updated_at = ?
           WHERE candidate_id = ?`,
        )
        .run(change.status, change.caseId ?? null, change.origin ?? null, at, ev.candidateId)
    })
  }

  listCandidateEvents(candidateId: string): CandidateEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM candidate_events WHERE candidate_id = ? ORDER BY seq')
      .all(candidateId) as Row[]
    return rows.map((r) =>
      CandidateEvent.parse({
        ...(r.detail === null ? {} : JSON.parse(r.detail as string)),
        seq: r.seq,
        candidateId: r.candidate_id,
        type: r.type,
        at: r.at,
      }),
    )
  }

  deleteCandidateCard(candidateId: string) {
    this.#db.prepare('DELETE FROM candidate_cards WHERE candidate_id = ?').run(candidateId)
  }

  addSuppression(kind: 'sender' | 'channel', value: string, reason: string) {
    this.#db
      .prepare('INSERT INTO suppressions (kind, value, reason, added_at) VALUES (?, ?, ?, ?)')
      .run(kind, value, reason, jst(this.#now()))
  }

  // 同じ差出人の候補を、その理由で見送った数（T3 の ask_suppress。ホームもこの数を出す）
  countDismissed(senderKey: string, reason: string): number {
    const r = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM candidate_events e JOIN candidates c ON c.candidate_id = e.candidate_id
         WHERE e.type = 'dismissed' AND c.sender_key = ? AND json_extract(e.detail, '$.reason') = ?`,
      )
      .get(senderKey, reason) as { n: number }
    return r.n
  }

  #appendCandidateEvent(ev: CandidateEventInput, at: string) {
    const { candidateId, type, ...fields } = CandidateEvent.parse({ ...ev, seq: 0, at }) as Row
    delete fields.seq
    delete fields.at
    this.#db
      .prepare('INSERT INTO candidate_events (candidate_id, type, detail, at) VALUES (?, ?, ?, ?)')
      .run(candidateId, type, Object.keys(fields).length ? JSON.stringify(fields) : null, at)
  }

  // --- approvals / deliveries / decisions / 会話欄（4.6 (6)）

  insertApproval(a: NewApproval) {
    const r = ApprovalRecord.parse({ ...a, at: jst(this.#now()) })
    this.#db
      .prepare(
        `INSERT INTO approvals (event_id, case_id, gate, by, version, version_fingerprint, set_fingerprint, plan_fingerprint, marks, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.eventId,
        r.caseId,
        r.gate,
        r.by,
        r.version ?? null,
        r.versionFingerprint ?? null,
        r.setFingerprint ?? null,
        r.planFingerprint ?? null,
        r.marks ? JSON.stringify(r.marks) : null,
        r.at,
      )
  }

  // まだ有効な承認を、無効にした遷移の event_id で埋める（9.1 の例外）
  supersedeApprovals(caseId: string, gates: readonly ApprovalRecord['gate'][], byEventId: string): number {
    return this.#db
      .prepare(
        `UPDATE approvals SET superseded_by = ? WHERE case_id = ? AND superseded_by IS NULL
         AND gate IN (${gates.map(() => '?').join(',')})`,
      )
      .run(byEventId, caseId, ...gates).changes
  }

  listApprovals(caseId: string): ApprovalRecord[] {
    const rows = this.#db.prepare('SELECT * FROM approvals WHERE case_id = ? ORDER BY rowid').all(caseId) as Row[]
    return rows.map(toApproval)
  }

  appendDelivery(d: NewDelivery) {
    const r = DeliveryRecord.parse({ ...d, seq: 0, at: jst(this.#now()) })
    this.#db
      .prepare(
        `INSERT INTO deliveries (event_id, attempt_id, case_id, target, version, status, receipt_id, link, share_token, visibility, overwrites, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.eventId,
        r.attemptId,
        r.caseId,
        JSON.stringify(r.target),
        r.version,
        r.status,
        r.receiptId ?? null,
        r.link ?? null,
        r.shareToken ?? null,
        r.visibility,
        r.overwrites ? 1 : 0,
        r.reason === undefined ? null : JSON.stringify({ reason: r.reason }),
        r.at,
      )
  }

  listDeliveries(caseId: string): DeliveryRecord[] {
    const rows = this.#db.prepare('SELECT * FROM deliveries WHERE case_id = ? ORDER BY seq').all(caseId) as Row[]
    return rows.map(toDelivery)
  }

  appendDecision(caseId: string, gate: z.infer<typeof DecisionGate>, text: string) {
    this.#db
      .prepare('INSERT INTO decisions (case_id, gate, text, at) VALUES (?, ?, ?, ?)')
      .run(caseId, gate, text, jst(this.#now()))
  }

  listDecisions(caseId: string): DecisionRecord[] {
    const rows = this.#db.prepare('SELECT * FROM decisions WHERE case_id = ? ORDER BY seq').all(caseId) as Row[]
    return rows.map((r) =>
      DecisionRecord.parse({ seq: r.seq, caseId: r.case_id, gate: r.gate, text: r.text, at: r.at }),
    )
  }

  // 会話欄にホストの 1 行（thread = 案件 id）
  appendConversation(thread: string, text: string) {
    this.appendMessage({ thread, who: 'libretto', text })
  }

  listConversation(thread: string): string[] {
    return this.#messages('WHERE thread = ? ORDER BY seq', thread).map((m) => m.text)
  }

  // 会話欄の 1 行。seq を返す（6.2.1）
  appendMessage(m: {
    thread: string
    who: Turn
    text: string
    choices?: Choice[]
    choiceId?: string
    caseId?: string
    requestId?: string
  }): number {
    const r = this.#db
      .prepare(
        `INSERT INTO conversation_messages (thread, who, text, choices, choice_id, case_id, request_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.thread,
        m.who,
        m.text,
        m.choices ? JSON.stringify(m.choices) : null,
        m.choiceId ?? null,
        m.caseId ?? null,
        m.requestId ?? null,
        jst(this.#now()),
      )
    return Number(r.lastInsertRowid)
  }

  // 直近 limit 行を古い順に
  listMessages(thread: string, limit: number): ConversationMessage[] {
    return this.#messages('WHERE thread = ? ORDER BY seq DESC LIMIT ?', thread, limit).reverse()
  }

  // 今の依頼の会話: 最後に case_id のある行（T5 を起こした返事）より後（6.2.1 (6)）
  currentRequest(thread: string): ConversationMessage[] {
    return this.#messages(
      `WHERE thread = ? AND seq > COALESCE((SELECT MAX(seq) FROM conversation_messages WHERE thread = ? AND case_id IS NOT NULL), 0)
       ORDER BY seq`,
      thread,
      thread,
    )
  }

  // 候補の中の会話は、見送ったら消す（他人のメールの要約を含む。9.1 の「後で消すもの」・6.4 (5)）
  deleteMessages(thread: string) {
    this.#db.prepare('DELETE FROM conversation_messages WHERE thread = ?').run(thread)
  }

  lastMessage(thread: string): ConversationMessage | undefined {
    return this.#messages('WHERE thread = ? ORDER BY seq DESC LIMIT 1', thread)[0]
  }

  findRequest(requestId: string): ConversationMessage | undefined {
    return this.#messages('WHERE request_id = ?', requestId)[0]
  }

  #messages(where: string, ...args: unknown[]): ConversationMessage[] {
    const rows = this.#db.prepare(`SELECT * FROM conversation_messages ${where}`).all(...args) as Row[]
    return rows.map((r) =>
      ConversationMessage.parse(
        clean({
          seq: r.seq,
          thread: r.thread,
          who: r.who,
          text: r.text,
          choices: typeof r.choices === 'string' ? JSON.parse(r.choices) : null,
          choiceId: r.choice_id,
          caseId: r.case_id,
          at: r.at,
        }),
      ),
    )
  }

  // --- sessions（ペアリング。session_id は Cookie の値の sha256。5.7 (1)）

  appendSession(type: 'created' | 'revoked', sessionId: string, label?: string) {
    this.#db
      .prepare('INSERT INTO sessions (type, session_id, label, at) VALUES (?, ?, ?, ?)')
      .run(type, sessionId, label ?? null, jst(this.#now()))
  }

  // 外していないセッションの作った時刻。寿命の判定は呼ぶ側
  sessionCreatedAt(sessionId: string): string | undefined {
    const rows = this.#db.prepare('SELECT type, at FROM sessions WHERE session_id = ? ORDER BY seq').all(sessionId) as {
      type: string
      at: string
    }[]
    if (rows.some((r) => r.type === 'revoked')) return undefined
    return rows.find((r) => r.type === 'created')?.at
  }

  // --- notices

  listNotices(limit: number): Notice[] {
    const rows = this.#db.prepare('SELECT * FROM notices ORDER BY seq DESC LIMIT ?').all(limit) as Row[]
    return rows.map((r) => Notice.parse(clean({ at: r.at, caseId: r.case_id, text: r.text, kind: r.kind })))
  }

  // --- costs

  // 集計 → 上限と比べる → hold を 1 つの BEGIN IMMEDIATE で（4.4・9.4 (3)）。超えるなら hold を書かない
  reserveCost(r: Reserve): { ok: true } | { ok: false; scope: '案件' | '全体' | '1日' } {
    return this.transaction(() => {
      const { caseCapYen, monthCapYen, daily, ...h } = r
      const now = this.#now() // 比べる月と hold の月を同じにする（9.4 (2)）
      checkCost({ ...h, type: 'hold' })
      if (!NON_CASE_COSTS.includes(r.caseId) && !this.getCase(r.caseId)) throw new Error(`no case ${r.caseId}`)
      // 案件の無い呼び出しは案件上限と比べない（会話の費用は 1 つの行き先に積もる。6.2.1 (8)）
      if (
        caseCapYen !== null &&
        !NON_CASE_COSTS.includes(r.caseId) &&
        this.caseCostYen(r.caseId) + r.holdYen > caseCapYen
      )
        return { ok: false, scope: '案件' }
      if (monthCapYen !== null && this.monthCostYen(now) + r.holdYen > monthCapYen) return { ok: false, scope: '全体' }
      if (daily !== undefined && this.callsToday(r.family, now) >= daily) return { ok: false, scope: '1日' }
      this.#db
        .prepare(
          `INSERT INTO costs (type, call_id, case_id, role, family, model, hold_yen, at)
           VALUES ('hold', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.callId, r.caseId, r.role, r.family, r.model, r.holdYen, jst(now))
      return { ok: true }
    })
  }

  // 費用が取れなかった呼び出しは hold と同じ額で呼ぶ（9.4 (1)）
  recordCharge(c: Charge) {
    this.transaction(() => {
      const hold = this.#db.prepare(`SELECT case_id FROM costs WHERE type = 'hold' AND call_id = ?`).get(c.callId) as
        | Row
        | undefined
      if (!hold) throw new Error(`no hold for call ${c.callId}`)
      checkCost({ ...c, type: 'charge', caseId: hold.case_id })
      this.#db
        .prepare(
          `INSERT INTO costs (type, call_id, case_id, yen, tokens_in, tokens_out, at) VALUES ('charge', ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.callId, hold.case_id, c.yen, c.tokensIn ?? null, c.tokensOut ?? null, jst(this.#now()))
    })
  }

  // charge の無い hold の全部。期間・案件の状態・持ち主で絞らない（9.4 (7)）
  listUnsettledHolds(): { callId: string; caseId: string; holdYen: number }[] {
    const rows = this.#db
      .prepare(
        `SELECT call_id, case_id, hold_yen FROM costs h WHERE type = 'hold'
         AND NOT EXISTS (SELECT 1 FROM costs c WHERE c.type = 'charge' AND c.call_id = h.call_id) ORDER BY seq`,
      )
      .all() as Row[]
    return rows.map((r) => ({
      callId: r.call_id as string,
      caseId: r.case_id as string,
      holdYen: r.hold_yen as number,
    }))
  }

  // 再起動の精算。charge と cost_recoveries の行を 1 回で（9.4 (7)）。二度目は一意の索引と主キーで例外
  settleOrphan(s: { callId: string; yen: number; source: '結果' | '予約' }) {
    this.transaction(() => {
      this.recordCharge({ callId: s.callId, yen: s.yen })
      this.#db
        .prepare(
          `INSERT INTO cost_recoveries (call_id, case_id, source, at)
           SELECT call_id, case_id, ?, ? FROM costs WHERE type = 'hold' AND call_id = ?`,
        )
        .run(s.source, jst(this.#now()), s.callId)
    })
  }

  // 結果が無く予約の額で確定した呼び出しがあるか。費用の欄の 1 行（9.4 (7)）
  costUnknown(caseId: string): boolean {
    return !!this.#db.prepare(`SELECT 1 FROM cost_recoveries WHERE case_id = ? AND source = '予約' LIMIT 1`).get(caseId)
  }

  recordClassified(itemId: string) {
    this.#db
      .prepare(`INSERT INTO costs (type, case_id, item_id, at) VALUES ('classified', '推測', ?, ?)`)
      .run(itemId, jst(this.#now()))
  }

  // 案件の累計は期間で絞らない（9.4 (2)）
  caseCostYen(caseId: string): number {
    return (this.#db.prepare(`${SUM_CALLS} AND h.case_id = ?`).get(caseId) as { yen: number }).yen
  }

  // 全体の今月（JST）。月は hold の時刻で決まる
  monthCostYen(at: Date = this.#now()): number {
    const [start, end] = jstMonth(at)
    return (this.#db.prepare(`${SUM_CALLS} AND h.at >= ? AND h.at < ?`).get(start, end) as { yen: number }).yen
  }

  // 系統ごとの 1 日（JST）の呼び出しの数。再試行も 1 回（7.6 (4)）
  callsToday(family: string, at: Date = this.#now()): number {
    const [start, end] = jstDay(at)
    const r = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM costs WHERE type = 'hold' AND family = ? AND at >= ? AND at < ?`)
      .get(family, start, end) as { n: number }
    return r.n
  }

  // 推測の 1 日（JST）の分類件数
  classifiedCount(at: Date = this.#now()): number {
    const [start, end] = jstDay(at)
    const r = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM costs WHERE type = 'classified' AND at >= ? AND at < ?`)
      .get(start, end) as { n: number }
    return r.n
  }

  listCosts(caseId: string): CostRecord[] {
    return (this.#db.prepare('SELECT * FROM costs WHERE case_id = ? ORDER BY seq').all(caseId) as Row[]).map(toCost)
  }
}
