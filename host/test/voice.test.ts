// 文体カードと読み比べ（docs/implementation.md 6.3.2）。数値・段落の選び方・文体の関数・判定への組み込み
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Check } from '@libretto/shared/checks'
import { type BriefFile, VoiceNumbers } from '@libretto/shared/ledger'
import { describe, expect, it } from 'vitest'
import { READ_ALIKE_QUESTION, withHostItems } from '../src/checks/host-items.ts'
import { runCode } from '../src/checks/judgeable.ts'
import type { Fetched, FetchFailure } from '../src/facts/fetch.ts'
import {
  endingOf,
  extractVoice,
  gatherVoice,
  PORTRAIT_EXAMPLE,
  PORTRAIT_INSTRUCTION,
  Portrait,
  pickVoiceSamples,
  usable,
} from '../src/facts/voice.ts'
import { initHome } from '../src/ledger/db.ts'
import { createFake, type ScriptEntry } from '../src/model/fake.ts'
import { createInvoke } from '../src/model/invoke.ts'
import { type JudgeReply, judge, NO_SAMPLES, NO_VOICE, verdictOf } from '../src/roles/judge.ts'

const POLITE = `# 振り返り

私は毎週の振り返りで、うまくいったことを先に書くようにしています。そうすると次の一週間の始め方が決まります。

振り返りの時間は十五分です。長く取ると反省が増えます。短く区切ると、次にやることが一つに絞れると思います。

- 項目は箇条書きにしない
`
const PLAIN = `僕は朝に書く。夜は書かない。理由は単純だ。眠いからである。それだけのことだ。`

