import { ApiError } from './api'

// 목록 카드는 넓어도 400px 남짓이다. 2배 밀도 화면까지 선명하면서 서버 상한(300KB)보다 충분히 작게 둔다
const MAX_WIDTH = 640
const QUALITY = 0.7
// 8x8로 줄인 평균 밝기(0~255)가 이보다 낮으면 검은 화면으로 본다 (카메라가 켜지는 중·화면 공유 시작 직후)
const BLACK_LUMA = 8

/**
 * 재생 중인 video의 지금 화면을 JPEG로 만든다 (최대 640px 폭, 비율 유지).
 * 아직 프레임이 없거나, 거의 검은 화면이거나, 캔버스를 쓸 수 없으면 null (카드에서는 기본 표지를 쓰는 편이 낫다).
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
  if (isNearlyBlack(canvas)) return Promise.resolve(null)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
}

/** 8x8로 줄여 평균 밝기를 본다. 픽셀을 읽을 수 없으면(보안 제한 등) 검지 않은 것으로 둔다 */
function isNearlyBlack(source: HTMLCanvasElement): boolean {
  const small = document.createElement('canvas')
  small.width = 8
  small.height = 8
  const ctx = small.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(source, 0, 0, 8, 8)
  try {
    const { data } = ctx.getImageData(0, 0, 8, 8)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    return sum / (data.length / 4) < BLACK_LUMA
  } catch {
    return false
  }
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
    throw new ApiError(0, 'NETWORK_ERROR', '서버에 연결할 수 없습니다.')
  }
  const data = (await res.json().catch(() => ({}))) as { thumbnailUrl?: string; code?: string; message?: string }
  if (!res.ok || !data.thumbnailUrl) {
    throw new ApiError(res.status, data.code ?? 'UNKNOWN', data.message ?? `썸네일을 올리지 못했습니다(HTTP ${res.status}).`)
  }
  return data.thumbnailUrl
}
