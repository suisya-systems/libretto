// 役割 → モデルの表（docs/implementation.md 6.1。設計書 12 章）。差し替えはこの表の 1 行で済む
import type { Role as RoleSchema } from '@libretto/shared/ledger'
import type { z } from 'zod'

export type Role = z.infer<typeof RoleSchema>
export type Family = 'claude' | 'openai' | 'jev'

// model は役割の側の名前。中身（claude-cli / openai / jev）がそれぞれの呼び名に直す
export const MODEL_BY_ROLE: Record<Role, { family: Family; model: string }> = {
  話し相手: { family: 'claude', model: 'claude-opus-5-5' },
  '下書き役・依頼書': { family: 'claude', model: 'claude-opus-5-5' },
  // 鍵が無いときの Claude への落ち方は Issue 16（設計書 5.8）
  '下書き役・確認項目': { family: 'openai', model: 'codex' },
  作り手: { family: 'claude', model: 'claude-opus-5-5' },
  '判定役・文章': { family: 'claude', model: 'claude-opus-5-5' },
  '判定役・画像': { family: 'claude', model: 'claude-sonnet-5-5' },
  '判定役・命題': { family: 'jev', model: 'jev' },
  '事実係・抜き出し': { family: 'claude', model: 'claude-haiku-5-5' },
  '事実係・分類': { family: 'claude', model: 'claude-haiku-5-5' },
  '事実係・命題': { family: 'jev', model: 'jev' },
  '事実係・描写': { family: 'claude', model: 'claude-sonnet-5-5' },
  // 起動のたびに 2 回動かすので安いモデル。隔離を作るのは起こし方で、モデルは関係しない（8.10 (4)）
  隔離の点検: { family: 'claude', model: 'claude-haiku-5-5' },
}

// 別系統が使えないときの受け皿（設計書 5.8.1）。呼ぶ側が Job.fallback で選ぶ（6.2.2 (3)）。鍵の有無で選ぶのは Issue 16
export const FALLBACK: Partial<Record<Role, { family: Family; model: string }>> = {
  '下書き役・確認項目': { family: 'claude', model: 'claude-opus-5-5' },
}

// 表に無い役割は既定に落とさず例外（6.1）
export function modelFor(role: string, fallback = false): { family: Family; model: string } {
  const table = (fallback ? FALLBACK : MODEL_BY_ROLE) as Record<string, { family: Family; model: string } | undefined>
  const m = table[role]
  if (!m) throw new Error(`no model for role ${role}`)
  return m
}
