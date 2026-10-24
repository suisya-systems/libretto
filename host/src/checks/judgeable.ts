// 判定できるものの表と機械判定（docs/implementation.md 6.2.5 (1)(2)）。下書き役の指示の列挙と 7.2 の受け入れ規則もこの表から作る。
// 関数を実装する後の Issue（15・18・19・26）はここに 1 行足す
import { Worker } from 'node:worker_threads'
import { type Check, CodeArgs, type CodeFn, type Phase } from '@libretto/shared/checks'
import type { z } from 'zod'
import { markerCheck } from '../facts/markers.ts'
import {
  align,
  blocks,
  charCount,
  compareUnits,
  ending,
  headingCount,
  pageUnits,
  paragraphs,
  plain,
  sameText,
  sections,
  sentenceLength,
  sentences,
} from './text.ts'

type PassKind = Check['pass']['kind']
// 判定の材料。page / paste は仕立ての成果物（形式の phase だけ。6.2.5 (5)）
export type FnInput = { md: string; page?: string; paste?: string }
// units は単位ごとの「はい」。timedOut は打ち切った（verdict は unable）。
// measured.gap は合格までの距離（6.2.7 (1)）。範囲で測る関数だけが書き、ほかは judge が裏返す単位の数で埋める
export type FnResult = { units: boolean[]; measured?: Record<string, number>; timedOut?: true }

type Fn<A> = {
  args: z.ZodType<A>
  example: A // 指示に載せる args の例（テストで args の zod に通す）
  unit: string
  yes: string
  pass: PassKind[]
  phase: Phase
  host?: true // ホストだけが書く（下書き役は使えない）
  run: (args: A, input: FnInput) => FnResult | Promise<FnResult>
}
const fn = <A>(f: Fn<A>) => f as Fn<unknown>

type Range = { min?: number | undefined; max?: number | undefined }
const inRange = (n: number, r: Range) => (r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max)
// 範囲から外れている量（範囲内は 0）
const outside = (n: number, r: Range) => Math.max(0, (r.min ?? n) - n, n - (r.max ?? n))
const norm = (s: string) => s.normalize('NFKC').toLowerCase()
// 見出しも段落も Markdown の記号を外して比べる（**社外**秘 も「社外秘」として数える）
const allBlocks = (md: string) =>
  blocks(md).map((b) => (b.kind === 'heading' ? plain(b.text) : b.lines.map(plain).join('\n')))
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}
const need = (v: string | undefined, name: string) => {
  if (v === undefined) throw new Error(`no ${name} output`)
  return v
}

// 一人称の表（6.2.5 (2)）。長い語から当て、allowed で始まる語は許す。
// ponytail: 「私立」「私服」のような語にも当たる。困ったら形態素で切る
export const FIRST_PERSON = [
  'わたくし',
  'われわれ',
  'わたし',
  'あたし',
  '私',
  '僕',
  'ぼく',
  '俺',
  'おれ',
  '筆者',
  '我々',
  '小生',
]
const firstPersonHits = (md: string, allowed: string, others?: string[]) => {
  const terms = [...FIRST_PERSON, ...(others ?? [])].sort((a, b) => b.length - a.length)
  const bad = new Set(others ?? FIRST_PERSON.filter((p) => !p.startsWith(allowed)))
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu')
  return [...md.matchAll(re)].filter((m) => !m[0].startsWith(allowed) && bad.has(m[0])).length
}

// 下書き役の正規表現は Worker で当て、PATTERN_MS で打ち切る（ホストの同期の処理に載せない。6.2.5 (2)）
export const PATTERN_MS = 1000
const PATTERN_WORKER = `const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.pattern, 'u')
parentPort.postMessage(workerData.texts.map((t) => re.test(t)))`
export function matchInWorker(pattern: string, texts: string[], ms = PATTERN_MS): Promise<boolean[] | 'timeout'> {
  return new Promise((resolve, reject) => {
    const w = new Worker(PATTERN_WORKER, { eval: true, workerData: { pattern, texts } })
    const t = setTimeout(() => {
      void w.terminate()
      resolve('timeout')
    }, ms)
    w.once('message', (m: boolean[]) => {
      clearTimeout(t)
      void w.terminate()
      resolve(m)
    })
    w.once('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}
// 受け入れで弾く形: u で作れない・後方参照・量指定子の入れ子（(a+)+ など）
export function patternProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'u')
  } catch {
    return '正規表現として読めません'
  }
  if (/\\[1-9]|\\k</.test(pattern)) return '後方参照は使えません'
  if (/[+*}]\)+[+*{]/.test(pattern)) return '量指定子の入れ子（(a+)+ のような形）は使えません'
  return undefined
}

