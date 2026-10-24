// 事実係（docs/implementation.md 6.3.1）。文・棚卸し・分類・照合・取り寄せ・閉じるときの削除・判定への組み込み・届け先のリンク
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Check, MARK, Review } from '@libretto/shared/checks'
import type { BriefFile } from '@libretto/shared/ledger'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Input, transition } from '../src/case/transition.ts'
import { SUPPORT_PROPOSITION, withHostItems } from '../src/checks/host-items.ts'
import { runCode } from '../src/checks/judgeable.ts'
import { renderHtml } from '../src/checks/text.ts'
import { pageBlocks } from '../src/deliver/page.ts'
import { pasteText } from '../src/deliver/paste.ts'
import { type Fetched, type FetchFailure, fetchSource, htmlText, isBlockedAddress } from '../src/facts/fetch.ts'
import {
  buildFacts,
  type Claim,
  claimsFrom,
  collectFacts,
  compareNumbers,
  excerptOf,
  fetchCached,
  INVENTORY_INSTRUCTION,
  Inventory,
  inventoryViolations,
  locate,
  marksOf,
  materialsDir,
  renderFacts,
  sentencesOf,
  whereAt,
} from '../src/facts/inventory.ts'
import { purge, purgeClosed } from '../src/facts/purge.ts'
import { caseDir, initHome, openDb } from '../src/ledger/db.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { createInvoke } from '../src/model/invoke.ts'
import { judge, sourceRows } from '../src/roles/judge.ts'
import { feedbackOf, makerInstruction, SOURCES_RULE } from '../src/roles/maker.ts'

const URL_A = 'https://example.com/a?x=1&y=2'
const URL_B = 'https://example.org/b'

describe('文と場所（6.3.1 (2)）', () => {
  it('リンクは 1 つの塊、句点の後の印は前の文に付く', () => {
    const md = `利用者は 120 万人だった（[調査](${URL_A})）。次の文です？${MARK}\n最後の文${MARK}。`
    const s = sentencesOf(md)
    expect(s.map((x) => x.text)).toEqual([
      `利用者は 120 万人だった（[調査](${URL_A})）。`,
      `次の文です？${MARK}`,
      `最後の文${MARK}。`,
    ])
    expect(s[0]?.links).toEqual([URL_A])
    expect(s.map((x) => x.marked)).toEqual([false, true, true])
    for (const x of s) expect(md.slice(x.start, x.end)).toBe(x.text)
  })

  it('場所は見出しと段落の番号', () => {
    const md = '前置き。\n\n# 題\n\n一つ目。\n続き。\n\n二つ目。'
    expect(whereAt(md, 0)).toBe('冒頭の 1 段落目')
    expect(whereAt(md, md.indexOf('題'))).toBe('見出し「題」')
    expect(whereAt(md, md.indexOf('続き'))).toBe('見出し「題」の 1 段落目')
    expect(whereAt(md, md.indexOf('二つ目'))).toBe('見出し「題」の 2 段落目')
  })

  it('印は棚卸しと別に本文から全部拾う（M01〜）', () => {
    const md = `# 題\n\n昨年は 3 回あった。${MARK}\n\n東京が最大だ${MARK}。`
    expect(marksOf(md)).toEqual([
      { claimId: 'M01', text: '昨年は 3 回あった。', where: '見出し「題」の 1 段落目' },
      { claimId: 'M02', text: '東京が最大だ。', where: '見出し「題」の 2 段落目' },
    ])
  })
})

