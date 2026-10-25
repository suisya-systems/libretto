// お知らせ（docs/implementation.md 6.8）。どの遷移が何を書くかの行ごとの表、候補の 1 通、送り出し、設定の入り切り
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryTarget, Notice } from '@libretto/shared/api'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Ctx, type Input, noticeCandidates, planFingerprint, SAY, transition } from '../src/case/transition.ts'
import { initHome, openDb } from '../src/ledger/db.ts'
import { Ledger } from '../src/ledger/ledger.ts'
import { createServer } from '../src/server/app.ts'
import { createNotices, quietAt, type Sender } from '../src/server/notices.ts'
import { createHub, type SseMessage } from '../src/server/sse.ts'

let ledger: Ledger
let clock: Date
let n = 0
const id = () => `e${++n}`
beforeEach(() => {
  clock = new Date('2026-10-23T03:00:00Z')
  ledger = new Ledger(openDb(':memory:'), () => clock)
})

const get = () => ledger.getCase('c1') ?? expect.unreachable()
const run = (ev: Record<string, unknown>, ctx?: Ctx) => {
  const r = transition(ledger, ev as Input, ctx)
  expect(r).toMatchObject({ ok: true })
  return r
}
const person = (type: string, rest: Record<string, unknown> = {}, ctx?: Ctx) =>
  run({ type, caseId: 'c1', by: '本人', eventId: id(), expectedRevision: get().revision, ...rest }, ctx)
const host = (type: string, rest: Record<string, unknown> = {}, ctx?: Ctx) =>
  run({ type, caseId: 'c1', by: 'libretto', eventId: id(), expectedRevision: get().revision, ...rest }, ctx)
const notices = () => ledger.listNotices(100).reverse()
const lastNotice = () => notices().at(-1)

const paste: DeliveryTarget = { kind: 'paste' }
function request(mode: '確認しながら' | 'おまかせ' = '確認しながら') {
  run({
    type: 'conversation.request',
    eventId: id(),
    caseId: 'c1',
    title: '週報',
    mode,
    docType: '記事',
    destination: [paste],
  })
}
const drafted = () => host('entrance.drafted', { setFingerprint: 'set1' })
const approve = (ctx?: Ctx) =>
  person('entrance.approve', { answers: {}, mode: get().mode, setFingerprint: 'set1' }, ctx)
const draft = () => host('draft.done', { n: get().version + 1, versionFingerprint: `v${get().version + 1}` })
const toChecking = (mode: '確認しながら' | 'おまかせ' = '確認しながら') => {
  request(mode)
  drafted()
  approve()
  host('materials.ready')
  draft()
}
const toConfirmSave = () => {
  toChecking('おまかせ')
  host('review.pass', { n: 1 })
  host('format.checked', { n: 1, outputFingerprint: 'o1' })
}
const mark = (claimId: string) => ({ claimId, text: `主張 ${claimId}`, where: '冒頭' })

