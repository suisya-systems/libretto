// 送付の面（画面 5。docs/implementation.md 6.2.8 (6)）と成果の面（6.2.8 (7)）。
// 送付確認待ち・本人の番は「何を・どこへ・誰に見えるか」と保存する / 戻る。完了は保存先ごとの受け取り口
import { type CaseView, DEST_TARGET, type DeliveryTarget, destChoiceOf } from '@libretto/shared/api'
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { useCaseAction } from '../action.ts'
import { W, w } from '../wording.ts'
import { CaseHeader, History, Leftovers, Versions } from './Progress.tsx'

export const destLabel = (t: DeliveryTarget) => W[`dest.${destChoiceOf(t)}`]
// 画面から選べる保存先の種類（CaseView.destinationChoices）を保存先に。Google の 3 つは libretto フォルダ（6.5 (3)・6.10 (3)）
export const targetOf = (k: CaseView['destinationChoices'][number]): DeliveryTarget => DEST_TARGET[k]
// Google に作るものの注記と、成果の面の「開く」（6.10 (6)）
const GOOGLE_NOTE = { gdoc: 'deliver.gdocNote', gsheet: 'deliver.gsheetNote', gslide: 'deliver.gslideNote' } as const
const GOOGLE_OPEN = { gdoc: 'result.openDoc', gsheet: 'result.openSheet', gslide: 'result.openSlides' } as const

const day = (at: string) =>
  new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  )

// 仕立てた貼り付け用の文（GET /api/cases/:id/drafts/:n?format=paste。6.2.8 (5)）
function usePaste(caseId: string, n: number, want: boolean) {
  const [text, setText] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!want) return
    const ac = new AbortController()
    setFailed(false)
    fetch(`/api/cases/${encodeURIComponent(caseId)}/drafts/${n}?format=paste`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
      .then(setText)
      .catch(() => !ac.signal.aborted && setFailed(true))
    return () => ac.abort()
  }, [caseId, n, want])
  return { text, failed }
}

function PastePreview({ paste, id }: { paste: ReturnType<typeof usePaste>; id: string }) {
  if (paste.failed) return <p className="empty">{W['deliver.pasteFailed']}</p>
  if (paste.text === undefined) return <div aria-busy="true" />
  return (
    <pre id={id} className="paste-preview">
      {paste.text}
    </pre>
  )
}

