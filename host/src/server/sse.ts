// SSE の合図（docs/implementation.md 5.2・5.7 (2)）。id = <起動 id>:<連番>、直近 500 件をメモリに持つ
import { randomUUID } from 'node:crypto'
import type { SseData } from '@libretto/shared/api'
import type { z } from 'zod'

export type SseEvent = keyof typeof SseData
export type SseMessage = { id: string; n: number; event: SseEvent; data: string }

export type Hub = ReturnType<typeof createHub>

export function createHub(keep = 500) {
  const boot = randomUUID().slice(0, 8)
  let seq = 0
  const kept: SseMessage[] = []
  const subs = new Set<(m: SseMessage) => void>()

  return {
    emit<E extends SseEvent>(event: E, data: z.infer<(typeof SseData)[E]>) {
      seq += 1
      const m = { id: `${boot}:${seq}`, n: seq, event, data: JSON.stringify(data) }
      kept.push(m)
      if (kept.length > keep) kept.shift()
      for (const s of subs) s(m)
    },
    subscribe(fn: (m: SseMessage) => void) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    // 送り直す分。undefined = 送り直せない（無い・別の起動・保持より古い・読めない）→ resync
    since(lastId: string | undefined): SseMessage[] | undefined {
      const m = lastId?.match(/^([0-9a-f]{8}):(\d+)$/)
      if (!m || m[1] !== boot) return undefined
      const n = Number(m[2])
      if (n > seq) return undefined
      if (n < seq && n < (kept[0]?.n ?? seq + 1) - 1) return undefined
      return kept.filter((k) => k.n > n)
    },
    // resync に付ける id（次の再接続で、この後の分から送り直せる）
    lastId: () => `${boot}:${seq}`,
  }
}
