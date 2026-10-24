import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { initHome, MIGRATIONS, monthCapFromEnv, openDb, resolveHome } from '../src/ledger/db.ts'
import { derivedEventId, type Hold, jst, Ledger, type NewCase } from '../src/ledger/ledger.ts'

const newCase = (caseId: string, eventId = `${caseId}:created`): NewCase => ({
  eventId,
  caseId,
  title: '記事',
  state: '入口待ち',
  turn: 'libretto',
  step: '依頼書と確認項目を書いています',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  docType: '記事',
  destination: [{ kind: 'paste' }],
})
const hold = (callId: string, caseId: string, holdYen: number): Hold => ({
  callId,
  caseId,
  role: '作り手',
  family: 'claude',
  model: 'm',
  holdYen,
})
const noCaps = { caseCapYen: null, monthCapYen: null }

let now: Date
let db: ReturnType<typeof openDb>
let ledger: Ledger
beforeEach(() => {
  now = new Date('2026-10-23T03:00:00Z')
  db = openDb(':memory:')
  ledger = new Ledger(db, () => now)
})

describe('時刻（9.1）', () => {
  it('JST の 1 つの形で書く', () => {
    expect(jst(new Date('2026-10-31T15:00:00Z'))).toBe('2026-11-01T00:00:00.000+09:00')
  })
  it('形の違う時刻は表が拒む', () => {
    expect(() =>
      db.prepare(`INSERT INTO notices (kind, text, at) VALUES ('k', 't', '2026-10-23T03:00:00.000Z')`).run(),
    ).toThrow(/CHECK/)
  })
})

