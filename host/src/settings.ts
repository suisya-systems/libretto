// settings.json（docs/implementation.md 9.2）。今は「あなたの文体の見本」（6.3.2 (10)）と自動検出（6.9 (10)）と、お知らせの出来事ごとの入り切り（6.8 (6)）と通知を止める時間帯（6.8 (14)）と、入口の既定（6.11 (1)）。
// 置き換えで書き、前の版を settings.prev.json に残す。読めない・欄が無いときは既定
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EntranceDefaults, InferenceSettings, MaterialRef, NoticePrefs, QuietHours } from '@libretto/shared/api'
import { z } from 'zod'

// 自動検出の既定は設計書 4.2.2・10.3 のとおり（Gmail は直近 7 日、Slack はチャンネル指定なし＋メンション、1 日 300 件）
export const INFERENCE_DEFAULTS: InferenceSettings = {
  gmailDays: 7,
  slackChannels: [],
  dailyLimit: 300,
  showLow: true,
  useJev: true,
}
// お知らせの既定は 6.8 (1) の表（下書きに取りかかったは出さない）
export const NOTICE_DEFAULTS: NoticePrefs = {
  your_turn: true,
  stopped: true,
  done: true,
  auto_started: true,
  candidates: true,
  started: false,
}
// 入口の既定は両入口とも「確認しながら」（設計書 D4）
export const ENTRANCE_DEFAULTS: EntranceDefaults = {
  会話: '確認しながら',
  gmail: '確認しながら',
  slack: '確認しながら',
  meet: '確認しながら',
}
const Source = z.enum(['会話', 'gmail', 'slack', 'meet'])
// 欄ごとに読めなければ既定（1 つの欄が壊れても、ほかの欄を既定に戻さない）
const File = z
  .object({
    voiceSamples: z.array(MaterialRef).catch([]).default([]),
    inference: InferenceSettings.catch(INFERENCE_DEFAULTS).default(INFERENCE_DEFAULTS),
    notices: NoticePrefs.catch(NOTICE_DEFAULTS).default(NOTICE_DEFAULTS),
    entranceDefaults: EntranceDefaults.catch(ENTRANCE_DEFAULTS).default(ENTRANCE_DEFAULTS),
    // おまかせにした時刻。これ以後に出た合図の候補だけを自動で入口へ入れる（6.11 (2)）
    autoSince: z.partialRecord(Source, z.string()).catch({}).default({}),
    quietHours: QuietHours.nullable().catch(null).default(null), // 既定は止めない（6.8 (10) の C）
  })
  .loose()
type File = z.infer<typeof File>
const pathOf = (home: string) => join(home, 'settings.json')

function read(home: string): File {
  const p = pathOf(home)
  const none = {
    voiceSamples: [],
    inference: INFERENCE_DEFAULTS,
    notices: NOTICE_DEFAULTS,
    quietHours: null,
    entranceDefaults: ENTRANCE_DEFAULTS,
    autoSince: {},
  }
  if (!existsSync(p)) return none
  try {
    const r = File.safeParse(JSON.parse(readFileSync(p, 'utf-8')))
    return r.success ? r.data : none
  } catch {
    return none
  }
}

function write(home: string, next: File) {
  const p = pathOf(home)
  if (existsSync(p)) copyFileSync(p, join(home, 'settings.prev.json'))
  const tmp = `${p}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  renameSync(tmp, p)
}

export const voiceSamples = (home: string) => read(home).voiceSamples
export const inferenceSettings = (home: string) => read(home).inference
export function saveInference(home: string, inference: InferenceSettings) {
  write(home, { ...read(home), inference })
  return inference
}
export const noticePrefs = (home: string) => read(home).notices
export function saveNoticePrefs(home: string, notices: NoticePrefs) {
  write(home, { ...read(home), notices })
  return notices
}
export const quietHours = (home: string) => read(home).quietHours
export function saveQuietHours(home: string, quietHours: QuietHours | null) {
  write(home, { ...read(home), quietHours })
  return quietHours
}

export const entranceDefaults = (home: string) => read(home).entranceDefaults
export const autoSince = (home: string) => read(home).autoSince
// おまかせに変えた取り込み元だけ時刻を書き換え、確認しながらに戻したら消す
export function saveEntranceDefaults(home: string, next: EntranceDefaults, now: string) {
  const f = read(home)
  const since = Object.fromEntries(
    Source.options.flatMap((k) =>
      next[k] !== 'おまかせ' ? [] : [[k, f.entranceDefaults[k] === 'おまかせ' ? (f.autoSince[k] ?? now) : now]],
    ),
  )
  write(home, { ...f, entranceDefaults: next, autoSince: since })
  return next
}

// PUT の形。最大 5 件、題は 1〜80 字、URL は http / https
const httpUrl = z
  .string()
  .trim()
  .refine((u) => {
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol)
    } catch {
      return false
    }
  })
export const MAX_VOICE_SAMPLES = 5
export const VoiceSamplesInput = z.object({
  samples: z.array(z.object({ title: z.string().trim().min(1).max(80), url: httpUrl })).max(MAX_VOICE_SAMPLES),
})

export function saveVoiceSamples(home: string, input: z.infer<typeof VoiceSamplesInput>) {
  const voiceSamples = input.samples.map((s, i) => ({
    id: `V${i + 1}`,
    kind: '声の見本' as const,
    title: s.title,
    where: s.url,
  }))
  write(home, { ...read(home), voiceSamples })
  return voiceSamples
}
