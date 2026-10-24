// 確認項目の受け入れ規則・ホストが足す項目・Undecided の照合（docs/implementation.md 7.2・6.2.2 (4)〜(6)）
import { Brief } from '@libretto/shared/api'
import { Check } from '@libretto/shared/checks'
import { describe, expect, it } from 'vitest'
import { checksViolations, judgeTerms, leaks } from '../src/checks/accept.ts'
import { CANARY_SUMMARY, withHostItems } from '../src/checks/host-items.ts'
import { CLASSIFIED_EXAMPLE, Classified, classifiedViolations, expects, toUndecided } from '../src/facts/undecided.ts'
import { withoutNulls } from '../src/model/invoke.ts'
import { BRIEF_EXAMPLE, BriefDraft, briefViolations, CHECK_EXAMPLES, ChecksDraft } from '../src/roles/entrance.ts'
import { goodChecks } from './fixtures/entrance.ts'

const shape = { voice: '合わせない', sources: '出典なし' } as const
const check = (cs: Check[], s: Parameters<typeof checksViolations>[1] = shape) =>
  checksViolations(cs, s, { minority: true })
const with_ = (i: number, patch: Partial<Check>) =>
  goodChecks.map((c, j) => (j === i ? ({ ...c, ...patch } as Check) : c))

describe('7.2 の受け入れ規則', () => {
  it('規則を全部満たす組は通る', () => {
    expect(check(goodChecks)).toEqual([])
  })

  it('id は C01 から連番', () => {
    expect(check(with_(2, { id: 'C07' })).join()).toContain('C03 にしてください')
  })

  it('summary に judge の語・数が出たら違反（部分の語も、桁区切りの違う数も）', () => {
    // question の中の「ブレスト」（カタカナの続き）
    expect(check(with_(1, { summary: 'ブレストの結論が伝わりません' })).join()).toContain('ブレスト')
    // 全文ではなく語で見る: 「納期遅延」は proposition の一部
    const q: Check['judge'] = {
      by: 'claude',
      question: '主要な懸念として納期遅延を取り上げているか',
      materials: ['draft'],
      scope: 'document',
    }
    expect(leaks({ judge: q, summary: '納期遅延を取り上げてください' })).toEqual(['納期遅延'])
    // args の数は 100 以上だけ。全角・桁区切りを揃える
    expect(check(with_(0, { summary: '本文が２，２００字に届いていません' })).join()).toContain('2200')
    expect(leaks({ judge: goodChecks[2]?.judge as Check['judge'], summary: '見出しを 4 個にしてください' })).toEqual([])
    // args の文字列は全体で
    expect(check(with_(3, { summary: 'アクメ社が入っています' })).join()).toContain('アクメ社')
    // 依頼に出てくる語（題材の名前）は漏れにしない
    expect(
      checksViolations(with_(1, { summary: 'ブレストの結論が伝わりません' }), shape, {
        minority: true,
        known: '{"summary":"先週のブレストを記事に"}',
      }),
    ).toEqual([])
    // ひらがなの続きは語にしない（どの summary も通らなくなるため）
    expect(judgeTerms(q).words).not.toContain('として')
  })

  it('summary は 1 行・80 字以内', () => {
    expect(check(with_(0, { summary: '二行に\nわたる' })).join()).toContain('1 行・80 字以内')
    expect(check(with_(0, { summary: 'あ'.repeat(81) })).join()).toContain('1 行・80 字以内')
    expect(check(with_(0, { summary: 'あ'.repeat(80) }))).toEqual([])
  })

  it('title・proposition・question に否定語があれば違反', () => {
    expect(check(with_(0, { title: '本文は短すぎない' })).join()).toContain('肯定形')
    // 言い直しで直せるよう、当たった所を前後付きで示す（「少ない」も当たる）
    expect(check(with_(0, { title: '専門用語が少ない文になっている' })).join()).toContain('「専門用語が少ない文に」')
    const neg: Check['judge'] = {
      by: 'jev',
      proposition: 'この段落は結論を含みません',
      state: ['paragraph'],
      scope: 'paragraph',
    }
    expect(check(with_(5, { judge: neg })).join()).toContain('肯定形')
  })

  it('見た目は by claude だけ', () => {
    const looks = with_(2, { category: '見た目' })
    expect(check(looks).join()).toContain('見た目')
  })

  it('件数は 5〜40（下書き役が書いた分）', () => {
    expect(check(goodChecks.slice(0, 4)).join()).toContain('5〜40')
    const many = Array.from({ length: 41 }, (_, i) => ({
      ...(goodChecks[i % 6] as Check),
      id: `C${String(i + 1).padStart(2, '0')}`,
    }))
    expect(check(many).join()).toContain('5〜40')
  })

  it('最低限の顔ぶれ: 依頼適合（claude / jev）・分量（code）、出典付きなら事実、合わせるなら声', () => {
    const noFit = goodChecks.map((c) => (c.category === '依頼適合' ? { ...c, category: '構成' as const } : c))
    expect(check(noFit).join()).toContain('依頼適合')
    expect(
      check(
        with_(0, {
          judge: {
            by: 'claude',
            question: '分量は依頼の範囲に収まっているか',
            materials: ['draft'],
            scope: 'document',
          },
        }),
      ).join(),
    ).toContain('分量')
    expect(check(goodChecks, { voice: '合わせる', sources: '出典付き' }).join()).toMatch(/事実.*声|声.*事実/)
  })

  it('下書き役は canary を書かない。同系統なら少数派が 3 件以上', () => {
    expect(check(with_(0, { canary: true })).join()).toContain('canary')
    const few = goodChecks.map((c) => ({ ...c, minority: undefined }))
    expect(check(few as Check[]).join()).toContain('少数派')
    expect(checksViolations(few as Check[], shape, { minority: false })).toEqual([])
  })
})

