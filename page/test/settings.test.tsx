// @vitest-environment jsdom
// 設定の面の API キーの節（画面 7。docs/implementation.md 6.1.3 (6)・設計書 D17）
import type { ApiKeyStatus, ConnectionsView, InferenceSettings } from '@libretto/shared/api'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/faces/Settings.tsx'
import { W, w } from '../src/wording.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-test-abcdefgh12345678'
const unset: ApiKeyStatus = { kind: 'openai', set: false }
const set: ApiKeyStatus = { kind: 'openai', set: true, last4: '5678', savedAt: '2026-10-24T17:00:00+09:00' }
let keys: ApiKeyStatus
let conn: ConnectionsView
// Jev の行は既定で設定済み（入力欄とボタンを OpenAI の行だけにする）
let jev: ApiKeyStatus
let respond: (method: string) => Response
const sent: { method: string; path: string; body?: unknown }[] = []
let samples: { id: string; kind: '声の見本'; title: string; where: string }[]
let infer: InferenceSettings
let inferStatus: number
let voiceStatus: number
let modes: Record<string, string>

beforeEach(() => {
  sent.length = 0
  keys = unset
  jev = { kind: 'jev', set: true, last4: 'WXYZ', savedAt: '2026-10-24T17:00:00+09:00' }
  conn = {
    isolation: { level: 'strong', running: false },
    google: { configured: false, state: 'none', label: 'libretto', docs: false, meet: false },
    slack: { configured: false, state: 'none', emoji: 'memo', missingScopes: [] },
    slackDm: { state: 'none' },
    tools: { soffice: true, pdftoppm: true },
    env: {
      platform: 'linux',
      port: 7780,
      checking: false,
      checkedAt: '2026-10-24T05:03:00Z',
      ai: { state: 'ok', version: '2.1.310' },
      phone: true,
    },
    inference: { classifiedToday: 0, dailyLimit: 300, recall: { hit: 0, total: 0 }, suppressions: [] },
  }
  infer = { gmailDays: 7, slackChannels: [], dailyLimit: 300, showLow: true, useJev: true }
  inferStatus = 200
  respond = () => new Response('{}')
  samples = []
  voiceStatus = 200
  modes = { 会話: '確認しながら', gmail: '確認しながら', slack: '確認しながら', meet: '確認しながら' }
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    if (path === '/api/settings/keys')
      return new Response(
        JSON.stringify({
          openai: keys,
          jev,
          slack: { kind: 'slack', set: false },
          slackBot: { kind: 'slackBot', set: false },
        }),
      )
    if (path === '/api/connections') return new Response(JSON.stringify(conn))
    if (path === '/api/settings/voice-samples') {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        sent.push({ method: 'PUT', path, body })
        if (voiceStatus !== 200) return new Response('{}', { status: voiceStatus })
        samples = body.samples.map((x: { title: string; url: string }, i: number) => ({
          id: `V${i + 1}`,
          kind: '声の見本',
          title: x.title,
          where: x.url,
        }))
      }
      return new Response(JSON.stringify({ samples }))
    }
    if (path === '/api/settings/inference') {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        sent.push({ method: 'PUT', path, body })
        if (inferStatus !== 200) return new Response('{}', { status: inferStatus })
        infer = body
      }
      return new Response(JSON.stringify(infer))
    }
    if (path === '/api/settings/entrance-defaults') {
      if (init.method === 'PUT') {
        modes = JSON.parse(String(init.body))
        sent.push({ method: 'PUT', path, body: modes })
      }
      return new Response(JSON.stringify(modes))
    }
    if (path === '/api/connections/slack/channels')
      return new Response(
        JSON.stringify({
          channels: [
            { id: 'C1', name: 'general' },
            { id: 'C2', name: 'docs' },
          ],
        }),
      )
    if (path.startsWith('/api/suppressions/') && init.method) {
      sent.push({ method: init.method, path })
      return new Response(null, { status: 204 })
    }
    if (path === '/api/checks/run' && init.method) {
      sent.push({ method: init.method, path })
      conn = { ...conn, isolation: { ...conn.isolation, running: true } }
      return new Response('{}', { status: 202 })
    }
    if (path.startsWith('/api/connections/google') && init.method) {
      sent.push({ method: init.method, path, ...(init.body && { body: JSON.parse(String(init.body)) }) })
      return respond(init.method)
    }
    if (/^\/api\/settings\/keys\/(openai|jev|slack)$/.test(path) && init.method) {
      sent.push({ method: init.method, path, ...(init.body && { body: JSON.parse(String(init.body)) }) })
      return respond(init.method)
    }
    if (path === '/api/devices') return new Response(JSON.stringify({ devices: [] }))
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(() => vi.unstubAllGlobals())

