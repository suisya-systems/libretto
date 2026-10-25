// 構成案の面（承認待ち kind=構成案。docs/implementation.md 6.12 (3)）。構成案を読み、そのままか指示を添えて承認する（T14）
import type { CaseView } from '@libretto/shared/api'
import { useState } from 'react'
import { Link } from 'wouter'
import { useCaseAction } from '../action.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { W } from '../wording.ts'
import { CaseHeader, History } from './Progress.tsx'

// 構成案は # の題・## の見出し・- の箇条書きだけ（6.12 (2)）。ほかの行は段落。HTML は組まず文字のまま出す
function OutlineBody({ md }: { md: string }) {
  const out: React.ReactNode[] = []
  let items: string[] = []
  const flush = () => {
    if (items.length)
      out.push(
        <ul key={out.length}>
          {items.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            <li key={i}>{t}</li>
          ))}
        </ul>,
      )
    items = []
  }
  for (const line of md.split('\n')) {
    const t = line.trim()
    const li = /^[-*]\s+(.*)$/.exec(t)
    if (li) {
      items.push(li[1] as string)
      continue
    }
    flush()
    if (!t) continue
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    // 承認の面の本文と同じ強弱（題は h1、見出しは h2）
    if (h) out.push(h[1] === '#' ? <h1 key={out.length}>{h[2]}</h1> : <h2 key={out.length}>{h[2]}</h2>)
    else out.push(<p key={out.length}>{t}</p>)
  }
  flush()
  return <article className="doc-body outline-body">{out}</article>
}

export function OutlineFace({ c, reload, stopped }: { c: CaseView; reload: () => void; stopped: boolean }) {
  const action = useCaseAction(c.id, reload)
  const [changing, setChanging] = useState(false)
  const [note, setNote] = useState('')
  const locked = action.busy || stopped || !c.outlineFingerprint
  const approve = async (text?: string) => {
    if (locked || !c.outlineFingerprint) return
    if (
      await action.run({
        type: 'outline.approve',
        expectedRevision: c.revision,
        outlineFingerprint: c.outlineFingerprint,
        ...(text && { note: text }),
      })
    )
      setNote('')
  }

  return (
    <section className="face progress approval outline">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <CaseHeader c={c} />
      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}

      <div className="card now approval-now approval-clean" role="status">
        <div className="now-eyebrow">{W['approval.eyebrow']}</div>
        <h2 className="now-title">{c.step}</h2>
        <p className="muted">{W['outline.lead']}</p>
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked}
            aria-busy={action.busy || undefined}
            onClick={() => void approve()}
          >
            {W['outline.ok']}
          </button>
          {!changing && (
            <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => setChanging(true)}>
              {W['outline.change']}
            </button>
          )}
        </div>
        {changing && (
          <div className="revise approval-redo">
            <label htmlFor="outline-note" className="strong small">
              {W['outline.changeLabel']}
            </label>
            <textarea
              id="outline-note"
              rows={4}
              value={note}
              maxLength={2000}
              onChange={(ev) => setNote(ev.target.value)}
              disabled={locked}
            />
            <div className="row-gap">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={locked || !note.trim()}
                aria-busy={action.busy || undefined}
                onClick={() => void approve(note.trim())}
              >
                {W['outline.changeSend']}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChanging(false)}>
                {W['outline.changeCancel']}
              </button>
            </div>
          </div>
        )}
        <p className="muted small">{W['outline.note']}</p>
      </div>

      <section aria-labelledby="h-outline" className="stack">
        <h2 id="h-outline">{W['outline.heading']}</h2>
        <div className="card pad doc">
          {c.outline ? <OutlineBody md={c.outline} /> : <p className="empty">{W['outline.empty']}</p>}
        </div>
      </section>

      <div className="now-actions">
        <Confirm
          trigger={W['progress.stop']}
          title={W['progress.stopTitle']}
          body={W['progress.stopBody']}
          confirm={W['progress.stop']}
          cancel={W['progress.stopNo']}
          danger
          disabled={stopped}
          busy={action.busy}
          triggerClass="btn btn-quiet"
          onConfirm={() => void action.run({ type: 'stop.case', expectedRevision: c.revision })}
        />
      </div>
      <History c={c} />
    </section>
  )
}
