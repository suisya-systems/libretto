// 確認項目と判定の型（docs/implementation.md 7.1・7.5。確定範囲は 5.3.3）
import { z } from 'zod'

export const Category = z.enum(['事実', '依頼適合', '声', '自然さ', '構成', '分量', '禁止事項', '形式', '見た目'])
export type Category = z.infer<typeof Category>

export const CheckId = z.string().regex(/^C\d{2}$/)
export const Phase = z.enum(['本文', '形式'])
export type Phase = z.infer<typeof Phase>

// 閉じた一覧（5.3.3）。足すときはここを変える
export const StateRef = z.enum([
  'document',
  'section',
  'paragraph',
  'claim',
  'excerpt',
  'brief.audience',
  'brief.mustNot',
  'voice.firstPerson',
])
export type StateRef = z.infer<typeof StateRef>

export const CodeFn = z.enum([
  'charCount',
  'headingCount',
  'paragraphsPerHeading',
  'forbiddenStrings',
  'forbiddenPattern',
  'sourcesReachable',
  'numbersMatch',
  'sentenceEndingRatio',
  'sentenceLengthMedian',
  'firstPersonOnly',
  'markerFree',
  'pasteSafe',
  'claimsInventoried',
  'xlsxNoFormulaErrors',
  'xlsxTotalsMatch',
  'pptxNoBlankPages',
  'pageRoundTrip',
  'docsRoundTrip',
  'sheetsRoundTrip',
  'canary',
])
export type CodeFn = z.infer<typeof CodeFn>

// CodeFn ごとの args（5.3.3 で「関数を作る Issue が足す」としたもの）。足した関数だけを持つ。
// 単位・「はい」の意味・使える pass は host/src/checks/judgeable.ts の表（6.2.5 (1)(2)）
const range = z
  .object({ min: z.number().int().min(0).optional(), max: z.number().int().min(1).optional() })
  .refine((r) => r.min !== undefined || r.max !== undefined, { message: 'min か max のどちらかを書く' })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: 'min は max 以下' })
const words = z.array(z.string().min(1)).min(1)
export const CodeArgs = {
  charCount: range,
  headingCount: z
    .object({
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(), // 見出しを置かない依頼は max 0
      level: z.number().int().min(1).max(6).optional(),
    })
    .refine((r) => r.min !== undefined || r.max !== undefined, { message: 'min か max のどちらかを書く' })
    .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, { message: 'min は max 以下' }),
  paragraphsPerHeading: range,
  forbiddenStrings: z.object({ strings: words }),
  forbiddenPattern: z.object({ pattern: z.string().min(1).max(200) }),
  sentenceEndingRatio: z.object({ endings: words }),
  sentenceLengthMedian: z.object({ max: z.number().int().min(1) }),
  firstPersonOnly: z.object({ allowed: z.string().min(1), others: words.optional() }),
  markerFree: z.object({}),
  canary: z.object({ token: z.string().min(1) }),
  pasteSafe: z.object({}),
  pageRoundTrip: z.object({}),
} satisfies Partial<Record<CodeFn, z.ZodType>>

export const JevScope = z.enum(['document', 'section', 'paragraph', 'claim'])
export const ClaudeScope = z.enum(['document', 'section'])
export const ClaudeMaterial = z.enum(['draft', 'brief', 'voice', 'voice-samples', 'facts', 'images'])

const Judge = z.discriminatedUnion('by', [
  // 未確定（5.3.3）: args は CodeFn ごとのスキーマを、その関数を実装する Issue が足して狭める
  z.object({ by: z.literal('code'), fn: CodeFn, args: z.record(z.string(), z.unknown()) }),
  z.object({
    by: z.literal('jev'),
    proposition: z.string().min(1),
    state: z.array(StateRef).min(1),
    scope: JevScope,
  }),
  z.object({
    by: z.literal('claude'),
    question: z.string().min(1),
    materials: z.array(ClaudeMaterial).min(1),
    scope: ClaudeScope,
  }),
])

const Pass = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('ratio'), min: z.number().min(0).max(1) }),
  z.object({ kind: z.literal('count'), max: z.number().int().min(0) }),
])

export const Check = z.object({
  id: CheckId,
  category: Category,
  title: z.string().min(1),
  judge: Judge,
  pass: Pass,
  phase: Phase,
  summary: z.string().min(1),
  hidden: z.boolean(),
  selfReport: z.enum(['依頼に書いてある', '書いていない']),
  minority: z.object({ usual: z.string(), chosen: z.string() }).optional(),
  canary: z.literal(true).optional(),
})
export type Check = z.infer<typeof Check>

export const Mark = z.object({ claimId: z.string(), text: z.string(), where: z.string() })
export type Mark = z.infer<typeof Mark>

export const SourceRow = z.object({
  ref: z.string(),
  title: z.string(),
  verdict: z.enum(['支持', '一部支持', '支持しない', '開けない']),
  claimIds: z.array(z.string()),
})
export type SourceRow = z.infer<typeof SourceRow>

export const Verdict = z.enum(['pass', 'fail', 'unable', 'skipped'])

export const CheckResult = z
  .object({
    id: CheckId,
    verdict: Verdict,
    by: z.enum(['code', 'jev', 'claude']),
    measured: z.record(z.string(), z.number()).optional(),
    units: z
      // noul = Jev の答え、claude = Claude に回した単位（docs/implementation.md 7.6 (5)）
      .array(
        z.object({
          index: z.number().int().min(0),
          yes: z.boolean().nullable(),
          noul: z.number().optional(),
          claude: z.literal(true).optional(),
        }),
      )
      .optional(),
    reasonRef: z.string().optional(),
  })
  // skipped は流していないので、単位ごとの結果も理由文も無い（7.5）
  .refine((r) => r.verdict !== 'skipped' || (r.units === undefined && r.reasonRef === undefined), {
    message: 'skipped の結果は units / reasonRef を持たない',
  })
export type CheckResult = z.infer<typeof CheckResult>

// 判定の注記（7.5・7.6 (5)）。画面は値で引き分けて wording の文を出す
export const JEV_NOTE = '判定専用モデルは使っていません'
export const JEV_PARTIAL = '一部は判定専用モデルにつながらず、別の読み手が判定しました'

// 3 回目を待たずに本人に上げた理由（docs/implementation.md 6.2.7 (2)）
export const Escalate = z.object({ why: z.enum(['直らない', '判定できない']), checkIds: z.array(CheckId).min(1) })
export type Escalate = z.infer<typeof Escalate>

// voiceMatch は Issue 19 で足す（5.3.3）
export const Review = z
  .object({
    version: z.number().int().min(1),
    series: z.number().int().min(1),
    round: z.number().int().min(1),
    at: z.string(),
    phase: Phase,
    attempt: z.number().int().min(1),
    results: z.array(CheckResult).min(1),
    pass: z.boolean(),
    failedSummaries: z.array(z.string()),
    marks: z.array(Mark),
    sources: z.array(SourceRow),
    familyNote: z.string().optional(),
    jevNote: z.string().optional(),
    jevBand: z.tuple([z.number(), z.number()]).optional(), // Jev を使った判定の帯（7.6 (5)）
    escalate: Escalate.optional(),
  })
  .refine((r) => r.pass === r.results.every((x) => x.verdict === 'pass'), {
    message: 'pass は results が全部 pass のときだけ真',
  })
export type Review = z.infer<typeof Review>
