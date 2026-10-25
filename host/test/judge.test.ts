// 判定役の部品（docs/implementation.md 6.2.5・7.3・7.5）。本文の読み方・機械判定・集計・受け入れ規則・judge() の段取り
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Check, CodeArgs, Review } from '@libretto/shared/checks'
import type { BriefFile } from '@libretto/shared/ledger'
import { describe, expect, it } from 'vitest'
import { checksViolations } from '../src/checks/accept.ts'
import { withHostItems } from '../src/checks/host-items.ts'
import {
  DRAFTER_FNS,
  FNS,
  judgeableViolations,
  matchInWorker,
  patternProblem,
  runCode,
} from '../src/checks/judgeable.ts'
import {
  blocks,
  charCount,
  diff,
  headingCount,
  pageUnits,
  renderHtml,
  sections,
  sentences,
} from '../src/checks/text.ts'
import { initHome } from '../src/ledger/db.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { createInvoke } from '../src/model/invoke.ts'
import { CHECK_EXAMPLES } from '../src/roles/entrance.ts'
import {
  escalateOf,
  FAMILY_NOTE,
  flipsToPass,
  JEV_NOTE,
  JUDGE_EXAMPLE,
  JUDGE_INSTRUCTION,
  JudgeReply,
  judge,
  parseReasons,
  replyViolations,
  verdictOf,
} from '../src/roles/judge.ts'
import { goodChecks } from './fixtures/entrance.ts'

const code = (fn: string, args: Record<string, unknown>, pass: Check['pass'], phase: Check['phase'] = '本文'): Check =>
  ({
    id: 'C01',
    category: '分量',
    title: 't',
    judge: { by: 'code', fn, args },
    pass,
    phase,
    summary: 's',
    hidden: false,
    selfReport: '依頼に書いてある',
  }) as Check
const run = (c: Check, md: string, extra: { page?: string; paste?: string; brief?: string } = {}) =>
  runCode(c, { md, ...extra })

const DOC = `# 題

前置きの段落です。

## 一つ目

段落 A です。とても短い。

段落 B です！

## 二つ目

- 項目 1
- 項目 2
`

describe('本文の読み方（6.2.5 (2)）', () => {
  it('ブロック・節・文・字数・見出し', () => {
    expect(blocks(DOC).map((b) => b.kind)).toEqual(['heading', 'para', 'heading', 'para', 'para', 'heading', 'para'])
    // 題の下の前置きは節に入れない
    expect(sections(DOC).map((s) => [s.heading, s.paras.length])).toEqual([
      ['一つ目', 2],
      ['二つ目', 1],
    ])
    // 依頼の「見出し」は題を除いた一番上のレベル。小見出しは数えず、その段落は上の節に入れる（実ホストの確認で落ちた形）
    const nested =
      '# 題\n\n前置き。\n\n## 案\n\n導入。\n\n### 案 1\n\n説明 1。\n\n### 案 2\n\n説明 2。\n\n## まとめ\n\nA。\n\nB。'
    expect(headingCount(nested)).toBe(2)
    expect(headingCount(nested, 3)).toBe(2)
    expect(sections(nested).map((s) => [s.heading, s.paras.length])).toEqual([
      ['案', 3],
      ['まとめ', 2],
    ])
    // 見出しの無い本文は全体で 1 節。題だけの見出しは節に数えない
    expect(sections('段落だけ。\n\n二つ目。').map((s) => s.paras.length)).toEqual([2])
    expect(sections('# 題\n\n## 節\n\n本文。').map((s) => s.heading)).toEqual(['節'])
    // 題でない空の節は残す
    expect(sections('## 要る節\n\n## 次\n\n本文。').map((s) => [s.heading, s.paras.length])).toEqual([
      ['要る節', 0],
      ['次', 1],
    ])
    expect(sentences(DOC)).toContain('とても短い。')
    // 句点の後の閉じ括弧は前の文に付ける
    expect(sentences('「例です。」と言った。次の文！')).toEqual(['「例です。」', 'と言った。', '次の文！'])
    // 記号・空白・リンクの URL を数えない
    expect(charCount('# あい\n\n- う え\n\n[お](https://example.com) **か**')).toBe(6)
    // 先頭の # が 1 つだけなら題として数えない。level を書けばそのレベルだけ
    expect(headingCount(DOC)).toBe(2)
    expect(headingCount(DOC, 1)).toBe(1)
    expect(headingCount('# A\n\n# B\n')).toBe(2)
  })

  it('承認の面の本文は Markdown から組み立て、文字は全部エスケープ', () => {
    const html = renderHtml('# <script>alert(1)</script>\n\n**強調** と <img src=x onerror=alert(1)>\n\n1. 一\n2. 二')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<strong>強調</strong>')
    expect(html).toContain('<ol><li>一</li><li>二</li></ol>')
  })

  it('差分: 同じブロックは返さず、挟まった消えた・増えたは changed に組む', () => {
    expect(diff('# 題\n\nA\n\nB\n\nC', '# 題\n\nA\n\nB2\n\nC\n\nD')).toEqual([
      { kind: 'changed', before: 'B', after: 'B2' },
      { kind: 'added', after: 'D' },
    ])
    expect(diff('A\n\nB', 'A')).toEqual([{ kind: 'removed', before: 'B' }])
    expect(diff('A', 'A')).toEqual([])
  })

  it('ページのブロックは文字参照を戻す', () => {
    expect(pageUnits('<h1 class="x">A &amp; B</h1><p>一<br>二</p><ul><li>&#x3042;</li></ul>')).toEqual([
      'A & B',
      '一二',
      'あ',
    ])
  })
})

