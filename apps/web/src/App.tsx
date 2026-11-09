import { Link, Route, Routes } from 'react-router'
import { useAuth } from './auth/context'
import { AuthForm } from './pages/AuthForm'
import { HomePage } from './pages/HomePage'

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
            <span>{user.nickname}</span>
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
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  )
}
