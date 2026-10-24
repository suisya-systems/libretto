// 準備中の面・見つからない面・読めなかったときの面（docs/implementation.md 5.8 (3)）。読めないことを空の一覧で描かない
import { Link } from 'wouter'
import type { Problem } from '../load.ts'
import { W } from '../wording.ts'

export function Pending({ title }: { title: string }) {
  return (
    <section className="face">
      <h1 className="face-title">
        {title} <span className="badge b-off">{W['pending.badge']}</span>
      </h1>
      <p className="muted">{W['pending.body']}</p>
    </section>
  )
}

export function NotFound() {
  return (
    <section className="face">
      <h1 className="face-title">{W['notFound.title']}</h1>
      <Link href="/" className="btn btn-secondary">
        {W['notFound.home']}
      </Link>
    </section>
  )
}

export function ProblemView({ problem, retry }: { problem: Problem; retry?: () => void }) {
  if (problem === 'not_paired')
    return (
      <div className="pair">
        <div className="pair-card card" role="alert">
          <div className="brand brand-dark">libretto</div>
          <h1>{W['pair.title']}</h1>
          <p className="muted">{W['pair.body']}</p>
        </div>
      </div>
    )
  if (problem === 'not_found') return <NotFound />
  return (
    <div className="problem card" role="alert">
      <span className="badge b-alert">{problem === 'offline' ? W['load.offline'] : W['load.failed']}</span>
      {retry && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>
          {W['load.retry']}
        </button>
      )}
    </div>
  )
}
