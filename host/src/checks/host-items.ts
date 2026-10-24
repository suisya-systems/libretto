// ホストが足す確認項目（docs/implementation.md 7.2 の最後の 2 行・8.4・6.2.2 (5)）。受け入れ規則を通った後に足す
import { randomBytes } from 'node:crypto'
import type { Brief, DeliveryTarget } from '@libretto/shared/api'
import type { Check } from '@libretto/shared/checks'

export const CANARY_SUMMARY = '隔離の点検'

type Item = Pick<Check, 'category' | 'title' | 'judge' | 'summary'>
const code = (fn: Extract<Check['judge'], { by: 'code' }>['fn'], title: string, summary: string): Item => ({
  category: '形式',
  title,
  judge: { by: 'code', fn, args: {} },
  summary,
})
const LOOKS: Item = {
  category: '見た目',
  title: '文字や図がすべて枠の中に収まっている',
  judge: {
    by: 'claude',
    question: '文字や図がすべて枠の中に収まっているか',
    materials: ['images'],
    scope: 'document',
  },
  summary: '枠からはみ出した文字や図があります',
}
const PAGE = code(
  'pageRoundTrip',
  'Web ページに本文の見出しと段落がそのまま表示される',
  'Web ページで本文の一部が欠けて表示されます',
)
const PASTE = code(
  'pasteSafe',
  '貼り付け用の下書きは、貼り付け先でそのまま読める文字だけでできている',
  '貼り付け用の下書きに、貼り付け先で崩れる書式が残っています',
)
const DOCS = code(
  'docsRoundTrip',
  'Google ドキュメントに保存した本文が元の本文と段落ごとに一致する',
  '保存した文書の本文が元の本文と食い違っています',
)
const SHEETS = code(
  'sheetsRoundTrip',
  'Google スプレッドシートに保存した値が元の表と一致する',
  '保存した表の値が元の表と食い違っています',
)
const FORMULAS = code('xlsxNoFormulaErrors', '表の式がすべて計算結果を返す', '表の式にエラーが出ています')
const PAGES = code(
  'pptxNoBlankPages',
  'スライドを画像にしたとき、すべてのページに内容がある',
  '中身の無いスライドがあります',
)

// 出典付きの依頼に足す事実の 4 項目（6.3.1 (6)）。機械の 3 つは「問題がある」を数えて 0 件で合格
export const SUPPORT_PROPOSITION = '「出典の抜粋」は「主張」を支持している'
const fact = (fn: 'claimsInventoried' | 'sourcesReachable' | 'numbersMatch', title: string, summary: string): Item => ({
  category: '事実',
  title,
  judge: { by: 'code', fn, args: {} },
  summary,
})
const FACTS: (Item & { pass: Check['pass'] })[] = [
  {
    ...fact(
      'claimsInventoried',
      '事実の主張がすべて、出典・資料・【要確認】のどれかに結び付いている',
      '出典も【要確認】も付いていない事実の主張があります',
    ),
    pass: { kind: 'count', max: 0 },
  },
  {
    ...fact(
      'sourcesReachable',
      '本文が示した出典がすべて開けて、主張の該当箇所が見つかる',
      '開けない出典か、主張の箇所が見つからない出典があります',
    ),
    pass: { kind: 'count', max: 0 },
  },
  {
    ...fact('numbersMatch', '資料から取った数が、資料と同じ値になっている', '資料と違う数を書いているところがあります'),
    pass: { kind: 'count', max: 0 },
  },
  {
    category: '事実',
    title: '出典や資料の該当箇所が、本文の主張を支えている',
    judge: { by: 'jev', proposition: SUPPORT_PROPOSITION, state: ['claim', 'excerpt'], scope: 'claim' },
    summary: '出典や資料が支えていない主張があります',
    pass: { kind: 'all' },
  },
]

// 文体カードとの距離の 3 項目と読み比べ（6.3.2 (6)(7)）。カードがあれば 3 項目、見本の段落があれば読み比べ
export const READ_ALIKE_QUESTION = '本文と「本人の文章の見本」を並べて読むと、同じ人が書いた文章に読める'
const voiceCode = (
  fn: 'voiceEndings' | 'voiceSentenceLength' | 'voiceFirstPerson',
  title: string,
  summary: string,
) => ({
  category: '声' as const,
  title,
  judge: { by: 'code' as const, fn, args: {} },
  summary,
  pass: { kind: 'all' as const },
  hidden: false,
  selfReport: '依頼に書いてある' as const,
})
const VOICE_CODE = [
  voiceCode('voiceEndings', '文末の形が、あなたの文体カードと同じ割合で出てくる', '文末の形が文体カードと違います'),
  voiceCode('voiceSentenceLength', '一文の長さが、あなたの文体カードに近い', '一文の長さが文体カードと違います'),
  voiceCode('voiceFirstPerson', '一人称が、あなたの文体カードと同じ', '一人称が文体カードと違います'),
]
const READ_ALIKE = {
  category: '声' as const,
  title: 'あなたの過去の文章と並べて読んでも、同じ人が書いたように読める',
  judge: {
    by: 'claude' as const,
    question: READ_ALIKE_QUESTION,
    materials: ['draft' as const, 'voice-samples' as const],
    scope: 'document' as const,
  },
  summary: 'あなたの過去の文章と書きぶりが違って読めます',
  pass: { kind: 'all' as const },
  hidden: true,
  selfReport: '書いていない' as const,
}
export type VoiceItems = { card: boolean; samples: boolean }

function itemsFor(t: DeliveryTarget): Item[] {
  switch (t.kind) {
    case 'page':
      return [PAGE]
    case 'paste':
      return [PASTE]
    case 'gdoc':
      return [DOCS]
    case 'gsheet':
      return [SHEETS, FORMULAS]
    case 'gslide':
      return [PAGES, LOOKS]
    case 'file':
      return t.format === 'pptx' ? [PAGES, LOOKS] : t.format === 'xlsx' ? [FORMULAS] : [LOOKS]
  }
}

// 下書き役の項目の後ろに、canary 1 件と（出典付きなら事実の 4 項目と）保存先ごとの形式の項目（同じものは 1 件）を足す
export function withHostItems(
  checks: readonly Check[],
  destinations: readonly DeliveryTarget[],
  token = randomBytes(16).toString('hex'),
  sources: Brief['sources'] = '出典なし',
  voice: VoiceItems = { card: false, samples: false },
): Check[] {
  const formats = [...new Set(destinations.flatMap(itemsFor))]
  const added: Omit<Check, 'id'>[] = [
    {
      category: '禁止事項',
      title: `本文に「${token}」が含まれている`,
      judge: { by: 'code', fn: 'canary', args: { token } },
      pass: { kind: 'count', max: 0 },
      phase: '本文',
      summary: CANARY_SUMMARY,
      hidden: true,
      selfReport: '書いていない',
      canary: true,
    },
    ...(voice.card ? VOICE_CODE : []).map((v) => ({ ...v, phase: '本文' as const })),
    ...(voice.samples ? [{ ...READ_ALIKE, phase: '本文' as const }] : []),
    ...(sources === '出典付き' ? FACTS : []).map((f) => ({
      ...f,
      phase: '本文' as const,
      hidden: false,
      selfReport: '依頼に書いてある' as const,
    })),
    ...formats.map((f) => ({
      ...f,
      pass: { kind: 'all' as const },
      phase: '形式' as const,
      hidden: false,
      selfReport: '依頼に書いてある' as const,
    })),
  ]
  return [...checks, ...added.map((c, i) => ({ ...c, id: `C${String(checks.length + i + 1).padStart(2, '0')}` }))]
}
