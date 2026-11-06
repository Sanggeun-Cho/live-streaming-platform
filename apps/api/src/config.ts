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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.INTERNAL_SECRET === DEV_INTERNAL_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['INTERNAL_SECRET'],
        message: '운영 환경에서는 INTERNAL_SECRET을 반드시 설정해야 합니다',
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
