// 台本を返す中身（docs/implementation.md 6.1.1 (5)・11.2）。費用・検査・言い直しの内側に差し込む
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Backend, Call, Reply, Why } from './invoke.ts'
import type { Role } from './roles.ts'

// text は壊れた JSON でもよい。json は JSON.stringify して text として返す（台本の JSON に二重に書かない。11.3 (1)）。
// costYen を省けば 0（fake は費用が掛からない）。hang は signal が切れるまで返らない（write を置いてから。書きかけ）。
// write は作り手の fake が作業場（workdir）に書くファイル。書いた名前を files として返す（6.2.3 (9)）
type Written = { costYen?: number | null; files?: string[]; write?: Record<string, string> }
export type ScriptReply =
  | ({ text: string } & Written)
  | ({ json: unknown } & Written)
  | { fail: 'unavailable'; why?: Why }
  | { fail: 'budget' }
  | { fail: 'hang'; write?: Record<string, string> }
export type ScriptEntry = { role: Role; nth: number; reply: ScriptReply }

// nth は役割ごとの実際の呼び出しの何回目か（1 から。言い直しも 1 回）。数えるのはこの fake 1 つの中
export function createFake(script: readonly ScriptEntry[]) {
  const counts = new Map<string, number>()
  const used = new Set<ScriptEntry>()
  const calls: Call[] = []

  const backend: Backend = async (call): Promise<Reply> => {
    calls.push(call)
    const nth = (counts.get(call.role) ?? 0) + 1
    counts.set(call.role, nth)
    const entry = script.find((e) => e.role === call.role && e.nth === nth)
    if (!entry) throw new Error(`fake: no script for ${call.role} #${nth}`)
    used.add(entry)
    const r = entry.reply
    if ('write' in r) {
      for (const [name, text] of Object.entries(r.write ?? {})) {
        if (!call.workdir) throw new Error('fake: write needs workdir')
        mkdirSync(dirname(join(call.workdir, name)), { recursive: true })
        writeFileSync(join(call.workdir, name), text, 'utf-8')
      }
    }
    if (!('fail' in r)) {
      const files = r.files ?? (r.write && Object.keys(r.write))
      const text = 'text' in r ? r.text : JSON.stringify(r.json)
      return { text, costYen: r.costYen === undefined ? 0 : r.costYen, ...(files && { files }) }
    }
    if (r.fail === 'unavailable') return { fail: r.fail, ...('why' in r && r.why && { why: r.why }), costYen: null }
    if (r.fail === 'budget') return { fail: r.fail, costYen: null }
    return new Promise((_, reject) =>
      call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }),
    )
  }

  return { backend, calls, unused: () => script.filter((e) => !used.has(e)) }
}
