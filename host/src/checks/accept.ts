// 確認項目の下書きを受け入れる規則（docs/implementation.md 7.2・6.2.2 (4)）。違反の文の一覧を返し、空なら受け入れ。
// invoke の accept に渡し、zod と同じ 1 回の言い直しを使う（6.1.1 (4)）
import type { Brief } from '@libretto/shared/api'
import type { Check } from '@libretto/shared/checks'
import { judgeableViolations } from './judgeable.ts'

export const MIN_CHECKS = 5
export const MAX_CHECKS = 40
export const MIN_MINORITY = 3
const NEGATION = /ない|無い|ません|なし|無し|せず/g

// 大文字小文字・全半角を揃え、数字の桁区切りを落とす
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, '$1')
// 中身を運ぶ語: 漢字・カタカナ・英数字が 3 文字以上続く部分と、かぎ括弧・引用符の中
const RUN = /[\p{Script=Han}\p{Script=Katakana}ーa-z0-9]{3,}/gu
const QUOTED = /[「『"“]([^」』"”]{3,})[」』"”]/g
const NUMBER = /\d+(?:\.\d+)?/g

function numbersIn(s: string) {
  return [...norm(s).matchAll(NUMBER)].map((m) => Number(m[0]))
}

// judge の中の語と 100 以上の数（6.2.2 (4)）
export function judgeTerms(j: Check['judge']): { words: string[]; numbers: number[] } {
  const words = new Set<string>()
  const numbers = new Set<number>()
  const text = (s: string) => {
    const n = norm(s)
    for (const m of n.matchAll(RUN)) words.add(m[0])
    for (const m of n.matchAll(QUOTED)) if (m[1]) words.add(m[1])
    for (const x of numbersIn(s)) if (x >= 100) numbers.add(x)
  }
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (norm(v).length >= 3) words.add(norm(v))
      for (const x of numbersIn(v)) if (x >= 100) numbers.add(x)
    } else if (typeof v === 'number') {
      if (v >= 100) numbers.add(v)
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  if (j.by === 'code') walk(j.args)
  else if (j.by === 'jev') {
    text(j.proposition)
    j.state.forEach(text)
  } else text(j.question)
  return { words: [...words], numbers: [...numbers] }
}

// known: 依頼の文（書く側も依頼書で知っている語。依頼の題材の名前は漏れではない。6.2.2 (4)）
export function leaks(c: Pick<Check, 'judge' | 'summary'>, known = ''): string[] {
  const s = norm(c.summary)
  const k = norm(known)
  const { words, numbers } = judgeTerms(c.judge)
  const nums = new Set(numbersIn(c.summary))
  const kn = new Set(numbersIn(known))
  return [
    ...words.filter((w) => s.includes(w) && !k.includes(w)),
    ...numbers.filter((n) => nums.has(n) && !kn.has(n)).map(String),
  ]
}

// 否定語の当たりを、前後 6 字付きで返す（言い直しで何を直すかが分かるように）
export function negations(t: string): string[] {
  return [...t.matchAll(NEGATION)].map((m) => t.slice(Math.max(0, m.index - 6), m.index + m[0].length + 2))
}

export type ChecksShape = Pick<Brief, 'voice' | 'sources'>

export function checksViolations(
  checks: readonly Check[],
  shape: ChecksShape,
  o: { minority: boolean; known?: string },
): string[] {
  const v: string[] = []
  if (checks.length < MIN_CHECKS || checks.length > MAX_CHECKS)
    v.push(`チェック項目は ${MIN_CHECKS}〜${MAX_CHECKS} 件にしてください（いま ${checks.length} 件）`)
  checks.forEach((c, i) => {
    const want = `C${String(i + 1).padStart(2, '0')}`
    if (c.id !== want) v.push(`${i + 1} 件目の id は ${want} にしてください（C01 から連番）`)
    const leaked = leaks(c, o.known)
    if (leaked.length) v.push(`${c.id} の summary に、確かめ方の中身（${leaked.join('、')}）を書かないでください`)
    if (/[\r\n]/.test(c.summary) || c.summary.length > 80) v.push(`${c.id} の summary は 1 行・80 字以内にしてください`)
    const texts = [
      c.title,
      c.judge.by === 'jev' ? c.judge.proposition : c.judge.by === 'claude' ? c.judge.question : '',
    ]
    const neg = texts.flatMap(negations)
    if (neg.length)
      v.push(
        `${c.id} の title・proposition・question に否定語があります（${neg.map((x) => `「${x}」`).join('、')}）。「含む」「〜している」の肯定形で書き、無いことを確かめるなら pass を count の max 0 にしてください`,
      )
    if (c.category === '見た目' && c.judge.by !== 'claude')
      v.push(`${c.id}: 見た目の項目は by "claude" で書いてください`)
    if (c.canary) v.push(`${c.id}: canary はホストが足すので書かないでください`)
    v.push(...judgeableViolations(c, true))
  })
  const has = (cat: Check['category'], by: Check['judge']['by'][]) =>
    checks.some((c) => c.category === cat && by.includes(c.judge.by))
  if (!has('依頼適合', ['claude', 'jev'])) v.push('依頼適合 の項目（by "claude" か "jev"）を 1 件以上入れてください')
  if (!has('分量', ['code'])) v.push('分量 の項目（by "code"）を 1 件以上入れてください')
  if (shape.sources === '出典付き' && !has('事実', ['code', 'jev', 'claude']))
    v.push('出典付きの依頼なので、事実 の項目を 1 件以上入れてください')
  if (shape.voice === '合わせる' && !has('声', ['code', 'jev', 'claude']))
    v.push('文体を合わせる依頼なので、声 の項目を 1 件以上入れてください')
  const minority = checks.filter((c) => c.minority).length
  if (o.minority && minority < MIN_MINORITY)
    v.push(`少数派の項目（minority 付き）を ${MIN_MINORITY} 件以上入れてください（いま ${minority} 件）`)
  return v
}
