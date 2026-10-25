// 設定の面（画面 7）。連携の節（Google と Slack。docs/implementation.md 6.4 (7)・6.6 (7)）、API キーの節（6.1.3 (6)。値は画面のどこにも出さない。設計書 D17）と
// 自動検出の節（6.9 (10)）と動作環境の確認の節（8.10 (6)）、お知らせの節（6.8 (6)。通知を止める時間帯は 6.8 (14)）、進め方の初期設定の節（6.11 (1)）、端末の節（6.12 (5)）
import {
  type ApiKeyStatus,
  ConnectionsView,
  EntranceDefaults,
  InferenceSettings,
  MaterialRef,
  type Mode,
  NoticePrefs,
  PushStatus,
  type QuietHours,
  QuietHoursInput,
  Settings as SettingsSchema,
} from '@libretto/shared/api'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { z } from 'zod'
import { send, useLoad } from '../load.ts'
import { type DeviceState, deviceState, enable, pushable, syncPush } from '../notify.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { W, type WKey, w } from '../wording.ts'
import { DeviceSection } from './Devices.tsx'
import { ProblemView } from './Pending.tsx'

const Keys = SettingsSchema.shape.apiKeys
type Kind = ApiKeyStatus['kind']
type Notice = 'saved' | 'deleted' | 'invalid' | 'failed'
const NOTICE: Record<Notice, WKey> = {
  saved: 'settings.key.saved',
  deleted: 'settings.key.deleted',
  invalid: 'settings.key.invalid',
  failed: 'settings.key.failed',
}

// 400 は形の誤り、それ以外の失敗（503 の保存できない・届かない）は「保存できませんでした」
async function sendKey(kind: Kind, value?: string): Promise<'ok' | 'invalid' | 'failed'> {
  try {
    const res = await fetch(`/api/settings/keys/${kind}`, {
      method: value === undefined ? 'DELETE' : 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(value !== undefined && { body: JSON.stringify({ value }) }),
    })
    return res.ok ? 'ok' : res.status === 400 ? 'invalid' : 'failed'
  } catch {
    return 'failed'
  }
}

const day = (at: string) => at.slice(0, 10).replaceAll('-', '/')

// 文は種類ごと（用途・未設定の注記・削除の確かめ。7.6 (10)）。Slack は貼るものの名前・保存の後・形の誤りの文も自分のもの（6.6 (7)）
type Texts = Record<'label' | 'use' | 'unsetNote' | 'deleteBody' | 'deleteTitle' | 'input' | 'saved' | 'invalid', WKey>
const KEY_TEXT = {
  deleteTitle: 'settings.key.deleteTitle',
  input: 'settings.key.input',
  saved: 'settings.key.saved',
  invalid: 'settings.key.invalid',
} as const
const TEXT: Record<Kind, Texts> = {
  openai: {
    ...KEY_TEXT,
    label: 'settings.openai.label',
    use: 'settings.openai.use',
    unsetNote: 'settings.openai.unsetNote',
    deleteBody: 'settings.openai.deleteBody',
  },
  jev: {
    ...KEY_TEXT,
    label: 'settings.jev.label',
    use: 'settings.jev.use',
    unsetNote: 'settings.jev.unsetNote',
    deleteBody: 'settings.jev.deleteBody',
  },
  slack: {
    label: 'settings.slack.label',
    use: 'settings.slack.use',
    unsetNote: 'settings.slack.unsetNote',
    deleteBody: 'settings.slack.deleteBody',
    deleteTitle: 'settings.slack.deleteTitle',
    input: 'settings.slack.input',
    saved: 'settings.slack.saved',
    invalid: 'settings.slack.invalid',
  },
  slackBot: {
    label: 'settings.slackDm.label',
    use: 'settings.slackDm.use',
    unsetNote: 'settings.slackDm.unsetNote',
    deleteBody: 'settings.slackDm.deleteBody',
    deleteTitle: 'settings.slackDm.deleteTitle',
    input: 'settings.slackDm.input',
    saved: 'settings.slackDm.saved',
    invalid: 'settings.slackDm.invalid',
  },
}

function KeyRow({ status, reload, children }: { status: ApiKeyStatus; reload: () => void; children?: ReactNode }) {
  const t = TEXT[status.kind]
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const open = !status.set || editing

  const run = async (v?: string) => {
    setBusy(true)
    setNotice(undefined)
    const r = await sendKey(status.kind, v)
    setBusy(false)
    if (r === 'ok') {
      setValue('')
      setEditing(false)
      setNotice(v === undefined ? 'deleted' : 'saved')
      reload()
    } else setNotice(r)
  }

  return (
    <li className="key-row">
      <div className="key-head">
        <div className="grow">
          <h3 className="key-label" id={`${id}-l`}>
            {W[t.label]}
          </h3>
          <p className="muted small">{W[t.use]}</p>
        </div>
        {status.set ? (
          <span className="badge b-done key-status">{w('settings.key.set', { last4: status.last4 })}</span>
        ) : (
          <span className="badge b-off key-status">{W['settings.key.unset']}</span>
        )}
      </div>
      {status.set ? (
        <p className="muted small key-saved">{w('settings.key.savedAt', { at: day(status.savedAt) })}</p>
      ) : (
        <p className="note-warn small">{W[t.unsetNote]}</p>
      )}
      {open ? (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (value.trim()) void run(value)
          }}
        >
          <label className="sr-only" htmlFor={`${id}-i`}>
            {W[t.input]}
          </label>
          <input
            id={`${id}-i`}
            className="grow"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={W[t.input]}
            aria-describedby={notice ? `${id}-n` : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !value.trim()}
            aria-busy={busy || undefined}
          >
            {W['settings.key.save']}
          </button>
          {editing && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setValue('')
                setNotice(undefined)
              }}
            >
              {W['settings.key.cancel']}
            </button>
          )}
        </form>
      ) : (
        <div className="key-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>
            {W['settings.key.replace']}
          </button>
          <Confirm
            trigger={W['settings.key.delete']}
            title={W[t.deleteTitle]}
            body={W[t.deleteBody]}
            confirm={W['settings.key.delete']}
            cancel={W['settings.key.cancel']}
            danger
            busy={busy}
            triggerClass="btn btn-quiet btn-sm"
            onConfirm={() => void run()}
          />
        </div>
      )}
      {notice && (
        <p
          id={`${id}-n`}
          className={notice === 'saved' || notice === 'deleted' ? 'muted small' : 'note-alert small'}
          role={notice === 'saved' || notice === 'deleted' ? 'status' : 'alert'}
        >
          {W[notice === 'saved' || notice === 'invalid' ? t[notice] : NOTICE[notice]]}
        </p>
      )}
      {children}
    </li>
  )
}

