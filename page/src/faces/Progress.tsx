// 進行の面（画面 3。docs/implementation.md 6.2.3 (8)）。材料待ち・下書き中・検品中・送付中と、停止・取り消し
import { ActionResult, type CaseState, type CaseView } from '@libretto/shared/api'
import type { FormEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useCaseAction } from '../action.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { STATE, W, type WKey, w } from '../wording.ts'
import { tone } from './Home.tsx'

export const PROGRESS_STATES: readonly CaseState[] = ['材料待ち', '下書き中', '検品中', '送付中', '停止', '取り消し']

const STEPS = ['entrance', 'materials', 'draft', 'check', 'approve', 'save'] as const
type Step = (typeof STEPS)[number]
// 状態 → 段取りの帯のどこにいるか
const AT: Partial<Record<CaseState, Step>> = {
  入口待ち: 'entrance',
  材料待ち: 'materials',
  下書き中: 'draft',
  検品中: 'check',
  承認待ち: 'approve',
  送付確認待ち: 'save',
  送付中: 'save',
}

const yen = (n: number) => n.toLocaleString('ja-JP')
const time = (at: string) =>
  new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  )
const has = (key: string): key is WKey => key in W

// 止まった・取り消した案件は、止まる前にいた段（最後の遷移の from）
function stepOf(c: CaseView): Step {
  if (c.state !== '停止' && c.state !== '取り消し') return AT[c.state] ?? 'entrance'
  const last = c.events.findLast((e) => e.type === 'transition' && e.to === c.state)
  return (last?.from && AT[last.from]) || 'entrance'
}