export function DeliverFace({ c, reload, stopped }: { c: CaseView; reload: () => void; stopped: boolean }) {
  const action = useCaseAction(c.id, reload)
  const latest = c.versions.at(-1)
  const targets = c.deliveryPlan.targets
  const paste = usePaste(
    c.id,
    c.version,
    targets.some((t) => t.kind === 'paste'),
  )
  const locked = action.busy || stopped

  return (
    <section className="face progress deliver">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <CaseHeader c={c} />

      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}

      <div className="card now now-yours deliver-now" role="status">
        <div className="now-eyebrow now-eyebrow-yours">{W['deliver.eyebrow']}</div>
        <h2 className="now-title">{c.step}</h2>
        <dl className="gate">
          <div>
            <dt>{W['deliver.what']}</dt>
            <dd>
              <span className="strong">{w('card.version', { n: c.version })}</span>
              {latest && (
                <span className="muted small">
                  {' '}
                  {w('progress.versionSize', {
                    chars: latest.chars.toLocaleString('ja-JP'),
                    headings: latest.headings,
                  })}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{W['deliver.where']}</dt>
            <dd>
              <ul className="gate-targets">
                {targets.map((t) => (
                  <li key={JSON.stringify(t)}>{destLabel(t)}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt>{W['deliver.who']}</dt>
            <dd className="strong">{W[`deliver.visibility.${c.deliveryPlan.visibility}`]}</dd>
          </div>
        </dl>
        {c.formatReview && <p className="deliver-checked">{W['deliver.checked']}</p>}
        {c.mode === 'おまかせ' && c.turn === '本人' && (
          <p className="note-warn small">{W[`deliver.held.${c.deliveryPlan.quotesOthers ? '引用' : '見える'}`]}</p>
        )}
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked}
            aria-busy={action.busy || undefined}
            onClick={() =>
              void action.run({
                type: 'delivery.send',
                expectedRevision: c.revision,
                planFingerprint: c.deliveryPlan.fingerprint,
              })
            }
          >
            {W['deliver.send']}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={locked}
            onClick={() => void action.run({ type: 'delivery.decline', expectedRevision: c.revision })}
          >
            {W['deliver.decline']}
          </button>
        </div>
      </div>

      <section aria-labelledby="h-looks" className="stack">
        <h2 id="h-looks">{W['deliver.looksHeading']}</h2>
        {targets.map((t) => (
          <div key={JSON.stringify(t)} className="card pad stack target">
            <h3 className="target-title">{destLabel(t)}</h3>
            {t.kind === 'page' && <p className="muted">{W['deliver.pageNote']}</p>}
            {t.kind in GOOGLE_NOTE && (
              <p className="muted">
                {w(GOOGLE_NOTE[t.kind as keyof typeof GOOGLE_NOTE], { title: c.title, n: c.version })}
              </p>
            )}
            {t.kind === 'file' && <p className="muted">{W['deliver.fileNote']}</p>}
            {t.kind === 'paste' && (
              <>
                <p className="muted">{W['deliver.pasteNote']}</p>
                <PastePreview paste={paste} id="paste-preview" />
              </>
            )}
          </div>
        ))}
      </section>

      <Versions c={c} />
      <History c={c} />
    </section>
  )
}

type Copy = 'idle' | 'copied' | 'failed'

export function ResultFace({ c, reload, stopped }: { c: CaseView; reload: () => void; stopped: boolean }) {
  const action = useCaseAction(c.id, reload)
  // 今の保存先に無い種類だけを「にも保存する」に出す（T26b。6.5 (8)）
  const more = c.destinationChoices.filter((k) => !c.deliveryPlan.targets.some((t) => destChoiceOf(t) === k))
  // 保存した版ごとの受け取り口（送付済の行）。新しい版が上
  const saved = c.deliveries.filter((d) => d.status === '送付済')
  const n = Math.max(0, ...saved.map((d) => d.version))
  const now = saved.filter((d) => d.version === n)
  const page = now.find((d) => d.target.kind === 'page')
  const hasPaste = now.some((d) => d.target.kind === 'paste')
  const paste = usePaste(c.id, n, hasPaste && n > 0)
  const pages = [...new Set(saved.filter((d) => d.target.kind === 'page').map((d) => d.version))].sort((a, b) => b - a)
  const [copy, setCopy] = useState<Copy>('idle')

  useEffect(() => {
    if (copy !== 'copied') return
    const t = setTimeout(() => setCopy('idle'), 2000)
    return () => clearTimeout(t)
  }, [copy])

  const copyText = async () => {
    try {
      if (paste.text === undefined) throw new Error('not loaded')
      await navigator.clipboard.writeText(paste.text)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <section className="face progress result-face">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <CaseHeader c={c} />

      <div className="card now now-done" role="status">
        <div className="now-eyebrow now-eyebrow-done">{W['result.eyebrow']}</div>
        <h2 className="now-title">{W['result.heading']}</h2>
        <p className="muted">{w('result.lead', { n, at: c.doneAt ? day(c.doneAt) : '' })}</p>
        {page?.link && (
          <div className="approval-actions">
            <a className="btn btn-primary" href={page.link} target="_blank" rel="noopener">
              {W['result.openPage']}
            </a>
          </div>
        )}
      </div>

      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}
      <Leftovers c={c} />

      <section aria-labelledby="h-receive" className="stack">
        <h2 id="h-receive">{W['result.receiveHeading']}</h2>
        {now.map((d) => (
          <div key={d.attemptId} className="card pad stack target">
            <div className="row-between wrap">
              <h3 className="target-title">{destLabel(d.target)}</h3>
              <span className="badge badge-sm b-done">{W['result.saved']}</span>
            </div>
            {d.target.kind === 'page' && d.link && (
              <>
                <div className="row-gap">
                  <a className="btn btn-secondary" href={d.link} target="_blank" rel="noopener">
                    {W['result.openPage']}
                  </a>
                  <a className="btn btn-secondary" href={`${d.link}&download=1`} download>
                    {W['result.download']}
                  </a>
                </div>
                <p className="muted small">{W['result.downloadNote']}</p>
              </>
            )}
            {d.target.kind in GOOGLE_OPEN && d.link && (
              <div className="row-gap">
                <a className="btn btn-secondary" href={d.link} target="_blank" rel="noopener noreferrer">
                  {W[GOOGLE_OPEN[d.target.kind as keyof typeof GOOGLE_OPEN]]}
                </a>
              </div>
            )}
            {d.target.kind === 'file' && d.link && (
              <div className="row-gap">
                <a className="btn btn-secondary" href={d.link} download>
                  {W['result.downloadFile']}
                </a>
              </div>
            )}
            {d.target.kind === 'paste' && (
              <>
                <div className="row-gap">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={paste.text === undefined}
                    onClick={() => void copyText()}
                  >
                    {copy === 'copied' ? W['result.copied'] : W['result.copy']}
                  </button>
                  <span className="muted small" aria-live="polite">
                    {copy === 'failed' ? W['result.copyFailed'] : ''}
                  </span>
                </div>
                <PastePreview paste={paste} id="result-paste" />
              </>
            )}
          </div>
        ))}
      </section>

      {more.length > 0 && (
        <section aria-labelledby="h-add" className="stack">
          <h2 id="h-add">{W['result.addHeading']}</h2>
          <div className="row-gap">
            {more.map((k) => (
              <button
                key={k}
                type="button"
                className="btn btn-secondary"
                disabled={action.busy || stopped}
                onClick={() =>
                  void action.run({ type: 'delivery.add', expectedRevision: c.revision, target: targetOf(k) })
                }
              >
                {w('result.add', { dest: destLabel(targetOf(k)) })}
              </button>
            ))}
          </div>
        </section>
      )}

      {pages.length > 1 && (
        <section aria-labelledby="h-pages" className="stack">
          <h2 id="h-pages">{W['result.pagesHeading']}</h2>
          <ul className="card plain-list">
            {pages.map((v) => (
              <li key={v}>
                <a href={`/cases/${encodeURIComponent(c.id)}/page?v=${v}`} target="_blank" rel="noopener">
                  {w('result.pageOf', { n: v })}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.auto && (
        <section aria-labelledby="h-undo" className="card pad stack">
          <h2 id="h-undo">{W['deliver.undoHeading']}</h2>
          {now.map((d) =>
            // 共有したページには「ほかの人には見えません」を出さない
            (d.target.kind === 'page' && !d.target.shared) || d.target.kind === 'paste' || d.target.kind === 'gdoc' ? (
              <p key={d.attemptId} className="small">
                {destLabel(d.target)}: {W[`deliver.undo.${d.target.kind}`]}
              </p>
            ) : null,
          )}
        </section>
      )}

      <Versions c={c} />
      <History c={c} />
    </section>
  )
}
