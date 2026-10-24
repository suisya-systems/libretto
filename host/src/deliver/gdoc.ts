// Google ドキュメントの届け先（docs/implementation.md 6.5 (6)）。docx を変換付きで作り、書き出して読み戻し照合する。
// 作成を送る前に印を書き、印のある attempt は二度と作らずに探して確かめる（作成が届いたか分からないまま再起動しても二度作らない）
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseRecord, DeliveryRecord } from '@libretto/shared/ledger'
import { roundTrip } from '../checks/judgeable.ts'
import type { Google, GoogleFail } from '../intake/google.ts'
import { caseDir } from '../ledger/db.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { writeAtomic } from '../roles/entrance.ts'
import { draftNames, versionDir } from '../roles/maker.ts'
import { exportedText } from './docx.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const CALL_MS = 60_000
export const UNKNOWN_LIMIT = 3 // 不明の行がこの数になった後の周期でも見つからなければ失敗（4.6 (5)）

export const GDOC_SAY = {
  notLinked: 'Google ドキュメントに保存できる連携がありません',
  rejected: 'Google ドライブが保存を受け付けませんでした',
  notFound: '保存した文書が 3 回探しても確かめられませんでした',
  mismatch: (missing: number, extra: number) =>
    `保存した文書の本文が元の本文と食い違っています（欠けた段落 ${missing}・増えた段落 ${extra}）`,
} as const

type File = { id: string; webViewLink?: string }
type Marker = { fileId?: string; link?: string }
type Deps = { home: string; ledger: Ledger; google: Google }
type Base = { caseId: string; by: 'libretto'; attemptId: string }
export type GdocEvent =
  | (Base & { type: 'delivery.done'; eventId: string; receiptId: string; link?: string })
  | (Base & { type: 'delivery.mismatch'; eventId: string; link?: string; reason: string })
  | (Base & { type: 'delivery.unknown'; eventId: string; link?: string })
  | (Base & { type: 'delivery.failed'; eventId: string; reason: string; link?: string })

const markerPath = (home: string, caseId: string, attemptId: string) =>
  join(caseDir(home, caseId), 'deliveries', `${encodeURIComponent(attemptId)}.json`)
const readMarker = (path: string): Marker | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Marker) : undefined

// 呼び出し 1 回の時間切れ。止めた（signal）ときは投げ、時間切れは届かなかったとして返す
async function within<T>(signal: AbortSignal, f: (s: AbortSignal) => Promise<T | GoogleFail>): Promise<T | GoogleFail> {
  try {
    return await f(AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]))
  } catch (e) {
    if (signal.aborted) throw e
    return { ok: false, why: 'network' }
  }
}

async function search(g: Google, attemptId: string, signal: AbortSignal): Promise<File | undefined | GoogleFail> {
  const q = `appProperties has { key='librettoAttempt' and value='${attemptId.replace(/['\\]/g, '\\$&')}' } and trashed=false`
  let page: string | undefined
  do {
    const p = new URLSearchParams({ q, spaces: 'drive', fields: 'nextPageToken,files(id,webViewLink)' })
    if (page) p.set('pageToken', page)
    const r = await within(signal, (s) =>
      g.drive<{ files?: File[]; nextPageToken?: string }>(`/drive/v3/files?${p}`, {}, s),
    )
    if (!r.ok) return r
    const f = r.json.files?.[0]
    if (f) return f
    page = r.json.nextPageToken
  } while (page)
  return undefined
}

function upload(g: Google, c: CaseRecord, a: DeliveryRecord, docx: Buffer, signal: AbortSignal) {
  const folderId = a.target.kind === 'gdoc' ? a.target.folderId : 'root'
  const meta = {
    name: `${c.title}（第 ${a.version} 版）`,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
    appProperties: { librettoAttempt: a.attemptId },
  }
  const b = `libretto-${randomBytes(12).toString('hex')}`
  const body = Buffer.concat([
    Buffer.from(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${DOCX}\r\n\r\n`,
    ),
    docx,
    Buffer.from(`\r\n--${b}--\r\n`),
  ])
  return within(signal, (s) =>
    g.drive<File>(
      '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${b}` }, body },
      s,
    ),
  )
}

