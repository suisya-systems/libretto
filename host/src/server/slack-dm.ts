// Slack の DM でお知らせを送る（docs/implementation.md 6.8 (2)(3)(8)(12)）。ボットトークン（api-keys.json の slackBot）で、
// 取り込みのユーザートークンの本人（auth.test の user_id）へ chat.postMessage。文は NOTICE のまま、まとめた分の行を並べる
import type { ConnectionsView, Notice } from '@libretto/shared/api'
import type { Slack, SlackFail } from '../intake/slack.ts'
import type { Sender } from './notices.ts'

// ui-wording.md の「Slack の DM に足す文」
export const SLACK_DM = {
  open: '開く',
  openApp: 'libretto の画面を開いてください',
  more: 'ほか {n} 件は libretto のお知らせ欄で見られます',
} as const
export const SLACK_DM_HOLD_MS = 2 * 60_000 // 2 分のあいだに出た知らせを 1 通に（6.8 (4)）
const MAX_LINES = 20 // 1 通に並べる行（落ちたホストの送り残しが溜まっても Slack の長さの上限に届かない）
const CALL_MS = 60_000

export type SlackDmState = ConnectionsView['slackDm']['state']

// mrkdwn で記号として読まれる 3 文字を逃がす（題に < > & が入りうる）
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// origin は Tailscale の HTTPS の起点。無ければリンクを付けない（127.0.0.1 はスマホで押すとスマホ自身を指す。6.8 (3)）
export function slackDmText(notices: Notice[], origin: string | undefined) {
  const lines = notices
    .slice(0, MAX_LINES)
    .map((n) => (origin ? `${esc(n.text)} <${origin}${n.path}|${SLACK_DM.open}>` : esc(n.text)))
  if (notices.length > MAX_LINES) lines.push(SLACK_DM.more.replace('{n}', String(notices.length - MAX_LINES)))
  if (!origin) lines.push(SLACK_DM.openApp)
  return lines.join('\n')
}

// 一時的な失敗（混んでいる・届かない・入れ直しの途中）は送り直す。それ以外は設定の画面に出す状態
const failure = (r: SlackFail): SlackDmState | 'retry' =>
  r.why === 'auth_expired'
    ? 'rejected'
    : r.why === 'rejected'
      ? r.error === 'missing_scope'
        ? 'missingScope'
        : 'rejected'
      : 'retry'

export function createSlackDm(o: { bot: Slack; user: Slack; origin?: string | undefined; changed?: () => void }) {
  let state: SlackDmState = 'unchecked'
  let gen = 0 // 後から始めた確かめ・送った結果が勝つ
  const set = (s: SlackDmState) => {
    if (s === state) return
    state = s
    o.changed?.()
  }

  // 送り先は取り込みのユーザートークンの本人。無い・受け付けない → noUser。入れ直しの途中・届かない → 送り直し
  async function who(signal: AbortSignal): Promise<string | 'noUser' | 'retry'> {
    if (!o.user.configured()) return 'noUser'
    const r = await o.user.whoami(signal)
    if (r.ok) return r.me.userId
    return r.why === 'auth_expired' || r.why === 'rejected' ? 'noUser' : 'retry'
  }

  async function probe(signal: AbortSignal): Promise<SlackDmState> {
    if (!o.bot.configured()) return 'none'
    const r = await o.bot.call('auth.test', {}, signal)
    if (!r.ok) {
      const f = failure(r)
      return f === 'retry' ? 'unchecked' : f
    }
    const scopes = r.headers.get('x-oauth-scopes')
    if (scopes !== null && !scopes.split(',').some((s) => s.trim() === 'chat:write')) return 'missingScope'
    const u = await who(signal)
    return u === 'retry' ? 'unchecked' : u === 'noUser' ? 'noUser' : 'on'
  }

  const send: Sender = async (_target, notices) => {
    const g = ++gen
    // 送っているあいだに始めた確かめの結果は上書きしない
    const settle = (s: SlackDmState) => g === gen && set(s)
    if (!o.bot.configured()) {
      settle('none')
      return 'gone'
    }
    const signal = AbortSignal.timeout(CALL_MS)
    const u = await who(signal)
    if (u === 'retry') return 'retry'
    if (u === 'noUser') {
      settle('noUser')
      return 'gone'
    }
    const r = await o.bot.call(
      'chat.postMessage',
      { channel: u, text: slackDmText(notices, o.origin), unfurl_links: 'false', unfurl_media: 'false' },
      signal,
    )
    if (r.ok) {
      settle('on')
      return 'sent'
    }
    const f = failure(r)
    if (f === 'retry') return 'retry'
    settle(f)
    return 'gone'
  }

  return {
    send,
    state: (): SlackDmState => (o.bot.configured() ? state : 'none'),
    // ボット・ユーザーのどちらかのトークンを入れた・消したとき、起動のとき
    async check() {
      const g = ++gen
      let s: SlackDmState = 'unchecked'
      try {
        s = await probe(AbortSignal.timeout(CALL_MS))
      } catch {}
      if (g === gen) set(s)
    },
  }
}
