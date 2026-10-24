// 画面とホストの契約（docs/implementation.md 5.2・5.3。確定範囲は 5.3.3）
// 本人に見える型の欄の名前に「出さない語」を使わない（11.2。shared/test で確かめる）
import { z } from 'zod'
import { Category, CheckId, Escalate, Mark, Phase, SourceRow } from './checks.ts'

export const CaseState = z.enum([
  '候補',
  '入口待ち',
  '材料待ち',
  '下書き中',
  '検品中',
  '承認待ち',
  '送付確認待ち',
  '送付中',
  '完了',
  '停止',
  '見送り',
  '取り消し',
])
export type CaseState = z.infer<typeof CaseState>

export const Mode = z.enum(['確認しながら', 'おまかせ'])
export type Mode = z.infer<typeof Mode>
export const Turn = z.enum(['本人', 'libretto'])
export type Turn = z.infer<typeof Turn>
export const Confidence = z.enum(['高', '中', '低'])
export const Source = z.enum(['gmail', 'slack', 'meet'])
export const DocType = z.enum(['記事', 'メモ', '表', 'スライド'])
export type DocType = z.infer<typeof DocType>
export const ApprovalKind = z.enum(['構成案', '完成稿'])
export const Visibility = z.enum(['あなただけ', 'ほかの人にも見える'])

export const Origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('会話') }),
  z.object({ kind: z.literal('合図'), source: Source, label: z.string().optional() }),
  z.object({ kind: z.literal('推測'), source: Source, confidence: Confidence, reason: z.string() }),
  z.object({ kind: z.literal('会議'), confidence: Confidence }),
])
export type Origin = z.infer<typeof Origin>

export const DeliveryTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), shared: z.boolean() }),
  z.object({ kind: z.literal('paste') }),
  z.object({ kind: z.enum(['gdoc', 'gsheet', 'gslide']), folderId: z.string() }),
  z.object({ kind: z.literal('file'), format: z.enum(['pptx', 'xlsx', 'docx']) }),
])
export type DeliveryTarget = z.infer<typeof DeliveryTarget>

export const MaterialRef = z.object({
  id: z.string(),
  kind: z.enum(['出典', '声の見本', '元データ', '添付']),
  title: z.string(),
  where: z.string(),
})
export const Material = MaterialRef.extend({ status: z.enum(['取り寄せ済み', '待ち', '開けない']) })

// 表 4-1 のうち仮定・モード・由来は入れない（仮定は Assumption、モードと由来は案件の行が正本。5.3.3）
export const Brief = z.object({
  docType: DocType,
  subject: z.string().min(1), // 書く内容（何について・何を入れるか）。表 4-1 に足した（6.2.3 (0)）
  // 本人に渡してほしいもの。あれば T8 で本人の番の材料待ちに入る。前の版のファイルで欄が無ければ []（6.2.4 (1)）
  wanted: z.array(z.string().trim().min(1).max(80)).max(5).default([]),
  audience: z.string().min(1),
  destinations: z.array(DeliveryTarget).min(1),
  shape: z.string().min(1),
  materials: z.array(MaterialRef),
  voice: z.enum(['合わせる', '合わせない']),
  sources: z.enum(['出典付き', '出典なし']),
  deadline: z.string().optional(),
  mustNot: z.array(z.string()),
})
export type Brief = z.infer<typeof Brief>

export const Assumption = z.object({ id: z.string(), text: z.string().min(1), why: z.string().min(1) })
export type Assumption = z.infer<typeof Assumption>

export const LEAVE_IT = '任せる'
const unique = (a: readonly string[]) => new Set(a).size === a.length
// 選択肢の id の配列か '任せる'。1 つだけの問いも長さ 1 の配列（6.2.6 (2)）
export const Answer = z.union([
  z.literal(LEAVE_IT),
  z.array(z.string()).min(1).refine(unique, { message: '同じ選択肢が重なっている' }),
])
export type Answer = z.infer<typeof Answer>

// 選んだ id がその問いの選択肢で、1 つだけの問いならちょうど 1 件（recommended と答えの両方に使う）
export function fitsQuestion(u: { options: readonly { id: string }[]; multiple: boolean }, ids: readonly string[]) {
  return (
    ids.length > 0 &&
    unique(ids) &&
    ids.every((id) => u.options.some((o) => o.id === id)) &&
    (u.multiple || ids.length === 1)
  )
}

