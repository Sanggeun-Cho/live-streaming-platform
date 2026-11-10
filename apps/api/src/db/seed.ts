// 테스트 계정 시드. 이미 있는 계정은 건너뛰므로 여러 번 실행해도 안전하다.
//   개발: npm run db:seed -w @live/api
//   컨테이너: docker compose exec api node dist/db/seed.js
// (SEED_TEST_ACCOUNTS=true면 api 기동 시 자동으로 만든다)
import { createAuthService } from '../auth/service.js'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { ensureTestAccounts, TEST_ACCOUNTS } from './test-accounts.js'

const config = loadConfig()
const db = createDb(config.DATABASE_PATH)
const auth = createAuthService(db, { sessionTtlDays: config.SESSION_TTL_DAYS })

try {
  const created = await ensureTestAccounts(db, auth)
  for (const { email } of TEST_ACCOUNTS) console.log(`${created.includes(email) ? 'created' : 'skip   '} ${email}`)
} finally {
  db.sqlite.close()
}
