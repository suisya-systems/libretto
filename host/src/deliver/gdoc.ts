// Google ドキュメント・スプレッドシート・スライドの届け先（docs/implementation.md 6.5 (6)・6.8 (4)）。
// docx / xlsx / pptx を変換付きで作り、書き出して読み戻し照合する。
// 作成を送る前に印を書き、印のある attempt は二度と作らずに探して確かめる（作成が届いたか分からないまま再起動しても二度作らない）
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseRecord, DeliveryRecord } from '@libretto/shared/ledger'
import { roundTrip, sheetsMatch } from '../checks/judgeable.ts'
import type { Google, GoogleFail } from '../intake/google.ts'
import { caseDir } from '../ledger/db.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { writeAtomic } from '../roles/entrance.ts'
import { draftNames, versionDir } from '../roles/maker.ts'
import { exportedText } from './docx.ts'
import { pptxText } from './pptx.ts'
import { xlsxSheets } from './xlsx.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const CALL_MS = 60_000
export const UNKNOWN_LIMIT = 3 // 不明の行がこの数になった後の周期でも見つからなければ失敗（4.6 (5)）

export const GDOC_SAY = {
  notLinked: 'Google ドキュメントに保存できる連携がありません',
  rejected: 'Google ドライブが保存を受け付けませんでした',
  driveDisabled:
    'Google Drive API が有効になっていないため、保存できませんでした。Google Cloud のコンソールで、連携に使っているプロジェクトの「Google Drive API」を有効にしてから、もう一度送ってください',
  notFound: '保存した文書が 3 回探しても確かめられませんでした',
  mismatch: (missing: number, extra: number) =>
    `保存した文書の本文が元の本文と食い違っています（欠けた段落 ${missing}・増えた段落 ${extra}）`,
} as const

// 種類ごとの違い（6.8 (4)）: 変換先・上げる中身・書き出しの形・照合と食い違いの文
type Kind = 'gdoc' | 'gsheet' | 'gslide'
type Check = { ok: true } | { ok: false; reason: string }
const KIND: Record<
  Kind,
  {
    google: string
    upload: string
    export: string
    as: 'text' | 'bytes'
    say: { notLinked?: string; notFound?: string }
    check: (md: string, got: string | Buffer) => Check
  }
> = {
  gdoc: {
    google: 'application/vnd.google-apps.document',
    upload: DOCX,
    export: 'text/html',
    as: 'text',
    say: {},
    check: (md, got) => {
      const r = roundTrip(md, exportedText(got as string))
      return r.units[0] ? { ok: true } : { ok: false, reason: GDOC_SAY.mismatch(r.measured.missing, r.measured.extra) }
    },
  },
  gsheet: {
    google: 'application/vnd.google-apps.spreadsheet',
    upload: XLSX,
    export: XLSX,
    as: 'bytes',
    say: {
      notLinked: 'Google スプレッドシートに保存できる連携がありません',
      notFound: '保存した表が 3 回探しても確かめられませんでした',
    },
    check: (md, got) => {
      const r = sheetsMatch(md, xlsxSheets(got as Buffer))
      return r.units[0]
        ? { ok: true }
        : {
            ok: false,
            reason: `保存した表が元の表と食い違っています（食い違ったセル ${r.measured.cells}・数の合わない表 ${r.measured.tables}・エラーのセル ${r.measured.errors}）`,
          }
    },
  },
  gslide: {
    google: 'application/vnd.google-apps.presentation',
    upload: PPTX,
    export: PPTX,
    as: 'bytes',
    say: {
      notLinked: 'Google スライドに保存できる連携がありません',
      notFound: '保存したスライドが 3 回探しても確かめられませんでした',
    },
    check: (md, got) => {
      const r = roundTrip(md, pptxText(got as Buffer))
      return r.units[0]
        ? { ok: true }
        : {
            ok: false,
            reason: `保存したスライドの字が元の本文と食い違っています（欠けた段落 ${r.measured.missing}・増えた段落 ${r.measured.extra}）`,
          }
    },
  },
}

type File = { id: string; webViewLink?: string; shared?: boolean }
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

