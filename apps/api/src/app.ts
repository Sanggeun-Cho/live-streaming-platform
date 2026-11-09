import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyError } from 'fastify'
import type { Config } from './config.js'
import type { Db } from './db/client.js'
import { authPlugin } from './auth/plugin.js'
import { createAuthService } from './auth/service.js'
import { createBroadcastLifecycle } from './broadcasts/lifecycle.js'
import { createBroadcastService } from './broadcasts/service.js'
import { createDonationService } from './donations/service.js'
import { createMediaControl, type MediaControl } from './media/control.js'
import { createPublishTokenSigner } from './media/token.js'
import { createFakeTossClient, createTossClient, disabledTossClient, type TossClient } from './payments/toss.js'
import { createEventHub } from './realtime/hub.js'
import { AppError } from './errors.js'
import { authRoutes } from './routes/auth.js'
import { broadcastRoutes } from './routes/broadcasts.js'
import { channelRoutes } from './routes/channels.js'
import { donationRoutes } from './routes/donations.js'
import { healthRoutes } from './routes/health.js'
import { internalMediaRoutes } from './routes/internal-media.js'
import { recordingRoutes } from './routes/recordings.js'
import { createRecordingService } from './recordings/service.js'

export type AppDeps = {
  config: Config
  db: Db
  /** 테스트에서 MediaMTX 대신 넣는다 */
  mediaControl?: MediaControl
  /** 테스트에서 토스 결제 API 대신 넣는다 */
  toss?: TossClient
}

/** 로그용: secret·token 쿼리 값을 가린다 */
export function redactQuery(url: string): string {
  return url.replace(/([?&](?:secret|token)=)[^&]*/gi, '$1[redacted]')
}

export async function buildApp({ config, db, mediaControl, toss }: AppDeps) {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            serializers: {
              // MediaMTX 인가 요청은 공유 시크릿을 쿼리로 보낸다. 로그에 남지 않도록 쿼리 값을 가린다
              req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
                method: req.method,
                url: redactQuery(req.url),
                host: req.hostname,
                remoteAddress: req.ip,
              }),
            },
          },
    // 지정한 프록시(Caddy)가 보낸 X-Forwarded-*만 믿는다. request.ip는 시도 횟수 제한의 기준이라
    // 아무나 보낸 헤더를 믿으면 요청마다 IP를 바꿔 제한을 우회할 수 있다.
    trustProxy: config.TRUST_PROXY.length > 0 ? config.TRUST_PROXY : false,
  })

  app.setErrorHandler<FastifyError | AppError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error')
    }
    reply.code(statusCode).send({
      code: error.code ?? 'INTERNAL_ERROR',
      // 5xx는 내부 정보를 숨긴다. 노출을 명시한 AppError(외부 결제 API 장애 안내 등)만 문구를 그대로 보낸다
      message:
        statusCode >= 500 && !(error instanceof AppError && error.expose) ? '서버 오류가 발생했습니다' : error.message,
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: '요청한 리소스를 찾을 수 없습니다' })
  })

  // 기본 text/plain 파서를 제거해 JSON 본문만 받는다.
  // 교차 사이트 <form enctype="text/plain"> 전송은 415로 막힌다 (SameSite=Lax와 함께 CSRF 방어).
  app.removeContentTypeParser('text/plain')

  // 로그인·가입은 IP당 시도 횟수를 제한한다 (라우트별 config.rateLimit로 켠다)
  await app.register(rateLimit, {
    global: false,
    // 기본 응답은 code 없이 영어 메시지라 공통 에러 형식으로 바꾼다 (던진 값은 setErrorHandler로 간다)
    errorResponseBuilder: (_request, context) =>
      new AppError(
        429,
        'TOO_MANY_REQUESTS',
        `요청이 너무 많습니다. ${Math.max(1, Math.ceil(context.ttl / 1000))}초 후 다시 시도하세요`,
      ),
  })

  const auth = createAuthService(db, { sessionTtlDays: config.SESSION_TTL_DAYS })
  auth.deleteExpiredSessions()
  const cleanup = setInterval(() => auth.deleteExpiredSessions(), 60 * 60 * 1000)
  cleanup.unref()
  await app.register(authPlugin, { config, auth })

  await app.register(healthRoutes(db), { prefix: '/api' })
  await app.register(authRoutes({ config, auth }), { prefix: '/api' })
  const broadcasts = createBroadcastService(db)
  const hub = createEventHub()
  const lifecycle = createBroadcastLifecycle({
    db,
    hub,
    control: mediaControl ?? createMediaControl(config.MEDIAMTX_API_URL),
    signer: createPublishTokenSigner(config.INTERNAL_SECRET, config.PUBLISH_TOKEN_TTL_SECONDS),
    graceMs: config.PUBLISH_GRACE_SECONDS * 1000,
    log: app.log,
  })
  // 테스트는 주기 작업 대신 메서드를 직접 호출한다
  const stopLifecycle = config.NODE_ENV === 'test' ? () => {} : lifecycle.start()
  app.decorate('lifecycle', lifecycle)

  await app.register(broadcastRoutes({ broadcasts, lifecycle, hub }), { prefix: '/api' })
  await app.register(channelRoutes(db), { prefix: '/api' })

  // 후원: 토스 키가 있으면 실제(테스트) 결제, 가짜 결제 모드면 토스를 거치지 않는다. 둘 다 아니면 꺼진다
  // (키와 가짜 결제를 함께 켜는 설정은 config에서 거부한다)
  const tossEnabled = Boolean(config.TOSS_SECRET_KEY)
  if (config.TOSS_FAKE_PAYMENTS) {
    app.log.warn('TOSS_FAKE_PAYMENTS=true: 결제창 없이 모든 후원을 승인 처리합니다. 개발·E2E 전용입니다')
  }
  const donations = createDonationService({
    db,
    hub,
    log: app.log,
    toss:
      toss ??
      (config.TOSS_FAKE_PAYMENTS
        ? createFakeTossClient()
        : tossEnabled
          ? createTossClient(config.TOSS_SECRET_KEY)
          : disabledTossClient),
  })
  await app.register(
    donationRoutes({
      donations,
      settings: {
        enabled: tossEnabled || config.TOSS_FAKE_PAYMENTS,
        clientKey: config.TOSS_CLIENT_KEY || null,
        fake: config.TOSS_FAKE_PAYMENTS,
      },
    }),
    { prefix: '/api' },
  )
  const recordings = createRecordingService(db, { recordingsDir: config.RECORDINGS_DIR })
  await app.register(recordingRoutes(recordings), { prefix: '/api' })
  await app.register(internalMediaRoutes({ secret: config.INTERNAL_SECRET, lifecycle, recordings, hub }), {
    prefix: '/internal',
  })

  // 열린 SSE 응답을 닫지 않으면 서버 close가 끝나지 않는다 (hub가 모든 응답을 닫는다)
  app.addHook('preClose', async () => {
    stopLifecycle()
    hub.closeAll()
  })
  app.addHook('onClose', async () => {
    clearInterval(cleanup)
    db.sqlite.close()
  })

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 방송 상태 머신 (테스트에서 주기 작업을 직접 실행할 때 쓴다) */
    lifecycle: import('./broadcasts/lifecycle.js').BroadcastLifecycle
  }
}
