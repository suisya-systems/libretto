// ホーム（画面案 1。docs/implementation.md 5.8 (3)・6.2.1 (9)・6.4 (7)）。候補の欄は連携しているか候補があるときだけ
import { type CaseCard, HomeView } from '@libretto/shared/api'
import { Link } from 'wouter'
import { useCaseAction } from '../action.ts'
import { useLoad } from '../load.ts'
import { Confirm } from '../parts/Dialog.tsx'
import { STATE, W, w } from '../wording.ts'
import { Candidates, when } from './Candidates.tsx'
import { Chat } from './Chat.tsx'
import { ProblemView } from './Pending.tsx'

// 凡例の色（5.8 (5)）: 確認待ち=琥珀、進行中=藍、完了=緑、止まった=朱
export function tone(c: Pick<CaseCard, 'state' | 'turn'>) {
  if (c.state === '完了') return 'b-done'
  if (c.state === '停止' || c.state === '材料待ち') return 'b-alert'
  if (c.state === '見送り' || c.state === '取り消し' || c.state === '候補') return 'b-off'
  return c.turn === '本人' ? 'b-you' : 'b-run'
}

const yen = (n: number) => n.toLocaleString('ja-JP')
const today = () => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format()

function Meta({ c }: { c: CaseCard }) {
  return (
    <div className="muted small">
      {c.version > 0 && w('card.version', { n: c.version })}
      {c.deadline && <> ・ {w('card.deadline', { d: c.deadline })}</>}
      {c.auto && <span className="badge b-run badge-sm">{W['card.auto']}</span>}
    </div>
  )
}

// 自動で開始した依頼の 1 枚（6.11 (5)）。どこから・いつ・今の段階・費用・取り消す（送付中と終わったものは取り消せない）
const CANCELABLE: readonly CaseCard['state'][] = [
  '入口待ち',
  '材料待ち',
  '下書き中',
  '検品中',
  '承認待ち',
  '送付確認待ち',
]
function AutoCard({ c, reload, stopped }: { c: CaseCard; reload: () => void; stopped: boolean }) {
  const action = useCaseAction(c.id, reload)
  const from = c.origin.kind === '会議' ? 'meet' : c.origin.kind === '合図' ? c.origin.source : undefined
  return (
    <div className="card pad">
      <Link href={`/cases/${c.id}`} className="strong">
        {c.title}
      </Link>
      <div className="muted small">
        {from && W[`home.auto.from.${from}`]}
        {c.startedAt && <> ・ {w('home.auto.at', { at: when(c.startedAt) })}</>}
      </div>
      <div className="row-gap">
        <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
        <span className="muted small">{c.step}</span>
      </div>
      <div className="muted small">{w('card.cost', { yen: yen(c.costYen), cap: yen(c.costCapYen) })}</div>
      {CANCELABLE.includes(c.state) && !stopped && (
        <Confirm
          trigger={W['entrance.cancel']}
          title={W['entrance.cancelTitle']}
          body={W['entrance.cancelBody']}
          confirm={W['entrance.cancel']}
          cancel={W['entrance.cancelNo']}
          danger
          busy={action.busy}
          triggerClass="btn btn-quiet btn-sm"
          onConfirm={() => void action.run({ type: 'cancel', expectedRevision: c.revision })}
        />
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>
}

export function Home({ stopped = false }: { stopped?: boolean }) {
  // 裏の取り込みで増えた候補と、連携の有無の変化でも取り直す（6.4 (7)）
  const home = useLoad('/api/home', HomeView, (s) =>
    ['case.changed', 'notice', 'candidates.changed', 'connections.changed'].includes(s.event),
  )
  const v = home.data
  if (!v) return home.problem ? <ProblemView problem={home.problem} retry={home.reload} /> : <div aria-busy="true" />

  const open = [...v.yourTurn, ...v.active]
  return (
    <div className="face home">
      {home.problem && <ProblemView problem={home.problem} retry={home.reload} />}
      <header className="home-head">
        <div>
          <div className="muted small">{today()}</div>
          <h1 className="face-title">
            {v.yourTurn.length ? w('home.yourTurn', { n: v.yourTurn.length }) : W['home.noTurn']}
          </h1>
          {!v.yourTurn.length && <p className="lead">{W['home.noTurnLead']}</p>}
        </div>
      </header>

      {v.yourTurn.length > 0 && (
        <section aria-labelledby="h-you" className="stack">
          <h2 id="h-you">{W['home.turnHeading']}</h2>
          {v.yourTurn.map((c) => (
            <div key={c.id} className="card turn-card">
              <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
              <div className="grow">
                <div className="strong">{c.title}</div>
                <div className="muted">{c.step}</div>
              </div>
              <Link href={`/cases/${c.id}`} className="btn btn-primary">
                {W['home.open']}
              </Link>
            </div>
          ))}
        </section>
      )}

      <Chat stopped={stopped} />

      <Candidates v={v} stopped={stopped} reload={home.reload} />

      <div className="two">
        <section aria-labelledby="h-auto" className="stack">
          <h2 id="h-auto">
            {W['home.autoHeading']} <span className="count">{w('count', { n: v.autoStarted.length })}</span>
          </h2>
          {v.autoStarted.length ? (
            v.autoStarted.map((c) => <AutoCard key={c.id} c={c} reload={home.reload} stopped={stopped} />)
          ) : (
            <Empty text={W['home.autoEmpty']} />
          )}
        </section>

        <section aria-labelledby="h-notice" className="stack">
          <h2 id="h-notice">{W['home.noticeHeading']}</h2>
          {v.notices.length ? (
            <ul className="card notices">
              {v.notices.map((n) => (
                <li key={n.id}>
                  <time className="muted small">{n.at.slice(11, 16)}</time> <Link href={n.path}>{n.text}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty text={W['home.noticeEmpty']} />
          )}
        </section>
      </div>

      <section aria-labelledby="h-active" className="stack">
        <h2 id="h-active">
          {W['home.activeHeading']} <span className="count">{w('count', { n: open.length })}</span>
        </h2>
        {open.length ? (
          <table className="card table" aria-labelledby="h-active">
            <thead>
              <tr className="tr th">
                <th scope="col">{W['home.colCase']}</th>
                <th scope="col">{W['home.colState']}</th>
                <th scope="col">{W['home.colNext']}</th>
                <th scope="col">{W['home.colMode']}</th>
              </tr>
            </thead>
            <tbody>
              {open.map((c) => (
                <tr key={c.id} className="tr">
                  <td>
                    <Link href={`/cases/${c.id}`} className="strong">
                      {c.title}
                    </Link>
                    <Meta c={c} />
                  </td>
                  <td>
                    <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
                  </td>
                  <td className={c.turn === '本人' ? '' : 'muted'}>
                    {c.turn === '本人' ? (c.nextForPerson ?? c.step) : W['home.nextNone']}
                  </td>
                  <td>
                    <span className="badge b-off">{c.mode}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text={W['home.activeEmpty']} />
        )}
      </section>

      <section aria-labelledby="h-mode" className="card pad">
        <h2 id="h-mode">{W['home.defaultsHeading']}</h2>
        <dl className="defaults">
          {(['会話', 'gmail', 'slack', 'meet'] as const).map((k) => (
            <div key={k}>
              <dt className="muted small">{W[`home.src.${k}`]}</dt>
              <dd className="strong">{v.defaults[k]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
