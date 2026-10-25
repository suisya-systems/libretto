// 受け入れ (5) と判定不能の帯の見直し（docs/implementation.md 7.6 (11)）、受け入れ (4) の見落とし（6.9 (9)）の測定。
// 案件フォルダとデータベースを読むだけで、何も書かず、モデルも外部も呼ばない
//   npm run measure -- codex <別系統で書いた案件 id> <同系統で書いた案件 id>
//   npm run measure -- band
//   npm run measure -- recall
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Review } from '@libretto/shared/checks'
import { ChecksFile } from '@libretto/shared/ledger'
import Database from 'better-sqlite3'
import { caseDir, resolveHome } from '../src/ledger/db.ts'
import { jst, Ledger } from '../src/ledger/ledger.ts'

const read = <T>(path: string, schema: { parse: (v: unknown) => T }) =>
  schema.parse(JSON.parse(readFileSync(path, 'utf-8')))

// --- 受け入れ (5): 別系統と同系統の確認項目と、第 1 版の本文の判定

export type CodexRow = {
  family: '別系統' | '同系統'
  checks: number
  notWritten: number // 「依頼に書いていない」項目（canary を除く）
  firstDraft?: Record<'pass' | 'fail' | 'unable' | 'skipped', number>
}

// 第 1 版を判定した組 = 最初に承認した組（承認の指紋を持つ checks*.json のうち番号の一番小さいもの）。
// 新しい組を選ぶと、入口に戻って作り直した項目と第 1 版の判定を取り合わせてしまう
export function codexRow(dir: string): CodexRow {
  const k = (f: string) => Number(/\.v(\d+)\./.exec(f)?.[1] ?? 1)
  const sets = readdirSync(join(dir, 'checks'))
    .filter((f) => /^checks(\.v\d+)?\.json$/.test(f))
    .sort((a, b) => k(a) - k(b))
    .map((f) => read(join(dir, 'checks', f), ChecksFile))
  const set = sets.find((s) => s.approvedFingerprint) ?? sets.at(-1)
  if (!set) throw new Error(`no checks in ${dir}`)
  const drafted = set.checks.filter((c) => !c.canary && c.phase === '本文')
  const path = join(dir, 'review-01-a.json')
  const r = existsSync(path) ? read(path, Review) : undefined
  const count = (v: string) => r?.results.filter((x) => x.verdict === v).length ?? 0
  return {
    family: set.family,
    checks: drafted.length,
    notWritten: drafted.filter((c) => c.selfReport === '書いていない').length,
    ...(r && {
      firstDraft: { pass: count('pass'), fail: count('fail'), unable: count('unable'), skipped: count('skipped') },
    }),
  }
}

// 比べられないときは理由を返す（系統が想定と違う・第 1 版をまだ判定していない・確かめていない項目がある）
export function codexVerdict(a: CodexRow, b: CodexRow): string | undefined {
  if (a.family !== '別系統' || b.family !== '同系統') return `系統が違います（A=${a.family}, B=${b.family}）`
  if (!a.firstDraft || !b.firstDraft) return '第 1 版の判定がまだありません'
  if (a.firstDraft.skipped || b.firstDraft.skipped)
    return '第 1 版で機械判定が落ち、まだ確かめていない項目があります。依頼を変えて出し直してください'
  return undefined
}

// --- 帯の見直し: Jev の単位の分布と、Claude に回した単位の一致

export type BandUnit = {
  caseId: string
  version: number
  checkId: string
  index: number
  noul: number
  claude: boolean
  yes: boolean | null
}

export function bandUnits(home: string): BandUnit[] {
  const root = join(home, 'cases')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((caseId) =>
    readdirSync(join(root, caseId))
      .filter((f) => /^review-\d+-(a|f\d+)\.json$/.test(f))
      .flatMap((f) => {
        const r = read(join(root, caseId, f), Review)
        return r.results.flatMap((x) =>
          (x.units ?? []).flatMap((u) =>
            u.noul === undefined
              ? []
              : [
                  {
                    caseId,
                    version: r.version,
                    checkId: x.id,
                    index: u.index,
                    noul: u.noul,
                    claude: !!u.claude,
                    yes: u.yes,
                  },
                ],
          ),
        )
      }),
  )
}

