// @vitest-environment jsdom
// 依頼の確認（画面 2。docs/implementation.md 6.2.2 (10)・5.3.1）
import type { CaseView } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EntranceFace } from '../src/faces/Entrance.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: CaseView = {
  id: 'c1',
  title: 'ブレストのまとめ',
  state: '入口待ち',
  turn: '本人',
  step: '依頼内容を確認してください',
  mode: '確認しながら',
  origin: { kind: '会話' },
  auto: false,
  version: 0,
  revision: 1,
  costYen: 12,
  costCapYen: 1500,
  materials: [],
  versions: [],
  rounds: { series: 1, used: 0, max: 3 },
  deliveryPlan: {
    targets: [{ kind: 'paste' }],
    fingerprint: 'p',
    visibility: 'あなただけ',
    overwrites: false,
    quotesOthers: false,
  },
  destinationChoices: ['page', 'paste'],
  deliveries: [],
  events: [],
}
const entrance: NonNullable<CaseView['entrance']> = {
  brief: {
    docType: '記事',
    subject: 'ブレストで決まった 3 つの方針と、その理由',
    wanted: [],
    gather: [],
    audience: '一般の読者',
    destinations: [{ kind: 'paste' }, { kind: 'page', shared: false }],
    shape: '2,500 字前後',
    materials: [],
    voice: '合わせない',
    sources: '出典なし',
    mustNot: ['社名の実名'],
  },
  assumptions: [{ id: 'A1', text: '文末はです・ます', why: 'note の読者に合わせる' }],
  undecided: {
    items: [
      {
        id: 'U01',
        question: '読み終えた人に何を持ち帰ってほしいですか？',
        options: [
          { id: 'a', label: 'ブレストで決まったこと' },
          { id: 'b', label: '次に試すこと' },
          { id: 'c', label: 'ブレストで出た案の一覧' },
        ],
        multiple: true,
        recommended: ['a', 'b'],
      },
      {
        id: 'U02',
        question: 'どのくらいの長さにしますか？',
        options: [
          { id: 's', label: '1,000 字ほど' },
          { id: 'l', label: '3,000 字ほど' },
        ],
        multiple: false,
        recommended: ['l'],
      },
    ],
    mismatches: [{ checkId: 'C03', briefSays: '見出しの数は決めていません', checkExpects: '見出しは 4〜5 個' }],
  },
  setFingerprint: 'set1',
  checks: {
    count: 2,
    byCategory: { 分量: 1, 禁止事項: 1 },
    family: '同系統',
    items: [
      {
        id: 'C01',
        category: '分量',
        title: '本文は 2,200〜2,800 字',
        method: '機械',
        phase: '本文',
        hidden: false,
        selfReport: '依頼に書いてある',
        summary: '分量が依頼の範囲から外れています',
        isolation: false,
        minority: true,
      },
      {
        id: 'C02',
        category: '禁止事項',
        title: '隔離の点検',
        method: '機械',
        phase: '本文',
        hidden: true,
        selfReport: '書いていない',
        summary: '隔離の点検',
        isolation: true,
        minority: false,
      },
    ],
  },
}

