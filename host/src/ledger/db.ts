// better-sqlite3 の接続・プラグマ・マイグレーション（9.1・9.4 (5)）と LIBRETTO_HOME の初期化（9.4 (6)）
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import Database from 'better-sqlite3'
import { Ledger } from './ledger.ts'
import initial from './migrations/0001-initial.ts'
import fingerprints from './migrations/0002-fingerprints.ts'
import costRecoveries from './migrations/0003-cost-recoveries.ts'
import conversation from './migrations/0004-conversation.ts'
import candidateAttachments from './migrations/0005-candidate-attachments.ts'
import candidateOthersPost from './migrations/0006-candidate-others-post.ts'
import meetNotes from './migrations/0007-meet-notes.ts'

// 添字 + 1 が user_version。足すときは末尾に 1 本足す
export const MIGRATIONS: readonly string[] = [
  initial,
  fingerprints,
  costRecoveries,
  conversation,
  candidateAttachments,
  candidateOthersPost,
  meetNotes,
]

export function openDb(file: string, migrations: readonly string[] = MIGRATIONS): Database.Database {
  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('secure_delete = ON')
    db.pragma('busy_timeout = 5000')
    migrate(db, migrations)
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

function migrate(db: Database.Database, migrations: readonly string[]) {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > migrations.length) {
    throw new Error(`database version ${current} is newer than this libretto (${migrations.length})`)
  }
  for (let v = current; v < migrations.length; v++) {
    // DDL と版番号を 1 つのトランザクションで。失敗すれば両方とも前のまま
    db.transaction(() => {
      db.exec(migrations[v] as string)
      db.pragma(`user_version = ${v + 1}`)
    }).immediate()
  }
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.LIBRETTO_HOME
  if (!home) return join(homedir(), 'libretto')
  if (!isAbsolute(home)) throw new Error(`LIBRETTO_HOME must be an absolute path: ${home}`)
  return home
}

// 全体上限の検証用の上書き（11.3 (2)）。無ければ null（P3: 本人が設定の面で入れる）
export function monthCapFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = env.LIBRETTO_MONTH_CAP_YEN
  if (v === undefined || v === '') return null
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`LIBRETTO_MONTH_CAP_YEN must be a positive integer: ${v}`)
  return Number(v)
}

// 呼び出しの結果のファイルの置き場（9.4 (7)）
export const callsDir = (home: string) => join(home, 'calls')
// 案件フォルダ（9.3）
export const caseDir = (home: string, caseId: string) => join(home, 'cases', caseId)

// 既にあるものには触らない
export function initHome(home: string, now?: () => Date): Ledger {
  mkdirSync(join(home, 'cases'), { recursive: true, mode: 0o700 })
  mkdirSync(callsDir(home), { recursive: true, mode: 0o700 })
  return new Ledger(openDb(join(home, 'libretto.db')), now)
}
