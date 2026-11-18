import { ApiError } from './api'

// 목록 카드는 넓어도 400px 남짓이다. 2배 밀도 화면까지 선명하면서 서버 상한(300KB)보다 충분히 작게 둔다
const MAX_WIDTH = 640
const QUALITY = 0.7

/**
 * 재생 중인 video의 지금 화면을 JPEG로 만든다 (최대 640px 폭, 비율 유지).
 * 아직 프레임이 없거나 캔버스를 쓸 수 없으면 null.
 */
export function captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const { videoWidth, videoHeight } = video
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !videoWidth || !videoHeight) return Promise.resolve(null)
  const scale = Math.min(1, MAX_WIDTH / videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(videoWidth * scale)
  canvas.height = Math.round(videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
}

/**
 * 방송 썸네일을 올린다 (방송 중인 본인 방송만). 성공하면 새 썸네일 주소를 돌려준다.
 * 실패하면 공통 형식의 ApiError (401·403·404·409·413 등)
 */
export async function uploadThumbnail(broadcastId: number, blob: Blob): Promise<string> {
  let res: Response
  try {
    res = await fetch(`/api/broadcasts/${broadcastId}/thumbnail`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '서버에 연결할 수 없습니다')
  }
  const data = (await res.json().catch(() => ({}))) as { thumbnailUrl?: string; code?: string; message?: string }
  if (!res.ok || !data.thumbnailUrl) {
    throw new ApiError(res.status, data.code ?? 'UNKNOWN', data.message ?? `썸네일을 올리지 못했습니다 (HTTP ${res.status})`)
  }
  return data.thumbnailUrl
}
