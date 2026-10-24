// 依頼の確認（画面 2。docs/implementation.md 13.1・6.2.2 (10)）。1 画面で依頼書・確認したいこと・チェック項目を見て承認する
import {
  type Answer,
  type CaseView,
  type DeliveryTarget,
  type HostStatus,
  LEAVE_IT,
  type Mode,
  type Undecided,
} from '@libretto/shared/api'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Link } from 'wouter'
import { useCaseAction } from '../action.ts'
import { Choose, ChooseMany, Fold } from '../parts/Choice.tsx'
import { Confirm } from '../parts/Dialog.tsx'
import { IsolationBand } from '../parts/IsolationBand.tsx'
import { STATE, W, w } from '../wording.ts'
import { Chat } from './Chat.tsx'
import { tone } from './Home.tsx'

type Entrance = NonNullable<CaseView['entrance']>
// 選んでいる途中の答え。全部外した問いは [] で、そのままでは送れない（6.2.6 (4)）
type Picked = string[] | typeof LEAVE_IT
const yen = (n: number) => n.toLocaleString('ja-JP')

function dest(t: DeliveryTarget) {
  if (t.kind === 'file') return w('dest.file', { format: t.format })
  return W[`dest.${t.kind}`]
}

export function EntranceFace({
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
  const e = c.entrance
  const mine = c.turn === '本人'
  const locked = action.busy || stopped
  const [revising, setRevising] = useState(false)
  const [talking, setTalking] = useState(false)

  return (
    <section className="face entrance">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <header className="entrance-head">
        <div className="row-gap">
          <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
          <span className="badge b-off">{c.mode}</span>
          {c.auto && <span className="badge b-run">{W['card.auto']}</span>}
        </div>
        <h1 className="face-title">{c.title}</h1>
        {mine ? (
          // 組が無いまま本人の番 = 整えられなかった（T6b）。起きたことを強く出す
          <p className={e ? 'lead' : 'lead lead-alert'} role={e ? undefined : 'alert'}>
            {c.step}
          </p>
        ) : (
          <div className="working" role="status" aria-live="polite">
            <span className="dots" aria-hidden="true" />
            <div>
              <p className="lead">{c.step}</p>
              <p className="muted small">{W['entrance.waitLead']}</p>
            </div>
          </div>
        )}
      </header>

      <IsolationBand level={isolation} />
      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}

      {e ? (
        <EntranceSet
          key={e.setFingerprint}
          c={c}
          e={e}
          canApprove={mine && !c.auto}
          locked={locked}
          approve={(answers, mode) =>
            void action.run({
              type: 'entrance.approve',
              expectedRevision: c.revision,
              answers,
              mode,
              setFingerprint: e.setFingerprint,
            })
          }
          actions={
            <Actions
              c={c}
              mine={mine}
              locked={locked}
              busy={action.busy}
              revising={revising}
              setRevising={setRevising}
              talking={talking}
              setTalking={setTalking}
              revise={(note) => action.run({ type: 'entrance.revise', expectedRevision: c.revision, note })}
              cancel={() => void action.run({ type: 'cancel', expectedRevision: c.revision })}
            />
          }
        />
      ) : (
        // 組が無いあいだ: 整えられなかった（本人の番）なら出し直しと取り消し、書いている間も取り消しはできる（T9）
        <div className={mine ? 'card pad entrance-failed' : 'entrance-failed entrance-drafting'}>
          {mine && <p>{W['entrance.failedLead']}</p>}
          <Actions
            c={c}
            mine={mine}
            locked={locked}
            busy={action.busy}
            revising={revising}
            setRevising={setRevising}
            talking={false}
            setTalking={() => {}}
            revise={(note) => action.run({ type: 'entrance.revise', expectedRevision: c.revision, note })}
            cancel={() => void action.run({ type: 'cancel', expectedRevision: c.revision })}
          />
        </div>
      )}

      {talking && e && mine && (
        <div ref={(el) => el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}>
          <Chat stopped={stopped} caseId={c.id} />
        </div>
      )}
    </section>
  )
}

