// 入口（依頼の確認）と承認の面の帯: チェック項目を書く側から隠す仕組みが弱い・動かない（docs/implementation.md 8.5・8.10 (6)）
import type { HostStatus } from '@libretto/shared/api'
import { Link } from 'wouter'
import { W } from '../wording.ts'

export function IsolationBand({ level }: { level: HostStatus['isolation'] | undefined }) {
  if (!level || level === 'strong') return null
  const broken = level === 'broken'
  return (
    <p className={`band ${broken ? 'band-stopped' : 'band-warn'}`} role={broken ? 'alert' : 'status'}>
      <span className="band-dot" aria-hidden="true" />
      <strong>{broken ? W['band.isolationBroken'] : W['band.isolationWeak']}</strong>
      <Link href="/settings">{W['band.isolationLink']}</Link>
    </p>
  )
}
