// データベースの行の読み出し形（docs/implementation.md 9.2 の「行と型の境界」。確定範囲は 5.3.3）
// 生の行（snake_case・0/1・JSON 文字列・null）は host/src/ledger/ の中だけに置く。ここはそれを直した後の形
import { z } from 'zod'
import {
  Answer,
  ApprovalKind,
  Assumption,
  Brief,
  CaseState,
  DeliveryStatus,
  DeliveryTarget,
  DocType,
  LEAVE_IT,
  MaterialRef,
  Mismatch,
  Mode,
  Origin,
  Source,
  Turn,
  Undecided,
  Visibility,
} from './api.ts'
import { Check } from './checks.ts'

// costYen は持たない（costs の集計値。9.2）
export const CaseRecord = z.object({
  caseId: z.string(),
  title: z.string(),
  state: CaseState,
  turn: Turn,
  step: z.string(),
  mode: Mode,
  origin: Origin,
  auto: z.boolean(),
  docType: DocType,
  destination: z.array(DeliveryTarget),
  deadline: z.string().optional(),
  candidateId: z.string().optional(),
  version: z.number().int().min(0),
  series: z.number().int().min(1),
  round: z.number().int().min(0),
  revision: z.number().int().min(0),
  approvalKind: ApprovalKind.optional(),
  stopReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // 今の組・構成案・本文・送付成果物の指紋（4.6 (1)・(4)）
  setFingerprint: z.string().optional(),
  outlineFingerprint: z.string().optional(),
  versionFingerprint: z.string().optional(),
  outputFingerprint: z.string().optional(),
})
export type CaseRecord = z.infer<typeof CaseRecord>

const caseEvent = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({
    seq: z.number().int(),
    eventId: z.string(),
    caseId: z.string(),
    at: z.string(),
    type: z.literal(type),
    ...shape,
  })

// 列と detail を合わせた形（9.2 の case_events の type の表）
export const CaseEvent = z.discriminatedUnion('type', [
  caseEvent('created', {
    // 作ったときの状態（出来事を順にたどる起点。9.4 (4)）
    to: CaseState,
    turn: Turn,
    step: z.string(),
    title: z.string(),
    origin: Origin,
    auto: z.boolean(),
    mode: Mode,
    docType: DocType,
    destination: z.array(DeliveryTarget),
    deadline: z.string().optional(),
    candidateId: z.string().optional(),
    parentCaseId: z.string().optional(), // T31 の元の案件
  }),
  caseEvent('transition', {
    from: CaseState,
    to: CaseState,
    event: z.string(),
    by: z.enum(['本人', 'libretto', '自動', '拾い上げ', '費用', '停止']),
    turn: Turn,
    step: z.string(),
    reason: z.string().optional(),
    version: z.number().int().optional(),
    series: z.number().int().optional(),
    round: z.number().int().optional(),
    approvalKind: ApprovalKind.optional(),
    mode: Mode.optional(),
    destination: z.array(DeliveryTarget).optional(),
    // 書き換えた指紋の列（9.1 の「順にたどれば今の行に一致」）。空にする遷移は 4.6 (1)
    setFingerprint: z.string().optional(),
    outlineFingerprint: z.string().optional(),
    versionFingerprint: z.string().optional(),
    outputFingerprint: z.string().optional(),
  }),
  caseEvent('rejected', { state: CaseState, event: z.string(), reason: z.enum(['invalid_transition', 'stale']) }),
  caseEvent('mode_changed', { mode: Mode }),
  caseEvent('title_changed', { title: z.string() }),
  caseEvent('purged', { paths: z.array(z.string()) }),
])
export type CaseEvent = z.infer<typeof CaseEvent>

const candidateEvent = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ seq: z.number().int(), candidateId: z.string(), at: z.string(), type: z.literal(type), ...shape })

