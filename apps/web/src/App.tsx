import { MapPinOff } from 'lucide-react'
import { Link, Route, Routes, matchPath, useLocation, useParams } from 'react-router'
import { RequireAuth } from './auth/RequireAuth'
import { EmptyState } from './components/EmptyState'
import { LiveSidebar } from './components/LiveSidebar'
import { SiteFooter } from './components/SiteFooter'
import { SiteHeader } from './components/SiteHeader'
import { TabBar } from './components/TabBar'
import { useDocumentTitle } from './hooks/useDocumentTitle'
import { AuthForm } from './pages/AuthForm'
import { EditBroadcastPage, NewBroadcastPage } from './pages/BroadcastFormPage'
import { BroadcastPage } from './pages/BroadcastPage'
import { LivePage, ReplaysPage } from './pages/BrowsePage'
import { ChannelPage } from './pages/ChannelPage'
import { DonationFailPage, DonationSuccessPage } from './pages/DonationResultPage'
import { HomePage } from './pages/HomePage'
import { HelpPage } from './pages/info/HelpPage'
import { LicensesPage } from './pages/info/LicensesPage'
import { PrivacyPage } from './pages/info/PrivacyPage'
import { TermsPage } from './pages/info/TermsPage'
import { StudioPage } from './pages/StudioPage'

// 영상이 화면을 채우는 곳(시청·스튜디오)과 입력에 집중하는 곳에서는 푸터·하단 탭을 숨긴다
const IMMERSIVE = ['/broadcasts/:id', '/broadcasts/:id/studio']
const FOCUSED = [...IMMERSIVE, '/broadcasts/new', '/broadcasts/:id/edit', '/broadcasts/:id/donation/*']

function useLayoutMode() {
  const { pathname } = useLocation()
  const matches = (patterns: string[]) => patterns.some((pattern) => matchPath(pattern, pathname))
  return { immersive: matches(IMMERSIVE), focused: matches(FOCUSED) }
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
  const { immersive, focused } = useLayoutMode()
  return (
    <>
      <a href="#main" className="skip-link">
        본문으로 건너뛰기
      </a>
      <SiteHeader />
      <div className={`shell${focused ? '' : ' has-tab-bar'}`}>
        <LiveSidebar />
        <div className="shell-main">
          <main className="container" id="main" tabIndex={-1}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/lives" element={<LivePage />} />
              <Route path="/replays" element={<ReplaysPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/licenses" element={<LicensesPage />} />
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
          {!immersive && <SiteFooter />}
        </div>
      </div>
      {!focused && <TabBar />}
    </>
  )
}
