import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 개발 서버에서는 /api 요청을 로컬 api(3000)로 프록시한다.
// 배포 환경에서는 Caddy가 같은 출처에서 정적 파일과 /api를 함께 서빙한다.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
