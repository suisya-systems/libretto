// 台帳の行 → 画面の型（docs/implementation.md 5.2・5.3）
import type {
  CaseCard,
  CaseState,
  CaseView,
  Entrance,
  EntranceDefaults,
  HomeView,
  HostStatus,
} from '@libretto/shared/api'
import type { CaseRecord } from '@libretto/shared/ledger'
import type { z } from 'zod'
import { MAX_ROUNDS, planFingerprint } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { nn, pastedCount, pastedName } from '../roles/maker.ts'

const OPEN: readonly CaseState[] = ['入口待ち', '材料待ち', '下書き中', '検品中', '承認待ち', '送付確認待ち', '送付中']

// ponytail: 設定（settings.json）を読むのは設定の Issue。それまでは 5.3 の既定の値
const CASE_CAP_YEN = 1500
// 文言は docs/ui-wording.md（9.4 (7)）
export const COST_UNKNOWN = '費用が分からなかったので予約の額で数えました'
export const DEFAULTS: z.infer<typeof EntranceDefaults> = {
  会話: '確認しながら',
  gmail: '確認しながら',
  slack: '確認しながら',
  meet: '確認しながら',
}

export function toCard(ledger: Ledger, c: CaseRecord): CaseCard {
  return {
    id: c.caseId,
    title: c.title,
    state: c.state,
    turn: c.turn,
    step: c.step,
    mode: c.mode,
    origin: c.origin,
    auto: c.auto,
    version: c.version,
    revision: c.revision,
    ...(c.deadline !== undefined && { deadline: c.deadline }),
    costYen: ledger.caseCostYen(c.caseId),
    costCapYen: CASE_CAP_YEN,
    ...(ledger.costUnknown(c.caseId) && { costNote: COST_UNKNOWN }),
    ...(c.approvalKind && { approvalKind: c.approvalKind }),
    ...(c.state === '完了' && { doneAt: doneAt(ledger, c.caseId) ?? c.updatedAt }),
  }
}

// 完了に入った最後の遷移の時刻（T26c は完了 → 完了なので from で除く）
const doneAt = (ledger: Ledger, caseId: string) =>
  ledger.listCaseEvents(caseId).findLast((e) => e.type === 'transition' && e.to === '完了' && e.from !== '完了')?.at

export function homeView(ledger: Ledger, host: HostStatus): HomeView {
  const open = ledger.listCases(OPEN).map((c) => toCard(ledger, c))
  return {
    yourTurn: open.filter((c) => c.turn === '本人'),
    notices: ledger.listNotices(20),
    // ponytail: 候補カードの一覧は拾い上げの Issue（20）で埋める。S0 では候補を作る経路が無い
    candidates: { signal: [], meeting: [], inferred: { high: [], mid: [], low: [] } },
    autoStarted: open.filter((c) => c.auto),
    active: open.filter((c) => c.turn === 'libretto'),
    defaults: DEFAULTS,
    host,
  }
}

// entrance は案件フォルダの今の組から（6.2.2 (9)。roles/entrance.ts の entranceView）。versions は versions/NN/ から（6.2.3 (8)）。
// review / formatReview は判定のファイルから（6.2.5 (6)。roles/judge.ts の reviewsOf）
export function caseView(
  ledger: Ledger,
  c: CaseRecord,
  entrance?: Entrance,
  versions: CaseView['versions'] = [],
  reviews: Pick<CaseView, 'review' | 'formatReview'> = {},
): CaseView {
  const approvals = ledger.listApprovals(c.caseId).filter((a) => !a.supersededBy)
  const approved = approvals.findLast((a) => a.gate === '入口')
  // 届け先（attempt）ごとの最新の行
  const latest = new Map(ledger.listDeliveries(c.caseId).map((d) => [d.attemptId, d]))
  const visibility = c.destination.some((t) => t.kind === 'page' && t.shared) ? 'ほかの人にも見える' : 'あなただけ'
  return {
    ...toCard(ledger, c),
    ...(entrance && { entrance }),
    // ponytail: 事実係の材料（S4）はまだ。materials は本人が貼った文だけ（6.2.4 (3)）
    ...(approved && {
      entranceApproval: { gate: '入口', by: approved.by, at: approved.at },
    }),
    materials: Array.from({ length: pastedCount(ledger, c.caseId) }, (_, i) => ({
      id: `M${nn(i + 1)}`,
      kind: '添付' as const,
      title: '貼り付けた文',
      where: `materials/${pastedName(i + 1)}`,
      status: '取り寄せ済み' as const,
    })),
    versions,
    ...reviews,
    rounds: { series: c.series, used: c.round, max: MAX_ROUNDS },
    ...(c.state === '承認待ち' &&
      c.approvalKind === '構成案' &&
      c.outlineFingerprint && { outlineFingerprint: c.outlineFingerprint }),
    deliveryPlan: {
      targets: c.destination,
      fingerprint: planFingerprint(c),
      visibility,
      overwrites: false, // v1 の届け先は上書きしない（T22）
      quotesOthers: false, // ponytail: facts.json を読む事実係の Issue（18）で埋める
    },
    deliveries: [...latest.values()].map((d) => ({
      attemptId: d.attemptId,
      target: d.target,
      version: d.version,
      status: d.status,
      ...(d.link && { link: d.link }),
      ...(d.shareToken && { shareToken: d.shareToken }),
      visibility: d.visibility,
      at: d.at,
    })),
    events: ledger.listCaseEvents(c.caseId).map((e) => ({
      at: e.at,
      type: e.type,
      ...(e.type === 'transition' && { from: e.from, to: e.to, event: e.event, by: e.by }),
      ...(e.type === 'created' && { to: e.to }),
      ...(e.type === 'rejected' && { event: e.event }),
    })),
    ...(c.stopReason && { stopReason: c.stopReason }),
  }
}