// あなたの文体の見本（6.3.2 (10)）。足す・外すたびに一覧の全体を保存する
const Samples = z.object({ samples: z.array(MaterialRef) })
type Sample = z.infer<typeof MaterialRef>
const MAX_SAMPLES = 5
type VoiceNotice = 'saved' | 'invalid' | 'failed'
async function putSamples(samples: { title: string; url: string }[]): Promise<Sample[] | 'invalid' | 'failed'> {
  try {
    const res = await fetch('/api/settings/voice-samples', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ samples }),
    })
    if (res.status === 400) return 'invalid'
    if (!res.ok) return 'failed'
    const r = Samples.safeParse(await res.json())
    return r.success ? r.data.samples : 'failed'
  } catch {
    return 'failed'
  }
}

function VoiceSection({ samples: loaded, reload }: { samples: Sample[]; reload: () => void }) {
  const id = useId()
  // 保存の応答で一覧を置き換える（取り直しを待たずに次の操作をしても、古い一覧から送らない）
  const [samples, setSamples] = useState(loaded)
  useEffect(() => setSamples(loaded), [loaded])
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<VoiceNotice>()
  const save = async (next: { title: string; url: string }[], added: boolean) => {
    setBusy(true)
    setNotice(undefined)
    const r = await putSamples(next)
    setBusy(false)
    setNotice(Array.isArray(r) ? 'saved' : r)
    if (Array.isArray(r)) {
      setSamples(r)
      if (added) {
        setTitle('')
        setUrl('')
      }
      reload()
    }
  }
  const current = samples.map((x) => ({ title: x.title, url: x.where }))
  const full = samples.length >= MAX_SAMPLES
  return (
    <section aria-labelledby="h-voice" className="card pad">
      <h2 id="h-voice">{W['settings.voiceHeading']}</h2>
      <p className="muted small">{W['settings.voice.use']}</p>
      {samples.length ? (
        <ul className="voice-list">
          {samples.map((x, i) => (
            <li key={x.id} className="voice-row">
              <div className="grow">
                <p className="strong">{x.title}</p>
                <a className="muted small voice-url" href={x.where} target="_blank" rel="noopener noreferrer">
                  {x.where}
                </a>
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                disabled={busy}
                aria-label={w('settings.voice.removeLabel', { title: x.title })}
                onClick={() =>
                  void save(
                    current.filter((_, k) => k !== i),
                    false,
                  )
                }
              >
                {W['settings.voice.remove']}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{W['settings.voice.empty']}</p>
      )}
      {full ? (
        <p className="muted small">{W['settings.voice.max']}</p>
      ) : (
        <form
          className="voice-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim() && url.trim()) void save([...current, { title, url }], true)
          }}
        >
          <label className="voice-field">
            <span className="small strong">{W['settings.voice.title']}</span>
            <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="voice-field grow">
            <span className="small strong">{W['settings.voice.url']}</span>
            <input
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder="https://"
              aria-describedby={notice ? `${id}-n` : undefined}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !title.trim() || !url.trim()}
            aria-busy={busy || undefined}
          >
            {W['settings.voice.add']}
          </button>
        </form>
      )}
      {notice && (
        <p
          id={`${id}-n`}
          className={notice === 'saved' ? 'muted small' : 'note-alert small'}
          role={notice === 'saved' ? 'status' : 'alert'}
        >
          {W[`settings.voice.${notice}`]}
        </p>
      )}
    </section>
  )
}

type Isolation = ConnectionsView['isolation']
const LEVEL: Record<Isolation['level'], [string, WKey]> = {
  strong: ['b-done', 'settings.isolation.strong'],
  weak: ['b-you', 'settings.isolation.weak'],
  broken: ['b-alert', 'settings.isolation.broken'],
}
const VERDICT: Record<NonNullable<Isolation['last']>['verdict'], WKey> = {
  hidden: 'settings.probe.hidden',
  visible: 'settings.probe.visible',
  unknown: 'settings.probe.unknown',
}
const pad = (n: number) => String(n).padStart(2, '0')
const when = (at: string) => {
  const d = new Date(at)
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// 文の中の `…` を <code> に（導入のコマンド）
const withCode = (s: string) => s.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={part}>{part}</code> : part))

type Env = ConnectionsView['env']
const AI: Record<Env['ai']['state'], [string, WKey, WKey?, WKey[]?]> = {
  ok: ['b-done', 'settings.ai.ok'],
  missing: [
    'b-alert',
    'settings.ai.missing',
    'settings.ai.missingWhy',
    ['settings.cmd.ai.install', 'settings.cmd.ai.login'],
  ],
  old: ['b-alert', 'settings.ai.old', 'settings.ai.oldWhy', ['settings.cmd.ai.update']],
  signedOut: ['b-alert', 'settings.ai.signedOut', 'settings.ai.signedOutWhy', ['settings.cmd.ai.login']],
}
// 道具の直し方はホストの OS ごと（見ている端末の OS ではない。6.13 (2)）。Windows は WSL2 の中で入れる
const TOOLS: Record<Env['platform'], [WKey, WKey?]> = {
  linux: ['settings.tools.why', 'settings.cmd.tools.linux'],
  darwin: ['settings.tools.why', 'settings.cmd.tools.darwin'],
  win32: ['settings.tools.windows', 'settings.cmd.tools.linux'],
  other: ['settings.tools.other'],
}
const ISOLATION_CMD: Partial<Record<NonNullable<Isolation['cause']>, WKey>> = {
  tools: 'settings.cmd.isolation.tools',
  userns: 'settings.cmd.isolation.userns',
}
const SLACK_APPS = 'https://api.slack.com/apps'
const API_PAGE = (api: string) => `https://console.cloud.google.com/apis/library/${api}.googleapis.com`

