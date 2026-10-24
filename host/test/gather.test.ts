// 事実係が公開の情報を集める（docs/implementation.md 6.3.3）
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Fetched, FetchFailure } from '../src/facts/fetch.ts'
import {
  GATHER_EXAMPLE,
  GatherDraft,
  gatheredPath,
  gatherSources,
  gatherViolations,
  readGathered,
} from '../src/facts/gather.ts'
import { buildFacts, claimsFrom, materialsDir, readMaterials, wordShare } from '../src/facts/inventory.ts'
import type { Job, Outcome } from '../src/model/invoke.ts'
import { BRIEF_EXAMPLE, BRIEF_GATHER_EXAMPLE, BriefDraft, briefViolations } from '../src/roles/entrance.ts'

const meta = { costYen: 0, family: 'claude' as const, model: 'claude-sonnet-5-5' }
const found = (urls: string[]): Outcome => ({
  ok: true,
  text: '',
  json: { sources: urls.map((url) => ({ url, why: '公式' })) },
  ...meta,
})
const fail = (kind: 'budget' | 'stopped' | 'timeout' | 'invalid_output' | 'unavailable', why?: 'auth_expired') =>
  ({
    ok: false,
    kind,
    detail: '',
    ...(kind === 'budget' && { scope: '案件' }),
    ...(why && { why }),
    ...meta,
  }) as Outcome
const fakeFetch = async (url: string): Promise<Fetched | FetchFailure> =>
  url.endsWith('/gone')
    ? { ok: false, why: 'network' }
    : { ok: true, url, title: 'お知らせ', paragraphs: ['新しい機能が増えた。'], fingerprint: 'f' }

let home: string
let jobs: Job[]
let authExpired: string[]
const ITEMS = ['今月の公式のお知らせ']
const run = (outcome: Outcome | (() => Promise<Outcome>), signal = new AbortController().signal) =>
  gatherSources(
    {
      home,
      invoke: async (job) => {
        jobs.push(job)
        return typeof outcome === 'function' ? outcome() : outcome
      },
      onAuthExpired: (id) => authExpired.push(id),
      now: () => new Date('2026-10-25T00:00:00Z'),
      fetch: fakeFetch,
    },
    'c1',
    ITEMS,
    signal,
  )
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'libretto-gather-'))
  mkdirSync(materialsDir(home, 'c1'), { recursive: true })
  jobs = []
  authExpired = []
})

describe('gatherSources', () => {
  it('集めるものと今日だけを渡し、道具は search。開けた URL を返して 済み を書く', async () => {
    expect(await run(found(['https://example.com/a', 'https://example.com/gone']))).toEqual(['https://example.com/a'])
    expect(jobs[0]).toMatchObject({ role: '事実係・集め', access: 'search', limits: { maxYen: 50 } })
    expect(jobs[0]?.materials).toEqual([
      { name: '集めるもの', text: '- 今月の公式のお知らせ' },
      { name: '今日', text: '2026-10-25' },
    ])
    expect(readGathered(home, 'c1')).toMatchObject({
      state: '済み',
      sources: [
        { url: 'https://example.com/a', title: 'お知らせ', opened: true },
        { url: 'https://example.com/gone', opened: false },
      ],
    })
  })

  it('集めるものが無ければ呼ばない', async () => {
    const r = await gatherSources(
      { home, invoke: async () => found([]), onAuthExpired: () => {} },
      'c1',
      [],
      new AbortController().signal,
    )
    expect(r).toEqual([])
    expect(existsSync(gatheredPath(home, 'c1'))).toBe(false)
  })

  it('済み があれば探し直さず、取り寄せだけをやり直す', async () => {
    await run(found(['https://example.com/a']))
    jobs = []
    expect(await run(found(['https://example.com/other']))).toEqual(['https://example.com/a'])
    expect(jobs).toEqual([])
  })

  it('探し中 が残っていたら（落ちた）探し直さずに 集められなかった で進む', async () => {
    writeFileSync(gatheredPath(home, 'c1'), JSON.stringify({ state: '探し中' }))
    expect(await run(found(['https://example.com/a']))).toEqual([])
    expect(jobs).toEqual([])
    expect(readGathered(home, 'c1')).toMatchObject({ state: '集められなかった', why: '途中で止まった' })
  })

  it('呼ぶ前に 探し中 を書く', async () => {
    let during: unknown
    await run(async () => {
      during = readGathered(home, 'c1')
      return found([])
    })
    expect(during).toEqual({ state: '探し中' })
  })

  it('budget は先へ進まない（cost.cap が止める）', async () => {
    expect(await run(fail('budget'))).toBeNull()
    expect(authExpired).toEqual([])
  })

  it('stopped は消して先へ進まない（次に起きたときに探す）', async () => {
    expect(await run(fail('stopped'))).toBeNull()
    expect(existsSync(gatheredPath(home, 'c1'))).toBe(false)
  })

  it('ログイン切れは消して待ちに入る', async () => {
    expect(await run(fail('unavailable', 'auth_expired'))).toBeNull()
    expect(existsSync(gatheredPath(home, 'c1'))).toBe(false)
    expect(authExpired).toEqual(['c1'])
  })

  it.each(['unavailable', 'timeout', 'invalid_output'] as const)('%s は止めずに 集められなかった で進む', async (k) => {
    expect(await run(fail(k))).toEqual([])
    expect(readGathered(home, 'c1')).toMatchObject({ state: '集められなかった', why: 'つながらなかった' })
  })

  it('見つからない・1 件も開けないときは 集められなかった', async () => {
    expect(await run(found(['https://example.com/gone']))).toEqual([])
    expect(readGathered(home, 'c1')).toMatchObject({ state: '集められなかった', why: '開けなかった' })
  })

  it('取り寄せの途中で止めたら null。選んだ URL は残り、次は探さない', async () => {
    const ac = new AbortController()
    const r = gatherSources(
      {
        home,
        invoke: async () => found(['https://example.com/a']),
        onAuthExpired: () => {},
        fetch: async () => {
          ac.abort()
          return { ok: false, why: 'network' }
        },
      },
      'c1',
      ITEMS,
      ac.signal,
    )
    expect(await r).toBeNull()
    expect(readGathered(home, 'c1')).toMatchObject({ state: '済み', sources: [{ opened: false }] })
  })
})