describe('文体カードの数値（6.3.2 (3)）', () => {
  it('文末の形は ぼかし → です・ます → だ・である → 体言止め の順で分ける', () => {
    expect(endingOf('次にやることが絞れると思います。')).toBe('ぼかし')
    expect(endingOf('決まります。')).toBe('です・ます')
    expect(endingOf('そうですね。')).toBe('です・ます')
    expect(endingOf('理由は単純だ。')).toBe('だ・である')
    expect(endingOf('夜は書かない。')).toBe('だ・である')
    expect(endingOf('十五分。')).toBe('体言止め')
    expect(endingOf('。')).toBeUndefined()
  })

  it('割合・いちばん多い形・一人称・文の長さ・見出し', () => {
    const v = extractVoice([POLITE])
    expect(VoiceNumbers.parse(v)).toEqual(v)
    expect(v.main).toBe('です・ます')
    expect(v.firstPerson).toBe('私')
    expect(v.readerAddress).toBe('なし')
    expect(v.paragraphs.headings).toBe('体言')
    expect(Object.values(v.endings).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
    expect(v.endings.ぼかし).toBeGreaterThan(0)
    expect(v.sentenceLength.p90).toBeGreaterThanOrEqual(v.sentenceLength.median)
    expect(v.unused).toContain('いかがでしたか')
    const p = extractVoice([PLAIN])
    expect(p).toMatchObject({ main: 'だ・である', firstPerson: '僕', paragraphs: { headings: 'なし' } })
  })

  it('一人称・読者の呼び方は段落だけで、50 文に 1 回以上のときだけ', () => {
    const many = Array.from({ length: 60 }, (_, i) => `今日は ${i} 番目の話を書きます。`).join('')
    // 見出し・箇条書きの「あなた」「私」は数えない（ページのおすすめ欄など）
    const chrome = `# あなたへのおすすめ\n\n- 私の記事\n\n${many}`
    expect(extractVoice([chrome])).toMatchObject({ readerAddress: 'なし', firstPerson: 'なし' })
    // 60 文に 1 回は 50 文に 1 回より少ない
    expect(extractVoice([`${many}あなたも試せます。`])).toMatchObject({ readerAddress: 'なし' })
    expect(extractVoice([`${many}あなたも試せます。あなたなら分かります。`])).toMatchObject({ readerAddress: 'あなた' })
    // 短い文章でも 1 回あれば数える
    expect(extractVoice([POLITE]).firstPerson).toBe('私')
  })

  it('使える文書は文が 5 つ以上', () => {
    expect(usable(PLAIN)).toBe(true)
    expect(usable('# 見出しだけ')).toBe(false)
  })
})

describe('読み比べ用の段落（6.3.2 (4)）', () => {
  const para = (k: string) => `${k}${'あ'.repeat(90)}。`
  it('80〜400 字の段落を文書ごとに順に回して最大 5 つ。見出し・箇条書き・短い段落は入れない', () => {
    const a = [para('a1'), para('a2'), para('a3'), '短い。', '- 項目'].join('\n\n')
    const b = ['# 見出し', para('b1'), para('b2'), 'あ'.repeat(401)].join('\n\n')
    const out = pickVoiceSamples([a, b])
    expect(out.map((p) => p.slice(0, 2))).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
    expect(pickVoiceSamples(['短い。'])).toEqual([])
  })
})

const check = (id: string, judge: Check['judge'], extra: Partial<Check> = {}): Check => ({
  id,
  category: '声',
  title: 't',
  judge,
  pass: { kind: 'all' },
  phase: '本文',
  summary: 's',
  hidden: false,
  selfReport: '依頼に書いてある',
  ...extra,
})

describe('文体の関数（6.3.2 (6)）', () => {
  const voice = extractVoice([POLITE])
  const run = async (fn: string, md: string) => {
    const c = check('C01', { by: 'code', fn: fn as 'voiceEndings', args: {} })
    const r = await runCode(c, { md, voice })
    return { ok: verdictOf(c.pass, r.units) === 'pass', measured: r.measured }
  }
  it('カードに近い本文は通り、遠い本文は落ちる', async () => {
    expect((await run('voiceEndings', POLITE)).ok).toBe(true)
    expect(await run('voiceEndings', PLAIN)).toMatchObject({ ok: false, measured: { ratio: 0 } })
    expect((await run('voiceSentenceLength', POLITE)).ok).toBe(true)
    expect((await run('voiceSentenceLength', `${'あ'.repeat(200)}です。`)).ok).toBe(false)
    expect((await run('voiceFirstPerson', POLITE)).ok).toBe(true)
    expect(await run('voiceFirstPerson', PLAIN)).toMatchObject({ ok: false, measured: { hits: 1 } })
  })
  it('カードが「なし」なら一人称が出てこない', async () => {
    const c = check('C01', { by: 'code', fn: 'voiceFirstPerson', args: {} })
    const r = await runCode(c, { md: '私が書く。', voice: { ...voice, firstPerson: 'なし' } })
    expect(r.units).toEqual([false])
  })
})

describe('本人の過去文書での点検（6.3.2 (5)）', () => {
  it('声と自然さの機械判定だけを流し、落ちた id を残す。開けない見本は docs に入れない', async () => {
    const checks = [
      check(
        'C01',
        { by: 'code', fn: 'sentenceEndingRatio', args: { endings: ['だ', 'である'] } },
        { pass: { kind: 'ratio', min: 0.9 } },
      ),
      check('C02', { by: 'code', fn: 'markerFree', args: {} }, { category: '自然さ' }),
      check('C03', { by: 'code', fn: 'charCount', args: { min: 5000 } }, { category: '分量' }),
      check('C04', { by: 'claude', question: 'q', materials: ['draft'], scope: 'document' }),
    ]
    const fetch = async (url: string): Promise<Fetched | FetchFailure> =>
      url.endsWith('/gone')
        ? { ok: false, why: 'network' }
        : { ok: true, url, title: 't', paragraphs: [], fingerprint: 'f', md: POLITE }
    const g = await gatherVoice(
      [
        { id: 'V1', kind: '声の見本', title: '記事', where: 'https://example.com/a' },
        { id: 'V2', kind: '声の見本', title: '消えた', where: 'https://example.com/gone' },
      ],
      checks,
      new AbortController().signal,
      async (c, md) => verdictOf(c.pass, (await runCode(c, { md })).units) === 'pass',
      fetch,
    )
    expect(g.voice.docs).toEqual([{ title: '記事', url: 'https://example.com/a', fingerprint: 'f', usable: true }])
    expect(g.voice.ownChecked).toEqual(['C01', 'C02'])
    // 打ち切った（決まらない）項目は確かめたものに入れない
    const timedOut = await gatherVoice(
      [{ id: 'V1', kind: '声の見本', title: '記事', where: 'https://example.com/a' }],
      checks,
      new AbortController().signal,
      async (c) => (c.id === 'C02' ? undefined : true),
      fetch,
    )
    expect(timedOut.voice.ownChecked).toEqual(['C01'])
    expect(timedOut.voice.ownFails).toEqual([])
    expect(g.voice.ownFails).toEqual(['C01'])
    expect(g.voice.card?.main).toBe('です・ます')
    // 段落が 80 字未満なので読み比べの段落は無い
    expect(g.samples).toBeUndefined()
    expect(g.voice.samplesFingerprint).toBeUndefined()
  })
})

describe('ホストの項目と判定（6.3.2 (6)(7)(9)）', () => {
  const brief = {
    docType: '記事',
    subject: 's',
    wanted: [],
    gather: [],
    audience: 'a',
    destinations: [{ kind: 'page', shared: false }],
    shape: '短く',
    materials: [],
    voice: '合わせる',
    sources: '出典なし',
    mustNot: [],
    assumptions: [],
    decisions: [],
  } as BriefFile
  const setup = (script: ScriptEntry[]) => {
    const ledger = initHome(mkdtempSync(join(tmpdir(), 'libretto-voice-')))
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
  const items = withHostItems([], [{ kind: 'page', shared: false }], 't0ken', '出典なし', { card: true, samples: true })
  const voice = extractVoice([POLITE])
  const base = {
    caseId: '推測',
    phase: '本文' as const,
    brief,
    family: '別系統' as const,
    signal: new AbortController().signal,
  }

  it('カードがあれば 3 項目、見本があれば読み比べ。読み比べは作り手に見せない', () => {
    const v = items.filter((c) => c.category === '声')
    expect(v.map((c) => (c.judge.by === 'code' ? c.judge.fn : c.judge.by))).toEqual([
      'voiceEndings',
      'voiceSentenceLength',
      'voiceFirstPerson',
      'claude',
    ])
    expect(v.at(-1)).toMatchObject({ hidden: true, judge: { question: READ_ALIKE_QUESTION } })
    expect(withHostItems([], [], 'x').some((c) => c.category === '声')).toBe(false)
  })

  it('読み比べに見本を渡し、voiceMatch にカードと本文の値を並べる', async () => {
    const readAlike = items.find((c) => c.judge.by === 'claude' && c.category === '声') as Check
    const reply: JudgeReply = {
      results: [{ id: readAlike.id, units: [{ index: 0, yes: true }], reason: '同じ調子です。' }],
    }
    const { fake, invoke } = setup([{ role: '判定役・文章', nth: 1, reply: { text: JSON.stringify(reply) } }])
    const out = await judge({ ...base, checks: items, input: { md: POLITE, voice }, samples: '# 見本\n\n段落' }, invoke)
    if (!out.ok) throw new Error(out.out.detail)
    expect(fake.calls[0]?.materials.find((m) => m.name === '本人の文章の見本')).toEqual({
      name: '本人の文章の見本',
      text: '# 見本\n\n段落',
    })
    expect(out.judged.body.voiceMatch).toEqual({
      endings: { main: 'です・ます', you: voice.endings['です・ます'], draft: voice.endings['です・ます'], ok: true },
      sentenceLength: { you: voice.sentenceLength.median, draft: voice.sentenceLength.median, ok: true },
      firstPerson: { you: '私', draft: '私', ok: true },
      readAlike: true,
    })
  })

  it('カードが無ければ文体の関数は unable、見本が無ければ読み比べを聞かずに unable', async () => {
    const { fake, invoke } = setup([])
    const noVoice = await judge({ ...base, checks: items, input: { md: POLITE } }, invoke)
    if (!noVoice.ok) throw new Error('not ok')
    expect(noVoice.judged.body.results.filter((r) => r.verdict === 'unable').length).toBe(3)
    expect(noVoice.judged.reasons[items.find((c) => c.judge.by === 'code' && c.category === '声')?.id as string]).toBe(
      NO_VOICE,
    )
    const noSamples = await judge({ ...base, checks: items, input: { md: POLITE, voice } }, invoke)
    if (!noSamples.ok) throw new Error('not ok')
    const ra = noSamples.judged.body.results.find((r) => r.by === 'claude')
    expect(ra?.verdict).toBe('unable')
    expect(noSamples.judged.reasons[ra?.id as string]).toBe(NO_SAMPLES)
    expect(noSamples.judged.body.voiceMatch?.readAlike).toBeNull()
    expect(fake.calls).toEqual([])
  })

  it('描写の指示の例は型に通る', () => {
    expect(Portrait.parse(PORTRAIT_EXAMPLE)).toEqual(PORTRAIT_EXAMPLE)
    expect(PORTRAIT_INSTRUCTION).toContain(JSON.stringify(PORTRAIT_EXAMPLE))
  })
})
