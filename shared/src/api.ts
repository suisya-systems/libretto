// 画面とホストの契約（docs/implementation.md 5.2・5.3。確定範囲は 5.3.3）
// 本人に見える型の欄の名前に「出さない語」を使わない（11.2。shared/test で確かめる）
import { z } from 'zod'
import { Category, CheckId, Escalate, Mark, Phase, SourceRow, VoiceMatch } from './checks.ts'

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

// 会話・候補・画面で選ぶ保存先の種類（6.10 (3)）。pptx / xlsx / docx は手元のファイル
export const DestChoice = z.enum(['page', 'paste', 'gdoc', 'gsheet', 'gslide', 'pptx', 'xlsx', 'docx'])
export type DestChoice = z.infer<typeof DestChoice>
// 選んだ種類 → 保存先。Google の 3 つは libretto フォルダ（6.5 (3)）
export const DEST_TARGET: Record<DestChoice, DeliveryTarget> = {
  page: { kind: 'page', shared: false },
  paste: { kind: 'paste' },
  gdoc: { kind: 'gdoc', folderId: 'libretto' },
  gsheet: { kind: 'gsheet', folderId: 'libretto' },
  gslide: { kind: 'gslide', folderId: 'libretto' },
  pptx: { kind: 'file', format: 'pptx' },
  xlsx: { kind: 'file', format: 'xlsx' },
  docx: { kind: 'file', format: 'docx' },
}
export const destChoiceOf = (t: DeliveryTarget): DestChoice => (t.kind === 'file' ? t.format : t.kind)
// 表（gsheet・xlsx）とほかの保存先は混ぜない（6.10 (1)）。ページ・ドキュメント・貼り付け用は表を通さない
export const isTable = (t: DeliveryTarget) => t.kind === 'gsheet' || (t.kind === 'file' && t.format === 'xlsx')
export const mixesTables = (ts: readonly DeliveryTarget[]) => ts.some(isTable) && ts.some((t) => !isTable(t))

export const MaterialRef = z.object({
  id: z.string(),
  kind: z.enum(['出典', '声の見本', '元データ', '添付']),
  title: z.string(),
  where: z.string(),
})
export const Material = MaterialRef.extend({
  status: z.enum(['取り寄せ済み', '待ち', '開けない']),
  gathered: z.boolean().optional(), // libretto がウェブで集めた出典（6.3.3 (7)）
})

// 表 4-1 のうち仮定・モード・由来は入れない（仮定は Assumption、モードと由来は案件の行が正本。5.3.3）
export const Brief = z.object({
  docType: DocType,
  subject: z.string().min(1), // 書く内容（何について・何を入れるか）。表 4-1 に足した（6.2.3 (0)）
  // 本人に渡してほしいもの。あれば T8 で本人の番の材料待ちに入る。前の版のファイルで欄が無ければ []（6.2.4 (1)）
  wanted: z.array(z.string().trim().min(1).max(80)).max(5).default([]),
  // libretto がウェブで集める公開の情報。前の版のファイルで欄が無ければ []（6.3.3 (1)）
  gather: z.array(z.string().trim().min(1).max(80)).max(3).default([]),
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
  own: z.enum(['pass', 'fail']).optional(), // 本人の過去文書で流した結果。流していなければ無い（6.3.2 (5)）
})

// 同系統で書いた理由（別系統の鍵が無い / つながらなかった）。識別子で、画面は wording.ts で引く（6.1.3 (5)）
export const FamilyFallback = z.enum(['no_key', 'unavailable'])
export const ChecksSummary = z.object({
  count: z.number().int().min(0),
  byCategory: z.partialRecord(Category, z.number().int().min(0)),
  family: z.enum(['別系統', '同系統']),
  fallback: FamilyFallback.optional(),
  items: z.array(CheckForPerson),
  // 依頼書が「合わせる」のときだけ。docs = 取り寄せた見本の数、card = 文体カードを作れたか（6.3.2 (2)）
  voice: z.object({ docs: z.number().int().min(0), card: z.boolean() }).optional(),
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
  // Jev が答えた単位の数と、そのうち帯の中で別の読み手に回した数（7.6 (6)）
  jev: z.object({ units: z.number().int().min(1), unsure: z.number().int().min(0) }).optional(),
  escalate: Escalate.optional(), // 3 回目を待たずに上げた（6.2.7 (5)）
  voiceMatch: VoiceMatch.optional(), // 文体カードとの比べ（6.3.2 (9)）
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
  reason: z.string().optional(), // 失敗の理由（照合の食い違いを含む。6.5 (8)）
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
  target: DeliveryTarget.optional(),
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
  doneAt: z.string().optional(), // state = 完了 のときだけ。完了に入った遷移の時刻（6.2.8 (9)）
})
export type CaseCard = z.infer<typeof CaseCard>

