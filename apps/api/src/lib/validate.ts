import { z } from 'zod'
import { validationError } from '../errors.js'

// 규칙에 한국어 메시지를 빠뜨린 곳(필드 타입 오류 등)도 영어 기본 문구 대신 한국어로 나가게 한다
z.config(z.locales.ko())

/** zod 스키마로 검증하고, 실패하면 공통 형식의 400 VALIDATION_ERROR를 던진다 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {})
  if (!result.success) throw validationError(result.error)
  return result.data
}

/** URL 경로의 숫자 ID (`/:id`) */
export const positiveId = (label = 'ID') => {
  const error = `${label}가 올바르지 않습니다`
  // 10진수 숫자만 받는다. z.coerce.number는 '1e3'·'0x10'·' 7'도 숫자로 바꿔 엉뚱한 방송을 가리키게 된다.
  // 15자리 이하로 제한해 안전한 정수 범위(2^53) 안에 둔다
  return z
    .string({ error })
    .regex(/^[1-9][0-9]{0,14}$/, { error })
    .transform(Number)
}

export const idParams = z.object({ id: positiveId() })

/** 목록 페이지 크기 (`?limit=`). 1~50, 기본 20 */
export const pageLimit = () => {
  const error = '개수는 1~50 사이의 숫자여야 합니다'
  return z.coerce.number({ error }).int({ error }).min(1, { error }).max(50, { error }).default(20)
}