describe('どの遷移が何を書くか（6.8 (1)）', () => {
  it('T6 依頼の確認（auto=false）は確認待ち。画面の外へも出す', () => {
    request()
    expect(notices()).toEqual([])
    drafted()
    expect(notices()).toEqual([
      {
        id: 1,
        at: '2026-10-23T12:00:00.000+09:00',
        caseId: 'c1',
        kind: 'your_turn',
        text: '『週報』の依頼内容がまとまりました。確認して承認してください',
        path: '/cases/c1',
        outside: true,
      },
    ])
  })

  it('T6b 整えられなかった', () => {
    request()
    host('entrance.failed')
    expect(lastNotice()).toMatchObject({
      kind: 'your_turn',
      text: '『週報』の依頼書とチェック項目を整えられませんでした。直して出し直すか取り消せます',
    })
  })

  it('T8 本人の「これで進める」で資料待ち: お知らせ欄には残すが、画面の外へは出さない', () => {
    request()
    drafted()
    approve({ materialsPending: true })
    expect(lastNotice()).toMatchObject({
      kind: 'your_turn',
      text: '『週報』で資料を待っています。貼り付けると続きを進めます',
      outside: false,
    })
  })

  it('T8 資料が要らなければ libretto の番なので書かない', () => {
    request()
    drafted()
    approve()
    expect(notices()).toHaveLength(1)
  })

  it('T11 下書きに取りかかったは書くが、既定では画面の外へ出さない', () => {
    request()
    drafted()
    approve()
    host('materials.ready')
    expect(lastNotice()).toMatchObject({ kind: 'started', text: '『週報』の下書きを書き始めました', outside: false })
  })

  it('T13 構成案', () => {
    request()
    drafted()
    approve()
    host('materials.ready')
    host('outline.done', { outlineFingerprint: 'out1' })
    expect(lastNotice()).toMatchObject({ kind: 'your_turn', text: '『週報』の構成案ができました。確認してください' })
  })

  it('T15 最終版。要確認が残れば数を言う', () => {
    toChecking()
    host('review.pass', { n: 1 }, { marks: [mark('K1'), mark('K2')] })
    expect(lastNotice()).toMatchObject({
      kind: 'your_turn',
      text: '『週報』の最終版ができました。要確認が 2 件あります。確認して承認してください',
    })
  })

  it('T17 確認しながらは往復上限で最終版の確認待ち', () => {
    toChecking()
    for (let i = 0; i < 2; i++) {
      host('review.fail', { n: get().version })
      draft()
    }
    host('review.fail', { n: get().version })
    expect(get().state).toBe('承認待ち')
    expect(lastNotice()).toMatchObject({
      kind: 'your_turn',
      text: '『週報』の最終版ができました。確認して承認してください',
    })
  })

  it('T17 おまかせは中止の 1 通だけ（確認待ちとして二重に書かない）', () => {
    toChecking('おまかせ')
    for (let i = 0; i < 2; i++) {
      host('review.fail', { n: get().version })
      draft()
    }
    const before = notices().length
    host('review.fail', { n: get().version })
    expect(notices()).toHaveLength(before + 1)
    expect(lastNotice()).toMatchObject({
      kind: 'stopped',
      text: `『週報』は、${SAY.roundLimit}。新しい依頼として出し直せます`,
      outside: true,
    })
  })

  it('T20 保存先の確認は送付の面を開く', () => {
    toConfirmSave()
    expect(lastNotice()).toMatchObject({
      kind: 'your_turn',
      text: '『週報』を保存する前の確認です。保存先と公開範囲を確かめてください',
      path: '/cases/c1/deliver',
    })
  })

  it('T24 完了。T26c 共有の取り消し（完了 → 完了）は書かない', () => {
    toConfirmSave()
    const sendId = id()
    run({
      type: 'delivery.send',
      caseId: 'c1',
      by: '本人',
      eventId: sendId,
      expectedRevision: get().revision,
      planFingerprint: planFingerprint(get()),
    })
    run({
      type: 'delivery.done',
      caseId: 'c1',
      by: 'libretto',
      eventId: id(),
      attemptId: `${sendId}:0`,
      receiptId: 'r1',
    })
    expect(lastNotice()).toMatchObject({ kind: 'done', text: '『週報』を保存しました。開いて確かめられます' })
  })

  it('T29 費用の上限で中止。理由の文は会話欄と同じ', () => {
    request()
    run({ type: 'cost.cap', by: '費用', caseId: 'c1', eventId: 'c1:cost.cap:k1', scope: '案件', callId: 'k1' })
    expect(lastNotice()).toMatchObject({
      kind: 'stopped',
      text: `『週報』は、${SAY.costCap}。新しい依頼として出し直せます`,
    })
  })

  it('T27b 隔離の失敗は見えたおそれを言う', () => {
    request()
    host('fail.system', { reason: '隔離の失敗' })
    expect(lastNotice()?.text).toBe(`『週報』は、${SAY.isolationLeaked}。新しい依頼として出し直せます`)
  })

  it('T27 本人の中止と T31 新しい依頼として出し直すは書かない', () => {
    request()
    person('stop.case', {})
    person('restart_as_new', {})
    expect(notices()).toEqual([])
  })

  it('同じ遷移の再送で 2 行にならない', () => {
    request()
    const ev = {
      type: 'entrance.drafted',
      caseId: 'c1',
      by: 'libretto',
      eventId: 'same',
      expectedRevision: 0,
      setFingerprint: 's',
    }
    run(ev)
    expect(run(ev)).toMatchObject({ replayed: true })
    expect(notices()).toHaveLength(1)
  })

  it('お知らせを書けなければ遷移も残らない（同じトランザクション）', () => {
    request()
    ledger.noticeRoute = {
      on: () => true,
      targets: () => {
        throw new Error('boom')
      },
    }
    expect(() => drafted()).toThrow('boom')
    expect(get()).toMatchObject({ turn: 'libretto', revision: 0 })
    expect(notices()).toEqual([])
  })
})

