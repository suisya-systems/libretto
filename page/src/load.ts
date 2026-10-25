// ホストの写しを読む（docs/implementation.md 5.1・5.7 (2)・5.8 (1)(3)(7)）。
// 取り直しは前の取得を打ち切ってから始め、後から始めた取得だけを画面に入れる
import { SseData } from '@libretto/shared/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'

export type Problem = 'offline' | 'not_paired' | 'not_found' | 'failed'
export type Loaded<T> = { data?: T; problem?: Problem }

export type SseEvent = keyof typeof SseData
// open は SSE がつながったとき。open と resync は全部の面が取り直す
type Signal = { event: SseEvent | 'open'; data: unknown }
type Listener = (s: Signal) => void
const listeners = new Set<Listener>()
const offlineListeners = new Set<(offline: boolean) => void>()

// EventSource は切れたら自分でつなぎ直すが、5xx などで閉じたら（CLOSED）もうつながない。
// そのときは 1 秒から倍々に 30 秒まで空けて作り直す（ホストを起こし直したら戻る）。
// 画面が見えるようになったときと網に戻ったときは、状態に関わらず今すぐ作り直す（5.8 (7)。
// 裏で止められた接続は OPEN のまま死んでいることがある）
export function connectEvents(url = '/api/events') {
  const fire = (s: Signal) => {
    for (const l of listeners) l(s)
  }
  const offline = (v: boolean) => {
    for (const l of offlineListeners) l(v)
  }
  let es: EventSource
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1_000
  const open = () => {
    es = new EventSource(url)
    es.addEventListener('open', () => {
      delay = 1_000
      offline(false)
      fire({ event: 'open', data: {} })
    })
    es.addEventListener('error', () => {
      offline(true)
      if (es.readyState !== EventSource.CLOSED) return
      retry = setTimeout(open, delay)
      delay = Math.min(delay * 2, 30_000)
    })
    for (const event of Object.keys(SseData) as SseEvent[])
      es.addEventListener(event, (e) => {
        let data: unknown
        try {
          data = JSON.parse((e as MessageEvent<string>).data)
        } catch {
          data = {}
        }
        fire({ event, data })
      })
  }
  const renew = () => {
    if (document.visibilityState !== 'visible') return
    clearTimeout(retry)
    es.close()
    delay = 1_000
    open()
  }
  open()
  document.addEventListener('visibilitychange', renew)
  window.addEventListener('online', renew)
  return () => {
    document.removeEventListener('visibilitychange', renew)
    window.removeEventListener('online', renew)
    clearTimeout(retry)
    es.close()
  }
}

// 面に結び付かない受け手（ブラウザの通知。6.8 (2)）。戻り値で外す
export function listen(l: Listener) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

// open・resync のたびに増える数。useLoad を通らない取得（下書きの本文など）が依存に入れて取り直す
export function useResync() {
  const [n, setN] = useState(0)
  useEffect(
    () =>
      listen((s) => {
        if (s.event === 'open' || s.event === 'resync') setN((k) => k + 1)
      }),
    [],
  )
  return n
}

export function useOffline() {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    offlineListeners.add(setOffline)
    return () => {
      offlineListeners.delete(setOffline)
    }
  }, [])
  return offline
}

async function get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<Loaded<T>> {
  let res: Response
  try {
    res = await fetch(path, { signal, headers: { accept: 'application/json' } })
  } catch {
    return { problem: 'offline' }
  }
  if (res.status === 401) return { problem: 'not_paired' }
  if (res.status === 404) return { problem: 'not_found' }
  if (!res.ok) return { problem: 'failed' }
  // 本文の途中で切れたのも通信の失敗（取り直す）。形が違うのは読み込めない
  let body: string
  try {
    body = await res.text()
  } catch {
    return { problem: 'offline' }
  }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { problem: 'failed' }
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? { data: parsed.data } : { problem: 'failed' }
}

// 通信の失敗で終わったら、この間をあけて取り直す（最初の 1 回＋3 回。5.8 (7)）
export const RETRY_MS = [1_000, 2_000, 4_000]

// refetchOn: open・resync のほかに、この面が取り直す合図
export function useLoad<T>(path: string, schema: z.ZodType<T>, refetchOn: (s: Signal) => boolean = () => false) {
  const [state, setState] = useState<Loaded<T>>({})
  const current = useRef<AbortController | null>(null)
  const on = useRef(refetchOn)
  on.current = refetchOn

  const load = useCallback(
    (attempt: number) => {
      current.current?.abort()
      const ac = new AbortController()
      current.current = ac
      void get(path, schema, ac.signal).then((r) => {
        if (ac.signal.aborted) return
        // 読めなかったときも、前に読めた中身は残す（5.8 (3)）
        setState((s) => (r.data !== undefined ? r : { ...s, ...r }))
        const wait = RETRY_MS[attempt]
        // 間に別の取り直しが始まった・面を離れたときは打ち切られているので、何もしない
        if (r.problem === 'offline' && wait !== undefined)
          setTimeout(() => ac.signal.aborted || load(attempt + 1), wait)
      })
    },
    [path, schema],
  )
  // 本人の「もう一度読み込む」と合図での取り直しは、数え直す
  const reload = useCallback(() => load(0), [load])

  useEffect(() => {
    setState({})
    reload()
    const l: Listener = (s) => {
      if (s.event === 'open' || s.event === 'resync' || on.current(s)) reload()
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
      current.current?.abort() // 面を離れた後に届いた応答は入れない
    }
  }, [reload])

  return { ...state, reload }
}

// 案件をまたぐ操作（停止・解除）。応答が返るまで呼ぶ側はボタンを押せなくする
export async function send(method: 'POST' | 'DELETE', path: string): Promise<boolean> {
  try {
    const res = await fetch(path, { method, headers: { accept: 'application/json' } })
    // 503 は「止まったが記録できない」。届いているので押し直させず、保存できない帯で知らせる（5.7 (3)(8)）
    return res.ok || res.status === 503
  } catch {
    return false
  }
}
