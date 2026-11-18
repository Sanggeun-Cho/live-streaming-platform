import { LogOut, MapPinOff, Video, WifiOff } from 'lucide-react'
import { Link, Route, Routes, useParams } from 'react-router'
import { useAuth } from './auth/context'
import { RequireAuth } from './auth/RequireAuth'
import { Avatar } from './components/Avatar'
import { BrandMark } from './components/BrandMark'
import { EmptyState } from './components/EmptyState'
import { LiveSidebar } from './components/LiveSidebar'
import { useDocumentTitle } from './hooks/useDocumentTitle'
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
        <BrandMark className="brand-mark" />
        galle<span className="brand-live">LIVE</span>
      </Link>
      <nav className="nav" aria-label="계정">
        {/* 비로그인도 보인다: 누르면 로그인 후 새 방송 화면으로 돌아온다 */}
        <Link to="/broadcasts/new" className="button nav-cta" aria-label="방송하기" title="방송하기">
          <Video size={18} aria-hidden="true" />
          <span className="nav-label">방송하기</span>
          <span className="nav-label-short" aria-hidden="true">
            방송
          </span>
        </Link>
        {status === 'authenticated' && user && (
          <>
            <Link to={`/channels/${user.channelId}`} className="nav-user" title="내 채널" aria-label={`${user.nickname} 내 채널`}>
              <Avatar id={user.id} name={user.nickname} size={30} />
              <span className="nav-nickname">{user.nickname}</span>
            </Link>
            <button
              type="button"
              className="ghost icon-only nav-logout"
              aria-label="로그아웃"
              title="로그아웃"
              onClick={() => void logout()}
            >
              <LogOut size={18} aria-hidden="true" />
              <span className="nav-label">로그아웃</span>
            </button>
          </>
        )}
        {status === 'error' && (
          <>
            <span className="nav-error" role="status">
              <WifiOff size={16} aria-hidden="true" />
              <span className="nav-label">서버 연결 오류</span>
            </span>
            <button type="button" className="ghost" onClick={refresh}>
              다시 시도
            </button>
          </>
        )}
        {(status === 'anonymous' || status === 'error') && (
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
  useDocumentTitle('페이지를 찾을 수 없습니다')
  return (
    <EmptyState
      icon={MapPinOff}
      as="h1"
      title="페이지를 찾을 수 없습니다"
      description="주소가 바뀌었거나 삭제된 페이지입니다. 홈에서 지금 방송 중인 채널을 찾아보세요."
      action={
        <Link to="/" className="button primary">
          홈으로
        </Link>
      }
    />
  )
}

export default function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        본문으로 건너뛰기
      </a>
      <Header />
      <div className="shell">
        <LiveSidebar />
        <main className="container" id="main" tabIndex={-1}>
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
