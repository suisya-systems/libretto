// 完了した依頼（/done。docs/implementation.md 6.2.8 (9)）。題・完了日・開く だけ
import { CaseCard } from '@libretto/shared/api'
import { Link } from 'wouter'
import { useLoad } from '../load.ts'
import { W } from '../wording.ts'
import { ProblemView } from './Pending.tsx'

const LIST = CaseCard.array()
const day = (at: string) =>
  new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(at))

export function Done() {
  const list = useLoad('/api/cases?state=完了', LIST, (s) => s.event === 'case.changed')
  const cases = list.data
  if (!cases)
    return list.problem ? <ProblemView problem={list.problem} retry={list.reload} /> : <div aria-busy="true" />
  return (
    <section className="face done">
      {list.problem && <ProblemView problem={list.problem} retry={list.reload} />}
      <h1 className="face-title">{W['nav.done']}</h1>
      {cases.length ? (
        <ul className="card done-list">
          {cases.map((c) => (
            <li key={c.id} className="done-row">
              <div className="grow">
                <div className="strong">{c.title}</div>
                {c.doneAt && (
                  <time className="muted small" dateTime={c.doneAt}>
                    {day(c.doneAt)}
                  </time>
                )}
              </div>
              <Link href={`/cases/${c.id}`} className="btn btn-secondary btn-sm">
                {W['done.open']}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">{W['done.empty']}</p>
      )}
    </section>
  )
}