describe('入り切りと送り先（6.8 (5)）', () => {
  it('本人が切った出来事は画面の外へ出さない。送り先の pending は画面の外へ出すものだけ', () => {
    ledger.noticeRoute = { on: (k) => k !== 'your_turn', targets: () => ['push:s1'] }
    request()
    drafted()
    expect(lastNotice()?.outside).toBe(false)
    expect(ledger.dueDeliveries(clock)).toEqual([])
    run({ type: 'cost.cap', by: '費用', caseId: 'c1', eventId: 'c1:cost.cap:k1', scope: '案件', callId: 'k1' })
    expect(ledger.dueDeliveries(clock)).toEqual([
      expect.objectContaining({ kind: 'stopped', target: 'push:s1', tries: 0 }),
    ])
  })
})

describe('候補の 1 通（6.8 (4)）', () => {
  const candidate = (candidateId: string, extra: Record<string, unknown> = {}) =>
    transition(ledger, {
      type: 'candidate.presented',
      candidate: { candidateId, source: 'gmail', origin: '合図', aiInstructionFlag: false, senderKey: 'a@x', ...extra },
      card: {
        subject: '件名',
        from: 'A',
        receivedAt: '2026-10-22',
        link: 'https://mail.example/t',
        summary: '要約',
        proposal: { docType: '記事', destination: [paste] },
        attachmentsNeeded: [],
        attachments: [],
      },
    } as Input)

  it('前の知らせより後に出た候補を数える。可能性「低」と見送ったものは数えない。0 件なら書かない', () => {
    noticeCandidates(ledger)
    expect(notices()).toEqual([])
    candidate('gmail:a')
    candidate('gmail:b')
    candidate('meet:c', { source: 'meet', origin: '推測', confidence: '低' })
    candidate('gmail:d')
    transition(ledger, { type: 'candidate.dismiss', candidateId: 'gmail:d', reason: 'もう済んだ' })
    noticeCandidates(ledger)
    expect(notices()).toEqual([
      expect.objectContaining({
        kind: 'candidates',
        text: '依頼の候補が 2 件届きました。進めるか見送るかを選べます',
        path: '/',
        outside: true,
      }),
    ])
    noticeCandidates(ledger) // 新しい候補が無い回
    expect(notices()).toHaveLength(1)
    candidate('gmail:e')
    noticeCandidates(ledger)
    expect(lastNotice()?.text).toBe('依頼の候補が 1 件届きました。進めるか見送るかを選べます')
  })

  it('T4 自動で開始', () => {
    candidate('gmail:a')
    transition(ledger, {
      type: 'candidate.auto_enter',
      candidateId: 'gmail:a',
      caseId: 'c9',
      entranceDefault: 'おまかせ',
    })
    expect(lastNotice()).toMatchObject({
      kind: 'auto_started',
      caseId: 'c9',
      text: '『件名』を自動で開始しました。止めたいときは取り消せます',
      outside: true,
    })
  })
})