// 動作環境の確認の節のコピーできる 1 行と、リンクの行き先
const cmds = (el: HTMLElement) =>
  [...(el.querySelector('#h-env')?.parentElement?.querySelectorAll('.env-cmd output') ?? [])].map((o) => o.textContent)
const link = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('a')].find((a) => a.textContent === text)?.getAttribute('href')

async function render() {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => root.render(<Settings />))
  // API キーの節を先に探す（連携の節の Slack の行にも同じ形の欄がある）。scope を渡せばその中だけ
  const button = (label: string, scope = '[aria-labelledby="h-keys"]') =>
    [...el.querySelectorAll(`${scope} button`), ...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined
  const input = (scope = '[aria-labelledby="h-keys"]') =>
    el.querySelector(`${scope} .key-form input:not([type="file"])`) as HTMLInputElement | null
  return {
    el,
    text: () => el.textContent ?? '',
    button,
    input,
    type: async (v: string, scope?: string) => {
      const i = input(scope) as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, v)
      await act(async () => i.dispatchEvent(new Event('input', { bubbles: true })))
    },
    click: (b: Element | undefined | null) => act(async () => (b as HTMLElement).click()),
    done: () => {
      act(() => root.unmount())
      el.remove()
    },
  }
}

describe('API キーの節', () => {
  it('未設定: 欄の名前・未設定・同じ種類の AI が作ることを出し、伏せた入力欄で保存する', async () => {
    const r = await render()
    for (const s of [W['settings.openai.label'], W['settings.key.unset'], W['settings.openai.unsetNote']])
      expect(r.text()).toContain(s)
    expect(r.input()?.type).toBe('password')
    expect(r.button(W['settings.key.save'])?.disabled).toBe(true)
    await r.type(`  ${KEY}`)
    keys = set
    await r.click(r.button(W['settings.key.save']))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/openai', body: { value: `  ${KEY}` } }])
    // 保存したら値を消し、設定済みを読み直す。値は画面のどこにも残らない
    expect(r.text()).toContain(W['settings.key.saved'])
    expect(r.text()).toContain(w('settings.key.set', { last4: '5678' }))
    expect(r.input()).toBeNull()
    expect(r.el.innerHTML).not.toContain(KEY)
    r.done()
  })

  it('設定済み: 末尾 4 文字と保存した日、入れ直すとやめる', async () => {
    keys = set
    const r = await render()
    expect(r.text()).toContain(w('settings.key.set', { last4: '5678' }))
    expect(r.text()).toContain(w('settings.key.savedAt', { at: '2026/10/24' }))
    expect(r.text()).not.toContain(W['settings.openai.unsetNote'])
    expect(r.input()).toBeNull()
    await r.click(r.button(W['settings.key.replace']))
    expect(r.input()).not.toBeNull()
    await r.click(r.button(W['settings.key.cancel']))
    expect(r.input()).toBeNull()
    r.done()
  })

  it('形の誤り（400）と保存できない（503）を、その行の下に一言で出す', async () => {
    const r = await render()
    await r.type('abc')
    respond = () => new Response('{"reason":"invalid"}', { status: 400 })
    await r.click(r.button(W['settings.key.save']))
    expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.key.invalid'])
    respond = () => new Response('{"reason":"storage"}', { status: 503 })
    await r.click(r.button(W['settings.key.save']))
    expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.key.failed'])
    // 失敗したら入力は残す（貼り直させない）
    expect(r.input()?.value).toBe('abc')
    r.done()
  })

  it('削除は確かめてから DELETE を送る', async () => {
    keys = set
    const r = await render()
    await r.click(r.button(W['settings.key.delete']))
    expect(document.querySelector('.dialog')?.textContent).toContain(W['settings.openai.deleteBody'])
    keys = unset
    await r.click(
      [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === W['settings.key.delete']),
    )
    expect(sent.map((s) => s.method)).toEqual(['DELETE'])
    expect(r.text()).toContain(W['settings.key.deleted'])
    expect(r.text()).toContain(W['settings.key.unset'])
    r.done()
  })
})