export const CandidateEvent = z.discriminatedUnion('type', [
  candidateEvent('found', {
    source: Source,
    origin: z.enum(['合図', '推測', '会議']),
    confidence: z.enum(['高', '中', '低']).optional(),
    aiInstructionFlag: z.boolean(),
    senderKey: z.string(),
  }),
  candidateEvent('promoted_to_signal', { signal: z.enum(['gmail_label', 'slack_emoji']) }),
  candidateEvent('proposal_changed', {}),
  candidateEvent('not_request', { source: Source }),
  candidateEvent('presented', {}),
  candidateEvent('proceeded', { caseId: z.string() }),
  candidateEvent('auto_entered', { caseId: z.string() }),
  candidateEvent('dismissed', {
    reason: z.enum(['依頼ではない', '自分の仕事ではない', 'もう済んだ', '拾わなくてよい']),
  }),
  candidateEvent('kept', {}),
  candidateEvent('recall_sample', { signalAt: z.string(), inferredBefore: z.boolean() }),
  candidateEvent('rejected', { event: z.string(), status: z.string() }), // 4.6 (0)
])
export type CandidateEvent = z.infer<typeof CandidateEvent>

export const CandidateStatus = z.enum(['found', 'presented', 'proceeded', 'auto_entered', 'dismissed', 'not_request'])
export const CandidateRecord = z.object({
  candidateId: z.string(),
  source: Source,
  origin: z.enum(['合図', '推測', '会議']),
  confidence: z.enum(['高', '中', '低']).optional(),
  aiInstructionFlag: z.boolean(),
  senderKey: z.string(),
  status: CandidateStatus,
  caseId: z.string().optional(),
  updatedAt: z.string(),
})
export type CandidateRecord = z.infer<typeof CandidateRecord>

// 6.1 の役割
export const Role = z.enum([
  '話し相手',
  '下書き役・依頼書',
  '下書き役・確認項目',
  '作り手',
  '判定役・文章',
  '判定役・画像',
  '判定役・命題',
  '事実係・抜き出し',
  '事実係・分類',
  '事実係・命題',
  '事実係・描写',
])

const costBase = { seq: z.number().int(), caseId: z.string(), at: z.string() } // caseId は案件 id、または '推測' / '点検' / '会話'
const tokens = { tokensIn: z.number().int().min(0).optional(), tokensOut: z.number().int().min(0).optional() }

// 行の種類ごとの必須欄は 9.2 の CHECK と同じ（9.4 (1)）
export const CostRecord = z.discriminatedUnion('type', [
  z.object({
    ...costBase,
    ...tokens,
    type: z.literal('hold'),
    callId: z.string(),
    role: Role,
    family: z.enum(['claude', 'openai', 'jev']),
    model: z.string(),
    holdYen: z.number().min(0),
  }),
  z.object({ ...costBase, ...tokens, type: z.literal('charge'), callId: z.string(), yen: z.number().min(0) }),
  z.object({ ...costBase, type: z.literal('classified'), caseId: z.literal('推測'), itemId: z.string() }),
])
export type CostRecord = z.infer<typeof CostRecord>

export const ApprovalRecord = z.object({
  eventId: z.string(),
  caseId: z.string(),
  gate: z.enum(['入口', '構成案', '完成稿', '送付']),
  by: z.enum(['本人', '自動']),
  version: z.number().int().optional(),
  versionFingerprint: z.string().optional(),
  setFingerprint: z.string().optional(),
  planFingerprint: z.string().optional(),
  marks: z.record(z.string(), z.literal('印のまま')).optional(),
  supersededBy: z.string().optional(),
  at: z.string(),
})
export type ApprovalRecord = z.infer<typeof ApprovalRecord>