export const CaseView = CaseCard.extend({
  entrance: Entrance.optional(),
  entranceApproval: Approval.optional(),
  materials: z.array(Material),
  gatherFailed: z.literal(true).optional(), // ウェブで集められなかった（6.3.3 (5)(7)）
  versions: z.array(Version),
  review: ReviewSummary.optional(), // 今の版の本文の判定（6.2.5 (6)）
  formatReview: ReviewSummary.optional(), // 今の版の形式の判定のうち最後のもの
  rounds: z.object({ series: z.number().int().min(1), used: z.number().int().min(0), max: z.literal(3) }),
  outlineFingerprint: z.string().optional(), // 承認待ち（kind=構成案）のとき。outline.approve に添える（4.6 (4)）
  deliveryPlan: DeliveryPlan,
  deliveries: z.array(Delivery),
  // 保存先を変える・足すときに選べる種類（Google は保存できる連携、ファイルは道具があるときだけ。表と文書は混ぜない。6.5 (3)・6.10 (3)）
  destinationChoices: z.array(DestChoice),
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

// お知らせの 1 行（6.8 (1)(3)）。id は notices.seq、path は押すと開く面。outside は画面の外へも出すか（本人の操作でなく、本人が切っていない）
export const NoticeKind = z.enum([
  'your_turn',
  'stopped',
  'done',
  'auto_started',
  'candidates',
  'started',
  'info',
  'quiet',
])
export type NoticeKind = z.infer<typeof NoticeKind>
export const Notice = z.object({
  id: z.number().int(),
  at: z.string(),
  caseId: z.string().optional(),
  text: z.string(),
  kind: NoticeKind,
  path: z.string().startsWith('/'),
  outside: z.boolean(),
})
export type Notice = z.infer<typeof Notice>
// 出来事ごとに画面の外へ出すか（設定の「お知らせ」。6.8 (1)(6)）。GET / PUT /api/settings/notices
export const NoticePrefs = z.object({
  your_turn: z.boolean(),
  stopped: z.boolean(),
  done: z.boolean(),
  auto_started: z.boolean(),
  candidates: z.boolean(),
  started: z.boolean(),
})
export type NoticePrefs = z.infer<typeof NoticePrefs>
// 通知を止める時間帯（6.8 (4)(12)）。[from, to) をホストの OS の時刻で。from > to は日をまたぐ。GET / PUT /api/settings/quiet-hours
const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const QuietHours = z.object({ from: HhMm, to: HhMm }).refine((q) => q.from !== q.to)
export type QuietHours = z.infer<typeof QuietHours>
export const QuietHoursInput = z.object({ quietHours: QuietHours.nullable() })
export type QuietHoursInput = z.infer<typeof QuietHoursInput>

// 止めたのは本人、保存できないのはホスト。別の欄（5.7 (8)）。signIn は Claude のログインし直し待ち（6.2.3 (7)）
// isolation は作り手の隔離（8.9 (5)）。入口・承認の帯と設定の面が読む（8.10 (6)）
export const Isolation = z.enum(['strong', 'weak', 'broken'])
export const HostStatus = z.object({
  stopped: z.boolean(),
  storageOk: z.boolean(),
  signIn: z.boolean(),
  isolation: Isolation,
})
export type HostStatus = z.infer<typeof HostStatus>

// GET /api/connections。隔離（8.10 (5)）と Google の連携（6.4 (7)）
export const IsolationCause = z.enum(['windows', 'tools', 'userns', 'srt', 'network'])
export type IsolationCause = z.infer<typeof IsolationCause>
export const ConnectionsView = z.object({
  isolation: z.object({
    level: Isolation,
    cause: IsolationCause.optional(),
    running: z.boolean(),
    last: z.object({ at: z.string(), verdict: z.enum(['hidden', 'visible', 'unknown']) }).optional(),
  }),
  // configured は設定の画面で OAuth クライアントを入れたか（clientSavedAt はその日時。6.4 (10)）。labelFound は最後の取り込みで見つかったか
  google: z.object({
    configured: z.boolean(),
    clientSavedAt: z.string().optional(),
    state: z.enum(['none', 'connected', 'expired']),
    email: z.string().optional(),
    label: z.string(),
    labelFound: z.boolean().optional(),
    docs: z.boolean(), // Google ドキュメントに保存できる権限があるか（無ければ連携し直しを促す。6.5 (2)）
    lastAt: z.string().optional(),
    problem: z.enum(['rate_limited', 'network', 'api_disabled']).optional(),
    docsProblem: z.literal('api_disabled').optional(), // Google Drive API が有効でない（連携のときに先に問い合わせる。6.5）
    meet: z.boolean(), // 会議メモ（Meet が作ったファイル）を読む権限があるか（無ければ連携し直しを促す。6.7 (1)）
    meetLastAt: z.string().optional(),
    meetProblem: z.enum(['rate_limited', 'network', 'api_disabled']).optional(),
  }),
  // Slack（6.6 (7)）。configured は設定の画面でトークンを入れたか。missingScopes は足りない権限の名前
  slack: z.object({
    configured: z.boolean(),
    state: z.enum(['none', 'connected', 'expired']),
    team: z.string().optional(),
    user: z.string().optional(),
    emoji: z.string(),
    missingScopes: z.array(z.string()),
    lastAt: z.string().optional(),
    problem: z.enum(['rate_limited', 'network']).optional(),
  }),
  // ファイルを作る道具（起動時の事前点検。6.10 (5)）。LibreOffice（soffice）と poppler（pdftoppm）
  tools: z.object({ soffice: z.boolean(), pdftoppm: z.boolean() }),
  // 自動検出（6.9 (6)(8)(10)）。recall は直近 30 日の合図のうち、自動検出が先に見つけていた数
  inference: z.object({
    classifiedToday: z.number().int(),
    dailyLimit: z.number().int(),
    skippedToday: z.number().int().optional(),
    lastAt: z.string().optional(),
    recall: z.object({ hit: z.number().int(), total: z.number().int() }),
    suppressions: z.array(
      z.object({ id: z.number().int(), kind: z.enum(['sender', 'channel']), label: z.string(), addedAt: z.string() }),
    ),
  }),
})
export type ConnectionsView = z.infer<typeof ConnectionsView>

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
  attachments: z.array(z.string()).optional(), // 添付の名前の全部（中身は読まない。6.4 (4)）
  account: z.string().optional(), // 取り込んだ本人のアドレス（Slack は user_id）。読み直すときの照合（6.4 (5)・6.6 (6)）
  othersPost: z.boolean().optional(), // 他人の Slack の投稿（「○○さんの投稿を資料にします」。6.6 (5)）
})
export type CandidateCard = z.infer<typeof CandidateCard>

