// 動作環境の確認で足りないものの数と、ホーム・設定の先頭の帯（docs/implementation.md 6.13 (2)）。
// 節は設定のいちばん下にあるので、足りないときは先頭から節へ飛べるようにする
import type { ConnectionsView } from '@libretto/shared/api'
import { Link } from 'wouter'
import { W, w } from '../wording.ts'

// 節の行と同じ数え方。スマホから開くのは任意なので数えない
export function envMissing(c: ConnectionsView): number {
  const { isolation, tools, env, slack, slackDm, google } = c
  return [
    env.ai.state !== 'ok',
    isolation.level !== 'strong',
    !(tools.soffice && tools.pdftoppm),
    (slack.configured || slackDm.state !== 'none') &&
      (slack.missingScopes.length > 0 || slackDm.state === 'missingScope'),
    google.state === 'connected' &&
      (google.problem === 'api_disabled' ||
        google.docsProblem === 'api_disabled' ||
        google.meetProblem === 'api_disabled'),
  ].filter(Boolean).length
}

// 設定の中では同じページの節へ、ホームからは設定の節へ
export function EnvBand({ c, here = false }: { c: ConnectionsView | undefined; here?: boolean }) {
  const n = c ? envMissing(c) : 0
  if (!n) return null
  return (
    <p className="band band-warn" role="status">
      <span className="band-dot" aria-hidden="true" />
      <strong>{w('band.envMissing', { n })}</strong>
      {here ? <a href="#h-env">{W['band.envLink']}</a> : <Link href="/settings#h-env">{W['band.envLink']}</Link>}
    </p>
  )
}
