import type { ZodError } from 'zod'

// 공통 에러 응답 { code, message }로 변환되는 애플리케이션 에러
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /**
     * 5xx여도 message를 사용자에게 그대로 보낸다 (외부 결제 API 장애처럼 사용자가 다음에 할 일을 알아야 하는 경우).
     * 기본값 false: 예상하지 못한 5xx는 내부 정보를 숨긴다. 4xx는 항상 보낸다
     */
    readonly expose = false,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function validationError(error: ZodError): AppError {
  const first = error.issues[0]
  // 본문 자체가 객체가 아닌 경우(배열, 문자열, 숫자)는 필드 규칙의 메시지가 없어 zod 기본 문구가 나온다. 한국어 안내로 바꾼다
  if (first && first.path.length === 0 && first.code === 'invalid_type') {
    return new AppError(400, 'VALIDATION_ERROR', '요청 본문은 JSON 객체여야 합니다')
  }
  return new AppError(400, 'VALIDATION_ERROR', first?.message ?? '요청 형식이 올바르지 않습니다')
}

/**
 * Fastify가 라우트 핸들러 전에 던지는 4xx 오류(본문 파싱 등)는 code가 FST_ERR_*이고 메시지가 영어다.
 * 클라이언트가 같은 형식({code, message}, 한국어)으로 처리하도록 바꾼다.
 * https://fastify.dev/docs/latest/Reference/Errors/
 */
const FRAMEWORK_ERRORS: Record<string, { code: string; message: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: { code: 'INVALID_JSON', message: '요청 본문이 올바른 JSON이 아닙니다' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: 'INVALID_JSON', message: '요청 본문이 비어 있습니다' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: '요청 본문은 JSON(Content-Type: application/json)이어야 합니다',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { code: 'BAD_REQUEST', message: '요청 본문 길이가 올바르지 않습니다' },
  FST_ERR_CTP_BODY_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다' },
  FST_ERR_BAD_URL: { code: 'BAD_URL', message: '요청 주소가 올바르지 않습니다' },
  FST_ERR_MAX_PARAM_LENGTH: { code: 'URI_TOO_LONG', message: '요청 주소가 너무 깁니다' },
}

const GENERIC_4XX: Record<number, { code: string; message: string }> = {
  401: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다' },
  403: { code: 'FORBIDDEN', message: '권한이 없습니다' },
  404: { code: 'NOT_FOUND', message: '요청한 리소스를 찾을 수 없습니다' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다' },
  415: FRAMEWORK_ERRORS.FST_ERR_CTP_INVALID_MEDIA_TYPE!,
  429: { code: 'TOO_MANY_REQUESTS', message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요' },
}

export type ErrorReply = { statusCode: number; body: { code: string; message: string } }

/**
 * 모든 오류를 공통 응답 { code, message }로 바꾼다.
 * - AppError: 그대로 (5xx는 expose일 때만 문구를 보낸다)
 * - Fastify·플러그인 4xx: 한국어 문구로 바꾼다
 * - 그 밖의 5xx(DB 제약 위반, 버그): code·message 모두 숨긴다. SQLITE_* 같은 code도 내부 정보다
 */
export function toErrorReply(error: { statusCode?: number; code?: string; message: string }): ErrorReply {
  const raw = error.statusCode ?? 500
  const statusCode = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500
  if (error instanceof AppError) {
    const hidden = statusCode >= 500 && !error.expose
    return { statusCode, body: { code: error.code, message: hidden ? '서버 오류가 발생했습니다' : error.message } }
  }
  if (statusCode >= 500) return { statusCode, body: { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다' } }
  const known = (error.code && FRAMEWORK_ERRORS[error.code]) || GENERIC_4XX[statusCode]
  return { statusCode, body: known ?? { code: 'BAD_REQUEST', message: '요청이 올바르지 않습니다' } }
}

export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', '로그인이 필요합니다')

export const forbidden = (message = '권한이 없습니다') => new AppError(403, 'FORBIDDEN', message)
