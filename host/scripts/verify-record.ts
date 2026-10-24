// 実モデル検証の記録の下書き（docs/implementation.md 11.3 (3)）。手帳と台帳から、公開してよい事実だけを Markdown にする。
// 本文・会話・依頼の題・確認項目の文・本人が「止める」に付けた文は入れない
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jst, jstMonth, type Ledger } from '../src/ledger/ledger.ts'

// 起動ごとの 1 行。検証したときの環境（記録を作り直すときの環境ではない）
export type Session = {
  at: string
  rev: string
  node: string
  platform: string
  isolation: string
  claude: string
  capYen: number
}
// <家>/verify.json
export type Notebook = { startedAt: string; month: string; capYen: number; sessions: Session[] }

const CONVERSATION = '会話'
// 費用は実額（ドル建ての換算）で小数が長いので、記録には 0.1 円まで
const yen = (n: number) => n.toFixed(1)
const MARGIN_MS = 2 * 3_600_000

export const monthOf = (d: Date) => jst(d).slice(0, 7)

// 起こしてよいか。全体上限は JST の月で区切るので、別の月の家の起こし直しと、月末間際の新しい検証は断る（11.3 (2)）
export function refusal(nb: Notebook | undefined, now: Date): string | undefined {
  if (nb) {
    return nb.month === monthOf(now)
      ? undefined
      : `this home was started in ${nb.month}. The monthly cap resets in a new month, so start a new verification.`
  }
  if (Date.parse(jstMonth(now)[1]) - now.getTime() < MARGIN_MS)
    return 'less than 2 hours left in this month (JST). The monthly cap would reset mid-run; start after midnight.'
  return undefined
}

function costTable(ledger: Ledger, caseIds: string[]) {
  const rows = new Map<string, { calls: number; yen: number }>()
  let total = 0
  let unsettled = 0
  for (const id of caseIds) {
    const costs = ledger.listCosts(id)
    const charged = new Map(costs.flatMap((c) => (c.type === 'charge' ? [[c.callId, c.yen] as const] : [])))
    for (const c of costs) {
      if (c.type !== 'hold') continue
      // 精算されていない予約（落ちた後に起こさず --report したとき）は予約の額で数える（上限の数え方と同じ。9.4 (2)）
      const yen = charged.get(c.callId) ?? c.holdYen
      if (!charged.has(c.callId)) unsettled += 1
      const r = rows.get(c.role) ?? { calls: 0, yen: 0 }
      r.calls += 1
      r.yen += yen
      rows.set(c.role, r)
      total += yen
    }
  }
  return { rows, total, unsettled }
}

// debug/ の 1 ファイル = 1 回の出力（invoke の debugDir）。中身は写さず、違反があったかだけ数える
function debugTable(debugDir: string) {
  const rows = new Map<string, { outputs: number; rejected: number }>()
  if (!existsSync(debugDir)) return rows
  for (const name of readdirSync(debugDir).filter((n) => n.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(debugDir, name), 'utf-8')) as { role: string; errors: string[] }
    const r = rows.get(d.role) ?? { outputs: 0, rejected: 0 }
    r.outputs += 1
    if (d.errors.length) r.rejected += 1
    rows.set(d.role, r)
  }
  return rows
}

export function facts(ledger: Ledger, nb: Notebook, debugDir: string): string {
  const out: string[] = []
  out.push('### 起動', '', '| 時刻 | 版 | OS | Node | 隔離 | claude | 上限（円） |', '|---|---|---|---|---|---|---|')
  for (const s of nb.sessions)
    out.push(`| ${s.at} | ${s.rev} | ${s.platform} | ${s.node} | ${s.isolation} | ${s.claude} | ${s.capYen} |`)

  const cases = ledger
    .listCases()
    .map((c) => ({ c, events: ledger.listCaseEvents(c.caseId) }))
    .sort((a, b) => (a.events[0]?.at ?? '').localeCompare(b.events[0]?.at ?? ''))
  const { rows, total, unsettled } = costTable(ledger, [CONVERSATION, ...cases.map((x) => x.c.caseId)])
  out.push('', '### 費用', '')
  out.push(`- 上限: ${nb.capYen} 円（この家の全部。始めた月 ${nb.month}）`)
  out.push(`- 使った額: ${yen(total)} 円（精算されていない予約 ${unsettled} 件を予約の額で含む）`)
  const recovered = cases.filter((x) => ledger.costUnknown(x.c.caseId)).length
  out.push(`- 再起動の精算で予約の額にした呼び出しがある案件: ${recovered} 件`)
  out.push('', '| 役割 | 回数 | 円 |', '|---|---|---|')
  for (const [role, r] of rows) out.push(`| ${role} | ${r.calls} | ${yen(r.yen)} |`)

  out.push('', '### 案件')
  cases.forEach(({ c, events }, i) => {
    const lastStop = events.findLast((e) => e.type === 'transition' && e.to === '停止')
    const stopped = lastStop?.type === 'transition' && lastStop.event === 'stop.case' ? '本人が止めた' : c.stopReason
    out.push('', `#### 案件 ${i + 1}`, '')
    out.push(
      `- 最後の状態: ${c.state}${c.state === '停止' ? `（${stopped}）` : ''}・版 ${c.version}・往復 ${c.round}・${c.mode}`,
    )
    out.push('', '| 時刻 | 出来事 | 前 → 後 | 誰 | 理由 |', '|---|---|---|---|---|')
    for (const e of events) {
      if (e.type === 'created') out.push(`| ${e.at} | 作成 | → ${e.to} | | |`)
      if (e.type === 'transition') {
        const reason = e.event === 'stop.case' ? '' : (e.reason ?? '')
        out.push(`| ${e.at} | ${e.event} | ${e.from} → ${e.to} | ${e.by} | ${reason} |`)
      }
    }
  })

  out.push('', '### 受け入れ規則に落ちた出力', '', '| 役割 | 出力 | 規則に落ちた |', '|---|---|---|')
  for (const [role, r] of debugTable(debugDir)) out.push(`| ${role} | ${r.outputs} | ${r.rejected} |`)
  return out.join('\n')
}

export const renderRecord = (template: string, factsMd: string) => template.replace('<!-- facts -->', factsMd)
