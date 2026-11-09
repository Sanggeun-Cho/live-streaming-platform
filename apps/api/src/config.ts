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
    // MediaMTX Control API (path 상태 조회, 송출 강제 종료). compose 내부 주소
    MEDIAMTX_API_URL: z.url().default('http://mediamtx:9997'),
    // 송출이 끊긴 뒤 ENDED로 확정하기까지 기다리는 시간 (네트워크 전환·새로고침 후 재송출 허용)
    PUBLISH_GRACE_SECONDS: z.coerce.number().int().min(5).max(600).default(45),
    // publish 토큰 수명. 송출을 시작(또는 재연결)할 때마다 새로 발급받는다
    PUBLISH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
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
