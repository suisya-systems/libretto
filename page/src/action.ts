// 案件の操作の送り方（docs/implementation.md 5.3.1）。押下ごとに eventId、応答まで同じ案件の操作を全部押せなくする。
// 通信の失敗は同じ eventId で 1・2・4 秒あけて 3 回、409 は読み直す。stop.case と cancel の stale だけ 1 回送り直す。
// 資料を渡す操作は送り先だけが違う（POST /api/cases/:id/materials。6.2.4 (3)）
import { type CaseAction, CaseView, type MaterialsPost } from '@libretto/shared/api'
import { useRef, useState } from 'react'

type Body =
  | { [K in CaseAction['type']]: Omit<Extract<CaseAction, { type: K }>, 'eventId'> }[CaseAction['type']]
  | Omit<MaterialsPost, 'eventId'>
export type ActionNotice = 'moved' | 'failed'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 応答が無い・5xx は undefined（同じ eventId で送り直す）
async function post(caseId: string, body: Body & { eventId: string }): Promise<Response | undefined> {
  try {
    const to = body.type === 'materials.provided' ? 'materials' : 'actions'
    const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}/${to}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    return res.status >= 500 ? undefined : res
  } catch {
    return undefined
  }
}

export function useCaseAction(caseId: string, reload: () => void, delays: readonly number[] = [1000, 2000, 4000]) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ActionNotice>()
  // 失敗した押下の eventId は、同じ中身をもう一度押すまで持つ（届いていたかが画面からは分からない）
  const kept = useRef<{ key: string; eventId: string } | null>(null)

  async function send(body: Body): Promise<Response | undefined> {
    const key = JSON.stringify(body)
    const eventId = kept.current?.key === key ? kept.current.eventId : crypto.randomUUID()
    kept.current = { key, eventId }
    for (let i = 0; ; i++) {
      const res = await post(caseId, { ...body, eventId })
      if (res) {
        kept.current = null
        return res
      }
      if (i >= delays.length) return undefined
      await sleep(delays[i] as number)
    }
  }

  // then は成功の応答を受け取る（restart_as_new の newCaseId で面を移るなど）
  async function run(body: Body, then?: (res: Response) => void): Promise<boolean> {
    setBusy(true)
    setNotice(undefined)
    try {
      let res = await send(body)
      if (!res) {
        setNotice('failed')
        return false
      }
      if (res.status === 409 && (body.type === 'stop.case' || body.type === 'cancel')) {
        const why = (await res
          .clone()
          .json()
          .catch(() => ({}))) as { reason?: string }
        if (why.reason === 'stale') {
          // 止める・取り消すは状態が進んでも本人の意図が変わらない。取り直した revision と新しい eventId で 1 回だけ
          const now = await fetch(`/api/cases/${encodeURIComponent(caseId)}`)
            .then((r) => r.json())
            .catch(() => undefined)
          const parsed = CaseView.safeParse(now)
          if (parsed.success) res = (await send({ ...body, expectedRevision: parsed.data.revision })) ?? res
        }
      }
      if (res.status === 409) setNotice('moved')
      else if (!res.ok) setNotice('failed')
      else if (then) then(res)
      reload()
      return res.ok
    } finally {
      setBusy(false)
    }
  }

  return { run, busy, notice }
}
