// Slack の合図（docs/implementation.md 6.6）。呼び出しは fetch で直接。トークンは .env.local とメモリだけで、外へ返さない。
// ファイルは名前だけ（files.* と url_private は呼ばない）。本文はメモリで渡して捨てる
import { jst } from '../ledger/ledger.ts'

// User Token Scopes（6.6 (3)）。足りないものは設定の面に名前で出す
export const SLACK_SCOPES = [
  'reactions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
]
export const SLACK_API = 'https://slack.com/api'
const CALL_MS = 15_000
const MAX_BODY = 20_000
const AUTH = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'])

// .env.local の 1 つ（6.6 (2)）
export const slackToken = (env: NodeJS.ProcessEnv = process.env) => env.LIBRETTO_SLACK_USER_TOKEN?.trim() || undefined

export type SlackFail = { ok: false; why: 'not_connected' | 'auth_expired' | 'rate_limited' | 'network' | 'rejected' }
export type Me = { userId: string; team: string; user: string; url: string }
export type Slack = ReturnType<typeof createSlack>

export function createSlack(o: { token?: string | undefined; api?: string; log?: (line: string) => void }) {
  const api = o.api ?? SLACK_API
  const log = o.log ?? (() => {})
  let me: Me | undefined
  let expired = false
  let missing = new Set<string>()

  async function call<T>(
    method: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ ok: true; json: T; headers: Headers } | SlackFail> {
    if (!o.token) return { ok: false, why: 'not_connected' }
    let res: Response
    let body: Record<string, unknown>
    try {
      res = await fetch(`${api}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
      })
      if (res.status === 429) return { ok: false, why: 'rate_limited' }
      if (!res.ok) {
        log(`slack ${method}: ${res.status}`)
        return { ok: false, why: res.status >= 500 ? 'network' : 'rejected' }
      }
      body = (await res.json()) as Record<string, unknown>
    } catch (e) {
      // 届かない・黙った・本文が途中で切れた（6.6 (4)）
      if (signal.aborted) throw e
      return { ok: false, why: 'network' }
    }
    if (body.ok === true) return { ok: true, json: body as T, headers: res.headers }
    const error = String(body.error ?? '')
    log(`slack ${method}: ${error}`)
    if (AUTH.has(error)) {
      expired = true
      return { ok: false, why: 'auth_expired' }
    }
    if (error === 'ratelimited') return { ok: false, why: 'rate_limited' }
    if (error === 'missing_scope' && typeof body.needed === 'string')
      for (const s of body.needed.split(',')) missing.add(s.trim())
    return { ok: false, why: 'rejected' }
  }

  return {
    configured: !!o.token,
    status() {
      return {
        state: !o.token ? ('none' as const) : expired ? ('expired' as const) : ('connected' as const),
        ...(me && { team: me.team, user: me.user, userId: me.userId }),
        missingScopes: SLACK_SCOPES.filter((s) => missing.has(s)),
      }
    },
    // 回の最初に本人と権限を確かめる（6.6 (2)）。見出しが無ければ、各口の missing_scope で覚えたものを残す
    async whoami(signal: AbortSignal): Promise<{ ok: true; me: Me } | SlackFail> {
      const r = await call<{ user_id: string; team: string; user: string; url: string }>('auth.test', {}, signal)
      if (!r.ok) return r
      expired = false
      me = { userId: r.json.user_id, team: r.json.team, user: r.json.user, url: r.json.url }
      const granted = r.headers.get('x-oauth-scopes')
      if (granted !== null) {
        const have = new Set(granted.split(',').map((s) => s.trim()))
        missing = new Set(SLACK_SCOPES.filter((s) => !have.has(s)))
      }
      return { ok: true, me }
    },
    call,
  }
}

// --- 読み取り

type File = { name?: string; title?: string }
export type RawMessage = {
  type?: string
  user?: string
  username?: string
  bot_profile?: { name?: string }
  text?: string
  ts: string
  thread_ts?: string
  permalink?: string
  files?: File[]
  reactions?: { name: string; users?: string[] }[]
}
export type ReactionItem = { type: string; channel?: string; message?: RawMessage }

export type Post = {
  candidateId: string
  channel: string
  ts: string
  subject: string // #チャンネル名
  from: string // 投稿者の名前
  senderKey: string // チャンネルの id（見送りの学習は Slack をチャンネルで外す。6.6 (4)）
  othersPost: boolean
  receivedAt: string
  link: string
  body: string // 保存しない
  attachments: string[]
}

export const slackCandidateId = (channel: string, ts: string) => `slack:${channel}:${ts}`
export const parseCandidateId = (id: string) => {
  const m = /^slack:([^:]+):(.+)$/.exec(id)
  return m && { channel: m[1] as string, ts: m[2] as string }
}

// 本人が付けたリアクションの 1 ページ。新しい順とは限らない（6.6 (4)）
export async function reactionsPage(s: Slack, cursor: string | undefined, signal: AbortSignal) {
  const r = await s.call<{ items?: ReactionItem[]; response_metadata?: { next_cursor?: string } }>(
    'reactions.list',
    { full: 'true', limit: '200', ...(cursor && { cursor }) },
    signal,
  )
  if (!r.ok) return r
  return { ok: true as const, items: r.json.items ?? [], next: r.json.response_metadata?.next_cursor || undefined }
}

// 本人がその絵文字を付けた投稿か（本人がほかの絵文字だけを付けた投稿も一覧に出る）
export const markedBy = (m: RawMessage | undefined, emoji: string, userId: string) =>
  !!m?.reactions?.some((r) => r.name === emoji && r.users?.includes(userId))

// 1 回の中で名前を覚えておく（同じ人を何度も引かない）。fatal は回を止める失敗
type Names = Map<string, string>
async function nameOf(s: Slack, id: string, names: Names, signal: AbortSignal): Promise<string | SlackFail> {
  const known = names.get(id)
  if (known) return known
  const r = await s.call<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string } } }>(
    'users.info',
    { user: id },
    signal,
  )
  if (!r.ok && r.why !== 'rejected') return r
  const u = r.ok ? r.json.user : undefined
  const name = u?.profile?.display_name || u?.real_name || u?.name || 'Slack のメンバー'
  names.set(id, name)
  return name
}

async function titleOf(s: Slack, channel: string, signal: AbortSignal): Promise<string | SlackFail> {
  const r = await s.call<{ channel?: { name?: string; is_im?: boolean; is_mpim?: boolean } }>(
    'conversations.info',
    { channel },
    signal,
  )
  if (!r.ok) return r.why === 'rejected' ? 'Slack' : r
  const c = r.json.channel
  if (c?.is_im) return 'ダイレクトメッセージ'
  if (c?.is_mpim) return 'グループ DM'
  return c?.name ? `#${c.name}` : 'Slack'
}

// Slack の書式を読める文に。<url|label> は場所を落とさない（6.6 (4)）
export function plain(text: string, names: Names): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? 'Slack のメンバー'}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2（$1）')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// 投稿とスレッドを読み、カードと材料の形に。印を付けた投稿を先頭に置き、字数で落とさない（6.6 (4)）。
// marked が無ければ（読み直し）スレッドの中から ts で探す
export async function readPost(
  s: Slack,
  me: Me,
  channel: string,
  ts: string,
  marked: RawMessage | undefined,
  signal: AbortSignal,
): Promise<{ ok: true; post: Post } | SlackFail> {
  const threadTs = marked ? marked.thread_ts : ts
  let thread: RawMessage[] = []
  if (threadTs) {
    const r = await s.call<{ messages?: RawMessage[] }>(
      'conversations.replies',
      { channel, ts: threadTs, limit: '100' },
      signal,
    )
    if (!r.ok && r.why !== 'rejected') return r
    // ponytail: 1 ページ（100 件）だけ。読み直しで印の投稿が 101 件目より後ろなら、スレッドの先頭だけになる
    thread = r.ok ? (r.json.messages ?? []) : []
  }
  const m = marked ?? thread.find((x) => x.ts === ts)
  const all = [...(m ? [m] : []), ...thread.filter((x) => x.ts !== ts)]
  const names: Names = new Map()
  const ids = new Set<string>()
  for (const x of all) {
    if (x.user) ids.add(x.user)
    for (const [, id] of (x.text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)) ids.add(id as string)
  }
  for (const id of ids) {
    const n = await nameOf(s, id, names, signal)
    if (typeof n !== 'string') return n
  }
  const title = await titleOf(s, channel, signal)
  if (typeof title !== 'string') return title
  const who = (x: RawMessage) =>
    (x.user && names.get(x.user)) || x.bot_profile?.name || x.username || 'Slack のメンバー'
  const line = (x: RawMessage) => `${who(x)}: ${plain(x.text ?? '', names)}`
  const rest = all.slice(m ? 1 : 0)
  const body = [
    ...(m ? ['（印を付けた投稿）', line(m)] : []),
    ...(rest.length ? ['', '（スレッド）', ...rest.map(line)] : []),
  ]
    .join('\n')
    .slice(0, MAX_BODY)
  const files = all.flatMap((x) => x.files ?? []).map((f) => f.name || f.title || '名前のないファイル')
  const base = me.url.replace(/\/?$/, '/')
  return {
    ok: true,
    post: {
      candidateId: slackCandidateId(channel, ts),
      channel,
      ts,
      subject: title,
      from: m ? who(m) : 'Slack のメンバー',
      senderKey: channel,
      othersPost: m?.user !== me.userId,
      receivedAt: jst(new Date(Number(ts) * 1000)),
      // permalink が無ければ組む（無いとカードが台帳の型に通らない。6.6 (4)）
      link: m?.permalink ?? `${base}archives/${channel}/p${ts.replace('.', '')}`,
      body,
      attachments: [...new Set(files)],
    },
  }
}
