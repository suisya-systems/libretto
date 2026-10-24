// API キーの読み書き（docs/implementation.md 9.2・5.7 (9)）。値を外へ返すのは readKey だけで、呼ぶのはアダプタだけ
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiKeyKind, type ApiKeyStatus } from '@libretto/shared/api'
import { z } from 'zod'
import { jst } from '../ledger/ledger.ts'

type Kind = z.infer<typeof ApiKeyKind>
const Entry = z.object({ value: z.string(), savedAt: z.string() })
const File = z.partialRecord(ApiKeyKind, Entry)
type File = z.infer<typeof File>

const pathOf = (home: string) => join(home, 'api-keys.json')

function load(home: string): File {
  try {
    return File.parse(JSON.parse(readFileSync(pathOf(home), 'utf-8')))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

// 作るときから 0600 の一時ファイルに書いて置き換える（途中で落ちても前の版が残る。9.2）。Google の連携も使う（6.4 (2)）
export function writeSecret(path: string, text: string) {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  try {
    renameSync(tmp, path)
  } catch (e) {
    unlinkSync(tmp)
    throw e
  }
}
const save = (home: string, f: File) => writeSecret(pathOf(home), JSON.stringify(f))

const statusOf = (kind: Kind, e: z.infer<typeof Entry> | undefined): ApiKeyStatus =>
  e ? { kind, set: true, last4: e.value.slice(-4), savedAt: e.savedAt } : { kind, set: false }

export const keyStatus = (home: string, kind: Kind) => statusOf(kind, load(home)[kind])

// value は ApiKeyInput を通したもの（8 文字以上。5.7 (7)）
export function setKey(home: string, kind: Kind, value: string, now = new Date()): ApiKeyStatus {
  const f = load(home)
  f[kind] = { value, savedAt: jst(now) }
  save(home, f)
  return statusOf(kind, f[kind])
}

export function deleteKey(home: string, kind: Kind): ApiKeyStatus {
  const f = load(home)
  if (f[kind]) {
    delete f[kind]
    save(home, f)
  }
  return statusOf(kind, undefined)
}

export const readKey = (home: string, kind: Kind): string | undefined => load(home)[kind]?.value