describe('棚卸し（6.3.1 (2)）', () => {
  it('位置: そのまま → 空白の違いだけ。全部の出現', () => {
    expect(locate('aXbXa', 'a')).toEqual([
      [0, 1],
      [4, 5],
    ])
    expect(locate('利用者は\n120 万人', '利用者は 120  万人')).toEqual([[0, 11]])
    expect(locate('abc', 'abd')).toEqual([])
  })

  it('見つからない text は言い直しの文になる。列挙は zod から', () => {
    const md = '利用者は 120 万人だった。'
    expect(inventoryViolations(md, { claims: [{ text: '利用者は 120 万人', kind: '数値' }], notClaims: [] })).toEqual(
      [],
    )
    expect(inventoryViolations(md, { claims: [], notClaims: ['利用者は 12 万人'] })[0]).toContain('見つかりません')
    for (const k of Inventory.shape.claims.element.shape.kind.options) expect(INVENTORY_INSTRUCTION).toContain(`"${k}"`)
  })

  it('同じ字面は場所ごとに別の主張、重なりは 1 つ、数字を含む文の取りこぼしはコードが足す', () => {
    const md = '# 2025 年\n\n東京が最大だ。東京が最大だ。\n\n1. 項目\n\n売上は 30 億円だった。'
    const cs = claimsFrom(md, [
      { text: '東京が最大だ', kind: '比較' },
      { text: '東京が最大', kind: '固有名詞' },
    ])
    expect(cs.map((c) => [c.id, c.text, c.kind])).toEqual([
      ['K01', '東京が最大だ', '比較'],
      ['K02', '東京が最大だ', '比較'],
      ['K03', '売上は 30 億円だった。', '数値'],
    ])
    for (const c of cs) expect(md.slice(...c.range)).toBe(c.text)
  })

  it('全角の数字の文も下限に入る', () => {
    expect(claimsFrom('利用者は１２０万人だった。', []).map((c) => c.kind)).toEqual(['数値'])
  })

  it('文に出典が複数あれば、主張ごとに一番当たる出典を相手にする', () => {
    const md = 'A 社は 10 人、B 社は 20 人だった（[A](https://ex.com/a)、[B](https://ex.com/b)）。'
    const cs = claimsFrom(md, [
      { text: 'A 社は 10 人', kind: '数値' },
      { text: 'B 社は 20 人だった', kind: '数値' },
    ])
    const src = (url: string, p: string): [string, Fetched] => [
      url,
      { ok: true, url, title: url, paragraphs: [p], fingerprint: 'f' },
    ]
    const f = buildFacts(
      1,
      md,
      cs,
      [],
      new Map([src('https://ex.com/a', 'A 社は 10 人だ。'), src('https://ex.com/b', 'B 社は 20 人だった。')]),
    )
    expect(f.file.verdicts.map((v) => v.sourceRef)).toEqual(['https://ex.com/a', 'https://ex.com/b'])
  })

  it('数字を含む文でも notClaims に挙げた文は主張に足さない', () => {
    const md = '来月は 2 本の記事で試します。売上は 30 億円だった。'
    expect(claimsFrom(md, [], ['来月は 2 本の記事で試します。']).map((c) => c.text)).toEqual(['売上は 30 億円だった。'])
  })
})