// 直し方の 1 行とコピーのボタン（6.13 (2)）
function Command({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="env-cmd">
      <output className="device-url">{cmd}</output>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(cmd)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? W['settings.env.copied'] : W['settings.env.copy']}
      </button>
    </div>
  )
}

function Row({
  label,
  use,
  ok,
  badge,
  children,
}: {
  label: WKey
  use: WKey
  ok: boolean
  badge: [string, WKey]
  children?: ReactNode
}) {
  return (
    <li className="key-row">
      <div className="key-head">
        <div className="grow">
          <h3 className="key-label">{W[label]}</h3>
          <p className="muted small">{W[use]}</p>
        </div>
        <span className={`badge ${badge[0]} key-status`}>{W[badge[1]]}</span>
      </div>
      {!ok && children}
    </li>
  )
}

// 動作環境の確認（8.10 (6)・6.13）。足りないものと何ができなくなるか、直し方の 1 行かリンク、「もう一度確かめる」。
// 結果は裏で届くので、connections.changed で取り直す
function EnvSection({ c, reload }: { c: ConnectionsView; reload: () => void }) {
  const { isolation: v, tools, env, slack, slackDm, google } = c
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const checking = env.checking || busy
  const run = async () => {
    setBusy(true)
    setFailed(false)
    const ok = await send('POST', '/api/checks/run')
    setBusy(false)
    setFailed(!ok)
    reload()
  }
  const cmd = (k: WKey) => w(k, { port: String(env.port) })
  const toolsOk = tools.soffice && tools.pdftoppm
  const [toolsWhy, toolsCmd] = TOOLS[env.platform]
  const [aiBadge, aiLabel, aiWhy, aiCmds] = AI[env.ai.state]
  const isoCmd = v.cause && ISOLATION_CMD[v.cause]
  const slackShown = slack.configured || slackDm.state !== 'none'
  const slackOk = !slack.missingScopes.length && slackDm.state !== 'missingScope'
  const googleShown = google.state === 'connected'
  const gmailOff = google.problem === 'api_disabled'
  const driveOff = google.docsProblem === 'api_disabled' || google.meetProblem === 'api_disabled'
  const missing = [
    env.ai.state !== 'ok',
    v.level !== 'strong',
    !toolsOk,
    slackShown && !slackOk,
    googleShown && (gmailOff || driveOff),
  ].filter(Boolean).length
  const [badge, label] = LEVEL[v.level]
  const status = v.running
    ? W['settings.probe.running']
    : v.last
      ? W[VERDICT[v.last.verdict]]
      : W['settings.probe.never']
  return (
    <section aria-labelledby="h-env" className="card pad">
      <h2 id="h-env">{W['settings.envHeading']}</h2>
      <p className={missing ? 'note-warn small' : 'muted small'} role="status">
        {missing ? w('settings.env.missing', { n: String(missing) }) : W['settings.env.ok']}
      </p>
      <p className="muted small key-saved">{w('settings.env.checkedAt', { at: when(env.checkedAt) })}</p>
      <div className="key-actions">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={checking}
          aria-busy={checking || undefined}
          onClick={() => void run()}
        >
          {W[checking ? 'settings.env.rechecking' : 'settings.env.recheck']}
        </button>
      </div>
      {failed && (
        <p className="note-alert small" role="alert">
          {W['settings.probe.failed']}
        </p>
      )}
      {missing > 0 && <p className="muted small">{W['settings.env.where']}</p>}
      <ul className="key-list">
        <Row label="settings.ai.label" use="settings.ai.use" ok={env.ai.state === 'ok'} badge={[aiBadge, aiLabel]}>
          {aiWhy && <p className="note-alert small">{W[aiWhy]}</p>}
          {aiCmds?.map((k) => (
            <Command key={k} cmd={cmd(k)} />
          ))}
          {env.ai.state === 'missing' && <p className="muted small">{W['settings.env.restart']}</p>}
        </Row>
        <li className="key-row">
          <div className="key-head">
            <div className="grow">
              <h3 className="key-label">{W['settings.isolation.label']}</h3>
              <p className="muted small">{W['settings.isolation.use']}</p>
            </div>
            <span className={`badge ${badge} key-status`}>{W[label]}</span>
          </div>
          {v.level !== 'strong' && v.cause && (
            <p
              className={v.level === 'broken' ? 'note-alert small' : 'note-warn small'}
              role={v.level === 'broken' ? 'alert' : undefined}
            >
              {W[`settings.isolation.why.${v.cause}`]}
            </p>
          )}
          {v.level !== 'strong' && isoCmd && <Command cmd={cmd(isoCmd)} />}
          <p
            className={!v.running && v.last?.verdict === 'visible' ? 'note-alert small' : 'muted small key-saved'}
            role="status"
          >
            {status}
            {!v.running && v.last && `（${w('settings.probe.at', { at: when(v.last.at) })}）`}
          </p>
        </li>
        {/* ファイルを作る道具（6.10 (5)） */}
        <Row
          label="settings.tools.label"
          use="settings.tools.use"
          ok={toolsOk}
          badge={toolsOk ? ['b-done', 'settings.tools.ok'] : ['b-you', 'settings.tools.missing']}
        >
          <p className="note-warn small">{W[toolsWhy]}</p>
          {toolsCmd && <Command cmd={cmd(toolsCmd)} />}
          <p className="muted small">{W['settings.env.restart']}</p>
        </Row>
        {slackShown && (
          <Row
            label="settings.envSlack.label"
            use="settings.envSlack.use"
            ok={slackOk}
            badge={slackOk ? ['b-done', 'settings.envSlack.ok'] : ['b-you', 'settings.envSlack.missing']}
          >
            {slack.missingScopes.length > 0 && (
              <p className="note-warn small">
                {w('settings.envSlack.scopes', { scopes: slack.missingScopes.join(', ') })}
              </p>
            )}
            {slackDm.state === 'missingScope' && <p className="note-warn small">{W['settings.envSlack.bot']}</p>}
            <p className="small">
              <a href={SLACK_APPS} target="_blank" rel="noreferrer">
                {W['settings.envSlack.open']}
              </a>
            </p>
          </Row>
        )}
        {googleShown && (
          <Row
            label="settings.envGoogle.label"
            use="settings.envGoogle.use"
            ok={!gmailOff && !driveOff}
            badge={
              !gmailOff && !driveOff ? ['b-done', 'settings.envGoogle.ok'] : ['b-you', 'settings.envGoogle.missing']
            }
          >
            {gmailOff && <p className="note-warn small">{W['settings.envGoogle.gmail']}</p>}
            {driveOff && <p className="note-warn small">{W['settings.envGoogle.drive']}</p>}
            <p className="muted small">{W['settings.envGoogle.how']}</p>
            <p className="small row-gap">
              {gmailOff && (
                <a href={API_PAGE('gmail')} target="_blank" rel="noreferrer">
                  {W['settings.envGoogle.openGmail']}
                </a>
              )}
              {driveOff && (
                <a href={API_PAGE('drive')} target="_blank" rel="noreferrer">
                  {W['settings.envGoogle.openDrive']}
                </a>
              )}
            </p>
          </Row>
        )}
        {/* スマホから開く（任意。足りないものの数に入れない。6.12 (6)） */}
        <Row
          label="settings.phone.label"
          use="settings.phone.use"
          ok={env.phone}
          badge={env.phone ? ['b-done', 'settings.phone.ok'] : ['b-off', 'settings.phone.unset']}
        >
          <details className="env-steps">
            <summary className="small">{W['settings.phone.lead']}</summary>
            <ol className="small">
              <li>
                {W['settings.phone.step1']}{' '}
                <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                  {W['settings.phone.step1Link']}
                </a>
              </li>
              <li>
                {W['settings.phone.step2']}{' '}
                <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">
                  {W['settings.phone.step2Link']}
                </a>
              </li>
              <li>
                {W['settings.phone.step3']}
                <Command cmd={cmd('settings.cmd.phone.serve')} />
              </li>
              <li>
                {W['settings.phone.step4']}
                <Command cmd={cmd('settings.cmd.phone.start')} />
              </li>
              <li>{W['settings.phone.step5']}</li>
            </ol>
          </details>
        </Row>
      </ul>
    </section>
  )
}