const quote = (s: string) => s.replace(/['\\]/g, '\\$&')
const byProp = (key: string, value: string) =>
  `appProperties has { key='${key}' and value='${quote(value)}' } and trashed=false`

async function search(
  g: Google,
  q: string,
  signal: AbortSignal,
  keep: (f: File) => boolean = () => true,
): Promise<File | undefined | GoogleFail> {
  let page: string | undefined
  do {
    const p = new URLSearchParams({ q, spaces: 'drive', fields: 'nextPageToken,files(id,webViewLink,shared)' })
    if (page) p.set('pageToken', page)
    const r = await within(signal, (s) =>
      g.drive<{ files?: File[]; nextPageToken?: string }>(`/drive/v3/files?${p}`, {}, s),
    )
    if (!r.ok) return r
    const f = r.json.files?.find(keep)
    if (f) return f
    page = r.json.nextPageToken
  } while (page)
  return undefined
}

// 保存先のフォルダ「libretto」（6.5 (3)）。覚えた id が今の連携のアカウントのもので、消されておらず共有もされていなければ
// それを使い、無ければ libretto が作った共有されていないフォルダを印で探し、それも無ければ作る。
// 共有されたフォルダの中に作ると「あなただけ」で承認したものがほかの人に見える。drive.file では本人が手で作った同名のフォルダは見えない
const FOLDER = 'application/vnd.google-apps.folder'
export const FOLDER_NAME = 'libretto'
// 案件をまたいで同時に初めて保存してもフォルダが 2 つにならないよう、アカウントごとに 1 本にまとめる。
// まとめた仕事は呼んだ案件の停止に巻き込まない（呼び出しごとの時間切れだけ）
const resolving = new Map<string, Promise<string | GoogleFail>>()
export function libFolder(d: Pick<Deps, 'home' | 'google'>, signal: AbortSignal): Promise<string | GoogleFail> {
  const key = `${d.home}\n${d.google.status().email ?? ''}`
  let p = resolving.get(key)
  if (!p) {
    p = findOrMakeFolder(d, new AbortController().signal).finally(() => resolving.delete(key))
    resolving.set(key, p)
  }
  return signal.aborted ? Promise.reject(signal.reason) : p
}
async function findOrMakeFolder(d: Pick<Deps, 'home' | 'google'>, signal: AbortSignal): Promise<string | GoogleFail> {
  const path = join(d.home, 'drive-folder.json')
  const account = d.google.status().email ?? ''
  const saved = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as { account: string; id: string })
    : undefined
  if (saved?.account === account) {
    const r = await within(signal, (s) =>
      d.google.drive<{ trashed?: boolean; shared?: boolean }>(
        `/drive/v3/files/${encodeURIComponent(saved.id)}?fields=id,trashed,shared`,
        {},
        s,
      ),
    )
    if (r.ok && !r.json.trashed && !r.json.shared) return saved.id
    if (!r.ok && r.why !== 'rejected') return r // 404（消された）だけ作り直す。届かないときは次の周期
  }
  const found = await search(
    d.google,
    `${byProp('librettoFolder', '1')} and mimeType='${FOLDER}'`,
    signal,
    (f) => !f.shared,
  )
  let id = found && 'id' in found ? found.id : undefined
  if (found && !('id' in found)) return found
  if (!id) {
    const r = await within(signal, (s) =>
      d.google.drive<File>(
        '/drive/v3/files?fields=id',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({
            name: FOLDER_NAME,
            mimeType: FOLDER,
            parents: ['root'],
            appProperties: { librettoFolder: '1' },
          }),
        },
        s,
      ),
    )
    if (!r.ok) return r
    id = r.json.id
  }
  writeAtomic(path, `${JSON.stringify({ account, id })}\n`)
  return id
}

