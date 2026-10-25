// 設定の面（画面 7）。連携の節（Google。docs/implementation.md 6.4 (7)）、API キーの節（6.1.3 (6)。値は画面のどこにも出さない。設計書 D17）と
// 動作環境の確認の節（8.10 (6)）
import { type ApiKeyStatus, ConnectionsView, MaterialRef, Settings as SettingsSchema } from '@libretto/shared/api'
import { useEffect, useId, useState } from 'react'
import { z } from 'zod'
import { send, useLoad } from '../load.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { W, type WKey, w } from '../wording.ts'
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

// 文は種類ごと（用途・未設定の注記・削除の確かめ。7.6 (10)）
const TEXT: Record<Kind, Record<'label' | 'use' | 'unsetNote' | 'deleteBody', WKey>> = {
  openai: {
    label: 'settings.openai.label',
    use: 'settings.openai.use',
    unsetNote: 'settings.openai.unsetNote',
    deleteBody: 'settings.openai.deleteBody',
  },
  jev: {
    label: 'settings.jev.label',
    use: 'settings.jev.use',
    unsetNote: 'settings.jev.unsetNote',
    deleteBody: 'settings.jev.deleteBody',
  },
}

function KeyRow({ status, reload }: { status: ApiKeyStatus; reload: () => void }) {
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
            {W['settings.key.input']}
          </label>
          <input
            id={`${id}-i`}
            className="grow"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={W['settings.key.input']}
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
            title={W['settings.key.deleteTitle']}
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
          {W[NOTICE[notice]]}
        </p>
      )}
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

// 動作環境の確認（8.10 (6)）。結果は裏で届くので、connections.changed で取り直す
function EnvSection({ v, reload }: { v: Isolation; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [badge, label] = LEVEL[v.level]
  const running = v.running || busy
  const run = async () => {
    setBusy(true)
    setFailed(false)
    const ok = await send('POST', '/api/checks/run')
    setBusy(false)
    setFailed(!ok)
    reload()
  }
  const status = v.running
    ? W['settings.probe.running']
    : v.last
      ? W[VERDICT[v.last.verdict]]
      : W['settings.probe.never']
  return (
    <section aria-labelledby="h-env" className="card pad">
      <h2 id="h-env">{W['settings.envHeading']}</h2>
      <ul className="key-list">
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
              {withCode(W[`settings.isolation.why.${v.cause}`])}
            </p>
          )}
          <p
            className={!v.running && v.last?.verdict === 'visible' ? 'note-alert small' : 'muted small key-saved'}
            role="status"
          >
            {status}
            {!v.running && v.last && `（${w('settings.probe.at', { at: when(v.last.at) })}）`}
          </p>
          <div className="key-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={running}
              aria-busy={running || undefined}
              onClick={() => void run()}
            >
              {W['settings.probe.run']}
            </button>
          </div>
          {failed && (
            <p className="note-alert small" role="alert">
              {W['settings.probe.failed']}
            </p>
          )}
        </li>
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

// 連携の節。Google の行（6.4 (7)）
function LinkSection({ g, reload }: { g: Google; reload: () => void }) {
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
            </div>
            <span className={`badge ${badge} key-status`}>{W[label]}</span>
          </div>
          {!g.configured && <p className="note-warn small">{withCode(W['settings.google.unconfiguredNote'])}</p>}
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
          {g.configured && <p className="muted small">{w('settings.google.signal', { label: g.label })}</p>}
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
          {g.state === 'connected' && g.lastAt && (
            <p className="muted small">{w('settings.google.lastAt', { at: when(g.lastAt) })}</p>
          )}
          {g.configured && (
            <div className="key-actions">
              {(g.state !== 'connected' || !g.docs) && (
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
      </ul>
    </section>
  )
}

export function Settings() {
  const keys = useLoad('/api/settings/keys', Keys, (s) => s.event === 'settings.changed')
  const env = useLoad('/api/connections', ConnectionsView, (s) => s.event === 'connections.changed')
  const voice = useLoad('/api/settings/voice-samples', Samples, (s) => s.event === 'settings.changed')
  return (
    <section className="face">
      <h1 className="face-title">{W['nav.settings']}</h1>
      {env.data && <LinkSection g={env.data.google} reload={env.reload} />}
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
      {voice.data && <VoiceSection samples={voice.data.samples} reload={voice.reload} />}
      {env.data && <EnvSection v={env.data.isolation} reload={env.reload} />}
    </section>
  )
}
