// 項目の点検（設計書 5.8.1・docs/implementation.md 7.6 (7)）。同系統が書いた確認項目を、項目ごとに Jev に 3 つ聞く
import type { Check } from '@libretto/shared/checks'
import type { Job, Outcome } from '../model/invoke.ts'
import { askNoul, BAND } from '../model/noul.ts'
import { expects } from './undecided.ts'

const ASK = {
  derivable: '「項目」の合格条件は、「依頼」から導ける',
  positive: '「項目」の合格条件は、肯定形の命題で書かれている',
  shapeOnly: '「項目」は、文書の種類・分量・保存先の形についてだけ述べている',
} as const

// notPositive → 下書き役に 1 回だけ書き直させる、notDerivable → 分類の材料、shapeOnly → 入口の面で書く側にも伝わる側
export type Inspection = { notPositive: string[]; notDerivable: string[]; shapeOnly: string[] }

// Jev が 1 つも答えなければ inspection は無い（点検しない）
export async function inspectChecks(
  d: { home: string; invoke: (job: Job) => Promise<Outcome> },
  a: { caseId: string; heard: string; checks: readonly Check[]; signal: AbortSignal },
): Promise<{ ok: true; inspection?: Inspection } | { ok: false; out: Extract<Outcome, { ok: false }> }> {
  const asked = await askNoul(d, {
    caseId: a.caseId,
    role: '事実係・命題',
    signal: a.signal,
    groups: a.checks.map((c) => ({
      state: { 依頼: a.heard, 項目: `${c.title} / ${expects(c)}` },
      questions: Object.fromEntries(Object.entries(ASK).map(([k, q]) => [`${c.id}:${k}`, q])),
    })),
  })
  if (!asked.ok) return asked
  if (!asked.answers.size) return { ok: true }
  const ids = (k: keyof typeof ASK, hit: (n: number) => boolean) =>
    a.checks.flatMap((c) => {
      const n = asked.answers.get(`${c.id}:${k}`)
      return n !== undefined && hit(n) ? [c.id] : []
    })
  // 0.5 は合否ではなく入口の見立ての線（5.8.1）。書く側に見せる側へ動かすのは強い答えだけ
  return {
    ok: true,
    inspection: {
      notPositive: ids('positive', (n) => n < 0.5),
      notDerivable: ids('derivable', (n) => n < 0.5),
      shapeOnly: ids('shapeOnly', (n) => n >= BAND.high),
    },
  }
}
