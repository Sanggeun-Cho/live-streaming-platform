import { Link, Route, Routes, useParams } from 'react-router'
import { useAuth } from './auth/context'
import { RequireAuth } from './auth/RequireAuth'
import { Avatar } from './components/Avatar'
import { LiveSidebar } from './components/LiveSidebar'
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
      <Link to="/" className="brand" aria-label="galle LIVE 홈">
        <span className="brand-mark" aria-hidden="true">
          ▶
        </span>
        galle<span className="brand-live">LIVE</span>
      </Link>
      <nav className="nav">
        {/* 비로그인도 보인다: 누르면 로그인 후 새 방송 화면으로 돌아온다 */}
        <Link to="/broadcasts/new" className="button primary nav-cta">
          ● 방송하기
        </Link>
        {status === 'authenticated' && user && (
          <>
            <Link to={`/channels/${user.channelId}`} className="nav-user" title="내 채널" aria-label={`${user.nickname} 내 채널`}>
              <Avatar id={user.id} name={user.nickname} size={30} />
              <span className="nav-nickname">{user.nickname}</span>
            </Link>
            <button type="button" className="nav-logout" onClick={() => void logout()}>
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
            <Link to="/login" className="button">
              로그인
            </Link>
            <Link to="/signup" className="button nav-signup">
              회원가입
            </Link>
          </>
        )}
      </nav>
    </header>
  )
}

/** 다른 방송으로 이동하면(사이드바 등) 채팅 입력·후원·플레이어 상태를 새로 시작한다 */
function BroadcastRoute() {
  const { id } = useParams()
  return <BroadcastPage key={id} />
}

function NotFound() {
  return (
    <section className="center-card">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p className="dim">주소가 바뀌었거나 삭제된 페이지입니다.</p>
      <Link to="/" className="button primary">
        홈으로
      </Link>
    </section>
  )
}

export default function App() {
  return (
    <>
      <Header />
      <div className="shell">
        <LiveSidebar />
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
            <Route path="/broadcasts/:id" element={<BroadcastRoute />} />
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
      </div>
    </>
  )
}
