// 방송 상태 머신 (DESIGN.md §4). 상태는 이 모듈만 바꾼다.
//
//   READY ──online──▶ LIVE ──소유자 종료──▶ ENDED
//                     │  ▲
//             offline │  │ 유예 시간 안에 재송출(online)
//                     ▼  │
//            LIVE + disconnectedAt ──유예 시간 경과──▶ ENDED
//
// MediaMTX 훅은 순서가 뒤바뀌거나(대체 송출 시 새 online이 이전 offline보다 먼저 도착) 유실될 수 있다(#2 스파이크).
// 그래서 (1) offline을 받으면 Control API로 실제 송출 여부를 확인하고, (2) 주기적으로 Control API와 대조해 보정한다.
// 모든 전이는 "현재 상태를 조건으로 거는 UPDATE"라서 훅과 API 요청이 겹쳐도 잘못된 전이(예: ENDED→LIVE)가 일어나지 않는다.
// offline 확인 중 재송출 online이 끼어드는 경우는 lastOnlineAt으로 걸러낸다.

import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { AuthUser } from '../auth/service.js'
import type { Db } from '../db/client.js'
import { type BroadcastStatus, broadcasts } from '../db/schema.js'
import { AppError } from '../errors.js'
import type { MediaControl } from '../media/control.js'
import type { PublishTokenSigner } from '../media/token.js'
import type { EventHub } from '../realtime/hub.js'
import { broadcastNotFound, getOwned } from './service.js'

export const mediaPath = (broadcastId: number) => `live/${broadcastId}`

/** `live/{id}` 형식이면 방송 ID, 아니면 null */
export function parseMediaPath(path: string): number | null {
  const m = /^live\/([1-9][0-9]{0,15})$/.exec(path)
  return m ? Number(m[1]) : null
}

export type StatusPayload = {
  status: BroadcastStatus
  startedAt: Date | null
  endedAt: Date | null
  disconnectedAt: Date | null
}

export type AuthDecision = { ok: true } | { ok: false; status: 401 | 403; reason: string }

const broadcastEnded = () => new AppError(409, 'BROADCAST_ENDED', '이미 종료된 방송입니다. 새 방송을 만들어 주세요')

