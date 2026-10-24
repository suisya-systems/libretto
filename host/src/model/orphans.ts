// 途中で落ちた呼び出しの精算（docs/implementation.md 9.4 (7)）。起動処理が STOP の確認・HTTP・runner より前に 1 回呼ぶ
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger } from '../ledger/ledger.ts'
import { resultYen } from './claude-cli.ts'
import { callFile } from './invoke.ts'

// 生きている呼び出しが無いときだけ呼ぶ。精算の数を返す
export function settleOrphans(ledger: Ledger, callsDir: string): { result: number; hold: number } {
  const n = { result: 0, hold: 0 }
  for (const h of ledger.listUnsettledHolds()) {
    const yen = resultYen(callFile(callsDir, h.callId))
    ledger.settleOrphan({ callId: h.callId, yen: yen ?? h.holdYen, source: yen === null ? '予約' : '結果' })
    n[yen === null ? 'hold' : 'result']++
  }
  // 残りは精算済みで消し損ねたもの
  for (const f of readdirSync(callsDir)) rmSync(join(callsDir, f), { force: true })
  return n
}