export const Undecided = z
  .object({
    id: z.string(),
    question: z.string().min(1),
    options: z
      .array(z.object({ id: z.string(), label: z.string(), note: z.string().optional() }))
      .min(2)
      .max(4),
    multiple: z.boolean(), // 当てはまるものを全部選べる問い（6.2.6 (1)）
    recommended: z.array(z.string()),
    answer: Answer.optional(),
  })
  .refine((u) => u.options.every((o) => o.id !== LEAVE_IT), { message: `選択肢の id に ${LEAVE_IT} は使えない` })
  .refine((u) => fitsQuestion(u, u.recommended), { message: 'recommended は選択肢の id（1 つだけの問いは 1 件）' })
  .refine((u) => u.answer === undefined || u.answer === LEAVE_IT || fitsQuestion(u, u.answer), {
    message: 'answer は選択肢の id（1 つだけの問いは 1 件）',
  })

export type Undecided = z.infer<typeof Undecided>

export const Mismatch = z.object({ checkId: CheckId, briefSays: z.string(), checkExpects: z.string() })
export type Mismatch = z.infer<typeof Mismatch>

// Check をそのまま返さない（judge の中身が本人に見える応答に出るため。5.3.3）
export const CheckForPerson = z.object({
  id: CheckId,
  category: Category,
  title: z.string(),
  method: z.enum(['機械', '読み手']),
  phase: Phase,
  hidden: z.boolean(),
  selfReport: z.enum(['依頼に書いてある', '書いていない']),
  summary: z.string(),
  isolation: z.boolean(), // canary。画面は「隔離の点検」
  minority: z.boolean(), // 少数派の項目（設計書 5.8.1。6.2.2 (9)）
})

export const ChecksSummary = z.object({
  count: z.number().int().min(0),
  byCategory: z.partialRecord(Category, z.number().int().min(0)),
  family: z.enum(['別系統', '同系統']),
  items: z.array(CheckForPerson),
})

// 最初の entrance.drafted（T6）まで無い（5.3.2）
export const Entrance = z.object({
  brief: Brief,
  assumptions: z.array(Assumption),
  undecided: z.object({ items: z.array(Undecided), mismatches: z.array(Mismatch) }),
  setFingerprint: z.string(),
  checks: ChecksSummary,
})
export type Entrance = z.infer<typeof Entrance>

export const Approval = z.object({
  gate: z.enum(['入口', '構成案', '完成稿', '送付']),
  by: z.enum(['本人', '自動']),
  version: z.number().int().optional(),
  at: z.string(),
})

export const FailedForPerson = z.object({
  checkId: CheckId,
  title: z.string(),
  verdict: z.enum(['fail', 'unable']),
  reason: z.string().optional(), // Claude の理由文。機械判定の項目には無い（6.2.5 (6)）
})

export const ReviewSummary = z.object({
  n: z.number().int().min(1),
  passed: z.number().int().min(0),
  failed: z.array(FailedForPerson),
  skipped: z.number().int().min(0), // 7.5 の未実行
  needsConfirmation: z.array(Mark),
  sources: z.array(SourceRow),
  familyNote: z.string().optional(),
  jevNote: z.string().optional(),
  escalate: Escalate.optional(), // 3 回目を待たずに上げた（6.2.7 (5)）
})

export const Version = z.object({
  n: z.number().int().min(1),
  at: z.string(),
  chars: z.number().int().min(0),
  headings: z.number().int().min(0),
  fingerprint: z.string(),
  state: z.enum(['検品中', '合格', '不合格', '承認済み']),
  review: ReviewSummary.optional(),
})

// GET /api/cases/:id/diff（5.2。段落単位）
export const DraftDiff = z.object({
  changes: z.array(
    z.object({
      kind: z.enum(['added', 'removed', 'changed']),
      before: z.string().optional(),
      after: z.string().optional(),
      note: z.string().optional(),
    }),
  ),
})

export const DeliveryPlan = z.object({
  targets: z.array(DeliveryTarget),
  fingerprint: z.string(),
  visibility: Visibility,
  overwrites: z.boolean(),
  quotesOthers: z.boolean(),
})

export const DeliveryStatus = z.enum(['送付中', '送付済', '不明', '失敗', '取り消し'])

export const Delivery = z.object({
  attemptId: z.string(),
  target: DeliveryTarget,
  version: z.number().int(),
  status: DeliveryStatus,
  link: z.string().optional(),
  shareToken: z.string().optional(),
  visibility: Visibility,
  at: z.string(),
})

export const CaseEventType = z.enum(['created', 'transition', 'rejected', 'mode_changed', 'title_changed', 'purged'])

// 「これまでの出来事」。文は画面が wording で組み立てる
export const EventRow = z.object({
  at: z.string(),
  type: CaseEventType,
  from: CaseState.optional(),
  to: CaseState.optional(),
  event: z.string().optional(),
  by: z.string().optional(),
})