describe('送り出し（6.8 (2)(5)）', () => {
  const MIN = 60_000
  let hub: ReturnType<typeof createHub>
  let seen: SseMessage[]
  let calls: [string, number[]][]
  let answer: Awaited<ReturnType<Sender>>
  const push: Sender = async (target, ns) => {
    calls.push([target, ns.map((x) => x.id)])
    return answer
  }
  const status = () => ledger.dueDeliveries(new Date(clock.getTime() + 365 * 24 * 60 * MIN))
  beforeEach(() => {
    hub = createHub()
    seen = []
    hub.subscribe((m) => seen.push(m))
    calls = []
    answer = 'sent'
    ledger.noticeRoute = { on: () => true, targets: () => ['push:s1'] }
    request()
  })
  const stop = () =>
    run({ type: 'cost.cap', by: '費用', caseId: 'c1', eventId: `c1:cost.cap:${id()}`, scope: '案件', callId: 'k' })

  it('コミットの後に SSE の notice を出す。つなぎ直しでは送り直さない', async () => {
    const out = createNotices({ ledger, hub, senders: { push }, now: () => clock })
    stop()
    await out.flush()
    await out.flush()
    expect(seen.filter((m) => m.event === 'notice').map((m) => JSON.parse(m.data).kind)).toEqual(['stopped'])
    // 送り直す分に notice は入らない（取り直しの合図になるだけ）
    expect((hub.since(seen[0]?.id.replace(/\d+$/, '0')) ?? []).filter((m) => m.event === 'notice')).toEqual([])
    expect(calls).toEqual([['push:s1', [1]]])
    expect(status()).toEqual([])
  })

  it('届かなければ 1・5・30 分後に送り直し、4 回目で落とす', async () => {
    answer = 'retry'
    const out = createNotices({ ledger, hub, senders: { push }, now: () => clock })
    stop()
    for (const wait of [0, MIN, 5 * MIN, 30 * MIN]) {
      clock = new Date(clock.getTime() + wait - 1)
      await out.flush()
      clock = new Date(clock.getTime() + 1)
      await out.flush()
    }
    expect(calls).toHaveLength(4)
    expect(status()).toEqual([])
  })

  it('登録が無い（gone）・送り手が無い送り先は落とす', async () => {
    answer = 'gone'
    ledger.noticeRoute = { on: () => true, targets: () => ['push:s1', 'slack'] }
    const out = createNotices({ ledger, hub, senders: { push }, now: () => clock })
    stop()
    await out.flush()
    expect(calls).toEqual([['push:s1', [1]]])
    expect(status()).toEqual([])
  })

  it('24 時間たった送り残しと、本人がもう答えた確認待ちは送らない', async () => {
    drafted() // 確認待ち（seq 1）
    person('cancel', {}) // 本人が答えた（取り消し）
    const out = createNotices({ ledger, hub, senders: { push }, now: () => clock })
    expect(seen).toEqual([])
    await out.flush()
    expect(calls).toEqual([])
    expect(status()).toEqual([])

    stop2()
    clock = new Date(clock.getTime() + 24 * 60 * MIN + 1)
    await out.flush()
    expect(calls).toEqual([])
    expect(status()).toEqual([])
  })
  const stop2 = () => {
    // 取り消した案件とは別の案件の中止
    run({
      type: 'conversation.request',
      eventId: id(),
      caseId: 'c2',
      title: '月報',
      mode: 'おまかせ',
      docType: '記事',
      destination: [paste],
    })
    run({ type: 'cost.cap', by: '費用', caseId: 'c2', eventId: 'c2:cost.cap:k', scope: '案件', callId: 'k' })
  }

  it('SSE の確認待ちは、案件が動いた後なら画面の外へ出さない印で出す', async () => {
    const out = createNotices({ ledger, hub, now: () => clock })
    drafted()
    person('cancel', {})
    await out.flush()
    const ns = seen.filter((m) => m.event === 'notice').map((m) => JSON.parse(m.data) as Notice)
    expect(ns.map((x) => [x.kind, x.outside])).toEqual([['your_turn', false]])
  })

  it('起動のときに落ちたホストの送り残しを拾い直す', async () => {
    stop()
    const out = createNotices({ ledger, hub, senders: { push }, now: () => clock })
    await out.flush()
    expect(seen).toEqual([]) // 起動より前のお知らせは SSE で出し直さない
    expect(calls).toEqual([['push:s1', [1]]])
  })

  describe('通知を止める時間帯（6.8 (12)）', () => {
    // 時計は 12:00（JST）。11:00〜13:00 を止める。時間帯は引数で渡す（CI の UTC に依らない）
    const quiet = { from: '11:00', to: '13:00' }
    const opened = () => {
      clock = new Date('2026-10-23T04:00:00Z') // 13:00（JST）。明けた
    }
    const make = () =>
      createNotices({ ledger, hub, senders: { push }, now: () => clock, quiet: () => quiet, timeZone: 'Asia/Tokyo' })
    const sse = () => seen.filter((m) => m.event === 'notice').map((m) => JSON.parse(m.data) as Notice)
    const candidate = (candidateId: string) =>
      transition(ledger, {
        type: 'candidate.presented',
        candidate: { candidateId, source: 'gmail', origin: '合図', aiInstructionFlag: false, senderKey: 'a@x' },
        card: {
          subject: '件名',
          from: 'A',
          receivedAt: '2026-10-22',
          link: 'https://mail.example/t',
          summary: '要約',
          proposal: { docType: '記事', destination: [paste] },
          attachmentsNeeded: [],
          attachments: [],
        },
      } as Input)

    it('時刻は [from, to) を渡した時間帯で比べる。from > to は日をまたぐ', () => {
      const night = { from: '22:00', to: '07:00' }
      const at = (iso: string) => new Date(iso)
      expect(quietAt(at('2026-10-23T13:30:00Z'), night, 'Asia/Tokyo')).toBe(true) // 22:30
      expect(quietAt(at('2026-10-23T13:30:00Z'), night, 'UTC')).toBe(false) // 13:30
      expect(quietAt(at('2026-10-23T21:59:00Z'), night, 'Asia/Tokyo')).toBe(true) // 06:59
      expect(quietAt(at('2026-10-23T22:00:00Z'), night, 'Asia/Tokyo')).toBe(false) // 07:00
      expect(quietAt(at('2026-10-23T03:00:00Z'), quiet, 'Asia/Tokyo')).toBe(true)
      expect(quietAt(at('2026-10-23T04:00:00Z'), quiet, 'Asia/Tokyo')).toBe(false)
      expect(quietAt(at('2026-10-23T03:00:00Z'), null, 'Asia/Tokyo')).toBe(false)
    })

    it('その間は出さず（お知らせ欄には残る）、明けに 1 通。止めていた分は送らない', async () => {
      const out = make()
      stop()
      await out.flush()
      expect(sse().map((x) => [x.kind, x.outside])).toEqual([['stopped', false]])
      expect(calls).toEqual([])
      clock = new Date(clock.getTime() + 30 * MIN) // 送り直しの時が来ても、時間帯の中は送らない
      await out.flush()
      expect(calls).toEqual([])

      opened()
      await out.flush()
      await out.flush() // 同じ分を二度まとめない
      expect(sse().map((x) => [x.kind, x.outside, x.text, x.path])).toEqual([
        ['stopped', false, expect.any(String), '/cases/c1'],
        ['quiet', true, '通知を止めていたあいだに、中止 1 件がありました', '/'],
      ])
      expect(calls).toEqual([['push:s1', [2]]])
      expect(status()).toEqual([])
      expect(notices().map((x) => x.kind)).toEqual(['stopped', 'quiet'])
    })

    it('案件ごとに最後の 1 行で数え、確認待ちはまだ確認待ちのもの、候補はまだ出したままのものだけ', async () => {
      const out = make()
      drafted() // c1 確認待ち → 本人が答える
      run({
        type: 'conversation.request',
        eventId: id(),
        caseId: 'c2',
        title: '月報',
        mode: '確認しながら',
        docType: '記事',
        destination: [paste],
      })
      run({
        type: 'entrance.drafted',
        caseId: 'c2',
        by: 'libretto',
        eventId: id(),
        expectedRevision: ledger.getCase('c2')?.revision,
        setFingerprint: 's',
      })
      run({ type: 'cost.cap', by: '費用', caseId: 'c2', eventId: 'c2:cost.cap:k', scope: '案件', callId: 'k' }) // c2 は確認待ち → 中止
      candidate('gmail:a')
      noticeCandidates(ledger)
      await out.flush()
      // 候補の知らせを切っていたあいだの分は数えない
      ledger.noticeRoute = { on: (k) => k !== 'candidates', targets: () => ['push:s1'] }
      candidate('gmail:b')
      noticeCandidates(ledger)
      ledger.noticeRoute = { on: () => true, targets: () => ['push:s1'] }
      candidate('gmail:c')
      candidate('gmail:d')
      transition(ledger, { type: 'candidate.dismiss', candidateId: 'gmail:d', reason: 'もう済んだ' })
      noticeCandidates(ledger)
      await out.flush()
      approve()
      await out.flush()

      opened()
      await out.flush()
      expect(lastNotice()).toMatchObject({
        kind: 'quiet',
        text: '通知を止めていたあいだに、中止 1 件・依頼の候補 2 件がありました',
      })
    })

    it('止めていたあいだの知らせが、明けた時点でもう済んでいれば書かない', async () => {
      const out = make()
      drafted()
      await out.flush()
      approve()
      opened()
      await out.flush()
      expect(notices().map((x) => x.kind)).toEqual(['your_turn'])
      expect(calls).toEqual([])
    })

    it('送っているうちに時間帯に入ったら、残りの送り先は明けまで残す', async () => {
      clock = new Date('2026-10-23T01:59:00Z') // 10:59（JST）
      ledger.noticeRoute = { on: () => true, targets: () => ['push:s1', 'slack'] }
      const slack: Sender = async (target, ns) => {
        calls.push([target, ns.map((x) => x.id)])
        return 'sent'
      }
      const out = createNotices({
        ledger,
        hub,
        senders: {
          push: async (t, ns) => {
            clock = new Date('2026-10-23T02:00:00Z') // 送っているうちに 11:00
            return push(t, ns)
          },
          slack,
        },
        now: () => clock,
        quiet: () => quiet,
        timeZone: 'Asia/Tokyo',
      })
      stop()
      await out.flush()
      expect(calls).toEqual([['push:s1', [1]]])
      opened()
      await out.flush()
      expect(calls).toEqual([
        ['push:s1', [1]],
        ['slack', [1]],
      ])
    })
  })
})