// POST /api/candidates/:id/actions（6.4 (5)）。「内容を修正」は候補の中の会話（ConversationPost の candidateId）。低の「やっぱり残す」（keep）は作らない（6.9 (13) D）
export const DismissReason = z.enum(['依頼ではない', '自分の仕事ではない', 'もう済んだ', '拾わなくてよい'])
export const CandidateAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('proceed') }),
  z.strictObject({ type: z.literal('dismiss'), reason: DismissReason }),
])
export type CandidateAction = z.infer<typeof CandidateAction>
// askSuppress は「依頼ではない」が続いて 3 回目のときだけ（6.9 (7)）
export const AskSuppress = z.object({
  kind: z.enum(['sender', 'channel']),
  value: z.string(),
  label: z.string(),
  count: z.number().int(),
})
export type AskSuppress = z.infer<typeof AskSuppress>
export const CandidateActionResult = z.object({ caseId: z.string().optional(), askSuppress: AskSuppress.optional() })
export const DismissLow = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) })

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
  // 窓の中で読んだ会議メモのうち、候補にならなかったもの（「行動項目なし」と「見つけられません」。6.7 (5)）
  meetNotes: z.array(
    z.object({
      title: z.string(),
      heldAt: z.string(),
      link: z.string(),
      result: z.enum(['none', 'unreadable', 'notMine']),
    }),
  ),
  // 取り込み（6.4 (7)）。connected でないときは候補の欄を、候補があるときだけ出す
  intake: z.object({ connected: z.boolean(), running: z.boolean(), lastAt: z.string().optional() }),
  host: HostStatus,
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
// caseId 付きは案件の中で話す（6.2.2 (8)）。candidateId 付きは候補の中で話す（「内容を修正」。6.4 (5)）。両方は付けない
const said = {
  requestId: z.uuid(),
  lastSeq: z.number().int().min(0),
  caseId: z.string().min(1).optional(),
  candidateId: z.string().min(1).optional(),
}
const oneThread = (v: { caseId?: string | undefined; candidateId?: string | undefined }) => !(v.caseId && v.candidateId)
export const ConversationPost = z.union([
  z.strictObject({ ...said, text: z.string().trim().min(1).max(2000) }).refine(oneThread),
  z.strictObject({ ...said, choiceId: z.string().min(1) }).refine(oneThread),
])
export type ConversationPost = z.infer<typeof ConversationPost>
export const ConversationAccepted = z.object({ seq: z.number().int(), replayed: z.boolean() })
export const ConversationRejected = z.object({ reason: z.enum(['busy', 'stopped', 'stale']) })

