// Gmail の合図と自動検出の読み取り（docs/implementation.md 6.4 (3)・6.9 (5)）。添付は中身を読まず名前だけ。本文はメモリで渡して捨てる
import { jst } from '../ledger/ledger.ts'
import type { Google, GoogleFail } from './google.ts'

const MAX_BODY = 20_000
const U = '/gmail/v1/users/me'

type Header = { name: string; value: string }
export type Part = {
  mimeType?: string
  filename?: string
  headers?: Header[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Part[]
}
export type RawThread = {
  id: string
  historyId?: string
  messages?: { id: string; internalDate?: string; labelIds?: string[]; payload?: Part }[]
}

export type Thread = {
  threadId: string
  subject: string
  from: string // 表示名
  senderKey: string // アドレスの小文字（見送りの学習の鍵）
  receivedAt: string
  link: string
  body: string // 保存しない
  latest: string // 最新のメッセージの本文（Jev に先頭だけ渡す。6.9 (3)）。保存しない
  attachments: string[]
  historyId?: string
  self: boolean // 本人が始めたスレッド
  bulk: boolean // 最初のメッセージが自動送信（List-Unsubscribe・Auto-Submitted・Precedence。6.9 (2)）
  toMe: boolean // どれかのメッセージの To / Cc に本人
  primary: boolean // 受信箱のメイン（INBOX と CATEGORY_PERSONAL）
  lastMs: number
}

export async function labelId(g: Google, name: string, signal: AbortSignal) {
  const r = await g.get<{ labels?: { id: string; name: string }[] }>(`${U}/labels`, signal)
  if (!r.ok) return r
  return { ok: true as const, id: r.json.labels?.find((l) => l.name === name)?.id }
}

// 最後のページまでたどる（打ち切ると、毎回同じ先頭だけを見ることになる。6.4 (3)）。新しい順で返る
export async function threadIds(g: Google, label: string, signal: AbortSignal) {
  const ids: string[] = []
  let page: string | undefined
  do {
    const q = new URLSearchParams({ labelIds: label, maxResults: '500', ...(page && { pageToken: page }) })
    const r = await g.get<{ threads?: { id: string }[]; nextPageToken?: string }>(`${U}/threads?${q}`, signal)
    if (!r.ok) return r
    for (const t of r.json.threads ?? []) ids.push(t.id)
    page = r.json.nextPageToken
  } while (page)
  return { ok: true as const, ids }
}

// 自動検出の窓（6.9 (5)）。最後のページまで（10 ページ = 5,000 件で打ち切る）。新しい順で返る
export async function inboxThreads(g: Google, q: string, signal: AbortSignal) {
  const threads: { id: string; historyId?: string }[] = []
  let page: string | undefined
  for (let i = 0; i < 10; i++) {
    const p = new URLSearchParams({ q, maxResults: '500', ...(page && { pageToken: page }) })
    const r = await g.get<{ threads?: { id: string; historyId?: string }[]; nextPageToken?: string }>(
      `${U}/threads?${p}`,
      signal,
    )
    if (!r.ok) return r
    threads.push(...(r.json.threads ?? []))
    page = r.json.nextPageToken
    if (!page) break
  }
  return { ok: true as const, threads }
}

export async function readThread(
  g: Google,
  threadId: string,
  account: string,
  signal: AbortSignal,
): Promise<{ ok: true; thread: Thread } | GoogleFail> {
  const r = await g.get<RawThread>(`${U}/threads/${encodeURIComponent(threadId)}?format=full`, signal)
  return r.ok ? { ok: true, thread: parseThread(r.json, account) } : r
}

const header = (p: Part | undefined, name: string) =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
// 部分の Content-Type の charset で読む（ISO-2022-JP・Shift_JIS など）。TextDecoder が知らない名前は UTF-8
function decode(p: Part, data: string) {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(header(p, 'Content-Type'))?.[1] ?? 'utf-8'
  let d: TextDecoder
  try {
    d = new TextDecoder(charset)
  } catch {
    d = new TextDecoder('utf-8')
  }
  return d.decode(Buffer.from(data, 'base64url'))
}
const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

// 名前のある部分と attachment の部分は、その下ごと本文から外す（body.data に中身が入っていても読まない。6.4 (3)）
function walk(p: Part, out: { plain: string[]; html: string[]; attachments: string[] }) {
  const disposition = header(p, 'Content-Disposition').toLowerCase()
  if (p.filename || disposition.startsWith('attachment')) {
    out.attachments.push(p.filename || '名前のない添付')
    return
  }
  if (p.parts) for (const c of p.parts) walk(c, out)
  else if (p.body?.data && p.mimeType === 'text/plain') out.plain.push(decode(p, p.body.data))
  else if (p.body?.data && p.mimeType === 'text/html') out.html.push(stripHtml(decode(p, p.body.data)))
}

export function parseFrom(v: string): { name: string; key: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v)
  const address = (m?.[2] ?? v).trim().toLowerCase()
  return { name: m?.[1]?.trim() || address, key: address }
}

export function parseThread(raw: RawThread, account: string): Thread {
  const messages = raw.messages ?? []
  const first = messages[0]?.payload
  const from = parseFrom(header(first, 'From'))
  const bodies: string[] = []
  const attachments: string[] = []
  let latest = ''
  for (const m of messages) {
    const out = { plain: [] as string[], html: [] as string[], attachments }
    if (m.payload) walk(m.payload, out)
    const text = (out.plain.length ? out.plain : out.html).join('\n').trim()
    if (text) bodies.push(text)
    latest = text
  }
  const last = Number(messages.at(-1)?.internalDate ?? 0)
  const me = account.toLowerCase()
  const auto = header(first, 'Auto-Submitted').trim().toLowerCase()
  return {
    threadId: raw.id,
    subject: header(first, 'Subject').trim() || '（件名なし）',
    from: from.name,
    senderKey: from.key,
    receivedAt: jst(new Date(last)),
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#all/${raw.id}`,
    body: bodies.join('\n\n---\n\n').slice(0, MAX_BODY),
    latest,
    attachments: [...new Set(attachments)],
    ...(raw.historyId && { historyId: raw.historyId }),
    self: !!me && from.key === me,
    bulk:
      !!header(first, 'List-Unsubscribe') ||
      (!!auto && auto !== 'no') ||
      /^(bulk|list|junk)$/i.test(header(first, 'Precedence').trim()),
    toMe:
      !!me &&
      messages.some((m) =>
        ['To', 'Cc'].some((h) =>
          header(m.payload, h)
            .split(',')
            .some((a) => parseFrom(a).key === me),
        ),
      ),
    primary: messages.some((m) => m.labelIds?.includes('INBOX') && m.labelIds.includes('CATEGORY_PERSONAL')),
    lastMs: last,
  }
}
