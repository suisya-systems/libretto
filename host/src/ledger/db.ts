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

// 添字 + 1 が user_version。足すときは末尾に 1 本足す
export const MIGRATIONS: readonly string[] = [initial, fingerprints, costRecoveries, conversation]

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
