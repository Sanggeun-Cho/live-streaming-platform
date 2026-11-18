import { ExternalLink } from 'lucide-react'
import { Link } from 'react-router'
import { ThemeSwitcher } from '../theme/ThemeSwitcher'
import { BrandMark } from './BrandMark'

const REPO_URL = 'https://github.com/Sanggeun-Cho/live-streaming-platform'

const COLUMNS = [
  {
    title: '서비스',
    links: [
      { to: '/lives', label: '라이브' },
      { to: '/replays', label: '다시보기' },
      { to: '/broadcasts/new', label: '방송하기' },
    ],
  },
  {
    title: '고객지원',
    links: [
      { to: '/help', label: '고객센터' },
      { href: `${REPO_URL}/issues`, label: '문의하기' },
    ],
  },
  {
    title: '정책',
    links: [
      { to: '/terms', label: '이용약관' },
      { to: '/privacy', label: '개인정보처리방침', strong: true },
      { to: '/licenses', label: '오픈소스 라이선스' },
    ],
  },
] as const

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link to="/" className="brand footer-logo" aria-label="galle LIVE 홈">
            <BrandMark className="brand-mark" />
            galle<span className="brand-live">LIVE</span>
          </Link>
          <p>설치 없이 브라우저에서 보고, 방송하는 실시간 라이브 서비스</p>
        </div>

        <nav className="footer-columns" aria-label="사이트 정보">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h2 className="footer-heading">{col.title}</h2>
              <ul>
                {col.links.map((link) => (
                  <li key={link.label}>
                    {'href' in link ? (
                      <a href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                        <ExternalLink size={13} aria-hidden="true" />
                        <span className="sr-only">(새 창)</span>
                      </a>
                    ) : (
                      <Link to={link.to} className={'strong' in link ? 'footer-strong' : undefined}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="footer-bottom">
        <div className="footer-notice">
          <p>
            galle LIVE는 개인이 학습과 공모전 출품을 위해 운영하는 비영리 서비스입니다. 후원은 토스페이먼츠 테스트
            결제로 처리되어 실제로 청구되지 않습니다.
          </p>
          <p>© 2026 galle LIVE</p>
        </div>
        <ThemeSwitcher className="footer-theme" />
      </div>
    </footer>
  )
}
