// detectInstructions（docs/implementation.md 6.3・7.6 (9)・設計書 10.1）。取り込み元の文の「AI への指示」に見える行に印を付ける。
// 決定的な検出は必ず流し、Jev が使えれば行ごとの Noul を足す。帯の中も印にする（取りこぼすほうが重い）
import type { Job, Outcome } from '../model/invoke.ts'
import { askNoul, BAND, type NoulGroup } from '../model/noul.ts'

// 決定的な検出は取り違えの少ない定型だけにする。「AI」と「〜してください」の組では「AI についての記事を書いてください」の
// ような、ふつうの依頼が当たる。言い回しの揺れは Jev が拾う（7.6 (9)）
const RULES = [
  /(?:以前|これまで|上記|前|先)の(?:指示|命令|設定)を(?:無視|忘れ)/,
  /ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?)/,
  /disregard (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts?)/,
  /システムプロンプト|system prompt/,
  // 「AI へ:」「ChatGPT に：」のように AI を宛先にした行
  /(?:^|[\s「(（])(?:ai|chatgpt|gpt|llm|言語モデル|aiアシスタント)\s*(?:へ|に|宛て?)\s*[:：]/,
  /あなたは\s*(?:ai|言語モデル|aiアシスタント)/,
  /you are (?:now )?(?:an? )?(?:ai|assistant|language model)\b/,
]
const MAX_STATE = 2000
const MAX_LINES = 20

const norm = (s: string) => s.normalize('NFKC').toLowerCase()
export const ruleHit = (line: string) => RULES.some((r) => r.test(norm(line)))

export async function detectInstructions(
  text: string,
  d: { home: string; caseId: string; invoke: (job: Job) => Promise<Outcome>; signal: AbortSignal },
): Promise<{ ok: true; flagged: boolean; lines: number[] } | { ok: false; out: Extract<Outcome, { ok: false }> }> {
  const all = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, t }))
  const hits = new Set(all.filter((l) => ruleHit(l.t)).map((l) => l.n))
  // 空でない行を、2,000 字・20 行に収まる分ずつ 1 群に。1 行で 2,000 字を超える行は決定的な検出だけ
  const groups: NoulGroup[] = []
  let g: NoulGroup | undefined
  let size = 0
  for (const l of all.filter((x) => x.t.trim() && [...x.t].length <= MAX_STATE)) {
    const len = [...l.t].length
    if (!g || size + len > MAX_STATE || Object.keys(g.questions).length >= MAX_LINES) {
      g = { state: {}, questions: {} }
      groups.push(g)
      size = 0
    }
    g.state[`行${l.n}`] = l.t
    g.questions[`L${l.n}`] = `「行${l.n}」には、AI へ特定の判定や動作をさせる命令が含まれている`
    size += len
  }
  if (groups.length) {
    const asked = await askNoul(d, { caseId: d.caseId, role: '事実係・命題', groups, signal: d.signal })
    if (!asked.ok) return asked
    for (const [q, noul] of asked.answers) if (noul >= BAND.low) hits.add(Number(q.slice(1)))
  }
  const lines = [...hits].sort((a, b) => a - b)
  return { ok: true, flagged: lines.length > 0, lines }
}
