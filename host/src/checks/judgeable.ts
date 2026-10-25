// 判定できるものの表と機械判定（docs/implementation.md 6.2.5 (1)(2)）。下書き役の指示の列挙と 7.2 の受け入れ規則もこの表から作る。
// 関数を実装する後の Issue（15・18・19・26）はここに 1 行足す
import { Worker } from 'node:worker_threads'
import { type Check, CodeArgs, type CodeFn, type Phase } from '@libretto/shared/checks'
import type { FactsFile, VoiceNumbers } from '@libretto/shared/ledger'
import type { z } from 'zod'
import type { DocText } from '../deliver/docx.ts'
import { safeHref } from '../deliver/page.ts'
import type { Renderer } from '../deliver/render.ts'
import { compareTables, mdTables, type Sheets, xlsxSheets } from '../deliver/xlsx.ts'
import { markerCheck } from '../facts/markers.ts'
import { endingShares, FIRST_PERSON, firstPersonOf, median, otherFirstPerson } from '../facts/voice.ts'
import {
  align,
  blocks,
  charCount,
  compareUnits,
  decode,
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
// 判定の材料。page / paste は仕立ての成果物（形式の phase だけ。6.2.5 (5)）。facts は版の事実（6.3.1 (7)）。
// brief は作り手が読む依頼書の文（目標を添えてよいかの照合。6.2.9 (2)）。voice は承認した組の文体カードの数値（6.3.2 (6)）
export type FnInput = {
  md: string
  page?: string
  paste?: string
  gdoc?: DocText // 仕立てた docx か、Google の書き出しの段落とリンク（6.5 (5)）
  sheets?: Sheets // 仕立てた xlsx か、Google の書き出しの xlsx の表（6.8 (3)(4)）
  slides?: DocText // 仕立てた pptx か、Google の書き出しの pptx の段落とリンク（6.8 (3)(4)）
  files?: { xlsx?: Buffer; pptx?: Buffer; docx?: Buffer } // 仕立てた成果物（描き出しと計算し直しの材料）
  render?: Renderer // 描き出しと計算し直し（6.8 (3)）。道具が無い・失敗は ToolFailure
  facts?: FactsFile
  brief?: string
  voice?: VoiceNumbers
}
// units は単位ごとの「はい」。timedOut は打ち切った（verdict は unable）。
// measured.gap は合格までの距離（6.2.7 (1)）。範囲で測る関数と sourcesReachable が書き、ほかは judge が裏返す単位の数で埋める。
// told は落ちたとき作り手に返す要約に添える行（目標と今の値・本文の文だけ。6.2.9）
export type FnResult = { units: boolean[]; measured?: Record<string, number>; timedOut?: true; told?: string[] }

type Fn<A> = {
  args: z.ZodType<A>
  example: A // 指示に載せる args の例（テストで args の zod に通す）
  unit: string
  yes: string
  pass: PassKind[]
  phase: Phase
  host?: true // ホストだけが書く（下書き役は使えない）
  facts?: true // 版の事実（棚卸し）が要る。judge が事実の関数の前に 1 回だけ棚卸しをする（6.3.1 (7)）
  voice?: true // 文体カードが要る。無ければ judge が unable にする（6.3.2 (6)）
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
const counted = (units: boolean[], told: string[] = []) => ({
  units,
  measured: { hits: units.filter(Boolean).length },
  ...(told.length && { told }),
})
// 字面の 10 進の数（NFKC・桁区切りを外す）
export const numbersIn = (s: string) =>
  [
    ...s
      .normalize('NFKC')
      .replace(/(\d),(?=\d{3})/g, '$1')
      .matchAll(/\d+(?:\.\d+)?/g),
  ].map((m) => Number(m[0]))

// --- 要約に添える行（6.2.9）。字数・見出しの目標は数が全部依頼書の文にあるときだけ（inBrief）、無ければ今の値だけ。
// 文体の数値（文の長さ・文末）は依頼書に無くても目標を返す（設計書 5.2 の「見せても同じ」の側）
const fmt = (n: number) => n.toLocaleString('ja-JP')
const inBrief = (r: Range, brief = '') => {
  const known = numbersIn(brief)
  return [r.min, r.max].every((x) => x === undefined || known.includes(x))
}
function told(subject: string, r: Range, unit: string, now: number, shown: boolean) {
  if (!shown) return [`${subject}今 ${fmt(now)} ${unit}です`]
  const want =
    r.min !== undefined && r.max !== undefined
      ? r.min === r.max
        ? `${fmt(r.min)} ${unit}`
        : `${fmt(r.min)}〜${fmt(r.max)} ${unit}`
      : r.min !== undefined
        ? `${fmt(r.min)} ${unit}以上`
        : `${fmt(r.max as number)} ${unit}以下`
  return [`${subject}${r.max === 0 ? '置かないで' : ` ${want}にして`}ください（今は ${fmt(now)} ${unit}）`]
}
// 主張は本文の字面と場所だけ。改行が入っても 1 行に
export const one = (s: string) => s.replace(/\s+/g, ' ').trim()
export const claimLine = (f: FactsFile, id: string) => {
  const c = f.claims.find((x) => x.id === id)
  return c ? [`「${one(c.text)}」（${one(c.where)}）`] : []
}
const need = <T>(v: T | undefined, name: string) => {
  if (v === undefined) throw new Error(`no ${name} output`)
  return v
}

export { FIRST_PERSON }

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
    let t: ReturnType<typeof setTimeout> | undefined
    // 打ち切りは Worker が動き出してから数える（起動の遅い Windows で、当てる前に打ち切らない）
    w.once('online', () => {
      t = setTimeout(() => {
        void w.terminate()
        resolve('timeout')
      }, ms)
    })
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

// コード書式の外にある、形で決まるコマンドや設定の名前（6.2.10 (3)）。コードブロック・コード書式・リンクの URL・裸の URL は外して見る。
// ponytail: 語の並びのコマンド（npm install）は形で決まらないので数えない。拾い漏れが続いたら形を足す
const NAME_SHAPES = [
  /(?<=^|\s)--?[A-Za-z][\w-]*/gm, // -p・--dry-run
  /(?<=^|[\s(（「『、])\/[a-z][\w-]*/gm, // /review
  /(?<![\w./-])[\w-]+\.(?:json|ya?ml|toml|md|sh|py|tsx?|env|ini|cfg|lock)(?![\w.])/g, // settings.json（Node.js は拾わない）
  /(?<!\w)[A-Z][A-Z0-9]*_[A-Z0-9_]+(?!\w)/g, // ANTHROPIC_API_KEY
]
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm
export function unmarkedNames(text: string): string[] {
  const t = text
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ') // ``a.json`` のような複数のバッククォートも
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ')
  return NAME_SHAPES.flatMap((re) => [...t.matchAll(re)].map((m) => m[0]))
}

export const VOICE_WIDTH = { endings: 0.15, length: [0.7, 1.3] as const }

export const FNS: Partial<Record<CodeFn, Fn<unknown>>> = {
  charCount: fn({
    args: CodeArgs.charCount,
    example: { min: 2200, max: 2800 },
    unit: '本文全体',
    yes: '字数（記号と空白を除く）が min 以上 max 以下',
    pass: ['all'],
    phase: '本文',
    run: (a, { md, brief }) => {
      const chars = charCount(md)
      return {
        units: [inRange(chars, a)],
        measured: { chars, gap: outside(chars, a) },
        ...(!inRange(chars, a) && { told: told('字数は', a, '字', chars, inBrief(a, brief)) }),
      }
    },
  }),
  headingCount: fn({
    args: CodeArgs.headingCount,
    example: { min: 4, max: 5 },
    unit: '本文全体',
    yes: '見出しの数が範囲内（level を書けばそのレベルだけ数える。書かなければ題と小見出しを除いた見出し）',
    pass: ['all'],
    phase: '本文',
    run: (a, { md, brief }) => {
      const headings = headingCount(md, a.level)
      // 数えた範囲を言う（level 3 だけの項目で見出しを全部消させない）
      const subject = a.level
        ? `\`${'#'.repeat(a.level)}\` の見出しは`
        : a.max === 0
          ? '見出しは'
          : '見出し（題と小見出しを除く）は'
      return {
        units: [inRange(headings, a)],
        measured: { headings, gap: outside(headings, a) },
        ...(!inRange(headings, a) && { told: told(subject, a, '個', headings, inBrief(a, brief)) }),
      }
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
      const hits = units.filter(Boolean).length
      // 落ちたかは judge が pass で決めるので、全部そろっていないときに添える（judge は fail のときだけ使う）
      const want = a.endings.map((e) => `「${e}」`).join('')
      return {
        units,
        measured: { ratio: units.length ? hits / units.length : 0 },
        ...(hits < units.length && {
          told: [`文末を${want}でそろえてください（今は ${units.length} 文中 ${hits} 文）`],
        }),
      }
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
      return {
        units: [m <= a.max],
        measured: { median: m, gap: Math.max(0, m - a.max) },
        ...(m > a.max && { told: told('文の長さは中央値で', { max: a.max }, '字', m, true) }),
      }
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
  unmarkedNames: fn({
    args: CodeArgs.unmarkedNames,
    example: {},
    unit: '段落（見出しを含む。コードブロックは除く）',
    yes: 'コード書式（`）の外に、コマンドや設定の名前の形（-p・--dry-run のようなオプション、/review のようなコマンド、settings.json のようなファイル名、API_KEY のような大文字と _ の名前）がある',
    pass: ['count'],
    phase: '本文',
    run: (_, { md }) => {
      const found = blocks(md.replace(/\r\n?/g, '\n').replace(FENCE, '')).map((b) =>
        unmarkedNames(b.kind === 'heading' ? b.text : b.lines.join('\n')),
      )
      const all = found.flat()
      // gap は段落でなく名前の数（同じ段落の名前を直した分が測れるように。6.2.10 (3)）
      return {
        units: found.map((x) => x.length > 0),
        measured: { hits: found.filter((x) => x.length).length, gap: all.length },
        ...(all.length && { told: [`コード書式（\`）になっていない名前: ${[...new Set(all)].join('、')}`] }),
      }
    },
  }),
  // 語が版にあれば、判定の前に作り手と判定役が fail.system(隔離の失敗) で止める（8.10 (1)）。ここは数えるだけ
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
  // 事実の 3 関数（6.3.1 (6)）。「はい」= 問題がある。0 件で合格
  claimsInventoried: fn({
    args: CodeArgs.claimsInventoried,
    example: {},
    unit: '事実の主張',
    yes: '出典にも資料にも要確認の印にも結び付いていない',
    pass: ['count'],
    phase: '本文',
    host: true,
    facts: true,
    run: (_, { facts }) => {
      const f = need(facts, 'facts')
      const bad = f.verdicts.filter((v) => v.kind === '出典なし' && !v.mark)
      return counted(
        f.verdicts.map((v) => bad.includes(v)),
        bad.flatMap((v) => claimLine(f, v.claimId)),
      )
    },
  }),
  sourcesReachable: fn({
    args: CodeArgs.sourcesReachable,
    example: {},
    unit: '本文が示した出典',
    yes: '開けない、またはそこを示す主張の該当箇所が見つからない',
    pass: ['count'],
    phase: '本文',
    host: true,
    facts: true,
    run: (_, { facts }) => {
      const f = need(facts, 'facts')
      const lost = (url: string) => f.verdicts.filter((v) => v.sourceRef === url && v.excerptFingerprint === undefined)
      const units = f.sources.map((s) => !s.opened || lost(s.url).length > 0)
      // gap は出典でなく主張で数える（同じ出典の主張を直した分が測れるように。6.2.9 (4)）
      const gap = f.sources.reduce((n, s) => n + (s.opened ? lost(s.url).length : 1), 0)
      const lines = f.sources.flatMap((s) =>
        s.opened ? lost(s.url).flatMap((v) => claimLine(f, v.claimId)) : [`開けなかった出典: ${s.url}`],
      )
      return { units, measured: { hits: units.filter(Boolean).length, gap }, ...(lines.length && { told: lines }) }
    },
  }),
  numbersMatch: fn({
    args: CodeArgs.numbersMatch,
    example: {},
    unit: '数を含む、資料から取った主張',
    yes: '資料と食い違う数がある',
    pass: ['count'],
    phase: '本文',
    host: true,
    facts: true,
    run: (_, { facts }) => {
      const f = need(facts, 'facts')
      const hasNumber = (id: string) => /\d/.test(f.claims.find((c) => c.id === id)?.text.normalize('NFKC') ?? '')
      const vs = f.verdicts.filter((v) => v.kind === '材料由来' && hasNumber(v.claimId))
      const bad = (v: (typeof vs)[number]) => (v.mismatched?.length ?? 0) > 0
      return counted(
        vs.map(bad),
        vs.filter(bad).flatMap((v) => claimLine(f, v.claimId)),
      )
    },
  }),
  // 文体カードとの距離（6.3.2 (6)）。幅は 1 人の文章の中のばらつきの目安
  voiceEndings: fn({
    args: CodeArgs.voiceEndings,
    example: {},
    unit: '本文全体',
    yes: '文体カードでいちばん多い文末の形の割合が、カードの割合より 0.15 以上は下がっていない',
    pass: ['all'],
    phase: '本文',
    host: true,
    voice: true,
    run: (_, { md, voice }) => {
      const v = need(voice, 'voice')
      const ratio = endingShares(sentences(md))[v.main]
      const target = v.endings[v.main] - VOICE_WIDTH.endings
      return { units: [ratio >= target], measured: { ratio, target, gap: Math.max(0, target - ratio) } }
    },
  }),
  voiceSentenceLength: fn({
    args: CodeArgs.voiceSentenceLength,
    example: {},
    unit: '本文全体',
    yes: '文の長さの中央値が、文体カードの中央値の 0.7〜1.3 倍',
    pass: ['all'],
    phase: '本文',
    host: true,
    voice: true,
    run: (_, { md, voice }) => {
      const target = need(voice, 'voice').sentenceLength.median
      const m = median(sentences(md).map(sentenceLength))
      const r = { min: target * VOICE_WIDTH.length[0], max: target * VOICE_WIDTH.length[1] }
      return { units: [inRange(m, r)], measured: { median: m, target, gap: outside(m, r) } }
    },
  }),
  voiceFirstPerson: fn({
    args: CodeArgs.voiceFirstPerson,
    example: {},
    unit: '本文全体',
    yes: '文体カードの一人称以外の一人称が出てこない（カードが「なし」なら一人称が出てこない）',
    pass: ['all'],
    phase: '本文',
    host: true,
    voice: true,
    run: (_, { md, voice }) => {
      const hits = otherFirstPerson(md, need(voice, 'voice').firstPerson)
      return { units: [hits === 0], measured: { hits, gap: hits } }
    },
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
    yes: '本文の見出し・段落・箇条書きの項目が、順番と数までそのままページに出ていて、出典のリンクの行き先も本文と同じ',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { md, page }) => {
      const a = compareUnits(md)
      const b = pageUnits(need(page, 'page'))
      const ops = align(a, b, sameText)
      const missing = ops.filter((o) => o.op === 'removed').length
      const extra = ops.filter((o) => o.op === 'added').length
      // 出典のリンクは判定した本文と同じ行き先を同じ順で（6.3.1 (11)）
      const want = [...md.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => safeHref(m[1]))
      const got = [...need(page, 'page').matchAll(/<a href="([^"]*)"/g)].map((m) => decode(m[1] as string))
      const links = want.length === got.length && want.every((u, i) => u === got[i]) ? 0 : 1
      return { units: [missing === 0 && extra === 0 && links === 0], measured: { missing, extra, links } }
    },
  }),
  // T20 は仕立てた docx、送付（T24 / T24b）は Google の書き出しを同じ数え方で比べる（6.5 (5)）
  docsRoundTrip: fn({
    args: CodeArgs.docsRoundTrip,
    example: {},
    unit: 'Google ドキュメントの成果物',
    yes: '本文の見出し・段落・箇条書きの項目が、順番と数までそのまま文書に出ていて、出典のリンクの行き先も本文と同じ',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { md, gdoc }) => roundTrip(md, need(gdoc, 'gdoc')),
  }),
  // 表の照合（6.8 (3)）。本文の Markdown の表と成果物の表を、表ごと・セルごとに比べる。本文に表が無ければ落とす
  sheetsRoundTrip: fn({
    args: CodeArgs.sheetsRoundTrip,
    example: {},
    unit: '表の成果物',
    yes: '本文の表がすべて、同じ順で、セルの値と式までそのまま表に入っている',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { md, sheets }) => sheetsMatch(md, need(sheets, 'sheets')),
  }),
  slidesRoundTrip: fn({
    args: CodeArgs.slidesRoundTrip,
    example: {},
    unit: 'スライドの成果物',
    yes: '本文の見出し・段落・箇条書きの項目が、順番と数までそのままスライドに出ていて、出典のリンクの行き先も本文と同じ',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: (_, { md, slides }) => roundTrip(md, need(slides, 'slides')),
  }),
  // 式が無ければ道具は要らない。式があれば LibreOffice で計算し直してエラーのセルを数える（6.8 (3)）
  xlsxNoFormulaErrors: fn({
    args: CodeArgs.xlsxNoFormulaErrors,
    example: {},
    unit: '表の成果物',
    yes: '表の式がすべて、エラーでない計算結果を返す',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: async (_, { files, render }) => {
      const xlsx = need(files?.xlsx, 'xlsx')
      const formulas = xlsxSheets(xlsx).formulas
      if (!formulas) return { units: [true], measured: { formulas, errors: 0 } }
      const errors = xlsxSheets(await need(render, 'render').recalc(xlsx)).errors
      return { units: [errors === 0], measured: { formulas, errors, gap: errors } }
    },
  }),
  pptxNoBlankPages: fn({
    args: CodeArgs.pptxNoBlankPages,
    example: {},
    unit: 'スライドを画像にしたページ',
    yes: 'ページに字や図がある',
    pass: ['all'],
    phase: '形式',
    host: true,
    run: async (_, { files, render }) => {
      const pages = await need(render, 'render').pages(need(files?.pptx, 'pptx'), 'pptx')
      return { units: pages.map((p) => !p.blank), measured: { pages: pages.length } }
    },
  }),
}

// 表の照合（T20 と送付で同じ数え方。6.8 (3)(4)）。errors は Google の書き出しが計算したエラーのセル
export function sheetsMatch(md: string, s: Sheets) {
  const want = mdTables(md)
  const r = compareTables(want, s.tables)
  const none = want.length ? 0 : 1
  return {
    units: [r.cells === 0 && r.tables === 0 && !none && s.errors === 0],
    measured: { cells: r.cells, tables: r.tables + none, errors: s.errors },
  }
}

// 本文と成果物の段落を並べ、欠けた・増えた段落と、リンクの行き先の食い違い（同じ順で同じ行き先か）を数える
export function roundTrip(md: string, d: DocText) {
  const ops = align(compareUnits(md), d.units, sameText)
  const missing = ops.filter((o) => o.op === 'removed').length
  const extra = ops.filter((o) => o.op === 'added').length
  const want = [...md.matchAll(/(?<!!)\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => safeHref(m[1]))
  const links = want.length === d.links.length && want.every((u, i) => u === d.links[i]) ? 0 : 1
  return { units: [missing === 0 && extra === 0 && links === 0], measured: { missing, extra, links } }
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

export const needsVoice = (c: Check) => c.judge.by === 'code' && !!FNS[c.judge.fn]?.voice
// 本文を voice の数え方で見た値（voiceMatch の draft。6.3.2 (9)）
export function draftVoice(md: string, main: keyof ReturnType<typeof endingShares>) {
  const ss = sentences(md)
  return { ending: endingShares(ss)[main], median: median(ss.map(sentenceLength)), firstPerson: firstPersonOf(md) }
}

// 機械判定を 1 項目流す。表に無い関数・合わない args は例外（受け入れで弾いているので、起きるのは壊れた組だけ）
export async function runCode(c: Check, input: FnInput): Promise<FnResult> {
  if (c.judge.by !== 'code') throw new Error(`${c.id} is not code`)
  const f = FNS[c.judge.fn]
  if (!f) throw new Error(`no implementation for ${c.judge.fn}`)
  return f.run(f.args.parse(c.judge.args), input)
}
