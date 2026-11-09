// 심사·시연용 테스트 계정. 비밀번호는 README에 공개하는 값이며 실제 사용자 계정이 아니다.
// SEED_TEST_ACCOUNTS=true면 기동 시 없는 계정만 만들고(여러 번 실행해도 안전), 로그인 화면에 "바로 로그인" 버튼을 보여준다.
// false로 바꾸면 버튼과 목록만 사라지고, 이미 만든 계정은 공개된 비밀번호로 계속 로그인된다(심사 후 정리하려면 DB에서 삭제).
import { eq } from 'drizzle-orm'
import type { AuthService } from '../auth/service.js'
import { AppError } from '../errors.js'
import type { Db } from './client.js'
import { users } from './schema.js'

export const TEST_ACCOUNTS = [
  { role: '방송자 A', email: 'streamer@test.com', password: 'test1234!', nickname: '방송자A' },
  { role: '시청자 B', email: 'viewer@test.com', password: 'test1234!', nickname: '시청자B' },
] as const

/** 없는 테스트 계정만 만든다. 만든 계정의 이메일 목록을 돌려준다 */
export async function ensureTestAccounts(db: Db, auth: AuthService): Promise<string[]> {
  const created: string[] = []
  for (const account of TEST_ACCOUNTS) {
    const exists = db.orm.select({ id: users.id }).from(users).where(eq(users.email, account.email)).get()
    if (exists) continue
    try {
      await auth.signup(account)
      created.push(account.email)
    } catch (err) {
      // 확인과 생성 사이에 다른 프로세스(시드 명령 등)가 먼저 만들었다면 이미 있는 것으로 본다 (기동을 막지 않는다)
      if (!(err instanceof AppError && err.code === 'EMAIL_TAKEN')) throw err
    }
  }
  return created
}