describe('動作環境の確認（8.10 (6)）', () => {
  it('しっかり隠せていて、まだ確認していない。そろっていれば足りないものの数も警告も出さない', async () => {
    const r = await render()
    expect(r.text()).toContain(W['settings.envHeading'])
    expect(r.text()).toContain(W['settings.env.ok'])
    expect(r.text()).not.toContain(W['settings.env.where'])
    expect(r.text()).toContain(W['settings.isolation.strong'])
    expect(r.text()).toContain(W['settings.probe.never'])
    expect(r.el.querySelector('#h-env')?.parentElement?.querySelector('.note-warn, .note-alert')).toBeNull()
    r.done()
  })

  it('弱い: 原因の文とコピーできる 1 行を出す。前回の結果と日時', async () => {
    conn = {
      ...conn,
      isolation: {
        level: 'weak',
        cause: 'tools',
        running: false,
        last: { at: '2026-10-24T05:03:00Z', verdict: 'unknown' },
      },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.isolation.weak'])
    expect(cmds(r.el)).toEqual(['sudo apt install bubblewrap socat ripgrep'])
    expect(r.text()).toContain(w('settings.env.missing', { n: 1 }))
    expect(r.text()).toContain(W['settings.probe.unknown'])
    expect(r.text()).toMatch(/2026\/10\/24 \d{2}:03 に確認/)
    r.done()
  })

  it('見えた結果は警告で出す。動かないときは原因を警告で出す', async () => {
    conn = {
      ...conn,
      isolation: {
        level: 'broken',
        cause: 'network',
        running: false,
        last: { at: '2026-10-24T05:03:00Z', verdict: 'visible' },
      },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.isolation.broken'])
    expect(r.el.querySelector('.note-alert[role="alert"]')?.textContent).toBe(W['settings.isolation.why.network'])
    expect(r.text()).toContain(W['settings.probe.visible'])
    expect(r.el.querySelector('.note-alert[role="status"]')?.textContent).toContain(W['settings.probe.visible'])
    r.done()
  })

  it('もう一度確かめる: POST して、確かめている間は押せない。終われば直った行は済みの印になる', async () => {
    conn = { ...conn, tools: { soffice: false, pdftoppm: false } }
    const r = await render()
    expect(r.text()).toContain(W['settings.tools.why'])
    conn = { ...conn, env: { ...conn.env, checking: true } }
    await r.click(r.button(W['settings.env.recheck']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/checks/run' }])
    await vi.waitFor(() => expect(r.button(W['settings.env.rechecking'])?.disabled).toBe(true))
    r.done()
    // 確かめ終わって取り直すと（connections.changed）、直った行は済みの印で、直し方は消える
    conn = { ...conn, tools: { soffice: true, pdftoppm: true }, env: { ...conn.env, checking: false } }
    const again = await render()
    expect(again.text()).toContain(W['settings.env.ok'])
    expect(again.text()).not.toContain(W['settings.tools.why'])
    expect(again.text()).toContain(W['settings.tools.ok'])
    expect(again.button(W['settings.env.recheck'])?.disabled).toBe(false)
    again.done()
  })

  it('道具が無い: 何ができなくなるかと、ホストの OS の 1 行（Linux は apt、Mac は brew、Windows は WSL2 の中で apt）', async () => {
    conn = { ...conn, tools: { soffice: false, pdftoppm: true } }
    let r = await render()
    expect(r.text()).toContain(W['settings.tools.missing'])
    expect(r.text()).toContain(W['settings.env.where'])
    expect(cmds(r.el)).toEqual(['sudo apt install libreoffice poppler-utils'])
    r.done()
    conn = { ...conn, env: { ...conn.env, platform: 'darwin' } }
    r = await render()
    expect(cmds(r.el)).toEqual(['brew install --cask libreoffice && brew install poppler'])
    r.done()
    conn = { ...conn, env: { ...conn.env, platform: 'win32' } }
    r = await render()
    expect(r.text()).toContain(W['settings.tools.windows'])
    expect(cmds(r.el)).toEqual(['sudo apt install libreoffice poppler-utils'])
    r.done()
  })

  it('AI: 入っていない・古い・ログインが切れたときの 1 行。コピーのボタンで写す', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    conn = { ...conn, env: { ...conn.env, ai: { state: 'missing' } } }
    let r = await render()
    expect(r.text()).toContain(W['settings.ai.missingWhy'])
    expect(cmds(r.el)).toEqual(['npm install -g @anthropic-ai/claude-code', 'claude auth login'])
    await r.click(r.button(W['settings.env.copy']))
    expect(writeText).toHaveBeenCalledWith('npm install -g @anthropic-ai/claude-code')
    expect(r.text()).toContain(W['settings.env.copied'])
    r.done()
    conn = { ...conn, env: { ...conn.env, ai: { state: 'old', version: '2.0.0' } } }
    r = await render()
    expect(cmds(r.el)).toEqual(['claude update'])
    r.done()
    conn = { ...conn, env: { ...conn.env, ai: { state: 'signedOut', version: '2.1.310' } } }
    r = await render()
    expect(r.text()).toContain(W['settings.ai.signedOutWhy'])
    expect(cmds(r.el)).toEqual(['claude auth login'])
    r.done()
  })

  it('Slack の権限: 足りない名前と設定画面へのリンク。入れていなければ行を出さない', async () => {
    let r = await render()
    expect(r.text()).not.toContain(W['settings.envSlack.label'])
    r.done()
    conn = {
      ...conn,
      slack: { ...conn.slack, configured: true, state: 'connected', missingScopes: ['search:read'] },
      slackDm: { state: 'missingScope' },
    }
    r = await render()
    expect(r.text()).toContain(w('settings.envSlack.scopes', { scopes: 'search:read' }))
    expect(r.text()).toContain(W['settings.envSlack.bot'])
    expect(link(r.el, W['settings.envSlack.open'])).toBe('https://api.slack.com/apps')
    expect(r.text()).toContain(w('settings.env.missing', { n: 1 }))
    r.done()
  })

  it('Google の API: 有効でない API のページへのリンク', async () => {
    conn = {
      ...conn,
      google: { ...conn.google, configured: true, state: 'connected', docs: true, docsProblem: 'api_disabled' },
    }
    const r = await render()
    expect(r.text()).toContain(W['settings.envGoogle.drive'])
    expect(r.text()).not.toContain(W['settings.envGoogle.gmail'])
    expect(link(r.el, W['settings.envGoogle.openDrive'])).toBe(
      'https://console.cloud.google.com/apis/library/drive.googleapis.com',
    )
    r.done()
  })

  it('スマホから開く: 未設定なら手順を出し、ポートは動いているホストのもの。足りないものの数には入れない', async () => {
    conn = { ...conn, env: { ...conn.env, phone: false, port: 7790 } }
    const r = await render()
    expect(r.text()).toContain(W['settings.phone.unset'])
    expect(r.text()).toContain(W['settings.env.ok'])
    expect(cmds(r.el)).toEqual([
      'tailscale serve --bg 7790',
      'LIBRETTO_ORIGIN=http://127.0.0.1:7790,https://<PC の名前>.<tailnet の名前>.ts.net npm start',
    ])
    expect(link(r.el, W['settings.phone.step2Link'])).toBe('https://login.tailscale.com/admin/dns')
    r.done()
  })
})

describe('Jev の API キーの行（7.6 (10)）', () => {
  it('未設定: 欄の名前と、判定を同じ種類の AI が行うことを出し、jev に保存する', async () => {
    keys = set
    jev = { kind: 'jev', set: false }
    const r = await render()
    for (const s of [W['settings.jev.label'], W['settings.jev.use'], W['settings.jev.unsetNote']])
      expect(r.text()).toContain(s)
    expect(r.text()).not.toContain(W['settings.openai.unsetNote'])
    await r.type(KEY)
    await r.click(r.button(W['settings.key.save']))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/jev', body: { value: KEY } }])
    r.done()
  })
})

describe('あなたの文体の見本（6.3.2 (10)）', () => {
  const field = (el: HTMLElement, caption: string) =>
    [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes(caption))
      ?.querySelector('input') as HTMLInputElement
  const typeIn = async (i: HTMLInputElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, v)
    await act(async () => i.dispatchEvent(new Event('input', { bubbles: true })))
  }

  it('題と URL を登録すると一覧の全体を保存し、外すと除いた一覧を保存する', async () => {
    const v = await render()
    expect(v.text()).toContain(W['settings.voiceHeading'])
    expect(v.text()).toContain(W['settings.voice.empty'])
    expect(v.button(W['settings.voice.add'])?.disabled).toBe(true)
    await typeIn(field(v.el, W['settings.voice.title']), '振り返りの話')
    await typeIn(field(v.el, W['settings.voice.url']), 'https://example.com/a')
    await v.click(v.button(W['settings.voice.add']))
    expect(sent.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/settings/voice-samples',
      body: { samples: [{ title: '振り返りの話', url: 'https://example.com/a' }] },
    })
    expect(v.text()).toContain(W['settings.voice.saved'])
    expect(v.text()).toContain('https://example.com/a')
    const remove = v.el.querySelector(`[aria-label="${w('settings.voice.removeLabel', { title: '振り返りの話' })}"]`)
    await v.click(remove)
    expect(sent.at(-1)?.body).toEqual({ samples: [] })
    v.done()
  })

  it('形の誤りは入れ直しを促し、5 件あれば登録の欄を出さない', async () => {
    voiceStatus = 400
    const v = await render()
    await typeIn(field(v.el, W['settings.voice.title']), 't')
    await typeIn(field(v.el, W['settings.voice.url']), 'ftp://example.com')
    await v.click(v.button(W['settings.voice.add']))
    expect(v.el.querySelector('[role="alert"]')?.textContent).toBe(W['settings.voice.invalid'])
    v.done()

    samples = Array.from({ length: 5 }, (_, i) => ({
      id: `V${i + 1}`,
      kind: '声の見本' as const,
      title: `t${i}`,
      where: `https://example.com/${i}`,
    }))
    const full = await render()
    expect(full.text()).toContain(W['settings.voice.max'])
    expect(full.button(W['settings.voice.add'])).toBeUndefined()
    full.done()
  })
})

describe('連携の節（Google。6.4 (7)）', () => {
  const google = (g: Partial<ConnectionsView['google']>) => {
    conn = { ...conn, google: { configured: true, state: 'none', label: 'libretto', docs: true, meet: true, ...g } }
  }
  const row = (el: HTMLElement) => el.querySelector('#h-link')?.parentElement as HTMLElement

  const G = '[aria-labelledby="h-link"] li:first-child'
  const CLIENT = '{"installed":{"client_id":"1-abc.apps.googleusercontent.com","client_secret":"GOCSPX-secret"}}'

  it('設定が無い: 入れ方を出し、連携するは出さない。貼った JSON を保存し、読めなければ直し方を出す', async () => {
    const r = await render()
    const g = row(r.el)
    expect(g.textContent).toContain(W['settings.google.unconfigured'])
    expect(g.textContent).toContain(W['settings.google.unconfiguredNote'])
    expect(g.textContent).not.toContain('.env.local')
    expect(r.button(W['settings.google.connect'])).toBeUndefined()
    expect(g.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe('.json,application/json')
    expect(r.input(G)?.type).toBe('password')
    await r.type('{"web":{}}', G)
    respond = () => new Response('{"reason":"invalid"}', { status: 400 })
    await r.click(r.button(W['settings.key.save'], G))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/connections/google/client', body: { json: '{"web":{}}' } }])
    expect(r.el.querySelector(`${G} [role="alert"]`)?.textContent).toBe(W['settings.google.clientInvalid'])
    await r.type(CLIENT, G)
    respond = () => new Response('{"disconnected":false}')
    google({ clientSavedAt: '2026-10-25T10:00:00+09:00' })
    await r.click(r.button(W['settings.key.save'], G))
    expect(sent.at(-1)).toEqual({ method: 'PUT', path: '/api/connections/google/client', body: { json: CLIENT } })
    expect(r.text()).toContain(W['settings.google.clientSaved'])
    expect(r.text()).toContain(w('settings.google.clientAt', { at: '2026/10/25' }))
    expect(r.input(G)).toBeNull()
    expect(r.el.innerHTML).not.toContain('GOCSPX')
    r.done()
  })

  it('ファイルを選ぶと、その中身をそのまま保存する', async () => {
    respond = () => new Response('{"disconnected":false}')
    const r = await render()
    const file = row(r.el).querySelector('input[type="file"]') as HTMLInputElement
    const f = new File([CLIENT], 'client_secret_1-abc.json', { type: 'application/json' })
    Object.defineProperty(file, 'files', { value: [f], configurable: true })
    await act(async () => {
      file.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((ok) => setTimeout(ok, 0))
    })
    expect(sent).toEqual([{ method: 'PUT', path: '/api/connections/google/client', body: { json: CLIENT } }])
    r.done()
  })

  it('設定済みで連携している: 入れ直すと今の連携を解除する注記。削除は確かめてから DELETE', async () => {
    google({ state: 'connected', email: 'me@example.com', clientSavedAt: '2026-10-25T10:00:00+09:00' })
    const r = await render()
    const g = row(r.el)
    expect(g.textContent).toContain(w('settings.google.clientAt', { at: '2026/10/25' }))
    expect(r.input(G)).toBeNull()
    await r.click(r.button(W['settings.key.replace'], G))
    expect(g.textContent).toContain(W['settings.google.clientReplaceNote'])
    respond = () => new Response('{"disconnected":true}')
    await r.type(CLIENT, G)
    await r.click(r.button(W['settings.key.save'], G))
    expect(r.text()).toContain(W['settings.google.clientSavedReset'])
    respond = () => new Response(null, { status: 204 })
    await r.click(r.button(W['settings.key.delete'], G))
    const dialog = document.querySelector('.dialog') as HTMLElement
    expect(dialog.textContent).toContain(W['settings.google.clientDeleteBody'])
    await r.click([...dialog.querySelectorAll('button')].at(-1))
    expect(sent.at(-1)).toEqual({ method: 'DELETE', path: '/api/connections/google/client' })
    r.done()
  })

  it('未連携: できることの文・目印・PC で行う注記。連携するで始めて、返った URL へ移る', async () => {
    google({})
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, search: '', pathname: '/settings' })
    respond = () => new Response(JSON.stringify({ url: 'https://accounts.example/auth?x=1' }))
    const r = await render()
    const g = row(r.el)
    for (const s of [W['settings.google.use'], W['settings.google.none'], W['settings.google.pcNote']])
      expect(g.textContent).toContain(s)
    expect(g.textContent).toContain(w('settings.google.signal', { label: 'libretto' }))
    await r.click(r.button(W['settings.google.connect']))
    expect(sent).toEqual([{ method: 'POST', path: '/api/connections/google/start' }])
    expect(assign).toHaveBeenCalledWith('https://accounts.example/auth?x=1')
    r.done()
  })

  it('連携済み: アドレス・ラベルが無い注記・混雑の注記。解除は確かめてから DELETE', async () => {
    google({ state: 'connected', email: 'me@example.com', labelFound: false, problem: 'rate_limited' })
    respond = () => new Response(null, { status: 204 })
    const r = await render()
    const g = row(r.el)
    expect(g.textContent).toContain(w('settings.google.as', { email: 'me@example.com' }))
    expect(g.textContent).toContain(w('settings.google.labelMissing', { label: 'libretto' }))
    expect(g.textContent).toContain(W['settings.google.problem.rate_limited'])
    expect(r.button(W['settings.google.connect'])).toBeUndefined()
    await r.click(r.button(W['settings.google.disconnect']))
    const dialog = document.querySelector('.dialog') as HTMLElement
    expect(dialog.textContent).toContain(W['settings.google.disconnectBody'])
    await r.click(r.button(W['settings.google.disconnect']) && [...dialog.querySelectorAll('button')].at(-1))
    expect(sent).toEqual([{ method: 'DELETE', path: '/api/connections/google' }])
    r.done()
  })

  it('会議メモ: できることの文と目印。Meet の許可が無ければ連携し直しを促し、Drive API が無効の文を出す（6.7 (1)(5)）', async () => {
    google({ state: 'connected', email: 'me@example.com', meet: false, meetProblem: 'api_disabled' })
    const r = await render()
    const g = row(r.el)
    for (const s of [
      W['settings.google.useMeet'],
      W['settings.google.meetSignal'],
      W['settings.google.meetMissing'],
      W['settings.google.meetProblem.api_disabled'],
    ])
      expect(g.textContent).toContain(s)
    expect(r.button(W['settings.google.connect'])).toBeDefined()
    r.done()
  })

  it('切れた: 連携し直す注記を出し、もう一度連携すると解除の両方を出す', async () => {
    google({ state: 'expired', email: 'me@example.com' })
    const r = await render()
    expect(row(r.el).textContent).toContain(W['settings.google.expiredNote'])
    expect(r.button(W['settings.google.connect'])).toBeDefined()
    expect(r.button(W['settings.google.disconnect'])).toBeDefined()
    r.done()
  })

  it('戻りの 1 行は 1 回だけ出し、URL から消す', async () => {
    google({ state: 'connected', email: 'me@example.com' })
    window.history.replaceState(null, '', '/settings?google=connected')
    const r = await render()
    expect(row(r.el).textContent).toContain(W['settings.google.result.connected'])
    expect(window.location.search).toBe('')
    r.done()
  })
})