type Google = ConnectionsView['google']
const GOOGLE_STATE: Record<Google['state'] | 'unconfigured', [string, WKey]> = {
  connected: ['b-done', 'settings.google.connected'],
  none: ['b-off', 'settings.google.none'],
  expired: ['b-alert', 'settings.google.expired'],
  unconfigured: ['b-off', 'settings.google.unconfigured'],
}
const RESULTS = ['connected', 'denied', 'failed'] as const
type Result = (typeof RESULTS)[number]

// 連携の戻り（?google=…）は 1 回だけ出し、URL から消す（6.4 (2)）
function useResult(): Result | undefined {
  const [r] = useState(() => {
    const v = new URLSearchParams(window.location.search).get('google')
    if (v) window.history.replaceState(null, '', window.location.pathname)
    return RESULTS.find((x) => x === v)
  })
  return r
}

// OAuth クライアントの保存と削除（6.4 (10)）。400 は読めない JSON、それ以外の失敗は「保存できませんでした」
async function sendClient(json?: string): Promise<{ disconnected: boolean } | 'invalid' | 'failed'> {
  try {
    const res = await fetch('/api/connections/google/client', {
      method: json === undefined ? 'DELETE' : 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(json !== undefined && { body: JSON.stringify({ json }) }),
    })
    if (!res.ok) return res.status === 400 ? 'invalid' : 'failed'
    return json === undefined ? { disconnected: true } : ((await res.json()) as { disconnected: boolean })
  } catch {
    return 'failed'
  }
}

// Google の OAuth クライアント（6.4 (10)）。Google Cloud からダウンロードした JSON をファイルで選ぶか、中身を貼る。
// 値は画面に二度と出さず、保存した日だけを出す（API キーと同じ。設計書 D17）
function GoogleClient({ g, reload }: { g: Google; reload: () => void }) {
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ key: WKey; alert?: boolean }>()
  const open = !g.configured || editing

  const run = async (json?: string) => {
    setBusy(true)
    setNotice(undefined)
    const r = await sendClient(json)
    setBusy(false)
    if (typeof r === 'string')
      return setNotice({ key: r === 'invalid' ? 'settings.google.clientInvalid' : NOTICE.failed, alert: true })
    setValue('')
    setEditing(false)
    setNotice({
      key:
        json === undefined
          ? NOTICE.deleted
          : r.disconnected
            ? 'settings.google.clientSavedReset'
            : g.state === 'none'
              ? 'settings.google.clientSaved'
              : 'settings.google.clientSavedKept',
    })
    reload()
  }

  return (
    <>
      {g.clientSavedAt && (
        <p className="muted small key-saved">{w('settings.google.clientAt', { at: day(g.clientSavedAt) })}</p>
      )}
      {open ? (
        <>
          {editing && g.state !== 'none' && <p className="note-warn small">{W['settings.google.clientReplaceNote']}</p>}
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (value.trim()) void run(value)
            }}
          >
            <label className="btn btn-secondary file-btn">
              {W['settings.google.clientFile']}
              <input
                type="file"
                className="sr-only"
                accept=".json,application/json"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void f.text().then(run)
                }}
              />
            </label>
            <label className="sr-only" htmlFor={`${id}-i`}>
              {W['settings.google.clientInput']}
            </label>
            <input
              id={`${id}-i`}
              className="grow"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={W['settings.google.clientInput']}
              aria-describedby={notice ? `${id}-n` : undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !value.trim()}
              aria-busy={busy || undefined}
            >
              {W['settings.key.save']}
            </button>
            {editing && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false)
                  setValue('')
                  setNotice(undefined)
                }}
              >
                {W['settings.key.cancel']}
              </button>
            )}
          </form>
        </>
      ) : (
        <div className="key-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(true)}>
            {W['settings.key.replace']}
          </button>
          <Confirm
            trigger={W['settings.key.delete']}
            title={W['settings.google.clientDeleteTitle']}
            body={W['settings.google.clientDeleteBody']}
            confirm={W['settings.key.delete']}
            cancel={W['settings.key.cancel']}
            danger
            busy={busy}
            triggerClass="btn btn-quiet btn-sm"
            onConfirm={() => void run()}
          />
        </div>
      )}
      {notice && (
        <p
          id={`${id}-n`}
          className={notice.alert ? 'note-alert small' : 'muted small'}
          role={notice.alert ? 'alert' : 'status'}
        >
          {W[notice.key]}
        </p>
      )}
    </>
  )
}