function upload(g: Google, c: CaseRecord, a: DeliveryRecord, folderId: string, body0: Buffer, signal: AbortSignal) {
  const k = KIND[a.target.kind as Kind]
  const meta = {
    name: `${c.title}（第 ${a.version} 版）`,
    mimeType: k.google,
    parents: [folderId],
    appProperties: { librettoAttempt: a.attemptId },
  }
  const b = `libretto-${randomBytes(12).toString('hex')}`
  const body = Buffer.concat([
    Buffer.from(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${k.upload}\r\n\r\n`,
    ),
    body0,
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

// 送付中の Google の attempt 1 つ（gdoc・gsheet・gslide）。recheck は「探し直す」周期（不明の attempt はこのときだけ見る。6.5 (7)）。
// 何もしないときは undefined（不明のまま次の周期を待つ）
export async function deliverGoogle(
  d: Deps,
  c: CaseRecord,
  a: DeliveryRecord,
  file: Buffer,
  signal: AbortSignal,
  recheck: boolean,
): Promise<GdocEvent | undefined> {
  const base: Base = { caseId: c.caseId, by: 'libretto', attemptId: a.attemptId }
  const id = (type: string) => `${c.caseId}:${type}:${a.attemptId}`
  const path = markerPath(d.home, c.caseId, a.attemptId)
  let marker = readMarker(path)
  const k = KIND[a.target.kind as Kind]
  const say = { ...GDOC_SAY, ...k.say }
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
    if (k >= UNKNOWN_LIMIT) return failed(say.notFound, marker?.link)
    return {
      ...base,
      type: 'delivery.unknown',
      eventId: `${id('delivery.unknown')}:${k + 1}`,
      ...(marker?.link && { link: marker.link }),
    }
  }

  if (a.status === '不明' && !recheck) return undefined
  if (!marker) {
    // 印が無ければ作成を送っていない（不明でも、フォルダが用意できなかった周期の後なので作ってよい）。
    // 作っていないことが確かなので、連携が無ければ不明にせず失敗
    const st = d.google.status()
    if (st.state !== 'connected' || !st.docs) return failed(say.notLinked)
    const target = 'folderId' in a.target ? a.target.folderId : FOLDER_NAME
    const folder = target === FOLDER_NAME ? await libFolder(d, signal) : target
    if (typeof folder !== 'string')
      // 断られたら作れない。届かないなどは次の周期にもう一度（フォルダが用意できない周期も数える。6.5 (7)）
      return folder.why === 'api_disabled'
        ? failed(GDOC_SAY.driveDisabled)
        : folder.why === 'rejected' || folder.why === 'rate_limited'
          ? failed(GDOC_SAY.rejected)
          : miss()
    if (signal.aborted) return undefined
    writeAtomic(path, '{}\n')
    marker = {}
    const r = await upload(d.google, c, a, folder, file, signal)
    if (!r.ok) {
      // 応答で断られたものは作られていない。届かない・時間切れ・連携の切れ目は作られたか分からない
      if (r.why === 'api_disabled') return failed(GDOC_SAY.driveDisabled)
      if (r.why === 'rejected' || r.why === 'rate_limited') return failed(GDOC_SAY.rejected)
      return miss()
    }
    marker = { fileId: r.json.id, ...(r.json.webViewLink && { link: r.json.webViewLink }) }
    writeAtomic(path, `${JSON.stringify(marker)}\n`)
  } else if (!marker.fileId) {
    const f = await search(d.google, byProp('librettoAttempt', a.attemptId), signal)
    if (!f || !('id' in f)) return miss()
    marker = { fileId: f.id, ...(f.webViewLink && { link: f.webViewLink }) }
    writeAtomic(path, `${JSON.stringify(marker)}\n`)
  }

  const fileId = marker.fileId as string
  const link = marker.link
  const got = await within(signal, (s) =>
    d.google.drive<string | Buffer>(
      `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(k.export)}`,
      {},
      s,
      k.as,
    ),
  )
  if (!got.ok) return miss()
  const md = readFileSync(join(versionDir(d.home, c.caseId, a.version), draftNames(a.version).md), 'utf-8')
  const r = k.check(md, got.json)
  if (r.ok)
    return {
      ...base,
      type: 'delivery.done',
      eventId: id('delivery.done'),
      receiptId: `${a.target.kind}:${fileId}`,
      ...(link && { link }),
    }
  return {
    ...base,
    type: 'delivery.mismatch',
    eventId: id('delivery.mismatch'),
    reason: r.reason,
    ...(link && { link }),
  }
}
