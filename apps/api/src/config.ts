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
    INTERNAL_SECRET: z.string().min(16).default(DEV_INTERNAL_SECRET),
    // 세션 쿠키 Secure 속성. Chrome·Firefox는 http://localhost도 보안 컨텍스트로 보므로 기본값 그대로 개발할 수 있다.
    // http로 LAN IP에 접속하는 등 예외 상황에서만 false로 끈다.
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
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