export function createBroadcastLifecycle(deps: {
  db: Db
  control: MediaControl
  hub: EventHub
  signer: PublishTokenSigner
  graceMs: number
  log: FastifyBaseLogger
}) {
  const { db, control, hub, signer, graceMs, log } = deps
  const { orm } = db

  const load = (id: number) =>
    orm
      .select({
        id: broadcasts.id,
        status: broadcasts.status,
        startedAt: broadcasts.startedAt,
        endedAt: broadcasts.endedAt,
        disconnectedAt: broadcasts.disconnectedAt,
        deletedAt: broadcasts.deletedAt,
      })
      .from(broadcasts)
      .where(eq(broadcasts.id, id))
      .get()

  /** 현재 상태를 시청자에게 알린다 (SSE `status`) */
  function emit(id: number) {
    const row = load(id)
    if (row) hub.publish(id, 'status', toPayload(row))
  }

  const toPayload = (row: StatusPayload): StatusPayload => ({
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    disconnectedAt: row.disconnectedAt,
  })

  /** Control API 실패는 상태 머신을 멈추지 않는다. 주기 대조가 나중에 보정한다 */
  async function sourceOf(path: string) {
    try {
      return { known: true as const, source: await control.getSource(path) }
    } catch (err) {
      log.warn({ err, path }, 'MediaMTX path 조회 실패')
      return { known: false as const, source: null }
    }
  }

  async function kickPath(path: string) {
    const { source } = await sourceOf(path)
    if (!source) return
    try {
      await control.kick(source)
      log.info({ path, source }, '송출 강제 종료')
    } catch (err) {
      log.warn({ err, path }, '송출 강제 종료 실패 (주기 대조에서 다시 시도)')
    }
  }

  // 방송별 마지막 online 처리 시각. offline 확인(Control API 조회)을 기다리는 사이에 재송출 online이
  // 먼저 처리되면, 늦게 끝난 offline이 방금 재개된 방송을 "끊김"으로 덮어쓰지 않게 한다
  const lastOnlineAt = new Map<number, number>()

  /** verified: 호출한 쪽이 이미 Control API로 송출 중임을 확인했으면 true */
  async function markOnline(id: number, { verified = false } = {}) {
    lastOnlineAt.set(id, Date.now())
    const now = new Date()
    const row = load(id)
    if (!row) return
    if (row.deletedAt || row.status === 'ENDED') {
      // 인가 단계에서 막지만, 종료 직전에 인가된 송출이 늦게 붙은 경우를 정리한다
      await kickPath(mediaPath(id))
      return
    }
    if (row.status === 'LIVE' && !row.disconnectedAt) return
    if (row.disconnectedAt && !verified) {
      // 끊김 뒤에 온 online이 늦게 도착한 이전 훅일 수 있다. 실제로 송출 중일 때만 끊김을 해제한다
      const { known, source } = await sourceOf(mediaPath(id))
      if (known && !source) return
    }
    const result = orm
      .update(broadcasts)
      .set({ status: 'LIVE', startedAt: row.startedAt ?? now, disconnectedAt: null, updatedAt: now })
      .where(and(eq(broadcasts.id, id), inArray(broadcasts.status, ['READY', 'LIVE']), isNull(broadcasts.deletedAt)))
      .run()
    if (result.changes > 0) emit(id)
  }

  /** 송출이 실제로 끊겼을 때만 유예를 시작한다 (대체 송출이면 무시) */
  async function markDisconnected(id: number) {
    const row = load(id)
    if (!row || row.status !== 'LIVE' || row.disconnectedAt) return
    const checkedAt = Date.now()
    const { source } = await sourceOf(mediaPath(id))
    if (source) return
    if ((lastOnlineAt.get(id) ?? 0) >= checkedAt) return
    const result = orm
      .update(broadcasts)
      .set({ disconnectedAt: new Date() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'LIVE'), isNull(broadcasts.disconnectedAt)))
      .run()
    if (result.changes > 0) emit(id)
  }

  return {
    // ---- 사용자 API ----

    /** 소유자에게 이 방송 전용 publish 토큰을 발급한다 (READY·LIVE만) */
    issuePublishToken(id: number, user: AuthUser) {
      getOwned(db, id, user)
      const row = load(id)!
      if (row.status === 'ENDED') throw broadcastEnded()
      return { ...signer.issue(id), whipPath: `/${mediaPath(id)}/whip` }
    },

    /** 소유자가 방송을 종료한다. 송출 중이면 MediaMTX에서 강제로 끊는다 */
    async end(id: number, user: AuthUser): Promise<StatusPayload> {
      getOwned(db, id, user)
      const now = new Date()
      const result = orm
        .update(broadcasts)
        .set({ status: 'ENDED', endedAt: now, disconnectedAt: null, updatedAt: now })
        .where(and(eq(broadcasts.id, id), inArray(broadcasts.status, ['READY', 'LIVE']), isNull(broadcasts.deletedAt)))
        .run()
      if (result.changes === 0) {
        const row = load(id)
        if (!row || row.deletedAt) throw broadcastNotFound()
        throw broadcastEnded()
      }
      emit(id)
      await kickPath(mediaPath(id))
      return toPayload(load(id)!)
    },

    // ---- MediaMTX 인가 ----

    authorize(action: string, path: string, token: string | undefined): AuthDecision {
      const id = parseMediaPath(path)
      if (id === null) return { ok: false, status: 403, reason: 'unknown path' }
      const row = load(id)
      const exists = row && !row.deletedAt

      if (action === 'publish') {
        if (!token || !signer.verify(token, id)) return { ok: false, status: 401, reason: 'invalid token' }
        if (!exists || row.status === 'ENDED') return { ok: false, status: 403, reason: 'broadcast not publishable' }
        return { ok: true }
      }
      if (action === 'read') {
        // 시청은 로그인 없이 허용한다. 방송 중일 때만 연결할 의미가 있다
        if (!exists || row.status !== 'LIVE') return { ok: false, status: 403, reason: 'broadcast not live' }
        return { ok: true }
      }
      return { ok: false, status: 403, reason: `action ${action} not allowed` }
    },

    // ---- MediaMTX 훅 ----

    async onOnline(path: string) {
      const id = parseMediaPath(path)
      if (id !== null) await markOnline(id)
    },

    async onOffline(path: string) {
      const id = parseMediaPath(path)
      if (id !== null) await markDisconnected(id)
    },

    // ---- 스케줄러 ----

    /** 유예 시간이 지난 끊김을 ENDED로 확정한다. 확정 직전에 실제 송출 여부를 다시 확인한다 */
    async expireDisconnected(now = Date.now()) {
      const expired = orm
        .select({ id: broadcasts.id, disconnectedAt: broadcasts.disconnectedAt })
        .from(broadcasts)
        .where(and(eq(broadcasts.status, 'LIVE'), lte(broadcasts.disconnectedAt, new Date(now - graceMs))))
        .all()
      for (const { id, disconnectedAt } of expired) {
        const { source } = await sourceOf(mediaPath(id))
        if (source) {
          // online 훅이 유실된 재송출
          await markOnline(id, { verified: true })
          continue
        }
        const result = orm
          .update(broadcasts)
          // 종료 시각은 마지막으로 송출이 끊긴 시각이다
          .set({ status: 'ENDED', endedAt: disconnectedAt, disconnectedAt: null, updatedAt: new Date(now) })
          .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'LIVE'), isNotNull(broadcasts.disconnectedAt)))
          .run()
        if (result.changes > 0) {
          log.info({ broadcastId: id }, '유예 시간 경과로 방송 종료')
          emit(id)
        }
      }
    },

    /** 훅 유실 보정: MediaMTX의 실제 송출 목록과 DB 상태를 맞춘다 */
    async reconcile() {
      let ready: Set<string>
      try {
        ready = await control.listReadyPaths()
      } catch (err) {
        log.warn({ err }, 'MediaMTX path 목록 조회 실패 (다음 주기에 다시 시도)')
        return
      }
      // DB는 LIVE인데 실제 송출이 없다 → offline 훅 유실
      const live = orm
        .select({ id: broadcasts.id })
        .from(broadcasts)
        .where(and(eq(broadcasts.status, 'LIVE'), isNull(broadcasts.disconnectedAt)))
        .all()
      for (const { id } of live) if (!ready.has(mediaPath(id))) await markDisconnected(id)

      // 실제 송출이 있다 → READY/끊김이면 online 훅 유실, ENDED/삭제면 강제 종료가 실패했던 것
      for (const path of ready) {
        const id = parseMediaPath(path)
        if (id !== null) await markOnline(id, { verified: true })
      }
    },

    /** 주기 작업을 시작하고 중지 함수를 돌려준다 */
    start() {
      const run = (name: string, fn: () => Promise<void>) => () =>
        fn().catch((err: unknown) => log.error({ err }, `${name} 실패`))
      const timers = [
        setInterval(run('expireDisconnected', () => this.expireDisconnected()), 5_000),
        setInterval(run('reconcile', () => this.reconcile()), 30_000),
      ]
      for (const t of timers) t.unref()
      return () => timers.forEach(clearInterval)
    },
  }
}

export type BroadcastLifecycle = ReturnType<typeof createBroadcastLifecycle>
