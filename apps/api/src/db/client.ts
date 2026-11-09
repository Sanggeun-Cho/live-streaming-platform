import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

// src/db/client.ts와 dist/db/client.js 모두에서 apps/api/drizzle을 가리킨다
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url))

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
  // 기동 시 미적용 마이그레이션을 적용한다. 단일 인스턴스라 경쟁이 없다.
  migrate(orm, { migrationsFolder: MIGRATIONS_DIR })
  return { sqlite, orm }
}