describe('Slack の行（6.6 (2)(7)）', () => {
  const LINK = '[aria-labelledby="h-link"] li:last-child'
  it('未設定: 作り方の注記と伏せた入力欄。貼ったトークンを slack に保存し、形の誤りは Slack の文で出す', async () => {
    const r = await render()
    expect(r.text()).toContain(W['settings.slack.unsetNote'])
    expect(r.input(LINK)?.type).toBe('password')
    expect(r.input(LINK)?.placeholder).toBe(W['settings.slack.input'])
    await r.type('xoxb-bot-token', LINK)
    respond = () => new Response('{"reason":"invalid"}', { status: 400 })
    await r.click(r.button(W['settings.key.save'], LINK))
    expect(sent).toEqual([{ method: 'PUT', path: '/api/settings/keys/slack', body: { value: 'xoxb-bot-token' } }])
    expect(r.el.querySelector(`${LINK} [role="alert"]`)?.textContent).toBe(W['settings.slack.invalid'])
    r.done()
  })

  it('足りない権限は名前で、使えないトークンは直し方を出す', async () => {
    conn = {
      ...conn,
      slack: {
        configured: true,
        state: 'connected',
        team: 'ACME',
        user: 'honnin',
        emoji: 'memo',
        missingScopes: ['users:read'],
      },
    }
    let r = await render()
    expect(r.text()).toContain(w('settings.slack.as', { team: 'ACME', user: 'honnin' }))
    expect(r.text()).toContain('users:read')
    expect(r.text()).toContain('User Token Scopes')
    r.done()
    conn = { ...conn, slack: { configured: true, state: 'expired', emoji: 'memo', missingScopes: [] } }
    r = await render()
    expect(r.text()).toContain(W['settings.slack.expiredNote'])
    r.done()
  })
})

