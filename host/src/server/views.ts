// 台帳の行 → 画面の型（docs/implementation.md 5.2・5.3）
import type {
  CandidateCard,
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

export function homeView(
  ledger: Ledger,
  host: HostStatus,
  intake: HomeView['intake'],
  meetNotes: HomeView['meetNotes'] = [],
  showLow = true,
): HomeView {
  const open = ledger.listCases(OPEN).map((c) => toCard(ledger, c))
  return {
    yourTurn: open.filter((c) => c.turn === '本人'),
    notices: ledger.listNotices(20),
    candidates: candidateLists(ledger, showLow),
    meetNotes,
    autoStarted: open.filter((c) => c.auto),
    active: open.filter((c) => c.turn === 'libretto'),
    defaults: DEFAULTS,
    intake,
    host,
  }
}

// 出したままの候補を由来と可能性で分ける。どの欄も新しい順（6.4 (7)）。showLow が false なら低を出さない（6.9 (10)）
function candidateLists(ledger: Ledger, showLow: boolean): HomeView['candidates'] {
  const lists: HomeView['candidates'] = { signal: [], meeting: [], inferred: { high: [], mid: [], low: [] } }
  const BY = { 高: 'high', 中: 'mid', 低: 'low' } as const
  for (const { candidate: c, card } of ledger.listPresentedCandidates()) {
    const v: CandidateCard = {
      id: c.candidateId,
      source: c.source,
      origin: c.origin,
      ...(c.confidence && { confidence: c.confidence }),
      aiInstructionFlag: c.aiInstructionFlag,
      ...card,
    }
    if (c.origin === '合図') lists.signal.push(v)
    else if (c.origin === '会議') lists.meeting.push(v)
    else lists.inferred[BY[c.confidence ?? '低']].push(v)
  }
  if (!showLow) lists.inferred.low = []
  return lists
}

// entrance は案件フォルダの今の組から（6.2.2 (9)。roles/entrance.ts の entranceView）。versions は versions/NN/ から（6.2.3 (8)）。
// review / formatReview は判定のファイルから（6.2.5 (6)。roles/judge.ts の reviewsOf）
export function caseView(
  ledger: Ledger,
  c: CaseRecord,
  entrance?: Entrance,
  versions: CaseView['versions'] = [],
  reviews: Pick<CaseView, 'review' | 'formatReview'> = {},
  fetched: { title: string; url: string; gathered?: boolean }[] = [],
  gatherFailed = false,
  destinationChoices: CaseView['destinationChoices'] = ['page', 'paste'],
): CaseView {
  const approvals = ledger.listApprovals(c.caseId).filter((a) => !a.supersededBy)
  const approved = approvals.findLast((a) => a.gate === '入口')
  // 届け先（attempt）ごとの最新の行
  const latest = new Map(ledger.listDeliveries(c.caseId).map((d) => [d.attemptId, d]))
  const visibility = c.destination.some((t) => t.kind === 'page' && t.shared) ? 'ほかの人にも見える' : 'あなただけ'
  return {
    ...toCard(ledger, c),
    ...(entrance && { entrance }),
    ...(approved && {
      entranceApproval: { gate: '入口', by: approved.by, at: approved.at },
    }),
    // 本人が貼った文と、T11 で取り寄せた出典（6.2.4 (3)・6.3.1 (5)。libretto が集めたものは印付き。6.3.3 (7)）。閉じて消した後は貼った文の行だけ残る
    materials: [
      ...Array.from({ length: pastedCount(ledger, c.caseId) }, (_, i) => ({
        id: `M${nn(i + 1)}`,
        kind: '添付' as const,
        title: '貼り付けた文',
        where: `materials/${pastedName(i + 1)}`,
        status: '取り寄せ済み' as const,
      })),
      ...fetched.map((s, i) => ({
        id: `S${nn(i + 1)}`,
        kind: '出典' as const,
        title: s.title,
        where: s.url,
        status: '取り寄せ済み' as const,
        ...(s.gathered && { gathered: true }),
      })),
    ],
    ...(gatherFailed && { gatherFailed: true as const }),
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
      ...(d.reason && { reason: d.reason }),
      at: d.at,
    })),
    destinationChoices,
    events: ledger.listCaseEvents(c.caseId).map((e) => ({
      at: e.at,
      type: e.type,
      ...(e.type === 'transition' && { from: e.from, to: e.to, event: e.event, by: e.by, target: e.target }),
      ...(e.type === 'created' && { to: e.to }),
      ...(e.type === 'rejected' && { event: e.event }),
    })),
    ...(c.stopReason && { stopReason: c.stopReason }),
  }
}