describe('機械判定（6.2.5 (2)）', () => {
  it('charCount・headingCount は範囲、measured に測った値', async () => {
    expect(await run(code('charCount', { min: 5, max: 10 }, { kind: 'all' }), 'あいうえお')).toEqual({
      units: [true],
      measured: { chars: 5, gap: 0 },
    })
    expect((await run(code('charCount', { max: 4 }, { kind: 'all' }), 'あいうえお')).units).toEqual([false])
    expect((await run(code('headingCount', { min: 2, max: 2 }, { kind: 'all' }), DOC)).units).toEqual([true])
    expect(FNS.headingCount?.args.safeParse({ max: 0 }).success).toBe(true)
    expect((await run(code('headingCount', { max: 0 }, { kind: 'all' }), '本文だけ。')).units).toEqual([true])
  })

  it('数える項目は落ちたときだけ、目標と今の値を 1 行添える（字数・見出しの目標は依頼書にあるときだけ。6.2.9 (2)）', async () => {
    const DOC2 = '書きます。書いた。読みます。読んだ。'
    const brief = '- 分量・形: 1,800〜2,200 字、見出し 4〜6、文は 45 字以内'
    const told = async (fn: string, args: Record<string, unknown>, md: string, b = brief) =>
      (await run(code(fn, args, { kind: 'all' }), md, { brief: b })).told
    const long = 'あ'.repeat(3628)
    expect(await told('charCount', { min: 1800, max: 2200 }, long)).toEqual([
      '字数は 1,800〜2,200 字にしてください（今は 3,628 字）',
    ])
    // 依頼書に無い数の目標は書かず、今の値だけ
    expect(await told('charCount', { min: 1900, max: 2200 }, long)).toEqual(['字数は今 3,628 字です'])
    expect(await told('charCount', { min: 1800 }, 'あ')).toEqual(['字数は 1,800 字以上にしてください（今は 1 字）'])
    expect(await told('charCount', { max: 2200 }, long)).toEqual(['字数は 2,200 字以下にしてください（今は 3,628 字）'])
    // 通っていれば何も添えない
    expect(await told('charCount', { max: 2200 }, 'あ')).toBeUndefined()
    const seven = Array.from({ length: 7 }, (_, i) => `## 見出し${i}\n\n段落。`).join('\n\n')
    expect(await told('headingCount', { min: 4, max: 6 }, `# 題\n\n${seven}\n\n### 小見出し`)).toEqual([
      '見出し（題と小見出しを除く）は 4〜6 個にしてください（今は 7 個）',
    ])
    expect(await told('headingCount', { min: 6, max: 6 }, seven)).toEqual([
      '見出し（題と小見出しを除く）は 6 個にしてください（今は 7 個）',
    ])
    // level を書いた項目はそのレベルを言う（level 3 の項目で見出しを全部消させない）
    expect(await told('headingCount', { max: 0, level: 3 }, `${seven}\n\n### 小`, '見出し 0')).toEqual([
      '`###` の見出しは置かないでください（今は 1 個）',
    ])
    expect(await told('headingCount', { max: 0 }, seven, '見出しは 0')).toEqual([
      '見出しは置かないでください（今は 7 個）',
    ])
    // 文体の数値は依頼書に無くても目標を返す（設計書 5.2 の「見せても同じ」。オーナー判断 2026-10-25）
    expect(await told('sentenceLengthMedian', { max: 50 }, `${'あ'.repeat(90)}。`, '')).toEqual([
      '文の長さは中央値で 50 字以下にしてください（今は 91 字）',
    ])
    expect(
      (await run(code('sentenceEndingRatio', { endings: ['です', 'ます'] }, { kind: 'ratio', min: 0.9 }), DOC2)).told,
    ).toEqual(['文末を「です」「ます」でそろえてください（今は 4 文中 2 文）'])
    expect(
      (await run(code('sentenceEndingRatio', { endings: ['です'] }, { kind: 'ratio', min: 0.9 }), 'です。')).told,
    ).toBeUndefined()
    // 文が無ければ中央値が無いので添えない
    expect(await told('sentenceLengthMedian', { max: 45 }, '# 題だけ')).toBeUndefined()
    // 依頼書が無ければ（judge の外から流したとき）今の値だけ
    expect((await run(code('charCount', { max: 2 }, { kind: 'all' }), 'あいう')).told).toEqual(['字数は今 3 字です'])
  })

  it('禁止語は「含む」を数えて count の max 0（反転しない）: 含む段落 3 → 不合格、0 → 合格', async () => {
    const c = code('forbiddenStrings', { strings: ['アクメ社'] }, { kind: 'count', max: 0 })
    const bad = await run(c, 'アクメ社です。\n\nアクメ社。\n\n## ｱｸﾒ社\n\n無関係。')
    expect(bad.measured).toEqual({ hits: 3 })
    expect(verdictOf(c.pass, bad.units)).toBe('fail')
    // 強調で分けても含むと数える
    expect((await run(c, '**アクメ**社の話。')).units).toEqual([true])
    const good = await run(c, '社名は出しません。\n\n無関係。')
    expect(verdictOf(c.pass, good.units)).toBe('pass')
  })

  it('段落ごと・文ごと・中央値・一人称・マーカー', async () => {
    expect((await run(code('paragraphsPerHeading', { min: 2 }, { kind: 'all' }), DOC)).units).toEqual([true, false])
    const ending = await run(code('sentenceEndingRatio', { endings: ['です'] }, { kind: 'ratio', min: 0.5 }), DOC)
    expect(ending.units.filter(Boolean).length).toBeGreaterThan(0)
    expect(
      (await run(code('sentenceLengthMedian', { max: 3 }, { kind: 'all' }), 'あいう。あいうえお。')).measured,
    ).toEqual({
      median: 5, // 句点も 1 字（4 と 6）
      gap: 2,
    })
    // 文が無ければ不合格
    expect((await run(code('sentenceLengthMedian', { max: 3 }, { kind: 'all' }), '# 題だけ')).units).toEqual([false])
    const fp = code('firstPersonOnly', { allowed: '私' }, { kind: 'all' })
    expect((await run(fp, '私たちは、私の考えを書きます。')).units).toEqual([true])
    expect((await run(fp, '私は書く。僕も書く。')).measured).toEqual({ hits: 1, gap: 1 })
    expect(
      (await run(code('firstPersonOnly', { allowed: '僕' }, { kind: 'all' }), '私はそう考えます。')).units,
    ).toEqual([false])
    expect(
      (await run(code('markerFree', {}, { kind: 'all' }), '説明することができる。\n\nふつうの文。')).units,
    ).toEqual([false, true])
  })

  it('正規表現は Worker で当て、戻らなければ打ち切って unable', async () => {
    const c = code('forbiddenPattern', { pattern: '\\d+円' }, { kind: 'count', max: 0 })
    expect((await run(c, '1200円です。\n\n無料。')).units).toEqual([true, false])
    expect(await matchInWorker('^(a+)+$', [`${'a'.repeat(40)}b`], 100)).toBe('timeout')
    // 受け入れで弾く形
    expect(patternProblem('(a+)+$')).toContain('入れ子')
    expect(patternProblem('(a)\\1')).toContain('後方参照')
    expect(patternProblem('[')).toContain('読めません')
    expect(patternProblem('\\d+円')).toBeUndefined()
  })

  it('形式: pageRoundTrip は順番と数まで、pasteSafe は崩れる書式', async () => {
    const md = '# 題\n\nAlpha\n\nBeta\n\nAlpha\n\n- 一\n- 二'
    const page = (body: string) => run(code('pageRoundTrip', {}, { kind: 'all' }, '形式'), md, { page: body })
    expect((await page('<h1>題</h1><p>Alpha</p><p>Beta</p><p>Alpha</p><ul><li>一</li><li>二</li></ul>')).units).toEqual(
      [true],
    )
    // 欠け・順番違い・余り
    expect((await page('<h1>題</h1><p>Beta</p><p>Alpha</p><ul><li>一</li><li>二</li></ul>')).measured).toEqual({
      missing: 1,
      extra: 0,
      links: 0,
    })
    expect(
      (await page('<h1>題</h1><p>Alpha</p><p>Beta</p><p>Alpha</p><ul><li>一</li><li>二</li></ul><p>余り</p>')).units,
    ).toEqual([false])
    const paste = (t: string) => run(code('pasteSafe', {}, { kind: 'all' }, '形式'), md, { paste: t })
    expect((await paste('題\n\n本文')).units).toEqual([true])
    for (const bad of ['| a | b |', '本文[^1]', '<b>x</b>', '# 題', '**強調**'])
      expect((await paste(bad)).units).toEqual([false])
  })

  it('コード書式の外のコマンドや設定の名前を数え、名前を添える（6.2.10 (3)）', async () => {
    const names = (md: string) => run(code('unmarkedNames', {}, { kind: 'count', max: 0 }), md)
    const bad = await names(
      [
        '# 題',
        '',
        '## /review の使い方',
        '',
        '--dry-run と -p を付け、settings.json の ANTHROPIC_API_KEY を見ます。（/stop でも止まる）',
        '',
        '`--ok` と `x.json` は書式付き。Node.js・設定.json・2-3 件・A/B・[説明](https://e.com/a.json) は名前ではない。',
        '',
        '```sh',
        'claude --inside-fence',
        '```',
      ].join('\n'),
    )
    expect(bad.units).toEqual([false, true, true, false])
    expect(bad.measured).toEqual({ hits: 2, gap: 6 })
    expect(bad.told).toEqual([
      'コード書式（`）になっていない名前: /review、--dry-run、-p、/stop、settings.json、ANTHROPIC_API_KEY',
    ])
    const ok = await names('`--dry-run` を付けます。')
    expect([ok.units, ok.told]).toEqual([[false], undefined])
    // 同じ段落の名前を直した分が gap で測れる
    expect((await names('--a --b --c')).measured?.gap).toBe(3)
    expect((await names('`--a` `--b` --c')).measured?.gap).toBe(1)
    expect(DRAFTER_FNS).toContain('unmarkedNames')
  })

  it('表の例は args の zod に通る', () => {
    for (const [fn, f] of Object.entries(FNS)) {
      expect(f.args.safeParse(f.example).success, fn).toBe(true)
      expect(CodeArgs[fn as keyof typeof CodeArgs]).toBe(f.args)
    }
  })
})

