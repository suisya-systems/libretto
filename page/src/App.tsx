// 画面の枠: ナビ・止めた帯・保存できない帯・つながらない帯と、経路ごとの面（docs/implementation.md 5.8 (1)(3)）
import { HostStatus } from '@libretto/shared/api'
import { useState } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'
import { Case } from './faces/Case.tsx'
import { Done } from './faces/Done.tsx'
import { Home } from './faces/Home.tsx'
import { NotFound, ProblemView } from './faces/Pending.tsx'
import { Settings } from './faces/Settings.tsx'
import { send, useLoad, useOffline } from './load.ts'
import { Confirm } from './parts/Dialog.tsx'
import { W } from './wording.ts'

const NAV = [
  ['/', W['nav.home']],
  ['/done', W['nav.done']],
  ['/settings', W['nav.settings']],
] as const

export function App() {
  const host = useLoad('/api/host', HostStatus, (s) => s.event === 'host.changed')
  const offline = useOffline()
  const [location] = useLocation()
  const [busy, setBusy] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)

  if (host.problem === 'not_paired') return <ProblemView problem="not_paired" />

  const act = async (method: 'POST' | 'DELETE') => {
    setBusy(true)
    setSendFailed(false)
    const ok = await send(method, '/api/stop')
    setBusy(false)
    setSendFailed(!ok)
    host.reload()
  }
  // ログインし直した本人の「続ける」（6.2.3 (7)）
  const resume = async () => {
    setBusy(true)
    setSendFailed(false)
    const ok = await send('POST', '/api/host/resume')
    setBusy(false)
    setSendFailed(!ok)
    host.reload()
  }
  const stopped = host.data?.stopped ?? false

  return (
    <div className="shell">
      <header className="nav">
        <Link href="/" className="brand">
          libretto
        </Link>
        <nav aria-label={W['nav.label']} className="nav-links">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} aria-current={location === href ? 'page' : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <Confirm
          trigger={W['stop.button']}
          title={W['stop.title']}
          body={W['stop.body']}
          confirm={W['stop.button']}
          cancel={W['stop.cancel']}
          danger
          disabled={stopped}
          busy={busy}
          triggerClass="btn nav-stop"
          onConfirm={() => void act('POST')}
        />
      </header>
      <main className="main">
        <div className="bands">
          {/* 止まっているかが読めないときも黙らない（止めた帯が出ないまま「止まっていない」に見えるため） */}
          {(offline || host.problem) && (
            <div className="band band-stopped" role="status">
              <span className="band-dot" aria-hidden="true" />
              <strong>{offline || host.problem === 'offline' ? W['load.offline'] : W['load.failed']}</strong>
              <button type="button" className="btn btn-secondary btn-sm" onClick={host.reload}>
                {W['load.retry']}
              </button>
            </div>
          )}
          {stopped && (
            <div className="band band-stopped" role="status">
              <span className="band-dot" aria-hidden="true" />
              <strong>{W['band.stopped']}</strong>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void act('DELETE')}
              >
                {W['band.release']}
              </button>
            </div>
          )}
          {host.data?.signIn && (
            <div className="band band-stopped" role="alert">
              <span className="band-dot" aria-hidden="true" />
              <strong>{W['band.signIn']}</strong>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void resume()}
              >
                {W['band.signInResume']}
              </button>
            </div>
          )}
          {host.data && !host.data.storageOk && (
            <div className="band band-stopped" role="alert">
              <span className="band-dot" aria-hidden="true" />
              <strong>{W['band.storage']}</strong>
            </div>
          )}
          {sendFailed && (
            <div className="band band-stopped" role="alert">
              <strong>{W['band.sendFailed']}</strong>
            </div>
          )}
        </div>
        <Switch>
          <Route path="/">{() => <Home stopped={stopped} />}</Route>
          {/* 送付の確認は案件の面が状態で出す。/deliver は同じ面の別名（6.2.8 (6)） */}
          <Route path="/cases/:id/deliver">
            {(p) => <Case key={p.id} id={p.id} stopped={stopped} isolation={host.data?.isolation} />}
          </Route>
          <Route path="/cases/:id">
            {(p) => <Case key={p.id} id={p.id} stopped={stopped} isolation={host.data?.isolation} />}
          </Route>
          <Route path="/done">{() => <Done />}</Route>
          <Route path="/settings" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  )
}