type SlackView = ConnectionsView['slack']

// Slack の行（6.6 (7)）。トークンは API キーと同じく貼り付けて入れる（オーナー判断 2026-10-25）。下に連携の状態
function SlackRow({ s, status, reload }: { s: SlackView; status: ApiKeyStatus; reload: () => void }) {
  return (
    <KeyRow status={status} reload={reload}>
      {s.state === 'connected' && s.team && s.user && (
        <p className="muted small">{w('settings.slack.as', { team: s.team, user: s.user })}</p>
      )}
      {s.state === 'expired' && (
        <p className="note-alert small" role="alert">
          {W['settings.slack.expiredNote']}
        </p>
      )}
      {s.state === 'connected' && s.missingScopes.length > 0 && (
        <p className="note-warn small" role="status">
          {withCode(w('settings.slack.missing', { scopes: s.missingScopes.map((x) => `\`${x}\``).join('、') }))}
        </p>
      )}
      {s.configured && <p className="muted small">{w('settings.slack.signal', { emoji: s.emoji })}</p>}
      {s.state === 'connected' && s.problem && (
        <p className="note-warn small">{W[`settings.slack.problem.${s.problem}`]}</p>
      )}
      {s.state === 'connected' && s.lastAt && (
        <p className="muted small">{w('settings.slack.lastAt', { at: when(s.lastAt) })}</p>
      )}
    </KeyRow>
  )
}

// 連携の節。Google の行（6.4 (7)）と Slack の行（6.6 (7)）
function LinkSection({
  g,
  s,
  slackKey,
  reload,
}: {
  g: Google
  s: SlackView
  slackKey?: ApiKeyStatus | undefined
  reload: () => void
}) {
  const result = useResult()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<WKey>()
  const [badge, label] = GOOGLE_STATE[g.configured ? g.state : 'unconfigured']
  const connect = async () => {
    setBusy(true)
    setFailed(undefined)
    try {
      const res = await fetch('/api/connections/google/start', {
        method: 'POST',
        headers: { accept: 'application/json' },
      })
      if (res.ok) return window.location.assign(((await res.json()) as { url: string }).url)
    } catch {}
    setBusy(false)
    setFailed('settings.google.startFailed')
  }
  const disconnect = async () => {
    setBusy(true)
    setFailed(undefined)
    const ok = await send('DELETE', '/api/connections/google')
    setBusy(false)
    if (!ok) setFailed('settings.google.disconnectFailed')
    reload()
  }
  return (
    <section aria-labelledby="h-link" className="card pad">
      <h2 id="h-link">{W['settings.linkHeading']}</h2>
      {result && (
        <p className={result === 'connected' ? 'muted small' : 'note-alert small'} role="status">
          {W[`settings.google.result.${result}`]}
        </p>
      )}
      <ul className="key-list">
        <li className="key-row">
          <div className="key-head">
            <div className="grow">
              <h3 className="key-label">{W['settings.google.label']}</h3>
              <p className="muted small">{W['settings.google.use']}</p>
              <p className="muted small">{W['settings.google.useDocs']}</p>
              <p className="muted small">{W['settings.google.useMeet']}</p>
            </div>
            <span className={`badge ${badge} key-status`}>{W[label]}</span>
          </div>
          {!g.configured && <p className="note-warn small">{W['settings.google.unconfiguredNote']}</p>}
          <GoogleClient g={g} reload={reload} />
          {g.state === 'connected' && g.email && (
            <p className="muted small key-saved">{w('settings.google.as', { email: g.email })}</p>
          )}
          {g.state === 'expired' && (
            <p className="note-alert small" role="alert">
              {W['settings.google.expiredNote']}
            </p>
          )}
          {/* 前の連携は Gmail だけ。Google ドキュメントには連携し直して許可を足す（6.5 (2)） */}
          {g.state === 'connected' && !g.docs && (
            <p className="note-warn small" role="status">
              {W['settings.google.docsMissing']}
            </p>
          )}
          {/* 会議メモは Meet のファイルの許可を足して連携し直す（6.7 (1)） */}
          {g.state === 'connected' && !g.meet && (
            <p className="note-warn small" role="status">
              {W['settings.google.meetMissing']}
            </p>
          )}
          {g.configured && <p className="muted small">{w('settings.google.signal', { label: g.label })}</p>}
          {g.configured && <p className="muted small">{W['settings.google.meetSignal']}</p>}
          {g.state === 'connected' && g.labelFound === false && (
            <p className="note-warn small">{w('settings.google.labelMissing', { label: g.label })}</p>
          )}
          {g.state === 'connected' && g.docsProblem && (
            <p className="note-warn small" role="status">
              {W['settings.google.docsApiDisabled']}
            </p>
          )}
          {g.state === 'connected' && g.problem && (
            <p className="note-warn small">{W[`settings.google.problem.${g.problem}`]}</p>
          )}
          {g.state === 'connected' && g.meetProblem && (
            <p className="note-warn small">{W[`settings.google.meetProblem.${g.meetProblem}`]}</p>
          )}
          {g.state === 'connected' && g.lastAt && (
            <p className="muted small">{w('settings.google.lastAt', { at: when(g.lastAt) })}</p>
          )}
          {g.configured && (
            <div className="key-actions">
              {(g.state !== 'connected' || !g.docs || !g.meet) && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    aria-busy={busy || undefined}
                    onClick={() => void connect()}
                  >
                    {W['settings.google.connect']}
                  </button>
                  <span className="muted small">{W['settings.google.pcNote']}</span>
                </>
              )}
              {/* 切れた連携も解除できる（保存した更新トークンを消す） */}
              {g.state !== 'none' && (
                <Confirm
                  trigger={W['settings.google.disconnect']}
                  title={W['settings.google.disconnectTitle']}
                  body={W['settings.google.disconnectBody']}
                  confirm={W['settings.google.disconnect']}
                  cancel={W['settings.google.cancel']}
                  danger
                  busy={busy}
                  triggerClass="btn btn-quiet btn-sm"
                  onConfirm={() => void disconnect()}
                />
              )}
            </div>
          )}
          {failed && (
            <p className="note-alert small" role="alert">
              {W[failed]}
            </p>
          )}
        </li>
        {slackKey && <SlackRow s={s} status={slackKey} reload={reload} />}
      </ul>
    </section>
  )
}

