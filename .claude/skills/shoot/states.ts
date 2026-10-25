// 撮る状態の定義。状態を足すときはここに 1 つ足す（preview.ts と shoot.sh は触らない。State の欄は preview.ts がそのまま使う）
// どの状態も、会話で依頼を 1 つ出して入口待ち（本人の番）に着いたところから始まる（preview.ts）
import type { CaseAction, CaseView, HostStatus, IsolationCause } from '@libretto/shared/api'
import { MARK } from '@libretto/shared/checks'
import { transition } from '../../../host/src/case/transition.ts'
import type { IsolationRecord } from '../../../host/src/checks/isolation.ts'
import { paragraphUnits, plain, renderHtml } from '../../../host/src/checks/text.ts'
import type { Tools } from '../../../host/src/deliver/render.ts'
import { type Fetch, sentencesOf } from '../../../host/src/facts/inventory.ts'
import type { CardContent, Ledger } from '../../../host/src/ledger/ledger.ts'
import type { ScriptEntry } from '../../../host/src/model/fake.ts'
import type { Claude } from '../../../host/src/server/app.ts'
import { briefDraft, classified, goodChecks } from '../../../host/test/fixtures/entrance.ts'
import { W, w } from '../../../page/src/wording.ts'

type Row = [ScriptEntry['role'], ScriptEntry['reply']]
type Omit2<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type Ctx = {
  caseId: string
  ledger: Ledger // 画面の操作では作れないもの（候補）を入れる
  view: () => Promise<CaseView>
  // 今の revision と新しい eventId を付けて送る。2xx でなければ投げる
  act: (a: Omit2<CaseAction, 'eventId' | 'expectedRevision'>) => Promise<void>
  // ok が通るまで view を見る（最大 10 秒）。通らなければ投げる
  until: (ok: (v: CaseView) => boolean) => Promise<CaseView>
}

export type State = {
  script: Row[] // fake の台本（役割ごとに上から 1 回目、2 回目…）
  drive?: (ctx: Ctx) => Promise<void> // 入口待ちからこの状態まで進める
  expect: (v: CaseView) => boolean // 着いた案件がこの状態か。違えば preview は止まる（--check もここを見る）
  mark: string // この状態で画面に必ず出る文言。出るまで撮らない
  selector?: string // mark に加えて、あるまで撮らない要素（本文など）
  path?: (caseId: string) => string // 開く画面。既定は案件の面
  openaiKey?: true // 会話の前に OpenAI の API キーを入れておく（別系統で書く・設定済みの面）
  jevKey?: true // 会話の前に Jev の API キーを入れておく（項目の点検と判定に Jev を使う）
  sameFirst390?: true // 390 の 1 画面目が他の状態と同じでよい（違いが下の方にだけある）。重複の検査から外す
  // チェック項目を隠す仕組みの水準・原因・前回の確認（8.10。既定は strong・確認なし）
  isolation?: { level: HostStatus['isolation']; cause?: IsolationCause; last?: IsolationRecord }
  // 動作環境の確認の行（6.13）。無ければ道具・AI はそろっている扱い
  env?: { tools: Tools; claude: Claude; platform?: NodeJS.Platform }
  fetch?: Fetch // 出典の取り寄せの偽物（網に出ない。6.3.1 (5)）
  voiceSamples?: { title: string; url: string }[] // 会話の前に「あなたの文体の見本」を登録しておく（6.3.2 (10)）
  // Google と連携済みにする（偽の設定と google.json。Google へはつながない。6.4 (7)）。'gmail' は Drive の許可の無い前の連携（6.5 (2)）、
  // 'docs' は Meet のファイルの許可の無い前の連携（6.7 (1)）
  google?: true | 'gmail' | 'docs'
}

const at = (h: number) => `2026-10-24T${String(h).padStart(2, '0')}:05:00.000+09:00`
const CANDIDATES: [string, CardContent][] = [
  [
    'gmail:c1',
    {
      subject: '来週の定例で使う新サービスの紹介資料',
      from: '山田 花子',
      receivedAt: at(10),
      link: 'https://mail.google.com/',
      summary: '来週の定例で映す、新サービスの紹介スライドをまとめる',
      proposal: { docType: 'スライド', destination: [{ kind: 'page', shared: false }] },
      attachmentsNeeded: ['サービス概要.pdf'],
      attachments: ['サービス概要.pdf', 'ロゴ.png'],
    },
  ],
  [
    'gmail:c2',
    {
      subject: 'お客さま向けのお知らせ文のお願い',
      from: '佐藤 一郎',
      receivedAt: at(9),
      link: 'https://mail.google.com/',
      summary: '料金の改定をお客さまに知らせる文を、貼り付け用にまとめる',
      proposal: { docType: 'メモ', destination: [{ kind: 'paste' }] },
      attachmentsNeeded: [],
      attachments: [],
    },
  ],
]