describe('cases / case_events', () => {
  it('作ると created 行に作ったときの状態が残り、revision は 0', () => {
    const c = ledger.insertCase({ ...newCase('c1'), deadline: '金曜' })
    expect(c).toMatchObject({ state: '入口待ち', revision: 0, version: 0, series: 1, deadline: '金曜' })
    expect(ledger.getCase('c1')).toEqual(c)
    expect(ledger.listCaseEvents('c1')).toEqual([
      expect.objectContaining({
        type: 'created',
        eventId: 'c1:created',
        to: '入口待ち',
        turn: 'libretto',
        deadline: '金曜',
      }),
    ])
    expect(ledger.getCase('c1')).not.toHaveProperty('candidateId')
  })

  it('遷移は案件の行と transition 行を 1 回で書き、revision を進める', () => {
    ledger.insertCase(newCase('c1'))
    now = new Date('2026-10-23T04:00:00Z')
    const c = ledger.appendTransition({
      eventId: 'e1',
      caseId: 'c1',
      from: '入口待ち',
      to: '承認待ち',
      event: 'outline.done',
      by: 'libretto',
      turn: '本人',
      step: '構成案',
      approvalKind: '構成案',
      mode: 'おまかせ',
      version: 1,
    })
    expect(c).toMatchObject({ state: '承認待ち', approvalKind: '構成案', mode: 'おまかせ', version: 1, revision: 1 })
    expect(c.updatedAt).toBe('2026-10-23T13:00:00.000+09:00')
    expect(ledger.findEvent('e1')).toMatchObject({
      type: 'transition',
      from: '入口待ち',
      to: '承認待ち',
      approvalKind: '構成案',
      mode: 'おまかせ',
    })

    const back = ledger.appendTransition({
      eventId: 'e2',
      caseId: 'c1',
      from: '承認待ち',
      to: '停止',
      event: 'stop.case',
      by: '本人',
      turn: '本人',
      step: '',
      reason: '止めた',
    })
    expect(back).toMatchObject({ revision: 2, stopReason: '止めた' })
    expect(back).not.toHaveProperty('approvalKind')
  })

  it('今の状態と from が違えば何も残さない', () => {
    ledger.insertCase(newCase('c1'))
    const t = {
      eventId: 'e1',
      caseId: 'c1',
      from: '下書き中',
      to: '検品中',
      event: 'draft.done',
      by: 'libretto',
      turn: 'libretto',
      step: '',
    } as const
    expect(() => ledger.appendTransition(t)).toThrow(/not in state/)
    expect(ledger.findEvent('e1')).toBeUndefined()
    expect(ledger.getCase('c1')?.revision).toBe(0)
  })

  it('承認待ちには approvalKind が要り、ほかの状態には付けられない', () => {
    ledger.insertCase(newCase('c1'))
    const t = {
      eventId: 'e1',
      caseId: 'c1',
      from: '入口待ち',
      event: 'x',
      by: 'libretto',
      turn: '本人',
      step: '',
    } as const
    expect(() => ledger.appendTransition({ ...t, to: '承認待ち' })).toThrow(/approvalKind/)
    expect(() => ledger.appendTransition({ ...t, to: '材料待ち', approvalKind: '完成稿' })).toThrow(/approvalKind/)
  })

  it('拒否の state は detail に入り、revision は進まない', () => {
    ledger.insertCase(newCase('c1'))
    ledger.appendRejected({ eventId: 'e1', caseId: 'c1', event: 'approval.ok', reason: 'stale' })
    expect(ledger.findEvent('e1')).toMatchObject({ type: 'rejected', state: '入口待ち', reason: 'stale' })
    expect(db.prepare('SELECT from_state, detail FROM case_events WHERE event_id = ?').get('e1')).toEqual({
      from_state: null,
      detail: '{"state":"入口待ち"}',
    })
    expect(ledger.getCase('c1')?.revision).toBe(0)
  })

  it('モードと題の変更は列と出来事を一緒に書く', () => {
    ledger.insertCase(newCase('c1'))
    ledger.changeMode('m1', 'c1', 'おまかせ')
    ledger.changeTitle('t1', 'c1', '新しい題')
    ledger.recordPurged('p1', 'c1', ['facts-excerpts/'])
    expect(ledger.getCase('c1')).toMatchObject({ mode: 'おまかせ', title: '新しい題' })
    expect(ledger.listCaseEvents('c1').map((e) => e.type)).toEqual([
      'created',
      'mode_changed',
      'title_changed',
      'purged',
    ])
  })

  it('一覧は状態で絞れる', () => {
    ledger.insertCase(newCase('c1'))
    ledger.insertCase({ ...newCase('c2'), state: '候補', turn: '本人' })
    expect(ledger.listCases(['候補']).map((c) => c.caseId)).toEqual(['c2'])
    expect(ledger.listCases()).toHaveLength(2)
  })

  it('同じ event_id の二度目は表が拒む', () => {
    ledger.insertCase(newCase('c1'))
    expect(() => ledger.insertCase(newCase('c2', 'c1:created'))).toThrow(/UNIQUE/)
    expect(ledger.getCase('c2')).toBeUndefined()
  })

  it('読み出し形に通らない行は例外にする', () => {
    ledger.insertCase(newCase('c1'))
    db.prepare(`UPDATE cases SET origin = '{"kind":"手紙"}' WHERE case_id = 'c1'`).run()
    expect(() => ledger.getCase('c1')).toThrow()
  })
})

