# 설계 문서

> 실시간 방송 플랫폼 — 결정 사항과 그 이유를 기록한다. 결정이 바뀌면 이 문서를 먼저 고친다.

## 1. 제약

| 제약 | 내용 |
|---|---|
| 마감 | 2026-11-19 23:59 (공개 GitHub 저장소 1회 제출) |
| 비용 | 0원. 유료 서비스·유료 플랜 사용 불가 |
| 공개 URL | README에 실제 접속 가능한 서비스 주소 필수 |
| 투입 | 하루 4~6시간, 약 65시간 |

## 2. 아키텍처

```
        https://galle.cloud  (Oracle Cloud Always Free VM 1대, docker compose)
 ┌──────────────────────────────────────────────────────────────────┐
 │  Caddy (자동 HTTPS)                                               │
 │   ├─ /            → web   (React 정적 파일)                       │
 │   ├─ /api/*       → api   (Fastify)                               │
 │   ├─ /whip/*      → mediamtx :8889 (WebRTC 송출 시그널링)          │
 │   ├─ /whep/*      → mediamtx :8889 (WebRTC 시청 시그널링)          │
 │   └─ /recordings/* → 녹화 파일 정적 서빙                           │
 │                                                                  │
 │  mediamtx ── authHTTP ──▶ api /internal/media/auth               │
 │           ── runOnOnline / runOnOffline / runOnRecordSegmentComplete │
 │                          ──▶ api /internal/media/events           │
 │  미디어 UDP 8189 + ICE-TCP 8189 는 Caddy를 거치지 않고 직접 노출  │
 │                                                                  │
 │  volumes: sqlite(db), recordings                                 │
 └──────────────────────────────────────────────────────────────────┘
```

모든 HTTP 경로가 **같은 출처**다. 세션 쿠키는 퍼스트파티이므로 iOS Safari에서도 동작하고 CORS 설정도 필요 없다.

