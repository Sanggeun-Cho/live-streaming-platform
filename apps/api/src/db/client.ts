import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

export function createDb(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const sqlite = new Database(path)
  // WAL: 읽기와 쓰기가 서로 막지 않는다. SSE 조회와 훅 쓰기가 동시에 일어나므로 필요하다.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  const orm = drizzle({ client: sqlite, schema })
  return { sqlite, orm }
}
