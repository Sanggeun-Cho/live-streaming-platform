import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { EFFECTIVE_DATE, ExternalAnchor, InfoLayout, ISSUES_URL } from './InfoLayout'

export function PrivacyPage() {
  useDocumentTitle('개인정보처리방침')

  return (
    <InfoLayout title="개인정보처리방침" updated={EFFECTIVE_DATE}>
      <p className="info-lead">
        galle LIVE(이하 &ldquo;서비스&rdquo;)는 개인이 학습과 공모전 목적으로 운영하는 비영리
        서비스입니다. 서비스는 운영에 꼭 필요한 정보만 수집하며, 이 방침에서 어떤 정보를 왜
        저장하고 언제 지우는지 설명합니다.
      </p>

      <section aria-labelledby="privacy-1">
        <h2 id="privacy-1">1. 수집하는 항목과 목적, 보관 기간</h2>
        <div className="info-table-wrap" role="region" aria-labelledby="privacy-1" tabIndex={0}>
          <table className="info-table">
            <thead>
              <tr>
                <th scope="col">구분</th>
                <th scope="col">수집 항목</th>
                <th scope="col">목적</th>
                <th scope="col">보관 기간</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">회원가입</th>
                <td>이메일, 닉네임, 비밀번호</td>
                <td>로그인, 회원 식별, 방송·채팅에 닉네임 표시</td>
                <td>탈퇴 요청 시까지</td>
              </tr>
              <tr>
                <th scope="row">방송</th>
                <td>제목, 설명, 시작·종료 시각, 썸네일 이미지</td>
                <td>방송 목록과 방송 화면 제공</td>
                <td>탈퇴 요청 시까지 (방송 삭제 시 화면에서 숨김)</td>
              </tr>
              <tr>
                <th scope="row">녹화</th>
                <td>방송 녹화 영상</td>
                <td>다시보기 제공</td>
                <td>탈퇴 요청 시까지 (방송 삭제 시 재생 불가)</td>
              </tr>
              <tr>
                <th scope="row">채팅</th>
                <td>채팅 내용, 작성 시각</td>
                <td>실시간 채팅 제공</td>
                <td>탈퇴 요청 시까지</td>
              </tr>
              <tr>
                <th scope="row">후원</th>
                <td>금액, 후원 메시지, 결제 키, 주문번호</td>
                <td>후원 결제 확인, 후원 메시지 표시</td>
                <td>탈퇴 요청 시까지</td>
              </tr>
              <tr>
                <th scope="row">로그인 유지</th>
                <td>세션 쿠키</td>
                <td>로그인 상태 유지</td>
                <td>30일 (사용할 때마다 연장), 로그아웃 시 삭제</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>
            비밀번호는 원문을 저장하지 않고 argon2 방식의 단방향 해시로만 저장합니다. 운영자도
            비밀번호 원문을 알 수 없습니다.
          </li>
          <li>
            세션 쿠키는 HttpOnly로 설정되어 브라우저의 스크립트에서 읽을 수 없습니다. 30일 동안
            유지되며, 서비스를 이용하면 기간이 다시 연장됩니다.
          </li>
          <li>
            화면 테마(라이트·다크) 설정은 이용자 브라우저의 localStorage에만 저장되며 서버로
            전송되지 않습니다.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-2">
        <h2 id="privacy-2">2. 결제 정보</h2>
        <p>
          후원 결제는 토스페이먼츠의 테스트 환경에서 처리되며 실제 대금은 청구되지 않습니다. 카드
          번호 등 결제 수단 정보는 토스페이먼츠 결제창에서 입력되며, 서비스는 이를 전달받거나
          저장하지 않습니다. 서비스가 저장하는 결제 관련 정보는 위 표의 후원 항목(금액, 메시지,
          결제 키, 주문번호)뿐입니다.
        </p>
      </section>

      <section aria-labelledby="privacy-3">
        <h2 id="privacy-3">3. 개인정보 처리 위탁</h2>
        <div className="info-table-wrap" role="region" aria-labelledby="privacy-3" tabIndex={0}>
          <table className="info-table">
            <thead>
              <tr>
                <th scope="col">수탁자</th>
                <th scope="col">위탁 업무</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>토스페이먼츠</td>
                <td>후원 결제 처리 (테스트 환경)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="privacy-4">
        <h2 id="privacy-4">4. 제3자 제공</h2>
        <p>서비스는 이용자의 개인정보를 제3자에게 제공하지 않습니다.</p>
      </section>

      <section aria-labelledby="privacy-5">
        <h2 id="privacy-5">5. 파기</h2>
        <ul>
          <li>회원이 탈퇴를 요청하면 해당 회원의 개인정보를 지체 없이 파기합니다.</li>
          <li>
            회원이 방송을 삭제하면 그 방송은 서비스 화면에서 숨겨지고 녹화 영상도 더 이상 재생할
            수 없게 됩니다. 다만 방송 기록 자체는 즉시 지우지 않고 데이터베이스에 남겨 두며(소프트
            삭제), 탈퇴 요청 시 함께 파기합니다.
          </li>
          <li>
            서비스 운영이 끝나거나 데이터를 초기화하는 경우 저장된 정보는 모두 파기됩니다.
          </li>
        </ul>
      </section>

      <section aria-labelledby="privacy-6">
        <h2 id="privacy-6">6. 이용자의 권리</h2>
        <p>
          이용자는 언제든지 본인의 개인정보 열람, 정정, 삭제와 처리 정지를 요청할 수 있습니다.
          요청은 <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>로 해 주시면 확인
          후 지체 없이 처리합니다. 공개 게시판이므로 비밀번호 등 민감한 정보는 적지 말아 주세요.
        </p>
      </section>

      <section aria-labelledby="privacy-7">
        <h2 id="privacy-7">7. 개인정보 보호책임자</h2>
        <p>
          개인정보 보호책임자는 서비스 운영자입니다. 개인정보와 관련한 문의와 신고는{' '}
          <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>로 접수합니다.
        </p>
      </section>

      <section aria-labelledby="privacy-8">
        <h2 id="privacy-8">8. 방침의 변경</h2>
        <p>
          이 방침이 바뀌면 시행일과 함께 이 페이지에 게시합니다. 이 방침은 {EFFECTIVE_DATE}부터
          시행합니다.
        </p>
      </section>
    </InfoLayout>
  )
}
