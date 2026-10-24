// 承認の面（画面 4。docs/implementation.md 6.2.5 (8)）。承認待ち kind=完成稿。本文・前の版との違い・チェックの結果を 1 画面に
import { type CaseView, DraftDiff, type HostStatus } from '@libretto/shared/api'
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import type { z } from 'zod'
import { useCaseAction } from '../action.ts'
import { IsolationBand } from '../parts/IsolationBand.tsx'
import { W, w } from '../wording.ts'
import { CaseHeader, History, Versions } from './Progress.tsx'

type Changes = z.infer<typeof DraftDiff>['changes']

// 本文はホストが判定した Markdown から組み立てた HTML（許したタグとエスケープした文字だけ。6.2.5 (7)）
function useDraft(caseId: string, n: number) {
  const [html, setHtml] = useState<string>()
  const [changes, setChanges] = useState<Changes>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const ac = new AbortController()
    const base = `/api/cases/${encodeURIComponent(caseId)}`
    setFailed(false)
    const text = (path: string) =>
      fetch(path, { signal: ac.signal }).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
    text(`${base}/drafts/${n}?format=html`)
      .then(setHtml)
      .catch(() => !ac.signal.aborted && setFailed(true))
    if (n > 1)
      text(`${base}/diff?from=${n - 1}&to=${n}`)
        .then((t) => setChanges(DraftDiff.parse(JSON.parse(t)).changes))
        .catch(() => !ac.signal.aborted && setFailed(true))
    else setChanges(undefined)
    return () => ac.abort()
  }, [caseId, n])
  return { html, changes, failed }
}