describe('集計（6.2.5 (3)）', () => {
  it('all / ratio / count と、単位 0 個', () => {
    expect(verdictOf({ kind: 'all' }, [true, true])).toBe('pass')
    expect(verdictOf({ kind: 'all' }, [true, false])).toBe('fail')
    expect(verdictOf({ kind: 'ratio', min: 0.5 }, [true, false])).toBe('pass')
    expect(verdictOf({ kind: 'count', max: 1 }, [true, false])).toBe('pass')
    expect(verdictOf({ kind: 'all' }, [])).toBe('fail')
    expect(verdictOf({ kind: 'ratio', min: 0 }, [])).toBe('fail')
    expect(verdictOf({ kind: 'count', max: 0 }, [])).toBe('pass')
  })
  it('null は結論が変わらなければその結論、変われば unable', () => {
    expect(verdictOf({ kind: 'count', max: 0 }, [true, null])).toBe('fail')
    expect(verdictOf({ kind: 'all' }, [false, null])).toBe('fail')
    expect(verdictOf({ kind: 'all' }, [true, null])).toBe('unable')
    expect(verdictOf({ kind: 'ratio', min: 0.5 }, [true, true, null])).toBe('pass')
    expect(verdictOf({ kind: 'count', max: 1 }, [true, null])).toBe('unable')
  })
})