export const CaseCard = z.object({
  id: z.string(),
  title: z.string(),
  state: CaseState,
  turn: Turn,
  step: z.string(),
  mode: Mode,
  origin: Origin,
  auto: z.boolean(),
  version: z.number().int().min(0),
  revision: z.number().int().min(0),
  deadline: z.string().optional(),
  costYen: z.number().min(0), // 保存しない集計値（9.2）
  costCapYen: z.number().min(0),
  nextForPerson: z.string().optional(),
  costNote: z.string().optional(), // 費用の欄の 1 行。予約の額で確定した呼び出しがあるときだけ（9.4 (7)）
  approvalKind: ApprovalKind.optional(), // state = 承認待ち のときだけ（5.3.2）
})
export type CaseCard = z.infer<typeof CaseCard>

export const CaseView = CaseCard.extend({
  entrance: Entrance.optional(),
  entranceApproval: Approval.optional(),
  materials: z.array(Material),
  versions: z.array(Version),
  review: ReviewSummary.optional(), // 今の版の本文の判定（6.2.5 (6)）
  formatReview: ReviewSummary.optional(), // 今の版の形式の判定のうち最後のもの
  rounds: z.object({ series: z.number().int().min(1), used: z.number().int().min(0), max: z.literal(3) }),
  outlineFingerprint: z.string().optional(), // 承認待ち（kind=構成案）のとき。outline.approve に添える（4.6 (4)）
  deliveryPlan: DeliveryPlan,
  deliveries: z.array(Delivery),
  events: z.array(EventRow),
  stopReason: z.string().optional(),
})
export type CaseView = z.infer<typeof CaseView>

// eventId は画面がボタンの押下ごとに 1 つ作り、再送では同じ値を使う。expectedRevision は全部の操作に付け、
// 画面の「押せなくする」をすり抜けた二度押しを stale で弾く（5.3.1）
const action = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ eventId: z.uuid(), expectedRevision: z.number().int().min(0), type: z.literal(type), ...shape })

export const CaseAction = z.discriminatedUnion('type', [
  action('entrance.approve', {
    answers: z.record(z.string(), Answer),
    mode: Mode,
    setFingerprint: z.string(),
  }),
  action('entrance.revise', { note: z.string().min(1) }),
  action('outline.approve', { note: z.string().optional(), outlineFingerprint: z.string() }), // 4.6 (4)
  action('approval.ok', {
    marks: z.record(z.string(), z.enum(['印のまま', '削る'])),
    versionFingerprint: z.string(),
  }),
  action('approval.redo', { instruction: z.string().min(1) }),
  action('delivery.change', { targets: z.array(DeliveryTarget).min(1) }),
  action('delivery.send', { planFingerprint: z.string() }),
  action('delivery.decline', {}),
  action('delivery.add', { target: DeliveryTarget }),
  action('share.revoke', { shareToken: z.string() }),
  action('stop.case', { reason: z.string().optional() }),
  action('cancel', {}),
  action('restart_as_new', {}),
])
export type CaseAction = z.infer<typeof CaseAction>

// POST /api/cases/:id/materials。S1 は貼り付けた文だけ（6.2.4 (3)）
export const MaterialsPost = z.object({
  type: z.literal('materials.provided'),
  eventId: z.uuid(),
  expectedRevision: z.number().int().min(0),
  text: z.string().trim().min(1).max(100_000),
})
export type MaterialsPost = z.infer<typeof MaterialsPost>

// POST /api/cases/:id/actions の応答（5.2・5.3.1）
export const ActionResult = z.object({
  state: CaseState,
  turn: Turn,
  revision: z.number().int(),
  replayed: z.boolean(),
  newCaseId: z.string().optional(), // restart_as_new のときだけ。二度目も同じ id（5.7 (5)）
})
export const ActionRejected = z.object({ reason: z.enum(['stale', 'invalid_transition']), current: CaseCard })

export const Notice = z.object({
  at: z.string(),
  caseId: z.string().optional(),
  text: z.string(),
  kind: z.enum(['info', 'your_turn', 'stopped']),
})
export type Notice = z.infer<typeof Notice>

// 止めたのは本人、保存できないのはホスト。別の欄（5.7 (8)）。signIn は Claude のログインし直し待ち（6.2.3 (7)）
export const HostStatus = z.object({ stopped: z.boolean(), storageOk: z.boolean(), signIn: z.boolean() })
export type HostStatus = z.infer<typeof HostStatus>

export const CandidateCard = z.object({
  id: z.string(),
  source: Source,
  origin: z.enum(['合図', '推測', '会議']),
  confidence: Confidence.optional(),
  aiInstructionFlag: z.boolean(),
  subject: z.string(),
  from: z.string(),
  receivedAt: z.string(),
  link: z.string(),
  reason: z.string().optional(),
  summary: z.string(),
  proposal: z.object({ docType: DocType, destination: z.array(DeliveryTarget) }),
  attachmentsNeeded: z.array(z.string()).optional(),
})

