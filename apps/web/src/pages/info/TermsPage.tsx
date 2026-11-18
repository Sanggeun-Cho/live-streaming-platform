import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { EFFECTIVE_DATE, ExternalAnchor, InfoLayout } from './InfoLayout'
import { ISSUES_URL } from '../../lib/site'

export function TermsPage() {
  useDocumentTitle('이용약관')

  return (
    <InfoLayout title="이용약관" updated={EFFECTIVE_DATE}>
      <section aria-labelledby="terms-1">
        <h2 id="terms-1">제1조 (목적)</h2>
        <p>
          이 약관은 galle LIVE(이하 &ldquo;서비스&rdquo;)를 이용하는 데 필요한 운영자와 이용자의
          권리, 의무 및 책임 사항을 정합니다.
        </p>
      </section>

      <section aria-labelledby="terms-2">
        <h2 id="terms-2">제2조 (정의)</h2>
        <ol>
          <li>&ldquo;서비스&rdquo;란 https://galle.cloud 에서 제공하는 실시간 방송, 채팅, 후원, 다시보기 기능을 말합니다.</li>
          <li>&ldquo;운영자&rdquo;란 서비스를 개발하고 운영하는 개인을 말합니다.</li>
          <li>&ldquo;이용자&rdquo;란 회원 여부와 관계없이 서비스에 접속해 이용하는 사람을 말합니다.</li>
          <li>&ldquo;회원&rdquo;이란 이메일과 비밀번호로 가입해 계정을 가진 이용자를 말합니다.</li>
          <li>
            &ldquo;게시물&rdquo;이란 회원이 서비스에 올린 방송, 방송 제목·설명·썸네일, 채팅, 후원
            메시지와 방송 녹화 영상을 말합니다.
          </li>
        </ol>
      </section>

      <section aria-labelledby="terms-3">
        <h2 id="terms-3">제3조 (약관의 효력과 변경)</h2>
        <ol>
          <li>이 약관은 서비스 화면에 게시함으로써 효력이 생깁니다.</li>
          <li>
            운영자는 필요한 경우 약관을 변경할 수 있으며, 변경한 약관은 시행일과 함께 이 페이지에
            게시합니다.
          </li>
          <li>변경된 약관에 동의하지 않는 회원은 이용을 중단하고 탈퇴를 요청할 수 있습니다.</li>
        </ol>
      </section>

      <section aria-labelledby="terms-4">
        <h2 id="terms-4">제4조 (회원가입과 계정)</h2>
        <ol>
          <li>회원가입은 이메일, 닉네임, 비밀번호를 입력해 신청하며, 이 약관에 동의한 것으로 봅니다.</li>
          <li>회원은 본인의 계정과 비밀번호를 관리할 책임이 있으며, 타인에게 계정을 양도하거나 빌려줄 수 없습니다.</li>
          <li>타인의 이메일을 도용하거나 다른 사람으로 오인될 수 있는 닉네임을 쓰는 경우 운영자는 해당 계정의 이용을 제한할 수 있습니다.</li>
          <li>
            회원 탈퇴는 <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>로 요청할 수
            있으며, 운영자는 요청을 확인한 뒤 지체 없이 처리합니다.
          </li>
        </ol>
      </section>

      <section aria-labelledby="terms-5">
        <h2 id="terms-5">제5조 (서비스의 제공)</h2>
        <ol>
          <li>
            서비스는 개인이 학습과 공모전 출품을 목적으로 운영하는 비영리 서비스이며, 이용료는
            없습니다.
          </li>
          <li>
            운영자는 서버 점검, 장애, 개발 일정 등의 사유로 서비스의 전부 또는 일부를 예고 없이
            중단하거나 종료할 수 있습니다.
          </li>
          <li>
            운영 과정에서 방송, 채팅, 다시보기 등 저장된 데이터가 예고 없이 초기화될 수 있습니다.
            보관이 필요한 자료는 이용자가 따로 보관해 주세요.
          </li>
        </ol>
      </section>

      <section aria-labelledby="terms-6">
        <h2 id="terms-6">제6조 (회원의 의무)</h2>
        <p>회원은 서비스를 이용하면서 다음 행위를 해서는 안 됩니다.</p>
        <ol>
          <li>타인의 저작권, 초상권 등 권리를 침해하는 영상이나 음악을 방송하는 행위</li>
          <li>채팅이나 방송으로 타인을 비방하거나 모욕하고, 개인정보를 공개하는 행위</li>
          <li>음란물, 폭력적인 내용 등 법령에 어긋나는 내용을 방송하거나 게시하는 행위</li>
          <li>같은 내용을 반복해 보내는 등 다른 이용자의 이용을 방해하는 행위</li>
          <li>서비스의 정상적인 운영을 방해하거나 허가 없이 시스템에 접근하는 행위</li>
        </ol>
        <p>
          운영자는 위 행위를 확인한 경우 해당 게시물을 숨기거나 삭제하고, 계정의 이용을 제한할 수
          있습니다.
        </p>
      </section>

      <section aria-labelledby="terms-7">
        <h2 id="terms-7">제7조 (게시물의 권리와 관리)</h2>
        <ol>
          <li>방송, 채팅, 녹화 영상 등 게시물의 권리는 그것을 만든 회원에게 있습니다.</li>
          <li>
            회원은 서비스 제공에 필요한 범위에서 운영자가 게시물을 저장하고, 다른 이용자에게
            송출·재생하는 것을 허락합니다. 방송은 녹화되어 다시보기로 공개됩니다.
          </li>
          <li>
            회원은 본인의 방송을 삭제할 수 있습니다. 삭제한 방송과 그 다시보기는 서비스 화면에서
            더 이상 보이지 않습니다.
          </li>
          <li>운영자는 제6조를 위반한 게시물을 회원의 동의 없이 숨기거나 삭제할 수 있습니다.</li>
        </ol>
      </section>

      <section aria-labelledby="terms-8">
        <h2 id="terms-8">제8조 (후원)</h2>
        <ol>
          <li>
            후원 기능은 토스페이먼츠의 테스트 결제 환경으로 동작합니다. 결제 과정을 거치더라도
            실제 대금은 청구되지 않습니다.
          </li>
          <li>후원 금액은 방송한 회원에게 정산되지 않으며, 운영자도 이를 수령하지 않습니다.</li>
          <li>후원 메시지는 해당 방송의 채팅에 표시되며 제6조의 의무가 똑같이 적용됩니다.</li>
        </ol>
      </section>

      <section aria-labelledby="terms-9">
        <h2 id="terms-9">제9조 (책임의 제한)</h2>
        <ol>
          <li>
            서비스는 무료로 제공되는 비영리 서비스로, 운영자는 서비스 중단이나 데이터 손실로 생긴
            손해에 대해 고의 또는 중대한 과실이 없는 한 책임을 지지 않습니다.
          </li>
          <li>운영자는 회원이 올린 게시물의 내용과 정확성에 대해 책임을 지지 않습니다.</li>
          <li>회원 간 또는 회원과 제3자 사이에 생긴 분쟁은 당사자끼리 해결하는 것을 원칙으로 합니다.</li>
        </ol>
      </section>

      <section aria-labelledby="terms-10">
        <h2 id="terms-10">제10조 (문의)</h2>
        <p>
          이 약관과 서비스에 관한 문의는{' '}
          <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>로 해 주세요.
        </p>
      </section>

      <p className="info-note">이 약관은 {EFFECTIVE_DATE}부터 시행합니다.</p>
    </InfoLayout>
  )
}
