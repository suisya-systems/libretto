// 出典の取り寄せ fetchSource（docs/implementation.md 6.3・6.3.1 (5)）。http / https だけ。手元の網には出ない
import { createHash } from 'node:crypto'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { decode } from '../checks/text.ts'

export type Fetched = { ok: true; url: string; title: string; paragraphs: string[]; fingerprint: string }
export type FetchFailure = {
  ok: false
  why: 'network' | 'timeout' | 'refused' | 'unsupported' | 'blocked'
}

export const FETCH_LIMITS = { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, redirects: 3 }

// ループバック・プライベート・リンクローカル・CGNAT・マルチキャスト・未指定と予約、IPv4 射影・NAT64・6to4（6.3.1 (5)）。
// v4 と v6 は別の表（1 つの表に ::ffff:0:0/96 を入れると、v4 の検査にも当たる）
const DENY = new BlockList()
const DENY6 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // マルチキャストと予約（224〜255）
] as const)
  DENY.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 96], // 未指定・ループバック・IPv4 互換
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  DENY6.addSubnet(net, bits, 'ipv6')

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (!family) return true
  return family === 4 ? DENY.check(ip, 'ipv4') : DENY6.check(ip, 'ipv6')
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// --- HTML → 題と段落。ponytail: 正規表現の簡易な取り出し。ナビやフッターも段落に残る。困ったら本文の抽出を入れる

const DROPPED = 'script|style|noscript|template|svg|head|title|iframe|object|select|textarea'
const DROP = new RegExp(`<(${DROPPED})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi')
// 先頭 2 MB で切ったとき、閉じていない要素は末尾まで捨てる（中身を段落にしない。6.3.3 (5)）。
// head は閉じタグを省けるので入れない
const DROP_OPEN = new RegExp(`<(${DROPPED.replace('|head', '')})\\b[\\s\\S]*$`, 'i')
const BLOCK =
  /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|nav|aside|main|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi

export function htmlText(html: string): { title: string; paragraphs: string[] } {
  const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const body = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '') // 先頭 2 MB で切れた閉じていない注釈も捨てる
    .replace(DROP, '')
    .replace(DROP_OPEN, '')
    .replace(BLOCK, '\n\n')
    .replace(/<[^>]*>/g, '')
  return { title, paragraphs: textParagraphs(decode(body)) }
}

export const textParagraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

// --- 取り寄せ

type Options = {
  blocked?: (ip: string) => boolean // テストだけがループバックを許す。設定や環境変数からは変えない
  signal?: AbortSignal
  timeoutMs?: number
}

export async function fetchSource(url: string, o: Options = {}): Promise<Fetched | FetchFailure> {
  const blocked = o.blocked ?? isBlockedAddress
  const signals = [AbortSignal.timeout(o.timeoutMs ?? FETCH_LIMITS.timeoutMs), ...(o.signal ? [o.signal] : [])]
  const signal = AbortSignal.any(signals)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, why: 'unsupported' }
  }
  for (let hop = 0; hop <= FETCH_LIMITS.redirects; hop++) {
    const r = await getOnce(u, blocked, signal)
    if (r.kind === 'fail') return { ok: false, why: r.why }
    if (r.kind === 'redirect') {
      try {
        u = new URL(r.location, u)
      } catch {
        return { ok: false, why: 'refused' }
      }
      continue
    }
    const text = r.html ? htmlText(r.body) : { title: '', paragraphs: textParagraphs(r.body) }
    if (!text.paragraphs.length) return { ok: false, why: 'refused' }
    return {
      ok: true,
      url: u.href,
      title: text.title,
      paragraphs: text.paragraphs,
      fingerprint: sha256(text.paragraphs.join('\n')),
    }
  }
  return { ok: false, why: 'refused' } // リダイレクトが多すぎる
}

type Once =
  | { kind: 'fail'; why: FetchFailure['why'] }
  | { kind: 'redirect'; location: string }
  | { kind: 'body'; body: string; html: boolean }

function getOnce(u: URL, blocked: (ip: string) => boolean, signal: AbortSignal): Promise<Once> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.resolve({ kind: 'fail', why: 'unsupported' })
  const host = u.hostname.replace(/^\[|\]$/g, '')
  // IP の字面は lookup を通らないので、ここで見る
  if (isIP(host) && blocked(host)) return Promise.resolve({ kind: 'fail', why: 'blocked' })
  let refused = false
  // 名前は全部のアドレスを引き、1 つでも手元なら拒む。接続は検査したアドレスに固定する
  const lookup = (
    hostname: string,
    options: { all?: boolean },
    cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) =>
    dnsLookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err, [])
      const first = addrs[0]
      if (!first || addrs.some((a) => blocked(a.address))) {
        refused = true
        return cb(Object.assign(new Error(`blocked ${hostname}`), { code: 'EBLOCKED' }), [])
      }
      return options.all ? cb(null, [first]) : cb(null, first.address, first.family)
    })
  const request = u.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    let req: ReturnType<typeof request>
    try {
      req = request(
        u,
        {
          lookup: lookup as never,
          signal,
          headers: { accept: 'text/html,text/plain', 'accept-encoding': 'identity', 'user-agent': 'libretto' },
        },
        (res) => onResponse(res, resolve),
      )
    } catch {
      // URL の資格情報が読めないなど、要求を作る前に投げる形（6.3.1 (5)）
      return resolve({ kind: 'fail', why: 'unsupported' })
    }
    req.on('error', () => resolve({ kind: 'fail', why: refused ? 'blocked' : signal.aborted ? 'timeout' : 'network' }))
    req.end()
  })
}

function onResponse(res: IncomingMessage, resolve: (o: Once) => void) {
  const status = res.statusCode ?? 0
  // 使わない本文は読まずに切る（大きさの上限の外で読み続けない）
  if (status >= 300 && status < 400 && res.headers.location) {
    res.destroy()
    return resolve({ kind: 'redirect', location: res.headers.location })
  }
  if (status !== 200) {
    res.destroy()
    return resolve({ kind: 'fail', why: 'refused' })
  }
  const type = res.headers['content-type'] ?? ''
  const html = /^text\/html\b/i.test(type)
  if (!html && !/^text\/plain\b/i.test(type)) {
    res.destroy()
    return resolve({ kind: 'fail', why: 'unsupported' })
  }
  const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8'
  const chunks: Buffer[] = []
  let size = 0
  const done = () => {
    let decoder: TextDecoder
    try {
      decoder = new TextDecoder(charset)
    } catch {
      decoder = new TextDecoder('utf-8')
    }
    resolve({ kind: 'body', body: decoder.decode(Buffer.concat(chunks)), html })
  }
  // 上限を超えたら先頭の 2 MB だけを読んで切る（公式の更新履歴は大きく、新しいものが頭にある。6.3.3 (5)）
  res.on('data', (c: Buffer) => {
    const room = FETCH_LIMITS.maxBytes - size
    size += c.length
    if (size <= FETCH_LIMITS.maxBytes) return void chunks.push(c)
    chunks.push(c.subarray(0, room))
    res.destroy()
    done()
  })
  res.on('error', () => resolve({ kind: 'fail', why: 'network' }))
  res.on('end', done)
}