// 自動検出（6.9 (10)）。範囲・上限・表示を 1 回で保存し、今日の件数・見落としの割合・除外したものを出す
const Channels = z.object({ channels: z.array(z.object({ id: z.string(), name: z.string() })) })
const DAYS = [3, 7, 14] as const
type InferNotice = 'saved' | 'invalid' | 'failed'

// Slack と連携しているときだけ出す（チャンネルの一覧を引く）
function SlackChannels({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const channels = useLoad('/api/connections/slack/channels', Channels)
  return (
    <fieldset className="stack">
      <legend className="small strong">{W['settings.infer.slackChannels']}</legend>
      <p className="muted small">{W['settings.infer.slackNote']}</p>
      {channels.data && !channels.data.channels.length && (
        <p className="muted small">{W['settings.infer.slackEmpty']}</p>
      )}
      {channels.data?.channels.map((c) => (
        <label key={c.id} className="row-gap small">
          <input
            type="checkbox"
            checked={value.includes(c.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))}
          />
          #{c.name}
        </label>
      ))}
    </fieldset>
  )
}

function InferSection({
  set: loaded,
  v,
  slack,
  reload,
}: {
  set: InferenceSettings
  v: ConnectionsView['inference']
  slack: boolean
  reload: () => void
}) {
  const id = useId()
  const [set, setSet] = useState(loaded)
  useEffect(() => setSet(loaded), [loaded])
  const [limit, setLimit] = useState(String(loaded.dailyLimit))
  useEffect(() => setLimit(String(loaded.dailyLimit)), [loaded.dailyLimit])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<InferNotice>()
  const save = async () => {
    setBusy(true)
    setNotice(undefined)
    let r: InferNotice = 'failed'
    try {
      const res = await fetch('/api/settings/inference', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...set, dailyLimit: Number(limit) }),
      })
      r = res.ok ? 'saved' : res.status === 400 ? 'invalid' : 'failed'
    } catch {}
    setBusy(false)
    setNotice(r)
    if (r === 'saved') reload()
  }
  const pct = v.recall.total ? Math.round((v.recall.hit / v.recall.total) * 100) : 0
  return (
    <section aria-labelledby="h-infer" className="card pad stack">
      <h2 id="h-infer">{W['settings.infer.heading']}</h2>
      <p className="muted small">{W['settings.infer.use']}</p>
      <p className="small">{w('settings.infer.today', { n: v.classifiedToday, limit: v.dailyLimit })}</p>
      {v.skippedToday !== undefined && (
        <p className="note-warn small">{w('settings.infer.skipped', { n: v.skippedToday })}</p>
      )}
      {v.lastAt && <p className="muted small">{w('settings.infer.lastAt', { at: when(v.lastAt) })}</p>}
      <p className="small">
        {v.recall.total
          ? w('settings.infer.recall', { total: v.recall.total, hit: v.recall.hit, pct })
          : W['settings.infer.recallNone']}
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="voice-field">
          <span className="small strong">{W['settings.infer.gmailDays']}</span>
          <select
            value={set.gmailDays}
            onChange={(e) => setSet({ ...set, gmailDays: Number(e.target.value) as InferenceSettings['gmailDays'] })}
          >
            {DAYS.map((n) => (
              <option key={n} value={n}>
                {w('settings.infer.days', { n })}
              </option>
            ))}
          </select>
        </label>
        {slack && (
          <SlackChannels value={set.slackChannels} onChange={(slackChannels) => setSet({ ...set, slackChannels })} />
        )}
        <label className="voice-field">
          <span className="small strong">{W['settings.infer.limit']}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={limit}
            aria-describedby={`${id}-limit`}
            onChange={(e) => setLimit(e.target.value)}
          />
          <span id={`${id}-limit`} className="muted small">
            {W['settings.infer.limitNote']}
          </span>
        </label>
        <label className="row-gap small">
          <input
            type="checkbox"
            checked={set.showLow}
            onChange={(e) => setSet({ ...set, showLow: e.target.checked })}
          />
          {W['settings.infer.showLow']}
        </label>
        <label className="row-gap small">
          <input type="checkbox" checked={set.useJev} onChange={(e) => setSet({ ...set, useJev: e.target.checked })} />
          {W['settings.infer.useJev']}
        </label>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {W['settings.infer.save']}
          </button>
        </div>
        {notice && (
          <p
            className={notice === 'saved' ? 'muted small' : 'note-alert small'}
            role={notice === 'saved' ? 'status' : 'alert'}
          >
            {W[`settings.infer.${notice}`]}
          </p>
        )}
      </form>
      <h3 className="small strong">{W['settings.infer.excluded']}</h3>
      {v.suppressions.length ? (
        <ul className="voice-list">
          {v.suppressions.map((x) => (
            <li key={x.id} className="voice-row">
              <span className="grow">{x.label}</span>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                aria-label={w('settings.infer.restoreLabel', { label: x.label })}
                onClick={async () => {
                  await send('DELETE', `/api/suppressions/${x.id}`)
                  reload()
                }}
              >
                {W['settings.infer.restore']}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{W['settings.infer.excludedNone']}</p>
      )}
    </section>
  )
}

// お知らせの節（6.8 (6)(7)）。この端末の状態と、出来事ごとに画面の外へ出すか
const DEVICE: Record<DeviceState, [string, WKey]> = {
  on: ['b-done', 'settings.notices.on'],
  off: ['b-off', 'settings.notices.off'],
  denied: ['b-off', 'settings.notices.off'],
  insecure: ['b-alert', 'settings.notices.unavailable'],
  homescreen: ['b-alert', 'settings.notices.unavailable'],
  unavailable: ['b-alert', 'settings.notices.unavailable'],
}
const KINDS = NoticePrefs.keyof().options
type SlackDm = ConnectionsView['slackDm']['state']
const DM_NOTE: Partial<Record<SlackDm, [string, WKey]>> = {
  on: ['muted', 'settings.slackDm.on'],
  noUser: ['note-warn', 'settings.slackDm.noUser'],
  missingScope: ['note-warn', 'settings.slackDm.missingScope'],
  rejected: ['note-alert', 'settings.slackDm.rejected'],
}

// Slack の DM の行（6.8 (8)(12)）。ボットトークンは API キーと同じく貼り付けて入れる。下に Slack で確かめた結果
function SlackDmRow({ status, dm, reload }: { status: ApiKeyStatus; dm: SlackDm; reload: () => void }) {
  const note = DM_NOTE[dm]
  return (
    <KeyRow status={status} reload={reload}>
      {note && <p className={`${note[0]} small`}>{W[note[1]]}</p>}
      {status.set && <p className="muted small">{W['settings.slackDm.openNote']}</p>}
    </KeyRow>
  )
}

function NoticeSection({
  prefs: loaded,
  reload,
  slackBot,
  dm,
  reloadDm,
  children,
}: {
  prefs: NoticePrefs
  reload: () => void
  slackBot?: ApiKeyStatus | undefined
  dm?: SlackDm | undefined
  reloadDm: () => void
  children?: ReactNode
}) {
  const [device, setDevice] = useState(deviceState)
  const push = useLoad('/api/devices/push', PushStatus)
  // 画面を閉じていても届くのは、対応しているブラウザで、許可してホストが登録を持っているとき
  // 開いたときの登録（SSE の open でも送る）が済んでから読み直す
  const { reload: reloadPush } = push
  useEffect(() => void syncPush().then(reloadPush), [reloadPush])
  const openOnly = !pushable() || (device === 'on' && push.data?.subscribed === false)
  // 保存の応答を待たずに続けて押しても、前の入り切りから送る
  const [prefs, setPrefs] = useState(loaded)
  useEffect(() => setPrefs(loaded), [loaded])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<'saved' | 'failed'>()
  const [badge, label] = DEVICE[device]
  const toggle = async (k: (typeof KINDS)[number]) => {
    const next = { ...prefs, [k]: !prefs[k] }
    setBusy(true)
    setSaved(undefined)
    let ok = false
    try {
      const res = await fetch('/api/settings/notices', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(next),
      })
      ok = res.ok
    } catch {}
    setBusy(false)
    setSaved(ok ? 'saved' : 'failed')
    if (ok) {
      setPrefs(next)
      reload()
    }
  }
  return (
    <section aria-labelledby="h-notices" className="card pad">
      <h2 id="h-notices">{W['settings.noticesHeading']}</h2>
      <p className="muted small">{W['settings.notices.use']}</p>
      <ul className="key-list">
        <li className="key-row">
          <div className="key-head">
            <div className="grow">
              <h3 className="key-label">{W['settings.notices.device']}</h3>
              {openOnly && <p className="muted small">{W['settings.notices.openOnly']}</p>}
            </div>
            <span className={`badge ${badge} key-status`}>{W[label]}</span>
          </div>
          {device === 'denied' && <p className="note-warn small">{W['settings.notices.denied']}</p>}
          {device === 'insecure' && <p className="note-warn small">{W['settings.notices.insecure']}</p>}
          {device === 'homescreen' && <p className="note-warn small">{W['settings.notices.homescreen']}</p>}
          {device === 'on' && push.data?.unreachable && (
            <p className="note-warn small">{W['settings.notices.unreachable']}</p>
          )}
          {(device === 'off' || device === 'denied') && (
            <div className="key-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  void enable().then((s) => {
                    setDevice(s)
                    push.reload()
                  })
                }
              >
                {W['settings.notices.enable']}
              </button>
            </div>
          )}
        </li>
        {slackBot && dm && <SlackDmRow status={slackBot} dm={dm} reload={reloadDm} />}
      </ul>
      <fieldset className="revise">
        <legend className="strong small">{W['settings.notices.kinds']}</legend>
        {KINDS.map((k) => (
          <label key={k} className="row-gap">
            <input type="checkbox" checked={prefs[k]} disabled={busy} onChange={() => void toggle(k)} />
            {W[`settings.notices.kind.${k}`]}
          </label>
        ))}
        <p className="muted small">{W['settings.notices.kindsNote']}</p>
      </fieldset>
      {children}
      {saved && (
        <p
          className={saved === 'saved' ? 'muted small' : 'note-alert small'}
          role={saved === 'saved' ? 'status' : 'alert'}
        >
          {W[`settings.notices.${saved}`]}
        </p>
      )}
    </section>
  )
}