// 中身を確かめられなかった Google のファイル（照合に落ちた・確かめられないまま止まった）。本人に消してもらう（6.5 (6)・6.10 (4)）
const GOOGLE = new Set(['gdoc', 'gsheet', 'gslide'])
export function Leftovers({ c }: { c: CaseView }) {
  const left = c.deliveries.filter((d) => d.status === '失敗' && GOOGLE.has(d.target.kind) && d.link)
  if (!left.length) return null
  return (
    <div className="band band-warn stack" role="note">
      <p>{W['result.leftover']}</p>
      <ul className="plain-list">
        {left.map((d) => (
          <li key={d.attemptId}>
            <a href={d.link} target="_blank" rel="noopener noreferrer">
              {w('result.leftoverOpen', { n: d.version })}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ProgressFace({ c, reload, stopped }: { c: CaseView; reload: () => void; stopped: boolean }) {
  const action = useCaseAction(c.id, reload)
  const [, navigate] = useLocation()
  const ended = c.state === '停止' || c.state === '取り消し'
  const current = stepOf(c)
  // 渡してほしいものを待っている（T8 の後の本人の番。6.2.4 (5)）
  const waiting = c.state === '材料待ち' && c.turn === '本人'
  const at = STEPS.indexOf(current)
  const restart = () =>
    void action.run({ type: 'restart_as_new', expectedRevision: c.revision }, (res) =>
      res
        .json()
        .then((j) => ActionResult.parse(j).newCaseId)
        .then((id) => id && navigate(`/cases/${id}`))
        .catch(() => {}),
    )
  const reason = c.stopReason && has(`reason.${c.stopReason}`) ? W[`reason.${c.stopReason}` as WKey] : W['reason.other']

  return (
    <section className="face progress">
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <CaseHeader c={c} />

      {action.notice && (
        <p className="band band-stopped" role="alert">
          <strong>{action.notice === 'moved' ? W['action.moved'] : W['band.sendFailed']}</strong>
        </p>
      )}

      {ended ? (
        <div className={`card now now-ended ${c.state === '停止' ? 'now-stopped' : 'now-cancelled'}`} role="status">
          <h2 className="now-title">
            {c.state === '停止' ? W['progress.stoppedHeading'] : W['progress.cancelledHeading']}
          </h2>
          {c.state === '停止' ? (
            <>
              <p className="now-reason">{reason}</p>
              <p className="muted">{W['progress.stoppedLead']}</p>
              <div className="row-gap now-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={action.busy || stopped}
                  aria-busy={action.busy || undefined}
                  onClick={restart}
                >
                  {W['progress.restart']}
                </button>
                <span className="muted small">{W['progress.restartNote']}</span>
              </div>
            </>
          ) : (
            <p className="muted">{W['progress.cancelledLead']}</p>
          )}
        </div>
      ) : waiting ? (
        <MaterialsCard
          c={c}
          locked={action.busy || stopped}
          busy={action.busy}
          send={(text) => action.run({ type: 'materials.provided', expectedRevision: c.revision, text })}
          stop={
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
          }
        />
      ) : (
        <div className="card now" role="status" aria-live="polite">
          <div className="now-eyebrow">
            <span className="dots" aria-hidden="true" />
            {W['progress.now']}
          </div>
          <h2 className="now-title">{c.step}</h2>
          {c.state === '検品中' && (
            <p className="now-round">{w('progress.round', { n: c.rounds.used + 1, max: c.rounds.max })}</p>
          )}
          <p className="muted">{W['progress.lead']}</p>
          <div className="now-next">
            <h3>{W['progress.nextHeading']}</h3>
            <p>{W['progress.nextNone']}</p>
            {(c.state === '下書き中' || c.state === '検品中') && <p className="muted">{W['progress.redoLater']}</p>}
          </div>
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
        </div>
      )}

      <ol className="steps" aria-label={W['progress.stepsLabel']}>
        {STEPS.map((s, i) => {
          const state = i < at ? 'done' : i > at ? 'todo' : ended ? 'halted' : 'now'
          const note =
            state === 'done'
              ? s === 'draft' && c.version > 0
                ? w('progress.draftUpTo', { n: c.version })
                : W['progress.stepDone']
              : state === 'now'
                ? waiting
                  ? W['progress.stepYours']
                  : W['progress.stepNow']
                : state === 'halted'
                  ? W['progress.stepHalted']
                  : s === 'approve' && !ended
                    ? c.mode === 'おまかせ'
                      ? W['progress.stepAuto']
                      : W['progress.stepNext']
                    : ''
          return (
            <li
              key={s}
              className={`step step-${state}${state === 'now' && waiting ? ' step-yours' : ''}`}
              aria-current={state === 'now' ? 'step' : undefined}
            >
              <span className="step-n" aria-hidden="true">
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span className="step-label">{W[`progress.step.${s}`]}</span>
              {note && <span className="step-note">{note}</span>}
            </li>
          )
        })}
      </ol>

      <Leftovers c={c} />
      <Versions c={c} />

      {(c.materials.length > 0 || c.gatherFailed) && (
        <section aria-labelledby="h-materials" className="stack">
          <h2 id="h-materials">{W['progress.materialsHeading']}</h2>
          <ul className="card plain-list">
            {c.materials.map((m) => (
              <li key={m.id}>
                {/^https?:\/\//.test(m.where) ? (
                  <a href={m.where} target="_blank" rel="noopener noreferrer" className="strong source-title">
                    {m.title}
                    <span className="muted small">（{W['approval.sourceOpens']}）</span>
                  </a>
                ) : (
                  <span className="strong">{m.title}</span>
                )}{' '}
                <span className="muted small">{m.kind}</span>
                {m.gathered && <span className="badge b-off badge-sm">{W['progress.materialGathered']}</span>}
              </li>
            ))}
            {c.gatherFailed && <li className="muted">{W['progress.gatherFailed']}</li>}
          </ul>
        </section>
      )}

      <History c={c} />
    </section>
  )
}

// 頭・バージョン・履歴は承認の面（Approval.tsx）でも使う
export function CaseHeader({ c }: { c: CaseView }) {
  return (
    <header className="progress-head">
      <div className="row-gap">
        <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
        <span className="badge b-off">{c.mode}</span>
        {c.auto && <span className="badge b-run">{W['card.auto']}</span>}
      </div>
      <h1 className="face-title">{c.title}</h1>
      <p className="muted small progress-meta">
        {c.deadline && <>{w('card.deadline', { d: c.deadline })} ・ </>}
        {W['case.cost']} {w('card.cost', { yen: yen(c.costYen), cap: yen(c.costCapYen) })}
        {c.costNote && <> ・ {c.costNote}</>}
      </p>
    </header>
  )
}

export function Versions({ c }: { c: CaseView }) {
  return (
    <section aria-labelledby="h-versions" className="stack">
      <div className="row-between wrap">
        <h2 id="h-versions">{W['progress.versionsHeading']}</h2>
        <span className="muted small">{W['progress.versionsNote']}</span>
      </div>
      {c.versions.length ? (
        <ol className="card versions">
          {[...c.versions].reverse().map((v) => {
            const failed = c.review?.n === v.n ? c.review.failed : []
            const checking = v.state === '検品中'
            return (
              <li key={v.n} className="version">
                <div className="version-head">
                  <span className="strong">{w('card.version', { n: v.n })}</span>
                  <span className="muted small">{time(v.at)}</span>
                </div>
                <div className="version-body">
                  <div className="row-gap">
                    {(!checking || (c.state === '検品中' && v.n === c.version)) && (
                      <span className={`badge badge-sm ${VERSION_TONE[v.state]}`}>{W[`progress.ver.${v.state}`]}</span>
                    )}
                    <span className="muted small">
                      {w('progress.versionSize', { chars: v.chars, headings: v.headings })}
                    </span>
                  </div>
                  {failed.length > 0 && (
                    <ul className="failed">
                      {failed.map((f) => (
                        <li key={f.checkId}>{f.title}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="empty">{W['progress.versionsEmpty']}</p>
      )}
    </section>
  )
}

// 不合格の行き先で文を替える: 下書き中 → 書き直しに回した、承認待ち → 確認に回した、停止 → 中止した（6.2.7 (5)）
const failTo = (e: CaseView['events'][number]) =>
  e.event === 'review.fail' || e.event === 'format.failed'
    ? e.to === '承認待ち'
      ? '.up'
      : e.to === '停止'
        ? '.stop'
        : ''
    : ''

// 保存先の名前の入った文があればそれ、無ければ（古い行・文の無い種類）名前の無い文（#21）
const named = (key: string, e: CaseView['events'][number]) =>
  e.target && has(`${key}.${e.target.kind}`) ? `${key}.${e.target.kind}` : key

export function History({ c }: { c: CaseView }) {
  const history = c.events
    .filter((e) => e.type === 'created' || e.type === 'transition')
    .map((e, n) => ({
      n,
      at: e.at,
      key: e.type === 'created' ? 'event.created' : named(`event.${e.event}${failTo(e)}`, e),
    }))
    .filter((e): e is { n: number; at: string; key: WKey } => has(e.key))
    .reverse()
  return (
    <section aria-labelledby="h-history" className="stack">
      <h2 id="h-history">{W['progress.historyHeading']}</h2>
      <ol className="card history">
        {history.map((e) => (
          <li key={e.n}>
            <time className="muted small" dateTime={e.at}>
              {time(e.at)}
            </time>
            <span>{W[e.key]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// 材料待ち・本人の番: 渡してほしいものと貼り付けの欄（6.2.4 (5)）
function MaterialsCard(p: {
  c: CaseView
  locked: boolean
  busy: boolean
  send: (text: string) => Promise<boolean>
  stop: ReactNode
}) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const wanted = p.c.entrance?.brief.wanted ?? []
  const chars = [...text.trim()].length
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (p.locked) return
    // 空のまま押したら欄へ（次の一手を弱く描かないよう、ボタンは押せる形のまま）
    if (!chars) area.current?.focus()
    else void p.send(text)
  }
  return (
    <form className="card now now-yours" aria-labelledby="h-now" onSubmit={submit}>
      <div className="now-eyebrow now-eyebrow-yours">{W['materials.eyebrow']}</div>
      <h2 id="h-now" className="now-title">
        {p.c.step}
      </h2>
      <p className="muted">{W['materials.lead']}</p>
      {wanted.length > 0 && (
        <div className="now-next">
          <h3>{W['materials.wantedHeading']}</h3>
          <ul className="wanted">
            {wanted.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="paste">
        <label htmlFor="paste-text" className="strong small">
          {W['materials.label']}
        </label>
        <textarea
          id="paste-text"
          ref={area}
          rows={10}
          value={text}
          maxLength={MAX_PASTE}
          onChange={(ev) => setText(ev.target.value)}
          disabled={p.locked}
          aria-describedby="paste-count"
        />
        <span id="paste-count" className="muted small paste-count">
          {w('materials.count', { n: chars.toLocaleString('ja-JP') })}
        </span>
      </div>
      <div className="row-gap now-actions">
        <button type="submit" className="btn btn-primary" disabled={p.locked} aria-busy={p.busy || undefined}>
          {W['materials.send']}
        </button>
        {p.stop}
      </div>
    </form>
  )
}
// MaterialsPost の上限（shared/src/api.ts）
const MAX_PASTE = 100_000

const VERSION_TONE = { 検品中: 'b-run', 合格: 'b-done', 不合格: 'b-alert', 承認済み: 'b-done' } as const
