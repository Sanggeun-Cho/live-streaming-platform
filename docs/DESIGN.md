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
 │   └─ /recordings/* → 녹화 파일 정적 서빙 (forward_auth → api)      │
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
| READY·LIVE | 소유자 종료 요청 | ENDED | MediaMTX에서 publisher를 강제로 끊는다 (Control API kick). READY 종료는 "시작 직후 종료" 경합에서 늦게 붙은 송출을 막기 위해 허용 |
| LIVE | runOnOffline (비정상 이탈) | LIVE + `disconnected_at` 기록 | 유예 시간 시작 |
| LIVE(disconnected) | 유예 시간 내 재송출 | LIVE | `disconnected_at` 해제 |
| LIVE(disconnected) | 유예 시간(45초) 경과 | ENDED | 스케줄러가 확정 |
| LIVE | 훅 유실 | ENDED | 스케줄러가 MediaMTX Control API로 path 상태를 주기적으로 대조해 보정 |
| ENDED | 송출 시도 | 거절 | publish 인증 단계에서 403. 종료 직전 인가된 송출이 늦게 online되면 kick |

- offline 훅을 받으면 Control API(`/v3/paths/get`)로 실제 송출 여부를 확인한다. 대체 송출(`overridePublisher`)로 새 online이 먼저 도착하는 경우를 걸러낸다.
- 모든 전이는 현재 상태를 조건으로 거는 UPDATE 한 문장이다. 훅과 API 요청이 겹쳐도 잘못된 전이가 일어나지 않는다.
- 스케줄러: 5초마다 유예 만료 확정(확정 직전 Control API 재확인), 30초마다 Control API 목록과 대조(훅 유실 보정, 남은 송출 kick).
- 송출 화면은 `pagehide`에서 WHIP 세션을 DELETE한다. 보내지 못하면 MediaMTX는 ICE 타임아웃(약 30초) 뒤 offline을 낸다.

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
  1. `POST /api/broadcasts/:id/publish-token`에서 로그인 여부, 소유자 여부, 상태(READY 또는 LIVE)를 검증한 뒤 짧은 수명(5분)의 publish 토큰을 발급한다.
     - 토큰은 `{방송ID}.{만료}.{HMAC}`로 서버에 저장하지 않는다. api가 재시작돼도 유효하고, 탈취돼도 그 방송에 5분 동안만 쓸 수 있으며 인가 시점에 상태를 다시 본다.
     - 송출을 시작하거나 재연결할 때마다 새로 받는다.
  2. 브라우저가 이 토큰으로 WHIP 송출을 시도하면 MediaMTX가 `authHTTPAddress`로 api에 다시 묻는다. api는 토큰, path, 방송 상태를 검증한다.
  - 결과적으로 **API 경로와 미디어 경로 모두** 서버가 소유권을 확인한다.
- **시청(WHEP read)·목록·상세**: 인증 없이 허용한다.
- **시청 인가(read)**: 방송이 LIVE일 때만 허용한다(로그인 불필요).
- **내부 훅 엔드포인트** `/internal/*`: Caddy는 `/api/*`·`/live/*`만 프록시하므로 외부에서 닿지 않는다. 같은 네트워크의 다른 컨테이너를 막기 위해 공유 시크릿을 한 번 더 확인한다. MediaMTX 인가 요청은 헤더를 붙일 수 없어 `authHTTPAddress`의 쿼리로, 훅은 `X-Internal-Secret` 헤더로 보낸다. api 로그는 `secret`·`token` 쿼리 값을 가린다.
- MediaMTX는 인가 실패 응답에 `WWW-Authenticate: Basic`을 붙인다. 그대로 두면 브라우저가 로그인 창을 띄우므로 Caddy에서 지운다.
- **실시간 이벤트(SSE)** `/api/broadcasts/:id/events`: `status`, `viewers`(방송자 본인 연결 제외), `updated`, `deleted`, `donation`(§7), `comment`(§7). 연결 직후 현재 상태를 보내 재연결 시 놓친 변경을 맞춘다.

### 권한 매트릭스

`apps/api/test/authz-matrix.test.ts`가 아래 칸을 표 기반(it.each)으로 검증한다(#13). SSE 구독은 `broadcasts.test.ts`, 녹화 파일 인가는 `recordings.test.ts`, MediaMTX 인가의 시크릿은 `internal-media.test.ts`가 맡는다. 응답은 모두 `{code, message}`이며, 비로그인은 `401 UNAUTHORIZED`, 남의 것은 `403 FORBIDDEN`이다.

| 동작 | 비로그인 | 다른 사용자 | 소유자/작성자 |
|---|---|---|---|
| 방송 목록·상세·채널 정보 | ✅ | ✅ | ✅ |
| 시청 (MediaMTX read 인가) | ✅ LIVE일 때만 | ✅ LIVE일 때만 | ✅ LIVE일 때만 (READY·ENDED는 소유자도 403) |
| 실시간 이벤트(SSE) 구독 | ✅ | ✅ | ✅ (시청자 수에서 제외) |
| 방송 등록 | 401 | ✅(본인 채널, 본문의 채널 ID는 무시) | ✅ |
| 방송 수정 | 401 | 403 | ✅ (ENDED도 수정 가능) |
| 방송 삭제 | 401 | 403 | ✅ (LIVE 중은 409 `BROADCAST_LIVE`) |
| publish 토큰 발급 | 401 | 403 | ✅ READY·LIVE(유예 중 재연결 포함), ENDED는 409 `BROADCAST_ENDED` |
| 송출 (MediaMTX publish 인가) | 401 (토큰 없음) | 401 (토큰을 받을 수 없음) | ✅ 이 방송의 유효 토큰 + READY·LIVE (ENDED·삭제는 403, 다른 방송 토큰은 401) |
| 방송 종료 | 401 | 403 | ✅ READY·LIVE, 이미 ENDED는 409 |
| 댓글 조회 | ✅ | ✅ | ✅ |
| 댓글 작성 | 401 | ✅ | ✅ (READY·LIVE·ENDED 모두) |
| 댓글 수정·삭제 | 401 | 403 (방송자도 남의 댓글은 403) | ✅ 작성자 |
| 후원 주문 | 401 | ✅ LIVE 중에만, 아니면 409 `BROADCAST_NOT_LIVE` | 403 (본인 방송) |
| 후원 승인 확인(confirm) | 401 | 403 (남의 주문, 방송자 포함) | ✅ 주문한 본인 |
| 후원 웹훅 | 공개 (토스 서버. 본문을 믿지 않고 결제 조회 API로 확인) | | |
| 후원 내역·합계·설정 조회 | ✅ | ✅ | ✅ |
| 다시보기 목록·녹화 목록 | ✅ | ✅ | ✅ |
| 녹화 파일(`/recordings/*`) | ✅ 등록된 파일이고 방송이 삭제되지 않았을 때 | ✅ | ✅ |
| 녹화 등록(세그먼트 훅)·내부 훅·미디어 인가 | 공유 시크릿만 (사용자 세션과 무관, 없으면 401) | | |
| 회원가입·로그인·로그아웃 | ✅ (가입·로그인은 IP당 분당 10회) | ✅ | ✅ |
| **삭제된 방송**의 모든 조회·쓰기 | 쓰기는 401, 조회는 404 | 404 `BROADCAST_NOT_FOUND` | 404 (소유자도) |

- 검증 순서는 인증(401) → 요청 형식(400) → 대상 존재(404) → 소유권(403) → 상태(409)다. 형식이 틀린 요청은 남의 방송이어도 400이 먼저 나온다(정보 노출 없음: 존재 여부는 형식 검사와 무관).
- 형식이 아예 다른 요청(잘못된 JSON 400 `INVALID_JSON`, JSON 아닌 본문 415, 1MB 초과 413, 깨진 URL 400 `BAD_URL`, 없는 경로 404)과 처리하지 못한 예외(500 `INTERNAL_ERROR`, 내부 정보 숨김)도 같은 형식이다(`error-format.test.ts`). `/internal`은 MediaMTX·Caddy만 부르므로 상태 코드만 쓴다.

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
- API
  - `GET /api/broadcasts/:id/comments?cursor&limit`(공개): 최신 `limit`개(기본 50, 최대 100)를 **오래된 것부터**(채팅 순서) 돌려주고, 더 오래된 댓글은 `nextCursor`로 읽는다. 삭제된 댓글은 `content`·`author`를 모두 null로 숨기고 자리만 남는다(본문은 DB에 보관).
  - `POST /api/broadcasts/:id/comments`(로그인), `PATCH /api/comments/:id`·`DELETE /api/comments/:id`(작성자만, 아니면 403. 방송자도 남의 댓글은 403). 삭제 응답은 본문을 숨긴 댓글(200).
  - 응답에 작성자 닉네임과 `isStreamer`(방송자 본인 댓글, 채팅에서 강조)를 담는다. 수정하면 `editedAt`을 채워 "(수정됨)"을 표시한다. 같은 내용으로 수정하면 아무것도 바꾸지 않는다(이벤트도 없음).
  - 내용은 앞뒤 공백을 뺀 1~300자. 쓰기(작성·수정·삭제)는 합쳐서 사용자당 10초에 10번(초과 시 429). 세 라우트가 제한 핸들러 하나를 공유한다.
  - 방송이 삭제되면 그 방송의 댓글 조회·작성·수정·삭제는 404. 방송 상태(READY·LIVE·ENDED)와 관계없이 작성할 수 있다.
- SSE 이벤트 `comment`: `{ type: 'created' | 'updated' | 'deleted', comment }`. 웹은 방송 화면이 이미 연 SSE 연결로 받고(시청자 수 중복 집계 방지), 연결·재연결될 때마다 최신 목록을 다시 읽는다. 새 목록이 들고 있던 목록과 겹치지 않으면(끊긴 동안 한 페이지보다 많이 쌓임) 목록과 커서를 새 페이지로 바꿔 빈 구간을 "이전 채팅 보기"로 잇는다. 화면이 들고 있는 댓글은 500개까지이며, 맨 아래를 보고 있을 때만 오래된 것부터 정리한다.

### 도네이션
1. `POST /api/broadcasts/:id/donation-orders`: 로그인(401), 본인 방송 아님(403), LIVE 상태(409 `BROADCAST_NOT_LIVE`)를 검증한다. 금액(1,000~1,000,000원, 1,000원 단위)과 메시지(선택, 100자)를 검증한 뒤 주문(무작위 `orderId`, 금액, 메시지, 대상 방송, 후원자)을 `PENDING`으로 생성한다.
2. 클라이언트가 토스 **결제창형 결제**(SDK v2 `widgets().renderPaymentWindow()` → `paymentRequest` 이벤트에서 `requestPayment()`)를 띄운다. 결제창(구버전) `payment()`는 API 개별 연동 키(`test_ck_`)가 필요하고, 공개 문서용 `test_ck_` 키는 더 이상 인증되지 않아(2026-11-09 확인) 결제창형을 택했다. 성공·실패는 `/broadcasts/:id/donation/success|fail`로 돌아온다(취소 시 orderId가 없어 방송 ID를 경로에 둔다).
3. `POST /api/donations/confirm`(로그인, 주문한 본인만): `orderId`, `paymentKey`, `amount`를 받는다. **저장된 주문 금액과 일치하는지** 확인하고(다르면 승인 요청 없이 FAILED) 토스 승인 API(`Idempotency-Key: confirm-{orderId}`)를 호출한 뒤, 응답의 상태(DONE)·금액·orderId·paymentKey·통화를 다시 대조한다.
   - 토스 거절(4xx) → 주문 FAILED, 400 `PAYMENT_REJECTED`. 토스 원문 메시지는 보내지 않고, 사용자 원인 코드(카드 거절·한도·결제 시간 만료 등)만 정해 둔 안내 문구로 바꾼다. 키 불일치 같은 설정 오류(`UNAUTHORIZED_KEY` 등)는 503 `PAYMENT_CONFIG_ERROR`("결제 설정 오류") + 오류 로그, 주문은 PENDING.
   - 네트워크·429·5xx·응답 형식 오류(zod 검증 실패) → 주문은 PENDING 유지, 502 `PAYMENT_UNAVAILABLE`("새로고침해 다시 확인"). 재요청은 멱등키 덕분에 안전하다.
   - 5xx 안내 문구는 `AppError`에 노출(`expose`)을 명시한 경우에만 그대로 보낸다. 나머지 5xx는 "서버 오류가 발생했습니다".
   - **한계**: 승인 후 응답 대조가 어긋나면 적립하지 않고 FAILED + 오류 로그만 남긴다. 결제 취소 API는 연동하지 않아 운영자가 토스 상점관리자에서 취소해야 한다.
   - `ALREADY_PROCESSED_PAYMENT`(다른 요청이 먼저 승인) → 결제 조회 API(`GET /v1/payments/{paymentKey}`)로 실제 상태를 확인해 같은 경로로 적립한다.
4. **멱등성**: `orderId`는 유니크이고, `UPDATE ... SET status='DONE' WHERE status IN ('PENDING','FAILED')`의 영향받은 행 수가 1일 때만 같은 트랜잭션에서 원장(`donations`, `order_id` 유니크)을 생성한다. 같은 승인 통지(재요청, 동시 요청, 웹훅)가 반복되어도 한 번만 적립된다. 이미 DONE인 주문의 재요청은 토스에 다시 묻지 않고 기존 결과를 돌려준다. FAILED → DONE을 허용하는 이유: 토스 조회로 승인이 확인된 결제는 돈이 빠져나갔으므로 적립이 맞다(confirm 경로는 FAILED 주문을 409로 먼저 거절한다).
5. 주문 생성 시점에 LIVE였다면, 결제 도중 방송이 종료되어도 확정한다. 단 confirm 전에 방송이 **삭제**됐으면 토스 승인을 요청하지 않고 404(주문 FAILED, 결제 안 됨)로 끝낸다(#13, 삭제된 방송의 후원은 아무도 볼 수 없다). 이미 승인된 결제가 웹훅으로 오면 돈이 빠져나갔으므로 삭제된 방송이어도 적립한다. 삭제 확인은 토스 승인 요청 직전에 한 번 하므로, 승인 요청(수 초) 도중 삭제되면 웹훅 경로와 같은 결과(적립)가 된다(알려진 한계, 돈은 보전된다).
6. 원장은 삭제하지 않는다. 방송별 내역과 합계는 원장에서 집계한다: `GET /api/broadcasts/:id/donations`(공개, 최신순 커서 페이지 + `total {amount, count}`).
7. 적립되면 SSE `donation` 이벤트(`{donation: {후원자 닉네임, 금액, 메시지}, total}`)를 보낸다. 방송 화면은 알림을 띄우고 합계·내역을 갱신하며, SSE가 다시 연결되면 내역을 다시 읽는다.
8. 웹훅 `POST /api/donations/webhook`(`PAYMENT_STATUS_CHANGED`): 본문은 믿지 않고 `paymentKey`로 결제 조회 API를 불러 DONE이고 주문과 일치하면 4와 같은 경로로 적립한다(브라우저가 confirm 전에 닫힌 경우 보정). 대조가 어긋나면 주문 상태를 바꾸지 않고 무시한다(남의 orderId에 자기 결제 키를 붙여 남의 주문을 실패로 만들 수 없게). IP당 분당 60회 제한. 조회 실패(일시 오류)만 503으로 재전송을 유도하고 나머지는 200. 개발자센터에 `https://<도메인>/api/donations/webhook`을 등록해야 동작한다.
9. 키: `TOSS_CLIENT_KEY`(공개, `GET /api/donations/config`로 웹에 전달) / `TOSS_SECRET_KEY`(서버 전용). 둘 다 없으면 후원 버튼에 "결제 설정이 없어 후원을 사용할 수 없습니다". 키는 결제창형 테스트 키(`test_gck_`/`test_gsk_`)만 받는다(라이브 키 거부, 이번 과제는 테스트 결제만). 개발·E2E 전용 `TOSS_FAKE_PAYMENTS=true`는 결제창 없이 승인 처리한다(운영에서는 기동 거부, 토스 키와 함께 설정하면 기동 거부, 켜져 있으면 기동 로그에 경고). 주문 생성은 사용자당 분당 10회로 제한한다.

### 녹화·다시보기
- MediaMTX `record: yes`, 포맷은 fMP4, path별 디렉터리에 저장한다. 기본값 `recordDeleteAfter: 1d`는 영구 저장 요구와 충돌하므로 `0s`로 끈다.
- 세그먼트가 닫히면 `hooks/segment.sh`가 mediamtx 컨테이너의 ffmpeg로 **영상은 복사, 오디오만 AAC**로 바꾼 웹용 mp4(`+faststart`)를 같은 경로에 만든다(원본 대체). Safari·iOS의 mp4 Opus 재생이 불확실하고(#2 스파이크), 1GB 서버에서 영상 재인코딩은 감당할 수 없기 때문이다. 변환이 실패하면 원본을 그대로 등록한다.
- 변환 후 api `/internal/media/events`(type=segment)를 호출하면 `recordings` 테이블(broadcastId, 녹화 디렉터리 기준 상대 경로(유니크), 시작 시각, 길이, 크기)에 등록한다.
  - 같은 파일은 한 번만 등록한다(멱등). path가 `live/{id}`가 아니거나, 경로가 녹화 디렉터리 밖·다른 방송 디렉터리·정규화되지 않은 경로면 400으로 거절한다.
  - 세그먼트 훅은 offline·종료 뒤에 오므로 방송 상태와 상관없이 등록한다. 등록되면 SSE `recording` 이벤트를 보낸다.
  - 시작 시각은 파일 이름(`%Y-%m-%d_%H-%M-%S-%f_%z`)에서 읽는다. 훅 도착 순서는 변환 시간에 따라 바뀔 수 있다.
- 파일은 Caddy가 recordings 볼륨(읽기 전용)에서 `/recordings/*`로 서빙한다(Range 지원). 요청마다 `forward_auth`로 api `/internal/recordings/authorize`에 묻고, **등록된 파일이고 방송이 삭제되지 않았을 때만** 내보낸다. 변환 중인 임시 파일·미등록 파일·삭제된 방송의 영상은 404.
- 훅이 유실되면(wget 실패, 변환 중 mediamtx 재시작) api가 기동 시와 5분마다 recordings 볼륨(읽기 전용)을 스캔해 미등록 세그먼트를 등록한다. 최근 2분 안에 바뀐 파일·변환 중인 원본·점 파일은 건너뛰고, 길이는 mp4 박스(mvhd 또는 moof의 tfdt+trun)에서 읽는다. MediaMTX는 세그먼트 훅을 path offline에 묶어 끝내지 않는다(v1.21.3 `internal/core/path.go` `OnSegmentComplete`).
- 변환은 `flock`으로 한 번에 하나, ffmpeg 스레드 1개·`nice`·30분 `timeout`.
- API: `GET /api/replays`(녹화가 있는 ENDED 방송, 종료 시각 최신순, 커서), `GET /api/broadcasts/:id/recordings`(재생 순서대로). 공개, 삭제된 방송은 404.
- 재연결로 세그먼트가 여러 개 생기면 회차 상세에서 시작 시각 순서로 이어서 재생한다(구간 목록 표시). 종료 직후 아직 등록 전이면 "녹화 파일을 준비하고 있습니다"를 보여준다. SSE `recording`과, 종료 후 10분 동안의 10초 주기 조회(개수 무관, 마지막 구간 누락 방지)로 갱신한다.

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
- 토스페이먼츠 연동은 공식 문서·예제를 따랐다 (코드 복사 없음, 2026-11-09 확인)
  - 결제창형 결제 연동: https://docs.tosspayments.com/guides/v2/payment-widget/integration-window
  - 결제창형 SDK: https://docs.tosspayments.com/sdk/v2/js/payment-window
  - 결제창(구버전) 연동(비교용): https://docs.tosspayments.com/guides/v2/payment-window/integration
  - 멱등키: https://docs.tosspayments.com/reference/using-api/idempotency-key
  - 웹훅 이벤트: https://docs.tosspayments.com/reference/using-api/webhook-events
  - 공식 예제(문서용 테스트 키 출처): https://github.com/tosspayments/tosspayments-sample (`express-javascript/server.js`)
- [FFmpeg](https://ffmpeg.org/) (LGPL/GPL): `bluenviron/mediamtx:*-ffmpeg` 이미지에 포함된 것을 녹화 세그먼트 오디오 변환(#12)에 실행만 한다
- 그 밖의 의존성은 각 `package.json` 참고
