/** galle LIVE 로고 마크. public/favicon.svg와 같은 그림이다 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path
        d="M12.5 10.3v11.4a1 1 0 0 0 1.53.85l9.1-5.7a1 1 0 0 0 0-1.7l-9.1-5.7a1 1 0 0 0-1.53.85Z"
        fill="#fff"
      />
    </svg>
  )
}
