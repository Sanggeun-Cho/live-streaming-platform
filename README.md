# live-streaming-platform

PC 화면 공유와 모바일 카메라로 라이브 방송을 송출하고, 로그인 없이 시청할 수 있는 웹 서비스입니다.

> 🚧 개발 중입니다. 제출 전에 아래 항목을 모두 채웁니다.

## 서비스 주소
TBD

## 테스트 계정
TBD

## 실행 방법

### Docker로 전체 실행 (권장)
요구 사항: Docker (Compose v2)

```bash
cp .env.example .env      # INTERNAL_SECRET 값을 바꾼다
docker compose up -d --build
```
- https://localhost 접속 (로컬 인증서 경고는 무시하고 진행)
- API 상태 확인: https://localhost/api/health

### 개발 모드
요구 사항: Node.js 22 이상

```bash
npm install
npm run dev:api   # http://localhost:3000
npm run dev:web   # http://localhost:5173 (/api는 3000으로 프록시)
npm test
```

### 구성
| 디렉터리 | 내용 |
|---|---|
| `apps/api` | Fastify + TypeScript + SQLite(Drizzle) |
| `apps/web` | React + Vite + TypeScript |
| `infra/caddy` | 리버스 프록시·HTTPS, 프론트 정적 파일 서빙 |
| `infra/mediamtx` | WebRTC 미디어 서버 설정 (WHIP/WHEP) |
| `compose.yaml` | 로컬과 운영에서 동일하게 쓰는 구성 |

## 기능 확인
TBD

## 설계
- [docs/DESIGN.md](docs/DESIGN.md): 아키텍처, 상태 머신, 권한 매트릭스
- [docs/INFRA_SETUP.md](docs/INFRA_SETUP.md): 운영 서버 세팅 절차
