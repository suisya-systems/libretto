// 設定の面（画面 7）。今は API キーの節だけ（docs/implementation.md 6.1.3 (6)）。値は画面のどこにも出さない（設計書 D17）
import { type ApiKeyStatus, Settings as SettingsSchema } from '@libretto/shared/api'
import { useId, useState } from 'react'
import { useLoad } from '../load.ts'
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

function KeyRow({
  status,
  label,
  use,
  reload,
}: {
  status: ApiKeyStatus
  label: string
  use: string
  reload: () => void
}) {
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
            {label}
          </h3>
          <p className="muted small">{use}</p>
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
        <p className="note-warn small">{W['settings.key.unsetNote']}</p>
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
            body={W['settings.key.deleteBody']}
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

export function Settings() {
  const keys = useLoad('/api/settings/keys', Keys, (s) => s.event === 'settings.changed')
  return (
    <section className="face">
      <h1 className="face-title">{W['nav.settings']}</h1>
      {keys.problem && !keys.data ? (
        <ProblemView problem={keys.problem} retry={keys.reload} />
      ) : (
        keys.data && (
          <section aria-labelledby="h-keys" className="card pad">
            <h2 id="h-keys">{W['settings.keysHeading']}</h2>
            <ul className="key-list">
              <KeyRow
                status={keys.data.openai}
                label={W['settings.openai.label']}
                use={W['settings.openai.use']}
                reload={keys.reload}
              />
            </ul>
          </section>
        )
      )}
    </section>
  )
}
