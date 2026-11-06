# 빌드 컨텍스트: 저장소 루트
# better-sqlite3는 네이티브 모듈이라 사전 빌드 바이너리가 없으면 소스 컴파일한다.
# 컴파일 도구는 설치 단계에만 두고, 실행 이미지에는 결과물만 복사한다.

# 1단계: 운영 의존성 설치 (네이티브 모듈 컴파일 포함)
FROM node:22-bookworm-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @live/api --include-workspace-root=false --omit=dev

# 2단계: TypeScript 빌드 (개발 의존성 포함)
FROM prod-deps AS build
RUN npm ci -w @live/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w @live/api

# 3단계: 실행 이미지
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules node_modules
COPY package.json ./
COPY apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
RUN mkdir -p /data && chown node:node /data
WORKDIR /repo/apps/api
USER node
ENV DATABASE_PATH=/data/app.db
EXPOSE 3000
# 1GB VM 기준으로 힙 상한을 둔다
CMD ["node", "--max-old-space-size=192", "dist/index.js"]
