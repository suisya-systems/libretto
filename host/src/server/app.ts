// hono のルート（docs/implementation.md 5.2・5.4・5.7）。経路の順は 5.7 (6): 公開 → /api/* → /cases/:id/page → 静的 → 画面の殻
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  ActionResult,
  ApiKeyInput,
  ApiKeyKind,
  CaseAction,
  type CaseCard,
  CaseState,
  type ConnectionsView,
  ConversationPost,
  DraftDiff,
  type HostStatus,
  type IsolationCause,
  MaterialsPost,
  type Mode,
} from '@libretto/shared/api'
import { type Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { createRunner } from '../case/runner.ts'
import { transition } from '../case/transition.ts'
import { type IsolationRecord, readIsolation, writeIsolation } from '../checks/isolation.ts'
import { diff, renderHtml } from '../checks/text.ts'
import { pageVersions } from '../deliver/run.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { deleteKey, keyStatus, setKey } from '../model/keys.ts'
import type { Isolation } from '../model/sandbox.ts'
import { createConversation } from '../roles/conversation.ts'
import { createEntrance, currentSet, entranceView, writeApproval, writeAtomic } from '../roles/entrance.ts'
import { OUTPUT_FILES, reviewsOf } from '../roles/judge.ts'
import { draftNames, pastedCount, pastedName, versionDir, versionsOf, workDir } from '../roles/maker.ts'
import { createRuns, Stopped } from '../runs.ts'
import { createHub, type SseMessage } from './sse.ts'
import { createStop, isStorageError } from './stop.ts'
import { caseView, DEFAULTS, homeView, toCard } from './views.ts'

export const COOKIE = 'libretto_session'
// Cookie の Max-Age とサーバーの寿命は同じ定数から（5.7 (1)）
export const SESSION_DAYS = 400
const SESSION_MS = SESSION_DAYS * 86_400_000
const PAIRING_MS = 10 * 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const DeviceInput = z.object({ label: z.string().trim().min(1).max(60) })

export type ServerOptions = {
  home: string
  ledger: Ledger
  origins: readonly string[] // Origin の許す起点（完全一致。5.4）。先頭がペアリング URL の起点
  staticDir: string // page/dist
  invoke: (job: Job) => Promise<Outcome> // モデル呼び出しのアダプタ（6.1）
  mode?: () => Mode // 会話の初期設定（設定の Issue までは既定。6.2.1 (6)）
  now?: () => Date
  log?: (line: string) => void
  runsWaitMs?: number
  token?: () => string // canary の語（テストで固定する）
  isolation?: Isolation // 起動時の自己点検の結果（8.9 (5)）
  cause?: IsolationCause // weak / broken の原因（8.10 (5)）
  probe?: (signal: AbortSignal) => Promise<IsolationRecord | undefined> // 隔離の点検（8.10 (4)）
}

export function createServer(o: ServerOptions) {
  const now = o.now ?? (() => new Date())
  const log = o.log ?? ((line: string) => console.error(line))
  const { home, ledger } = o
  const status: HostStatus = { stopped: false, storageOk: true, signIn: false, isolation: o.isolation ?? 'strong' }
  const hub = createHub()
  const changed = () => hub.emit('host.changed', { ...status })
  const storage = (written: boolean) => {
    const ok = written && !stop.unsaved()
    if (status.storageOk === ok) return
    status.storageOk = ok
    changed()
  }
  const caseChanged = (caseId: string) => {
    const c = ledger.getCase(caseId)
    if (c) hub.emit('case.changed', { caseId, state: c.state, turn: c.turn })
  }
  // runs は stop を、stop は runs を見る
  const runs = createRuns(() => stop.isStopped(), o.runsWaitMs)
  const stop = createStop({
    home,
    ledger,
    runs,
    status,
    changed,
    storage,
    stoppedCases: (ids) => {
      for (const id of ids) caseChanged(id)
    },
    log,
  })

  const entrance = createEntrance({
    home,
    ledger,
    invoke: o.invoke,
    runs,
    caseChanged,
    storage,
    log,
    ...(o.token && { token: o.token }),
    blocked: (caseId) => runner.blocked(caseId),
    onAuthExpired: (caseId) => runner.onAuthExpired(caseId),
  })
  // 状態ごとの仕事を起こす（6.2.3 (1)）。入口待ちは entrance に任せる
  const runner = createRunner({
    home,
    ledger,
    invoke: o.invoke,
    runs,
    entrance,
    caseChanged,
    storage,
    signInChanged: (waiting) => {
      status.signIn = waiting
      changed()
    },
    log,
    ...(o.now && { now: o.now }),
  })

  const conversation = createConversation({
    home,
    ledger,
    invoke: o.invoke,
    runs,
    isStopped: () => stop.isStopped(),
    mode: o.mode ?? (() => DEFAULTS.会話),
    messageChanged: (m) => hub.emit('conversation.message', m),
    caseChanged,
    requested: (caseId) => runner.kick(caseId),
    revised: (caseId) => runner.kick(caseId),
    // 依頼書と仮定だけ。チェック項目は渡さない（6.2.2 (8)）
    briefOf: (caseId) => {
      const b = currentSet(home, ledger, caseId)?.brief
      return b && { ...b, decisions: undefined, approvedFingerprint: undefined }
    },
    storage,
    log,
  })

  // --- ペアリング（5.4）。トークンはメモリだけ。起こし直すと前の URL は使えない
  const pairings = new Map<string, { expiresAt: number; label: string; file: boolean }>()
  const pairingFile = join(home, 'pairing.txt')
  function issuePairing(label: string, file = false) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now().getTime() + PAIRING_MS
    pairings.set(token, { expiresAt, label, file })
    const url = `${o.origins[0]}/pair/${token}`
    if (file) writeFileSync(pairingFile, `${url}\n`, { encoding: 'utf-8', mode: 0o600 })
    return { url, expiresAt: new Date(expiresAt).toISOString() }
  }

  const paired = (c: Context) => {
    const v = getCookie(c, COOKIE)
    const at = v && ledger.sessionCreatedAt(sha256(v))
    return !!at && now().getTime() - Date.parse(at) < SESSION_MS
  }

  // 保存の失敗は 503 にして帯を出す。成功したら帯を下ろす（5.7 (8)）
  function writing<T>(c: Context, fn: () => T): T | Response {
    try {
      const r = fn()
      storage(true)
      return r
    } catch (e) {
      if (!isStorageError(e)) throw e
      log(`write failed: ${String(e)}`)
      storage(false)
      return c.json({ reason: 'storage' }, 503)
    }
  }

  const app = new Hono()

  // 1. 公開（Cookie 不要）
  app.get('/pair/:token', (c) => {
    const token = c.req.param('token')
    const p = pairings.get(token)
    if (!p || p.expiresAt <= now().getTime()) {
      pairings.delete(token)
      return c.html('<p>この URL はもう使えません。ホストを動かしている PC で新しい URL を出してください。</p>', 410)
    }
    const value = randomBytes(32).toString('base64url')
    const r = writing(c, () => ledger.appendSession('created', sha256(value), p.label))
    if (r instanceof Response) return r
    pairings.delete(token) // 使い切り。保存できてから消す
    if (p.file) {
      try {
        unlinkSync(pairingFile)
      } catch {}
    }
    const https = c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:'
    setCookie(c, COOKIE, value, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_MS / 1000,
      secure: https,
    })
    return c.redirect('/', 303)
  })
  // ponytail: /p/:shareToken（共有リンク）は版のあるページの Issue（12）。P1 では外に届かない（5.6）

  // 2. /api/*: Origin → Cookie → 各 API → 未知は JSON の 404
  app.use('/api/*', async (c, next) => {
    // GET 以外は JSON・multipart・PUT・DELETE を区別せず完全一致（5.4）
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !o.origins.includes(c.req.header('origin') ?? ''))
      return c.json({ reason: 'origin' }, 403)
    if (!paired(c)) return c.json({ reason: 'not_paired' }, 401)
    await next()
  })

  // 隔離の点検（8.10 (4)）。同時に 1 本。runs で包み、すべて停止で切る（切れたら isolation.json を書かない）
  let probing: Promise<void> | undefined
  function checkIsolation(): Promise<void> | undefined {
    const probe = o.probe
    if (!probe) return undefined
    if (probing) return probing
    const ac = runs.open('点検')
    probing = (async () => {
      try {
        const r = await probe(ac.signal)
        if (r && !ac.signal.aborted) {
          writeIsolation(home, r)
          storage(true)
        }
      } catch (e) {
        // 書けない（容量・台帳）は保存の帯に出す。ほかは log だけ（5.7 (8)）
        if (isStorageError(e)) storage(false)
        log(`isolation check: ${e instanceof Error ? e.stack : String(e)}`)
      } finally {
        runs.close('点検', ac)
        probing = undefined
        hub.emit('connections.changed', {})
      }
    })()
    runs.watch('点検', probing)
    hub.emit('connections.changed', {})
    return probing
  }

  app.get('/api/connections', (c) => {
    const last = readIsolation(home)
    const view: ConnectionsView = {
      isolation: {
        level: status.isolation,
        ...(o.cause && { cause: o.cause }),
        running: !!probing,
        ...(last && { last: { at: last.at, verdict: last.verdict } }),
      },
    }
    return c.json(view)
  })
  app.post('/api/checks/run', (c) => {
    if (!o.probe) return c.json({ reason: 'not_found' }, 404)
    try {
      void checkIsolation()
    } catch (e) {
      if (e instanceof Stopped) return c.json({ reason: 'stopped' }, 409)
      throw e
    }
    return c.json({}, 202)
  })

  app.get('/api/host', (c) => c.json(status))
  // ログインし直した本人の「続ける」（6.2.3 (7)）
  app.post('/api/host/resume', (c) => {
    runner.retrySignIn()
    return c.json(status)
  })
  app.get('/api/home', (c) => c.json(homeView(ledger, { ...status })))

  // 一覧（5.2）。完了した依頼（/done）が使う。新しく変わった順
  app.get('/api/cases', (c) => {
    const states = z
      .array(CaseState)
      .min(1)
      .safeParse(c.req.queries('state') ?? [])
    if (!states.success) return c.json({ reason: 'invalid' }, 400)
    return c.json(ledger.listCases(states.data).map((r) => toCard(ledger, r)))
  })

  app.get('/api/cases/:id', (c) => {
    const rec = ledger.getCase(c.req.param('id'))
    if (!rec) return c.json({ reason: 'not_found' }, 404)
    return c.json(
      caseView(
        ledger,
        rec,
        entranceView(home, ledger, rec),
        versionsOf(home, ledger, rec),
        reviewsOf(home, ledger, rec),
      ),
    )
  })

  // 版の本文（5.2・6.2.5 (7)）。html は判定した Markdown からホストが組み立てる（作り手の HTML は出さない）
  const draftText = (rec: { caseId: string; version: number }, raw: string | undefined) => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > rec.version) return undefined
    return readFileSync(join(versionDir(home, rec.caseId, n), draftNames(n).md), 'utf-8')
  }
  app.get('/api/cases/:id/drafts/:n', (c) => {
    const rec = ledger.getCase(c.req.param('id'))
    if (!rec) return c.json({ reason: 'not_found' }, 404)
    const md = draftText(rec, c.req.param('n'))
    if (md === undefined) return c.json({ reason: 'not_found' }, 404)
    const format = c.req.query('format') ?? 'md'
    if (format === 'md') return c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8' })
    if (format === 'html')
      return c.body(renderHtml(md), 200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
    // 仕立てた貼り付け用の文。仕立ての前は無い（6.2.8 (5)）
    if (format === 'paste') {
      const path = join(versionDir(home, rec.caseId, Number(c.req.param('n'))), 'outputs', OUTPUT_FILES.paste)
      if (!existsSync(path)) return c.json({ reason: 'not_found' }, 404)
      return c.body(readFileSync(path, 'utf-8'), 200, { 'content-type': 'text/plain; charset=utf-8' })
    }
    return c.json({ reason: 'invalid' }, 400)
  })
  app.get('/api/cases/:id/diff', (c) => {
    const rec = ledger.getCase(c.req.param('id'))
    if (!rec) return c.json({ reason: 'not_found' }, 404)
    const from = draftText(rec, c.req.query('from'))
    const to = draftText(rec, c.req.query('to'))
    if (from === undefined || to === undefined) return c.json({ reason: 'invalid' }, 400)
    return c.json(DraftDiff.parse({ changes: diff(from, to) }))
  })

  app.post('/api/cases/:id/actions', async (c) => {
    const caseId = c.req.param('id')
    const parsed = CaseAction.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ reason: 'invalid', issues: parsed.error.issues }, 400)
    const action = parsed.data
    const rec0 = ledger.getCase(caseId)
    const before = rec0?.state
    // 入口の承認は、初めての操作のときだけ答えをトランザクションの前にファイルへ（4.2 T8・6.2.2 (7)）
    if (action.type === 'entrance.approve' && rec0 && !ledger.findEvent(action.eventId)) {
      const w = writing(c, () => writeApproval(home, ledger, rec0, action))
      if (w instanceof Response) return w
      if (w === 'invalid') return c.json({ reason: 'invalid' }, 400)
    }
    // 承認する組の依頼書に「渡してほしいもの」があれば本人の番の材料待ち（T8。6.2.4 (2)）
    const ctx =
      action.type === 'entrance.approve' && rec0
        ? { materialsPending: !!currentSet(home, ledger, caseId)?.brief.wanted.length }
        : {}
    // revision は先に比べない。eventId → expectedRevision の順は transition が持つ（5.3.1・5.7 (5)）
    const r = writing(c, () => transition(ledger, { ...action, caseId, by: '本人' }, ctx))
    if (r instanceof Response) return r
    return answer(c, caseId, r, () => {
      // 動いている仕事を止める（stop.case・cancel・T7b。8.4・5.7 (4)）
      if (shouldAbort(action.type, before))
        void runs.abort(caseId).then((left) => left.length && log(`run did not end: ${caseId}`))
    })
  })

  // 本人が資料を渡す。S1 は貼り付けた文だけ。初めての操作で遷移が受けるときだけ、先にファイルを書く（6.2.4 (3)）
  app.post('/api/cases/:id/materials', async (c) => {
    const caseId = c.req.param('id')
    const parsed = MaterialsPost.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ reason: 'invalid' }, 400)
    const p = parsed.data
    const rec0 = ledger.getCase(caseId)
    if (
      rec0?.state === '材料待ち' &&
      rec0.turn === '本人' &&
      rec0.revision === p.expectedRevision &&
      !ledger.findEvent(p.eventId)
    ) {
      const path = join(workDir(home, caseId), 'materials', pastedName(pastedCount(ledger, caseId) + 1))
      const w = writing(c, () => writeAtomic(path, `${p.text}\n`))
      if (w instanceof Response) return w
    }
    const r = writing(c, () =>
      transition(ledger, {
        type: 'materials.provided',
        eventId: p.eventId,
        caseId,
        expectedRevision: p.expectedRevision,
        by: '本人',
      }),
    )
    return r instanceof Response ? r : answer(c, caseId, r)
  })

  // 本人の操作の応答（5.3.1）。コミットしたら合図を出し、libretto の番なら仕事を起こす
  // （T7・T7b・T8・T10・T14・T19・T31。6.2.3 (1)）
  function answer(c: Context, caseId: string, r: ReturnType<typeof transition>, moved?: () => void) {
    if (!r.ok) {
      if (r.reason === 'not_found') return c.json({ reason: 'not_found' }, 404)
      if (r.reason === 'conflict') return c.json({ reason: 'conflict' }, 400)
      const current: CaseCard | undefined = 'case' in r && r.case ? toCard(ledger, r.case) : undefined
      return c.json({ reason: r.reason, ...(current && { current }) }, 409)
    }
    const rec = r.case ?? ledger.getCase(caseId)
    if (!rec) return c.json({ reason: 'not_found' }, 404)
    if (!r.replayed) {
      caseChanged(caseId)
      if (r.newCaseId) caseChanged(r.newCaseId)
      moved?.()
      runner.kick(caseId)
      if (r.newCaseId) runner.kick(r.newCaseId)
    }
    return c.json(
      ActionResult.parse({
        state: rec.state,
        turn: rec.turn,
        revision: rec.revision,
        replayed: r.replayed,
        ...(r.newCaseId && { newCaseId: r.newCaseId }),
      }),
    )
  }

  // 会話欄（6.2.1）。caseId が無いか空なら lobby。caseId 付きは案件の中で話す（6.2.2 (8)）
  app.get('/api/conversation', (c) => c.json(conversation.view(c.req.query('caseId') || 'lobby')))
  app.post('/api/conversation/messages', async (c) => {
    const parsed = ConversationPost.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ reason: 'invalid' }, 400)
    const r = writing(c, () => conversation.post(parsed.data))
    if (r instanceof Response) return r
    if (r.ok) return c.json({ seq: r.seq, replayed: r.replayed }, 202)
    return c.json({ reason: r.reason }, r.reason === 'not_found' ? 404 : 409)
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let chain = Promise.resolve()
      let end = () => {}
      const ended = new Promise<void>((resolve) => {
        end = resolve
        stream.onAbort(resolve)
      })
      // 外した端末・寿命の切れた端末には送らず、つなぎを切る（認証は接続のときだけでは足りない）
      const allowed = () => {
        if (paired(c)) return true
        end()
        return false
      }
      const send = (m: Pick<SseMessage, 'id' | 'event' | 'data'>) => {
        if (allowed()) chain = chain.then(() => stream.writeSSE(m)).catch(() => {})
      }
      // 登録してから送り直しを積む（同期なので、間に合図が挟まらない）
      const unsubscribe = hub.subscribe(send)
      const replay = hub.since(c.req.header('last-event-id'))
      if (replay) for (const m of replay) send(m)
      else send({ id: hub.lastId(), event: 'resync', data: '{}' })
      // 途中の網（tailscale serve など）に切られないよう 25 秒ごとに注釈の行
      const beat = setInterval(() => {
        if (!allowed()) return
        chain = chain
          .then(() => stream.write(': \n\n'))
          .then(() => {})
          .catch(() => {})
      }, 25_000)
      await ended
      clearInterval(beat)
      unsubscribe()
    }),
  )

  app.post('/api/stop', async (c) => {
    await stop.stop()
    // メモリの停止は効いている。保存できていなければ 503（再起動すると止まっていない。5.7 (8)）
    return status.storageOk ? c.json(status) : c.json({ reason: 'storage' }, 503)
  })
  app.delete('/api/stop', async (c) => {
    let r: boolean
    try {
      r = await stop.release()
    } catch (e) {
      if (!isStorageError(e)) throw e
      storage(false)
      return c.json({ reason: 'storage' }, 503)
    }
    return r ? c.json(status) : c.json({ reason: 'storage' }, 503)
  })

  // Settings.apiKeys の形。GET /api/settings ができたらそちらの apiKeys に移して消す（6.1.3 (6)）
  app.get('/api/settings/keys', (c) =>
    c.json(Object.fromEntries(ApiKeyKind.options.map((k) => [k, keyStatus(home, k)]))),
  )
  app.put('/api/settings/keys/:kind', async (c) => {
    const kind = ApiKeyKind.safeParse(c.req.param('kind'))
    if (!kind.success) return c.json({ reason: 'not_found' }, 404)
    const body = ApiKeyInput.safeParse(await c.req.json().catch(() => undefined))
    // 値を含む issues は返さない
    if (!body.success) return c.json({ reason: 'invalid' }, 400)
    const r = writing(c, () => setKey(home, kind.data, body.data.value, now()))
    if (r instanceof Response) return r
    hub.emit('settings.changed', {})
    return c.json(r)
  })
  app.delete('/api/settings/keys/:kind', (c) => {
    const kind = ApiKeyKind.safeParse(c.req.param('kind'))
    if (!kind.success) return c.json({ reason: 'not_found' }, 404)
    const r = writing(c, () => deleteKey(home, kind.data))
    if (r instanceof Response) return r
    hub.emit('settings.changed', {})
    return c.json(r)
  })

  app.post('/api/devices', async (c) => {
    const body = DeviceInput.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) return c.json({ reason: 'invalid' }, 400)
    return c.json(issuePairing(body.data.label))
  })
  app.delete('/api/devices/:sessionId', (c) => {
    const r = writing(c, () => ledger.appendSession('revoked', c.req.param('sessionId')))
    return r instanceof Response ? r : c.body(null, 204)
  })

  app.all('/api/*', (c) => c.json({ reason: 'not_found' }, 404))

  // 3. 版のあるページ（Cookie 必須）
  app.get('/cases/:id/page', (c) => {
    if (!paired(c)) return c.html('<p>この端末はまだつながっていません。</p>', 401)
    // 出せるのは page に保存した版。v が無ければその最新（6.2.8 (4)）
    const rec = ledger.getCase(c.req.param('id'))
    const saved = rec ? pageVersions(ledger, rec.caseId) : []
    const raw = c.req.query('v')
    const n = raw === undefined ? saved.at(-1) : Number(raw)
    if (!rec || n === undefined || !saved.includes(n))
      return c.html('<p>このバージョンのページはまだありません。</p>', 404)
    const body = readFileSync(join(versionDir(home, rec.caseId, n), 'outputs', OUTPUT_FILES.page))
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    }
    if (c.req.query('download') === '1') headers['content-disposition'] = attachment(rec.title, n)
    return c.body(body, 200, headers)
  })

  // 4. 静的ファイル、5. 画面の殻（Cookie 不要。データは /api/* だけが持つ）
  app.use('/*', serveStatic({ root: o.staticDir }))
  app.get('/*', (c) => {
    try {
      return c.html(readFileSync(join(o.staticDir, 'index.html'), 'utf-8'))
    } catch {
      return c.text('画面がまだありません', 404)
    }
  })

  return { app, hub, runs, stop, status, issuePairing, conversation, entrance, runner, caseChanged, checkIsolation }
}

// ダウンロードの名前（6.2.8 (4)）。ASCII の名前と、題を百分率符号化した名前
export function attachment(title: string, n: number) {
  const safe = [...title].map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || '\u007f/\\'.includes(ch) ? '_' : ch))
  const name = `${safe.join('')}-第${n}版.html`
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="page-v${n}.html"; filename*=UTF-8''${encoded}`
}

// T7b は入口待ち以外からの entrance.revise（動いている仕事がある）
function shouldAbort(type: CaseAction['type'], before: CaseState | undefined) {
  return type === 'stop.case' || type === 'cancel' || (type === 'entrance.revise' && before !== '入口待ち')
}