## 3. 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 미디어 서버 | MediaMTX | WHIP/WHEP 지원, 녹화 내장, 인증 HTTP 훅 제공, 바이너리 1개로 동작 |
| 백엔드 | Node 22 + TypeScript + Fastify | 얇은 컨트롤 플레인(인가·상태·훅·결제 검증). 메모리 약 80MB, 빠른 기동 |
| DB | SQLite + Drizzle ORM | 단일 인스턴스, 볼륨 파일로 영구 저장. 운영 부담 0 |
| 검증 | zod | 요청 스키마 검증 |
| 실시간 | SSE | 댓글·후원·상태 이벤트는 서버→클라이언트 단방향. 쓰기는 REST |
| 프론트 | React + Vite + TypeScript | 송출 화면의 상태 전이(권한 → 미리보기 → 송출 → 재연결 → 종료) 관리 |
| 결제 | 토스페이먼츠 테스트 모드 | 서버 승인 API로 금액·주문 검증 |
| 리버스 프록시 | Caddy | 자동 HTTPS (Let's Encrypt) |
| 도메인 | `galle.cloud` (가비아 DNS) | 보유 도메인. `www`는 루트로 리다이렉트 |
| 호스팅 | Oracle Cloud Always Free (도쿄 리전) | 0원. AMD Micro(1GB)로 운영 중이고, ARM(A1)을 확보하면 이전 |
| 이미지 빌드 | GitHub Actions → GHCR (amd64 + arm64) | 빌드는 CI에서 하고, VM은 pull만 한다. A1으로 옮겨도 유지한다 (배포가 서버 사양에 묶이지 않고, 같은 이미지를 재현할 수 있다) |

### 기각한 대안
- **LiveKit Cloud / Egress**: 무료 한도에 의존하고, 녹화(Egress)는 비용이나 무거운 자체 호스팅이 필요하다.
- **Render 무료 플랜**: HTTP 포트 하나만 노출되어 WebRTC 미디어를 처리할 수 없다. 15분 유휴 시 슬립하고, 디스크가 휘발성이다. 미디어용 VM은 어차피 필요하므로 컴포넌트를 나누면 장애 지점만 늘어난다.
- **Vercel(프론트) + Oracle(백엔드) 분리**: 출처가 갈라져 iOS Safari에서 세션 쿠키가 서드파티로 차단된다. rewrite, CORS, 경로별 분기가 필요하고 배포 대상이 2개로 늘어난다. 단일 출처가 더 단순하다.
- **AWS**: 프리티어가 만료되어 비용이 발생한다.
- **Spring Boot**: 이번 범위에서는 메모리(1GB VM)와 개발 속도 면에서 불리하다.
- **HLS 시청**: 지연이 3~10초다. WebRTC 경로가 실패할 때를 위한 플랜 B로 남긴다.

## 4. 도메인 모델

```
User 1 ── 1 Channel 1 ── N Broadcast(회차) 1 ── N Comment
                                         1 ── N DonationOrder ── 0..1 Donation(원장)
                                         1 ── N Recording(세그먼트)
```

- **Channel**: 회원가입 시 자동 생성된다. 편집 UI는 없다. 채널 페이지는 해당 사용자의 방송 목록이다.
- **Broadcast**: `READY → LIVE → ENDED`. ENDED에서 다시 LIVE로 돌아가는 전이는 없다. `deleted_at`으로 Soft Delete한다.
- **MediaMTX path** = `live/{broadcastId}`. 회차마다 path가 다르므로 녹화가 섞이지 않는다.

### 방송 상태 머신

| 현재 | 이벤트 | 다음 | 비고 |
|---|---|---|---|
| READY | 소유자 송출 시작(publish 인증 통과 + runOnOnline) | LIVE | `started_at` 기록 |
| LIVE | 소유자 종료 요청 | ENDED | MediaMTX에서 publisher를 강제로 끊는다 (Control API kick) |
| LIVE | runOnOffline (비정상 이탈) | LIVE + `disconnected_at` 기록 | 유예 시간 시작 |
| LIVE(disconnected) | 유예 시간 내 재송출 | LIVE | `disconnected_at` 해제 |
| LIVE(disconnected) | 유예 시간(45초) 경과 | ENDED | 스케줄러가 확정 |
| LIVE | 훅 유실 | ENDED | 스케줄러가 MediaMTX Control API로 path 상태를 주기적으로 대조해 보정 |
| ENDED | 송출 시도 | 거절 | publish 인증 단계에서 403 |

상태가 바뀌면 SSE로 시청자에게 알리고, 시청 화면은 "방송 종료" 상태로 전환한다.

## 5. 인증·인가

- **사용자 인증**: 세션 ID를 HttpOnly + Secure + SameSite=Lax 쿠키에 담는다. 세션은 SQLite 테이블에 저장해 서버 재시작 후에도 유지한다. 비밀번호는 argon2id로 해시한다.
  - 쿠키에는 무작위 토큰(32바이트)을, DB에는 그 **SHA-256 해시**를 저장한다. DB가 유출되어도 세션을 바로 탈취할 수 없다.
  - 수명 30일, 남은 기간이 절반 이하일 때 요청이 오면 연장한다(슬라이딩). 로그인·회원가입 시 그 요청에 실려 온(같은 브라우저의) 기존 세션은 폐기한다(세션 고정 방지). 다른 기기의 세션은 유지한다.
  - 없는 이메일과 틀린 비밀번호는 같은 401 응답을 주고, 없는 이메일도 해시 검증을 수행해 응답 시간으로 계정 존재 여부가 드러나지 않게 한다.
  - 회원가입은 "이미 가입된 이메일"(409)을 알려준다. 가입 화면의 사용성을 위해 이 단계의 노출은 허용하고, 아래 시도 횟수 제한으로 대량 조회만 막는다. 중복 확인은 argon2 해시보다 먼저 한다.
  - CSRF: SameSite=Lax로 교차 사이트 POST에 쿠키가 실리지 않고, API는 JSON 본문만 받는다(Fastify 기본 text/plain 파서를 제거해 폼·text/plain 전송은 415).
  - 로그인·회원가입은 IP당 분당 10회로 제한한다(초과 시 429 `TOO_MANY_REQUESTS`). 비밀번호 추측과 argon2 연산을 이용한 CPU 소모를 막는다.
  - 클라이언트 IP는 Caddy(compose 고정 IP)가 보낸 `X-Forwarded-For`에서만 읽는다(`TRUST_PROXY`). 다른 주소가 보낸 헤더는 무시해서 IP를 바꿔 가며 제한을 우회할 수 없다.
  - 웹은 세션 확인(`/auth/me`)이 네트워크·서버 오류로 실패하면 비로그인으로 단정하지 않고 "서버 연결 오류 · 다시 시도"를 보여준다.
  - 만료 세션은 기동 시와 1시간마다 정리한다.
  - 회원가입 시 사용자와 채널을 한 트랜잭션으로 만든다. 가입 직후 바로 로그인 상태가 된다.
- **송출 인가 (두 단계)**
  1. `POST /api/broadcasts/:id/publish-token`에서 로그인 여부, 소유자 여부, 상태(READY 또는 LIVE)를 검증한 뒤 짧은 수명의 publish 토큰을 발급한다.
  2. 브라우저가 이 토큰으로 WHIP 송출을 시도하면 MediaMTX가 `authHTTPAddress`로 api에 다시 묻는다. api는 토큰, path, 방송 상태를 검증한다.
  - 결과적으로 **API 경로와 미디어 경로 모두** 서버가 소유권을 확인한다.
- **시청(WHEP read)·목록·상세**: 인증 없이 허용한다.
- **내부 훅 엔드포인트** `/internal/*`: Caddy에서 외부 접근을 차단하고, 공유 시크릿 헤더로 한 번 더 검증한다.

### 권한 매트릭스

| 동작 | 비로그인 | 다른 사용자 | 소유자/작성자 |
|---|---|---|---|
| 방송 목록·상세·시청 | ✅ | ✅ | ✅ |
| 방송 등록 | 401 | ✅(본인 채널) | ✅ |
| 방송 수정·삭제 | 401 | 403 | ✅ (LIVE 중 삭제는 409) |
| publish 토큰 발급 / 송출 / 종료 | 401 | 403 | ✅ |
| 댓글 조회 | ✅ | ✅ | ✅ |
| 댓글 작성 | 401 | ✅ | ✅ |
| 댓글 수정·삭제 | 401 | 403 | ✅ |
| 후원 | 401 | ✅ (LIVE 중에만) | 403 (본인 방송) |

## 6. 송출 클라이언트

- **PC**: `getDisplayMedia({ video, audio: true, systemAudio: 'include' })`와 `getUserMedia({ audio })`를 WebAudio로 믹싱해 **오디오 트랙 1개**로 송출한다.
- **모바일**: `getUserMedia({ video: { facingMode }, audio })`로 송출한다.
- 코덱은 `setCodecPreferences`로 **H.264**를 우선한다. 녹화(fMP4)와 iOS 재생 호환성 때문이다.
- 같은 path에 새 송출이 들어오면 기존 송출을 대체한다(`overridePublisher`). 탭 중복이나 재연결 상황을 위한 설정이다.

### 지원 환경 (검증 후 README에 확정)

| 기능 | 환경 |
|---|---|
| 화면 + 시스템 소리 | Windows Chrome/Edge, "전체 화면" 공유 시 |
| 화면 + 탭 소리 | Chrome/Edge (Windows·macOS), "탭" 공유 시 |
| 모바일 카메라 송출 | iOS Safari, Android Chrome |
| 시청 | 최신 Chrome/Edge/Safari/Firefox, 모바일 포함 |

## 7. 선택 기능

### 댓글 (실시간)
- REST CRUD가 기준이다. 작성·수정·삭제 이벤트는 SSE `/api/broadcasts/:id/events`로 전파한다.
- 삭제는 Soft Delete이며 "삭제된 댓글입니다"로 표시한다.

### 도네이션
1. `POST /api/broadcasts/:id/donation-orders`: 로그인, 본인 방송 아님, LIVE 상태를 검증한다. 금액 범위를 검증한 뒤 주문(`orderId`, 금액, 대상 방송, 후원자)을 `PENDING`으로 생성한다.
2. 클라이언트가 토스 결제창을 호출한다(테스트 키).
3. `POST /api/donations/confirm`: `orderId`, `paymentKey`, `amount`를 받는다. **저장된 주문 금액과 일치하는지** 확인한 뒤 토스 승인 API를 호출하고, 응답의 상태·금액·orderId를 다시 대조한다.
4. **멱등성**: `orderId`는 유니크이고, `UPDATE ... SET status='DONE' WHERE status='PENDING'`의 영향받은 행 수가 1일 때만 원장(`donations`)을 생성한다. 같은 승인 통지(재요청, 웹훅)가 반복되어도 한 번만 적립된다.
5. 주문 생성 시점에 LIVE였다면, 결제 도중 방송이 종료되어도 확정한다.
6. 원장은 삭제하지 않는다. 방송별 내역과 합계는 원장에서 집계한다.

### 녹화·다시보기
- MediaMTX `record: yes`, 포맷은 fMP4, path별 디렉터리에 저장한다. 기본값 `recordDeleteAfter: 1d`는 영구 저장 요구와 충돌하므로 `0s`로 끈다.
- `runOnRecordSegmentComplete` 훅을 받으면 `recordings` 테이블(broadcastId, 파일 경로, 시작 시각, 길이)에 저장한다.
- 재연결로 세그먼트가 여러 개 생기면 회차 상세에서 순서대로 재생한다.

## 8. 위험과 대응

| 위험 | 대응 |
|---|---|
| A1 인스턴스 용량 부족 | E2.1.Micro(1GB)로 운영하고 A1은 재시도. 이미지는 amd64·arm64를 함께 빌드해 어느 쪽으로든 옮길 수 있다 |
| Always Free 유휴 인스턴스 회수 | Pay As You Go 전환 여부를 결정하고 $1 예산 알림을 설정 ([INFRA_SETUP.md](INFRA_SETUP.md) §8) |
| 1GB 메모리 부족 | 2GB 스왑, 이미지 빌드는 CI에서만 |
| 실기기 WebRTC 연결 실패 | 1~2일차 스파이크. 실패 시 시청 경로를 LL-HLS로 전환 |
| 로컬 모바일 테스트에 HTTPS 필요 | Caddy `tls internal` 또는 mkcert + LAN IP |
| 훅 유실로 유령 LIVE | 스케줄러가 Control API와 대조해 보정 |
| 일정 초과 | 선택 기능은 녹화 → 도네이션 → 댓글 순으로 자른다 |

## 9. 오픈소스 출처
- [MediaMTX](https://github.com/bluenviron/mediamtx) (MIT)
- 그 밖의 의존성은 각 `package.json` 참고
