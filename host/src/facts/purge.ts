// 閉じるときの削除（docs/implementation.md 9.1・6.3.1 (10)）。出典の本文・資料の正本と写し・読み比べの段落を消し、purged 行を残す
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CaseState } from '@libretto/shared/api'
import { caseDir } from '../ledger/db.ts'
import type { Ledger } from '../ledger/ledger.ts'

export const CLOSED: readonly CaseState[] = ['完了', '取り消し', '停止', '見送り']
const TARGETS = ['facts-excerpts', 'materials', 'work/materials', 'checks/voice-samples.md']

// 消したパス（案件フォルダからの相対）。終端でなければ何もしない
export function purge(home: string, ledger: Ledger, caseId: string, now = new Date()): string[] {
  const c = ledger.getCase(caseId)
  if (!c || !CLOSED.includes(c.state)) return []
  const dir = caseDir(home, caseId)
  const paths = TARGETS.filter((p) => existsSync(join(dir, p)))
  if (!paths.length) return []
  for (const p of paths) rmSync(join(dir, p), { recursive: true, force: true })
  ledger.recordPurged(`${caseId}:purged:${now.getTime()}`, caseId, paths)
  return paths
}

// 起動時のやり直し（消す前に落ちた案件）。HTTP と runner より前に呼ぶ
export function purgeClosed(home: string, ledger: Ledger) {
  for (const c of ledger.listCases(CLOSED)) purge(home, ledger, c.caseId)
}
