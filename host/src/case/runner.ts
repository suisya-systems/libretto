// runner（docs/implementation.md 4.1・4.4・6.2.3 (1)(2)(7)）。状態 × turn=libretto を見て仕事を 1 本起こす。
// 遷移は transition だけが書く。ここは起動・続き・再起動・ログインし直し待ちを持つ
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseState } from '@libretto/shared/api'
import type { CaseRecord } from '@libretto/shared/ledger'
import type { Ledger } from '../ledger/ledger.ts'
import type { Job, Outcome } from '../model/invoke.ts'
import { approvedSet, renderBrief, writeAtomic } from '../roles/entrance.ts'
import { judgeBody } from '../roles/judge.ts'
import { make, workDir } from '../roles/maker.ts'
import type { Runs } from '../runs.ts'
import { isStorageError } from '../server/stop.ts'
import { transition } from './transition.ts'

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

  // 材料待ち → 作業場（承認した組の brief.md と空の materials/）→ T11（6.2.3 (2)）
  async function assemble(c: CaseRecord, signal: AbortSignal): Promise<boolean> {
    const set = approvedSet(home, ledger, c.caseId)
    if (!set) throw new Error(`no approved brief for ${c.caseId}`)
    const work = workDir(home, c.caseId)
    mkdirSync(join(work, 'materials'), { recursive: true, mode: 0o700 })
    writeAtomic(join(work, 'brief.md'), renderBrief(set.brief))
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

  // 送付確認待ち（仕立て → judgeFormat）と送付中は、仕事を作る Issue 12 がここに足す
  const JOBS: Partial<Record<CaseState, (c: CaseRecord, signal: AbortSignal) => Promise<boolean>>> = {
    材料待ち: assemble,
    下書き中: (c, signal) =>
      make({ home, ledger, invoke: d.invoke, emit, onAuthExpired, ...(d.now && { now: d.now }) }, c, signal),
    検品中: (c, signal) =>
      judgeBody(
        { home, ledger, invoke: d.invoke, emit, onAuthExpired, log: d.log, ...(d.now && { now: d.now }) },
        c,
        signal,
      ),
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