let respond: (body: Record<string, unknown>) => Response | Promise<Response>
const sent: Record<string, unknown>[] = []
beforeEach(() => {
  sent.length = 0
  respond = () => new Response('{"state":"材料待ち","turn":"libretto","revision":2,"replayed":false}')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/cases/c1/actions') {
      const body = JSON.parse(String(init.body))
      sent.push(body)
      return respond(body)
    }
    if (path === '/api/cases/c1') return new Response(JSON.stringify({ ...base, revision: 5, entrance }))
    if (path.startsWith('/api/conversation')) return new Response('{"messages":[],"pending":false}')
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(c: CaseView, stopped = false, isolation?: 'strong' | 'weak' | 'broken') {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const reload = vi.fn()
  await act(async () => root.render(<EntranceFace c={c} reload={reload} stopped={stopped} isolation={isolation} />))
  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
  return {
    el,
    reload,
    text: () => el.textContent ?? '',
    button,
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    box: (label: string) =>
      [...el.querySelectorAll('[role="checkbox"]')].find((r) =>
        r.closest('label')?.textContent?.includes(label),
      ) as HTMLElement,
    radio: (label: string) =>
      [...el.querySelectorAll('[role="radio"]')].find((r) =>
        r.closest('label')?.textContent?.includes(label),
      ) as HTMLElement,
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('依頼の確認', () => {
  it('書いている間は、いまの 1 行と待つことを出し、承認のボタンを出さない', async () => {
    const r = await render({ ...base, turn: 'libretto', step: '依頼書とチェック項目を書いています' })
    expect(r.text()).toContain('依頼書とチェック項目を書いています')
    expect(r.text()).toContain(W['entrance.waitLead'])
    expect(r.el.querySelector('[role="status"]')).not.toBeNull()
    expect(r.button(W['entrance.approve'])).toBeUndefined()
    // 書いている間も、この依頼だけを取り消せる
    expect(r.button(W['entrance.cancel'])).toBeDefined()
    expect(r.button(W['entrance.revise'])).toBeUndefined()
    r.done()
  })

  it('組があれば依頼書・確認したいこと・違うところ・チェック項目を出し、おすすめが選ばれている', async () => {
    const r = await render({ ...base, entrance })
    for (const s of [
      '一般の読者',
      '貼り付け用の下書き、Web ページ（自分だけ閲覧・履歴付き）',
      '社名の実名',
      '文末はです・ます',
    ])
      expect(r.text()).toContain(s)
    expect(r.text()).toContain('見出しの数は決めていません')
    expect(r.text()).toContain(W['entrance.sameFamily'])
    // 渡してほしいものが無ければ「なし」で、貼り付けの案内は出さない（6.2.4 (5)）
    expect(r.text()).not.toContain(W['entrance.wantedNote'])
    expect(r.box('ブレストで決まったこと').getAttribute('aria-checked')).toBe('true')
    expect(r.radio('3,000 字ほど').getAttribute('aria-checked')).toBe('true')
    expect(r.text()).toContain(W['chat.recommended'])
    // 全項目は折りたたみ。隔離の点検は NG の一言を出さない
    await r.click(r.button(W['entrance.checksShow']))
    expect(r.text()).toContain('本文は 2,200〜2,800 字')
    expect(r.text()).toContain(W['entrance.minority'])
    expect(r.text().match(/NG のとき/g)).toHaveLength(1)
    r.done()
  })

  it('同じ種類の AI が作った理由と、設定への道を出す。別の種類なら出さない（6.1.3 (6)）', async () => {
    const at = (checks: Partial<typeof entrance.checks>) =>
      render({ ...base, entrance: { ...entrance, checks: { ...entrance.checks, ...checks } } })
    for (const why of ['no_key', 'unavailable'] as const) {
      const r = await at({ family: '同系統', fallback: why })
      expect(r.text()).toContain(W[`entrance.fallback.${why}`])
      expect(r.el.querySelector('a[href="/settings"]')?.textContent).toBe(W['entrance.fallback.link'])
      r.done()
    }
    const other = await at({ family: '別系統' })
    expect(other.text()).toContain(W['entrance.otherFamily'])
    expect(other.el.querySelector('a[href="/settings"]')).toBeNull()
    other.done()
  })

  it('文体: 見本から読み取ったこと、読めなかったときの設定への道、過去の文章で確かめた結果（6.3.2 (2)(5)）', async () => {
    const items = entrance.checks.items.map((x) => (x.id === 'C01' ? { ...x, own: 'fail' as const } : x))
    const at = (voice: { docs: number; card: boolean }) =>
      render({ ...base, entrance: { ...entrance, checks: { ...entrance.checks, family: '別系統', items, voice } } })
    const made = await at({ docs: 2, card: true })
    expect(made.text()).toContain(w('entrance.voice.made', { n: 2 }))
    expect(made.el.querySelector('a[href="/settings"]')).toBeNull()
    await made.click(made.button(W['entrance.checksShow']))
    expect(made.text()).toContain(W['entrance.own.fail'])
    expect(made.text()).not.toContain(W['entrance.own.pass'])
    made.done()
    const none = await at({ docs: 0, card: false })
    expect(none.text()).toContain(W['entrance.voice.none'])
    expect(none.el.querySelector('a[href="/settings"]')?.textContent).toBe(W['entrance.voice.link'])
    none.done()
  })

  it('渡してほしいものがあれば依頼書の表に出し、進めると貼り付けてもらうことを書く', async () => {
    const r = await render({
      ...base,
      entrance: { ...entrance, brief: { ...entrance.brief, wanted: ['ブレストのメモ', '当日の写真の説明'] } },
    })
    const row = [...r.el.querySelectorAll('.brief > div')].find(
      (d) => d.querySelector('dt')?.textContent === W['entrance.brief.wanted'],
    )
    expect(row?.querySelector('dd')?.textContent).toBe('ブレストのメモ、当日の写真の説明')
    expect(r.text()).toContain(W['entrance.wantedNote'])
    r.done()
  })

  it('libretto が集めるものがあれば依頼書の表に出し、進めるとウェブで探すことを書く（6.3.3 (7)）', async () => {
    const r = await render({
      ...base,
      entrance: { ...entrance, brief: { ...entrance.brief, gather: ['今月の公式のお知らせ'], sources: '出典付き' } },
    })
    const row = [...r.el.querySelectorAll('.brief > div')].find(
      (d) => d.querySelector('dt')?.textContent === W['entrance.brief.gather'],
    )
    expect(row?.querySelector('dd')?.firstChild?.textContent).toBe('今月の公式のお知らせ')
    // 説明は「libretto が集めるもの」の行の中
    expect(row?.querySelector('.gather-note')?.textContent).toBe(W['entrance.gatherNote'])
    expect(r.el.querySelectorAll('.gather-note')).toHaveLength(1)
    expect(r.text()).not.toContain(W['entrance.wantedNote'])
    r.done()
  })

  it('「これで進める」は答え・進め方・組の指紋・revision・eventId を送り、読み直す', async () => {
    const r = await render({ ...base, entrance })
    await r.click(r.radio(W['entrance.leaveIt']))
    await r.click(r.radio(W['entrance.mode.おまかせ']))
    await r.click(r.button(W['entrance.approve']))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'entrance.approve',
      answers: { U01: ['a', 'b'], U02: '任せる' },
      mode: 'おまかせ',
      setFingerprint: 'set1',
      expectedRevision: 1,
    })
    expect(sent[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.reload).toHaveBeenCalled()
    r.done()
  })

  describe('当てはまるものを全部選べる問い（6.2.6 (4)）', () => {
    const on = (el: HTMLElement) => el.getAttribute('aria-checked')

    it('チェックボックスで、おすすめが全部入っている。1 つだけの問いはラジオのまま', async () => {
      const r = await render({ ...base, entrance })
      expect(r.text()).toContain(W['entrance.pickMany'])
      expect(on(r.box('ブレストで決まったこと'))).toBe('true')
      expect(on(r.box('次に試すこと'))).toBe('true')
      expect(on(r.box('ブレストで出た案の一覧'))).toBe('false')
      expect(r.el.querySelectorAll('.questions .badge')).toHaveLength(3)
      expect(r.radio('1,000 字ほど')).toBeDefined()
      expect(r.el.querySelectorAll('[role="checkbox"]')).toHaveLength(4)
      r.done()
    })

    it('選んだものを配列で送る', async () => {
      const r = await render({ ...base, entrance })
      await r.click(r.box('次に試すこと'))
      await r.click(r.box('ブレストで出た案の一覧'))
      await r.click(r.button(W['entrance.approve']))
      expect(sent[0]?.answers).toEqual({ U01: ['a', 'c'], U02: ['l'] })
      r.done()
    })

    it('おまかせと選択肢は互いに外れる', async () => {
      const r = await render({ ...base, entrance })
      await r.click(r.box(W['entrance.leaveIt']))
      expect(on(r.box('ブレストで決まったこと'))).toBe('false')
      expect(on(r.box('次に試すこと'))).toBe('false')
      expect(on(r.box(W['entrance.leaveIt']))).toBe('true')
      await r.click(r.box('ブレストで出た案の一覧'))
      expect(on(r.box(W['entrance.leaveIt']))).toBe('false')
      await r.click(r.button(W['entrance.approve']))
      expect(sent[0]?.answers).toEqual({ U01: ['c'], U02: ['l'] })
      r.done()
    })

    it('全部外すと、問いとボタンの上に一言出て、進められない', async () => {
      const r = await render({ ...base, entrance })
      expect(r.text()).not.toContain(W['entrance.unanswered'])
      await r.click(r.box('ブレストで決まったこと'))
      await r.click(r.box('次に試すこと'))
      expect(r.text()).toContain(W['entrance.pickNone'])
      expect(r.text()).toContain(W['entrance.unanswered'])
      expect(r.button(W['entrance.approve'])?.disabled).toBe(true)
      await r.click(r.box(W['entrance.leaveIt']))
      expect(r.button(W['entrance.approve'])?.disabled).toBe(false)
      expect(r.text()).not.toContain(W['entrance.pickNone'])
      r.done()
    })
  })

  it('409 は「もう進んでいます」を出して読み直す。応答が無ければ同じ eventId で送り直す', async () => {
    respond = () => new Response('{"reason":"stale"}', { status: 409 })
    const r = await render({ ...base, entrance })
    await r.click(r.button(W['entrance.approve']))
    expect(r.text()).toContain(W['action.moved'])
    expect(r.reload).toHaveBeenCalled()

    vi.useFakeTimers()
    let n = 0
    respond = () => (++n < 3 ? Promise.reject(new Error('offline')) : new Response('{}', { status: 200 }))
    await act(async () => r.button(W['entrance.approve'])?.click())
    // 押している間は押せない
    expect(r.button(W['entrance.approve'])?.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(3100))
    expect(sent.slice(1).map((s) => s.eventId)).toEqual([sent[1]?.eventId, sent[1]?.eventId, sent[1]?.eventId])
    r.done()
  })

  it('取り消しの stale は、取り直した revision と新しい eventId で 1 回だけ送り直す', async () => {
    let n = 0
    respond = () => (++n === 1 ? new Response('{"reason":"stale"}', { status: 409 }) : new Response('{}'))
    const r = await render({ ...base, entrance })
    await r.click(r.button(W['entrance.cancel']))
    await r.click([...document.querySelectorAll('.dialog button')].find((b) => b.textContent === W['entrance.cancel']))
    expect(sent.map((s) => [s.type, s.expectedRevision])).toEqual([
      ['cancel', 1],
      ['cancel', 5],
    ])
    expect(sent[0]?.eventId).not.toBe(sent[1]?.eventId)
    expect(r.text()).not.toContain(W['action.moved'])
    r.done()
  })

  it('整えられなかったとき（組が無く本人の番）は、出し直すと取り消すだけ', async () => {
    const r = await render({ ...base, step: '依頼書とチェック項目を整えられませんでした' })
    expect(r.text()).toContain(W['entrance.failedLead'])
    expect(r.button(W['entrance.approve'])).toBeUndefined()
    await r.click(r.button(W['entrance.revise']))
    const ta = r.el.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, '読者を社内に')
    await act(async () => ta.dispatchEvent(new Event('input', { bubbles: true })))
    await r.click(r.button(W['entrance.reviseSend']))
    expect(sent[0]).toMatchObject({ type: 'entrance.revise', note: '読者を社内に', expectedRevision: 1 })
    r.done()
  })

  it('自動で入った案件は「直して出し直す」と「取り消す」だけ', async () => {
    const r = await render({ ...base, auto: true, turn: 'libretto', step: '自動で進めています', entrance })
    expect(r.button(W['entrance.approve'])).toBeUndefined()
    expect(r.button(W['entrance.talk'])).toBeUndefined()
    expect(r.button(W['entrance.revise'])).toBeDefined()
    expect(r.button(W['entrance.cancel'])).toBeDefined()
    r.done()
  })

  it('「話して内容を変える」で案件の会話欄を開く', async () => {
    const r = await render({ ...base, entrance })
    await r.click(r.button(W['entrance.talk']))
    expect(r.text()).toContain(W['talk.label'])
    r.done()
  })
})

describe('チェック項目を隠す仕組みの帯（8.10 (6)）', () => {
  it('弱いときは帯と設定への道を出し、しっかり隠せているときは出さない', async () => {
    const weak = await render({ ...base, turn: 'libretto' }, false, 'weak')
    expect(weak.text()).toContain(W['band.isolationWeak'])
    expect(weak.el.querySelector('.band-warn a')?.getAttribute('href')).toBe('/settings')
    weak.done()
    const strong = await render({ ...base, turn: 'libretto' }, false, 'strong')
    expect(strong.el.querySelector('.band-warn, .band-stopped')).toBeNull()
    strong.done()
  })
})