export function ApprovalFace({
  c,
  reload,
  stopped,
  isolation,
}: {
  c: CaseView
  reload: () => void
  stopped: boolean
  isolation?: HostStatus['isolation'] | undefined
}) {
  const action = useCaseAction(c.id, reload)
  const latest = c.versions.at(-1)
  const n = latest?.n ?? c.version
  const draft = useDraft(c.id, n)
  const [tab, setTab] = useState<'draft' | 'diff'>('draft')
  const [redoing, setRedoing] = useState(false)
  const [note, setNote] = useState('')
  const locked = action.busy || stopped

  const failed = [...(c.review?.failed ?? []), ...(c.formatReview?.failed ?? [])]
  const skipped = (c.review?.skipped ?? 0) + (c.formatReview?.skipped ?? 0)
  const passed = (c.review?.passed ?? 0) + (c.formatReview?.passed ?? 0)
  const clean = failed.length === 0 && skipped === 0
  const formatIds = new Set(c.formatReview?.failed.map((f) => f.checkId))
  // 3 回目を待たずに上げたとき（6.2.7 (5)）。印は本文の判定で 2 回続けて直らなかった項目だけ
  const early = c.review?.escalate ?? c.formatReview?.escalate
  const stuck = new Set(c.review?.escalate?.why === '直らない' ? c.review.escalate.checkIds : [])

  const approve = () =>
    latest &&
    void action.run({
      type: 'approval.ok',
      expectedRevision: c.revision,
      marks: {},
      versionFingerprint: latest.fingerprint,
    })
  const redo = async () => {
    const instruction = note.trim()
    if (!instruction || locked) return
    if (await action.run({ type: 'approval.redo', expectedRevision: c.revision, instruction })) {
      setNote('')
      setRedoing(false)
    }
  }

  return (
    <section className="face progress approval">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <CaseHeader c={c} />

      <IsolationBand level={isolation} />
      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}

      <div className={`card now approval-now ${clean ? 'approval-clean' : 'approval-left'}`} role="status">
        <div className="now-eyebrow">{W['approval.eyebrow']}</div>
        <h2 className="now-title">{c.step}</h2>
        <p className="approval-verdict">
          {clean ? w('approval.allPassed', { n: passed }) : w('approval.remaining', { n: failed.length })}
        </p>
        {early && <p className="muted">{W[`approval.early.${early.why}`]}</p>}
        {!clean && <p className="muted">{W['approval.remainingLead']}</p>}
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked || !latest}
            aria-busy={action.busy || undefined}
            onClick={approve}
          >
            {W['approval.ok']}
          </button>
          {!redoing && (
            <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => setRedoing(true)}>
              {W['approval.redo']}
            </button>
          )}
        </div>
        {redoing && (
          <div className="revise approval-redo">
            <label htmlFor="redo-note" className="strong small">
              {W['approval.redoLabel']}
            </label>
            <textarea
              id="redo-note"
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
                onClick={() => void redo()}
              >
                {W['approval.redoSend']}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRedoing(false)}>
                {W['approval.redoCancel']}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="approval-grid">
        <section aria-labelledby="h-draft" className="stack approval-draft">
          <div className="row-between wrap">
            <h2 id="h-draft">{w('approval.version', { n })}</h2>
            {n > 1 && (
              <div className="tabs" role="tablist">
                {(['draft', 'diff'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={`tab ${tab === t ? 'tab-on' : ''}`}
                    onClick={() => setTab(t)}
                  >
                    {t === 'draft' ? W['approval.draftTab'] : W['approval.diffTab']}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="card pad doc">
            {draft.failed ? (
              <p className="empty">{W['approval.draftFailed']}</p>
            ) : tab === 'diff' && n > 1 ? (
              <DiffView changes={draft.changes} />
            ) : draft.html === undefined ? (
              <div aria-busy="true" />
            ) : (
              // biome-ignore lint/security/noDangerouslySetInnerHtml: ホストが Markdown から組み立てた HTML（許したタグとエスケープした文字だけ）
              <article className="doc-body" dangerouslySetInnerHTML={{ __html: draft.html }} />
            )}
          </div>
        </section>

        <section aria-labelledby="h-results" className="stack approval-results">
          <h2 id="h-results">{W['approval.resultsHeading']}</h2>
          <div className="card pad stack">
            <div className="row-gap">
              <span className="badge b-done">{w('approval.passedCount', { n: passed })}</span>
              {failed.length > 0 && (
                <span className="badge b-alert">{w('approval.failedCount', { n: failed.length })}</span>
              )}
              {skipped > 0 && <span className="badge b-off">{w('approval.skipped', { n: skipped })}</span>}
            </div>
            {failed.length > 0 && (
              <>
                <h3 className="small strong">{W['approval.failedHeading']}</h3>
                <ul className="results">
                  {failed.map((f) => (
                    <li key={`${formatIds.has(f.checkId) ? 'f' : 'a'}-${f.checkId}`} className="result">
                      <div className="result-title">
                        <span className="strong">{f.title}</span>
                        {formatIds.has(f.checkId) && (
                          <span className="badge badge-sm b-off">{W['approval.format']}</span>
                        )}
                        {!formatIds.has(f.checkId) && stuck.has(f.checkId) && (
                          <span className="badge badge-sm b-alert">{W['approval.stuck']}</span>
                        )}
                        {f.verdict === 'unable' && <span className="badge badge-sm b-off">{W['approval.unable']}</span>}
                      </div>
                      {f.reason && <p className="muted small">{f.reason}</p>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(c.review?.familyNote || c.review?.jevNote) && (
              <ul className="notes muted small">
                {c.review?.familyNote && <li>{W['approval.sameFamily']}</li>}
                {c.review?.jevNote && <li>{W['approval.noJudgeModel']}</li>}
              </ul>
            )}
          </div>
        </section>
      </div>

      <Versions c={c} />
      <History c={c} />
    </section>
  )
}

function DiffView({ changes }: { changes: Changes | undefined }) {
  if (!changes) return <div aria-busy="true" />
  if (!changes.length) return <p className="empty">{W['approval.noDiff']}</p>
  return (
    <ol className="diff">
      {changes.map((ch, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 差分の並びは取り直すまで変わらない
        <li key={i} className={`diff-row diff-${ch.kind}`}>
          <span className="diff-kind">{W[`approval.diff.${ch.kind}`]}</span>
          {ch.before !== undefined && <del className="diff-before">{ch.before}</del>}
          {ch.after !== undefined && <ins className="diff-after">{ch.after}</ins>}
        </li>
      ))}
    </ol>
  )
}