// 送付中の gdoc の attempt 1 つ。recheck は「探し直す」周期（不明の attempt はこのときだけ見る。6.5 (7)）。
// 何もしないときは undefined（不明のまま次の周期を待つ）
export async function deliverGdoc(
  d: Deps,
  c: CaseRecord,
  a: DeliveryRecord,
  docx: Buffer,
  signal: AbortSignal,
  recheck: boolean,
): Promise<GdocEvent | undefined> {
  const base: Base = { caseId: c.caseId, by: 'libretto', attemptId: a.attemptId }
  const id = (type: string) => `${c.caseId}:${type}:${a.attemptId}`
  const path = markerPath(d.home, c.caseId, a.attemptId)
  let marker = readMarker(path)
  const failed = (reason: string, link?: string): GdocEvent => ({
    ...base,
    type: 'delivery.failed',
    eventId: id('delivery.failed'),
    reason,
    ...(link && { link }),
  })
  // 見つからない・確かめられない周期。不明の行が UNKNOWN_LIMIT になった後なら失敗（作ったと分かっていればリンクを残す）
  const miss = (): GdocEvent => {
    const k = d.ledger.listDeliveries(c.caseId).filter((x) => x.attemptId === a.attemptId && x.status === '不明').length
    if (k >= UNKNOWN_LIMIT) return failed(GDOC_SAY.notFound, marker?.link)
    return {
      ...base,
      type: 'delivery.unknown',
      eventId: `${id('delivery.unknown')}:${k + 1}`,
      ...(marker?.link && { link: marker.link }),
    }
  }

  if (a.status === '不明' && !recheck) return undefined
  if (!marker) {
    if (a.status !== '送付中') return miss() // 印が無いまま不明は無い（念のため）
    // 作る前に確かめる。作っていないことが確かなので、連携が無ければ不明にせず失敗
    const st = d.google.status()
    if (st.state !== 'connected' || !st.docs) return failed(GDOC_SAY.notLinked)
    if (signal.aborted) return undefined
    writeAtomic(path, '{}\n')
    marker = {}
    const r = await upload(d.google, c, a, docx, signal)
    if (!r.ok) {
      // 応答で断られたものは作られていない。届かない・時間切れ・連携の切れ目は作られたか分からない
      if (r.why === 'rejected' || r.why === 'rate_limited') return failed(GDOC_SAY.rejected)
      return miss()
    }
    marker = { fileId: r.json.id, ...(r.json.webViewLink && { link: r.json.webViewLink }) }
    writeAtomic(path, `${JSON.stringify(marker)}\n`)
  } else if (!marker.fileId) {
    const f = await search(d.google, a.attemptId, signal)
    if (!f || !('id' in f)) return miss()
    marker = { fileId: f.id, ...(f.webViewLink && { link: f.webViewLink }) }
    writeAtomic(path, `${JSON.stringify(marker)}\n`)
  }

  const fileId = marker.fileId as string
  const link = marker.link
  const html = await within(signal, (s) =>
    d.google.drive<string>(`/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/html`, {}, s, 'text'),
  )
  if (!html.ok) return miss()
  const md = readFileSync(join(versionDir(d.home, c.caseId, a.version), draftNames(a.version).md), 'utf-8')
  const r = roundTrip(md, exportedText(html.json))
  if (r.units[0])
    return {
      ...base,
      type: 'delivery.done',
      eventId: id('delivery.done'),
      receiptId: `gdoc:${fileId}`,
      ...(link && { link }),
    }
  return {
    ...base,
    type: 'delivery.mismatch',
    eventId: id('delivery.mismatch'),
    reason: GDOC_SAY.mismatch(r.measured.missing, r.measured.extra),
    ...(link && { link }),
  }
}