export const FNS: Partial<Record<CodeFn, Fn<unknown>>> = {
  charCount: fn({
    args: CodeArgs.charCount,
    example: { min: 2200, max: 2800 },
    unit: '本文全体',
    yes: '字数（記号と空白を除く）が min 以上 max 以下',
    pass: ['all'],
    phase: '本文',
    run: (a, { md }) => {
      const chars = charCount(md)
      return { units: [inRange(chars, a)], measured: { chars, gap: outside(chars, a) } }
    },
  }),
  headingCount: fn({
    args: CodeArgs.headingCount,
    example: { min: 4, max: 5 },
    unit: '本文全体',
    yes: '見出しの数が範囲内（level を書けばそのレベルだけ数える。書かなければ題と小見出しを除いた見出し）',
    pass: ['all'],
    phase: '本文',
    run: (a, { md }) => {
      const headings = headingCount(md, a.level)
      return { units: [inRange(headings, a)], measured: { headings, gap: outside(headings, a) } }
    },
  }),
  paragraphsPerHeading: fn({
    args: CodeArgs.paragraphsPerHeading,
    example: { min: 2 },
    unit: '見出しごとの節（小見出しの下の段落も含む。題の下の前置きは入れない）',
    yes: '節の段落の数が範囲内',
    pass: ['all', 'ratio'],
    phase: '本文',
    run: (a, { md }) => ({ units: sections(md).map((s) => inRange(s.paras.length, a)) }),
  }),
  forbiddenStrings: fn({
    args: CodeArgs.forbiddenStrings,
    example: { strings: ['社外秘'] },
    unit: '段落（見出しを含む）',
    yes: 'strings のどれかを含む',
    pass: ['count'],
    phase: '本文',
    run: (a, { md }) => {
      const units = allBlocks(md).map((t) => a.strings.some((s) => norm(t).includes(norm(s))))
      return { units, measured: { hits: units.filter(Boolean).length } }
    },
  }),
  forbiddenPattern: fn({
    args: CodeArgs.forbiddenPattern,
    example: { pattern: '\\d+円' },
    unit: '段落（見出しを含む）',
    yes: '正規表現 pattern に当たる（後方参照と (a+)+ のような入れ子は使えない）',
    pass: ['count'],
    phase: '本文',
    run: async (a, { md }) => {
      const units = await matchInWorker(a.pattern, allBlocks(md))
      if (units === 'timeout') return { units: [], timedOut: true }
      return { units, measured: { hits: units.filter(Boolean).length } }
    },
  }),
  sentenceEndingRatio: fn({
    args: CodeArgs.sentenceEndingRatio,
    example: { endings: ['です', 'ます'] },
    unit: '文',
    yes: '文末（句点と閉じ括弧を除く）が endings のどれかで終わる',
    pass: ['ratio'],
    phase: '本文',
    run: (a, { md }) => {
      const units = sentences(md).map((s) => a.endings.some((e) => ending(s).endsWith(e)))
      return { units, measured: { ratio: units.length ? units.filter(Boolean).length / units.length : 0 } }
    },
  }),
  sentenceLengthMedian: fn({
    args: CodeArgs.sentenceLengthMedian,
    example: { max: 45 },
    unit: '本文全体',
    yes: '文の長さ（字数）の中央値が max 以下',
    pass: ['all'],
    phase: '本文',
    run: (a, { md }) => {
      const ls = sentences(md).map(sentenceLength)
      if (!ls.length) return { units: [false], measured: { gap: 1 } }
      const m = median(ls)
      return { units: [m <= a.max], measured: { median: m, gap: Math.max(0, m - a.max) } }
    },
  }),
  firstPersonOnly: fn({
    args: CodeArgs.firstPersonOnly,
    example: { allowed: '私' },
    unit: '本文全体',
    yes: `一人称が allowed だけ（ほかの一人称 ${FIRST_PERSON.join('・')} が出てこない。others を書けばその一覧で比べる）`,
    pass: ['all'],
    phase: '本文',
    run: (a, { md }) => {
      const hits = firstPersonHits(md, a.allowed, a.others)
      return { units: [hits === 0], measured: { hits, gap: hits } }
    },
  }),
  markerFree: fn({
    args: CodeArgs.markerFree,
    example: {},
    unit: '段落',
    yes: '翻訳調の決まった言い回し（「することができ」「において」など）が無い',
    pass: ['all', 'ratio'],
    phase: '本文',
    run: (_, { md }) => ({ units: paragraphs(md).map((b) => markerCheck(b.lines.join('\n')).hits.length === 0) }),
  }),
  // canary を当てたときの fail.system は Issue 15。S1 はほかの機械判定と同じに数える
  canary: fn({
    args: CodeArgs.canary,
    example: { token: '0123456789abcdef' },
    unit: '本文全体',
    yes: 'token を含む',
    pass: ['count'],
    phase: '本文',
    host: true,
    run: (a, { md }) => ({ units: [md.includes(a.token)] }),
  }),
  pasteSafe: fn({
    args: CodeArgs.pasteSafe,
    example: {},
    unit: '貼り付け用の成果物',
    yes: '表の行・脚注・HTML のタグ・行頭の #・** が無い',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { paste }) => {
      const t = need(paste, 'paste')
      // 表は外側の | がある行と、外側の | が無くてもよい区切りの行（--- | ---）で見る（6.2.8 (2)）
      const bad = [
        /^\s*\|.*\|\s*$/m,
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/m,
        /\[\^/,
        /<\/?[a-z][^>]*>/i,
        /^\s*#/m,
        /\*\*/,
      ].some((re) => re.test(t))
      return { units: [!bad] }
    },
  }),
  pageRoundTrip: fn({
    args: CodeArgs.pageRoundTrip,
    example: {},
    unit: 'ページの成果物',
    yes: '本文の見出し・段落・箇条書きの項目が、順番と数までそのままページに出ている',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { md, page }) => {
      const a = compareUnits(md)
      const b = pageUnits(need(page, 'page'))
      const ops = align(a, b, sameText)
      const missing = ops.filter((o) => o.op === 'removed').length
      const extra = ops.filter((o) => o.op === 'added').length
      return { units: [missing === 0 && extra === 0], measured: { missing, extra } }
    },
  }),
}

