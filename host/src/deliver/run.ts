// 仕立てと送付（docs/implementation.md 6.2.8 (1)(3)）。送付確認待ち・turn=libretto は仕立て → 形式の判定、
// 送付中・turn=libretto は今の送付回の attempt を順に送付済にする。仕事の起動と 1 案件 1 本は runner（case/runner.ts）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CaseRecord, VersionManifest } from '@libretto/shared/ledger'
import { currentSend, transition } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import { writeAtomic } from '../roles/entrance.ts'
import { OUTPUT_FILES } from '../roles/judge.ts'
import { draftNames, filesFingerprint, sha256, versionDir } from '../roles/maker.ts'
import { isStorageError } from '../server/stop.ts'
import { pageDocument } from './page.ts'
import { pasteText } from './paste.ts'

type Kind = keyof typeof OUTPUT_FILES
const KINDS = Object.keys(OUTPUT_FILES) as Kind[]
const isKind = (k: string): k is Kind => (KINDS as string[]).includes(k)
const readManifest = (path: string) => VersionManifest.parse(JSON.parse(readFileSync(path, 'utf-8')))

// versions/NN/outputs/ と outputs.json を書く。版のファイルと manifest.at は T12 の後に変わらないので、何度流しても同じ指紋
export function tailor(home: string, c: CaseRecord, now: Date): VersionManifest {
  const vdir = versionDir(home, c.caseId, c.version)
  const f = draftNames(c.version)
  const m = readManifest(join(vdir, 'manifest.json'))
  const kinds = [...new Set(c.destination.map((t) => t.kind))]
  const bad = kinds.find((k) => !isKind(k))
  if (bad) throw new Error(`cannot tailor ${bad} for ${c.caseId}`)
  const files = (kinds as Kind[])
    .map((kind) => {
      const body =
        kind === 'page'
          ? pageDocument(readFileSync(join(vdir, f.html), 'utf-8'), { title: c.title, n: c.version, at: m.at })
          : pasteText(readFileSync(join(vdir, f.md), 'utf-8'))
      writeAtomic(join(vdir, 'outputs', OUTPUT_FILES[kind]), body)
      return { path: OUTPUT_FILES[kind], sha256: sha256(body), bytes: Buffer.byteLength(body) }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  const outputs = { n: c.version, at: now.toISOString(), files, fingerprint: filesFingerprint(files) }
  writeAtomic(join(vdir, 'outputs.json'), `${JSON.stringify(outputs, null, 2)}\n`)
  return outputs
}

// 形式の判定を通った成果物か（6.2.8 (3)）: 版・指紋の計算し直し・今の案件の指紋・その種類のファイルの bytes と sha256
export function checkedOutput(home: string, c: CaseRecord, kind: string): Buffer | undefined {
  if (!isKind(kind)) return undefined
  const vdir = versionDir(home, c.caseId, c.version)
  try {
    const o = readManifest(join(vdir, 'outputs.json'))
    if (o.n !== c.version || filesFingerprint(o.files) !== o.fingerprint || o.fingerprint !== c.outputFingerprint)
      return undefined
    const entry = o.files.find((x) => x.path === OUTPUT_FILES[kind])
    const body = readFileSync(join(vdir, 'outputs', OUTPUT_FILES[kind]))
    return entry && entry.bytes === body.length && entry.sha256 === sha256(body) ? body : undefined
  } catch (e) {
    if (isStorageError(e)) throw e
    return undefined
  }
}

type Deps = {
  home: string
  ledger: Ledger
  emit: (caseId: string, r: ReturnType<typeof transition>) => boolean
  log: (line: string) => void
}

// 送付中の仕事。attempt を 1 つ送付済にしたら返り、runner が続きを起こす（再起動では残りだけ）
export function deliver(d: Deps, c: CaseRecord): boolean {
  const pending = [...currentSend(d.ledger, c.caseId).values()].find(
    (a) => a.status === '送付中' || a.status === '不明',
  )
  if (!pending) return false
  const base = { caseId: c.caseId, by: 'libretto' as const, attemptId: pending.attemptId }
  const kind = pending.target.kind
  if (!checkedOutput(d.home, c, kind)) {
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
  return d.emit(
    c.caseId,
    transition(d.ledger, {
      ...base,
      type: 'delivery.done',
      receiptId: `${kind}:v${c.version}`,
      ...(kind === 'page' && { link: `/cases/${encodeURIComponent(c.caseId)}/page?v=${c.version}` }),
      eventId: `${c.caseId}:delivery.done:${pending.attemptId}`,
    }),
  )
}

// 版のあるページで出せる版 = page の届け先で最新の行が送付済の attempt がある版（6.2.8 (4)）。小さい順
export function pageVersions(ledger: Ledger, caseId: string): number[] {
  const latest = new Map(ledger.listDeliveries(caseId).map((x) => [x.attemptId, x]))
  const ns = [...latest.values()].filter((x) => x.target.kind === 'page' && x.status === '送付済').map((x) => x.version)
  return [...new Set(ns)].sort((a, b) => a - b)
}