export const EntranceDefaults = z.record(z.enum(['会話', 'gmail', 'slack', 'meet']), Mode)

export const HomeView = z.object({
  yourTurn: z.array(CaseCard),
  notices: z.array(Notice),
  candidates: z.object({
    signal: z.array(CandidateCard),
    meeting: z.array(CandidateCard),
    inferred: z.object({ high: z.array(CandidateCard), mid: z.array(CandidateCard), low: z.array(CandidateCard) }),
  }),
  autoStarted: z.array(CaseCard),
  active: z.array(CaseCard),
  defaults: EntranceDefaults,
  host: HostStatus,
  askSuppress: z.object({ sender: z.string(), count: z.number().int() }).optional(),
})
export type HomeView = z.infer<typeof HomeView>

export const Choice = z.object({ id: z.string(), label: z.string(), recommended: z.boolean(), why: z.string() })
export type Choice = z.infer<typeof Choice>

export const ConversationMessage = z.object({
  seq: z.number().int(),
  thread: z.string(), // 案件 id か 'lobby'
  who: Turn,
  text: z.string(),
  choices: z.array(Choice).optional(),
  choiceId: z.string().optional(),
  caseId: z.string().optional(), // この返事で依頼になった案件（T5。6.2.1 (6)）
  at: z.string(),
})
export type ConversationMessage = z.infer<typeof ConversationMessage>

// GET /api/conversation。pending は返事を作っている最中か（6.2.1 (2)）
export const ConversationView = z.object({ messages: z.array(ConversationMessage), pending: z.boolean() })
export type ConversationView = z.infer<typeof ConversationView>

// POST /api/conversation/messages。requestId は送り直しで同じ値、lastSeq は画面が見ている最後の行（6.2.1 (3)）。
// caseId 付きは案件の中で話す（6.2.2 (8)）
const said = { requestId: z.uuid(), lastSeq: z.number().int().min(0), caseId: z.string().min(1).optional() }
export const ConversationPost = z.union([
  z.strictObject({ ...said, text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ ...said, choiceId: z.string().min(1) }),
])
export type ConversationPost = z.infer<typeof ConversationPost>
export const ConversationAccepted = z.object({ seq: z.number().int(), replayed: z.boolean() })
export const ConversationRejected = z.object({ reason: z.enum(['busy', 'stopped', 'stale']) })

// 識別子の値（'openai' など）は「出さない語」の検査の対象外（11.2）
export const ApiKeyKind = z.enum(['openai', 'jev'])
export const ApiKeyStatus = z.discriminatedUnion('set', [
  z.object({ kind: ApiKeyKind, set: z.literal(false) }),
  z.object({ kind: ApiKeyKind, set: z.literal(true), last4: z.string().length(4), savedAt: z.string() }),
])
export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>

export const Settings = z.object({
  usdJpy: z.number().positive(),
  costCapYenPerCase: z.number().positive(),
  costCapYenPerMonth: z.number().positive().nullable(), // null = 未入力（P3）
  entranceDefaults: EntranceDefaults,
  signals: z.object({ gmailLabel: z.string().min(1), slackEmoji: z.string().min(1) }),
  inference: z.object({
    gmailDays: z.union([z.literal(3), z.literal(7), z.literal(14)]),
    slackChannels: z.array(z.string()),
    slackIncludeDm: z.boolean(),
    dailyLimit: z.number().int().min(0),
    showLow: z.boolean(),
    useJev: z.boolean(),
  }),
  defaultDestinations: z.record(DocType, z.array(DeliveryTarget)),
  driveFolderId: z.string().optional(),
  voiceSamples: z.array(MaterialRef),
  bind: z.string(),
  apiKeys: z.record(ApiKeyKind, ApiKeyStatus), // 読み取り専用。PUT /api/settings では無視する
})
export type Settings = z.infer<typeof Settings>

// SSE の event 名 → data の形（5.2）
export const SseData = {
  'case.changed': z.object({ caseId: z.string(), state: CaseState, turn: Turn }),
  'candidates.changed': z.object({}),
  'conversation.message': ConversationMessage,
  notice: Notice,
  'settings.changed': z.object({}),
  'connections.changed': z.object({}),
  'host.changed': HostStatus,
  resync: z.object({}), // 保持外・再起動・読めない Last-Event-ID。画面は全部取り直す（5.7 (2)）
}

// 前後の空白を落とした後で 8 文字以上、空白・改行を含まない（last4 が値の全部にならない。5.7 (7)）
export const ApiKeyInput = z.object({ value: z.string().trim().min(8).regex(/^\S+$/) })
