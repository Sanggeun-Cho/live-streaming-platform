# 테스트 명세

명세 항목([SPEC_CHECKLIST.md](SPEC_CHECKLIST.md))이 어느 테스트로 검증되는지, 각 테스트가 무엇을 확인하는지, 테스트로 증명하지 못하는 것이 무엇인지 정리한다.
모든 건수는 실제 테스트 코드에서 센 값이다(2026-11-10, dev 기준, vitest `--reporter=json`).

## 1. 개요

### 테스트 계층

| 계층 | 도구 | 위치 | 건수 | 무엇을 보나 |
|---|---|---|---|---|
| API 통합 | vitest + Fastify `inject` (SSE는 임시 포트로 실제 연결) | `apps/api/test/*.test.ts` 13개 파일 | **408** | 라우트 → 서비스 → SQLite(메모리 또는 임시 파일)까지 실제 코드. MediaMTX Control API와 토스 API만 대역 |
| 웹 단위 | vitest (node 환경, 브라우저 API는 가짜) | `apps/web/src/lib/**/*.test.ts` 4개 파일 | **53** | 송출(Publisher) 상태 전이, 캡처, WHIP 핸드셰이크·코덱 선택, 다시보기 구간 |
| 브라우저 E2E | playwright-core + 설치된 Chrome + 가짜 카메라·마이크·화면 | `e2e/NN-*.mjs` 9개 파일 | 시나리오 단계 93개(11을 가짜 결제로 돌릴 때 실행 기준. 테스트 키 모드면 89개) | 실제 화면·실제 MediaMTX·실제 WebRTC 송출과 시청 |

- 합계: vitest 461건(API 408 + 웹 53). CI(`.github/workflows`)는 `npm run typecheck`와 `npm test`(API·웹 모두)를 돌린다. E2E는 CI에 없고 로컬에서 돌린다.
- API 테스트는 테스트마다 새 앱(`makeApp`, 메모리 DB)을 만든다. 재시작 테스트만 임시 파일 DB를 두 번 연다.

### 실행 방법

```bash
npm ci
npm test                      # API 408 + 웹 53 (루트: 두 워크스페이스를 차례로)
npm test -w @live/api         # API 통합 테스트만
npm test -w @live/web         # 웹 단위 테스트만
npm run typecheck             # api tsc + web tsc·vite build + CSS 검사
```

E2E는 설치된 Chrome이 필요하다(브라우저를 내려받지 않는다). 파일 이름 일부로 하나만 고를 수 있다(`npm run e2e -- 07`).

| E2E | 필요한 환경 | 명령 예 |
|---|---|---|
| 05·10 | 개발 서버 또는 docker compose 어느 쪽이든 | `npm run e2e -- 05` (기본 `http://localhost:5173`) |
| 14 | 테스트 계정 시드가 켜진 서버(`SEED_TEST_ACCOUNTS=true`, compose 기본값) | `E2E_BASE_URL=https://localhost npm run e2e -- 14` |
| 06·07·08·12 | docker compose 전체 구성(Caddy·api·MediaMTX). 07·12는 `docker compose`를 직접 부른다 | `E2E_BASE_URL=https://localhost npm run e2e -- 07` |
| 13 | docker compose + `.env`에 `NODE_ENV=development`, `TOSS_FAKE_PAYMENTS=true` (가짜 결제로 후원 내역을 만든다) | `E2E_BASE_URL=https://localhost npm run e2e -- 13` |
| 11 | 개발 서버(`npm run dev:api` + `npm run dev:web`). api에 `TOSS_FAKE_PAYMENTS=true`(NODE_ENV 기본 development) 또는 토스 결제창형 테스트 키. 내부 훅을 api 직접 주소로 보낸다 | `npm run e2e -- 11` (`E2E_API_URL` 기본 `http://localhost:3000`, `E2E_INTERNAL_SECRET` 기본 개발용 값) |

- docker 구성을 기본 이름이 아닌 프로젝트로 띄웠다면 E2E도 같은 `COMPOSE_PROJECT_NAME`으로 실행한다(07·12·13이 `docker compose`를 직접 부른다). 예: `COMPOSE_PROJECT_NAME=liveqa13`.
- `E2E_HEADED=1`이면 브라우저 창을 띄우고, `E2E_VERBOSE=1`이면 실패한 Playwright 호출 기록을 더 보여준다.
- 운영에서는 가짜 결제를 켤 수 없다(`NODE_ENV=production` + `TOSS_FAKE_PAYMENTS=true`면 api가 기동을 거부, `donations.test.ts`가 확인).

## 2. 명세 항목 ↔ 테스트 추적표

ID는 [SPEC_CHECKLIST.md](SPEC_CHECKLIST.md)와 같다. "수동"은 테스트로 증명하지 못해 실기기·사람이 확인할 항목이다(§7).