describe('トランザクション（9.4 (3)）', () => {
  it('中で例外が出れば全部巻き戻る', () => {
    expect(() =>
      ledger.transaction(() => {
        ledger.insertCase(newCase('c1'))
        ledger.reserveCost({ ...hold('k1', 'c1', 10), ...noCaps })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(ledger.getCase('c1')).toBeUndefined()
    expect(ledger.listCosts('c1')).toEqual([])
  })

  it('非同期の関数は拒まれ、await の前の書き込みも残らない', () => {
    expect(() =>
      ledger.transaction(async () => {
        ledger.insertCase(newCase('c1'))
      }),
    ).toThrow(/promise/)
    expect(ledger.getCase('c1')).toBeUndefined()
  })

  it('T31: 元の案件の遷移に操作の id、新しい案件の created に派生の id。二度目は何も増やさない', () => {
    ledger.insertCase({ ...newCase('c1'), state: '停止', turn: '本人' })
    const restart = (newId: string) =>
      ledger.transaction(() => {
        ledger.appendTransition({
          eventId: 'op',
          caseId: 'c1',
          from: '停止',
          to: '停止',
          event: 'restart_as_new',
          by: '本人',
          turn: '本人',
          step: '',
        })
        ledger.insertCase(newCase(newId, derivedEventId('op', 'created')))
      })
    restart('c2')
    expect(() => restart('c3')).toThrow(/UNIQUE/)
    expect(ledger.getCase('c3')).toBeUndefined()
    expect(ledger.getCase('c1')?.revision).toBe(1)
    expect(ledger.findEvent('op')).toMatchObject({ caseId: 'c1', type: 'transition' })
    expect(ledger.findEvent('op#created')).toMatchObject({ caseId: 'c2', type: 'created' })
  })

  it('追記専用の表は書き換えも消しもできない', () => {
    ledger.insertCase(newCase('c1'))
    ledger.reserveCost({ ...hold('k1', 'c1', 10), ...noCaps })
    expect(() => db.prepare(`UPDATE case_events SET step = 'x'`).run()).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM case_events').run()).toThrow(/append-only/)
    expect(() => db.prepare('UPDATE costs SET hold_yen = 0').run()).toThrow(/append-only/)
  })

  it('approvals は superseded_by を 1 回埋めるだけ通す', () => {
    ledger.insertCase(newCase('c1'))
    db.prepare(`INSERT INTO approvals (event_id, case_id, gate, by, at) VALUES ('a1', 'c1', '入口', '本人', ?)`).run(
      jst(now),
    )
    expect(() => db.prepare(`UPDATE approvals SET gate = '送付'`).run()).toThrow(/append-only/)
    db.prepare(`UPDATE approvals SET superseded_by = 'e9'`).run()
    expect(() => db.prepare(`UPDATE approvals SET superseded_by = 'e10'`).run()).toThrow(/once/)
  })
})

describe('費用の行（9.4 (1)）', () => {
  beforeEach(() => {
    ledger.insertCase(newCase('c1'))
  })
  it('hold と charge は 1 呼び出し 1 行ずつ', () => {
    ledger.reserveCost({ ...hold('k1', 'c1', 100), ...noCaps })
    expect(() => ledger.reserveCost({ ...hold('k1', 'c1', 100), ...noCaps })).toThrow(/UNIQUE/)
    ledger.recordCharge({ callId: 'k1', yen: 30, tokensIn: 5 })
    expect(() => ledger.recordCharge({ callId: 'k1', yen: 30 })).toThrow(/UNIQUE/)
    expect(ledger.listCosts('c1')).toEqual([
      expect.objectContaining({ type: 'hold', callId: 'k1', holdYen: 100, role: '作り手' }),
      expect.objectContaining({ type: 'charge', callId: 'k1', yen: 30, tokensIn: 5 }),
    ])
  })
  it('hold の無い charge は書けない', () => {
    expect(() => ledger.recordCharge({ callId: 'nope', yen: 1 })).toThrow(/no hold/)
    expect(() =>
      db
        .prepare(`INSERT INTO costs (type, call_id, case_id, yen, at) VALUES ('charge', 'nope', 'c1', 1, ?)`)
        .run(jst(now)),
    ).toThrow(/charge without hold/)
  })
  it('欠けた行・負の額・有限でない額を拒む', () => {
    const insert = `INSERT INTO costs (type, call_id, case_id, role, family, model, hold_yen, at) VALUES ('hold', 'k', 'c1', 'r', 'f', 'm', ?, ?)`
    expect(() => db.prepare(insert).run(null, jst(now))).toThrow(/CHECK/)
    expect(() => db.prepare(insert).run(-1, jst(now))).toThrow(/CHECK/)
    expect(() => ledger.reserveCost({ ...hold('k2', 'c1', Number.NaN), ...noCaps })).toThrow()
    expect(() => ledger.reserveCost({ ...hold('k2', 'c1', Number.POSITIVE_INFINITY), ...noCaps })).toThrow()
    expect(() => ledger.reserveCost({ ...hold('k3', 'c1', 1), ...noCaps })).not.toThrow()
    expect(() => ledger.recordCharge({ callId: 'k3', yen: -1 })).toThrow()
    expect(() => ledger.recordCharge({ callId: 'k3', yen: 1, tokensIn: 0.5 })).toThrow()
    expect(ledger.listCosts('c1')).toHaveLength(1)
  })
  it('案件でも推測・点検でもない case_id は拒む', () => {
    expect(() => ledger.reserveCost({ ...hold('k1', 'c9', 1), ...noCaps })).toThrow(/no case/)
    expect(ledger.reserveCost({ ...hold('k2', '推測', 1), ...noCaps })).toEqual({ ok: true })
    expect(ledger.reserveCost({ ...hold('k3', '点検', 1), ...noCaps })).toEqual({ ok: true })
  })
  it('分類は 1 候補 1 行で、JST の 1 日で数える', () => {
    now = new Date('2026-10-23T14:59:59.999Z') // JST 23:59:59.999
    ledger.recordClassified('gmail:a')
    expect(() => ledger.recordClassified('gmail:a')).toThrow(/UNIQUE/)
    now = new Date('2026-10-23T15:00:00Z') // JST 翌日 0 時
    ledger.recordClassified('gmail:b')
    expect(ledger.classifiedCount()).toBe(1)
    expect(ledger.classifiedCount(new Date('2026-10-23T03:00:00Z'))).toBe(1)
  })
})

describe('上限と月の数え方（4.4・9.4 (2)）', () => {
  beforeEach(() => {
    ledger.insertCase(newCase('c1'))
    ledger.insertCase(newCase('c2'))
  })
  it('案件の累計 = charge ＋ 未精算の hold。超えるなら hold を書かない', () => {
    ledger.reserveCost({ ...hold('k1', 'c1', 1000), ...noCaps })
    ledger.recordCharge({ callId: 'k1', yen: 400 })
    ledger.reserveCost({ ...hold('k2', 'c1', 500), ...noCaps })
    expect(ledger.caseCostYen('c1')).toBe(900)
    expect(ledger.reserveCost({ ...hold('k3', 'c1', 601), caseCapYen: 1500, monthCapYen: null })).toEqual({
      ok: false,
      scope: '案件',
    })
    expect(ledger.reserveCost({ ...hold('k3', 'c1', 600), caseCapYen: 1500, monthCapYen: null })).toEqual({ ok: true })
    expect(ledger.listCosts('c1')).toHaveLength(4)
  })
  it('全体上限は全案件と推測を合わせて比べ、null なら比べない', () => {
    ledger.reserveCost({ ...hold('k1', 'c1', 300), ...noCaps })
    ledger.reserveCost({ ...hold('k2', '推測', 200), ...noCaps })
    expect(ledger.reserveCost({ ...hold('k3', 'c2', 501), caseCapYen: 1500, monthCapYen: 1000 })).toEqual({
      ok: false,
      scope: '全体',
    })
    expect(ledger.reserveCost({ ...hold('k3', 'c2', 501), caseCapYen: 1500, monthCapYen: null })).toEqual({ ok: true })
  })
  it('前月の hold に今月 charge が付いても前月に数える', () => {
    now = new Date('2026-10-31T14:59:59.999Z') // JST 10/31 23:59:59.999
    ledger.reserveCost({ ...hold('k1', 'c1', 1000), ...noCaps })
    now = new Date('2026-10-31T15:00:00Z') // JST 11/1 0 時
    expect(ledger.monthCostYen()).toBe(0)
    ledger.recordCharge({ callId: 'k1', yen: 300 })
    expect(ledger.monthCostYen()).toBe(0)
    expect(ledger.monthCostYen(new Date('2026-10-15T00:00:00Z'))).toBe(300)
    ledger.reserveCost({ ...hold('k2', 'c1', 50), ...noCaps })
    expect(ledger.monthCostYen()).toBe(50)
    expect(ledger.caseCostYen('c1')).toBe(350)
  })
  it('比べる月と hold の月は同じ時刻で決まる（月末をまたぐ予約）', () => {
    ledger.reserveCost({ ...hold('k0', 'c1', 900), ...noCaps }) // 10 月分
    const times = [new Date('2026-10-31T14:59:59.999Z'), new Date('2026-10-31T15:00:00Z')]
    const l = new Ledger(db, () => times.shift() ?? new Date('2026-12-01T00:00:00Z'))
    expect(l.reserveCost({ ...hold('k1', 'c2', 50), caseCapYen: null, monthCapYen: 1000 })).toEqual({ ok: true })
    expect(ledger.monthCostYen(new Date('2026-10-15T00:00:00Z'))).toBe(950)
  })
  it('前月から未精算の hold は前月に全額で残り、今月には入らない。案件の累計には入る', () => {
    now = new Date('2026-09-30T10:00:00Z')
    ledger.reserveCost({ ...hold('k1', 'c1', 700), ...noCaps })
    now = new Date('2026-10-01T10:00:00Z')
    expect(ledger.monthCostYen()).toBe(0)
    expect(ledger.monthCostYen(new Date('2026-09-10T00:00:00Z'))).toBe(700)
    expect(ledger.reserveCost({ ...hold('k2', 'c1', 900), caseCapYen: 1500, monthCapYen: 1000 })).toEqual({
      ok: false,
      scope: '案件',
    })
    expect(ledger.reserveCost({ ...hold('k2', 'c1', 800), caseCapYen: 1500, monthCapYen: 1000 })).toEqual({ ok: true })
  })
})

describe('実ファイルのデータベースと LIBRETTO_HOME（9.4 (5)(6)）', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'libretto-'))

  it('今の OS と CPU のビルド済みのバイナリを読む（ソースからビルドしない。9.1）', () => {
    openDb(':memory:').close()
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((f) => f.endsWith('.node'))
    expect(loaded).toEqual([expect.stringMatching(/better-sqlite3[\\/]prebuilds[\\/]/)])
  })

  it('WAL になり、閉じて開き直しても残り、マイグレーションを流し直しても変わらない', () => {
    const file = join(tmp(), 'libretto.db')
    const a = openDb(file)
    expect(a.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(a.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(a.pragma('secure_delete', { simple: true })).toBe(1)
    new Ledger(a).insertCase(newCase('c1'))
    a.close()
    const b = openDb(file)
    expect(b.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(new Ledger(b).getCase('c1')?.title).toBe('記事')
    b.close()
  })

  it('ホームの初期化をもう一度してもデータは残る', () => {
    const home = join(tmp(), 'home')
    const first = initHome(home)
    first.insertCase(newCase('c1'))
    first.close()
    const second = initHome(home)
    expect(second.getCase('c1')).toBeDefined()
    second.close()
  })

  it('失敗したマイグレーションは表も版番号も残さず、開けない', () => {
    const file = join(tmp(), 'libretto.db')
    openDb(file).close()
    const broken = [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER); CREATE TABLE cases (x INTEGER);']
    expect(() => openDb(file, broken)).toThrow(/already exists/)
    const db = openDb(file)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'extra'`).get()).toBeUndefined()
    db.close()
  })

  it('未来の版のデータベースは開かない', () => {
    const file = join(tmp(), 'libretto.db')
    const db = openDb(file)
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`)
    db.close()
    expect(() => openDb(file)).toThrow(/newer/)
  })

  it('LIBRETTO_HOME: 未設定・空は ~/libretto、相対は拒む', () => {
    expect(resolveHome({})).toMatch(/libretto$/)
    expect(resolveHome({ LIBRETTO_HOME: '' })).toBe(resolveHome({}))
    const abs = tmp()
    expect(resolveHome({ LIBRETTO_HOME: abs })).toBe(abs)
    expect(() => resolveHome({ LIBRETTO_HOME: 'rel/dir' })).toThrow(/absolute/)
  })

  it('LIBRETTO_MONTH_CAP_YEN: 未設定・空は null、正の整数だけ読み、ほかは起動しない（11.3 (2)）', () => {
    expect(monthCapFromEnv({})).toBeNull()
    expect(monthCapFromEnv({ LIBRETTO_MONTH_CAP_YEN: '' })).toBeNull()
    expect(monthCapFromEnv({ LIBRETTO_MONTH_CAP_YEN: '3000' })).toBe(3000)
    for (const v of ['abc', '0', '-1', '1.5', '03', ' 3000'])
      expect(() => monthCapFromEnv({ LIBRETTO_MONTH_CAP_YEN: v })).toThrow()
  })
})
