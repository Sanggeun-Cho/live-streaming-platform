import type { ReactNode } from 'react'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { ExternalAnchor, InfoLayout } from './InfoLayout'
import { ISSUES_URL } from '../../lib/site'

type Faq = { q: string; a: ReactNode }
type FaqGroup = { id: string; title: string; items: Faq[] }

const FAQ: FaqGroup[] = [
  {
    id: 'faq-watch',
    title: '시청',
    items: [
      {
        q: '로그인하지 않아도 방송을 볼 수 있나요?',
        a: (
          <p>
            네. 진행 중인 방송과 다시보기는 로그인 없이 볼 수 있습니다. 채팅, 후원, 방송하기는
            로그인한 뒤에 이용할 수 있습니다.
          </p>
        ),
      },
      {
        q: '어떤 브라우저에서 이용할 수 있나요?',
        a: (
          <>
            <p>최신 버전의 Chrome, Edge, Safari, Firefox를 지원합니다.</p>
            <p>
              방송할 때 화면 공유는 PC 브라우저에서만 됩니다. 휴대폰에서는 카메라로 송출할 수
              있습니다.
            </p>
          </>
        ),
      },
      {
        q: '방송 소리가 들리지 않습니다.',
        a: (
          <>
            <p>
              브라우저의 자동재생 정책 때문에 방송은 소리가 꺼진 상태로 시작될 수 있습니다.
              플레이어의 &ldquo;소리 켜기&rdquo; 버튼을 눌러 주세요.
            </p>
            <p>
              그래도 들리지 않으면 기기 볼륨과 브라우저 탭의 음소거 여부를 확인해 주세요. 방송하는
              쪽에서 소리를 함께 공유하지 않았을 수도 있습니다.
            </p>
          </>
        ),
      },
      {
        q: '다시보기는 언제 볼 수 있나요?',
        a: (
          <>
            <p>
              방송이 끝나고 잠시 뒤 다시보기가 자동으로 등록됩니다. 녹화 파일을 정리하는 데 시간이
              조금 걸립니다.
            </p>
            <p>
              방송 중 연결이 끊겼다가 이어서 송출한 경우 녹화가 여러 구간으로 나뉘는데,
              다시보기에서는 이 구간들을 순서대로 이어서 재생합니다.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: 'faq-broadcast',
    title: '방송',
    items: [
      {
        q: '화면 공유를 하는데 소리가 나가지 않습니다.',
        a: (
          <p>
            화면 공유 창에서 공유할 대상을 고를 때 &ldquo;탭 오디오 공유&rdquo; 또는 &ldquo;시스템
            오디오 공유&rdquo;를 체크해야 소리가 함께 송출됩니다. 브라우저와 운영체제에 따라 이
            항목이 보이지 않을 수 있으며, 그런 경우 탭을 선택해 공유하면 탭 소리를 보낼 수
            있습니다.
          </p>
        ),
      },
      {
        q: '방송 중에 송출이 끊겼습니다.',
        a: (
          <p>
            송출이 끊긴 뒤 45초 안에는 스튜디오에서 &ldquo;이어서 송출&rdquo;을 눌러 같은 방송을
            계속할 수 있습니다. 45초가 지나면 방송은 자동으로 종료되고, 그때까지의 녹화는
            다시보기로 저장됩니다.
          </p>
        ),
      },
      {
        q: '휴대폰으로도 방송할 수 있나요?',
        a: (
          <p>
            네. 휴대폰 브라우저에서 스튜디오에 들어가면 카메라를 선택해 송출할 수 있습니다. 화면
            공유는 휴대폰 브라우저에서 지원되지 않습니다.
          </p>
        ),
      },
    ],
  },
  {
    id: 'faq-chat',
    title: '채팅·후원',
    items: [
      {
        q: '후원하면 실제로 결제되나요?',
        a: (
          <p>
            아니요. 후원은 토스페이먼츠의 <strong>테스트 결제</strong>로 처리되어 실제로 돈이
            나가지 않습니다. 카드 대금이 청구되지 않고, 스트리머에게 정산되는 금액도 없습니다.
          </p>
        ),
      },
      {
        q: '후원은 어떻게 하나요?',
        a: (
          <p>
            방송 화면에서 후원 버튼을 누르고 1,000원부터 금액을 선택한 뒤 메시지를 적어 결제하면
            됩니다. 결제가 끝나면 채팅에 후원 메시지가 표시됩니다.
          </p>
        ),
      },
      {
        q: '채팅을 수정하거나 지울 수 있나요?',
        a: (
          <p>
            본인이 보낸 채팅만 수정하거나 삭제할 수 있습니다. 다른 사람의 채팅은 바꿀 수
            없습니다.
          </p>
        ),
      },
      {
        q: '채팅에 글자 수 제한이 있나요?',
        a: <p>채팅 한 개는 최대 300자까지 보낼 수 있습니다.</p>,
      },
      {
        q: '채팅이 바로 올라가지 않습니다.',
        a: (
          <p>
            너무 빠르게 연달아 보내면 잠시 기다렸다가 보낸 순서대로 전송됩니다. 메시지가
            사라진 것이 아니니 조금만 기다려 주세요.
          </p>
        ),
      },
    ],
  },
  {
    id: 'faq-account',
    title: '계정',
    items: [
      {
        q: '회원 탈퇴는 어떻게 하나요?',
        a: (
          <p>
            현재 화면에서 직접 탈퇴하는 기능은 없습니다.{' '}
            <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>에 탈퇴를 요청해
            주시면 계정과 관련 정보를 지체 없이 삭제합니다. 요청할 때 비밀번호는 절대 적지 마세요.
          </p>
        ),
      },
      {
        q: '문의는 어디로 하나요?',
        a: (
          <p>
            오류 제보와 문의는 모두 <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>
            로 받습니다. 개인정보가 담긴 내용은 공개 이슈에 적지 말아 주세요.
          </p>
        ),
      },
    ],
  },
]

export function HelpPage() {
  useDocumentTitle('고객센터')

  return (
    <InfoLayout title="고객센터">
      <p className="info-lead">
        galle LIVE 이용 방법과 자주 묻는 질문을 모았습니다. 여기서 해결되지 않는 문제는 아래
        문의하기를 이용해 주세요.
      </p>

      <section aria-labelledby="help-start">
        <h2 id="help-start">방송 시작하는 방법</h2>
        <ol className="info-steps">
          <li>로그인합니다. 계정이 없으면 회원가입부터 진행합니다.</li>
          <li>방송 만들기에서 방송 제목과 설명을 입력합니다.</li>
          <li>
            스튜디오에서 송출할 화면을 고릅니다. PC에서는 화면 공유를, 휴대폰에서는 카메라를
            선택합니다.
          </li>
          <li>방송 시작을 누르면 시청자에게 방송이 공개됩니다.</li>
          <li>방송을 종료하면 녹화된 영상이 다시보기로 저장됩니다.</li>
        </ol>
      </section>

      <section aria-labelledby="help-faq">
        <h2 id="help-faq">자주 묻는 질문</h2>
        {FAQ.map((group) => (
          <div key={group.id} className="info-faq-group">
            <h3 id={group.id}>{group.title}</h3>
            <div className="info-faq-list">
              {group.items.map((item) => (
                <details key={item.q} className="info-faq">
                  <summary className="info-faq-q">{item.q}</summary>
                  <div className="info-faq-a">{item.a}</div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="info-contact" aria-labelledby="help-contact">
        <h2 id="help-contact">문의하기</h2>
        <p>
          오류 제보, 계정 탈퇴, 개인정보 관련 요청은{' '}
          <ExternalAnchor href={ISSUES_URL}>GitHub Issues</ExternalAnchor>에 남겨 주세요.
          운영자가 확인한 뒤 답변드립니다. 공개 게시판이므로 비밀번호나 결제 정보 같은 민감한
          정보는 적지 말아 주세요.
        </p>
      </section>
    </InfoLayout>
  )
}
