// Google の連携（docs/implementation.md 6.4 (1)(2)）。OAuth は fetch で直接。トークンは google.json とメモリだけで、外へ返さない
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { jst } from '../ledger/ledger.ts'
import { writeSecret } from '../model/keys.ts'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
// libretto が作ったファイルだけを作る・書き出す・探す（6.5 (1)）。本人のほかのファイルは読めない
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
// Google Meet が作った・編集したファイルだけを読む（会議メモ。6.7 (1)）。ほかのファイルは読めない
export const MEET_SCOPE = 'https://www.googleapis.com/auth/drive.meet.readonly'
const SCOPES = [GMAIL_SCOPE, DRIVE_SCOPE, MEET_SCOPE]
export const GOOGLE_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com',
  drive: 'https://www.googleapis.com',
}
export type GoogleEndpoints = typeof GOOGLE_ENDPOINTS
export type GoogleConfig = { clientId: string; clientSecret: string }

// .env.local の 2 つ（6.4 (2)）。片方でも無ければ連携できない
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | undefined {
  const clientId = env.LIBRETTO_GOOGLE_CLIENT_ID?.trim()
  const clientSecret = env.LIBRETTO_GOOGLE_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : undefined
}

const Saved = z.object({
  refreshToken: z.string().min(1),
  email: z.string(),
  scopes: z.array(z.string()),
  savedAt: z.string(),
})
type Saved = z.infer<typeof Saved>

export type GoogleFail =
  | { ok: false; why: 'not_connected' | 'auth_expired' | 'rate_limited' | 'network' | 'rejected' }
  // 403 accessNotConfigured: Google Cloud のプロジェクトでその API が有効でない。api は呼んだ先
  | { ok: false; why: 'api_disabled'; api: 'gmail' | 'drive' }
export type Google = ReturnType<typeof createGoogle>

const STATE_MS = 10 * 60_000
const TOKEN_MS = 15_000 // トークンの口が黙っても、取り込みの回が終わるように（6.4 (3)）
const b64url = (b: Buffer) => b.toString('base64url')

