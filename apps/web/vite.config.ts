import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 개발 서버에서는 /api 요청을 로컬 api(3000)로 프록시한다.
// 배포 환경에서는 Caddy가 같은 출처에서 정적 파일과 /api를 함께 서빙한다.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // spike.html: #2 WebRTC 검증 화면 (#7에서 운영 화면으로 대체 후 삭제)
      input: { main: resolve(import.meta.dirname, 'index.html'), spike: resolve(import.meta.dirname, 'spike.html') },
    },
  },
  server: {
    host: true,
    // 여러 작업 트리를 동시에 띄울 때 api 포트를 바꿀 수 있게 한다 (기본 3000)
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
    },
  },
})