describe('分類と照合（6.3.1 (3)(4)）', () => {
  it('compareNumbers は桁区切りと全角を揃え、無い数を挙げる', () => {
    expect(compareNumbers('利用者は１,２００人、昨年は 900 人', '1200 人と 950 人')).toEqual({
      matched: [1200],
      mismatched: [950],
    })
  })

  it('2 段落にまたがる主張は、隣り合う段落を繋いで当てる', () => {
    const md = `塔は 2012 年に完成し、634 m の高さがある（[百科](${URL_B})）。`
    const cs = claimsFrom(md, [{ text: '塔は 2012 年に完成し、634 m の高さがある', kind: '数値' }])
    const src: Fetched = {
      ok: true,
      url: URL_B,
      title: 'b',
      paragraphs: ['塔は 2012 年に完成した。', '高さは 634 m ある。'],
      fingerprint: 'f',
    }
    const one = buildFacts(1, md, cs, [], new Map([[URL_B, src]]))
    expect(one.excerpts.get('K01')).toBe('塔は 2012 年に完成した。\n高さは 634 m ある。')
  })

  it('抜粋は 1,200 字まで、主張の当たりの多い所', () => {
    const para = `${'あ'.repeat(3000)}利用者は 120 万人${'い'.repeat(3000)}`
    const ex = excerptOf('利用者は 120 万人', para)
    expect(ex.length).toBeLessThanOrEqual(1200)
    expect(ex).toContain('利用者は 120 万人')
    expect(excerptOf('x', '短い')).toBe('短い')
  })

  const md = [
    `利用者は 120 万人だった（[調査](${URL_A})）。`,
    `広告費は 5 億円だった（[別](${URL_B})）。`,
    '会員は 300 人に増えた。',
    `東京が最大の拠点だ。${MARK}`,
    '大阪は二番目の拠点だ。',
  ].join('\n\n')
  const claims: Claim[] = claimsFrom(md, [
    { text: '利用者は 120 万人だった', kind: '数値' },
    { text: '広告費は 5 億円だった', kind: '数値' },
    { text: '会員は 300 人に増えた', kind: '数値' },
    { text: '東京が最大の拠点だ', kind: '比較' },
    { text: '大阪は二番目の拠点だ', kind: '比較' },
  ])
  const sources = new Map<string, Fetched | FetchFailure>([
    [
      URL_A,
      {
        ok: true,
        url: URL_A,
        title: '調査',
        paragraphs: ['関係ない段落', '2025 年の利用者は 120 万人だった。'],
        fingerprint: 'f',
      },
    ],
    [URL_B, { ok: false, why: 'network' }],
  ])
  const facts = buildFacts(1, md, claims, ['会員は 3000 人に増えた。'], sources)

  it('出典あり（抜粋あり / 開けない）・材料由来（食い違う数）・出典なし（印あり / 無し）', () => {
    expect(facts.file.verdicts.map((v) => [v.claimId, v.kind, !!v.excerptFingerprint, v.mismatched, v.mark])).toEqual([
      ['K01', '出典あり', true, undefined, undefined],
      ['K02', '出典あり', false, undefined, undefined],
      ['K03', '材料由来', true, ['300'], undefined],
      ['K04', '出典なし', false, undefined, true],
      ['K05', '出典なし', false, undefined, undefined],
    ])
    expect(facts.excerpts.get('K01')).toBe('2025 年の利用者は 120 万人だった。')
    // 抜粋の本文はファイルに入れない
    expect(JSON.stringify(facts.file)).not.toContain('2025 年の利用者')
    expect(facts.file.sources.map((s) => [s.url, s.opened, s.title])).toEqual([
      [URL_A, true, '調査'],
      [URL_B, false, undefined],
    ])
  })

  it('事実の 3 関数は「問題がある」を数えて 0 件で合格', async () => {
    const all = withHostItems([], [], 'x'.repeat(32), '出典付き').filter((c) => c.category === '事実')
    const units = async (fn: string) => {
      const c = all.find((x) => x.judge.by === 'code' && x.judge.fn === fn) as Check
      return (await runCode(c, { md, facts: facts.file })).units
    }
    expect(await units('claimsInventoried')).toEqual([false, false, false, false, true])
    expect(await units('sourcesReachable')).toEqual([false, true])
    expect(await units('numbersMatch')).toEqual([true])
    const empty = buildFacts(1, 'x', [], [], new Map()).file
    for (const c of all.filter((x) => x.judge.by === 'code'))
      expect((await runCode(c, { md: 'x', facts: empty })).units).toEqual([])
    expect(all.find((c) => c.judge.by === 'jev')?.judge).toMatchObject({
      scope: 'claim',
      proposition: SUPPORT_PROPOSITION,
    })
    expect(withHostItems([], [], 'x'.repeat(32), '出典なし').some((c) => c.category === '事実')).toBe(false)
  })

  it('出典ごとの集計: 開けない / 未判定 / 支持 / 一部支持 / 支持しない', () => {
    const f = structuredClone(facts.file)
    expect(sourceRows(f).map((r) => r.verdict)).toEqual(['未判定', '開けない'])
    const v = f.verdicts[0] as (typeof f.verdicts)[number]
    v.supports = true
    expect(sourceRows(f)[0]?.verdict).toBe('支持')
    v.supports = false
    expect(sourceRows(f)[0]?.verdict).toBe('支持しない')
    v.supports = null
    expect(sourceRows(f)[0]?.verdict).toBe('未判定')
    f.verdicts.push({ claimId: 'K09', kind: '出典あり', sourceRef: URL_A, excerptFingerprint: 'e', supports: true })
    v.supports = false
    expect(sourceRows(f)[0]?.verdict).toBe('一部支持')
  })
})

