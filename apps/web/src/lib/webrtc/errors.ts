import { ApiError, errorMessage } from '../api'
import { WebRtcHttpError } from './whip'

/** 송출 실패를 사용자가 다음에 할 일과 함께 안내한다 */
export function publishErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return '카메라·마이크 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 권한을 허용한 뒤 다시 시도하세요'
  }
  if (e instanceof DOMException && e.name === 'NotFoundError') {
    return '카메라나 마이크를 찾을 수 없습니다. 장치가 연결되어 있는지 확인하세요'
  }
  if (e instanceof ApiError && e.status === 401) {
    return '로그인이 만료되었습니다. 다시 로그인한 뒤 송출하세요'
  }
  if (e instanceof DOMException && e.name === 'NotReadableError') {
    return '카메라나 마이크를 다른 앱이 사용 중입니다. 다른 앱을 닫고 다시 시도하세요'
  }
  if (e instanceof WebRtcHttpError && e.status === 401) {
    return '송출 인증이 만료되었습니다. 다시 시작을 눌러 주세요'
  }
  if ((e instanceof WebRtcHttpError && e.status === 403) || (e instanceof ApiError && e.code === 'BROADCAST_ENDED')) {
    return '이미 종료된 방송입니다. 새 방송을 만들어 송출하세요'
  }
  if (e instanceof WebRtcHttpError) return `미디어 서버 연결에 실패했습니다 (HTTP ${e.status}). 잠시 후 다시 시도하세요`
  return errorMessage(e)
}