// deliveries.detail は { reason }（失敗の理由。4.6 (5)）。読み出しでは reason の欄に出す
export const DeliveryRecord = z.object({
  seq: z.number().int(),
  eventId: z.string(),
  attemptId: z.string(),
  caseId: z.string(),
  target: DeliveryTarget,
  version: z.number().int(),
  status: DeliveryStatus,
  receiptId: z.string().optional(),
  link: z.string().optional(),
  shareToken: z.string().optional(),
  visibility: Visibility,
  overwrites: z.boolean(),
  reason: z.string().optional(),
  at: z.string(),
})
export type DeliveryRecord = z.infer<typeof DeliveryRecord>

export const DecisionGate = z.enum(['入口', '構成案', '完成稿', '送付'])
export const DecisionRecord = z.object({
  seq: z.number().int(),
  caseId: z.string(),
  gate: DecisionGate,
  text: z.string(),
  at: z.string(),
})
export type DecisionRecord = z.infer<typeof DecisionRecord>

// 会話で聞き取った依頼（6.2.1 (4)）。必須は表 4-1 の 何を・誰が読むか・届け先。保存先は S1 で作れる 2 つだけ
export const IntakeDraft = z.object({
  title: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(300),
  docType: DocType,
  audience: z.string().trim().min(1),
  destinations: z.array(z.enum(['page', 'paste'])).min(1),
  shape: z.string().optional(),
  deadline: z.string().optional(),
  mustNot: z.array(z.string()).optional(),
})
export type IntakeDraft = z.infer<typeof IntakeDraft>

// 案件フォルダの intake.json（9.3）。この Issue は会話の由来だけを書く
export const Intake = z.object({
  origin: Origin,
  summary: z.string(),
  materials: z.array(MaterialRef),
  conversationRef: z.object({ thread: z.string(), seq: z.number().int() }).optional(),
  heard: IntakeDraft.optional(),
  parentCaseId: z.string().optional(), // T31 で写した元の案件（6.2.2 (1)）
})
export type Intake = z.infer<typeof Intake>

// 入口の組のファイル（9.3・6.2.2 (7)）。approvedFingerprint と答えは入口の承認の前に書く
// #47 の前のファイルも読む: 答えと recommended の文字列 1 つは配列に、multiple が無ければ false（6.2.6 (2)）
const asList = (v: unknown) => (typeof v === 'string' && v !== LEAVE_IT ? [v] : v)
const StoredAnswer = z.preprocess(asList, Answer)
const StoredUndecided = z.preprocess(
  (v) =>
    v && typeof v === 'object'
      ? { multiple: false, ...v, recommended: asList((v as { recommended?: unknown }).recommended) }
      : v,
  Undecided,
)
export const BriefFile = Brief.extend({
  assumptions: z.array(Assumption),
  decisions: z.array(z.object({ undecidedId: z.string(), answer: StoredAnswer, label: z.string() })),
  approvedFingerprint: z.string().optional(),
})
export type BriefFile = z.infer<typeof BriefFile>
export const ChecksFile = z.object({
  checks: z.array(Check),
  family: z.enum(['別系統', '同系統']),
  approvedFingerprint: z.string().optional(),
})
export type ChecksFile = z.infer<typeof ChecksFile>
export const UndecidedFile = z.object({
  items: z.array(StoredUndecided),
  mismatches: z.array(Mismatch),
  answers: z.record(z.string(), StoredAnswer).optional(),
})
export type UndecidedFile = z.infer<typeof UndecidedFile>

// versions/NN/manifest.json（9.3）。版の正本。fingerprint が本文の指紋（T18 の承認の対象。4.6 (1)）
export const VersionManifest = z.object({
  n: z.number().int().min(1),
  at: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().min(0) })),
  fingerprint: z.string(),
})
export type VersionManifest = z.infer<typeof VersionManifest>

// maker.json（6.2.3 (5)）。作り手を最後に起こしたときの版と系列。再起動で書き終えた版を拾ってよいかの照合に使う
export const MakerAttempt = z.object({ n: z.number().int().min(1), series: z.number().int().min(1), at: z.string() })
