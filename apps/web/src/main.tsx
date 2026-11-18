import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { FeedbackProvider } from './feedback/FeedbackProvider.tsx'

// 데이터 라우터를 써야 방송 중 화면 이동을 막는 useBlocker를 쓸 수 있다. 실제 경로는 App 안의 <Routes>가 정한다
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <FeedbackProvider>
          <App />
        </FeedbackProvider>
      </AuthProvider>
    ),
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
