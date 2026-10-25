// 設定の面の端末の節（docs/implementation.md 6.12 (5)）。つないでいる端末の一覧・外す・別の端末を追加する（新しい追加用のアドレス）
import { DeviceList, Pairing } from '@libretto/shared/api'
import { useState } from 'react'
import type { z } from 'zod'
import { useLoad } from '../load.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { W, w } from '../wording.ts'

const day = (at: string) =>
  new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(at))
const clock = (at: string) =>
  new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
// この PC の中でしか開けないアドレス（スマホからは開けない）
const local = (url: string) => /^https?:\/\/(127\.|localhost|\[::1\])/.test(url)

export function DeviceSection() {
  const list = useLoad('/api/devices', DeviceList)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [issued, setIssued] = useState<z.infer<typeof Pairing>>()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<'failed' | 'removeFailed'>()
  const [copied, setCopied] = useState(false)

  const issue = async () => {
    setBusy(true)
    setProblem(undefined)
    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setIssued(Pairing.parse(await res.json()))
      setCopied(false)
    } catch {
      setProblem('failed')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    setBusy(true)
    setProblem(undefined)
    // send() は 503 を「届いた」とみなす（緊急停止用）。外すのは保存できなければ外れていないので res.ok で見る
    const ok = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((r) => r.ok)
      .catch(() => false)
    if (!ok) setProblem('removeFailed')
    setBusy(false)
    list.reload()
  }
  const close = () => {
    setAdding(false)
    setIssued(undefined)
    setLabel('')
    list.reload() // 追加した端末が開いていれば一覧に出る
  }

  return (
    <section aria-labelledby="h-devices" className="card pad stack">
      <h2 id="h-devices">{W['settings.devicesHeading']}</h2>
      <p className="muted small">{W['settings.devices.use']}</p>
      {list.data && (
        <ul className="key-list device-list">
          {list.data.devices.map((d) => (
            <li key={d.id} className="key-row device-row">
              <div>
                <span className="strong">{d.label || W['settings.devices.unnamed']}</span>
                {d.current && <span className="badge b-done device-current">{W['settings.devices.current']}</span>}
                <div className="muted small">{w('settings.devices.at', { at: day(d.at) })}</div>
              </div>
              {!d.current && (
                <Confirm
                  trigger={W['settings.devices.remove']}
                  triggerLabel={w('settings.devices.removeLabel', { label: d.label || W['settings.devices.unnamed'] })}
                  title={W['settings.devices.removeTitle']}
                  body={W['settings.devices.removeBody']}
                  confirm={W['settings.devices.remove']}
                  cancel={W['settings.devices.removeNo']}
                  danger
                  busy={busy}
                  triggerClass="btn btn-secondary btn-sm"
                  onConfirm={() => void remove(d.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {!adding ? (
        <div className="device-add">
          <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
            {W['settings.devices.add']}
          </button>
        </div>
      ) : issued ? (
        <div className="revise stack device-issued" role="status">
          <p className="small">{W['settings.devices.urlLead']}</p>
          <output className="device-url">{issued.url}</output>
          <p className="muted small">{w('settings.devices.expires', { at: clock(issued.expiresAt) })}</p>
          {local(issued.url) && <p className="note-alert small">{W['settings.devices.local']}</p>}
          <div className="row-gap">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(issued.url)
                  .then(() => setCopied(true))
                  .catch(() => {})
              }
            >
              {copied ? W['settings.devices.copied'] : W['settings.devices.copy']}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
              {W['settings.devices.cancel']}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="revise stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (label.trim()) void issue()
          }}
        >
          <label className="voice-field">
            <span className="small strong">{W['settings.devices.nameLabel']}</span>
            <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <div className="row-gap">
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy || !label.trim()}
              aria-busy={busy || undefined}
            >
              {W['settings.devices.issue']}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={close}>
              {W['settings.devices.cancel']}
            </button>
          </div>
        </form>
      )}
      {problem && (
        <p className="note-alert small" role="alert">
          {W[`settings.devices.${problem}`]}
        </p>
      )}
    </section>
  )
}