const probed = (verdict: IsolationRecord['verdict']): IsolationRecord => ({
  at: '2026-10-24T05:03:00.000Z',
  level: 'strong',
  verdict,
  session: true,
  reached: true,
  hidden: verdict !== 'visible',
  homeOk: true,
  control: verdict === 'hidden',
  extraHome: [],
})

export const SHOOT_KEY = 'sk-shoot-0000000000001a2b' // 撮影用の偽の API キー（送らない。fake が答える）
const say = (v: unknown) => ({ text: JSON.stringify(v) })
const done = {
  text: '「先週のブレストのまとめ」として受け付けました。',
  intake: {
    title: '先週のブレストのまとめ',
    summary: '先週の社内ブレストの内容を note 記事にまとめる',
    docType: '記事',
    audience: '一般の読者',
    destinations: ['paste', 'page'],
  },
}
const entrance = (brief: unknown = briefDraft, intake: unknown = done): Row[] => [
  ['話し相手', say(intake)],
  ['下書き役・依頼書', say(brief)],
  ['下書き役・確認項目', say({ checks: goodChecks })],
  ['事実係・分類', say(classified)],
]

const fill = (s: string, n: number) => Array.from({ length: n }, () => s).join('')
// 2,200〜2,800 字・見出し 4 つ（goodChecks の機械判定が通る本文）。バージョンごとに数か所だけ変える
const body = (k: number) =>
  [
    '# 先週のブレストのまとめ',
    `先週の社内ブレストでは、来期の記事づくりの進め方について 3 つの方針が決まりました。${k > 1 ? 'この記事では、決まったことを先に書き、そのあとに理由を説明します。' : 'この記事では、話し合いの流れに沿って順に振り返ります。'}`,
    '## 決まったこと',
    fill('一つ目は、記事を出す前に必ず読み手の立場で読み直すことです。', 14),
    fill('二つ目は、数字や固有名詞には出典を添えることです。', 14),
    '## なぜそう決めたか',
    fill('これまでの記事では、書いた本人には分かっても初めて読む人には伝わらない箇所が残っていました。', 11),
    k > 1
      ? fill('読み直しの手順を決めておけば、誰が書いても同じ水準で出せます。', 12)
      : fill('読み直しは各自に任せてきました。', 22),
    '## 次に試すこと',
    fill('来月の記事 2 本で、この進め方を試します。', 14),
    '## まとめ',
    fill('決まった 3 つの方針を、まず小さく試してから広げます。', 11),
  ].join('\n\n')
const nn = (k: number) => String(k).padStart(2, '0')
const draft = (k: number): Row => [
  '作り手',
  {
    text: '書きました',
    write: {
      [`draft-${nn(k)}.md`]: body(k),
      // 本文と同じ中身の HTML（ページの形式の判定を通す。6.2.8 (1)）
      [`draft-${nn(k)}.html`]: renderHtml(body(k)),
      [`draft-${nn(k)}.done`]: 'done',
    },
  },
]
// 判定役の Claude の答え（C02・C05 は本文全体、C06 は段落ごと）。jev なら C06 は Jev が決めるので聞かれない
const verdicts = (k: number, ok: boolean, jev = false): Row => [
  '判定役・文章',
  say({
    results: [
      {
        id: 'C02',
        units: [{ index: 0, yes: ok }],
        reason: ok
          ? '冒頭で 3 つの方針が決まったと書かれ、見出し「決まったこと」で中身がすぐ分かります。'
          : '話し合いの流れに沿って書かれていて、何が決まったのかが本文の後半まで出てきません。',
      },
      { id: 'C05', units: [{ index: 0, yes: true }], reason: 'ふだんの言い回しで書かれています。' },
      ...(jev
        ? []
        : [
            {
              id: 'C06',
              units: paragraphUnits(body(k)).map((_, index) => ({ index, yes: true })),
              reason: 'どの段落も、読み手が次にすることにつながっています。',
            },
          ]),
    ],
  }),
]
// Jev の答え。送られた qid に関係なく全部を並べる（使われるのは送られた分だけ）
// 項目の点検（同系統で書いたとき。項目ごとに 1 要求）と、判定の C06（段落ごとに 1 要求）
const inspected: Row[] = goodChecks.map(() => [
  '事実係・命題',
  say({
    answers: Object.fromEntries(
      goodChecks.flatMap((c) => [
        [`${c.id}:derivable`, 0.8],
        [`${c.id}:positive`, 0.9],
        [`${c.id}:shapeOnly`, 0.1],
      ]),
    ),
  }),
])
const jevJudged = (k: number): Row[] => {
  const n = paragraphUnits(body(k)).length
  const answers = Object.fromEntries(Array.from({ length: n }, (_, i) => [`C06:${i}`, 0.9]))
  return Array.from({ length: n }, (): Row => ['判定役・命題', say({ answers })])
}

