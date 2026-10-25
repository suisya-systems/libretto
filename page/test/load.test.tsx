// @vitest-environment jsdom
// 取り直しの順序と、読めなかったときの出し分け・つながらなかったときの取り直し（docs/implementation.md 5.8 (1)(3)(7)）
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectEvents, type Loaded, RETRY_MS, useLoad, useResync } from '../src/load.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 手で返す fetch。呼ばれた順に pending に積む
type Call = { path: string; signal: AbortSignal; reply: (r: Response | Error) => void }
let calls: Call[]
// 合図を手で起こす EventSource
let fire: (event: string, data?: unknown) => void
let sources: { readyState: number; closed: boolean }[]
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
    closed = false
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
    close() {
      this.readyState = 2
      this.closed = true
    }
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

function Count(p: { out: (n: number) => void }) {
  p.out(useResync())
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
    [
      '本文の途中で切れたのもつながらない',
      new Response(
        new ReadableStream({
          start: (c) => c.error(new TypeError('network')),
        }),
      ),
      'offline',
    ],
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

// 本物の端末（iPhone のホーム画面・Tailscale）で、通知から開いた案件の面が「つながりません」のまま止まった（GitHub #66）
describe('つながらなかったときの取り直し', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const fail = async (i: number) => act(async () => calls[i]?.reply(new TypeError('network')))
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))

  it('通知から開いた直後の 1 回だけ失敗しても、SSE を待たずに取り直して面を出す', async () => {
    const p = mount('/api/cases/c1')
    await fail(0)
    expect(p.get().problem).toBe('offline') // 失敗はすぐ見せる
    wait(RETRY_MS[0] as number)
    expect(calls).toHaveLength(2)
    await act(async () => calls[1]?.reply(json({ n: 1 })))
    expect(p.get().data).toEqual({ n: 1 })
    expect(p.get().problem).toBeUndefined()
    p.unmount()
  })

  it('最初の 1 回と 3 回の取り直しで止める。本人の取り直しで数え直す', async () => {
    const p = mount('/api/home')
    for (const [i, ms] of RETRY_MS.entries()) {
      await fail(i)
      wait(ms - 1)
      expect(calls).toHaveLength(i + 1)
      wait(1)
      expect(calls).toHaveLength(i + 2)
    }
    await fail(3)
    wait(60_000)
    expect(calls).toHaveLength(4)
    act(() => p.get().reload())
    await fail(4)
    wait(RETRY_MS[0] as number)
    expect(calls).toHaveLength(6)
    p.unmount()
  })

  it('取り直しを待つ間に面を離れたら、取り直さない', async () => {
    const p = mount('/api/home')
    await fail(0)
    p.unmount()
    wait(60_000)
    expect(calls).toHaveLength(1)
  })

  it('取り直しを待つ間に合図で取り直したら、待っていた取り直しは捨てる', async () => {
    const p = mount('/api/home')
    await fail(0)
    act(() => fire('resync'))
    expect(calls).toHaveLength(2)
    wait(60_000)
    expect(calls).toHaveLength(2)
    p.unmount()
  })
})

describe('画面が見えるようになったとき・網に戻ったとき', () => {
  const setVisible = (v: boolean) =>
    Object.defineProperty(document, 'visibilityState', { value: v ? 'visible' : 'hidden', configurable: true })
  afterEach(() => setVisible(true))

  it('つながっている（OPEN）ように見えても SSE を作り直し、つながったら面が取り直す', async () => {
    const p = mount('/api/cases/c1')
    ;(sources[0] as { readyState: number }).readyState = 1
    setVisible(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(sources[0]?.closed).toBe(true)
    expect(sources).toHaveLength(2)
    act(() => fire('open'))
    expect(calls).toHaveLength(2)
    p.unmount()
  })

  it('網に戻ったときも作り直す。見えていないあいだは作り直さない', () => {
    setVisible(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
    })
    expect(sources).toHaveLength(1)
    setVisible(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(sources).toHaveLength(2)
  })

  it('作り直しを待っている（CLOSED）ときは、待たずに今すぐ作り直す', () => {
    vi.useFakeTimers()
    act(() => {
      ;(sources[0] as { readyState: number }).readyState = 2
      fire('error')
    })
    setVisible(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(sources).toHaveLength(2)
    act(() => vi.advanceTimersByTime(60_000))
    expect(sources).toHaveLength(2) // 前の待ちは取り消した
    vi.useRealTimers()
  })

  it('useLoad を通らない取得は、useResync の数で取り直す', () => {
    let n = -1
    const el = document.createElement('div')
    const root = createRoot(el)
    act(() => root.render(<Count out={(k) => (n = k)} />))
    expect(n).toBe(0)
    act(() => fire('open'))
    act(() => fire('resync'))
    act(() => fire('case.changed'))
    expect(n).toBe(2)
    act(() => root.unmount())
  })
})