describe('3 回目を待たずに上げる（6.2.7）', () => {
  it('合格までの距離: 範囲の両側、裏返す単位の数、単位 0 個', async () => {
    const chars = async (args: Record<string, unknown>, md: string) =>
      (await run(code('charCount', args, { kind: 'all' }), md)).measured?.gap
    expect(await chars({ min: 10 }, 'あいう')).toBe(7)
    expect(await chars({ max: 2 }, 'あいう')).toBe(1)
    expect(await chars({ min: 1, max: 5 }, 'あいう')).toBe(0)
    expect(flipsToPass({ kind: 'all' }, [true, false, false])).toBe(2)
    expect(flipsToPass({ kind: 'count', max: 1 }, [true, true, true])).toBe(2)
    expect(flipsToPass({ kind: 'ratio', min: 0.5 }, [true, true])).toBe(0)
    // ceil(min × 単位数) だと浮動小数で両方 3 になる組（設計レビュー）。verdictOf と同じ述語で数える
    const ys = (yes: number, n: number) => Array.from({ length: n }, (_, i) => i < yes)
    expect(flipsToPass({ kind: 'ratio', min: 0.14 }, ys(11, 93))).toBe(3)
    expect(flipsToPass({ kind: 'ratio', min: 0.14 }, ys(12, 100))).toBe(2)
    expect(flipsToPass({ kind: 'all' }, [])).toBe(1)
    expect(flipsToPass({ kind: 'ratio', min: 0.5 }, [])).toBe(1)
    expect(flipsToPass({ kind: 'count', max: 0 }, [])).toBe(0)
  })

  const res = (id: string, verdict: 'pass' | 'fail' | 'unable' | 'skipped', gap?: number) =>
    ({ id, verdict, by: 'code', ...(gap !== undefined && { measured: { gap } }) }) as Review['results'][number]
  const prev = (results: Review['results']) =>
    Review.parse({
      version: 1,
      series: 1,
      round: 1,
      at: 'x',
      phase: '本文',
      attempt: 1,
      results,
      pass: false,
      failedSummaries: ['s'],
      marks: [],
      sources: [],
    })
  it('落ちている項目のどれも近づいていなければ直らない（1 つでも近づけば上げない。6.2.7 (2)）', () => {
    const before = prev([res('C01', 'fail', 110), res('C03', 'fail', 2)])
    const now = (c01: number, c03: number) => ({
      results: [res('C01', 'fail', c01), res('C03', 'fail', c03)],
      pass: false,
      failedSummaries: ['a', 'b'],
      round: 2,
    })
    // C03 が近づいたので、C01 が遠のいても続ける（オーナー判断 2026-10-25）
    expect(escalateOf(now(331, 1), before)).toBeUndefined()
    expect(escalateOf(now(331, 2), before)).toEqual({ why: '直らない', checkIds: ['C01', 'C03'] })
    expect(escalateOf(now(110, 2), before)).toEqual({ why: '直らない', checkIds: ['C01', 'C03'] })
    // 前に落ちていた項目が合格したのも近づいた側（実ホストの C01・C20）
    const passed = { ...now(331, 2), results: [res('C01', 'fail', 331), res('C03', 'pass', 0)] }
    expect(escalateOf(passed, before)).toBeUndefined()
    // 前に通っていて今回落ちた項目は「近づいた」に数えない
    expect(
      escalateOf(
        { ...now(110, 2), results: [...now(110, 2).results, res('C05', 'fail', 1)] },
        prev([...before.results, res('C05', 'pass', 0)]),
      ),
    ).toEqual({ why: '直らない', checkIds: ['C01', 'C03'] })
    expect(escalateOf(now(50, 1), before)).toBeUndefined()
    expect(escalateOf(now(331, 2), undefined)).toBeUndefined() // 前の判定が無い（1 回目・系列が違う）
    expect(escalateOf({ ...now(331, 2), round: 3 }, before)).toBeUndefined() // 3 回目は往復上限
    // 前の判定で通っていた項目は「2 回続けて」ではない
    expect(escalateOf(now(331, 1), prev([res('C01', 'pass', 0), res('C03', 'fail', 2)]))).toBeUndefined()
  })
  it('作り手に返す要約が 0 件なら判定できない（skipped が残っても）', () => {
    const r = { results: [res('C01', 'unable'), res('C02', 'skipped')], pass: false, failedSummaries: [], round: 1 }
    expect(escalateOf(r)).toEqual({ why: '判定できない', checkIds: ['C01'] })
    expect(escalateOf({ ...r, pass: true, results: [res('C01', 'pass', 0)] })).toBeUndefined()
  })
})

