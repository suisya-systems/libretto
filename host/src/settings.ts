// settings.json（docs/implementation.md 9.2）。今は「あなたの文体の見本」の欄だけ（6.3.2 (10)）。
// 置き換えで書き、前の版を settings.prev.json に残す。読めない・欄が無いときは既定
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MaterialRef } from '@libretto/shared/api'
import { z } from 'zod'

const File = z.object({ voiceSamples: z.array(MaterialRef).default([]) }).loose()
type File = z.infer<typeof File>
const pathOf = (home: string) => join(home, 'settings.json')

function read(home: string): File {
  const p = pathOf(home)
  if (!existsSync(p)) return { voiceSamples: [] }
  try {
    const r = File.safeParse(JSON.parse(readFileSync(p, 'utf-8')))
    return r.success ? r.data : { voiceSamples: [] }
  } catch {
    return { voiceSamples: [] }
  }
}

export const voiceSamples = (home: string) => read(home).voiceSamples

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
  const p = pathOf(home)
  if (existsSync(p)) copyFileSync(p, join(home, 'settings.prev.json'))
  const voiceSamples = input.samples.map((s, i) => ({
    id: `V${i + 1}`,
    kind: '声の見本' as const,
    title: s.title,
    where: s.url,
  }))
  const tmp = `${p}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...read(home), voiceSamples }, null, 2)}\n`, 'utf-8')
  renameSync(tmp, p)
  return voiceSamples
}
