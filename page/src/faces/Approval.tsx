// 承認の面（画面 4。docs/implementation.md 6.2.5 (8)）。承認待ち kind=完成稿。本文・前の版との違い・チェックの結果を 1 画面に
import { type CaseView, DraftDiff, type HostStatus } from '@libretto/shared/api'
import { JEV_PARTIAL } from '@libretto/shared/checks'
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import type { z } from 'zod'
import { useCaseAction } from '../action.ts'
import { Segment } from '../parts/Choice.tsx'
import { IsolationBand } from '../parts/IsolationBand.tsx'
import { W, w } from '../wording.ts'
import { destLabel, targetOf } from './Deliver.tsx'
import { CaseHeader, History, Versions } from './Progress.tsx'

type Changes = z.infer<typeof DraftDiff>['changes']
// 出典ごとの結果の色（凡例は tokens.css）。赤は「出典が主張を支えない」だけ。開けなかったのは分からないだけなので、あなたが開くための黄
const SOURCE_BADGE = {
  支持: 'b-done',
  一部支持: 'b-you',
  支持しない: 'b-alert',
  開けない: 'b-you',
  未判定: 'b-off',
} as const

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
  // 「要確認」の印ごとの答え（6.3.1 (9)）。既定は印のまま
  const marks = c.review?.needsConfirmation ?? []
  const sources = c.review?.sources ?? []
  const [cut, setCut] = useState<ReadonlySet<string>>(new Set())
  const cutting = marks.some((m) => cut.has(m.claimId))
  const [note, setNote] = useState('')
  const locked = action.busy || stopped
  // 保存先を変える（T23b。6.5 (8)）。選び直したら完成稿の承認はやり直し
  const [changing, setChanging] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const startChange = () => {
    setPicked(new Set(c.deliveryPlan.targets.map((t) => t.kind)))
    setChanging(true)
  }
  const change = async () => {
    const targets = c.destinationChoices.filter((k) => picked.has(k)).map(targetOf)
    if (!targets.length || locked) return
    if (await action.run({ type: 'delivery.change', expectedRevision: c.revision, targets })) setChanging(false)
  }

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
      marks: Object.fromEntries(marks.map((m) => [m.claimId, cut.has(m.claimId) ? '削る' : '印のまま'])),
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
            {cutting ? W['approval.okCut'] : W['approval.ok']}
          </button>
          {!redoing && (
            <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => setRedoing(true)}>
              {W['approval.redo']}
            </button>
          )}
          {!changing && (
            <button type="button" className="btn btn-secondary" disabled={locked} onClick={startChange}>
              {W['approval.changeDest']}
            </button>
          )}
        </div>
        {changing && (
          <fieldset className="revise approval-dest">
            <legend className="strong small">{W['approval.changeDestLabel']}</legend>
            {c.destinationChoices.map((k) => (
              <label key={k} className="row-gap">
                <input
                  type="checkbox"
                  checked={picked.has(k)}
                  disabled={locked}
                  onChange={(ev) => {
                    const next = new Set(picked)
                    if (ev.target.checked) next.add(k)
                    else next.delete(k)
                    setPicked(next)
                  }}
                />
                {destLabel(targetOf(k))}
              </label>
            ))}
            <p className="muted small">{W['approval.changeDestNote']}</p>
            <div className="row-gap">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={locked || picked.size === 0}
                aria-busy={action.busy || undefined}
                onClick={() => void change()}
              >
                {W['approval.changeDestSave']}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setChanging(false)}>
                {W['approval.changeDestCancel']}
              </button>
            </div>
          </fieldset>
        )}
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
            {marks.length > 0 && (
              <section aria-labelledby="h-marks" className="facts">
                <h3 id="h-marks" className="small strong">
                  {W['approval.marksHeading']}
                </h3>
                <p className="muted small">{W['approval.marksLead']}</p>
                <ul className="results">
                  {marks.map((m) => (
                    <li key={m.claimId} className="result fact-mark">
                      <span className="strong">{m.text}</span>
                      <span className="muted small">{m.where}</span>
                      <Segment
                        label={m.text}
                        value={cut.has(m.claimId) ? '削る' : '印のまま'}
                        disabled={locked}
                        options={(['印のまま', '削る'] as const).map((v) => ({
                          value: v,
                          label: W[`approval.mark.${v}`],
                        }))}
                        onChange={(v) =>
                          setCut((s) => {
                            const next = new Set(s)
                            if (v === '削る') next.add(m.claimId)
                            else next.delete(m.claimId)
                            return next
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {sources.length > 0 && (
              <section aria-labelledby="h-sources" className="facts">
                <h3 id="h-sources" className="small strong">
                  {W['approval.sourcesHeading']}
                </h3>
                <p className="muted small">{W['approval.sourcesLead']}</p>
                <ul className="sources">
                  {sources.map((s) => (
                    <li key={s.ref} className="source">
                      <a href={s.ref} target="_blank" rel="noopener noreferrer" className="strong source-title">
                        {s.title}
                        <span className="muted small">（{W['approval.sourceOpens']}）</span>
                      </a>
                      <span className="row-gap">
                        <span className={`badge badge-sm ${SOURCE_BADGE[s.verdict]}`}>
                          {W[`approval.source.${s.verdict}`]}
                        </span>
                        <span className="muted small">{w('approval.sourceClaims', { n: s.claimIds.length })}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {c.review?.voiceMatch && <VoiceMatchView m={c.review.voiceMatch} />}
            {(c.review?.familyNote || c.review?.jevNote || c.review?.jev) && (
              <ul className="notes muted small">
                {c.review?.familyNote && <li>{W['approval.sameFamily']}</li>}
                {c.review?.jev && (
                  <li>
                    {w('approval.judgeModel', { units: c.review.jev.units })}
                    {c.review.jev.unsure > 0 && (
                      <>
                        {'。'}
                        {w('approval.judgeModelUnsure', { unsure: c.review.jev.unsure })}
                      </>
                    )}
                  </li>
                )}
                {c.review?.jevNote && (
                  <li>
                    {W[c.review.jevNote === JEV_PARTIAL ? 'approval.judgeModelPartial' : 'approval.noJudgeModel']}
                  </li>
                )}
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

type Match = NonNullable<NonNullable<CaseView['review']>['voiceMatch']>
const OK_BADGE = { true: 'b-done', false: 'b-alert', null: 'b-off' } as const
function Ok({ ok }: { ok: boolean | null }) {
  const k = String(ok) as 'true' | 'false' | 'null'
  return <span className={`badge badge-sm ${OK_BADGE[k]}`}>{W[`approval.voice.ok.${k}`]}</span>
}
const pct = (n: number) => `${Math.round(n * 100)}%`
const NONE = 'なし' // 一人称を使っていない（host の文体カードの値）

// 文体カードとの比べ（6.3.2 (9)）。あなた（カード）/ この版 / 合っているか
function VoiceMatchView({ m }: { m: Match }) {
  const rows: [string, string, string, string, boolean | null][] = [
    [
      'endings',
      w('approval.voice.endings', { main: m.endings.main }),
      pct(m.endings.you),
      pct(m.endings.draft),
      m.endings.ok,
    ],
    [
      'length',
      W['approval.voice.sentenceLength'],
      w('approval.voice.chars', { n: Math.round(m.sentenceLength.you) }),
      w('approval.voice.chars', { n: Math.round(m.sentenceLength.draft) }),
      m.sentenceLength.ok,
    ],
    ['firstPerson', W['approval.voice.firstPerson'], m.firstPerson.you, m.firstPerson.draft, m.firstPerson.ok],
  ]
  // 一人称は、どちらかが「なし」なら出さない（使っていないのに合っていると読める。6.3.2 (9)）
  const shown = rows.filter(([key, , you, draft]) => key !== 'firstPerson' || (you !== NONE && draft !== NONE))
  return (
    <section aria-labelledby="h-voice" className="facts">
      <h3 id="h-voice" className="small strong">
        {W['approval.voiceHeading']}
      </h3>
      <table className="voice-match small">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">{W['approval.voice.item']}</span>
            </th>
            <th scope="col">{W['approval.voice.you']}</th>
            <th scope="col">{W['approval.voice.draft']}</th>
            <th scope="col">
              <span className="sr-only">{W['approval.voice.result']}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(([key, label, you, draft, ok]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td>{you}</td>
              <td>{draft}</td>
              <td>
                <Ok ok={ok} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">{W['approval.voice.readAlike']}</th>
            <td colSpan={2} className="muted">
              {W['approval.voice.readAlikeNote']}
            </td>
            <td>
              <Ok ok={m.readAlike} />
            </td>
          </tr>
        </tbody>
      </table>
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
