import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { NavLink } from 'react-router'
import './info.css'

export const EFFECTIVE_DATE = '2026년 11월 19일'
export const ISSUES_URL = 'https://github.com/Sanggeun-Cho/live-streaming-platform/issues'

const LINKS = [
  { to: '/help', label: '고객센터' },
  { to: '/terms', label: '이용약관' },
  { to: '/privacy', label: '개인정보처리방침' },
  { to: '/licenses', label: '오픈소스 라이선스' },
]

type InfoLayoutProps = {
  title: string
  /** 시행일 등 기준 날짜. 있으면 제목 아래에 표시한다 */
  updated?: string
  children: ReactNode
}

export function InfoLayout({ title, updated, children }: InfoLayoutProps) {
  return (
    <article className="info-page">
      <nav className="info-nav" aria-label="안내 페이지">
        <ul className="info-nav-list">
          {LINKS.map((link) => (
            <li key={link.to}>
              <NavLink to={link.to} className="info-nav-link">
                {link.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="info-main">
        <header className="info-head">
          <h1 className="info-title">{title}</h1>
          {updated && <p className="info-updated">시행일 {updated}</p>}
        </header>
        <div className="info-body">{children}</div>
      </div>
    </article>
  )
}

/** 새 탭으로 여는 외부 링크 */
export function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="info-ext" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink className="info-ext-icon" size={14} aria-hidden="true" />
      <span className="info-sr">(새 탭에서 열림)</span>
    </a>
  )
}
