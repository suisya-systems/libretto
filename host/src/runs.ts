// 実行の登録簿（docs/implementation.md 5.7 (4)）。子プロセスの終わらせ方（OS ごと）は中身（claude-cli）の責務
export class Stopped extends Error {}

export type Runs = ReturnType<typeof createRuns>

export function createRuns(isStopped: () => boolean, waitMs = 10_000) {
  const controllers = new Map<string, Set<AbortController>>()
  const exits = new Map<string, Set<Promise<unknown>>>()
  const bucket = <T>(m: Map<string, Set<T>>, caseId: string) => {
    const s = m.get(caseId) ?? new Set<T>()
    m.set(caseId, s)
    return s
  }

  // 切ってから、watch された終わりを全部待つ（最大 waitMs）。待ち切れなかった案件の id を返す
  async function abortCases(caseIds: string[]): Promise<string[]> {
    const waits = caseIds.map(async (caseId) => {
      for (const ac of controllers.get(caseId) ?? []) ac.abort()
      controllers.delete(caseId)
      const pending = [...(exits.get(caseId) ?? [])]
      if (!pending.length) return undefined
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), waitMs)
      })
      const r = await Promise.race([Promise.allSettled(pending), timedOut])
      clearTimeout(timer)
      return r === 'timeout' ? caseId : undefined
    })
    return (await Promise.all(waits)).filter((id): id is string => id !== undefined)
  }

  return {
    // 仕事を起こす側（runner）が呼ぶ。止まっている間は Stopped。終わったら close
    open(caseId: string): AbortController {
      if (isStopped()) throw new Stopped(`stopped: ${caseId}`)
      const ac = new AbortController()
      bucket(controllers, caseId).add(ac)
      return ac
    },
    close(caseId: string, ac: AbortController) {
      controllers.get(caseId)?.delete(ac)
    },
    // runner が invoke の Promise を渡す。invoke は子孫まで全部終わってから決着する（6.1.2 (2)）
    watch(caseId: string, exited: Promise<unknown>) {
      const s = bucket(exits, caseId)
      s.add(exited)
      exited.then(
        () => s.delete(exited),
        () => s.delete(exited),
      )
    },
    abort: (caseId: string) => abortCases([caseId]),
    abortAll: () => abortCases([...new Set([...controllers.keys(), ...exits.keys()])]),
  }
}