describe('集め役の出力の規則', () => {
  it('例は型と規則に通る', () => {
    expect(GatherDraft.parse(GATHER_EXAMPLE)).toEqual(GATHER_EXAMPLE)
    expect(gatherViolations(GATHER_EXAMPLE)).toEqual([])
  })
  it('http(s) 以外と重複は違反', () => {
    const v = gatherViolations({
      sources: [
        { url: 'file:///etc/passwd', why: 'x' },
        { url: 'https://a.example/', why: 'x' },
        { url: 'https://a.example/', why: 'x' },
      ],
    })
    expect(v).toEqual([expect.stringContaining('file:///etc/passwd'), expect.stringContaining('同じ URL')])
  })
})

describe('依頼書の「libretto が集めるもの」（6.3.3 (1)）', () => {
  const draft = (brief: Partial<BriefDraft['brief']>, assume = '文末はです・ます'): BriefDraft => ({
    ...BRIEF_EXAMPLE,
    brief: { ...BRIEF_EXAMPLE.brief, ...brief },
    assumptions: [{ id: 'A1', text: assume, why: '理由' }],
  })

  it('指示に載せた 2 つの例は型と規則に通る', () => {
    for (const ex of [BRIEF_EXAMPLE, BRIEF_GATHER_EXAMPLE]) {
      expect(BriefDraft.parse(ex)).toEqual(ex)
      expect(briefViolations(ex)).toEqual([])
    }
  })

  it('出力では欄が要る', () => {
    const { gather: _, ...rest } = BRIEF_EXAMPLE.brief
    expect(BriefDraft.safeParse({ ...BRIEF_EXAMPLE, brief: rest }).success).toBe(false)
  })

  it('集めるものがあれば出典付き', () => {
    expect(briefViolations(draft({ gather: ['公式のお知らせ'], sources: '出典なし' }))).toEqual([
      expect.stringContaining('出典付き'),
    ])
  })

  it('出典付きなのに資料がどこからも来なければ違反。依頼の文に URL があれば通す', () => {
    expect(briefViolations(draft({ wanted: [], gather: [], sources: '出典付き' }))).toEqual([
      expect.stringContaining('どこからも'),
    ])
    expect(
      briefViolations(draft({ wanted: [], gather: [], sources: '出典付き', subject: 'https://example.com を紹介' })),
    ).toEqual([])
  })

  it('集め先を仮定に書いたら違反（今回の A2）', () => {
    const v = briefViolations(draft({}, '公式の更新履歴やお知らせから集める'))
    expect(v).toEqual([expect.stringContaining('gather に書き')])
    expect(briefViolations(draft({}, '見出しは 4 つに分ける'))).toEqual([])
  })

  it('重複と直訳調は違反', () => {
    expect(briefViolations(draft({ gather: ['a', 'a'], sources: '出典付き' }))).toEqual([
      expect.stringContaining('同じもの'),
    ])
    expect(briefViolations(draft({ gather: ['公式において出たお知らせ'], sources: '出典付き' }))).toEqual([
      expect.stringContaining('において'),
    ])
  })
})

describe('集めた出典を出典として扱う（6.3.3 (3)）', () => {
  it('材料由来の相手は本人が貼った文だけ', () => {
    const dir = materialsDir(home, 'c1')
    writeFileSync(join(dir, 'pasted-01.md'), '会員は 3000 人に増えた。')
    writeFileSync(join(dir, 'source-01.md'), '# 題\n\nhttps://example.com/a\n\n売上は 5 億円。\n')
    expect(readMaterials(home, 'c1')).toEqual(['会員は 3000 人に増えた。'])
  })

  it('英語の出典は英字の語と数で相手を探す', () => {
    const url = 'https://example.com/changelog'
    const md = `Claude Code 2.1.300 で PostCompact フックが加わった（[更新履歴](${url})）。`
    const cs = claimsFrom(md, [{ text: 'Claude Code 2.1.300 で PostCompact フックが加わった', kind: '固有名詞' }])
    const src: Fetched = {
      ok: true,
      url,
      title: 'Changelog',
      paragraphs: ['Fixed a crash on startup.', 'Version 2.1.300: Added the PostCompact hook to Claude Code.'],
      fingerprint: 'f',
    }
    const f = buildFacts(1, md, cs, [], new Map([[url, src]]))
    expect(f.excerpts.get('K01')).toContain('PostCompact')
    expect(f.file.verdicts[0]).toMatchObject({
      kind: '出典あり',
      sourceRef: url,
      excerptFingerprint: expect.any(String),
    })
    expect(wordShare('新しい機能が増えた', 'New features')).toBe(0)
  })
})