// jev の state / scope と claude の materials のうち、S1 で組み立てられるもの（6.2.5 (1)(3)）
export const JEV_STATES = ['document', 'section', 'paragraph', 'brief.audience', 'brief.mustNot'] as const
export const JEV_SCOPES = ['document', 'section', 'paragraph'] as const
export const CLAUDE_MATERIALS = ['draft', 'brief'] as const
export const DRAFTER_PHASES: readonly Phase[] = ['本文']
export const DRAFTER_FNS = (Object.keys(FNS) as CodeFn[]).filter((f) => !FNS[f]?.host)

// 7.2 の「fn が表にあり args がその関数の zod に通る」と、表で決めた組み合わせ。違反の文の一覧
export function judgeableViolations(c: Check, drafter: boolean): string[] {
  const v: string[] = []
  const j = c.judge
  if (drafter && !DRAFTER_PHASES.includes(c.phase)) v.push(`${c.id}: phase は "本文" にしてください`)
  if (j.by === 'code') {
    const f = FNS[j.fn]
    if (!f || (drafter && f.host)) {
      v.push(`${c.id}: fn "${j.fn}" は使えません。使えるのは ${DRAFTER_FNS.join(' / ')}`)
      return v
    }
    const parsed = f.args.safeParse(j.args)
    if (!parsed.success)
      v.push(
        `${c.id}: ${j.fn} の args が合いません（${parsed.error.issues.map((i) => `${i.path.join('.') || '(全体)'}: ${i.message}`).join('、')}）。例: ${JSON.stringify(f.example)}`,
      )
    if (!f.pass.includes(c.pass.kind)) v.push(`${c.id}: ${j.fn} の pass は ${f.pass.join(' か ')} にしてください`)
    if (j.fn === 'forbiddenPattern' && parsed.success) {
      const p = patternProblem((parsed.data as { pattern: string }).pattern)
      if (p) v.push(`${c.id}: pattern が使えません（${p}）`)
    }
  } else if (j.by === 'jev') {
    const bad = j.state.filter((s) => !(JEV_STATES as readonly string[]).includes(s))
    if (bad.length) v.push(`${c.id}: state の ${bad.join('、')} は使えません。使えるのは ${JEV_STATES.join(' / ')}`)
    if (!(JEV_SCOPES as readonly string[]).includes(j.scope))
      v.push(`${c.id}: scope "${j.scope}" は使えません。使えるのは ${JEV_SCOPES.join(' / ')}`)
  } else {
    const bad = j.materials.filter((m) => !(CLAUDE_MATERIALS as readonly string[]).includes(m))
    if (bad.length)
      v.push(`${c.id}: materials の ${bad.join('、')} は使えません。使えるのは ${CLAUDE_MATERIALS.join(' / ')}`)
  }
  return v
}

// 機械判定を 1 項目流す。表に無い関数・合わない args は例外（受け入れで弾いているので、起きるのは壊れた組だけ）
export async function runCode(c: Check, input: FnInput): Promise<FnResult> {
  if (c.judge.by !== 'code') throw new Error(`${c.id} is not code`)
  const f = FNS[c.judge.fn]
  if (!f) throw new Error(`no implementation for ${c.judge.fn}`)
  return f.run(f.args.parse(c.judge.args), input)
}
