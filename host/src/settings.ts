// settings.json（docs/implementation.md 9.2）。今は「あなたの文体の見本」（6.3.2 (10)）と自動検出（6.9 (10)）の欄だけ。
// 置き換えで書き、前の版を settings.prev.json に残す。読めない・欄が無いときは既定
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { InferenceSettings, MaterialRef } from '@libretto/shared/api'
import { z } from 'zod'

// 自動検出の既定は設計書 4.2.2・10.3 のとおり（Gmail は直近 7 日、Slack はチャンネル指定なし＋メンション、1 日 300 件）
export const INFERENCE_DEFAULTS: InferenceSettings = {
  gmailDays: 7,
  slackChannels: [],
  dailyLimit: 300,
  showLow: true,
  useJev: true,
}
// 欄ごとに読めなければ既定（1 つの欄が壊れても、ほかの欄を既定に戻さない）
const File = z
  .object({
    voiceSamples: z.array(MaterialRef).catch([]).default([]),
    inference: InferenceSettings.catch(INFERENCE_DEFAULTS).default(INFERENCE_DEFAULTS),
  })
  .loose()
type File = z.infer<typeof File>
const pathOf = (home: string) => join(home, 'settings.json')

function read(home: string): File {
  const p = pathOf(home)
  const none = { voiceSamples: [], inference: INFERENCE_DEFAULTS }
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