// 識別子の値（'openai' など）は「出さない語」の検査の対象外（11.2）
// slack は Slack アプリのユーザートークン（オーナー判断 2026-10-25。6.6 (2)）
export const ApiKeyKind = z.enum(['openai', 'jev', 'slack'])
export const ApiKeyStatus = z.discriminatedUnion('set', [
  z.object({ kind: ApiKeyKind, set: z.literal(false) }),
  z.object({ kind: ApiKeyKind, set: z.literal(true), last4: z.string().length(4), savedAt: z.string() }),
])
export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>

// 自動検出（推測）の範囲・上限・表示（6.9 (10)）。dailyLimit 0 で止まる。Slack の DM は見ない（6.9 (13) A）
export const InferenceSettings = z.object({
  gmailDays: z.union([z.literal(3), z.literal(7), z.literal(14)]),
  slackChannels: z.array(z.string().regex(/^[CG][A-Z0-9]+$/)).max(20),
  dailyLimit: z.number().int().min(0).max(1000),
  showLow: z.boolean(),
  useJev: z.boolean(),
})
export type InferenceSettings = z.infer<typeof InferenceSettings>

export const Settings = z.object({
  usdJpy: z.number().positive(),
  costCapYenPerCase: z.number().positive(),
  costCapYenPerMonth: z.number().positive().nullable(), // null = 未入力（P3）
  entranceDefaults: EntranceDefaults,
  signals: z.object({ gmailLabel: z.string().min(1), slackEmoji: z.string().min(1) }),
  inference: InferenceSettings,
  defaultDestinations: z.record(DocType, z.array(DeliveryTarget)),
  driveFolderId: z.string().optional(),
  voiceSamples: z.array(MaterialRef),
  bind: z.string(),
  apiKeys: z.record(ApiKeyKind, ApiKeyStatus), // 読み取り専用。PUT /api/settings では無視する
})
export type Settings = z.infer<typeof Settings>

// POST /api/suppressions（6.9 (7)）
export const SuppressionInput = z.object({
  kind: z.enum(['sender', 'channel']),
  value: z.string().min(1).max(320),
  label: z.string().min(1).max(200),
})
export type SuppressionInput = z.infer<typeof SuppressionInput>

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
export const ApiKeyInput = z.object({
  value: z
    .string()
    .trim()
    .min(8)
    .regex(/^[\x21-\x7e]+$/),
}) // 印字できる ASCII だけ（6.1.3 (4)）

// PUT /api/connections/google/client。Google Cloud からダウンロードした JSON の中身（6.4 (10)）
export const GoogleClientInput = z.object({ json: z.string().max(20_000) })