export function createGoogle(o: {
  home: string
  config?: GoogleConfig
  redirectUri: string // http://127.0.0.1:<port>/oauth/google/callback（ループバック。6.4 (2)）
  endpoints?: Partial<GoogleEndpoints>
  now?: () => Date
  log?: (line: string) => void
}) {
  const ep = { ...GOOGLE_ENDPOINTS, ...o.endpoints }
  const now = o.now ?? (() => new Date())
  const log = o.log ?? (() => {})
  const file = join(o.home, 'google.json')
  // 連携の世代。解除で進め、遅れて届いた戻りが書き戻さないようにする（6.4 (2)）
  let generation = 0
  const pending = new Map<string, { verifier: string; origin: string; expiresAt: number; generation: number }>()
  let access: { token: string; expiresAt: number } | undefined
  let refreshing: Promise<string | GoogleFail> | undefined
  let expired = false

  function load(): Saved | undefined {
    try {
      return Saved.parse(JSON.parse(readFileSync(file, 'utf-8')))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`google.json: ${(e as Error).message}`)
      return undefined
    }
  }

  async function post(url: string, form: Record<string, string>) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_MS),
    })
  }

  // 更新トークンからアクセストークン。invalid_grant は連携し直し（10.2）
  function refresh(saved: Saved): Promise<string | GoogleFail> {
    const config = o.config
    if (!config) return Promise.resolve({ ok: false, why: 'not_connected' })
    const started = generation
    refreshing ??= (async (): Promise<string | GoogleFail> => {
      try {
        const res = await post(ep.token, {
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: saved.refreshToken,
          grant_type: 'refresh_token',
        })
        const body = (await res.json().catch(() => ({}))) as {
          access_token?: string
          expires_in?: number
          error?: string
        }
        // 更新の間に解除・連携し直しがあれば、古い連携の結果で今の状態を書き換えない（6.4 (2)）
        if (started !== generation) return { ok: false, why: 'not_connected' }
        if (res.ok && body.access_token) {
          expired = false
          access = { token: body.access_token, expiresAt: now().getTime() + (body.expires_in ?? 3600) * 1000 }
          return body.access_token
        }
        if (body.error === 'invalid_grant' || res.status === 401) {
          expired = true
          return { ok: false, why: 'auth_expired' }
        }
        log(`google token: ${res.status} ${body.error ?? ''}`)
        return { ok: false, why: res.status === 429 ? 'rate_limited' : 'network' }
      } catch (e) {
        log(`google token: ${(e as Error).message}`)
        return { ok: false, why: 'network' }
      } finally {
        refreshing = undefined
      }
    })()
    return refreshing
  }

  async function token(force = false): Promise<string | GoogleFail> {
    const saved = load()
    if (!saved || !o.config) return { ok: false, why: 'not_connected' }
    if (!force && access && access.expiresAt - 60_000 > now().getTime()) return access.token
    return refresh(saved)
  }

  return {
    configured: !!o.config,
    generation: () => generation,
    // docs: Google ドキュメントに保存できる権限があるか（前の連携は Gmail だけ。連携し直すと付く。6.5 (2)）。meet は会議メモ（6.7 (1)）
    status(): { state: 'none' | 'connected' | 'expired'; email?: string; docs: boolean; meet: boolean } {
      const saved = o.config ? load() : undefined
      if (!saved) return { state: 'none', docs: false, meet: false }
      return {
        state: expired ? 'expired' : 'connected',
        email: saved.email,
        docs: saved.scopes.includes(DRIVE_SCOPE),
        meet: saved.scopes.includes(MEET_SCOPE),
      }
    },

    // POST /api/connections/google/start。origin は Origin の検査を通った要求の起点（戻った後にそこへ返す）
    start(origin: string): string {
      const config = o.config
      if (!config) throw new Error('google is not configured')
      const at = now().getTime()
      for (const [k, v] of pending) if (v.expiresAt <= at) pending.delete(k)
      const state = b64url(randomBytes(32))
      const verifier = b64url(randomBytes(32))
      pending.set(state, { verifier, origin, expiresAt: at + STATE_MS, generation })
      const q = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: o.redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      })
      return `${ep.auth}?${q}`
    },

    // GET /oauth/google/callback。Cookie は求めず state で確かめる（6.4 (2)）。state は使い切り
    async callback(q: {
      state?: string | undefined
      code?: string | undefined
      error?: string | undefined
    }): Promise<{ origin?: string; result: 'connected' | 'denied' | 'failed' }> {
      const p = q.state ? pending.get(q.state) : undefined
      if (q.state) pending.delete(q.state)
      if (!p || p.expiresAt <= now().getTime() || p.generation !== generation || !o.config) return { result: 'failed' }
      const origin = p.origin
      if (q.error || !q.code) return { origin, result: q.error === 'access_denied' ? 'denied' : 'failed' }
      try {
        const res = await post(ep.token, {
          code: q.code,
          client_id: o.config.clientId,
          client_secret: o.config.clientSecret,
          redirect_uri: o.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: p.verifier,
        })
        const t = (await res.json().catch(() => ({}))) as {
          access_token?: string
          refresh_token?: string
          expires_in?: number
          scope?: string
        }
        if (!res.ok || !t.access_token || !t.refresh_token) {
          log(`google code exchange: ${res.status}`)
          return { origin, result: 'failed' }
        }
        const profile = await fetch(`${ep.gmail}/gmail/v1/users/me/profile`, {
          headers: { authorization: `Bearer ${t.access_token}` },
        })
        const me = (await profile.json().catch(() => ({}))) as { emailAddress?: string }
        if (!profile.ok || !me.emailAddress) {
          log(`google profile: ${profile.status}`)
          return { origin, result: 'failed' }
        }
        // 交換の間に解除されていれば書かない
        if (p.generation !== generation) return { origin, result: 'failed' }
        writeSecret(
          file,
          JSON.stringify({
            refreshToken: t.refresh_token,
            email: me.emailAddress,
            scopes: (t.scope ?? GMAIL_SCOPE).split(' '),
            savedAt: jst(now()),
          } satisfies Saved),
        )
        // 連携し直しも世代を進める。前の連携の更新・取り込みの結果で、新しい連携を書き換えない（6.4 (2)）
        generation += 1
        pending.clear()
        access = { token: t.access_token, expiresAt: now().getTime() + (t.expires_in ?? 3600) * 1000 }
        expired = false
        return { origin, result: 'connected' }
      } catch (e) {
        log(`google callback: ${(e as Error).message}`)
        return { origin, result: 'failed' }
      }
    },

    // DELETE /api/connections/google。世代を進め、待っている state とメモリのトークンを捨て、ファイルを消してから取り消す（6.4 (2)）
    async disconnect() {
      generation += 1
      pending.clear()
      access = undefined
      expired = false
      const saved = load()
      try {
        unlinkSync(file)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      if (!saved) return
      try {
        await post(ep.revoke, { token: saved.refreshToken })
      } catch (e) {
        log(`google revoke: ${(e as Error).message}`)
      }
    },

    // Gmail の GET。401 は 1 回だけ更新して呼び直す（6.4 (3)）
    get<T>(path: string, signal: AbortSignal): Promise<{ ok: true; json: T } | GoogleFail> {
      return call<T>(`${ep.gmail}${path}`, {}, signal, 'json')
    },
    // Drive。作成（POST）が届いたか分からないときは network（呼ぶ側が「不明」にする。6.5 (6)）
    drive<T>(path: string, init: RequestInit, signal: AbortSignal, as: 'json' | 'text' = 'json') {
      return call<T>(`${ep.drive}${path}`, init, signal, as)
    },
  }

  async function call<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    as: 'json' | 'text',
  ): Promise<{ ok: true; json: T } | GoogleFail> {
    // 呼んでいる間に解除・連携し直しがあれば、結果を使わず、今の連携のトークンにも触らない（別のメールボックスを読まない）
    const started = generation
    const stale = (): GoogleFail | undefined =>
      started !== generation ? { ok: false, why: 'not_connected' } : undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(attempt > 0)
      const moved = stale()
      if (moved) return moved
      if (typeof t !== 'string') return t
      let res: Response
      try {
        res = await fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${t}` },
          signal,
        })
      } catch (e) {
        if (signal.aborted) throw e
        return { ok: false, why: 'network' }
      }
      const moved2 = stale()
      if (moved2) return moved2
      if (res.ok) {
        // 本文の受け取りの途中で切れても、届かなかったとして返す（呼ぶ側の落ち方に乗せる）
        let json: T
        try {
          json = (as === 'json' ? await res.json() : await res.text()) as T
        } catch (e) {
          if (signal.aborted) throw e
          return { ok: false, why: 'network' }
        }
        // 受け取りの間に解除・連携し直しがあれば捨てる
        return stale() ?? { ok: true, json }
      }
      if (res.status === 401) {
        access = undefined
        continue
      }
      const reason = res.status === 403 ? await res.text().catch(() => '') : ''
      log(`google ${new URL(url).pathname}: ${res.status}`)
      if (/accessNotConfigured|SERVICE_DISABLED/.test(reason))
        return { ok: false, why: 'api_disabled', api: url.startsWith(ep.gmail) ? 'gmail' : 'drive' }
      if (res.status === 429 || /rateLimitExceeded/i.test(reason)) return { ok: false, why: 'rate_limited' }
      return { ok: false, why: res.status >= 500 ? 'network' : 'rejected' }
    }
    expired = true
    return { ok: false, why: 'auth_expired' }
  }
}
