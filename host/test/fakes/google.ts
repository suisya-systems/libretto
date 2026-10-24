// 偽の Google（docs/implementation.md 11.1・6.4 (8)・6.5 (10)）。OAuth のトークン・取り消しと Gmail の 4 口、
// Drive の 3 口（multipart の作成・appProperties の検索・HTML の書き出し）をプロセス内の HTTP で受け、受けた要求を記録する。
// テストは「添付の口を呼んでいない」をこの記録で確かめる
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { docxText } from '../../src/deliver/docx.ts'
import type { Part, RawThread } from '../../src/intake/gmail.ts'
import type { GoogleEndpoints } from '../../src/intake/google.ts'

export type Seen = { method: string; path: string; body: string; auth?: string }

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url')

// 1 通のメッセージ。text は本文、attachments は名前と中身（中身は body.data に入れて返す。添付の中身が混ざらないことを試す）
export function message(o: {
  id: string
  from: string
  subject?: string
  text?: string
  html?: string
  at: number
  attachments?: { name: string; text: string; inline?: boolean }[]
}): NonNullable<RawThread['messages']>[number] {
  const parts: Part[] = []
  if (o.text !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64(o.text) } })
  if (o.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64(o.html) } })
  for (const a of o.attachments ?? [])
    parts.push(
      a.inline
        ? // 名前は無いが attachment の部分（Content-Disposition だけで分かる）
          {
            mimeType: 'text/plain',
            headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }],
            body: { data: b64(a.text) },
          }
        : { mimeType: 'text/plain', filename: a.name, body: { data: b64(a.text), attachmentId: `att-${a.name}` } },
    )
  return {
    id: o.id,
    internalDate: String(o.at),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: o.from },
        { name: 'Subject', value: o.subject ?? '' },
      ],
      parts,
    },
  }
}

export type DriveFile = {
  id: string
  name: string
  parents: string[]
  appProperties: Record<string, string>
  docx: Buffer
  mimeType: string
  trashed?: boolean
}

// multipart/related の 2 つの部分（メタデータの JSON と中身）。中身はバイト列のまま
function multipart(body: Buffer, type: string): { meta: Record<string, unknown>; media: Buffer } {
  const b = Buffer.from(`--${/boundary=([^;]+)/.exec(type)?.[1]}`)
  const parts: Buffer[] = []
  let at = body.indexOf(b)
  while (at >= 0) {
    const next = body.indexOf(b, at + b.length)
    if (next < 0) break
    const part = body.subarray(at + b.length + 2, next - 2) // 区切りの後の CRLF と前の CRLF
    parts.push(part.subarray(part.indexOf('\r\n\r\n') + 4))
    at = next
  }
  return { meta: JSON.parse((parts[0] as Buffer).toString('utf-8')), media: parts[1] as Buffer }
}