describe('受け入れ規則: 判定できるものに揃える（6.2.5 (1)）', () => {
  const v = (patch: Partial<Check>) =>
    judgeableViolations({ ...(goodChecks[0] as Check), ...patch } as Check, true).join()
  it('表に無い関数・ホストだけの関数・args・pass・phase', () => {
    expect(v({ judge: { by: 'code', fn: 'sourcesReachable', args: {} } })).toContain('使えません')
    expect(v({ judge: { by: 'code', fn: 'canary', args: { token: 'x' } } })).toContain('使えません')
    expect(v({ judge: { by: 'code', fn: 'charCount', args: { minimum: 3 } } })).toContain('args が合いません')
    expect(v({ judge: { by: 'code', fn: 'charCount', args: { min: 3 } }, pass: { kind: 'count', max: 0 } })).toContain(
      'pass は all',
    )
    expect(v({ phase: '形式' })).toContain('phase')
    expect(
      v({ judge: { by: 'code', fn: 'forbiddenPattern', args: { pattern: '(a+)+' } }, pass: { kind: 'count', max: 0 } }),
    ).toContain('入れ子')
  })
  it('jev の state / scope と claude の materials', () => {
    expect(v({ judge: { by: 'jev', proposition: 'p', state: ['claim'], scope: 'paragraph' } })).toContain('state')
    expect(v({ judge: { by: 'jev', proposition: 'p', state: ['paragraph'], scope: 'claim' } })).toContain('scope')
    expect(v({ judge: { by: 'claude', question: 'q', materials: ['voice'], scope: 'document' } })).toContain(
      'materials',
    )
  })
  it('ホストが足す項目は、ホストとしては通る', () => {
    const all = withHostItems(goodChecks, [{ kind: 'page', shared: false }, { kind: 'paste' }], 'tok')
    for (const c of all) expect(judgeableViolations(c, false)).toEqual([])
  })
  it('指示の例と fixture の組は規則に通る', () => {
    expect(checksViolations(goodChecks, { voice: '合わせない', sources: '出典なし' }, { minority: true })).toEqual([])
    for (const c of CHECK_EXAMPLES) expect(judgeableViolations(c, true)).toEqual([])
    expect(DRAFTER_FNS).not.toContain('canary')
    expect(DRAFTER_FNS).not.toContain('pageRoundTrip')
  })
})