function EntranceSet(p: {
  c: CaseView
  e: Entrance
  canApprove: boolean
  locked: boolean
  approve: (answers: Record<string, Answer>, mode: Mode) => void
  actions: ReactNode
}) {
  const { c, e } = p
  const b = e.brief
  // おすすめが最初から選ばれている（13.2 (b)）。承認の後は答えを出す
  const [answers, setAnswers] = useState<Record<string, Picked>>(() =>
    Object.fromEntries(e.undecided.items.map((u) => [u.id, u.answer ?? u.recommended])),
  )
  const [mode, setMode] = useState<Mode>(c.mode)
  const readOnly = !p.canApprove
  const picked = (u: Undecided) => answers[u.id] ?? u.recommended
  const empty = (u: Undecided) => picked(u).length === 0
  const unanswered = e.undecided.items.some(empty)
  const pick = (u: Undecided, v: Picked) => setAnswers((a) => ({ ...a, [u.id]: v }))
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (!p.locked && p.canApprove && !unanswered) p.approve(answers as Record<string, Answer>, mode)
  }
  const options = (u: Undecided) => [
    ...u.options.map((o) => ({
      value: o.id,
      label: o.label,
      ...(o.note && { note: o.note }),
      ...(u.recommended.includes(o.id) && {
        badge: <span className="badge b-you badge-sm">{W['chat.recommended']}</span>,
      }),
    })),
    { value: LEAVE_IT, label: W['entrance.leaveIt'], note: W['entrance.leaveItNote'] },
  ]
  const rows: [string, string][] = [
    [W['entrance.brief.docType'], b.docType],
    [W['entrance.brief.subject'], b.subject],
    [W['entrance.brief.wanted'], b.wanted.length ? b.wanted.join('、') : W['entrance.none']],
    [W['entrance.brief.gather'], b.gather.length ? b.gather.join('、') : W['entrance.none']],
    [W['entrance.brief.audience'], b.audience],
    [W['entrance.brief.destinations'], b.destinations.map(dest).join('、')],
    [W['entrance.brief.shape'], b.shape],
    [W['entrance.brief.voice'], W[`entrance.voice.${b.voice}`]],
    [W['entrance.brief.sources'], W[`entrance.sources.${b.sources}`]],
    [W['entrance.brief.deadline'], b.deadline ?? W['entrance.none']],
    [W['entrance.brief.mustNot'], b.mustNot.length ? b.mustNot.join('、') : W['entrance.none']],
  ]
  const cats = Object.entries(e.checks.byCategory)

  return (
    <form className="entrance-grid" onSubmit={submit}>
      <div className="entrance-main stack">
        <section aria-labelledby="h-brief" className="card pad">
          <h2 id="h-brief">{W['entrance.briefHeading']}</h2>
          <dl className="brief">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {b.wanted.length > 0 && <p className="wanted-note">{W['entrance.wantedNote']}</p>}
          {b.gather.length > 0 && <p className="wanted-note gather-note">{W['entrance.gatherNote']}</p>}
        </section>

        {e.assumptions.length > 0 && (
          <section aria-labelledby="h-assume" className="card pad">
            <h2 id="h-assume">{W['entrance.assumptionsHeading']}</h2>
            <ul className="assumptions">
              {e.assumptions.map((a) => (
                <li key={a.id} className="assume">
                  <span className="strong">{a.text}</span>
                  <span className="muted small">{a.why}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {e.undecided.items.length > 0 && (
          <section aria-labelledby="h-undecided" className="card pad">
            <h2 id="h-undecided">
              {W['entrance.undecidedHeading']}{' '}
              <span className="count">{w('count', { n: e.undecided.items.length })}</span>
            </h2>
            <p className="muted small">{W['entrance.undecidedLead']}</p>
            <ol className="questions">
              {e.undecided.items.map((u) => (
                <li key={u.id} className="question">
                  <p className="strong question-text">
                    {u.question}
                    {u.multiple && <span className="pick-many">{W['entrance.pickMany']}</span>}
                  </p>
                  {u.multiple ? (
                    <>
                      <ChooseMany
                        label={u.question}
                        value={[picked(u)].flat()}
                        disabled={readOnly || p.locked}
                        // おまかせと選択肢は互いに外れる
                        onChange={(v) => {
                          const was = picked(u)
                          pick(u, v.includes(LEAVE_IT) && was !== LEAVE_IT ? LEAVE_IT : v.filter((x) => x !== LEAVE_IT))
                        }}
                        options={options(u)}
                      />
                      {empty(u) && (
                        <p className="note-warn small" role="alert">
                          {W['entrance.pickNone']}
                        </p>
                      )}
                    </>
                  ) : (
                    <Choose
                      label={u.question}
                      value={[picked(u)].flat()[0] ?? ''}
                      disabled={readOnly || p.locked}
                      onChange={(v) => pick(u, v === LEAVE_IT ? LEAVE_IT : [v])}
                      options={options(u)}
                    />
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {e.undecided.mismatches.length > 0 && (
          <section aria-labelledby="h-mismatch" className="card pad mismatch">
            <h2 id="h-mismatch">{W['entrance.mismatchHeading']}</h2>
            <p className="muted small">{W['entrance.mismatchLead']}</p>
            <ul>
              {e.undecided.mismatches.map((m) => (
                <li key={m.checkId} className="mismatch-row">
                  <div>
                    <span className="muted small">{W['entrance.mismatch.brief']}</span>
                    <p>{m.briefSays}</p>
                  </div>
                  <div>
                    <span className="muted small">
                      {W['entrance.mismatch.check']} {m.checkId}
                    </span>
                    <p>{m.checkExpects}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="h-checks" className="card pad">
          <h2 id="h-checks">
            {W['entrance.checksHeading']} <span className="count">{w('count', { n: e.checks.count })}</span>
          </h2>
          <p className={e.checks.family === '同系統' ? 'note-warn small' : 'muted small'}>
            {e.checks.family === '同系統' ? W['entrance.sameFamily'] : W['entrance.otherFamily']}
            {e.checks.fallback && (
              <>
                {' '}
                {W[`entrance.fallback.${e.checks.fallback}`]}{' '}
                <Link href="/settings">{W['entrance.fallback.link']}</Link>
              </>
            )}
          </p>
          <ul className="cats">
            {cats.map(([k, n]) => (
              <li key={k} className="badge b-off">
                {k} {n}
              </li>
            ))}
          </ul>
          <Fold trigger={(open) => (open ? W['entrance.checksHide'] : W['entrance.checksShow'])}>
            <ol className="checks">
              {e.checks.items.map((x) => (
                <li key={x.id} className="check">
                  <span className="check-id muted small">{x.id}</span>
                  <div className="grow">
                    <p className="strong">{x.title}</p>
                    {!x.isolation && (
                      <p className="muted small">
                        {W['entrance.ifNg']} {x.summary}
                      </p>
                    )}
                    <div className="row-gap">
                      <span className="badge b-off badge-sm">{x.category}</span>
                      <span className="badge b-off badge-sm">{W[`entrance.method.${x.method}`]}</span>
                      {x.phase === '形式' && <span className="badge b-off badge-sm">{W['entrance.phase.形式']}</span>}
                      {!x.isolation && (
                        <span className={`badge badge-sm ${x.hidden ? 'b-run' : 'b-off'}`}>
                          {x.hidden ? W['entrance.hidden.true'] : W['entrance.hidden.false']}
                        </span>
                      )}
                      {x.minority && <span className="badge b-you badge-sm">{W['entrance.minority']}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Fold>
        </section>
      </div>

      <aside className="entrance-side stack">
        <section aria-labelledby="h-mode" className="card pad">
          <h2 id="h-mode">{W['entrance.modeHeading']}</h2>
          <Choose
            label={W['entrance.modeHeading']}
            value={mode}
            disabled={readOnly || p.locked}
            onChange={(v) => setMode(v as Mode)}
            options={(['確認しながら', 'おまかせ'] as const).map((m) => ({
              value: m,
              label: m,
              note: W[`entrance.mode.${m}`],
            }))}
          />
          <p className="muted small">{w('entrance.costCap', { cap: yen(c.costCapYen) })}</p>
        </section>
        {p.canApprove && unanswered && <p className="note-warn small">{W['entrance.unanswered']}</p>}
        {p.canApprove && (
          <button
            type="submit"
            className="btn btn-primary btn-wide"
            disabled={p.locked || unanswered}
            aria-busy={p.locked || undefined}
          >
            {W['entrance.approve']}
          </button>
        )}
        {p.actions}
      </aside>
    </form>
  )
}

function Actions(p: {
  c: CaseView
  mine: boolean
  locked: boolean
  busy: boolean
  revising: boolean
  setRevising: (v: boolean) => void
  talking: boolean
  setTalking: (v: boolean) => void
  revise: (note: string) => Promise<boolean>
  cancel: () => void
}) {
  const [note, setNote] = useState('')
  // 自動で入った案件は、書いている間でも出し直せる（T7）。それ以外は本人の番のときだけ
  const canRevise = p.mine || p.c.auto
  const send = async () => {
    const text = note.trim()
    if (!text || p.locked) return
    if (await p.revise(text)) {
      setNote('')
      p.setRevising(false)
    }
  }
  return (
    <div className="stack entrance-actions">
      {canRevise &&
        (p.revising ? (
          <div className="card pad revise">
            <label htmlFor="revise-note" className="strong small">
              {W['entrance.reviseLabel']}
            </label>
            <textarea
              id="revise-note"
              rows={3}
              value={note}
              maxLength={2000}
              onChange={(ev) => setNote(ev.target.value)}
              disabled={p.locked}
            />
            <div className="row-gap">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={p.locked || !note.trim()}
                aria-busy={p.busy || undefined}
                onClick={() => void send()}
              >
                {W['entrance.reviseSend']}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => p.setRevising(false)}>
                {W['entrance.reviseCancel']}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-wide"
            disabled={p.locked}
            onClick={() => p.setRevising(true)}
          >
            {W['entrance.revise']}
          </button>
        ))}
      {p.mine && !p.c.auto && p.c.entrance && (
        <button
          type="button"
          className="btn btn-secondary btn-wide"
          aria-expanded={p.talking}
          disabled={p.locked}
          onClick={() => p.setTalking(!p.talking)}
        >
          {W['entrance.talk']}
        </button>
      )}
      <Confirm
        trigger={W['entrance.cancel']}
        title={W['entrance.cancelTitle']}
        body={W['entrance.cancelBody']}
        confirm={W['entrance.cancel']}
        cancel={W['entrance.cancelNo']}
        danger
        busy={p.locked}
        triggerClass="btn btn-quiet btn-wide"
        onConfirm={p.cancel}
      />
    </div>
  )
}
