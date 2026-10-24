// ホームの「依頼の候補」の欄（画面案 1 の合図カード。docs/implementation.md 6.4 (5)(7)）。進める・見送る・内容を修正（候補の中の会話）
import type { CandidateCard, DeliveryTarget, HomeView } from '@libretto/shared/api'
import { useState } from 'react'
import { useLocation } from 'wouter'
import { send } from '../load.ts'
import { Choose } from '../parts/Choice.tsx'
import { Confirm } from '../parts/Dialog.tsx'
import { W, type WKey, w } from '../wording.ts'
import { Chat } from './Chat.tsx'

// ラベルのカードで選べる見送りの理由（6.4 (5)）
const REASONS = ['依頼ではない', '自分の仕事ではない', 'もう済んだ'] as const
type Reason = (typeof REASONS)[number]

const dest = (t: DeliveryTarget) => (t.kind === 'page' || t.kind === 'paste' ? W[`dest.${t.kind}`] : '')
const pad = (n: number) => String(n).padStart(2, '0')
const when = (at: string) => {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type Sent = { ok: true; caseId?: string } | { ok: false; moved: boolean }
async function act(id: string, body: { type: 'proceed' } | { type: 'dismiss'; reason: Reason }): Promise<Sent> {
  try {
    const res = await fetch(`/api/candidates/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true, ...((await res.json()) as { caseId?: string }) }
    return { ok: false, moved: res.status === 409 || res.status === 404 }
  } catch {
    return { ok: false, moved: false }
  }
}

function Card({ c, stopped, reload }: { c: CandidateCard; stopped: boolean; reload: () => void }) {
  const [, go] = useLocation()
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<Reason | ''>('')
  const [talking, setTalking] = useState(false)
  const [notice, setNotice] = useState<WKey>()

  async function run(body: Parameters<typeof act>[1]) {
    setBusy(true)
    setNotice(undefined)
    const r = await act(c.id, body)
    setBusy(false)
    if (r.ok && r.caseId) return go(`/cases/${r.caseId}`)
    if (!r.ok) setNotice(r.moved ? 'action.moved' : 'band.sendFailed')
    reload()
  }

  const titleId = `cand-${c.id}`
  return (
    <li className="card cand" aria-labelledby={titleId}>
      <div className="cand-head">
        <span className="badge b-you badge-sm">{W['cand.mark.gmail']}</span>
        <span className="muted small">{w('cand.from', { from: c.from, at: when(c.receivedAt) })}</span>
      </div>
      <h3 className="cand-title" id={titleId}>
        {c.subject}
      </h3>
      <p className="cand-ask">
        <span className="sr-only">{W['cand.askLabel']}</span>
        {c.summary}
      </p>
      <p className="muted small">
        {w('cand.make', { doc: c.proposal.docType, dest: c.proposal.destination.map(dest).join('、') })}
      </p>
      {!!c.attachmentsNeeded?.length && (
        <p className="note-warn small">{w('cand.attach', { names: c.attachmentsNeeded.join('」「') })}</p>
      )}
      {c.aiInstructionFlag && <p className="note-alert small">{W['cand.aiNote']}</p>}
      <div className="cand-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || stopped}
          aria-busy={busy || undefined}
          onClick={() => void run({ type: 'proceed' })}
        >
          {W['cand.proceed']}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || stopped}
          aria-expanded={talking}
          onClick={() => setTalking((t) => !t)}
        >
          {talking ? W['cand.changeClose'] : W['cand.change']}
        </button>
        <Confirm
          trigger={W['cand.dismiss']}
          title={W['cand.dismissTitle']}
          body={W['cand.dismissBody']}
          confirm={W['cand.dismiss']}
          cancel={W['cand.cancel']}
          disabled={stopped}
          busy={busy}
          canConfirm={reason !== ''}
          triggerClass="btn btn-quiet btn-sm"
          onConfirm={() => reason && void run({ type: 'dismiss', reason })}
        >
          <Choose
            label={W['cand.dismissTitle']}
            value={reason}
            options={REASONS.map((r) => ({ value: r, label: W[`cand.reason.${r}`] }))}
            onChange={(v) => setReason(v as Reason)}
          />
        </Confirm>
        <a className="btn btn-quiet btn-sm" href={c.link} target="_blank" rel="noreferrer noopener">
          {W['cand.open']}
        </a>
      </div>
      {notice && (
        <p className="note-alert small" role="alert">
          {W[notice]}
        </p>
      )}
      {talking && <Chat stopped={stopped} candidateId={c.id} />}
    </li>
  )
}

// 連携しているか、候補が 1 件以上あるときだけ出す（6.4 (7)）
export function Candidates({ v, stopped, reload }: { v: HomeView; stopped: boolean; reload: () => void }) {
  const [refreshing, setRefreshing] = useState(false)
  const cards = v.candidates.signal
  if (!v.intake.connected && !cards.length) return null
  const running = v.intake.running || refreshing
  return (
    <section aria-labelledby="h-cand" className="stack">
      <div className="row-between wrap">
        <h2 id="h-cand">
          {W['home.candHeading']} <span className="count">{w('count', { n: cards.length })}</span>
        </h2>
        {v.intake.connected && (
          <div className="row-gap">
            {v.intake.lastAt && !running && (
              <span className="muted small">{w('home.candLast', { at: when(v.intake.lastAt) })}</span>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={running || stopped}
              aria-busy={running || undefined}
              onClick={async () => {
                setRefreshing(true)
                await send('POST', '/api/intake/refresh')
                setRefreshing(false)
                reload()
              }}
            >
              {running ? W['home.candRefreshing'] : W['home.candRefresh']}
            </button>
          </div>
        )}
      </div>
      {cards.length ? (
        <ul className="cand-list">
          {cards.map((c) => (
            <Card key={c.id} c={c} stopped={stopped} reload={reload} />
          ))}
        </ul>
      ) : (
        <p className="empty">{W['home.candEmpty']}</p>
      )}
    </section>
  )
}
