// 撮る状態の定義。状態を足すときはここに 1 つ足す（preview.ts と shoot.sh は触らない）
// どの状態も、会話で依頼を 1 つ出して入口待ち（本人の番）に着いたところから始まる（preview.ts）
import type { CaseAction, CaseView } from '@libretto/shared/api'
import { paragraphUnits, renderHtml } from '../../../host/src/checks/text.ts'
import type { ScriptEntry } from '../../../host/src/model/fake.ts'
import { briefDraft, classified, goodChecks } from '../../../host/test/fixtures/entrance.ts'
import { W, w } from '../../../page/src/wording.ts'

type Row = [ScriptEntry['role'], ScriptEntry['reply']]
type Omit2<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type Ctx = {
  caseId: string
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
}

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
const entrance = (brief: unknown = briefDraft): Row[] => [
  ['話し相手', say(done)],
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
// 判定役の Claude の答え（C02・C05 は本文全体、C06 は段落ごと）
const verdicts = (k: number, ok: boolean): Row => [
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
      {
        id: 'C06',
        units: paragraphUnits(body(k)).map((_, index) => ({ index, yes: true })),
        reason: 'どの段落も、読み手が次にすることにつながっています。',
      },
    ],
  }),
]

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
const clean: Row[] = [...entrance(), draft(1), verdicts(1, false), draft(2), verdicts(2, true)]
const hang: Row = ['作り手', { fail: 'hang' }]
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
    expect: (v) => v.state === '入口待ち' && v.entrance?.checks.family === '別系統',
    mark: W['entrance.otherFamily'],
  },
  // 設定: API キーが未設定
  'settings-unset': {
    script: entrance(),
    expect: (v) => v.state === '入口待ち',
    mark: W['settings.key.unsetNote'],
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
  // 送付の確認: 仕立てと保存先の形のチェックが済み、本人の番（仕立ては機械だけで、整えている間は撮れない）
  deliver: {
    script: clean,
    drive: toDeliver,
    expect: (v) => v.state === '送付確認待ち' && v.turn === '本人',
    mark: W['deliver.looksHeading'],
    selector: '.paste-preview',
  },
  // 成果: 保存して完了
  done: {
    script: clean,
    drive: toDone,
    expect: (v) => v.state === '完了',
    mark: W['result.receiveHeading'],
    selector: '.paste-preview',
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