export function bandReport(units: readonly BandUnit[]) {
  const bins = Array.from(
    { length: 20 },
    (_, i) => units.filter((u) => Math.min(19, Math.floor(u.noul * 20)) === i).length,
  )
  // Claude が決めた単位だけで比べる（null は数えない）
  const decided = units.filter((u) => u.claude && u.yes !== null)
  const agree = decided.filter((u) => u.noul > 0.5 === u.yes).length
  const edges = units.filter((u) => (u.noul >= 0.25 && u.noul <= 0.35) || (u.noul >= 0.65 && u.noul <= 0.75))
  return { total: units.length, bins, decided: decided.length, agree, edges }
}

// --- 受け入れ (4): 直近 30 日に合図を付けた候補のうち、推測が先に見つけていた割合（6.9 (9)）

export function recallReport(ledger: Ledger, now: Date) {
  const since = jst(new Date(now.getTime() - 30 * 86_400_000))
  const { hit, total } = ledger.recallSince(since)
  const misses = ledger.recallMisses(since).map((m) => {
    const thread = /^gmail:(.+)$/.exec(m.candidateId)?.[1]
    return { ...m, ...(thread && { link: `https://mail.google.com/mail/#all/${thread}` }) }
  })
  return { since, hit, total, rate: total ? hit / total : undefined, misses }
}

function main(argv: string[]) {
  const home = resolveHome()
  if (argv[0] === 'codex' && argv[1] && argv[2]) {
    const [a, b] = [codexRow(caseDir(home, argv[1])), codexRow(caseDir(home, argv[2]))]
    for (const [name, r] of [
      ['A', a],
      ['B', b],
    ] as const)
      console.log(
        `${name}: ${r.family} / items ${r.checks} / not in request ${r.notWritten} / first draft ${JSON.stringify(r.firstDraft ?? null)}`,
      )
    const why = codexVerdict(a, b)
    console.log(
      why
        ? `inconclusive: ${why}`
        : `diff: not in request ${a.notWritten - b.notWritten}, failed ${(a.firstDraft?.fail ?? 0) - (b.firstDraft?.fail ?? 0)}`,
    )
    return
  }
  if (argv[0] === 'band') {
    const r = bandReport(bandUnits(home))
    console.log(`units ${r.total}`)
    for (const [i, n] of r.bins.entries()) console.log(`${(i / 20).toFixed(2)}-${((i + 1) / 20).toFixed(2)} ${n}`)
    console.log(`in band, decided by the other reader: ${r.decided}, agree with the 0.5 side: ${r.agree}`)
    console.log('edge units (open the draft and mark whether the answer is right):')
    for (const u of r.edges)
      console.log(`  ${u.caseId} v${u.version} ${u.checkId} #${u.index} noul=${u.noul.toFixed(3)}`)
    return
  }
  if (argv[0] === 'recall') {
    const db = new Database(join(home, 'libretto.db'), { readonly: true, fileMustExist: true })
    const r = recallReport(new Ledger(db), new Date())
    db.close()
    console.log(
      `since ${r.since}: ${r.hit} / ${r.total} found first${r.rate === undefined ? '' : ` (${(r.rate * 100).toFixed(1)}%)`}`,
    )
    if (r.rate !== undefined && r.rate < 0.9) console.log('below 90%: loosen the prefilter and the classifier wording')
    console.log('missed:')
    for (const m of r.misses)
      console.log(`  ${m.candidateId}${m.link ? ` ${m.link}` : ''}${m.subject ? ` ${m.subject}` : ''}`)
    return
  }
  console.log('usage: npm run measure -- codex <case A> <case B> | band | recall')
  process.exitCode = 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