export async function startFakeGoogle() {
  const seen: Seen[] = []
  const files = new Map<string, DriveFile>()
  const threads = new Map<string, RawThread>()
  const labels = [
    { id: 'INBOX', name: 'INBOX' },
    { id: 'Label_1', name: 'libretto' },
  ]
  const labeled = new Set<string>()
  const state = {
    email: 'me@example.com',
    pageSize: 500,
    valid: new Set<string>(),
    refresh: 'rt-1',
    invalidGrant: false,
    issued: 0,
    fail: undefined as undefined | { status: number; body?: string; times: number; path?: RegExp },
    revoked: [] as string[],
    refreshDelayMs: 0, // 更新トークンでの更新を遅らせる（解除と重なる場面を作る）
    bodyDelayMs: 0, // Gmail の応答の本文を、見出しの後に遅らせる（本文の受け取り中の解除を作る）
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file',
    createThenFail: 0, // 作成を受けてファイルを作った上で 500 を返す回数（作られたか分からない場面）
    dropParagraph: false, // 書き出しで最初の段落を落とす（読み戻しの不一致）
    exportFail: 0, // 書き出しを 500 にする回数
  }
  const issue = () => {
    const t = `at-${++state.issued}`
    state.valid.add(t)
    return t
  }

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const body = raw.toString('utf-8')
    const url = new URL(req.url ?? '/', 'http://x')
    const auth = req.headers.authorization
    seen.push({ method: req.method ?? '', path: url.pathname + url.search, body, ...(auth && { auth }) })
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      const s = JSON.stringify(v)
      if (!state.bodyDelayMs || !url.pathname.startsWith('/gmail')) return res.end(s)
      res.write(s.slice(0, 1))
      setTimeout(() => res.end(s.slice(1)), state.bodyDelayMs)
    }
    const f = state.fail
    if (f && f.times > 0 && (!f.path || f.path.test(url.pathname))) {
      f.times -= 1
      res.writeHead(f.status, { 'content-type': 'application/json' })
      res.end(f.body ?? '{}')
      return
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' })
        return json(200, {
          access_token: issue(),
          refresh_token: state.refresh,
          expires_in: 3600,
          scope: state.scope,
        })
      }
      if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs))
      if (state.invalidGrant || form.get('refresh_token') !== state.refresh)
        return json(400, { error: 'invalid_grant' })
      return json(200, { access_token: issue(), expires_in: 3600 })
    }
    if (url.pathname === '/revoke') {
      state.revoked.push(new URLSearchParams(body).get('token') ?? '')
      return json(200, {})
    }
    if (!auth || !state.valid.has(auth.replace(/^Bearer /, ''))) return json(401, { error: { code: 401 } })
    const pick = (f: DriveFile) => ({
      id: f.id,
      ...((url.searchParams.get('fields') ?? '').includes('webViewLink') && {
        webViewLink: `https://docs.google.com/document/d/${f.id}/edit`,
      }),
    })
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const { meta, media } = multipart(raw, req.headers['content-type'] ?? '')
      const f: DriveFile = {
        id: `doc-${files.size + 1}`,
        name: String(meta.name),
        parents: meta.parents as string[],
        appProperties: meta.appProperties as Record<string, string>,
        docx: media,
        mimeType: String(meta.mimeType),
      }
      files.set(f.id, f)
      if (state.createThenFail > 0) {
        state.createThenFail -= 1
        return json(500, { error: { code: 500 } })
      }
      return json(200, pick(f))
    }
    // フォルダの作成（メタデータだけ）
    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      const meta = JSON.parse(body) as Record<string, unknown>
      const f: DriveFile = {
        id: `folder-${files.size + 1}`,
        name: String(meta.name),
        parents: meta.parents as string[],
        appProperties: meta.appProperties as Record<string, string>,
        docx: Buffer.alloc(0),
        mimeType: String(meta.mimeType),
      }
      files.set(f.id, f)
      return json(200, pick(f))
    }
    if (url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? ''
      const [, k, v] = /key='([^']*)' and value='([^']*)'/.exec(q) ?? []
      const mime = /mimeType='([^']*)'/.exec(q)?.[1]
      const hit = [...files.values()].filter(
        (f) => !f.trashed && f.appProperties[k as string] === v && (!mime || f.mimeType === mime),
      )
      return json(200, { files: hit.map(pick) })
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const f = files.get(decodeURIComponent(one[1] as string))
      return f ? json(200, { id: f.id, trashed: !!f.trashed }) : json(404, { error: { code: 404 } })
    }
    const ex = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname)
    if (ex) {
      const f = files.get(decodeURIComponent(ex[1] as string))
      if (!f) return json(404, { error: { code: 404 } })
      if (state.exportFail > 0) {
        state.exportFail -= 1
        return json(500, { error: { code: 500 } })
      }
      // Google の書き出しに似せる: 段落ごとの p と span、リンクは google.com/url の転送、空の段落（リンクは字の無い段落に寄せる）
      const t = docxText(f.docx)
      const ps = (state.dropParagraph ? t.units.slice(1) : t.units).map(
        (u) => `<p class="c1"><span>${esc(u)}</span></p>`,
      )
      const as = t.links.map((l) => `<a href="https://www.google.com/url?q=${encodeURIComponent(l)}&amp;sa=D"></a>`)
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end(
        `<html><head><style>p{margin:0}</style></head><body><p class="c1"><span>${as.join('')}</span></p>${ps.join('')}</body></html>`,
      )
    }
    const p = url.pathname.replace('/gmail/v1/users/me', '')
    if (p === '/profile') return json(200, { emailAddress: state.email })
    if (p === '/labels') return json(200, { labels })
    if (p === '/threads') {
      const ids = [...threads.keys()].filter((id) => url.searchParams.get('labelIds') !== 'Label_1' || labeled.has(id))
      // 新しい順（最後のメッセージの時刻）
      ids.sort((a, b) => last(threads.get(b)) - last(threads.get(a)))
      const from = Number(url.searchParams.get('pageToken') ?? 0)
      const page = ids.slice(from, from + state.pageSize)
      const next = from + state.pageSize < ids.length ? String(from + state.pageSize) : undefined
      return json(200, { threads: page.map((id) => ({ id })), ...(next && { nextPageToken: next }) })
    }
    if (p.includes('/attachments/')) return json(200, { data: b64('添付の中身') })
    const m = /^\/threads\/([^/]+)$/.exec(p)
    const t = m && threads.get(decodeURIComponent(m[1] as string))
    if (t) return json(200, t)
    return json(404, { error: { code: 404 } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const endpoints: GoogleEndpoints = {
    auth: `${base}/auth`,
    token: `${base}/token`,
    revoke: `${base}/revoke`,
    gmail: base,
    drive: base,
  }
  return {
    endpoints,
    seen,
    state,
    files,
    labels,
    // ラベルの付いたスレッドを足す
    add(t: RawThread, label = true) {
      threads.set(t.id, t)
      if (label) labeled.add(t.id)
    },
    expireAll: () => state.valid.clear(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const last = (t: RawThread | undefined) => Number(t?.messages?.at(-1)?.internalDate ?? 0)