describe('自動検出の節（6.9 (10)）', () => {
  const scope = '[aria-labelledby="h-infer"]'
  const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v)
    await act(async () =>
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })),
    )
  }

  it('今日の件数・見られなかった数・見落としの割合・除外したもの（戻すは DELETE）', async () => {
    conn.inference = {
      classifiedToday: 12,
      dailyLimit: 300,
      skippedToday: 4,
      recall: { hit: 9, total: 10 },
      suppressions: [{ id: 3, kind: 'sender', label: 'news@example.com', addedAt: '2026-10-24T10:00:00+09:00' }],
    }
    const r = await render()
    const sec = r.el.querySelector(scope)?.textContent ?? ''
    expect(sec).toContain(w('settings.infer.today', { n: 12, limit: 300 }))
    expect(sec).toContain(w('settings.infer.skipped', { n: 4 }))
    expect(sec).toContain(w('settings.infer.recall', { total: 10, hit: 9, pct: 90 }))
    expect(sec).toContain('news@example.com')
    await r.click(
      r.el.querySelector(
        `${scope} button[aria-label="${w('settings.infer.restoreLabel', { label: 'news@example.com' })}"]`,
      ),
    )
    expect(sent).toContainEqual({ method: 'DELETE', path: '/api/suppressions/3' })
    r.done()
  })

  it('範囲・上限・表示を 1 回で保存する。Slack と連携していればチャンネルを選べる。形の誤りは直し方', async () => {
    conn.slack = { ...conn.slack, configured: true, state: 'connected' }
    const r = await render()
    expect(r.text()).toContain(W['settings.infer.recallNone'])
    const sec = r.el.querySelector(scope) as HTMLElement
    await setValue(sec.querySelector('select') as HTMLSelectElement, '14')
    await setValue(sec.querySelector('input[type="number"]') as HTMLInputElement, '0')
    const boxes = [...sec.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    // チャンネル 2 つ、可能性が低い候補、Jev
    expect(boxes).toHaveLength(4)
    await r.click(boxes[1])
    await r.click(boxes[2])
    await r.click(r.button(W['settings.infer.save'], scope))
    expect(sent.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/settings/inference',
      body: { gmailDays: 14, slackChannels: ['C2'], dailyLimit: 0, showLow: false, useJev: true },
    })
    expect(sec.textContent).toContain(W['settings.infer.saved'])
    inferStatus = 400
    await r.click(r.button(W['settings.infer.save'], scope))
    expect(sec.textContent).toContain(W['settings.infer.invalid'])
    r.done()
  })

  it('Slack と連携していなければチャンネルの欄を出さない', async () => {
    const r = await render()
    expect(r.text()).not.toContain(W['settings.infer.slackChannels'])
    r.done()
  })
})

describe('進め方の初期設定の節（6.11 (1)）', () => {
  it('取り込み元ごとに 2 択で、保存すると全部を PUT する', async () => {
    const r = await render()
    const scope = '[aria-labelledby="h-modes"]'
    const sec = r.el.querySelector(scope) as HTMLElement
    expect(sec.textContent).toContain(W['settings.modes.lead'])
    const selects = [...sec.querySelectorAll('select')] as HTMLSelectElement[]
    expect(selects).toHaveLength(4)
    const gmail = selects[1] as HTMLSelectElement
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(gmail, 'おまかせ')
    await act(async () => gmail.dispatchEvent(new Event('change', { bubbles: true })))
    await r.click(r.button(W['settings.modes.save'], scope))
    expect(sent.at(-1)).toEqual({
      method: 'PUT',
      path: '/api/settings/entrance-defaults',
      body: { 会話: '確認しながら', gmail: 'おまかせ', slack: '確認しながら', meet: '確認しながら' },
    })
    expect(sec.textContent).toContain(W['settings.modes.saved'])
    r.done()
  })
})