describe('ホストが足す項目', () => {
  it('canary 1 件と保存先ごとの形式の項目を、次の番号から足す（同じ種類は 1 件）', () => {
    const token = 'f'.repeat(32)
    const all = withHostItems(
      goodChecks,
      [{ kind: 'paste' }, { kind: 'page', shared: false }, { kind: 'paste' }],
      token,
    )
    expect(all.map((c) => c.id)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09'])
    expect(all[6]).toMatchObject({
      canary: true,
      judge: { by: 'code', fn: 'canary', args: { token } },
      pass: { kind: 'count', max: 0 },
      phase: '本文',
      summary: CANARY_SUMMARY,
      hidden: true,
    })
    expect(all[6]?.title).toContain(token)
    expect(all.slice(7).map((c) => [c.judge.by === 'code' && c.judge.fn, c.phase])).toEqual([
      ['pasteSafe', '形式'],
      ['pageRoundTrip', '形式'],
    ])
    // 足した項目も肯定形
    expect(checksViolations(all.slice(7), shape, { minority: false }).join()).not.toContain('肯定形')
  })

  it('7.2 の表のとおり: gsheet は 2 件、pptx は見た目（claude）も', () => {
    const fns = (t: Parameters<typeof withHostItems>[1]) =>
      withHostItems([], t, 'x'.repeat(32))
        .slice(1)
        .map((c) => (c.judge.by === 'code' ? c.judge.fn : c.judge.by))
    expect(fns([{ kind: 'gsheet', folderId: 'f' }])).toEqual(['sheetsRoundTrip', 'xlsxNoFormulaErrors'])
    expect(
      fns([
        { kind: 'file', format: 'pptx' },
        { kind: 'gslide', folderId: 'f' },
      ]),
    ).toEqual(['pptxNoBlankPages', 'claude'])
    expect(fns([{ kind: 'file', format: 'docx' }])).toEqual(['claude'])
  })
})

describe('classifyUndecided の照合', () => {
  const ids = goodChecks.map((c) => c.id)
  const answer: Classified = {
    items: [
      { checkId: 'C01', verdict: '決まる' },
      {
        checkId: 'C02',
        verdict: '決まらない',
        question: '読み終えた人に何を持ち帰ってほしいですか？',
        options: [
          { id: 'a', label: 'ブレストで決まったこと' },
          { id: 'b', label: '次に試すこと' },
        ],
        multiple: true,
        recommended: ['a', 'b'],
      },
      { checkId: 'C03', verdict: '食い違う', briefSays: '依頼書は見出しを 3 個としています' },
      { checkId: 'C04', verdict: '決まる' },
      { checkId: 'C05', verdict: '決まる' },
      { checkId: 'C06', verdict: '決まる' },
    ],
  }

  it('3 値の答えから Undecided と Mismatch を組み立てる', () => {
    expect(classifiedViolations(answer, ids)).toEqual([])
    const r = toUndecided(answer, goodChecks)
    expect(r.items).toEqual([
      {
        id: 'U01',
        question: answer.items[1]?.question,
        options: answer.items[1]?.options,
        multiple: true,
        recommended: ['a', 'b'],
      },
    ])
    expect(r.mismatches).toEqual([
      { checkId: 'C03', briefSays: '依頼書は見出しを 3 個としています', checkExpects: '見出しは 4〜5 個' },
    ])
  })

  it('渡した項目にちょうど 1 回ずつ。決まらないは問いと選択肢とおすすめ、食い違うは依頼書の文が要る', () => {
    const v = classifiedViolations(
      {
        items: [
          {
            checkId: 'C01',
            verdict: '決まらない',
            options: [{ id: 'a', label: 'x' }],
            multiple: false,
            recommended: ['z'],
          },
          { checkId: 'C01', verdict: '食い違う' },
          { checkId: 'C99', verdict: '決まる' },
        ],
      },
      ['C01', 'C02'],
    ).join('\n')
    for (const s of [
      'C01 はちょうど 1 回',
      'C02 はちょうど 1 回',
      'C99 は渡した',
      'question',
      '2〜4',
      'recommended',
      'briefSays',
    ])
      expect(v).toContain(s)
  })

  it('1 つだけか全部かを問いごとに。recommended の件数と id、任せるの予約を確かめる（6.2.6 (1)）', () => {
    const q = (o: Partial<Classified['items'][number]>) =>
      classifiedViolations(
        {
          items: [
            {
              checkId: 'C01',
              verdict: '決まらない',
              question: '本文に何を入れますか？',
              options: [
                { id: 'a', label: '決まったこと' },
                { id: 'b', label: '次に試すこと' },
              ],
              ...o,
            },
          ],
        },
        ['C01'],
      ).join('\n')
    expect(q({ multiple: true, recommended: ['a', 'b'] })).toBe('')
    expect(q({ recommended: ['a'] })).toContain('multiple を true か false')
    expect(q({ multiple: false, recommended: ['a', 'b'] })).toContain('ちょうど 1 つ')
    expect(q({ multiple: true, recommended: [] })).toContain('1 つ以上')
    expect(q({ multiple: true, recommended: ['a', 'a'] })).toContain('1 つ以上')
    expect(q({ multiple: true, recommended: ['z'] })).toContain('recommended')
    expect(
      q({
        multiple: false,
        options: [
          { id: '任せる', label: 'x' },
          { id: 'b', label: 'y' },
        ],
        recommended: ['b'],
      }),
    ).toContain('「任せる」は使えません')
  })

  it('recommended の文字列 1 つは配列に読む。指示の例は型と規則に通る', () => {
    const r = withoutNulls(Classified).parse({
      items: [{ checkId: 'C01', verdict: '決まらない', multiple: null, recommended: 'a' }],
    }) as Classified
    expect(r.items[0]).toMatchObject({ recommended: ['a'] })
    expect(r.items[0]?.multiple).toBeUndefined()
    expect(Classified.parse(CLASSIFIED_EXAMPLE)).toEqual(CLASSIFIED_EXAMPLE)
    expect(
      classifiedViolations(
        CLASSIFIED_EXAMPLE,
        CLASSIFIED_EXAMPLE.items.map((i) => i.checkId),
      ),
    ).toEqual([])
    expect(CLASSIFIED_EXAMPLE.items.map((i) => i.multiple)).toContain(true)
    expect(CLASSIFIED_EXAMPLE.items.map((i) => i.multiple)).toContain(false)
  })

  it('確かめ方と合格の条件を文にして渡す（同じ title でも値の違いが見える）', () => {
    expect(expects(goodChecks[0] as Check)).toBe('機械: charCount {"min":2200,"max":2800} / 合格: すべての単位で真')
    expect(expects(goodChecks[5] as Check)).toBe(
      '読み手（paragraphごと）: この段落は読者の次の行動を示している / 合格: 真の割合が 0.3 以上',
    )
  })
})

describe('下書き役への指示と型のずれ', () => {
  it('指示に載せた例は型と 7.2 の項目ごとの規則に通る', () => {
    for (const c of CHECK_EXAMPLES) expect(Check.parse(c)).toEqual(c)
    const v = checksViolations(CHECK_EXAMPLES, shape, { minority: false })
    expect(v.filter((x) => /C0\d/.test(x))).toEqual([])
  })

  it('任意の欄の null は欄が無いと読む', () => {
    const r = withoutNulls(ChecksDraft).safeParse({ checks: [{ ...CHECK_EXAMPLES[0], minority: null, canary: null }] })
    expect(r.success).toBe(true)
    expect(
      withoutNulls(Classified).safeParse({ items: [{ checkId: 'C01', verdict: '決まる', briefSays: null }] }).success,
    ).toBe(true)
  })
})

describe('依頼書の「渡してほしいもの」（6.2.4 (1)）', () => {
  const draft = (wanted: string[], text = '文末はです・ます') => ({
    ...BRIEF_EXAMPLE,
    brief: { ...BRIEF_EXAMPLE.brief, wanted },
    assumptions: [{ id: 'A1', text, why: '社内向けなので' }],
  })

  it('指示に載せた例は型と受け入れ規則に通る', () => {
    expect(BriefDraft.parse(BRIEF_EXAMPLE)).toEqual(BRIEF_EXAMPLE)
    expect(briefViolations(BRIEF_EXAMPLE)).toEqual([])
  })

  it('出力では欄が要る（書き落とし・null は言い直しに回る）。保存したファイルでは無ければ []', () => {
    const { wanted: _, ...rest } = BRIEF_EXAMPLE.brief
    expect(withoutNulls(BriefDraft).safeParse({ ...BRIEF_EXAMPLE, brief: rest }).success).toBe(false)
    expect(withoutNulls(BriefDraft).safeParse({ ...BRIEF_EXAMPLE, brief: { ...rest, wanted: null } }).success).toBe(
      false,
    )
    expect(Brief.parse({ ...rest, docType: '記事', destinations: [{ kind: 'paste' }], materials: [] }).wanted).toEqual(
      [],
    )
  })

  it('待つものを仮定に書いたら違反（当たった所を引用）。関係の無い「受け取る」は通す', () => {
    const v = briefViolations(draft([], 'ブレストの中身は本人からメモをもらって使う'))
    expect(v).toEqual([expect.stringContaining('「本人からメモをもら」')])
    expect(briefViolations(draft([], '読者が受け取る情報は 3 点に絞る'))).toEqual([])
    // wanted に書いてあれば、仮定に重ねて書いても違反にしない
    expect(briefViolations(draft(['ブレストのメモ'], '本人からメモをもらう'))).toEqual([])
  })

  it('重複と直訳調は違反', () => {
    expect(briefViolations(draft(['メモ', 'メモ']))).toEqual([expect.stringContaining('同じもの')])
    expect(briefViolations(draft(['会議において決まったことの記録']))).toEqual([expect.stringContaining('において')])
  })
})
