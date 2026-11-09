import { BroadcastList } from '../components/BroadcastList'

export function HomePage() {
  return (
    <>
      <section>
        <h2>지금 방송 중</h2>
        <BroadcastList params={{ status: 'LIVE' }} empty="지금 방송 중인 채널이 없습니다." />
      </section>
      <section>
        <h2>전체 방송</h2>
        <BroadcastList params={{}} empty="아직 등록된 방송이 없습니다." />
      </section>
    </>
  )
}
