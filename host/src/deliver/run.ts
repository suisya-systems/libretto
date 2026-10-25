// 仕立てと送付（docs/implementation.md 6.2.8 (1)(3)・6.5）。送付確認待ち・turn=libretto は仕立て → 形式の判定、
// 送付中・turn=libretto は今の送付回の attempt を順に送付済にする。仕事の起動と 1 案件 1 本は runner（case/runner.ts）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CaseRecord, VersionManifest } from '@libretto/shared/ledger'
import { currentSend, transition } from '../case/transition.ts'
import type { Google } from '../intake/google.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { writeAtomic } from '../roles/entrance.ts'
import { OUTPUT_FILES, type OutputFormat, outputOf } from '../roles/judge.ts'
import { draftNames, filesFingerprint, sha256, versionDir } from '../roles/maker.ts'
import { isStorageError } from '../server/stop.ts'
import { docxOf } from './docx.ts'
import { deliverGoogle } from './gdoc.ts'
import { pageDocument } from './page.ts'
import { pasteText } from './paste.ts'
import { pptxOf } from './pptx.ts'
import { htmlTables, xlsxOf } from './xlsx.ts'

const FORMATS = Object.keys(OUTPUT_FILES) as OutputFormat[]
const isFormat = (k: string): k is OutputFormat => (FORMATS as string[]).includes(k)
const readManifest = (path: string) => VersionManifest.parse(JSON.parse(readFileSync(path, 'utf-8')))

// versions/NN/outputs/ と outputs.json を書く。版のファイルと manifest.at は T12 の後に変わらないので、何度流しても同じ指紋。
// 成果物は形式ごとに 1 つ（Google の 3 つは手元のファイルと同じもの。6.10 (2)）
export function tailor(home: string, c: CaseRecord, now: Date): VersionManifest {
  const vdir = versionDir(home, c.caseId, c.version)
  const f = draftNames(c.version)
  const m = readManifest(join(vdir, 'manifest.json'))
  const html = () => readFileSync(join(vdir, f.html), 'utf-8')
  const files = [...new Set(c.destination.map(outputOf))]
    .map((format) => {
      const body =
        format === 'page'
          ? pageDocument(html(), { title: c.title, n: c.version, at: m.at })
          : format === 'docx'
            ? docxOf(html())
            : format === 'xlsx'
              ? xlsxOf(htmlTables(html()))
              : format === 'pptx'
                ? pptxOf(html())
                : pasteText(readFileSync(join(vdir, f.md), 'utf-8'))
      writeAtomic(join(vdir, 'outputs', OUTPUT_FILES[format]), body)
      return { path: OUTPUT_FILES[format], sha256: sha256(body), bytes: Buffer.byteLength(body) }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  const outputs = { n: c.version, at: now.toISOString(), files, fingerprint: filesFingerprint(files) }
  writeAtomic(join(vdir, 'outputs.json'), `${JSON.stringify(outputs, null, 2)}\n`)
  return outputs
}

// 形式の判定を通った成果物か（6.2.8 (3)）: 版・指紋の計算し直し・今の案件の指紋・その形式のファイルの bytes と sha256
export function checkedOutput(home: string, c: CaseRecord, format: string): Buffer | undefined {
  if (!isFormat(format)) return undefined
  const vdir = versionDir(home, c.caseId, c.version)
  try {
    const o = readManifest(join(vdir, 'outputs.json'))
    if (o.n !== c.version || filesFingerprint(o.files) !== o.fingerprint || o.fingerprint !== c.outputFingerprint)
      return undefined
    const entry = o.files.find((x) => x.path === OUTPUT_FILES[format])
    const body = readFileSync(join(vdir, 'outputs', OUTPUT_FILES[format]))
    return entry && entry.bytes === body.length && entry.sha256 === sha256(body) ? body : undefined
  } catch (e) {
    if (isStorageError(e)) throw e
    return undefined
  }
}

type Deps = {
  home: string
  ledger: Ledger
  google: Google
  emit: (caseId: string, r: ReturnType<typeof transition>) => boolean
  log: (line: string) => void
}

// 送付中の仕事。attempt を 1 つ進めたら返り、runner が続きを起こす（再起動では残りだけ）。
// 不明の attempt は探し直しの周期（recheck）にだけ見る。送付中の attempt を先に（6.5 (7)）
export async function deliver(d: Deps, c: CaseRecord, signal: AbortSignal, recheck = false): Promise<boolean> {
  const all = [...currentSend(d.ledger, c.caseId).values()]
  const pending = all.find((a) => a.status === '送付中') ?? (recheck ? all.find((a) => a.status === '不明') : undefined)
  if (!pending) return false
  const base = { caseId: c.caseId, by: 'libretto' as const, attemptId: pending.attemptId }
  const t = pending.target
  const body = checkedOutput(d.home, c, outputOf(t))
  if (!body) {
    d.log(`deliver ${c.caseId} ${pending.attemptId}: output missing or changed`)
    return d.emit(
      c.caseId,
      transition(d.ledger, {
        ...base,
        type: 'delivery.failed',
        reason: '成果物が判定したものと違う',
        eventId: `${c.caseId}:delivery.failed:${pending.attemptId}`,
      }),
    )
  }
  if (t.kind === 'gdoc' || t.kind === 'gsheet' || t.kind === 'gslide') {
    const ev = await deliverGoogle(d, c, pending, body, signal, recheck)
    if (ev) d.log(`deliver ${c.caseId} ${pending.attemptId}: ${ev.type}`)
    return ev ? d.emit(c.caseId, transition(d.ledger, ev)) : false
  }
  return d.emit(
    c.caseId,
    transition(d.ledger, {
      ...base,
      type: 'delivery.done',
      receiptId: t.kind === 'file' ? `file:${t.format}:v${c.version}` : `${t.kind}:v${c.version}`,
      ...(t.kind === 'page' && { link: `/cases/${encodeURIComponent(c.caseId)}/page?v=${c.version}` }),
      // 手元のファイルはダウンロードの口（6.10 (4)）
      ...(t.kind === 'file' && { link: fileLink(c.caseId, c.version, t.format) }),
      eventId: `${c.caseId}:delivery.done:${pending.attemptId}`,
    }),
  )
}

export const fileLink = (caseId: string, n: number, format: string) =>
  `/api/cases/${encodeURIComponent(caseId)}/files/${n}?format=${format}`

// 手元のファイルでダウンロードできる版か = その形式の file の届け先で最新の行が送付済の attempt がある（6.10 (4)）
export function fileVersions(ledger: Ledger, caseId: string, format: string): number[] {
  const latest = new Map(ledger.listDeliveries(caseId).map((x) => [x.attemptId, x]))
  return [...latest.values()]
    .filter((x) => x.target.kind === 'file' && x.target.format === format && x.status === '送付済')
    .map((x) => x.version)
}

// 版のあるページで出せる版 = page の届け先で最新の行が送付済の attempt がある版（6.2.8 (4)）。小さい順
export function pageVersions(ledger: Ledger, caseId: string): number[] {
  const latest = new Map(ledger.listDeliveries(caseId).map((x) => [x.attemptId, x]))
  const ns = [...latest.values()].filter((x) => x.target.kind === 'page' && x.status === '送付済').map((x) => x.version)
  return [...new Set(ns)].sort((a, b) => a - b)
}
