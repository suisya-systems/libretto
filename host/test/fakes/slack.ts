// 偽の Slack（docs/implementation.md 11.1・6.6 (8)・6.9 (11)）。口（auth.test・reactions.list・conversations.replies・
// conversations.info・users.info と、自動検出の search.messages・conversations.history・conversations.list）をプロセス内の HTTP で受け、受けた要求を記録する。テストは「files.* を呼んでいない」をこの記録で確かめる
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type RawMessage, type ReactionItem, SLACK_SCOPES } from '../../src/intake/slack.ts'

export type SlackSeen = { method: string; params: Record<string, string>; auth?: string }

export const ME = 'U0OWNER'

export async function startFakeSlack() {
  const seen: SlackSeen[] = []
  const state = {
    token: 'xoxp-good',
    userId: ME, // auth.test が返す本人
    scopes: SLACK_SCOPES as string[] | undefined, // undefined なら x-oauth-scopes の見出しを返さない
    items: [] as ReactionItem[],
    pageSize: 200, // 1 ページに返す数（limit より少なく返すこともある）
    threads: new Map<string, RawMessage[]>(), // `${channel}:${thread_ts}`
    channels: new Map<string, { name?: string; is_im?: boolean; is_mpim?: boolean }>(),
    users: new Map<string, string>([[ME, '本人']]),
    history: new Map<string, RawMessage[]>(), // チャンネルの投稿（新しい順に返す）
    mentions: [] as { channel: string; ts: string; is_im?: boolean; is_mpim?: boolean }[], // search.messages の結果
    searchPageSize: 100,
    fail: new Map<string, { status?: number; error?: string; needed?: string }>(), // 口ごとの失敗
  }
  const server: Server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const method = (req.url ?? '').replace(/^\/api\//, '')
    const params = Object.fromEntries(new URLSearchParams(raw))
    seen.push({ method, params, ...(req.headers.authorization && { auth: req.headers.authorization }) })
    const json = (v: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(v))
    }
    const f = state.fail.get(method)
    if (f?.status) {
      res.writeHead(f.status)
      return res.end()
    }
    if (f?.error) return json({ ok: false, error: f.error, ...(f.needed && { needed: f.needed }) })
    if (req.headers.authorization !== `Bearer ${state.token}`) return json({ ok: false, error: 'invalid_auth' })

    if (method === 'auth.test')
      return json(
        {
          ok: true,
          url: 'https://acme.slack.com/',
          team: 'ACME',
          user: 'honnin',
          team_id: 'T1',
          user_id: state.userId,
        },
        state.scopes ? { 'x-oauth-scopes': state.scopes.join(',') } : {},
      )
    if (method === 'reactions.list') {
      const at = Number(params.cursor ?? 0)
      const next = at + state.pageSize
      return json({
        ok: true,
        items: state.items.slice(at, next),
        response_metadata: { next_cursor: next < state.items.length ? String(next) : '' },
      })
    }
    if (method === 'conversations.replies') {
      // ts は親の投稿でも、スレッドの中の投稿でもよい（公式文書のとおり）
      const t = [...state.threads].find(
        ([k, m]) =>
          k === `${params.channel}:${params.ts}` ||
          (k.startsWith(`${params.channel}:`) && m.some((x) => x.ts === params.ts)),
      )?.[1]
      // スレッドでない投稿の ts なら、その投稿だけを返す（公式文書のとおり）
      const one = state.history.get(params.channel ?? '')?.find((x) => x.ts === params.ts)
      if (!t && one) return json({ ok: true, messages: [one] })
      return t
        ? json({ ok: true, messages: t.slice(0, Number(params.limit ?? 1000)) })
        : json({ ok: false, error: 'thread_not_found' })
    }
    if (method === 'search.messages') {
      const page = Number(params.page ?? 1)
      const size = state.searchPageSize
      const all = state.mentions
      return json({
        ok: true,
        messages: {
          matches: all.slice((page - 1) * size, page * size).map(({ channel, ts, is_im, is_mpim }) => ({
            ts,
            channel: { id: channel, is_im: !!is_im, is_mpim: !!is_mpim },
          })),
          paging: { page, pages: Math.max(1, Math.ceil(all.length / size)) },
        },
      })
    }
    if (method === 'conversations.history') {
      const all = (state.history.get(params.channel ?? '') ?? [])
        .filter((m) => Number(m.ts) >= Number(params.oldest ?? 0))
        .sort((a, b) => Number(b.ts) - Number(a.ts))
      const at = Number(params.cursor ?? 0)
      const next = at + Number(params.limit ?? 100)
      return json({
        ok: true,
        messages: all.slice(at, next),
        response_metadata: { next_cursor: next < all.length ? String(next) : '' },
      })
    }
    if (method === 'conversations.list')
      return json({
        ok: true,
        channels: [...state.channels]
          .filter(([, c]) => !c.is_im && !c.is_mpim)
          .map(([id, c]) => ({ id, name: c.name })),
        response_metadata: { next_cursor: '' },
      })
    if (method === 'conversations.info') {
      const c = state.channels.get(params.channel ?? '')
      return c ? json({ ok: true, channel: c }) : json({ ok: false, error: 'channel_not_found' })
    }
    if (method === 'users.info') {
      const name = state.users.get(params.user ?? '')
      return name
        ? json({ ok: true, user: { name: 'x', real_name: name, profile: { display_name: '' } } })
        : json({ ok: false, error: 'user_not_found' })
    }
    json({ ok: false, error: 'unknown_method' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  return { api, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) }
}

// 本人（既定）が emoji を付けた投稿 1 件の一覧の項目
export function reacted(
  channel: string,
  m: Partial<RawMessage> & { ts: string },
  o: { emoji?: string; by?: string[] } = {},
): ReactionItem {
  return {
    type: 'message',
    channel,
    message: { type: 'message', text: '', ...m, reactions: [{ name: o.emoji ?? 'memo', users: o.by ?? [ME] }] },
  }
}
