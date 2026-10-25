// 依頼の面。入口待ちは依頼の確認（Issue 9。6.2.2 (10)）、材料待ち〜送付中と停止・取り消しは進行（Issue 10。6.2.3 (8)）、
// 承認待ち（完成稿）は承認（Issue 11。6.2.5 (8)）、承認待ち（構成案）は構成案（6.12 (3)）、送付確認待ち・本人の番は送付、
// 完了は成果（Issue 12。6.2.8 (6)(7)）、ほかは見出しだけ（5.8 (3)）
import { CaseView, type HostStatus } from '@libretto/shared/api'
import { Link } from 'wouter'
import { useLoad } from '../load.ts'
import { STATE, W, w, yen } from '../wording.ts'
import { ApprovalFace } from './Approval.tsx'
import { DeliverFace, ResultFace } from './Deliver.tsx'
import { EntranceFace } from './Entrance.tsx'
import { tone } from './Home.tsx'
import { OutlineFace } from './Outline.tsx'
import { ProblemView } from './Pending.tsx'
import { PROGRESS_STATES, ProgressFace } from './Progress.tsx'

export function Case({
  id,
  stopped = false,
  isolation,
}: {
  id: string
  stopped?: boolean
  isolation?: HostStatus['isolation'] | undefined
}) {
  const one = useLoad(
    `/api/cases/${encodeURIComponent(id)}`,
    CaseView,
    (s) => s.event === 'case.changed' && (s.data as { caseId?: string }).caseId === id,
  )
  const c = one.data
  if (!c) {
    if (one.problem === 'not_found')
      return (
        <section className="face">
          <h1 className="face-title">{W['case.notFound']}</h1>
          <Link href="/" className="btn btn-secondary">
            {W['notFound.home']}
          </Link>
        </section>
      )
    return one.problem ? <ProblemView problem={one.problem} retry={one.reload} /> : <div aria-busy="true" />
  }
  if (c.state === '入口待ち')
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <EntranceFace c={c} reload={one.reload} stopped={stopped} isolation={isolation} />
      </>
    )
  if (c.state === '承認待ち' && c.approvalKind === '完成稿')
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <ApprovalFace c={c} reload={one.reload} stopped={stopped} isolation={isolation} />
      </>
    )
  if (c.state === '承認待ち' && c.approvalKind === '構成案')
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <OutlineFace c={c} reload={one.reload} stopped={stopped} />
      </>
    )
  if (c.state === '送付確認待ち' && c.turn === '本人')
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <DeliverFace c={c} reload={one.reload} stopped={stopped} />
      </>
    )
  if (c.state === '完了')
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <ResultFace c={c} reload={one.reload} stopped={stopped} />
      </>
    )
  // 送付確認待ちは、保存先の形に整えているあいだ（turn=libretto）進行の面
  if (PROGRESS_STATES.includes(c.state) || (c.state === '送付確認待ち' && c.turn === 'libretto'))
    return (
      <>
        {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
        <ProgressFace c={c} reload={one.reload} stopped={stopped} />
      </>
    )
  return (
    <section className="face">
      {one.problem && <ProblemView problem={one.problem} retry={one.reload} />}
      <Link href="/" className="back">
        ← {W['case.back']}
      </Link>
      <div className="row-gap">
        <span className={`badge ${tone(c)}`}>{STATE[c.state]}</span>
        <span className="badge b-off">{c.mode}</span>
      </div>
      <h1 className="face-title">{c.title}</h1>
      <p className="lead">{c.step}</p>
      <p>
        <span className="muted">{W['case.cost']}</span>{' '}
        <span className="strong">{w('card.cost', { yen: yen(c.costYen), cap: yen(c.costCapYen) })}</span>
      </p>
      <p className="empty">{W['case.pending']}</p>
    </section>
  )
}
