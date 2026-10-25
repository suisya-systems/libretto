// 準備中の面・見つからない面・読めなかったときの面（docs/implementation.md 5.8 (3)）。読めないことを空の一覧で描かない
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { z } from 'zod'
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
  if (problem === 'not_paired') return <NotPaired />
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

// つながっていない面（6.12 (9)）。Cookie は起点ごとなので、同じブラウザでもほかの起点ではつながっていることがある。
// 401 の本文の起点の一覧から、今の起点以外の同じページへのリンクを出す。読めなければ出さないだけ
const Origins = z.object({ origins: z.array(z.string()) })
function NotPaired() {
  const [others, setOthers] = useState<string[]>([])
  useEffect(() => {
    const ac = new AbortController()
    fetch('/api/host', { signal: ac.signal, headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((j) => {
        const p = Origins.safeParse(j)
        if (p.success) setOthers(p.data.origins.filter((o) => /^https?:\/\//.test(o) && o !== location.origin))
      })
      .catch(() => {})
    return () => ac.abort()
  }, [])
  const here = location.pathname + location.search + location.hash
  return (
    <div className="pair">
      <div className="pair-card card" role="alert">
        <div className="brand brand-dark">libretto</div>
        <h1>{W['pair.title']}</h1>
        {others.length > 0 && (
          <>
            <p>{W['pair.elsewhere']}</p>
            <ul className="pair-links">
              {others.map((o) => (
                <li key={o}>
                  <a href={o + here}>{o + here}</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">{W['pair.add']}</p>
        <p className="muted">{W['pair.body']}</p>
      </div>
    </div>
  )
}
