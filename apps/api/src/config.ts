import { isAbsolute } from 'node:path'
import { z } from 'zod'

const DEV_INTERNAL_SECRET = 'dev-internal-secret-change-me'

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_PATH: z.string().default('./data/app.db'),
    // MediaMTX → api 내부 훅 호출을 검증하는 공유 시크릿
    // MediaMTX 인가 URL의 쿼리에 그대로 들어가므로 URL에 안전한 문자만 허용한다 (예: openssl rand -hex 24)
    INTERNAL_SECRET: z
      .string()
      .min(16)
      .regex(/^[A-Za-z0-9_-]+$/, { error: '영문·숫자·-·_만 사용할 수 있습니다 (openssl rand -hex 24로 만드세요)' })
      .default(DEV_INTERNAL_SECRET),
    // 세션 쿠키 Secure 속성. Chrome·Firefox는 http://localhost도 보안 컨텍스트로 보므로 기본값 그대로 개발할 수 있다.
    // http로 LAN IP에 접속하는 등 예외 상황에서만 false로 끈다.
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // 테스트 계정(README 공개)을 기동 시 만들고 로그인 화면에 "바로 로그인" 버튼을 보여준다 (심사·시연용)
    SEED_TEST_ACCOUNTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // MediaMTX Control API (path 상태 조회, 송출 강제 종료). compose 내부 주소
    MEDIAMTX_API_URL: z.url().default('http://mediamtx:9997'),
    // 송출이 끊긴 뒤 ENDED로 확정하기까지 기다리는 시간 (네트워크 전환·새로고침 후 재송출 허용)
    PUBLISH_GRACE_SECONDS: z.coerce.number().int().min(5).max(600).default(45),
    // publish 토큰 수명. 송출을 시작(또는 재연결)할 때마다 새로 발급받는다
    PUBLISH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
    // 녹화 디렉터리. MediaMTX 컨테이너의 경로(mediamtx.yml recordPath의 앞부분)와 같아야 하고,
    // compose에서 api에도 같은 경로로 읽기 전용으로 붙인다(복구 스캔). segmentPath가 이 디렉터리 밖이면 등록을 거절한다
    RECORDINGS_DIR: z
      .string()
      .refine((v) => isAbsolute(v), { error: '절대 경로여야 합니다' })
      .default('/recordings'),
    // X-Forwarded-For를 믿을 프록시 주소(IP/CIDR, 쉼표 구분). 비우면 아무도 믿지 않고 소켓 주소를 쓴다.
    // compose에서는 Caddy 컨테이너의 고정 IP만 넣는다. 다른 주소가 보낸 X-Forwarded-For는 무시된다.
    TRUST_PROXY: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    // 토스페이먼츠 결제창형 키 (개발자센터 > API 키 > 주문서형, 결제창형 연동 키: test_gck_/test_gsk_). 둘 다 비우면 후원 기능이 꺼진다.
    // 클라이언트 키는 브라우저에 공개되고, 시크릿 키는 서버의 승인·조회 API 호출에만 쓴다
    // 이 과제는 테스트 결제만 한다. 라이브 키(live_)나 다른 종류의 키(API 개별 연동 키 test_ck_)는 기동 단계에서 거부한다
    TOSS_CLIENT_KEY: z
      .string()
      .trim()
      .regex(/^(test_gck_[A-Za-z0-9_]+)?$/, {
        error: '토스 결제창형 테스트 클라이언트 키(test_gck_로 시작)만 쓸 수 있습니다',
      })
      .default(''),
    TOSS_SECRET_KEY: z
      .string()
      .trim()
      .regex(/^(test_gsk_[A-Za-z0-9_]+)?$/, {
        error: '토스 결제창형 테스트 시크릿 키(test_gsk_로 시작)만 쓸 수 있습니다',
      })
      .default(''),
    // 개발·E2E 전용: 토스를 거치지 않고 결제를 승인된 것으로 처리한다 (운영에서는 켤 수 없다)
    TOSS_FAKE_PAYMENTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.INTERNAL_SECRET === DEV_INTERNAL_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['INTERNAL_SECRET'],
        message: '운영 환경에서는 INTERNAL_SECRET을 반드시 설정해야 합니다',
      })
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: '운영 환경에서는 COOKIE_SECURE를 끌 수 없습니다',
      })
    }
    // 한쪽 키만 있으면 결제창은 열리는데 승인이 실패하는(돈은 빠지지 않지만 후원도 안 되는) 상태가 된다
    if (Boolean(env.TOSS_CLIENT_KEY) !== Boolean(env.TOSS_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOSS_SECRET_KEY'],
        message: 'TOSS_CLIENT_KEY와 TOSS_SECRET_KEY는 함께 설정하거나 함께 비워야 합니다',
      })
    }
    if (env.NODE_ENV === 'production' && env.TOSS_FAKE_PAYMENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOSS_FAKE_PAYMENTS'],
        message: '운영 환경에서는 가짜 결제를 켤 수 없습니다',
      })
    }
    // 둘 다 켜져 있으면 어느 쪽으로 결제되는지 헷갈리고, 실제 키로 띄운 줄 알고 가짜 승인을 받을 수 있다
    if (env.TOSS_FAKE_PAYMENTS && (env.TOSS_CLIENT_KEY || env.TOSS_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TOSS_FAKE_PAYMENTS'],
        message: '가짜 결제(TOSS_FAKE_PAYMENTS)와 토스 키를 함께 설정할 수 없습니다. 둘 중 하나만 설정하세요',
      })
    }
  })

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`환경변수 설정이 올바르지 않습니다:\n${issues}`)
  }
  return parsed.data
}