describe('取り寄せ（6.3.1 (5)）', () => {
  it('手元のアドレスを拒む（v4・v6・射影・NAT64）', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      'ff02::1',
      'x',
    ])
      expect(isBlockedAddress(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '2606:4700::1111', '8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false)
  })

  it('HTML から題と段落。script・style は中身ごと捨てる', () => {
    const t = htmlText(
      '<html><head><title>題 &amp; 副題</title><style>p{}</style></head><body><script>x()</script><p>一つ目<b>強調</b></p><div>二つ目&nbsp;です</div></body></html>',
    )
    expect(t).toEqual({
      title: '題 & 副題',
      paragraphs: ['一つ目強調', '二つ目 です'],
      md: '一つ目強調\n\n二つ目 です',
    })
  })

  it('md は見出しを # 、箇条書きの項目を - で始める（文体カード。6.3.2 (3)）', () => {
    const t = htmlText('<h2>見出し</h2><p>本文です。</p><ul><li>項目 1</li><li>項目 2</li></ul><h3> </h3>')
    expect(t.md).toBe('# 見出し\n\n本文です。\n\n- 項目 1\n\n- 項目 2')
    expect(t.paragraphs).toEqual(['見出し', '本文です。', '項目 1', '項目 2'])
  })

  it('md: 項目の中に段落があっても箇条書きのまま', () => {
    expect(htmlText('<ul><li><p>中に段落のある項目</p></li></ul><p>本文です。</p>').md).toBe(
      '- 中に段落のある項目\n\n本文です。',
    )
    expect(htmlText('<ol><li><p>一つ目</p><p>続き</p></li><li>二つ目</li></ol><p>後</p>').md).toBe(
      '- 一つ目 続き\n\n- 二つ目\n\n後',
    )
  })

  let http: Server
  let base: string
  let hits = 0
  beforeAll(async () => {
    http = createHttp((req, res) => {
      hits++
      if (req.url === '/page')
        return res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('<title>T</title><p>本文の段落。</p>')
      if (req.url === '/text') return res.writeHead(200, { 'content-type': 'text/plain' }).end('一つ目\n\n二つ目')
      if (req.url === '/move') return res.writeHead(302, { location: '/page' }).end()
      if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end()
      if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      if (req.url === '/big')
        return res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end(`頭の段落\n\n${'a'.repeat(3 * 1024 * 1024)}\n\n末尾の段落`)
      if (req.url === '/hang') return
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  })
  afterAll(() => {
    http.closeAllConnections()
    http.close()
  })
  const open = { blocked: () => false }

  it('既定では手元のサーバーに出ない（IP の字面・名前の両方）', async () => {
    const before = hits
    const port = new URL(base).port
    expect(await fetchSource(`${base}/page`)).toEqual({ ok: false, why: 'blocked' })
    expect(await fetchSource(`http://localhost:${port}/page`)).toEqual({ ok: false, why: 'blocked' })
    expect(await fetchSource(`http://[::1]:${port}/page`)).toEqual({ ok: false, why: 'blocked' })
    // リダイレクトの行き先も同じ検査
    expect(await fetchSource(`${base}/move`, { blocked: (ip) => ip !== '127.0.0.1' })).toMatchObject({ ok: true })
    expect(hits - before).toBe(2)
    expect(await fetchSource('file:///etc/passwd')).toEqual({ ok: false, why: 'unsupported' })
    expect(await fetchSource('not a url')).toEqual({ ok: false, why: 'unsupported' })
    expect(await fetchSource('https://%zz@example.com/')).toEqual({ ok: false, why: 'unsupported' })
  })

  it('成功・リダイレクト・回数・種類・大きさ・時間切れ・404', async () => {
    expect(await fetchSource(`${base}/page`, open)).toMatchObject({
      ok: true,
      title: 'T',
      paragraphs: ['本文の段落。'],
    })
    expect(await fetchSource(`${base}/text`, open)).toMatchObject({ ok: true, paragraphs: ['一つ目', '二つ目'] })
    expect(await fetchSource(`${base}/move`, open)).toMatchObject({ ok: true, url: `${base}/page` })
    expect(await fetchSource(`${base}/loop`, open)).toEqual({ ok: false, why: 'refused' })
    expect(await fetchSource(`${base}/json`, open)).toEqual({ ok: false, why: 'unsupported' })
    // 2 MB を超えたら先頭だけを読む（6.3.3 (5)）
    const big = await fetchSource(`${base}/big`, open)
    expect(big).toMatchObject({ ok: true })
    const paras = big.ok ? big.paragraphs : []
    expect(paras[0]).toBe('頭の段落')
    expect(paras.join('').length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(paras).not.toContain('末尾の段落')
    // HTML の切れ目が script の中なら、その中身は段落にしない。閉じタグの無い head は捨てない
    expect(htmlText(`<p>本文</p><script>var data = "${'x'.repeat(50)}`).paragraphs).toEqual(['本文'])
    expect(htmlText('<html><head><meta charset="utf-8"><body><p>本文</p>').paragraphs).toEqual(['本文'])
    expect(htmlText('<p>本文</p><!-- 隠した段落 <p>古い文</p>').paragraphs).toEqual(['本文'])
    expect(await fetchSource(`${base}/hang`, { ...open, timeoutMs: 200 })).toEqual({ ok: false, why: 'timeout' })
    expect(await fetchSource(`${base}/nothing`, open)).toEqual({ ok: false, why: 'refused' })
  })

  it('取り寄せた本文は facts-excerpts/ に置いて使い回し、開けなかったものは覚えない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'libretto-facts-'))
    const calls: string[] = []
    const fake = async (url: string): Promise<Fetched | FetchFailure> => {
      calls.push(url)
      return url === URL_A
        ? { ok: true, url, title: 'A', paragraphs: ['p'], fingerprint: 'f' }
        : { ok: false, why: 'network' }
    }
    const signal = new AbortController().signal
    await fetchCached(home, 'c1', [URL_A, URL_B, URL_A], signal, fake)
    const again = await fetchCached(home, 'c1', [URL_A, URL_B], signal, fake)
    expect(calls).toEqual([URL_A, URL_B, URL_B])
    expect(again.get(URL_A)).toMatchObject({ ok: true, title: 'A', paragraphs: ['p'] })
  })
})

describe('判定への組み込み（6.3.1 (7)(8)）', () => {
  const brief = { sources: '出典付き', audience: 'a', mustNot: [] } as unknown as BriefFile
  const length: Check = {
    id: 'C01',
    category: '分量',
    title: 't',
    judge: { by: 'code', fn: 'charCount', args: { min: 10 } },
    pass: { kind: 'all' },
    phase: '本文',
    summary: '分量',
    hidden: false,
    selfReport: '依頼に書いてある',
  }
  const checks = withHostItems([length], [], 'tok'.repeat(6), '出典付き')
  const md = `# 題\n\n利用者は 120 万人だった（[調査](${URL_A})）。\n\n会員は 300 人に増えた。\n\n東京が最大の拠点だ。${MARK}`
  const setup = (script: ScriptEntry[], body = md) => {
    const home = mkdtempSync(join(tmpdir(), 'libretto-facts-judge-'))
    const ledger = initHome(home)
    // 費用の仮押さえは案件の行に付く
    transition(ledger, {
      type: 'conversation.request',
      eventId: 'c1-created',
      caseId: 'c1',
      title: 't',
      mode: '確認しながら',
      docType: '記事',
      destination: [{ kind: 'paste' }],
    } as Input)
    const fake = createFake(script)
    const invoke = createInvoke({
      ledger,
      backends: { claude: fake.backend },
      caps: () => ({ caseCapYen: null, monthCapYen: null }),
      onCostCap: () => {},
      log: () => {},
    })
    mkdirSync(materialsDir(home, 'c1'), { recursive: true })
    writeFileSync(join(materialsDir(home, 'c1'), 'pasted-01.md'), '会員は 300 人に増えた。\n')
    const fetched: string[] = []
    const fetch = async (url: string): Promise<Fetched> => {
      fetched.push(url)
      return { ok: true, url, title: '調査', paragraphs: ['利用者は 120 万人だった。'], fingerprint: 'f' }
    }
    const signal = new AbortController().signal
    const facts = () => collectFacts({ home, caseId: 'c1', invoke, signal, fetch }, 1, body)
    return { fake, invoke, facts, fetched, signal, home }
  }
  const say = (v: unknown) => ({ text: JSON.stringify(v) })
  const inventory = {
    claims: [
      { text: '利用者は 120 万人だった', kind: '数値' },
      { text: '会員は 300 人に増えた', kind: '数値' },
      { text: '東京が最大の拠点だ', kind: '比較' },
    ],
  }

  it('ほかの機械判定が落ちても棚卸しと事実の機械判定は流し、支持（モデル判定）だけ skipped（6.3.1 (7)）', async () => {
    const body = `短（[調](${URL_A})）`
    const { fake, invoke, facts, signal } = setup(
      [{ role: '事実係・抜き出し', nth: 1, reply: say({ claims: [] }) }],
      body,
    )
    const out = await judge(
      { caseId: 'c1', phase: '本文', checks, input: { md: body }, brief, family: '別系統', signal, facts },
      invoke,
    )
    if (!out.ok) throw new Error(out.out.detail)
    expect(fake.calls.map((c) => c.role)).toEqual(['事実係・抜き出し'])
    expect(out.judged.body.results.map((r) => r.verdict)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass', 'skipped'])
    expect(out.judged.facts).toBeDefined()
    // どの主張にも付かなかった本文のリンクも、まだチェックしていない形で並ぶ
    expect(out.judged.body.sources).toEqual([{ ref: URL_A, title: '調', verdict: '未判定', claimIds: [] }])
  })

  it('事実の項目が無い組でも、承認の面に本文の出典を「まだチェックしていません」で並べる', async () => {
    const { invoke, signal } = setup([])
    const out = await judge(
      {
        caseId: 'c1',
        phase: '本文',
        checks: [length],
        input: { md: `${'あ'.repeat(10)}（[調査](${URL_A})）` },
        brief,
        family: '別系統',
        signal,
      },
      invoke,
    )
    expect(out.ok && out.judged.body.sources).toEqual([{ ref: URL_A, title: '調査', verdict: '未判定', claimIds: [] }])
  })

  it('棚卸し（言い直し 1 回）→ 取り寄せ → 3 関数 → 支持（Jev が無ければ Claude）→ 出典の集計', async () => {
    const { fake, invoke, facts, fetched, signal } = setup([
      { role: '事実係・抜き出し', nth: 1, reply: say({ claims: [{ text: '利用者は 12 万人', kind: '数値' }] }) },
      { role: '事実係・抜き出し', nth: 2, reply: say(inventory) },
      { role: '事実係・命題', nth: 1, reply: say({ yes: true, reason: '同じ数です。' }) },
      { role: '事実係・命題', nth: 2, reply: say({ yes: false, reason: '数が違います。' }) },
    ])
    const out = await judge(
      { caseId: 'c1', phase: '本文', checks, input: { md }, brief, family: '別系統', signal, facts },
      invoke,
    )
    if (!out.ok) throw new Error(out.out.detail)
    expect(fake.unused()).toEqual([])
    expect(fetched).toEqual([URL_A])
    const r = out.judged.body
    expect(r.results.map((x) => [x.id, x.verdict])).toEqual([
      ['C01', 'pass'],
      ['C02', 'pass'], // canary
      ['C03', 'pass'], // 棚卸し: 出典あり・材料由来・印
      ['C04', 'pass'],
      ['C05', 'pass'],
      ['C06', 'fail'], // 支持: 材料由来の 1 件が支持しない
    ])
    expect(r.results[5]?.units?.map((u) => [u.yes, u.claude])).toEqual([
      [true, true],
      [false, true],
    ])
    expect(r.marks).toEqual([{ claimId: 'M01', text: '東京が最大の拠点だ。', where: '見出し「題」の 3 段落目' }])
    expect(r.sources).toEqual([{ ref: URL_A, title: '調査', verdict: '支持', claimIds: ['K01'] }])
    expect(r.jevNote).toBeDefined() // Jev を使っていない
    expect(out.judged.facts?.verdicts.map((v) => v.supports)).toEqual([true, false, undefined])
    // 材料由来の主張の抜粋は Claude の材料に入るが、facts には指紋だけ
    expect(JSON.stringify(fake.calls[3]?.materials)).toContain('会員は 300 人に増えた')
    expect(() =>
      Review.parse({ version: 1, series: 1, round: 1, at: 'x', phase: '本文', attempt: 1, ...r }),
    ).not.toThrow()
  })

  it('言い直しても本文から写せなければ、数字の文の下限だけで棚卸しする（止めない）', async () => {
    const bad = say({ claims: [{ text: '本文に無い主張', kind: '断定' }] })
    const { facts, fake } = setup([
      { role: '事実係・抜き出し', nth: 1, reply: bad },
      { role: '事実係・抜き出し', nth: 2, reply: bad },
    ])
    const got = await facts()
    if (!got.ok) throw new Error('not ok')
    expect(fake.unused()).toEqual([])
    expect(got.facts.file.claims.map((c) => c.kind)).toEqual(['数値', '数値'])
  })

  it('出典ありの主張が無い版は、支持の項目が単位 0 個で合格', async () => {
    const body = '# 題\n\n今日は良い天気だと思う。'
    const { invoke, facts, signal } = setup([{ role: '事実係・抜き出し', nth: 1, reply: say({ claims: [] }) }], body)
    const out = await judge(
      {
        caseId: 'c1',
        phase: '本文',
        checks,
        input: { md: body },
        brief,
        family: '別系統',
        signal,
        facts,
      },
      invoke,
    )
    if (!out.ok) throw new Error(out.out.detail)
    expect(out.judged.body.results.map((x) => x.verdict)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
    expect(out.judged.body.results[5]?.units).toEqual([])
  })

  it('作り手が作業場の資料に段落を足しても、照合は正本だけを読む（6.3.1 (5)）', async () => {
    const { facts, home } = setup([{ role: '事実係・抜き出し', nth: 1, reply: say(inventory) }])
    const work = join(caseDir(home, 'c1'), 'work', 'materials')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'forged.md'), '東京が最大の拠点だ。\n')
    const got = await facts()
    if (!got.ok) throw new Error('not ok')
    expect(got.facts.file.verdicts.map((v) => v.kind)).toEqual(['出典あり', '材料由来', '出典なし'])
  })
})

describe('閉じるときの削除（6.3.1 (10)）', () => {
  it('終端の案件だけ、消すものを消して purged 行を残す。起動時のやり直し', () => {
    const home = mkdtempSync(join(tmpdir(), 'libretto-purge-'))
    const ledger = initHome(home)
    const mk = (caseId: string) => {
      transition(ledger, {
        type: 'conversation.request',
        eventId: `${caseId}-1`,
        caseId,
        title: 't',
        mode: '確認しながら',
        docType: '記事',
        destination: [{ kind: 'paste' }],
      } as Input)
      const dir = caseDir(home, caseId)
      for (const p of [
        'facts-excerpts/a.json',
        'materials/pasted-01.md',
        'work/materials/pasted-01.md',
        'checks/voice-samples.md',
        'checks/checks.json',
        'facts.json',
      ]) {
        mkdirSync(join(dir, p, '..'), { recursive: true })
        writeFileSync(join(dir, p), 'x')
      }
      return dir
    }
    const open = mk('open')
    expect(purge(home, ledger, 'open')).toEqual([])
    expect(existsSync(join(open, 'materials'))).toBe(true)

    const closed = mk('closed')
    transition(ledger, {
      type: 'cancel',
      eventId: 'closed-2',
      caseId: 'closed',
      by: '本人',
      expectedRevision: 0,
    } as Input)
    expect(purge(home, ledger, 'closed', new Date(1))).toEqual([
      'facts-excerpts',
      'materials',
      'work/materials',
      'checks/voice-samples.md',
    ])
    for (const p of ['facts-excerpts', 'materials', 'work/materials', 'checks/voice-samples.md'])
      expect(existsSync(join(closed, p)), p).toBe(false)
    // 残すもの
    expect(existsSync(join(closed, 'checks/checks.json'))).toBe(true)
    expect(existsSync(join(closed, 'facts.json'))).toBe(true)
    expect(ledger.listCaseEvents('closed').at(-1)).toMatchObject({
      type: 'purged',
      paths: ['facts-excerpts', 'materials', 'work/materials', 'checks/voice-samples.md'],
    })
    expect(purge(home, ledger, 'closed')).toEqual([]) // 2 度目は何もしない

    mkdirSync(join(closed, 'materials'))
    purgeClosed(home, ledger)
    expect(existsSync(join(closed, 'materials'))).toBe(false)
    expect(existsSync(join(open, 'materials'))).toBe(true)
  })
})

describe('作り手との約束と「削る」（6.3.1 (1)(9)）', () => {
  it('出典付きのときだけ出典と印の約束を指示に書く', () => {
    expect(makerInstruction('/w', 1, false, true)).toContain(SOURCES_RULE)
    expect(makerInstruction('/w', 1, false, true)).toContain('出典のリンク（a）')
    expect(makerInstruction('/w', 1, false)).not.toContain(MARK)
  })

  it('「削る」で新しい系列を始めたら、feedback.md に主張の文と場所が入る', () => {
    const home = mkdtempSync(join(tmpdir(), 'libretto-cut-'))
    const ledger = new Ledger(openDb(':memory:'), () => new Date('2026-10-24T03:00:00Z'))
    let k = 0
    const run = (ev: Record<string, unknown>, ctx = {}) => {
      const c = ledger.getCase('c1')
      const r = transition(
        ledger,
        { caseId: 'c1', eventId: `e${++k}`, expectedRevision: c?.revision ?? 0, ...ev } as Input,
        ctx,
      )
      expect(r).toMatchObject({ ok: true })
    }
    run({
      type: 'conversation.request',
      title: 't',
      mode: '確認しながら',
      docType: '記事',
      destination: [{ kind: 'paste' }],
    })
    run({ type: 'entrance.drafted', by: 'libretto', setFingerprint: 's' })
    run({ type: 'entrance.approve', by: '本人', answers: {}, mode: '確認しながら', setFingerprint: 's' })
    run({ type: 'materials.ready', by: 'libretto' })
    run({ type: 'draft.done', by: 'libretto', n: 1, versionFingerprint: 'v1' })
    run({ type: 'review.pass', by: 'libretto', n: 1 })
    const marks = [{ claimId: 'M01', text: '東京が最大だ。', where: '冒頭の 1 段落目' }]
    run({ type: 'approval.ok', by: '本人', marks: { M01: '削る' }, versionFingerprint: 'v1' }, { marks })
    const c = ledger.getCase('c1')
    if (!c) throw new Error('no case')
    expect(c).toMatchObject({ state: '下書き中', series: 2 })
    const fb = feedbackOf(home, ledger, c)
    expect(fb).toContain('「東京が最大だ。」（冒頭の 1 段落目）')
  })
})

describe('届け先と承認の面のリンク（6.3.1 (11)）', () => {
  it('ページは http / https の a だけ残し、ほかの属性と危ない href は捨てる', () => {
    const b = pageBlocks(
      '<p>出典は<a href="https://ex.com/a?x=1&amp;y=2" onclick="x()" target="_top">調査</a>と<a href="javascript:alert(1)">危ない</a>。</p>',
    )
    expect(b[0]?.html).toBe('出典は<a href="https://ex.com/a?x=1&amp;y=2" rel="noopener noreferrer">調査</a>と危ない。')
  })

  it('URL の中の __ や ~~ は消さない（貼り付け用・承認の面）', () => {
    const md = '- 利用者は 10 人（[調__査](https://example.com/a__b~~c)）。'
    expect(pasteText(md)).toBe('・利用者は 10 人（調査（https://example.com/a__b~~c））。\n')
    expect(renderHtml(md)).toContain('href="https://example.com/a__b~~c"')
  })

  it('ページの形式の判定は、出典のリンクの行き先を判定した本文と比べる', async () => {
    const c = withHostItems([], [{ kind: 'page', shared: false }], 'x'.repeat(32)).find(
      (x) => x.judge.by === 'code' && x.judge.fn === 'pageRoundTrip',
    ) as Check
    const md = '利用者は 10 人（[調査](https://ex.com/a?x=1&y=2)）。'
    const page = (href: string) =>
      pageBlocks(`<p>利用者は 10 人（<a href="${href}">調査</a>）。</p>`)
        .map((b) => `<p>${b.html}</p>`)
        .join('')
    expect((await runCode(c, { md, page: page('https://ex.com/a?x=1&amp;y=2') })).units).toEqual([true])
    expect((await runCode(c, { md, page: page('https://ex.com/other') })).units).toEqual([false])
    expect((await runCode(c, { md, page: '<p>利用者は 10 人（調査）。</p>' })).units).toEqual([false])
  })

  it('貼り付け用は「題（URL）」、承認の面の本文はリンク', () => {
    const md = `利用者は 120 万人（[調査](${URL_B})）。![図](https://ex.com/i.png)`
    expect(pasteText(md)).toBe(`利用者は 120 万人（調査（${URL_B}））。図\n`)
    expect(renderHtml(md)).toBe(
      `<p>利用者は 120 万人（<a href="${URL_B}" rel="noopener noreferrer" target="_blank">調査</a>）。図</p>`,
    )
    expect(renderHtml('[x](javascript:alert)')).toBe('<p>x</p>')
  })
})

it('facts.md は主張ごとに 1 行（9.3 の描き出し）', () => {
  const f = buildFacts(1, '会員は 300 人。', claimsFrom('会員は 300 人。', []), [], new Map()).file
  expect(renderFacts(f)).toContain('- K01 会員は 300 人。（冒頭の 1 段落目）: 出典なし')
})
