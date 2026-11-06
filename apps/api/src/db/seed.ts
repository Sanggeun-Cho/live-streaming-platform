// 테스트 계정 시드. 이미 있는 계정은 건너뛰므로 여러 번 실행해도 안전하다.
//   개발: npm run db:seed -w @live/api
//   컨테이너: docker compose exec api node dist/db/seed.js
import { eq } from 'drizzle-orm'
import { createAuthService } from '../auth/service.js'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { users } from './schema.js'

export const SEED_ACCOUNTS = [
  { email: 'streamer@test.com', password: 'test1234!', nickname: '방송자A' },
  { email: 'viewer@test.com', password: 'test1234!', nickname: '시청자B' },
] as const

const config = loadConfig()
const db = createDb(config.DATABASE_PATH)
const auth = createAuthService(db, { sessionTtlDays: config.SESSION_TTL_DAYS })

try {
  for (const account of SEED_ACCOUNTS) {
    const exists = db.orm.select({ id: users.id }).from(users).where(eq(users.email, account.email)).get()
    if (exists) {
      console.log(`skip    ${account.email} (이미 있음)`)
      continue
    }
    const user = await auth.signup(account)
    console.log(`created ${account.email} (userId=${user.id}, channelId=${user.channelId})`)
  }
} finally {
  db.sqlite.close()
}
