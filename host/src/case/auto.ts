// おまかせ（docs/implementation.md 6.11）。ホストが本人の代わりに出す 3 つ（T4・T6 → T8・T20 → T22）と、
// 送付の自走を止める理由（D5）。どれも決まった eventId で、同じ出来事の 2 回目は replayed になる
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Answer, type EntranceDefaults, LEAVE_IT } from '@libretto/shared/api'
import type { CandidateRecord, CaseRecord, Intake } from '@libretto/shared/ledger'
import { materialsDir } from '../facts/inventory.ts'
import { meetFileId } from '../intake/meet.ts'
import { caseDir } from '../ledger/db.ts'
import type { CardContent, Ledger } from '../ledger/ledger.ts'
import { currentSet, writeApproval, writeAtomic } from '../roles/entrance.ts'
import { draftNames, versionDir } from '../roles/maker.ts'
import { planFingerprint, selfOnly, transition } from './transition.ts'

// --- 候補から作る案件の intake.json（T2・T4 の前に書く。4.2・6.4 (5)・6.6 (6)・6.7 (4)）。
// Slack の threadId は <channelId>:<ts>、会議メモはファイルの id

export function writeIntake(home: string, caseId: string, cand: CandidateRecord, card: CardContent) {
  const { candidateId, source, confidence = '低' } = cand
  const dir = caseDir(home, caseId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // 由来は候補のとおり（transition.ts の originOf と同じ写し方）
  const origin: Intake['origin'] =
    cand.origin === '合図'
      ? { kind: '合図', source }
      : cand.origin === '会議'
        ? { kind: '会議', confidence }
        : { kind: '推測', source, confidence, reason: card.reason ?? '' }
  const intake: Intake = {
    origin,
    summary: card.summary,
    materials: [{ id: candidateId, kind: '元データ', title: card.subject, where: card.link }],
    source: {
      candidateId,
      threadId: meetFileId(candidateId) ?? candidateId.replace(/^(gmail|slack):/, ''),
      account: card.account ?? '',
      subject: card.subject,
      from: card.from,
      attachments: card.attachments ?? [],
      attachmentsNeeded: card.attachmentsNeeded ?? [],
    },
  }
  writeAtomic(join(dir, 'intake.json'), `${JSON.stringify(intake, null, 2)}\n`)
}

// --- T4。出したままの合図・会議の候補のうち、取り込み元をおまかせにした後に出たもの（6.11 (2)）

type EnterDeps = {
  home: string
  ledger: Ledger
  defaults: EntranceDefaults
  since: Partial<Record<keyof EntranceDefaults, string>>
  monthCapYen: number | null
  now: Date
}

// 作った案件の id を返す。STOP の間は呼ぶ側が呼ばない
export function autoEnter(d: EnterDeps): string[] {
  if (d.monthCapYen !== null && d.ledger.monthCostYen(d.now) >= d.monthCapYen) return []
  const made: string[] = []
  for (const { candidate: cand, card } of d.ledger.listPresentedCandidates()) {
    const since = d.since[cand.source]
    if (d.defaults[cand.source] !== 'おまかせ' || !since || cand.updatedAt < since) continue
    if (cand.origin === '推測' || cand.aiInstructionFlag) continue
    const caseId = randomUUID()
    writeIntake(d.home, caseId, cand, card)
    const r = transition(d.ledger, {
      type: 'candidate.auto_enter',
      candidateId: cand.candidateId,
      caseId,
      entranceDefault: 'おまかせ',
    })
    if (r.ok && !r.replayed && r.case) made.push(r.case.caseId)
  }
  return made
}

// --- 送付の自走を止める理由（D5・6.11 (4)）

export type Hold = '見える' | '引用'

// 引用の形: かぎ括弧・引用符の中の文
const QUOTED = /「([^」]*)」|『([^』]*)』|“([^”]*)”|‘([^’]*)’|"([^"\n]*)"/g
const MIN_MATCH = 4

// 判定した版の本文がほかの人の言葉を引用しているか。分からないときは引用とみなす
export function quotesOthers(home: string, c: CaseRecord): boolean {
  if (!c.version) return false
  const path = join(versionDir(home, c.caseId, c.version), draftNames(c.version).md)
  if (!existsSync(path)) return false
  const md = readFileSync(path, 'utf-8')
  if (/^ {0,3}>/m.test(md)) return true
  const spans = [...md.matchAll(QUOTED)].map((m) => (m.slice(1).find((x) => x !== undefined) ?? '').trim())
  if (!spans.some(Boolean)) return false
  // 取り込み元の本文は案件フォルダに残さないので照らし合わせられない
  if (c.origin.kind !== '会話') return true
  // 会話の案件は資料の正本（本人が貼った文と取り寄せた出典）と照らす。依頼書は本人の言葉なので見ない
  const dir = materialsDir(home, c.caseId)
  const texts = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => readFileSync(join(dir, f), 'utf-8'))
    : []
  return spans.some((s) => s.length >= MIN_MATCH && texts.some((t) => t.includes(s)))
}

export function holdOf(home: string, c: CaseRecord): Hold | undefined {
  if (c.mode !== 'おまかせ') return undefined
  if (!c.destination.every(selfOnly)) return '見える'
  return quotesOthers(home, c) ? '引用' : undefined
}

// --- T8・T22。runner が案件を起こすときに見る（再起動の resume も同じ道）。遷移したら結果を返す

export function autoStep(home: string, ledger: Ledger, c: CaseRecord) {
  const last = ledger
    .listCaseEvents(c.caseId)
    .filter((e) => e.type === 'transition')
    .at(-1)
  const lastEvent = last?.type === 'transition' ? last.event : undefined
  if (
    c.state === '入口待ち' &&
    c.auto &&
    c.turn === 'libretto' &&
    c.setFingerprint &&
    lastEvent === 'entrance.drafted'
  ) {
    const set = currentSet(home, ledger, c.caseId)
    if (!set) return undefined
    // Undecided は全部「任せる」（設計書 4.2.3）。答えは本人の承認と同じくトランザクションの前にファイルへ
    const answers: Record<string, Answer> = Object.fromEntries(set.undecided.items.map((i) => [i.id, LEAVE_IT]))
    const a = { eventId: `${c.caseId}:entrance.approve:auto:r${c.revision}`, setFingerprint: c.setFingerprint }
    if (!ledger.findEvent(a.eventId))
      writeApproval(home, ledger, c, { ...a, answers, expectedRevision: c.revision }, true)
    return transition(
      ledger,
      { ...a, type: 'entrance.approve', by: '自動', caseId: c.caseId, expectedRevision: c.revision, answers },
      { materialsPending: !!set.brief.wanted.length },
    )
  }
  if (
    c.state === '送付確認待ち' &&
    c.mode === 'おまかせ' &&
    c.turn === '本人' &&
    c.outputFingerprint &&
    lastEvent === 'format.checked' &&
    !holdOf(home, c)
  )
    return transition(ledger, {
      type: 'delivery.send',
      by: '自動',
      eventId: `${c.caseId}:delivery.send:auto:r${c.revision}`,
      caseId: c.caseId,
      expectedRevision: c.revision,
      planFingerprint: planFingerprint(c),
      quotesOthers: false, // holdOf が引用なしと見た
    })
  return undefined
}
