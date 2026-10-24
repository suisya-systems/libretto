// @vitest-environment jsdom
// 取り直しの順序と、読めなかったときの出し分け（docs/implementation.md 5.8 (1)(3)）
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectEvents, type Loaded, useLoad } from '../src/load.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 手で返す fetch。呼ばれた順に pending に積む
type Call = { path: string; signal: AbortSignal; reply: (r: Response | Error) => void }
let calls: Call[]
// 合図を手で起こす EventSource
let fire: (event: string, data?: unknown) => void
let sources: { readyState: number }[]
let disconnect: () => void

beforeEach(() => {
  calls = []
  sources = []
  vi.stubGlobal(
    'fetch',
    (path: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({
          path,
          signal: init.signal as AbortSignal,
          reply: (r) => (r instanceof Error ? reject(r) : resolve(r)),
        })
      }),
  )
  class FakeSource {
    static CLOSED = 2
    readyState = 0
    handlers = new Map<string, ((e: MessageEvent) => void)[]>()
    constructor() {
      sources.push(this)
      fire = (event, data = {}) => {
        for (const h of this.handlers.get(event) ?? []) h(new MessageEvent(event, { data: JSON.stringify(data) }))
      }
    }
    addEventListener(event: string, h: (e: MessageEvent) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), h])
    }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeSource)
  disconnect = connectEvents()
})
afterEach(() => {
  disconnect()
  vi.unstubAllGlobals()
})

const Item = z.object({ n: z.number() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Seen = Loaded<{ n: number }> & { reload: () => void }
function Probe(p: { path: string; onCase: boolean; out: (s: Seen) => void }) {
  p.out(useLoad(p.path, Item, (s) => p.onCase && s.event === 'case.changed'))
  return null
}

function mount(path: string, onCase = false) {
  let seen: Seen = { reload: () => {} }
  const el = document.createElement('div')
  let root: Root | undefined
  act(() => {
    root = createRoot(el)
    root.render(<Probe path={path} onCase={onCase} out={(s) => (seen = s)} />)
  })
  return {
    get: () => seen,
    unmount: () => act(() => root?.unmount()),
  }
}

describe('useLoad の取り直し', () => {
  it('前の取得を打ち切り、後から始めた取得だけを入れる（古い応答が後に着いても戻らない）', async () => {
    const p = mount('/api/home', true)
    expect(calls).toHaveLength(1)
    act(() => fire('case.changed', { caseId: 'c1', state: '下書き中', turn: 'libretto' }))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal.aborted).toBe(true)
    await act(async () => calls[1]?.reply(json({ n: 2 })))
    await act(async () => calls[0]?.reply(json({ n: 1 })))
    expect(p.get().data).toEqual({ n: 2 })
    p.unmount()
  })

  it('open と resync では合図の種類に関わらず取り直す', async () => {
    const p = mount('/api/host')
    act(() => fire('case.changed'))
    expect(calls).toHaveLength(1) // この面は case.changed を見ない
    act(() => fire('open'))
    act(() => fire('resync'))
    expect(calls).toHaveLength(3)
    p.unmount()
  })

  it('面を離れたら取得を打ち切り、後から届いた応答を入れない', async () => {
    const p = mount('/api/cases/a')
    const before = p.get()
    p.unmount()
    expect(calls[0]?.signal.aborted).toBe(true)
    await act(async () => calls[0]?.reply(json({ n: 9 })))
    expect(p.get()).toBe(before)
    act(() => fire('resync'))
    expect(calls).toHaveLength(1) // 離れた面は合図を聞かない
  })
})

describe('SSE のつなぎ直し', () => {
  it('閉じられた（CLOSED）ら、空けてから作り直す。つながったら取り直す', async () => {
    vi.useFakeTimers()
    const p = mount('/api/home')
    expect(sources).toHaveLength(1)
    act(() => {
      ;(sources[0] as { readyState: number }).readyState = 2
      fire('error')
    })
    expect(sources).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1_000))
    expect(sources).toHaveLength(2)
    act(() => fire('open'))
    expect(calls).toHaveLength(2)
    p.unmount()
    vi.useRealTimers()
  })

  it('切れただけ（つなぎ直し中）なら作り直さない', () => {
    vi.useFakeTimers()
    act(() => fire('error'))
    act(() => vi.advanceTimersByTime(60_000))
    expect(sources).toHaveLength(1)
    vi.useRealTimers()
  })
})

describe('useLoad の読めなかったとき', () => {
  it.each([
    ['401 はつながっていない', json({ reason: 'not_paired' }, 401), 'not_paired'],
    ['404 は見つからない', json({ reason: 'not_found' }, 404), 'not_found'],
    ['5xx は読み込めない', json({}, 500), 'failed'],
    ['形の違う応答は読み込めない', json({ n: 'x' }), 'failed'],
    ['通信の失敗はつながらない', new TypeError('network'), 'offline'],
  ] as const)('%s', async (_, reply, problem) => {
    const p = mount('/api/home')
    await act(async () => calls[0]?.reply(reply))
    expect(p.get().problem).toBe(problem)
    expect(p.get().data).toBeUndefined()
    p.unmount()
  })

  it('前に読めた中身は、次に読めなくても残す', async () => {
    const p = mount('/api/home')
    await act(async () => calls[0]?.reply(json({ n: 1 })))
    act(() => p.get().reload())
    await act(async () => calls[1]?.reply(new TypeError('network')))
    expect(p.get()).toMatchObject({ data: { n: 1 }, problem: 'offline' })
    act(() => p.get().reload())
    await act(async () => calls[2]?.reply(json({ n: 2 })))
    expect(p.get().problem).toBeUndefined()
    p.unmount()
  })
})
