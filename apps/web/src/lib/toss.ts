// 토스페이먼츠 결제 SDK v2 "결제창형" 결제 (구 결제위젯).
//   https://docs.tosspayments.com/guides/v2/payment-widget/integration-window
//   https://docs.tosspayments.com/sdk/v2/js/payment-window
// 구매자가 결제가 필요할 때만 SDK를 읽는다 (방송 화면 첫 로딩을 무겁게 하지 않는다).
// 패키지(@tosspayments/tosspayments-sdk) 대신 공식 스크립트를 쓴다: 문서가 권장하는 방식이고, 쓰는 메서드가 몇 개뿐이다.

const SDK_URL = 'https://js.tosspayments.com/v2/standard'

type PaymentWindow = {
  on(event: 'paymentRequest' | 'cancel', callback: () => void): void
  destroy(): void
}

type Widgets = {
  setAmount(amount: { value: number; currency: 'KRW' }): Promise<void>
  renderPaymentWindow(params: { orderName: string }): Promise<PaymentWindow>
  requestPayment(params: {
    orderId: string
    orderName: string
    customerName?: string
    successUrl: string
    failUrl: string
  }): Promise<void>
}

type TossPaymentsFactory = ((clientKey: string) => {
  widgets(params: { customerKey: string }): Widgets
}) & { ANONYMOUS: string }

declare global {
  interface Window {
    TossPayments?: TossPaymentsFactory
  }
}

let loading: Promise<TossPaymentsFactory> | null = null

function loadSdk(): Promise<TossPaymentsFactory> {
  if (window.TossPayments) return Promise.resolve(window.TossPayments)
  loading ??= new Promise<TossPaymentsFactory>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onload = () => (window.TossPayments ? resolve(window.TossPayments) : reject(new Error('sdk')))
    script.onerror = () => reject(new Error('sdk'))
    document.head.appendChild(script)
  }).catch((e: unknown) => {
    // 다음 시도에서 다시 읽을 수 있게 한다 (일시적인 네트워크 오류)
    loading = null
    throw e
  })
  return loading
}

/** SDK가 던지는 오류 ({ code, message }) */
export const tossErrorCode = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : null

/** 한 번에 결제창은 하나만 띄울 수 있다 (두 번째는 PaymentWindowAlreadyRenderedError) */
let openWindow: PaymentWindow | null = null

/**
 * 결제창을 띄운다. 구매자가 결제하기를 누르면 successUrl/failUrl로 페이지가 이동한다.
 * 구매자가 결제창을 닫으면 onCancel을 부른다.
 */
export async function openTossPaymentWindow(params: {
  clientKey: string
  amount: number
  orderId: string
  orderName: string
  customerName: string
  successUrl: string
  failUrl: string
  onCancel: () => void
  onError: (e: unknown) => void
}) {
  let TossPayments: TossPaymentsFactory
  try {
    TossPayments = await loadSdk()
  } catch {
    throw new Error('결제 모듈을 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요')
  }
  openWindow?.destroy()
  openWindow = null
  // 비회원 결제: 카드 정보를 저장하는 브랜드페이를 쓰지 않으므로 구매자 키가 필요 없다
  const widgets = TossPayments(params.clientKey).widgets({ customerKey: TossPayments.ANONYMOUS })
  await widgets.setAmount({ value: params.amount, currency: 'KRW' })
  const paymentWindow = await widgets.renderPaymentWindow({ orderName: params.orderName })
  openWindow = paymentWindow
  paymentWindow.on('paymentRequest', () => {
    widgets
      .requestPayment({
        orderId: params.orderId,
        orderName: params.orderName,
        customerName: params.customerName,
        successUrl: params.successUrl,
        failUrl: params.failUrl,
      })
      .catch(params.onError)
  })
  paymentWindow.on('cancel', () => {
    paymentWindow.destroy()
    if (openWindow === paymentWindow) openWindow = null
    params.onCancel()
  })
}