describe('設定の入り切り（6.8 (6)）', () => {
  it('PUT /api/settings/notices で下書きに取りかかったを入れると、画面の外へも出す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'libretto-notices-'))
    const staticDir = join(home, 'dist')
    mkdirSync(staticDir)
    writeFileSync(join(staticDir, 'index.html'), '')
    ledger = initHome(home, () => clock)
    const server = createServer({
      home,
      ledger,
      origins: ['http://127.0.0.1:7780'],
      staticDir,
      invoke: () => Promise.reject(new Error('no model')),
      log: () => {},
    })
    const { url } = server.issuePairing('t')
    const cookie = ((await server.app.request(new URL(url).pathname)).headers.get('set-cookie') ?? '').split(
      ';',
    )[0] as string
    const headers = { cookie, origin: 'http://127.0.0.1:7780', 'content-type': 'application/json' }
    const prefs = await (await server.app.request('/api/settings/notices', { headers })).json()
    expect(prefs).toEqual({
      your_turn: true,
      stopped: true,
      done: true,
      auto_started: true,
      candidates: true,
      started: false,
    })
    expect(
      (await server.app.request('/api/settings/notices', { method: 'PUT', headers, body: '{"started":true}' })).status,
    ).toBe(400)
    const put = await server.app.request('/api/settings/notices', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...prefs, started: true }),
    })
    expect(put.status).toBe(200)
    request()
    drafted()
    approve()
    host('materials.ready')
    expect(lastNotice()).toMatchObject({ kind: 'started', outside: true })

    // 通知を止める時間帯（6.8 (12)）。既定は止めない。始まりと終わりが同じは入れられない
    expect(await (await server.app.request('/api/settings/quiet-hours', { headers })).json()).toEqual({
      quietHours: null,
    })
    for (const quietHours of [{ from: '22:00', to: '22:00' }, { from: '24:00', to: '07:00' }, { from: '22:00' }])
      expect(
        (
          await server.app.request('/api/settings/quiet-hours', {
            method: 'PUT',
            headers,
            body: JSON.stringify({ quietHours }),
          })
        ).status,
      ).toBe(400)
    const quietHours = { from: '22:00', to: '07:00' }
    const q = await server.app.request('/api/settings/quiet-hours', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ quietHours }),
    })
    expect(await q.json()).toEqual({ quietHours })
    expect(await (await server.app.request('/api/settings/quiet-hours', { headers })).json()).toEqual({ quietHours })
    expect(await (await server.app.request('/api/settings/notices', { headers })).json()).toMatchObject({
      started: true,
    })
    ledger.close()
  })
})