| ID | 항목 | API 통합 | 웹 단위 | E2E | 수동 |
|---|---|---|---|---|---|
| B1 | 문법 오류 없음 | — (CI `typecheck`, oxlint) | — | — | — |
| P1 | PC 화면 캡처 실시간 송출 | `internal-media` MediaMTX 인가·상태 머신 | `publisher` 송출 시작·종료, `whip` 전체, `media` captureScreen | 07 "방송을 시작하면 LIVE…시청자 화면에서 재생" | 실제 화면 공유 #9 |
| P2 | 탭·시스템 소리 + 마이크 | — | — | 07 "화면 공유를 선택하면…화면 소리·마이크 상태", 시청 측 수신 오디오 RTP 증가 | 실제 소리가 섞여 들리는지 #9 |
| P3 | 마이크 음성 송출 | — | — | 07 "마이크 끄기·켜기", 수신 오디오 RTP 증가 | 실제 음성 #9 |
| P4 | 시작·종료 시 송출 연결 생성·종료 | `internal-media` 상태 머신·방송 종료(kick) | `publisher` "종료하면 서버에 종료를 요청하고 연결·장치를 모두 끈다" | 07 시작·종료·장치 정지·서버 끊김 자동 재연결, 06 | — |
| P5 | PC 송출을 다른 기기에서 시청 | `authz-matrix` 시청(read) 인가 | — | 07 같은 PC 다른 브라우저 컨텍스트 | 다른 기기 #9 |
| M1 | 휴대폰 카메라 + 마이크 송출 | — | `publisher` 영상 소스 중단·카메라 복구 루프, `media` captureCamera | 08 iPhone UA 카메라 송출, PC에서 디코딩 프레임·오디오 RTP 증가, 카메라 강제 종료 복구 | 실제 iOS·Android #9 |
| M2 | 휴대폰 마이크 송출 | — | — | 08 PC·휴대폰 시청 측 오디오 RTP 증가 | 실기기 #9 |
| M3 | 모바일 시작·종료 | `internal-media` 방송 종료 | `publisher` 전체(상태 전이) | 08 시작·전면/후면 전환·종료 | 실제 전면/후면 카메라 #9 |
| M4 | 휴대폰 송출을 다른 기기에서 시청 | — | — | 08 PC·모바일 화면에서 시청 | 실기기 #9 |
| S1 | 방송 정보 CRUD | `broadcasts` 등록·조회·수정·삭제 | — | 05 전체 | — |
| S2 | 목록·상세·선택 시청 | `broadcasts` 조회, `authz-matrix` 공개 조회 | — | 05 목록·상세, 06·07·08 상세에서 시청 | — |
| S3 | PC·모바일 송출을 각각 다른 기기에서 재생 | — | — | 07(PC→PC 화면), 08(모바일→PC, 모바일 시청) | 다른 기기·이동통신망 #9 |
| S4 | 방송 중·종료 상태 관리 | `internal-media` 상태 머신·주기 대조·SSE, `state-boundaries` 전체 | `publisher` 연결 끊김과 재연결 | 06 실시간 상태 전환·유예 만료 자동 종료 | — |
| S5 | 종료 시 송출 중단 | `internal-media` "소유자가 종료하면 ENDED가 되고 송출을 강제로 끊는다", "종료 후 늦게 도착한 online은 끊는다", `state-boundaries` 경합 | `publisher` "끊긴 사이 방송이 종료됐으면 ended" | 06 종료 후 시청 중단·다른 탭 종료 시 장치 정지, 07 종료 후 캡처 트랙 0개 | — |
| S6 | 영구 저장·재시작 후 조회 | `broadcasts` "서버를 재시작해도 방송 정보가 유지된다", `auth` 세션 영속성, `recordings` 영구 저장 | — | 13 `restart api`·`down`→`up` | 운영 서버 재시작 #9 |
| A1 | 가입·로그인·로그아웃·인증 상태 | `auth`(24), `auth-service`(5) | — | 05·10 세션 만료 유도, 14 바로 로그인 | — |
| A2 | 비로그인 목록·시청 | `authz-matrix` 공개 조회 12종 × 3, 시청(read) 비로그인 허용 | — | 05 비로그인 상세, 06 비로그인 시청자, 12 | — |
| A3 | 등록·송출은 로그인만 | `authz-matrix` 방송 등록·publish 토큰 anon 401, `internal-media` 토큰 발급 | — | 06 "토큰 없이 WHIP로 송출하면 401" | — |
| A4 | 소유자 권한 서버 검증 | `broadcasts` 수정·삭제 403, 검증 순서, `internal-media` 토큰·종료 403, `authz-matrix` 쓰기 | — | 05 "API로 직접 수정·삭제하면 403", 07 다른 사용자 스튜디오 | — |
| A5 | 사용자 유형별 허용·거절 | `authz-matrix` 151건(147칸 + 독립 4건) | — | — | — |
| C1 | 댓글 CRUD | `comments`(22) | — | 10 전체 | — |
| C2 | 댓글 작성자 권한 | `comments` 수정·삭제 403(방송자라도), `authz-matrix` 댓글 행 | — | 10 "C가 API로 직접 수정·삭제하면 403" | — |
| D1 | 후원 대상·금액 선택, 테스트 결제 요청 | `donations` 설정·주문 생성, `error-format` 후원 금액 | — | 11 금액 규칙·결제창(테스트 키 모드) | 실제 카드 승인 |
| D2 | 서버 승인 검증·저장 | `donations` 승인(confirm) 26건, `toss-client` 응답 형식 | — | 11 가짜 결제 적립·금액 위조 거절, 테스트 키 모드 실제 승인 API 거절 | 실제 승인 성공 응답 |
| D3 | 중복 적립 방지 | `donations` 재요청·동시 요청·웹훅 반복·원장 유니크 단독, `toss-client` 가짜 멱등키 | — | 11 "같은 성공 주소를 다시 열어도 1번만 적립" | — |
| D4 | 방송별 내역·합계 | `donations` 방송별 내역·합계, SSE donation | — | 11 합계·내역·다른 시청자 실시간 알림 | — |
| R1 | 라이브 녹화 저장 | `recordings` segment 훅 등록, `recordings-scan` 복구 스캔·mp4 길이 | — | 12 세그먼트 2개 이상, ffprobe h264+aac, faststart | — |
| R2 | 녹화 목록·상세·재생 | `recordings` 다시보기 목록·커서·파일 서빙 인가 | `recordings` 다시보기 구간(nextSegment) | 12 다시보기 목록·재생(오디오 포함)·다음 구간 자동 재생 | Safari 재생 #9 |
| R3 | 영상 정보·위치 영구 저장 | `recordings` "서버를 재시작해도 녹화 목록과 다시보기 목록이 그대로" | — | 12 api 재시작, 13 | — |
| D-1 | 서비스 URL | — | — | — | 운영 배포(QUESTIONS U0·U1) |
| D-2 | 테스트 계정·바로 로그인 | `auth` SEED_TEST_ACCOUNTS 2건, `auth-service` 시드 3건 | — | 14 전체 | — |
| D-3 | 실행 방법 | — | — | — | README 따라 실행(전체 리뷰에서 새 클론으로 확인) |
| D-4 | 기능 확인 절차 | — | — | 05~14가 README 절차와 같은 흐름 | 실기기 #9 |
| N1 | 출처 명시 | — | — | — | README 표 |
| N2 | 민감 정보 미포함 | — | — | — | `git grep`·`git log -G` 점검(#14) |

품질 기준(평가 "코드 품질·안정성")에 해당하는 공통 테스트: `error-format`(공통 에러 형식 37건), `health`(로그 마스킹), `state-boundaries`(경합 10건).

## 3. 파일별 테스트 목록

### API 통합 (`apps/api/test`, 408건)

| 파일 | 건수 | describe (건수) |
|---|---|---|
| `auth-service.test.ts` | 5 | 로그인 시간 균등화(2), 테스트 계정 시드(3) |
| `auth.test.ts` | 24 | 인증 API(20), 리버스 프록시 신뢰(1), 세션 영속성(3) |
| `authz-matrix.test.ts` | 151 | 쓰기(78), 공개 조회(36), 삭제된 방송(33), 독립(4) |
| `broadcasts.test.ts` | 21 | 등록(6), 조회(4), 수정(3), 삭제(3), 그 밖(5) |
| `comments.test.ts` | 22 | 작성(10), 목록(4), 수정(4), 삭제(3), SSE(1) |
| `donations.test.ts` | 52 | 설정(4), 주문 생성(10), 승인(26), 웹훅(7), 내역·합계(4), SSE(1) |
| `error-format.test.ts` | 37 | Fastify 본문·URL 오류(7), 검증 오류(26), 인증·권한·상태·제한(2), 500(2) |
| `health.test.ts` | 3 | health(2), 로그 마스킹(1) |
| `internal-media.test.ts` | 29 | 내부 호출 보호(2), 토큰 발급(2), MediaMTX 인가(4), 상태 머신(9), 방송 종료(5), 주기 대조(2), SSE(4), 토큰 서명(1) |
| `recordings-scan.test.ts` | 12 | mp4 길이 계산(4), 복구 스캔(8) |
| `recordings.test.ts` | 32 | 등록·다시보기(21), 영구 저장(1), 경로·메타데이터 해석(10) |
| `state-boundaries.test.ts` | 10 | 종료·삭제와 훅의 경합(5), 유예 시간(2), 삭제된 방송의 후원·녹화(3) |
| `toss-client.test.ts` | 10 | 토스 API 클라이언트(8), 가짜 토스 멱등키(2) |

#### `auth-service.test.ts` (5)
- 로그인 시간 균등화: 없는 이메일도 더미 해시로 argon2 검증을 한 번 수행하고 401 / 있는 이메일·틀린 비밀번호도 한 번 수행(두 경로 비용 동일).
- 테스트 계정 시드: 확인과 생성 사이 경합(`EMAIL_TAKEN`)은 건너뜀 / 그 밖의 오류는 기동 실패 / 없는 계정만 만들고 만든 이메일을 반환.

#### `auth.test.ts` (24)
- 인증 API(20): 가입 201·채널 생성·보안 쿠키 / DB에는 세션 토큰 해시만 / 같은 이메일(대소문자 무관) 409 / 잘못된 입력 400 ×4 / 로그인 200·새 세션 / 틀린 비밀번호와 없는 이메일은 같은 401 / 로그인 시 요청의 이전 세션 폐기 / 다른 기기 세션은 유지 / 로그아웃 시 세션 삭제·쿠키 제거 / 쿠키 없음·위조 `/me` 401 / JSON 아닌 본문 415 / 로그인·가입 IP당 분당 10회 초과 429 (각 1) / 신뢰하지 않는 `X-Forwarded-For`로 제한 우회 불가 / 가입도 이전 세션 폐기 / 만료 세션 거부 / 남은 기간 절반 이하면 연장.
- 리버스 프록시 신뢰(1): 신뢰하는 프록시가 전달한 클라이언트 IP별로 시도 횟수를 센다.
- 세션 영속성(3): 재시작해도 로그인 유지 / `SEED_TEST_ACCOUNTS` 켜짐: 기동 시 계정 생성(재기동해도 중복 없음)·목록 공개 / 꺼짐: 목록 비어 있음.

#### `authz-matrix.test.ts` (151)
DESIGN §5 권한 매트릭스를 행 그대로 옮겨, 행마다 비로그인(anon)·다른 사용자(other)·소유자(owner) 칸을 각각 새 앱에서 실행한다. 거절 칸은 상태 코드와 `{code, message}` 형식까지, 대표 성공 칸은 본문까지 확인한다.
- 쓰기(78 = 25행): 방송 등록·수정(READY·ENDED)·삭제(READY·LIVE), publish 토큰(READY·LIVE·ENDED), 송출 인가, 종료(READY·LIVE·ENDED), 댓글 작성(일반·종료된 방송)·수정·삭제, 후원 주문(LIVE·READY·ENDED)·승인 확인, 웹훅, 로그인·로그아웃·가입, 내부 훅. 댓글 수정·삭제와 승인 확인은 "방송자" 칸을 더해 4칸.
- 공개 조회(36 = 12종 × 3): 방송 목록·채널별 목록·상세, 채널 정보, 댓글 목록, 후원 내역·합계, 후원 설정, 다시보기 목록, 녹화 목록, 시청(read) 인가 LIVE / READY·ENDED, `/auth/me`.
- 삭제된 방송(33 = 11종 × 3): 상세·수정·삭제·토큰·종료·SSE·댓글 목록·댓글 작성·후원 주문·후원 내역·녹화 목록이 모두 404.
- 독립(4): 거절된 수정·삭제·종료는 방송을 바꾸지 않는다 / 남의 채널을 지정해 등록할 수 없다 / 다른 방송의 토큰으로 송출 불가 / 위조·로그아웃한 쿠키는 비로그인과 같다(401).

#### `broadcasts.test.ts` (21)
- 등록(6): 로그인 사용자는 본인 채널에 READY로 등록 / 비로그인 401 / 잘못된 입력 400 ×4(빈 본문, 공백 제목, 제목 길이 초과, 설명 길이 초과).
- 조회(4): 비로그인 상세 / 없는 방송 404·숫자 아닌 ID 400 / 목록 최신순·상태·채널 필터·커서 / 잘못된 목록 조건 400(한국어).
- 수정(3): 소유자 수정, 보내지 않은 항목 유지 / 방송 중 제목 변경 / 401·403·404·빈 변경 400.
- 삭제(3): 소유자 삭제 204 후 상세·목록·수정에서 사라짐 / LIVE 409, 종료된 방송은 삭제 가능 / 401·403.
- 그 밖(5): 검증 순서 401→400→404→403 / 채널 정보 공개·없는 채널 404 / 시청자 수 = 방송 중 SSE 연결 수(방송자 제외) / 방송자 본인 연결은 빼고 다른 로그인 사용자는 셈(목록·viewers 이벤트) / 서버 재시작 후 방송 정보 유지(파일 DB).

#### `comments.test.ts` (22)
- 작성(10): 작성자 닉네임·방송자 여부 포함 / 비로그인 401 / 잘못된 입력 400 ×3 / 300자 허용 / 없는·삭제된 방송 404 / 종료된 방송에도 작성 / 사용자당 10초 10회(다른 사용자 무관) / 작성·수정·삭제 합산 제한.
- 목록(4): 비로그인 조회, 최신 N개를 오래된 순으로, 커서로 이전 댓글 / 다른 방송과 섞이지 않음 / 삭제된 댓글은 자리만 / 404·400.
- 수정(4): 작성자 수정·`editedAt` / 같은 내용이면 변화 없음 / 401·403(방송자라도) / 빈 내용 400, 없는·삭제된 댓글·삭제된 방송 404.
- 삭제(3): 작성자 삭제(본문 숨김) / 401·403(방송자라도) / 이미 삭제 404.
- SSE(1): 작성·수정·삭제가 `comment` 이벤트로 전파.

#### `donations.test.ts` (52)
가짜 토스(§5)로 실제 승인 흐름을 재현한다.
- 설정(4): 클라이언트 키·금액 규칙만 공개(시크릿 키 없음) / 키 없으면 꺼짐·주문·승인 503 / 키 한쪽만·운영에서 가짜 결제·키와 가짜 결제 동시 → 기동 거부 / 결제창형 테스트 키만 허용.
- 주문 생성(10): LIVE 방송에 PENDING 주문 / 401·본인 방송 403·404 / LIVE 아니면 409 / 금액 규칙 400 ×5(999, 1,001,000, 1,500, 문자열, 소수) / 사용자당 분당 10건 초과 429 / 경계값 허용·메시지 100자 초과 400.
- 승인(26):
  - 정상 적립·합계 반영 / 재요청 1번 적립·같은 결과 / 동시 요청(처리 중 409 → PENDING 안내) / 타이밍 무관 동시 요청 적립 1번·실패 없음.
  - 금액 대조: 결제창에서 돌아온 금액이 다르면 토스에 요청하지 않음 / 토스 응답의 금액·orderId·paymentKey·통화 불일치 ×4는 적립 안 함 / 상태가 DONE이 아니면 PENDING.
  - 결과 미정(#29): 시간 초과 뒤 조회 IN_PROGRESS + 새 키 ALREADY_PROCESSED → 실패로 만들지 않음 / 새 키 거절돼도 미정이면 FAILED 확정 안 함 / 거절 후 조회로 승인 확인되면 적립 / 다른 경로(웹훅)가 먼저 적립했으면 거절로 덮지 않음.
  - 거절: 토스 거절 400 + 사유·FAILED / 모르는 코드는 원문 숨김 / 키 설정 오류는 PENDING.
  - 일시 오류 ×4(429, 500, PROVIDER_ERROR, 토스 도달 전 네트워크): PENDING 유지, 다시 확인하면 새 멱등키로 승인해 적립.
  - 응답 유실: 조회로 승인 확인해 1번 적립 / 조회도 실패하면 PENDING, 재요청은 ALREADY_PROCESSED → 조회 → 1번 적립.
  - 결제 도중 방송 종료돼도 확정 / 401·403·404·400 / 완료된 주문에 다른 결제 키 409.
- 웹훅(7): 본문을 믿지 않고 조회로 확인 / confirm 없이 웹훅만으로 적립, 반복·confirm과 겹쳐도 1번 / 남의 주문·금액 다른 결제는 무시 / 조회 일시 오류는 503(재전송 유도) / FAILED 주문도 승인 확인되면 적립 / 다른 이벤트 무시.
- 내역·합계(4): 공개·최신순·커서·전체 원장 합계 / 방송별 분리 / 원장 주문당 1건은 DB 유니크가 단독으로도 막음 / 빈 목록 0원·없는 방송 404.
- SSE(1): 적립 시 `donation` 이벤트(닉네임·금액·메시지·새 합계), 중복 통지는 다시 보내지 않음.

#### `error-format.test.ts` (37)
- Fastify 본문·URL 오류(7): 404 NOT_FOUND / 400 INVALID_JSON(빈 본문 포함) / 객체 아닌 JSON 400 / 415 / 1MB 초과 413 / 깨진 퍼센트 인코딩 400 BAD_URL / 100자 초과 경로 파라미터 414.
- 검증 오류(26): 필드 타입 오류도 한국어 / 매우 긴 문자열 400 / 경로 ID 8종 400 / 15자리 ID는 404 / 목록 쿼리 6종 400 / 후원 금액 8종 400 / JSON `1e400`(Infinity) 400.
- 인증·권한·상태·제한(2): 401·403·409 형식 / 429(로그인 제한, 댓글 도배).
- 500(2): 처리 못 한 예외는 일반 문구(SQLITE_* 숨김) / 노출 지정 없는 AppError 5xx 문구 숨김.

#### `health.test.ts` (3)
DB 정상이면 200 ok / 없는 경로 404 형식 / 로그에서 `secret`·`token` 쿼리 값을 가림.

#### `internal-media.test.ts` (29)
- 내부 호출 보호(2): 시크릿 없음·틀림 401 / 형식 틀린 훅 400, `/api` 아래 미노출.
- 토큰 발급(2): 소유자에게 토큰·WHIP 경로 / 401·403·종료 409·삭제 404.
- MediaMTX 인가(4): publish는 이 방송 유효 토큰만(Bearer·`?token=`) / 다른 방송·만료 토큰 거절 / 종료된 방송은 유효 토큰도 403 / read는 LIVE일 때만 누구나.
- 상태 머신(9): online → LIVE / 대체 송출 시 이전 offline 무시 / 유예 안 재송출은 LIVE 유지 / 45초 지나면 ENDED(종료 시각 = 끊긴 시각) / 확정 직전 실제 송출 중이면 유지 / offline 확인 중 재송출 online 우선 / 끊긴 뒤 늦은 online(실제 송출 없음) 무시 / online 유실 + offline → 유예 후 종료 / 조회 실패 시 offline을 끊김으로.
- 방송 종료(5): 소유자 종료 → ENDED + 송출 강제 종료(kick) / 401·403·409 / MediaMTX 무응답이어도 확정, 주기 대조가 끊음 / 종료 후 늦은 online은 끊음 / READY에서도 종료.
- 주기 대조(2): LIVE인데 송출 없음 → 끊김, READY인데 송출 중 → LIVE / MediaMTX 무응답이면 변경 없음.
- SSE(4): 현재 상태·상태·제목·시청자 수 실시간 / 삭제 시 서버가 연결 종료 / IP당 20개 초과 429 / 없는 방송 404.
- 토큰 서명(1): 서명 변조·다른 키 토큰 거절.

#### `recordings-scan.test.ts` (12)
- mp4 길이 계산(4): faststart mp4는 mvhd / fragmented mp4는 tfdt + 샘플 길이(긴 트랙) / mvhd v1(64비트, `2**32+500`으로 상위 워드까지 확인) / mp4 아님·잘린 파일 null.
- 복구 스캔(8): 훅 유실 세그먼트 등록·중복 없음 / 이미 등록된 파일 건너뜀 / 녹화 중·변환 중·임시·mp4 아님·이름 형식 다름 건너뜀 / 오래된 임시 파일(변환 죽음)이면 원본 등록 / 변환 대기 중(빈 임시 파일)은 등록 안 함 / 스캔이 원본을 먼저 등록했어도 훅이 크기·길이를 고치고 `recording` 재전송(#31) / 없는 방송·형식 다른 디렉터리 제외 / 녹화 디렉터리 없으면 아무것도 안 함.

#### `recordings.test.ts` (32)
- 등록·다시보기(21): 훅 도착 순서와 무관하게 시작 시각 순 / 종료된 방송에도 등록 / 같은 파일 반복 훅은 1번 / 잘못된 경로·입력 거절 400 ×8(디렉터리 밖, `..` 탈출, 중간 `..`, 다른 방송, path 형식, mp4 아님, segmentPath 없음, 길이 형식) / 시크릿 없음 401 / 없는 방송 204(재시도 방지) / 녹화 목록 공개·404 / 다시보기 목록(녹화 있는 종료 방송만, 세그먼트 수·총 길이) / 종료 시각 최신순 / 파일 서빙 인가(등록된 파일만, 삭제·미등록·경로 조작 404) / 경로 형식 가드(DB 행이 있어도 형식 밖이면 거절) / `recording` SSE(중복 훅은 재전송 안 함) / 종료·삭제 뒤 늦은 세그먼트는 기록하되 조회·서빙 차단 / 커서 동률 시 ID 내림차순.
- 영구 저장(1): 재시작 후 녹화 목록·다시보기 목록 유지.
- 경로·메타데이터 해석(10): 상대 경로만 / 길이 문자열 8종(→ ms 또는 null) / 파일 이름에서 시작 시각(시간대 포함).

#### `state-boundaries.test.ts` (10)
- 종료·삭제와 훅의 경합(5): 재송출 online 확인 중 종료 → ENDED 유지·kick / 삭제된 READY 방송에 붙은 송출은 끊고 LIVE 안 됨 / online이 먼저면 삭제 409 / 동시 종료 2회 → 하나만 성공 / 동시 삭제 2회 → 204 하나, 404 하나.
- 유예 시간(2): 유예 중 새 토큰으로 재송출 가능 / 유예 확정 대기 중 재송출 후 다시 끊기면 새 기준으로 다시 셈.
- 삭제된 방송의 후원·녹화(3): 결제창 연 사이 종료·삭제 → 승인 요청 없이 404·FAILED / 이미 승인된 결제는 삭제 후 웹훅으로도 적립 / 삭제 뒤 늦은 세그먼트는 등록하되 노출 안 함.

#### `toss-client.test.ts` (10)
- 토스 API 클라이언트(8, `fetch` 대역): Basic 인증·받은 멱등키 부착 / 성공 응답 형식 오류 ×3(빈 본문, 필드 누락, 금액 문자열)은 일시 오류 / 429·5xx는 일시 오류, 4xx 거절은 아님 / 재시도 안내 4xx ×3(409 IDEMPOTENT_REQUEST_PROCESSING, PROVIDER_ERROR, FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING)은 일시 오류.
- 가짜 토스 멱등키(2): 같은 키는 첫 응답(오류 포함) 재생·처리 중 409·다른 키는 새로 처리 / E2E용 가짜 결제: 같은 키 재요청은 같은 승인, 다른 키로 같은 결제는 ALREADY_PROCESSED_PAYMENT.

### 웹 단위 (`apps/web/src`, 53건)

| 파일 | 건수 | describe (건수) |
|---|---|---|
| `lib/recordings.test.ts` | 4 | 다시보기 구간(3), formatDuration(1) |
| `lib/webrtc/media.test.ts` | 5 | captureScreen(1), captureCamera(4) |
| `lib/webrtc/publisher.test.ts` | 37 | 송출 시작·종료(4), 연결 끊김과 재연결(6), 다른 탭과 송출 경쟁(2), 영상 소스 중단(10), 소스 선택 중 연결 끊김(4), 카메라 복구 루프(9), 소스 중단 뒤 자동 종료 시한(2) |
| `lib/webrtc/whip.test.ts` | 7 | h264Rank(1), preferH264(3), publish(3) |

#### `lib/recordings.test.ts` (4)
다음 구간은 시작 시각 순, 마지막이면 null / 보던 구간은 id로 추적(앞 구간이 늦게 끼어도 유지) / 보던 구간이 사라지면 첫 구간 / `formatDuration` m:ss·h:mm:ss.

#### `lib/webrtc/media.test.ts` (5)
- captureScreen(1): 실제 `captureScreen` 형태에는 카메라 복구 수단(`restartVideo`·`switchFacing`)이 없다 → 공유 중지는 항상 sourceEnded.
- captureCamera(4): 처음부터 끝난 영상 트랙이면 끄고 다시 엶 / 계속 끝난 트랙만 오면 NotReadableError / 트랙이 끝나면 onEnded, `restartVideo`는 같은 방향 카메라로 교체 / `restartVideo`가 끝난 트랙을 받으면 실패하고 기존 스트림 유지.

#### `lib/webrtc/publisher.test.ts` (37)
가짜 타이머로 재연결 대기·끊김 유예(4초)·소스 중단 자동 종료(45초)를 앞당겨 확인한다.
- 송출 시작·종료(4): 소스 선택 → 미리보기 → 시작 → LIVE(새 토큰으로 WHIP, Wake Lock) / 종료 시 서버 종료 요청·연결·장치 끔 / 토큰 받는 사이 종료되면 늦은 연결 폐기 / 화면 이탈(release) 시 처음 상태.
- 연결 끊김과 재연결(6): failed → 서버 상태 확인 후 새 토큰으로 재송출 / 4초 안 회복되는 disconnected는 무시 / 4초 넘으면 끊김 / 서버에 다른 송출이 붙어 있으면 takenOver / 끊긴 사이 종료됐으면 ended·장치 끔 / 5번 모두 실패하면 미리보기로 돌아가 안내.
- 다른 탭과 송출 경쟁(2): 다른 탭이 시작하면 takenOver, 다시 가져오면 상대가 takenOver / 다른 방송 알림 무시.
- 영상 소스 중단(10): 화면 공유 중지 → 송출·마이크 멈춤, 45초 안에 안 고르면 종료 / 유예 안에 다시 고르면 이어서 송출 / 미리보기 중 공유 종료는 idle / 카메라 트랙이 끝나면 다시 열어 같은 연결로 / 첫 프레임 전 끊기면 새 연결로 재송출(오디오만 나가는 스트림 방지) / 6번 못 열면 sourceEnded / 몇 초 장치를 못 찾다가 돌아오면 이어서 / 다시 여는 중 연결 끊김도 복구 / 전환 실패로 영상 트랙이 없어지면 원래 방향 다시 열기 / 다시 여는 사이 종료하면 새 트랙 즉시 끔.
- 소스 선택 중 연결 끊김(4): 공유 창 열린 사이 끊겨도 재연결, 고른 새 소스로 송출 / 창 취소해도 재연결 상태 유지 / 끊김 없으면 트랙만 교체 / 고르는 사이 다른 탭이 송출하면 takenOver, 빼앗지 않음.
- 카메라 복구 루프(9, #30 리뷰 반영): `replaceTrack` 중 다시 끊김 / 재송출 중 또 끊김 / 연결 중(start) 끊김 / 공유 창 중 재송출 후 새 소스 / 재송출 실패는 LIVE 표시 없이 재연결 / 1분 5회 초과면 멈춤 / NotAllowedError는 즉시 sourceEnded / `replaceTrack` 실패는 새 연결로 / 화면 공유 중지는 카메라 복구를 타지 않음.
- 자동 종료 시한(2): 창이 열린 채 시한이 지나고 취소하면 즉시 종료 / 시한 전 취소면 남은 시간만큼 기다렸다 종료.

#### `lib/webrtc/whip.test.ts` (7)
- `h264Rank`(1): Constrained Baseline < Baseline < 기타 < packetization-mode≠1 순.
- `preferH264`(3): H.264만 순위대로, 재전송·오류정정 코덱은 뒤 / 송신 capability 거부 시 수신 capability로 / H.264 없으면 CodecUnsupportedError.
- `publish`(3): Bearer 토큰으로 SDP offer POST, 종료 시 Location에 DELETE / 답에 H.264 없으면 닫고 CodecUnsupportedError / 201이 아니면 WebRtcHttpError.

## 4. E2E 시나리오

공통 판정(`e2e/lib.mjs`):
- 각 단계(`step`)는 독립 실행되고, 하나라도 실패하면 종료 코드 1. `npm run e2e`는 파일별 결과를 모아 하나라도 실패하면 1.
- **재생 판정 `expectMediaFlowing`**(#30): 시청 화면의 RTCPeerConnection을 모아 1초 간격으로 잰다. `videoWidth > 0`, 디코딩 프레임(`framesDecoded`)·화면 출력 프레임(`getVideoPlaybackQuality().totalVideoFrames`)·수신 오디오 RTP 패킷이 **모두 늘어나야** 통과(기본 20초 안). `currentTime`은 멈춘 화면에서도 흐를 수 있어 쓰지 않는다.

| 파일 | 단계 | 흐름 | 성공 판정 |
|---|---|---|---|
| `05-broadcasts.mjs` | 12 | 비로그인 → 로그인 유도(next 유지) / 빈 제목 차단 / 생성 → 상세 "방송 준비" / 비로그인·다른 사용자에게 수정·삭제 없음 / 다른 사용자 API 직접 수정·삭제 / 수정 반영 / 내 채널 / 삭제 → "찾을 수 없음" / 세션 만료 후 삭제 → 로그인 유도 / 잘못된 주소 안내 / 390px 가로 스크롤 없음 | 화면 요소·URL, API 직접 호출 403, `scrollWidth ≤ innerWidth` |
| `06-publish.mjs` | 11 | 방송 생성·비로그인 시청자 대기 / 토큰 없는 WHIP / 카메라 송출 → 시청자 화면 LIVE·재생 / 시청자 수 / LIVE 중 삭제 비활성 / 송출 탭 닫힘 → "재연결 대기" / 유예 안 재송출 → 다시 재생 / 종료 → "방송 종료" / 종료 후 토큰 재발급 409 / 끊긴 채 45초 → 자동 종료 / 다른 탭에서 종료 → 송출 탭 장치 끔 | WHIP 401, 상태 문구 실시간 변화(새로고침 없음), `expectMediaFlowing`, 살아 있는 캡처 트랙 0개 |
| `07-studio.mjs` | 12 | 상세 → 스튜디오 / 다른 사용자 송출 불가 / 화면 공유 선택 → 미리보기·화면 소리·마이크 상태 / 시작 → LIVE·시청 재생·송출 품질 / 마이크 끄기·켜기 / 방송 중 카메라 전환 / 공유 중지 → 안내·시청자 재연결 대기 → 다시 선택 / 다른 탭 송출 → "다른 곳에서 송출 중" → 되가져오기 / MediaMTX Control API로 세션 강제 종료 → "재연결 중" → LIVE / 종료 → 캡처 트랙 0개 / 공유 중지 방치 → 유예 뒤 자동 종료 / 종료된 방송 스튜디오 안내 | `expectMediaFlowing`(영상 + 오디오 RTP), 단계 문구, `docker compose exec mediamtx`로 실제 끊김 유발 |
| `08-mobile.mjs` | 7 | iPhone UA·390px·터치, `getDisplayMedia` 제거 / 가입·방송 생성 / 화면 공유 대신 안내, 카메라로 송출(카메라 열기 실패 시 다시 누르기 1회까지만) / 송출 → PC 시청 / 전면/후면 전환 / 카메라 트랙 강제 종료(`stop` + `ended`) → 새 트랙으로 복구 / 휴대폰 시청: 음소거 시작·소리 켜기·전체 화면 / 휴대폰에서 종료 | PC 쪽 `expectMediaFlowing`, 복구 뒤 새 트랙 id·송신 `framesEncoded` 증가, 두 번째 카메라 실패는 회귀로 실패 처리 |
| `10-comments.mjs` | 15 | 비로그인 안내 / 공백 전송 비활성 / A의 채팅이 B(비로그인)에 실시간 / 작성자에게만 수정·삭제 / C가 API로 수정·삭제 403 / 방송자 표시 / "(수정됨)" / "삭제된 댓글입니다" / 모바일 영상 아래·데스크톱 옆 배치 / SSE 끊긴 동안 50개 초과 쌓여도 빈 구간 없이 이어짐 / 비로그인 → 가입 → 같은 방송에서 채팅 / 세션 만료 후 전송 → 로그인 유도 / 연달아 보내도 입력 유지 / 모든 페이지 `pageerror` 0건 | 화면 텍스트·요소 위치, API 403, 처리되지 않은 오류 없음 |
| `11-donations.mjs` | 14 (가짜 결제 12 / 테스트 키 8) | 공통 5: READY 비활성 안내 / 내부 훅으로 LIVE → 새로고침 없이 활성 / 비로그인 로그인 유도 / 방송자 본인 비활성 / 금액 규칙. 가짜 결제 6: 후원 → 성공 화면 → 합계·내역 / 다른 시청자 실시간 알림 / 성공 주소 재방문 1번 적립 / 금액 위조 거절 / 결제 취소 안내 / 390px 넘침 없음. 테스트 키 2: 실제 토스 결제창이 주문 금액으로 열리고 닫으면 취소 안내 / 인증 없이 만든 결제 키는 실제 승인 API가 거절·주문 실패. 공통 마지막: 종료 후 버튼 꺼짐·내역 유지 | 화면 문구, API로 `total = {amount: 5000, count: 1}`, `alreadyConfirmed: true` |
| `12-recordings.mjs` | 15 | 카메라 송출 / 탭 닫고 유예 안 재송출(세그먼트 2개) / 시청 중 종료 → 다시보기 플레이어로 전환 / 세그먼트 ≥ 2 / 홈 다시보기 목록 / 재생(오디오 포함) / 다음 구간 자동 재생 / Range·faststart / ffprobe h264+aac·임시 파일 없음 / 미등록·경로 조작 404 / api 재시작 후 조회 / 훅 유실 세그먼트 복구 스캔 / Cache-Control은 허용 응답에만 / 녹화 1개 방송의 "준비 중" → 플레이어 / 삭제 후 전부 404 | 재생 시간 증가·오디오 디코드 바이트 > 0, `ffprobe` 코덱, 원문 경로 요청(`https.request`)으로 404·`/etc/passwd` 미노출, 길이 오차 300ms 이내 |
| `13-restart.mjs` | 6 (4 + MediaMTX 재시작 반복 3) | 방송 송출·종료, 댓글·후원(가짜 결제)·녹화 생성 / `docker compose restart api` / `down` → `up -d`(볼륨 유지) / MediaMTX 재시작 0·2·4초 뒤 새 방송 송출 | 재시작 전후 스냅샷(방송·댓글·후원 합계·내역·녹화·다시보기·파일 Range 206·`/auth/me` 200) 동일, LIVE 도달 |
| `14-test-accounts.mjs` | 3 | 로그인 화면 "방송자 A / 시청자 B" / 방송자 A로 바로 로그인 → 원래 화면 / 로그아웃 후 시청자 B | URL·채널 링크 |

## 5. 테스트 대역(fake)

| 대역 | 위치 | 흉내 내는 것 | 증명하지 못하는 것 |
|---|---|---|---|
| 가짜 토스 (`withFakeIdempotency`, 테스트의 `fakeToss`) | `apps/api/src/payments/toss.ts`, `donations.test.ts` | 실제 토스 API로 확인한 멱등키 동작: 같은 키 재요청은 첫 응답(오류 포함)을 그대로 재생, 처리 중이면 409 `IDEMPOTENT_REQUEST_PROCESSING`, 이미 승인된 `paymentKey`를 다른 키로 승인하면 `ALREADY_PROCESSED_PAYMENT`. 테스트용은 거절·429·500·PROVIDER_ERROR·응답 유실·조회 실패·IN_PROGRESS·응답 필드 불일치를 한 번씩 주입 | 키 없이 본문 비교 등 토스의 나머지 규칙, 실제 카드 승인 성공 응답의 세부 필드, 실제 지연·장애 분포 |
| E2E 가짜 결제 (`createFakeTossClient`, `TOSS_FAKE_PAYMENTS=true`) | `apps/api/src/payments/toss.ts` | 결제창 없이 받은 값 그대로 승인(위 멱등 동작 포함). 승인 이후의 서버 검증·멱등 적립·화면 흐름 확인용 | 결제창 인증, 실제 승인. 운영에서는 기동 거부 |
| 승인만 하는 토스 (`approvingToss`) | `authz-matrix.test.ts` | 권한 칸만 보려고 받은 값 그대로 승인 | 승인 세부(그건 `donations.test.ts`) |
| 토스 `fetch` 대역 | `toss-client.test.ts` | HTTP 응답 형식·상태 코드별 분류 | 실제 토스 서버 |
| 가짜 MediaMTX Control (`fakeControl`, `idleMediaControl`) | `internal-media`·`state-boundaries` 등 | 송출 중인 path 목록, 조회 실패(`fail`), 조회 지연(`hold`, 경합 재현), kick 기록 | 실제 MediaMTX 훅 순서·지연, WebRTC 세션. 이는 E2E 06·07·13이 실제 MediaMTX로 확인 |
| 녹화 파일 | `recordings-scan.test.ts` | ISO BMFF 박스를 직접 만든 mp4, 임시 디렉터리, `utimes`로 수정 시각 조작 | 실제 MediaMTX 녹화·ffmpeg 변환(E2E 12가 ffprobe로 확인) |
| 가짜 WebRTC·미디어 (웹) | `publisher.test.ts`, `media.test.ts`, `whip.test.ts` | `FakeTrack`·`FakeMediaStream`·`FakePeerConnection`·`FakeBroadcastChannel`·Wake Lock·`fetch`·`getUserMedia`·`AudioContext`, 가짜 타이머 | 실제 인코딩·네트워크·ICE, 브라우저별 이벤트 순서, 실제 기기 카메라의 동작 |
| Chrome 가짜 장치 | `e2e/lib.mjs` `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--auto-select-desktop-capture-source=Entire screen` | 권한 창 없는 카메라(움직이는 테스트 패턴)·마이크(신호음)·화면 공유 | 실제 시스템 소리 캡처, 전면/후면 카메라 차이, 모바일 브라우저(UA만 iPhone이고 엔진은 Chrome), 다른 기기·NAT·이동통신망. 부하가 크면 가짜 카메라가 `NotFoundError`를 내기도 한다(#30) |

## 6. 테스트로 증명하지 못하는 것 / 수동 확인 항목

| 항목 | 왜 자동화하지 못하나 | 확인 방법 |
|---|---|---|
| 시스템 소리·탭 소리와 마이크가 **실제로 섞여 들리는지** | E2E는 오디오 RTP 패킷이 오는지만 본다. 가짜 장치의 소리가 실제 시스템 소리가 아니다 | #9 실기기: Chrome "탭"·"전체 화면" 공유로 소리를 내고 다른 기기에서 듣기 |
| 실제 휴대폰의 전면/후면 카메라 | 가짜 장치는 방향 구분이 없다. 08은 전환 뒤 송출이 이어지는지만 본다 | #9: iOS Safari·Android Chrome에서 전환 |
| iOS Safari·Android Chrome 송출·시청, Safari 다시보기 | E2E는 Chrome 엔진에 iPhone UA만 씌운다 | #9 |
| 다른 기기·이동통신망에서 시청 (NAT, TCP 8189 전환) | 같은 PC 안의 브라우저 컨텍스트끼리만 확인 | #9 |
| 다른 기기에서 같은 방송을 이어받는 송출(takeover) | 탭 사이 경쟁은 07·단위 테스트가 보지만, 기기 사이는 서버 대체 송출 판정에 의존 | #9: PC 송출 중 휴대폰에서 같은 방송 송출 |
| 실제 카드 승인 성공 | 테스트 결제도 카드사 인증 화면(앱·ISP)을 거쳐 자동화 불가. 결제창이 열리는 것과 실제 승인 API의 거절까지만 확인 | 운영 테스트 키로 사람이 결제(QUESTIONS U2·Q6) |
| 트랙은 live인데 프레임이 멈춘 영상 | Publisher는 트랙 종료(`ended`)만 감지한다. #30 리뷰에서 범위 밖으로 남긴 위험 | 실기기 장시간 송출 중 관찰 |
| 운영 서버 재시작·배포 | 로컬 docker로만 확인(13) | 운영 배포 후(QUESTIONS U0·U1) |

## 변이 테스트 결과

(최종 점검 결과로 채움)