// おすすめのまま、確認しながら進める
const approve = async (ctx: Ctx) => {
  const v = await ctx.view()
  if (!v.entrance) throw new Error('no entrance')
  await ctx.act({
    type: 'entrance.approve',
    answers: Object.fromEntries(v.entrance.undecided.items.map((u) => [u.id, u.recommended])),
    mode: '確認しながら',
    setFingerprint: v.entrance.setFingerprint,
  })
  // 長い文書は最初のバージョンの前に構成案を 1 回通す（6.12 (2)）。資料待ち・中止ならそのまま
  const next = await ctx.until((x) => x.turn === '本人')
  if (next.state === '承認待ち' && next.approvalKind === '構成案')
    await ctx.act({ type: 'outline.approve', outlineFingerprint: next.outlineFingerprint as string })
}
const toApproval = async (ctx: Ctx) => {
  await approve(ctx)
  await ctx.until((v) => v.state === '承認待ち')
}
// 承認して、仕立てと保存先の形のチェックが済むまで（6.2.8 (1)）
const toDeliver = async (ctx: Ctx) => {
  await toApproval(ctx)
  const last = (await ctx.view()).versions.at(-1)
  if (!last) throw new Error('no version')
  await ctx.act({ type: 'approval.ok', marks: {}, versionFingerprint: last.fingerprint })
  await ctx.until((v) => v.state === '送付確認待ち' && v.turn === '本人')
}
const toDone = async (ctx: Ctx) => {
  await toDeliver(ctx)
  await ctx.act({ type: 'delivery.send', planFingerprint: (await ctx.view()).deliveryPlan.fingerprint })
  await ctx.until((v) => v.state === '完了')
}
// 出典付きの依頼: 出典のリンクの付いた主張と、【要確認】の付いた（出典が見つからなかった）文を 1 つずつ（6.3.1 (1)）
const SURVEY = 'https://example.com/survey'
// libretto がウェブで集めるものがある依頼（6.3.3 (1)）
const gatherBrief = {
  ...briefDraft,
  brief: { ...briefDraft.brief, sources: '出典付き', gather: ['記事の読了率についての公開の調査'] },
}
const factBody = body(2).replace(
  '\n\n## なぜそう決めたか',
  `\n\n社内の調査では、記事を最後まで読んだ人の割合は 2025 年に 38% でした（[記事の読了率の調査](${SURVEY})）。同じ進め方は、ほかの編集部でも広がっています。${MARK}\n\n## なぜそう決めたか`,
)
const CLAIM = '記事を最後まで読んだ人の割合は 2025 年に 38% でした'
const factRows: Row[] = [
  // 出典付きは資料の出どころが要る（6.3.3 (1)）。調査は libretto がウェブで集めた
  ...entrance(gatherBrief),
  ['事実係・集め', say({ sources: [{ url: SURVEY, why: '公式の調査' }] })],
  [
    '作り手',
    {
      text: '書きました',
      write: { 'draft-01.md': factBody, 'draft-01.html': renderHtml(factBody), 'draft-01.done': 'done' },
    },
  ],
  [
    '事実係・抜き出し',
    say({
      claims: [
        { text: CLAIM, kind: '数値' },
        { text: '同じ進め方は、ほかの編集部でも広がっています', kind: '断定' },
      ],
      // 数字を含むが主張ではない文（方針の数・予定）
      notClaims: sentencesOf(factBody)
        .filter((x) => !/^\s*#/.test(x.text) && /\d/.test(plain(x.text)) && !x.text.includes(CLAIM))
        .map((x) => x.text.trim()),
    }),
  ],
  ['事実係・命題', say({ yes: true, reason: '調査の段落が同じ年と割合を述べています。' })],
  [
    '判定役・文章',
    say({
      results: [
        { id: 'C02', units: [{ index: 0, yes: true }], reason: '冒頭で決まったことが分かります。' },
        { id: 'C05', units: [{ index: 0, yes: true }], reason: 'ふだんの言い回しで書かれています。' },
        {
          id: 'C06',
          units: paragraphUnits(factBody).map((_, index) => ({ index, yes: true })),
          reason: 'どの段落も、読み手が次にすることにつながっています。',
        },
      ],
    }),
  ],
]
const fakeSurvey: Fetch = async (url) => ({
  ok: true,
  url,
  title: '記事の読了率の調査（2025 年）',
  paragraphs: ['この調査は社内の記事 120 本を対象にした。', '2025 年に記事を最後まで読んだ人の割合は 38% でした。'],
  fingerprint: 'shoot',
})

// 文体を合わせる依頼（6.3.2）。見本はです・ますで「私」の文章。声の項目を 1 つ足した組で、本文の C07 も通る
const VOICE_URL = 'https://example.com/my-note'
const VOICE_DOC = [
  '# 私の書き方',
  '私は記事を書くとき、話し合いで決まったことを最初の段落に書くようにしています。読む人が冒頭の数行で結論をつかめると、そのあとの説明も落ち着いて読めるからです。理由はそのあとで、具体的な場面を一つ挙げながら短く説明します。',
  '書き終えたら、初めてその話題に触れる人の立場で最初から読み直します。社内でしか通じない言葉があれば、ふだんの言い方に置き換えて書き直します。数字や固有名詞には、どこで確かめたかが分かるように出典を添えます。',
  '記事の終わりには、読んだ人が次に試せることを一つだけ書きます。読んだ人が明日から少しでも動けるようにしたいと考えているからです。まずは小さく試して、うまくいったら少しずつ広げていきます。',
].join('\n\n')
const voiceChecks = [
  ...goodChecks,
  {
    id: 'C07',
    category: '声',
    title: '文末がです・ます調でそろっている',
    judge: { by: 'code', fn: 'sentenceEndingRatio', args: { endings: ['です', 'ます', 'でした', 'ました'] } },
    pass: { kind: 'ratio', min: 0.8 },
    phase: '本文',
    summary: '文末の調子がそろっていません',
    hidden: false,
    selfReport: '依頼に書いてある',
  },
]
const voiceEntrance: Row[] = [
  ['話し相手', say(done)],
  ['下書き役・依頼書', say({ ...briefDraft, brief: { ...briefDraft.brief, voice: '合わせる' } })],
  ['下書き役・確認項目', say({ checks: voiceChecks })],
  ['事実係・分類', say({ items: [...classified.items, { checkId: 'C07', verdict: '決まる' }] })],
]
// 読み比べの項目の id: 下書き役の 7 件・canary・文体の 3 項目の次
const READ_ALIKE_ID = 'C12'
const voiceRows: Row[] = [
  ...voiceEntrance,
  [
    '事実係・描写',
    say({
      portrait: [
        '結論を先に書き、理由を短く添える。',
        'です・ます調で、ふだんの言葉を選ぶ。',
        '終わりに次の一歩を置く。',
      ],
    }),
  ],
  [
    '作り手',
    {
      text: '書きました',
      write: { 'draft-01.md': body(2), 'draft-01.html': renderHtml(body(2)), 'draft-01.done': 'done' },
    },
  ],
  [
    '判定役・文章',
    say({
      results: [
        { id: 'C02', units: [{ index: 0, yes: true }], reason: '冒頭で決まったことが分かります。' },
        { id: 'C05', units: [{ index: 0, yes: true }], reason: 'ふだんの言い回しで書かれています。' },
        {
          id: 'C06',
          units: paragraphUnits(body(2)).map((_, index) => ({ index, yes: true })),
          reason: 'どの段落も、読み手が次にすることにつながっています。',
        },
        { id: READ_ALIKE_ID, units: [{ index: 0, yes: true }], reason: '結論を先に置く運びが見本と同じです。' },
      ],
    }),
  ],
]
const fakeVoice: Fetch = async (url) => ({
  ok: true,
  url,
  title: '私の書き方',
  paragraphs: VOICE_DOC.split('\n\n'),
  fingerprint: 'voice',
  md: VOICE_DOC,
})
const VOICE_SAMPLES = [
  { title: '私の書き方', url: VOICE_URL },
  { title: '週報の書き方を変えた話', url: 'https://example.com/weekly-report' },
]

const clean: Row[] = [...entrance(), draft(1), verdicts(1, false), draft(2), verdicts(2, true)]
const hang: Row = ['作り手', { fail: 'hang' }]
// 構成案（6.12 (2)）。goodChecks の字数（2,200〜2,800 字）は長い文書なので、作り手の最初の回は構成案になる
const OUTLINE_MD = [
  '# 先週のブレストのまとめ',
  '## 決まったこと',
  '- 来期の記事づくりで決まった 3 つの方針を、先に箇条で示す',
  '- 方針ごとに 1 段落で、具体的に何が変わるかを書く',
  '## そう決めた理由',
  '- 読み手の立場で読み直すことにした背景（前期の読了率）',
  '- 公開前のダブルチェックを足した理由',
  '## これからの進め方',
  '- 来月から試す手順と、うまくいったかを確かめる時期',
  '## まとめ',
  '- 3 つの方針を 1 行ずつで振り返る',
].join('\n\n')
const outlined: Row = [
  '作り手',
  { text: '構成案を書きました', write: { 'outline.md': OUTLINE_MD, 'outline.done': 'done' } },
]
// mark の項目数・件数と合わせる（Approval.tsx は本文と形式の判定を足して出す）
const verdictOf = (v: CaseView) => ({
  passed: (v.review?.passed ?? 0) + (v.formatReview?.passed ?? 0),
  failed: (v.review?.failed.length ?? 0) + (v.formatReview?.failed.length ?? 0),
  skipped: (v.review?.skipped ?? 0) + (v.formatReview?.skipped ?? 0),
})
const allPassed = (v: CaseView) => {
  const r = verdictOf(v)
  return v.state === '承認待ち' && v.approvalKind === '完成稿' && r.failed + r.skipped === 0 && r.passed === 7
}

export const STATES: Record<string, State> = {
  // 入口: 依頼書とチェック項目の確認
  entrance: {
    script: entrance(),
    expect: (v) => v.state === '入口待ち' && v.turn === '本人' && !!v.entrance,
    mark: W['entrance.undecidedHeading'],
  },
  // 入口: API キーがあり、チェック項目を別の種類の AI が作った
  'entrance-other': {
    script: entrance(),
    openaiKey: true,
    sameFirst390: true, // 違いはチェック項目の欄の 1 行だけで、390 の 1 画面目には入らない
    expect: (v) => v.state === '入口待ち' && v.entrance?.checks.family === '別系統',
    mark: W['entrance.otherFamily'],
  },
  // ホーム: ラベルを付けたメールの依頼の候補（6.4 (7)）。Google は連携済みにして、候補は台帳に直接入れる
  'home-candidates': {
    script: entrance(),
    google: true,
    drive: async (ctx) => {
      for (const [id, card] of CANDIDATES) {
        const r = transition(ctx.ledger, {
          type: 'candidate.presented',
          candidate: {
            candidateId: id,
            source: 'gmail',
            origin: '合図',
            aiInstructionFlag: id === 'gmail:c2',
            senderKey: id,
          },
          card,
        })
        if (!r.ok) throw new Error(`candidate ${id}: ${r.reason}`)
      }
    },
    expect: (v) => v.state === '入口待ち',
    mark: W['home.candHeading'],
    selector: '.cand',
    path: () => '/',
  },
  // ホーム: 会議メモの行動項目の候補（会議・高と、折りたたんだ推測・低）と、候補にならなかったメモ（6.7 (5)）
  'home-meet': {
    script: entrance(),
    google: true,
    drive: async (ctx) => {
      const link = (id: string) => `https://docs.google.com/document/d/${id}/edit`
      const items: [string, '会議' | '推測', '高' | '低', string, string][] = [
        ['meet:f1:aaaaaaaaaaaa', '会議', '高', '岩間 涼', '来週の定例で使う、新サービスの紹介資料をまとめる'],
        ['meet:f1:bbbbbbbbbbbb', '推測', '低', '', '会議の内容を関係者向けのメモにまとめる'],
      ]
      for (const [id, origin, confidence, from, summary] of items) {
        const r = transition(ctx.ledger, {
          type: 'candidate.presented',
          candidate: {
            candidateId: id,
            source: 'meet',
            origin,
            confidence,
            aiInstructionFlag: false,
            senderKey: 'meet:ブレスト',
          },
          card: {
            subject: 'ブレスト',
            from,
            receivedAt: at(11),
            link: link('f1'),
            ...(origin === '推測' && { reason: '担当がチームと書かれています' }),
            summary,
            proposal: { docType: 'メモ', destination: [{ kind: 'page', shared: false }] },
            attachmentsNeeded: [],
            attachments: [],
            account: 'me@example.com',
          },
        })
        if (!r.ok) throw new Error(`candidate ${id}: ${r.reason}`)
      }
      const notes = [
        ['f2', '定例', 'none'],
        ['f3', '朝会', 'unreadable'],
        ['f4', '1on1', 'notMine'],
      ] as const
      for (const [fileId, title, result] of notes)
        ctx.ledger.putMeetNote({
          account: 'me@example.com',
          fileId,
          title,
          heldAt: at(9),
          link: link(fileId),
          modifiedTime: '2026-10-24T00:10:00.000Z',
          result,
          truncated: false,
        })
    },
    expect: (v) => v.state === '入口待ち',
    mark: W['cand.mark.meet.高'],
    selector: '.cand',
    path: () => '/',
  },
  // ホーム: お知らせ欄の 1 行は面へのリンク（6.8 (3)）。会話で出した依頼の「依頼内容がまとまりました」が入っている
  'home-notice': {
    script: entrance(),
    expect: (v) => v.state === '入口待ち',
    mark: W['home.noticeHeading'],
    selector: '.notices a',
    path: () => '/',
    sameFirst390: true, // お知らせ欄は 390 の 1 画面目より下にある
  },
  // 設定: 動作環境の確認で足りないものがある（6.13）。AI のログイン切れ・隠す道具・ファイルを作る道具・スマホは未設定
  'settings-env-missing': {
    script: entrance(),
    isolation: { level: 'weak', cause: 'tools' },
    env: { tools: {}, claude: { version: '2.1.310', ok: true, signedIn: false } },
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.ai.signedOutWhy'],
    selector: '.env-cmd',
    path: () => '/settings',
    sameFirst390: true, // 動作環境の確認は 390 の 1 画面目より下にある
  },
  // ホーム: 動作環境で足りないものがあり、先頭に帯が出る（6.13 (2)）
  'home-env-missing': {
    script: entrance(),
    isolation: { level: 'weak', cause: 'tools' },
    env: { tools: {}, claude: { version: '2.1.310', ok: true, signedIn: false } },
    expect: (v) => v.state === '入口待ち',
    mark: w('band.envMissing', { n: 3 }),
    path: () => '/',
  },
  // 設定: 動作環境の確認で全部そろっている（直った行は済みの印。6.13）
  'settings-env-ok': {
    script: entrance(),
    env: {
      tools: { soffice: 'soffice', pdftoppm: 'pdftoppm' },
      claude: { version: '2.1.310', ok: true, signedIn: true },
    },
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.env.ok'],
    path: () => '/settings',
    sameFirst390: true,
  },
  // 設定: お知らせの節（この端末の状態と、出来事ごとの入り切り。6.8 (6)）
  'settings-notices': {
    script: entrance(),
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.notices.kinds'],
    path: () => '/settings',
    sameFirst390: true, // お知らせの節は 390 の 1 画面目より下にある
  },
  // 設定: 端末の節（この端末と、別の端末を追加する。6.12 (5)）
  'settings-devices': {
    script: entrance(),
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.devices.add'],
    selector: '.device-list',
    path: () => '/settings',
    sameFirst390: true, // 端末の節は 390 の 1 画面目より下にある
  },
  // 設定: Google と連携済み（6.4 (7)）
  'settings-google': {
    script: entrance(),
    google: true,
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.google.connected'],
    path: () => '/settings',
    sameFirst390: true,
  },
  // 設定: Gmail だけで連携していて、Google ドキュメントには連携し直しが要る（6.5 (2)）
  'settings-google-docs': {
    script: entrance(),
    google: 'gmail',
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.google.docsMissing'],
    path: () => '/settings',
    sameFirst390: true,
  },
  // 設定: Meet のファイルの許可の無い前の連携で、会議メモには連携し直しが要る（6.7 (1)）
  'settings-google-meet': {
    script: entrance(),
    google: 'docs',
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.google.meetMissing'],
    path: () => '/settings',
    sameFirst390: true,
  },
  // 設定: API キーが未設定
  'settings-unset': {
    script: entrance(),
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.openai.unsetNote'],
    path: () => '/settings',
  },
  // 設定: API キーが設定済み
  'settings-set': {
    script: entrance(),
    openaiKey: true,
    expect: (v) => v.state === '入口待ち',
    mark: w('settings.key.set', { last4: SHOOT_KEY.slice(-4) }),
    path: () => '/settings',
  },
  // 設定: 隠す仕組みが弱い（必要なソフトが無い）。前回は確かめられなかった
  'settings-weak': {
    script: entrance(),
    isolation: { level: 'weak', cause: 'tools', last: { ...probed('unknown'), level: 'weak' } },
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.probe.unknown'],
    path: () => '/settings',
    sameFirst390: true, // Jev の API キーの行が増え、動作環境の欄は 390 の 1 画面目より下にある（違いはそこだけ）
  },
  // 設定: しっかり隠せているはずが、前回の確認で見えた
  'settings-visible': {
    script: entrance(),
    isolation: { level: 'strong', last: probed('visible') },
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.probe.visible'],
    path: () => '/settings',
    sameFirst390: true, // Jev の API キーの行が増え、動作環境の欄は 390 の 1 画面目より下にある（違いはそこだけ）
  },
  // 入口: 隠す仕組みが弱い（素の Windows）帯
  'entrance-weak': {
    script: entrance(),
    isolation: { level: 'weak', cause: 'windows' },
    expect: (v) => v.state === '入口待ち' && v.turn === '本人' && !!v.entrance,
    mark: W['band.isolationWeak'],
  },
  // 入口: 渡してほしいものがあり、その行の中に次の画面で貼り付けることを書く（GitHub #68）
  'entrance-wanted': {
    script: entrance({ ...briefDraft, brief: { ...briefDraft.brief, wanted: ['ブレストのメモ'] } }),
    expect: (v) => v.state === '入口待ち' && v.turn === '本人' && !!v.entrance?.brief.wanted.length,
    mark: W['entrance.wantedNote'],
  },
  // 進行: 渡してほしいものを待っている（本人の番）
  materials: {
    script: entrance({ ...briefDraft, brief: { ...briefDraft.brief, wanted: ['ブレストのメモ'] } }),
    drive: async (ctx) => {
      await approve(ctx)
      await ctx.until((v) => v.state === '材料待ち' && v.turn === '本人')
    },
    expect: (v) => v.state === '材料待ち' && v.turn === '本人',
    mark: W['materials.lead'],
  },
  // 入口: libretto がウェブで集めるものがある（6.3.3 (7)）
  'entrance-gather': {
    script: entrance(gatherBrief),
    expect: (v) => v.state === '入口待ち' && v.turn === '本人' && !!v.entrance?.brief.gather.length,
    mark: W['entrance.gatherNote'],
  },
  // 進行: libretto が集めた出典を資料に足し、下書きを書いている
  gathered: {
    script: [...entrance(gatherBrief), ['事実係・集め', say({ sources: [{ url: SURVEY, why: '公式の調査' }] })], hang],
    fetch: fakeSurvey,
    sameFirst390: true, // 違いは資料の欄で、390 の 1 画面目には入らない
    drive: async (ctx) => {
      await approve(ctx)
      await ctx.until((v) => v.state === '下書き中')
    },
    expect: (v) => v.state === '下書き中' && v.materials.some((m) => m.gathered),
    mark: W['progress.materialGathered'],
  },
  // 進行: ウェブで資料を見つけられなかったが、止めずに下書きを書いている
  'gather-failed': {
    script: [...entrance(gatherBrief), ['事実係・集め', say({ sources: [] })], hang],
    sameFirst390: true, // 違いは資料の欄の 1 行で、390 の 1 画面目には入らない
    drive: async (ctx) => {
      await approve(ctx)
      await ctx.until((v) => v.state === '下書き中')
    },
    expect: (v) => v.state === '下書き中' && !!v.gatherFailed,
    mark: W['progress.gatherFailed'],
  },
  // 進行: 下書きを書いている（作り手は返らない）
  drafting: {
    script: [...entrance(), hang],
    drive: async (ctx) => {
      await approve(ctx)
      await ctx.until((v) => v.state === '下書き中')
    },
    expect: (v) => v.state === '下書き中',
    mark: W['progress.redoLater'],
  },
  // 構成案: 長い文書で、最初のバージョンの前に構成案を確かめる（6.12 (3)）
  outline: {
    script: [...entrance(), hang],
    drive: async (ctx) => {
      const v = await ctx.view()
      if (!v.entrance) throw new Error('no entrance')
      await ctx.act({
        type: 'entrance.approve',
        answers: Object.fromEntries(v.entrance.undecided.items.map((u) => [u.id, u.recommended])),
        mode: '確認しながら',
        setFingerprint: v.entrance.setFingerprint,
      })
      await ctx.until((x) => x.state === '承認待ち' && x.approvalKind === '構成案')
    },
    expect: (v) => v.state === '承認待ち' && v.approvalKind === '構成案' && !!v.outline,
    mark: W['outline.lead'],
    selector: '.outline-body',
  },
  // 承認: 2 版目で全部通った
  'approval-clean': {
    script: clean,
    drive: toApproval,
    expect: allPassed,
    mark: w('approval.allPassed', { n: 7 }),
    selector: '.doc-body',
  },
  // 承認: 3 回とも直しきれなかった項目が残った（理由文付き）
  'approval-left': {
    script: [...entrance(), draft(1), verdicts(1, false), draft(2), verdicts(2, false), draft(3), verdicts(3, false)],
    drive: toApproval,
    expect: (v) => v.state === '承認待ち' && v.approvalKind === '完成稿' && verdictOf(v).failed === 1,
    mark: w('approval.remaining', { n: 1 }),
    selector: '.doc-body',
  },
  // 承認: 隠す仕組みが動かない帯（全部通った版）
  'approval-broken': {
    script: clean,
    isolation: { level: 'broken', cause: 'network' },
    drive: toApproval,
    expect: allPassed,
    mark: W['band.isolationBroken'],
    selector: '.doc-body',
  },
  // 承認: Jev の鍵があり、段落ごとの項目を判定専用の AI が確かめた（注記の 1 行。7.6 (6)）
  'approval-jev': {
    script: [
      ...entrance(),
      ...inspected,
      draft(1),
      ...jevJudged(1),
      verdicts(1, false, true),
      draft(2),
      ...jevJudged(2),
      verdicts(2, true, true),
    ],
    jevKey: true,
    sameFirst390: true, // 違いはチェックの結果の注記の 1 行だけで、390 の 1 画面目には入らない
    drive: toApproval,
    expect: (v) => allPassed(v) && !!v.review?.jev,
    mark: w('approval.judgeModel', { units: paragraphUnits(body(2)).length }),
    selector: '.doc-body',
  },
  // 承認: 出典付きの依頼で、出典が見つからなかった文が 1 つと、裏付けのある出典が 1 つ（6.3.1 (11)）
  'approval-facts': {
    script: factRows,
    fetch: fakeSurvey,
    drive: toApproval,
    expect: (v) =>
      v.state === '承認待ち' &&
      v.review?.needsConfirmation.length === 1 &&
      v.review.sources[0]?.verdict === '支持' &&
      v.review.failed.length === 0,
    mark: W['approval.marksHeading'],
    selector: '.doc-body',
  },
  // 入口: 文体の見本から文体を読み取った。過去の文章で確かめた項目に印（6.3.2 (2)(5)）
  'entrance-voice': {
    script: voiceEntrance,
    voiceSamples: VOICE_SAMPLES,
    fetch: fakeVoice,
    sameFirst390: true, // 違いはチェック項目の欄の 1 行と印だけ
    expect: (v) => v.state === '入口待ち' && v.entrance?.checks.voice?.card === true,
    mark: w('entrance.voice.made', { n: 2 }),
  },
  // 入口: 文体を合わせる依頼なのに、見本が無い（6.3.2 (2)）
  'entrance-novoice': {
    script: voiceEntrance,
    sameFirst390: true,
    expect: (v) => v.state === '入口待ち' && v.entrance?.checks.voice?.card === false,
    mark: W['entrance.voice.none'],
  },
  // 承認: 文体カードと比べた結果（6.3.2 (9)）
  'approval-voice': {
    script: voiceRows,
    voiceSamples: VOICE_SAMPLES,
    fetch: fakeVoice,
    drive: toApproval,
    expect: (v) => v.state === '承認待ち' && !!v.review?.voiceMatch && v.review.failed.length === 0,
    mark: W['approval.voiceHeading'],
    selector: '.voice-match',
  },
  // 設定: あなたの文体の見本を 2 件登録した（6.3.2 (10)）
  'settings-voice': {
    script: entrance(),
    voiceSamples: VOICE_SAMPLES,
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.voiceHeading'],
    selector: '.voice-row',
    path: () => '/settings',
  },
  // 送付の確認: 仕立てと保存先の形のチェックが済み、本人の番（仕立ては機械だけで、整えている間は撮れない）
  deliver: {
    script: clean,
    drive: toDeliver,
    expect: (v) => v.state === '送付確認待ち' && v.turn === '本人',
    mark: W['deliver.looksHeading'],
    selector: '.paste-preview',
  },
  // 送付の確認: 保存先に Google ドキュメントがある（6.5 (8)）。保存は Google につながるので撮らない
  'deliver-gdoc': {
    script: [
      ...entrance(briefDraft, { ...done, intake: { ...done.intake, destinations: ['page', 'gdoc'] } }),
      draft(1),
      verdicts(1, false),
      draft(2),
      verdicts(2, true),
    ],
    google: true,
    drive: toDeliver,
    expect: (v) =>
      v.state === '送付確認待ち' && v.turn === '本人' && v.deliveryPlan.targets.some((t) => t.kind === 'gdoc'),
    mark: W['dest.gdoc'],
  },
  // 成果: 保存して完了
  done: {
    script: clean,
    drive: toDone,
    expect: (v) => v.state === '完了',
    mark: W['result.receiveHeading'],
    selector: '.paste-preview',
  },
  // 成果: 貼り付け用だけで完了し、Web ページを足せる（#72。長い保存先の名前のボタンが 390 ではみ出さない）
  'done-add': {
    script: [
      ...entrance(briefDraft, { ...done, intake: { ...done.intake, destinations: ['paste'] } }),
      draft(1),
      verdicts(1, false),
      draft(2),
      verdicts(2, true),
    ],
    drive: toDone,
    expect: (v) => v.state === '完了' && v.deliveryPlan.targets.every((t) => t.kind === 'paste'),
    mark: W['result.addHeading'],
    selector: '.result-add',
  },
  // 完了した依頼の一覧
  'done-list': {
    script: clean,
    drive: toDone,
    expect: (v) => v.state === '完了',
    mark: W['done.open'],
    path: () => '/done',
  },
  // 版のあるページ（保存した Web ページそのもの）
  page: {
    script: clean,
    drive: toDone,
    expect: (v) => v.state === '完了',
    mark: 'バージョン 2', // ページの末尾の 1 行（host/src/deliver/page.ts）
    path: (caseId) => `/cases/${caseId}/page`,
  },
  // 進行: 下書きの途中で中止した
  stopped: {
    script: [...entrance(), hang],
    drive: async (ctx) => {
      await approve(ctx)
      await ctx.until((v) => v.state === '下書き中')
      await ctx.act({ type: 'stop.case' })
      await ctx.until((v) => v.state === '停止')
    },
    expect: (v) => v.state === '停止',
    mark: W['progress.stoppedHeading'],
  },
}

// 作り手の最初の回は構成案（6.12 (2)）。作り手を呼ぶ状態の台本の、最初の作り手の行の前に差し込む
// （台本の配列は状態どうしで共有しているので、書き換えずに作り直す）
for (const st of Object.values(STATES)) {
  const i = st.script.findIndex(([role]) => role === '作り手')
  if (i >= 0) st.script = [...st.script.slice(0, i), outlined, ...st.script.slice(i)]
}
