// runner（docs/implementation.md 4.1・4.4・6.2.3 (1)(2)(7)）。状態 × turn=libretto を見て仕事を 1 本起こす。
// 遷移は transition だけが書く。ここは起動・続き・再起動・ログインし直し待ちを持つ
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseState } from '@libretto/shared/api'
import type { CaseRecord, VoiceCard } from '@libretto/shared/ledger'
import { deliver, tailor } from '../deliver/run.ts'
import { gatherSources } from '../facts/gather.ts'
import { type Fetch, fetchCached, materialsDir } from '../facts/inventory.ts'
import { type Portrait, portraitJob, renderVoice, sha256Hex } from '../facts/voice.ts'
import { caseDir } from '../ledger/db.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { approvedSet, renderBrief, voiceSamplesPath, writeAtomic } from '../roles/entrance.ts'
import { judgeBody, judgeFormat } from '../roles/judge.ts'
import { make, nn, workDir } from '../roles/maker.ts'
import type { Runs } from '../runs.ts'
import { isStorageError } from '../server/stop.ts'
import { transition } from './transition.ts'

// 取り寄せる URL（6.3.1 (5)）。閉じ括弧・句読点で切る
const URL_IN_TEXT = /https?:\/\/[^\s<>"'()[\]（）」』、。]+/g
const MAX_SOURCES = 5
const sameUrl = (u: string) => {
  try {
    const x = new URL(u)
    x.hash = '' // 同じページの中の場所違いも同じ見本
    return x.href
  } catch {
    return u
  }
}

const WORKING: readonly CaseState[] = ['入口待ち', '材料待ち', '下書き中', '検品中', '送付確認待ち', '送付中']

type Deps = {
  home: string
  ledger: Ledger
  invoke: (job: Job) => Promise<Outcome>
  runs: Runs
  entrance: { kick: (caseId: string) => void }
  caseChanged: (caseId: string) => void
  storage: (written: boolean) => void
  signInChanged: (waiting: boolean) => void
  log: (line: string) => void
  now?: () => Date
  fetch?: Fetch // 出典の取り寄せ（テストは偽物。6.3.1 (5)）
}

export type Runner = ReturnType<typeof createRunner>

export function createRunner(d: Deps) {
  const { home, ledger } = d
  const running = new Map<string, { ac: AbortController; again: boolean }>()
  let signIn = false
  const waiting = new Set<string>()

  const emit = (caseId: string, r: ReturnType<typeof transition>) => {
    d.storage(true)
    const moved = r.ok && !r.replayed
    if (moved) d.caseChanged(caseId)
    return moved
  }

  // 材料待ち → 集めるもの → 出典の取り寄せ → 作業場（承認した組の brief.md と資料の写し）→ T11（6.2.3 (2)・6.3.1 (5)・6.3.3）
  async function assemble(c: CaseRecord, signal: AbortSignal): Promise<boolean> {
    const set = approvedSet(home, ledger, c.caseId)
    if (!set) throw new Error(`no approved brief for ${c.caseId}`)
    const src = materialsDir(home, c.caseId)
    mkdirSync(src, { recursive: true, mode: 0o700 })
    // 依頼書の「集めるもの」をウェブで探す。null は止めた・ログインし直し待ち・費用の上限（6.3.3 (5)）
    const gathered = await gatherSources(
      { home, invoke: d.invoke, onAuthExpired, ...(d.now && { now: d.now }), ...(d.fetch && { fetch: d.fetch }) },
      c.caseId,
      set.brief.gather,
      signal,
    )
    if (gathered === null || signal.aborted) return false
    // 本人の資料と依頼書に出てくる URL を取り寄せ、資料の正本に足す（作り手は網に出られない）
    const pasted = readdirSync(src)
      .filter((f) => f.startsWith('pasted-'))
      .sort()
    const text = [
      set.brief.subject,
      ...set.brief.materials.filter((m) => m.kind !== '声の見本').map((m) => m.where),
      ...pasted.map((f) => readFileSync(join(src, f), 'utf-8')),
    ].join('\n')
    // 本人の URL（5 件まで）の後に集めたもの（5 件まで）。文体の見本は出典として取り寄せない
    // （作り手に見せない本人の段落が作業場に届く。6.3.2 (8)）
    const voiceUrls = new Set(set.checks.voice?.docs.map((x) => sameUrl(x.url)))
    const urls = [
      ...new Set([...new Set(text.match(URL_IN_TEXT) ?? [])].slice(0, MAX_SOURCES).concat(gathered)),
    ].filter((u) => !voiceUrls.has(sameUrl(u)))
    const got = await fetchCached(home, c.caseId, urls, signal, d.fetch)
    if (signal.aborted) return false
    // 取り寄せた出典は組み立てのたびに書き直す（前の組で取った出典が、今の組の見本になっていても残さない）
    const work = workDir(home, c.caseId)
    for (const dir of [src, join(work, 'materials')])
      if (existsSync(dir))
        for (const f of readdirSync(dir)) if (/^source-\d+\.md$/.test(f)) rmSync(join(dir, f), { force: true })
    let k = 0
    for (const url of urls) {
      const f = got.get(url)
      if (!f?.ok) continue
      k++
      writeAtomic(
        join(src, `source-${nn(k)}.md`),
        [`# ${f.title || url}`, '', url, '', ...f.paragraphs.flatMap((p) => [p, ''])].join('\n'),
      )
    }
    // 作業場の materials/ は写し。照合は正本だけを読む（作り手は作業場に書ける）
    mkdirSync(join(work, 'materials'), { recursive: true, mode: 0o700 })
    // gathered.json（集め役の出力）は写さない。作り手が読むのは資料の本文だけ（6.3.3 (6)）
    for (const f of readdirSync(src)) if (f.endsWith('.md')) copyFileSync(join(src, f), join(work, 'materials', f))
    writeAtomic(join(work, 'brief.md'), renderBrief(set.brief))
    // 文体カード（6.3.2 (8)）。承認した組にカードが無ければ前の組のカードを作業場に残さない
    const card = set.checks.voice?.card
    if (card) {
      const sp = voiceSamplesPath(home, c.caseId)
      const raw = existsSync(sp) ? readFileSync(sp, 'utf-8') : undefined
      const samples = raw && sha256Hex(raw) === set.checks.voice?.samplesFingerprint ? raw : undefined
      const out = await d.invoke(portraitJob(c.caseId, card, samples, signal))
      if (!out.ok && (out.kind === 'stopped' || out.kind === 'budget')) return false
      if (signal.aborted) return false
      const portrait = out.ok ? (out.json as Portrait).portrait : undefined
      const voice: VoiceCard = {
        ...card,
        ...(portrait && { portrait }),
        sources: (set.checks.voice?.docs ?? []).filter((x) => x.usable).map(({ title, url }) => ({ title, url })),
      }
      writeAtomic(join(caseDir(home, c.caseId), 'voice.json'), `${JSON.stringify(voice, null, 2)}\n`)
      writeAtomic(join(caseDir(home, c.caseId), 'voice.md'), renderVoice(voice))
      writeAtomic(join(work, 'voice.md'), renderVoice(voice))
    } else rmSync(join(work, 'voice.md'), { force: true })
    if (signal.aborted) return false
    return emit(
      c.caseId,
      transition(ledger, {
        type: 'materials.ready',
        eventId: `${c.caseId}:materials.ready:r${c.revision}`,
        caseId: c.caseId,
        expectedRevision: c.revision,
        by: 'libretto',
      }),
    )
  }

  const judgeDeps = () => ({
    home,
    ledger,
    invoke: d.invoke,
    emit,
    onAuthExpired,
    log: d.log,
    ...(d.now && { now: d.now }),
    ...(d.fetch && { fetch: d.fetch }),
  })

  // 送付確認待ち → 仕立て → 形式の判定（T20〜T21b。6.2.8 (1)）。版が読めない・作れない保存先は判定できなかった
  async function tailorAndJudge(c: CaseRecord, signal: AbortSignal): Promise<boolean> {
    try {
      tailor(home, c, (d.now ?? (() => new Date()))())
    } catch (e) {
      if (isStorageError(e)) throw e
      d.log(`tailor ${c.caseId}: ${e instanceof Error ? e.stack : String(e)}`)
      return emit(
        c.caseId,
        transition(ledger, {
          type: 'fail.system',
          reason: '判定できなかった',
          eventId: `${c.caseId}:fail.system:r${c.revision}`,
          caseId: c.caseId,
          expectedRevision: c.revision,
          by: 'libretto',
        }),
      )
    }
    if (signal.aborted) return false
    return judgeFormat(judgeDeps(), c, signal)
  }

  const JOBS: Partial<Record<CaseState, (c: CaseRecord, signal: AbortSignal) => Promise<boolean>>> = {
    材料待ち: assemble,
    下書き中: (c, signal) =>
      make({ home, ledger, invoke: d.invoke, emit, onAuthExpired, ...(d.now && { now: d.now }) }, c, signal),
    検品中: (c, signal) => judgeBody(judgeDeps(), c, signal),
    送付確認待ち: tailorAndJudge,
    // 送付中 → 今の送付回の attempt を 1 つずつ送付済に（T24。6.2.8 (3)）
    送付中: async (c) => deliver({ home, ledger, emit, log: d.log }, c),
  }

  // ログインし直し待ちの関門。待っていれば案件を覚えて真（6.2.3 (7)）
  function blocked(caseId: string) {
    if (signIn) waiting.add(caseId)
    return signIn
  }
  function onAuthExpired(caseId: string) {
    waiting.add(caseId)
    if (signIn) return
    signIn = true
    d.signInChanged(true)
  }

  // 1 案件に 1 本。動いている間の kick は、動いている方を止めて、終わってから新しい revision で始め直す
  function kick(caseId: string) {
    const r = running.get(caseId)
    if (r) {
      r.again = true
      r.ac.abort()
      return
    }
    const c = ledger.getCase(caseId)
    if (c?.turn !== 'libretto') return
    if (c.state === '入口待ち') return d.entrance.kick(caseId) // 入口は自分の 1 本を持ち、同じ関門を通る
    const job = JOBS[c.state]
    if (!job || blocked(caseId)) return
    let ac: AbortController
    try {
      ac = d.runs.open(caseId)
    } catch {
      return // 止まっている間は起こさない（解いても自動では再開しない。4.4）
    }
    const entry = { ac, again: false }
    running.set(caseId, entry)
    const done = job(c, ac.signal)
      .catch((e) => {
        d.log(`runner ${caseId} ${c.state}: ${e instanceof Error ? e.stack : String(e)}`)
        if (isStorageError(e)) d.storage(false)
        return false
      })
      .then((moved) => {
        d.runs.close(caseId, ac)
        running.delete(caseId)
        // 遷移をコミットした仕事だけ続きを起こす（失敗した仕事を起こし直し続けない）
        if (moved || entry.again) kick(caseId)
      })
    d.runs.watch(caseId, done)
  }

  return {
    kick,
    blocked,
    onAuthExpired,
    // 起動時: 非終端で libretto の番の案件を全部（4.4 の再起動）
    resume() {
      for (const c of ledger.listCases(WORKING)) if (c.turn === 'libretto') kick(c.caseId)
    },
    signIn: () => signIn,
    // 「続ける」: 待ちを下ろして、待っていた案件を起こし直す。まだ切れていればまた待ちに戻る
    retrySignIn() {
      if (!signIn) return
      signIn = false
      d.signInChanged(false)
      const ids = [...waiting]
      waiting.clear()
      for (const id of ids) kick(id)
    },
    running: () => [...running.keys()],
  }
}