describe('judge() の段取り（7.3）', () => {
  const brief = {
    docType: '記事',
    subject: 's',
    wanted: [],
    gather: [],
    audience: '一般の読者',
    destinations: [{ kind: 'page', shared: false }],
    shape: '短く',
    materials: [],
    voice: '合わせない',
    sources: '出典なし',
    mustNot: [],
    assumptions: [],
    decisions: [],
  } as BriefFile
  const setup = (script: ScriptEntry[]) => {
    const ledger = initHome(mkdtempSync(join(tmpdir(), 'libretto-judge-')))
    const fake = createFake(script)
    const invoke = createInvoke({
      ledger,
      backends: { claude: fake.backend },
      caps: () => ({ caseCapYen: null, monthCapYen: null }),
      onCostCap: () => {},
      log: () => {},
    })
    return { fake, invoke }
  }
  const md = `# 題\n\n${'あ'.repeat(2300)}\n\n## 一\n\n段落。\n\n## 二\n\n段落。\n\n## 三\n\n段落。\n\n## 四\n\n段落。`
  const input = {
    caseId: '推測',
    phase: '本文' as const,
    brief,
    family: '同系統' as const,
    signal: new AbortController().signal,
  }

  it('機械判定が落ちたら Claude を呼ばず、モデル判定の項目は skipped（summary は返さない）', async () => {
    const { fake, invoke } = setup([])
    const out = await judge({ ...input, checks: goodChecks, input: { md: '# 短い' } }, invoke)
    if (!out.ok) throw new Error('not ok')
    expect(fake.calls).toEqual([])
    const r = out.judged.body
    expect(r.results.map((x) => [x.id, x.verdict])).toEqual([
      ['C01', 'fail'],
      ['C02', 'skipped'],
      ['C03', 'fail'],
      ['C04', 'pass'],
      ['C05', 'skipped'],
      ['C06', 'skipped'],
    ])
    // 機械判定の要約には今の値を添える（依頼書の「短く」に数が無いので目標は書かない。6.2.9 (2)）
    expect(r.failedSummaries).toEqual([
      '分量が依頼の範囲から外れています\n  - 字数は今 2 字です',
      '見出しの数が依頼と合っていません\n  - 見出し（題と小見出しを除く）は今 0 個です',
    ])
    expect(r.familyNote).toBe(FAMILY_NOTE)
    expect(r.jevNote).toBe(JEV_NOTE)
    expect(() =>
      Review.parse({ version: 1, series: 1, round: 1, at: 'x', phase: '本文', attempt: 1, ...r }),
    ).not.toThrow()
  })

  it('機械が全部通れば jev と claude を 1 回の Claude で聞き、単位ごとに集計する', async () => {
    const paragraphs = md.split('\n\n').filter((b) => !b.startsWith('#')).length
    const reply: JudgeReply = {
      results: [
        { id: 'C02', units: [{ index: 0, yes: true }], reason: '決まったことが先に書いてあります。' },
        { id: 'C05', units: [{ index: 0, yes: false }], reason: '「することができる」が残っています。' },
        {
          id: 'C06',
          units: Array.from({ length: paragraphs }, (_, index) => ({ index, yes: index === 0 ? true : null })),
          reason: '1 段落目だけ次の行動があります。',
        },
      ],
    }
    const { fake, invoke } = setup([{ role: '判定役・文章', nth: 1, reply: { text: JSON.stringify(reply) } }])
    const out = await judge({ ...input, checks: goodChecks, input: { md } }, invoke)
    if (!out.ok) throw new Error(out.out.detail)
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call?.access).toBe('none')
    const text = (name: string) => JSON.parse(JSON.stringify(call?.materials.find((m) => m.name === name) ?? {})).text
    const asked = JSON.parse(text('確かめること'))
    expect(asked.map((a: { id: string }) => a.id)).toEqual(['C02', 'C05', 'C06'])
    expect(JSON.parse(text('本文の単位'))).toHaveProperty('paragraph')
    // 依頼書は materials に brief が無いので渡さない
    expect(call?.materials.some((m) => m.name === '依頼書')).toBe(false)
    const r = out.judged.body
    expect(r.results.find((x) => x.id === 'C05')?.verdict).toBe('fail')
    // ratio 0.3: はい 1 / null は結論を変える → unable
    expect(r.results.find((x) => x.id === 'C06')?.verdict).toBe('unable')
    expect(r.pass).toBe(false)
    expect(out.judged.reasons.C05).toContain('することができる')
    // モデル判定の要約は 1 行のまま、unable は返さない（6.2.9 (3)・6.2.7 (3)）
    const c05 = goodChecks.find((c) => c.id === 'C05')?.summary
    expect(r.failedSummaries).toEqual([c05])
  })

  it('モデル判定で落ちた項目には、落ちた節・段落を番号と本文の字面で添える。理由文は返さない（6.2.10 (1)）', async () => {
    const model = (id: string, judge: Check['judge'], pass: Check['pass']): Check =>
      ({ ...(goodChecks[1] as Check), id, judge, pass, summary: `要約 ${id}` }) as Check
    const checks = [
      goodChecks[0] as Check,
      model('C02', { by: 'claude', question: 'q', materials: ['draft'], scope: 'section' }, { kind: 'all' }),
      model(
        'C03',
        { by: 'jev', proposition: 'p', state: ['paragraph'], scope: 'paragraph' },
        { kind: 'count', max: 0 },
      ),
      model('C04', { by: 'claude', question: 'q', materials: ['draft'], scope: 'document' }, { kind: 'all' }),
    ]
    const reply: JudgeReply = {
      results: [
        {
          id: 'C02',
          // 節 2 は落ち、節 4 は決められない（null は箇所に入れない）
          units: [0, 1, 2, 3].map((index) => ({ index, yes: index === 1 ? false : index === 3 ? null : true })),
          reason: '2 つ目の節は二つの機能をまとめています。',
        },
        {
          id: 'C03',
          // count は「はい」が問題のある単位。同じ字面の段落は番号で見分ける
          units: [0, 1, 2, 3, 4].map((index) => ({ index, yes: index === 2 || index === 4 })),
          reason: '段落の理由。',
        },
        { id: 'C04', units: [{ index: 0, yes: false }], reason: '全体の理由。' },
      ],
    }
    const { invoke } = setup([{ role: '判定役・文章', nth: 1, reply: { text: JSON.stringify(reply) } }])
    const out = await judge({ ...input, checks, input: { md } }, invoke)
    if (!out.ok) throw new Error(out.out.detail)
    const r = out.judged.body
    expect(r.failedSummaries).toEqual([
      '要約 C02\n  - 2 つ目の節「二」',
      '要約 C03\n  - 3 段落目「段落。」（「二」の下）\n  - 5 段落目「段落。」（「四」の下）',
      '要約 C04', // 本文全体の項目は箇所が 1 つなので添えない
    ])
    expect(r.failedSummaries.join()).not.toContain('機能')
    // 段落の先頭は 20 字で切る
    const one = {
      ...reply,
      results: [{ id: 'C03', units: [0, 1, 2, 3, 4].map((index) => ({ index, yes: index === 0 })), reason: 'r' }],
    }
    const s2 = setup([{ role: '判定役・文章', nth: 1, reply: { text: JSON.stringify(one) } }])
    const out2 = await judge({ ...input, checks: [checks[0] as Check, checks[2] as Check], input: { md } }, s2.invoke)
    if (!out2.ok) throw new Error(out2.out.detail)
    expect(out2.judged.body.failedSummaries).toEqual([`要約 C03\n  - 1 段落目「${'あ'.repeat(20)}…」（「題」の下）`])
  })

  it('目標の数が依頼書にあれば、機械判定の要約に目標と今の値を添える（6.2.9 (2)）', async () => {
    const { invoke } = setup([])
    const out = await judge(
      { ...input, brief: { ...brief, shape: '2,200〜2,800 字' }, checks: goodChecks, input: { md: '# 短い' } },
      invoke,
    )
    if (!out.ok) throw new Error('not ok')
    expect(out.judged.body.failedSummaries[0]).toBe(
      '分量が依頼の範囲から外れています\n  - 字数は 2,200〜2,800 字にしてください（今は 2 字）',
    )
  })

  it('Claude の出力の受け入れ規則と、指示の例', () => {
    const asked = [{ id: 'C02', ask: 'q', scope: 'section', units: [0, 1] }]
    expect(replyViolations(JUDGE_EXAMPLE, asked)).toEqual([])
    expect(JudgeReply.safeParse(JUDGE_EXAMPLE).success).toBe(true)
    expect(JUDGE_INSTRUCTION).toContain(JSON.stringify(JUDGE_EXAMPLE))
    const one = { id: 'C02', units: [{ index: 0, yes: true }], reason: 'r' }
    expect(replyViolations({ results: [one] }, asked).join()).toContain('index 0・1')
    expect(replyViolations({ results: [] }, asked).join()).toContain('ちょうど 1 つ')
    expect(
      replyViolations(
        {
          results: [
            { ...one, id: 'C09' },
            {
              ...one,
              units: [
                { index: 0, yes: true },
                { index: 1, yes: false },
              ],
            },
          ],
        },
        asked,
      ).join(),
    ).toContain('C09 は聞いていない')
  })

  it('理由文の描き出しを読み戻せる', () => {
    expect(parseReasons('## C02 題\n\n理由 1\n\n## C05 隔離の点検\n\n理由 2\n')).toEqual({
      C02: '理由 1',
      C05: '理由 2',
    })
  })
})