// 進め方の初期設定（docs/implementation.md 6.11 (1)）。取り込み元ごとに 2 択
const SOURCES = ['会話', 'gmail', 'slack', 'meet'] as const
function ModeSection({ set: loaded, reload }: { set: EntranceDefaults; reload: () => void }) {
  const [set, setSet] = useState(loaded)
  useEffect(() => setSet(loaded), [loaded])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'failed'>()
  const save = async () => {
    setBusy(true)
    setNotice(undefined)
    let ok = false
    try {
      ok = (
        await fetch('/api/settings/entrance-defaults', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(set),
        })
      ).ok
    } catch {}
    setBusy(false)
    setNotice(ok ? 'saved' : 'failed')
    if (ok) reload()
  }
  return (
    <section aria-labelledby="h-modes" className="card pad stack">
      <h2 id="h-modes">{W['settings.modes.heading']}</h2>
      <p className="muted small">{W['settings.modes.lead']}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {SOURCES.map((k) => (
          <label key={k} className="voice-field">
            <span className="small strong">{W[`home.src.${k}`]}</span>
            <select value={set[k]} onChange={(e) => setSet({ ...set, [k]: e.target.value as Mode })}>
              {(['確認しながら', 'おまかせ'] as const).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {W['settings.modes.save']}
          </button>
        </div>
        {notice && (
          <p
            className={notice === 'saved' ? 'muted small' : 'note-alert small'}
            role={notice === 'saved' ? 'status' : 'alert'}
          >
            {W[`settings.modes.${notice}`]}
          </p>
        )}
      </form>
    </section>
  )
}

// 通知を止める時間帯（6.8 (14)）。既定は止めない。始まりと終わりが同じ時刻は保存できない
function QuietSection({ value, reload }: { value: QuietHours | null; reload: () => void }) {
  const [from, setFrom] = useState(value?.from ?? '')
  const [to, setTo] = useState(value?.to ?? '')
  useEffect(() => {
    setFrom(value?.from ?? '')
    setTo(value?.to ?? '')
  }, [value])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<'saved' | 'failed'>()
  const save = async (quietHours: QuietHours | null) => {
    setBusy(true)
    setSaved(undefined)
    let ok = false
    try {
      const res = await fetch('/api/settings/quiet-hours', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ quietHours }),
      })
      ok = res.ok
    } catch {}
    setBusy(false)
    setSaved(ok ? 'saved' : 'failed')
    if (ok) reload()
  }
  return (
    <fieldset className="revise">
      <legend className="strong small">{W['settings.notices.quiet']}</legend>
      <p className="muted small">{W['settings.notices.quietNote']}</p>
      <p className="small" role="status">
        {value ? w('settings.notices.quietNow', value) : W['settings.notices.quietNone']}
      </p>
      <div className="row-gap">
        <label className="row-gap">
          {W['settings.notices.quietFrom']}
          <input type="time" value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="row-gap">
          {W['settings.notices.quietTo']}
          <input type="time" value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="key-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !from || !to || from === to}
          onClick={() => void save({ from, to })}
        >
          {W['settings.notices.quietSave']}
        </button>
        {value && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void save(null)}>
            {W['settings.notices.quietOff']}
          </button>
        )}
      </div>
      {saved && (
        <p
          className={saved === 'saved' ? 'muted small' : 'note-alert small'}
          role={saved === 'saved' ? 'status' : 'alert'}
        >
          {W[`settings.notices.${saved}`]}
        </p>
      )}
    </fieldset>
  )
}

