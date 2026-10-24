// 緊急停止（docs/implementation.md 4.4・5.7 (3)）。メモリの停止 → 中断 → STOP → 遷移。先の段が落ちても後を飛ばさない
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '@libretto/shared/api'
import { transition } from '../case/transition.ts'
import type { Ledger } from '../ledger/ledger.ts'
import type { Runs } from '../runs.ts'

const SQLITE_STORAGE = ['SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_CANTOPEN']
const FS_STORAGE = ['ENOSPC', 'EACCES', 'EROFS', 'EPERM']

// 保存の失敗（5.7 (8)）。ほかの例外はそのまま上へ
export function isStorageError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return false
  return SQLITE_STORAGE.includes(code) || code.startsWith('SQLITE_IOERR') || FS_STORAGE.includes(code)
}

export const stopFile = (home: string) => join(home, 'STOP')

// `libretto stop`（ホストの外から）。ファイルを書くだけで、検知はホストが 2 秒ごとにする
export const writeStopFile = (home: string, now = new Date()) =>
  writeFileSync(stopFile(home), `${now.toISOString()}\n`, 'utf-8')

type Deps = {
  home: string
  ledger: Ledger
  runs: Runs
  status: HostStatus // 書き換えるのはここと storage()
  changed: () => void // status が変わった
  storage: (ok: boolean) => void
  stoppedCases: (caseIds: string[]) => void
  log: (line: string) => void
}

export type Stop = ReturnType<typeof createStop>

export function createStop(d: Deps) {
  let pending = false // 停止の遷移がまだ（再処理で再び試す）

  function applyTransition() {
    try {
      const r = transition(d.ledger, { type: 'stop.all' })
      pending = false
      d.storage(true)
      if (r.ok && r.stopped?.length) d.stoppedCases(r.stopped)
    } catch (e) {
      pending = true
      if (!isStorageError(e)) throw e
      d.storage(false)
      d.log(`stop.all failed, retrying: ${String(e)}`)
    }
  }

  function writeFile() {
    try {
      writeStopFile(d.home)
      return true
    } catch (e) {
      if (!isStorageError(e)) throw e
      d.storage(false)
      d.log(`STOP file not written: ${String(e)}`)
      return false
    }
  }

  function raise() {
    if (d.status.stopped) return
    d.status.stopped = true
    d.changed()
  }

  async function abortAll() {
    const left = await d.runs.abortAll()
    if (left.length) d.log(`runs did not end within the wait: ${left.join(', ')}`)
  }

  async function external() {
    raise()
    const aborted = abortAll()
    applyTransition()
    await aborted
  }

  return {
    // 止まっているのに STOP か停止の遷移が保存できていない（ほかの書き込みが通っても帯を下ろさない）
    unsaved: () => d.status.stopped && (pending || !existsSync(stopFile(d.home))),
    isStopped: () => d.status.stopped || existsSync(stopFile(d.home)),

    // POST /api/stop
    async stop() {
      raise()
      const aborted = abortAll()
      const written = writeFile()
      applyTransition()
      // 遷移が書けても、STOP が無ければ起こし直すと止まっていない。帯は下ろさない
      if (!written) d.storage(false)
      await aborted
    },

    // DELETE /api/stop。停止の遷移が残っていれば先に済ませ、済まなければ false（止まったまま）。STOP が消せなければ例外
    async release(): Promise<boolean> {
      // 見回りの前に外から置かれた STOP も、効かせてから解く（案件は再開しない）
      if (!d.status.stopped && existsSync(stopFile(d.home))) await external()
      if (pending) applyTransition()
      if (pending) return false
      try {
        unlinkSync(stopFile(d.home))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      if (!d.status.stopped) return true
      d.status.stopped = false
      d.changed()
      return true
    },

    // 起動時。HTTP を開く前に
    boot() {
      if (!existsSync(stopFile(d.home))) return
      d.status.stopped = true
      applyTransition()
    },

    // 2 秒ごと: 外からの STOP の検知。retry（30 秒ごと）: 停止の再処理
    async tick(retry: boolean) {
      if (!d.status.stopped && existsSync(stopFile(d.home))) return external()
      if (!retry || !d.status.stopped) return
      // 停止の再処理: 書けなかった STOP と遷移を追いつかせる
      const written = existsSync(stopFile(d.home)) || writeFile()
      if (pending) applyTransition()
      d.storage(written && !pending)
    },
  }
}
