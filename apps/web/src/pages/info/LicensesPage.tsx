import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { ExternalAnchor, InfoLayout } from './InfoLayout'

type License = { name: string; url: string; license: string; usage: string }

const LICENSES: License[] = [
  { name: 'MediaMTX', url: 'https://github.com/bluenviron/mediamtx', license: 'MIT', usage: 'WebRTC 미디어 서버, 녹화' },
  { name: 'Caddy', url: 'https://github.com/caddyserver/caddy', license: 'Apache-2.0', usage: '리버스 프록시, HTTPS' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org/', license: 'LGPL / GPL', usage: '녹화 오디오 변환' },
  { name: 'Fastify', url: 'https://fastify.dev/', license: 'MIT', usage: 'API 서버' },
  { name: 'Drizzle ORM', url: 'https://orm.drizzle.team/', license: 'MIT', usage: 'API 서버 (데이터베이스 접근)' },
  { name: 'zod', url: 'https://zod.dev/', license: 'MIT', usage: 'API 서버 (입력 검증)' },
  { name: 'better-sqlite3', url: 'https://github.com/WiseLibs/better-sqlite3', license: 'MIT', usage: 'API 서버 (SQLite)' },
  { name: '@node-rs/argon2', url: 'https://github.com/napi-rs/node-rs', license: 'MIT', usage: 'API 서버 (비밀번호 해시)' },
  { name: 'React', url: 'https://react.dev/', license: 'MIT', usage: '웹 화면' },
  { name: 'React Router', url: 'https://reactrouter.com/', license: 'MIT', usage: '웹 화면 (라우팅)' },
  { name: 'Vite', url: 'https://vite.dev/', license: 'MIT', usage: '웹 빌드' },
  { name: 'Pretendard', url: 'https://github.com/orioncactus/pretendard', license: 'OFL-1.1', usage: '글꼴' },
  { name: 'Lucide', url: 'https://lucide.dev/', license: 'ISC', usage: '아이콘' },
  {
    name: '토스페이먼츠 결제위젯 SDK v2',
    url: 'https://docs.tosspayments.com/',
    license: '토스페이먼츠 이용약관',
    usage: '후원 테스트 결제',
  },
  { name: 'Vitest', url: 'https://vitest.dev/', license: 'MIT', usage: '테스트' },
  { name: 'Playwright', url: 'https://playwright.dev/', license: 'Apache-2.0', usage: 'E2E 테스트' },
]

export function LicensesPage() {
  useDocumentTitle('오픈소스 라이선스')

  return (
    <InfoLayout title="오픈소스 라이선스">
      <p className="info-lead">
        galle LIVE는 아래 오픈소스 소프트웨어와 외부 SDK를 사용해 만들었습니다. 각 소프트웨어의
        라이선스 전문은 이름을 눌러 해당 프로젝트에서 확인할 수 있습니다.
      </p>

      <div className="info-table-wrap" role="region" aria-label="사용한 오픈소스 목록" tabIndex={0}>
        <table className="info-table">
          <thead>
            <tr>
              <th scope="col">이름</th>
              <th scope="col">라이선스</th>
              <th scope="col">사용처</th>
            </tr>
          </thead>
          <tbody>
            {LICENSES.map((item) => (
              <tr key={item.name}>
                <th scope="row">
                  <ExternalAnchor href={item.url}>{item.name}</ExternalAnchor>
                </th>
                <td>{item.license}</td>
                <td>{item.usage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section aria-labelledby="licenses-whip">
        <h2 id="licenses-whip">직접 구현한 부분</h2>
        <p>
          브라우저에서 방송을 송출하고 재생하는 WHIP·WHEP 클라이언트는 외부 라이브러리 없이 RFC
          9725(WHIP)와 draft-ietf-wish-whep(WHEP) 명세를 참고해 직접 구현했습니다.
        </p>
      </section>
    </InfoLayout>
  )
}
