import { createHmac } from 'node:crypto'
import { safeEqual } from '../lib/crypto.js'

// publish 토큰: `{broadcastId}.{만료 epoch초}.{HMAC-SHA256}` (base64url)
// - 발급 시점에 소유자·상태를 확인하고, MediaMTX 인가 시점에 서명·만료·방송 ID를 확인한다.
// - 서버에 저장하지 않으므로 api가 재시작돼도 유효하다. 서명 키는 INTERNAL_SECRET에서 파생한다.
// - 탈취돼도 피해 범위는 "그 방송에 수명(기본 5분) 동안 송출"뿐이고, 인가 시점에 방송 상태를 다시 확인한다.

export type PublishTokenSigner = {
  issue(broadcastId: number, now?: number): { token: string; expiresAt: Date }
  /** 서명이 맞고 만료되지 않았으며 이 방송용이면 true */
  verify(token: string, broadcastId: number, now?: number): boolean
}

export function createPublishTokenSigner(secret: string, ttlSeconds: number): PublishTokenSigner {
  // 다른 용도의 서명과 섞이지 않도록 용도별 키를 파생한다
  const key = createHmac('sha256', secret).update('publish-token-v1').digest()
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url')

  return {
    issue(broadcastId, now = Date.now()) {
      const exp = Math.floor(now / 1000) + ttlSeconds
      const payload = `${broadcastId}.${exp}`
      return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000) }
    },

    verify(token, broadcastId, now = Date.now()) {
      const parts = token.split('.')
      if (parts.length !== 3) return false
      const [id, exp, mac] = parts as [string, string, string]
      if (!safeEqual(mac, sign(`${id}.${exp}`))) return false
      return Number(id) === broadcastId && Number(exp) * 1000 > now
    },
  }
}