export function Settings() {
  const keys = useLoad('/api/settings/keys', Keys, (s) => s.event === 'settings.changed')
  const env = useLoad('/api/connections', ConnectionsView, (s) => s.event === 'connections.changed')
  const voice = useLoad('/api/settings/voice-samples', Samples, (s) => s.event === 'settings.changed')
  const infer = useLoad('/api/settings/inference', InferenceSettings, (s) => s.event === 'settings.changed')
  const notices = useLoad('/api/settings/notices', NoticePrefs, (s) => s.event === 'settings.changed')
  const modes = useLoad('/api/settings/entrance-defaults', EntranceDefaults, (s) => s.event === 'settings.changed')
  const quiet = useLoad('/api/settings/quiet-hours', QuietHoursInput, (s) => s.event === 'settings.changed')
  return (
    <section className="face">
      <h1 className="face-title">{W['nav.settings']}</h1>
      {env.data && (
        <LinkSection
          g={env.data.google}
          s={env.data.slack}
          slackKey={keys.data?.slack}
          reload={() => {
            env.reload()
            keys.reload()
          }}
        />
      )}
      {keys.problem && !keys.data ? (
        <ProblemView problem={keys.problem} retry={keys.reload} />
      ) : (
        keys.data && (
          <section aria-labelledby="h-keys" className="card pad">
            <h2 id="h-keys">{W['settings.keysHeading']}</h2>
            <ul className="key-list">
              <KeyRow status={keys.data.openai} reload={keys.reload} />
              <KeyRow status={keys.data.jev} reload={keys.reload} />
            </ul>
          </section>
        )
      )}
      {infer.data && env.data && (
        <InferSection
          set={infer.data}
          v={env.data.inference}
          slack={env.data.slack.state === 'connected'}
          reload={() => {
            infer.reload()
            env.reload()
          }}
        />
      )}
      {notices.data && (
        <NoticeSection
          prefs={notices.data}
          reload={notices.reload}
          slackBot={keys.data?.slackBot}
          dm={env.data?.slackDm.state}
          reloadDm={() => {
            env.reload()
            keys.reload()
          }}
        >
          {quiet.data && <QuietSection value={quiet.data.quietHours} reload={quiet.reload} />}
        </NoticeSection>
      )}
      <DeviceSection />
      {modes.data && <ModeSection set={modes.data} reload={modes.reload} />}
      {voice.data && <VoiceSection samples={voice.data.samples} reload={voice.reload} />}
      {env.data && <EnvSection c={env.data} reload={env.reload} />}
    </section>
  )
}
