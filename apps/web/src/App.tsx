import { Link, Route, Routes } from 'react-router'
import { useAuth } from './auth/context'
import { RequireAuth } from './auth/RequireAuth'
import { AuthForm } from './pages/AuthForm'
import { EditBroadcastPage, NewBroadcastPage } from './pages/BroadcastFormPage'
import { BroadcastPage } from './pages/BroadcastPage'
import { ChannelPage } from './pages/ChannelPage'
import { DonationFailPage, DonationSuccessPage } from './pages/DonationResultPage'
import { HomePage } from './pages/HomePage'
import { StudioPage } from './pages/StudioPage'

function Header() {
  const { status, user, logout, refresh } = useAuth()
  return (
    <header className="header">
      <Link to="/" className="brand">
        Live
      </Link>
      <nav className="nav">
        {status === 'authenticated' && user && (
          <>
            <Link to="/broadcasts/new">방송하기</Link>
            <Link to={`/channels/${user.channelId}`}>내 채널</Link>
            <span className="muted">{user.nickname}</span>
            <button type="button" className="link-button" onClick={() => void logout()}>
              로그아웃
            </button>
          </>
        )}
        {status === 'error' && (
          <>
            <span className="error">서버 연결 오류</span>
            <button type="button" className="link-button" onClick={refresh}>
              다시 시도
            </button>
            <Link to="/login">로그인</Link>
          </>
        )}
        {status === 'anonymous' && (
          <>
            <Link to="/login">로그인</Link>
            <Link to="/signup">회원가입</Link>
          </>
        )}
      </nav>
    </header>
  )
}

function NotFound() {
  return (
    <>
      <h1>페이지를 찾을 수 없습니다</h1>
      <Link to="/">홈으로</Link>
    </>
  )
}

export default function App() {
  return (
    <>
      <Header />
      <main className="container">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<AuthForm key="login" mode="login" />} />
          <Route path="/signup" element={<AuthForm key="signup" mode="signup" />} />
          <Route
            path="/broadcasts/new"
            element={
              <RequireAuth>
                <NewBroadcastPage />
              </RequireAuth>
            }
          />
          <Route path="/broadcasts/:id" element={<BroadcastPage />} />
          <Route
            path="/broadcasts/:id/edit"
            element={
              <RequireAuth>
                <EditBroadcastPage />
              </RequireAuth>
            }
          />
          <Route
            path="/broadcasts/:id/studio"
            element={
              <RequireAuth>
                <StudioPage />
              </RequireAuth>
            }
          />
          {/* 토스 결제창이 돌아오는 주소 (#11) */}
          <Route
            path="/broadcasts/:id/donation/success"
            element={
              <RequireAuth>
                <DonationSuccessPage />
              </RequireAuth>
            }
          />
          <Route path="/broadcasts/:id/donation/fail" element={<DonationFailPage />} />
          <Route path="/channels/:channelId" element={<ChannelPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  )
}
