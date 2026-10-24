// ホストが足す確認項目（docs/implementation.md 7.2 の最後の 2 行・8.4・6.2.2 (5)）。受け入れ規則を通った後に足す
import { randomBytes } from 'node:crypto'
import type { DeliveryTarget } from '@libretto/shared/api'
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

// 下書き役の項目の後ろに、canary 1 件と保存先ごとの形式の項目（同じものは 1 件）を足す
export function withHostItems(
  checks: readonly Check[],
  destinations: readonly DeliveryTarget[],
  token = randomBytes(16).toString('hex'),
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
