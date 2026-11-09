# 빌드 컨텍스트: 저장소 루트
# 1단계: React 빌드
FROM node:22-bookworm-slim AS web-build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @live/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build -w @live/web

# 2단계: Caddy + 정적 파일
FROM caddy:2.10-alpine
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /repo/apps/web/dist /srv
