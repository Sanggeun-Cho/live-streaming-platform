# #2 WebRTC 스파이크 결과 (2026-11-06)

MediaMTX 1.21.3 + Caddy + 브라우저 WHIP/WHEP 조합이 설계대로 동작하는지 로컬 `docker compose`에서 검증했습니다.
검증 화면: `https://localhost/spike.html` (운영 화면 #7·#8이 생기면 삭제)

## 결론
**설계를 그대로 진행합니다.** 실패 시 대안(LL-HLS)은 필요하지 않습니다.
다만 아래 "후속 이슈에 반영할 발견" 네 가지는 설계에 없던 내용이라 각 이슈에 옮겨 적었습니다.

## 측정 결과
환경: Windows 11, Docker Desktop, Chrome(headless, 가짜 카메라·마이크), 송출과 시청 모두 같은 PC.

| 항목 | 결과 | 근거 |
|---|---|---|
| 화면 공유 + 탭 소리 + 마이크 → WHIP | ✅ | `hasDisplayAudio: true, hasMic: true`, 1920x1080 H.264 + Opus |
| 타임코드 송출 → WHEP 시청 지연 | ✅ **p50 63–145ms, p90 81–171ms** (30fps, 3회) | 타임코드 영상을 시청 측에서 읽어 측정 |
| H.264 강제 | ✅ | 송출·시청 모두 `video/H264`, 서버 응답 SDP에서도 확인 |
| fMP4 녹화 | ✅ | `ffprobe`: h264 640x360 + opus, 23.18s. ffmpeg 전체 디코드 성공, Chrome `<video>` 재생 성공 |
| `authHTTPAddress` | ✅ | publish·read마다 `{action, path, protocol:"webrtc", ip, query, token}` 호출 |
| `runOnOnline` / `runOnOffline` | ✅ | `MTX_SOURCE_TYPE=webRTCSession` |
| `runOnRecordSegmentComplete` | ✅ | `segmentPath`, `segmentDuration` 전달 |
| `MTX_WEBRTCADDITIONALHOSTS` | ✅ | 서버가 지정한 주소만 광고 (UDP·TCP 8189) |
| `overridePublisher` | ✅ (주의 사항 있음) | 두 번째 송출이 첫 번째를 대체 |
| 첫 화면까지 시간 | 약 2.3초 | 시청 페이지 로드 포함 |

## 후속 이슈에 반영할 발견

1. **AudioContext가 멈춘 채 송출하면 방송 전체가 무음이 됩니다 → #7**
   - 사용자 클릭 없이 송출을 시작하면 믹서 오디오 트랙이 패킷을 보내지 않습니다.
   - 그러면 MediaMTX가 트랙 수집 시간(2초) 뒤 오디오 트랙을 버리고, 녹화에도 영상만 남습니다 (`recording 1 track (H264)`).
   - 조치(반영함): 믹서를 클릭 핸들러의 첫 `await` 전에 만들고, 송출 전에 `running` 상태를 확인합니다 (`media.ts`).
2. **송출이 대체되어도 이전 송출 화면은 모릅니다 → #7**
   - 서버는 이전 세션을 끊지만, 이전 탭의 상태는 계속 "송출 중"으로 남습니다.
   - 조치: `pc.connectionState`가 `failed`/`closed`로 바뀌면 "다른 곳에서 송출이 시작됨/재연결" 상태로 바꿉니다.
3. **훅 도착 순서를 믿으면 안 됩니다 → #6**
   - 송출이 대체될 때 MediaMTX는 이전 세션의 `offline` 훅을 먼저 실행하지만, 훅은 별도 프로세스라 api에는 **새 `online`이 먼저, 이전 `offline`이 나중에** 도착했습니다.
   - 조치: `offline`을 받으면 바로 끊김으로 처리하지 않고, Control API(`GET /v3/paths/get/live/{id}`)로 지금 송출 중인지 확인합니다. 송출 중이 아닐 때만 유예 타이머를 시작합니다. ENDED 확정 직전에도 한 번 더 확인합니다.
4. **녹화 세그먼트는 송출 세션마다 생기고, `offline` 이후에 도착합니다 → #12**
   - 송출 대체·재연결마다 세그먼트 파일이 새로 생깁니다 (1:N 설계와 맞음).
   - 세그먼트 완료 훅은 `offline`과 같은 시점이나 그 뒤에 옵니다. 유예 시간이 끝나 ENDED가 된 방송에도 세그먼트 등록을 허용해야 합니다.

## 검증하지 못한 것
| 항목 | 이유 | 어디서 확인 |
|---|---|---|
| iOS Safari / Android Chrome 카메라 송출 | 실기기와 HTTPS가 필요하고, 임시 터널 도구 실행은 권한 정책으로 막힘 | 아래 "휴대폰 사전 확인" 또는 #9 |
| 모바일 데이터망(NAT), ICE-TCP 폴백 | 공인 서버 필요 | #9 |
| Safari에서 녹화 파일(Opus 오디오) 재생 | 실기기 필요. **확실하지 않음**: 재생이 안 되면 세그먼트 완료 시 ffmpeg로 오디오만 AAC로 변환 | #12 |
| 실제 마이크·시스템 소리 품질 | 가짜 장치로만 확인 | #7 수동 확인 |

## 휴대폰 사전 확인 (선택, Oracle 서버 없이)
서버가 준비되기 전에 휴대폰 카메라 송출을 미리 보고 싶을 때만 합니다. 하지 않아도 #8·#9에서 확인합니다.
신호(HTTPS)는 임시 터널로, 미디어(UDP 8189)는 같은 Wi-Fi 안에서 PC로 바로 보냅니다.

1. `.env`에 `MEDIA_PUBLIC_HOST=<PC의 LAN IP>`를 넣고 `docker compose up -d`를 실행합니다.
   - LAN IP는 `ipconfig`의 Wi-Fi 어댑터 IPv4 주소입니다 (예: 192.168.10.x).
2. 관리자 PowerShell에서 방화벽을 엽니다. 확인이 끝나면 지웁니다.
   ```powershell
   New-NetFirewallRule -DisplayName "live-spike-8189" -Direction Inbound -Protocol UDP -LocalPort 8189 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "live-spike-8189-tcp" -Direction Inbound -Protocol TCP -LocalPort 8189 -Action Allow -Profile Private
   # 끝나면: Remove-NetFirewallRule -DisplayName "live-spike-8189*"
   ```
3. cloudflared를 설치하고 임시 터널을 엽니다 (계정 불필요).
   ```powershell
   winget install --id Cloudflare.cloudflared
   cloudflared tunnel --url https://localhost --no-tls-verify --http-host-header localhost --origin-server-name localhost
   ```
4. 출력된 `https://*.trycloudflare.com/spike.html`을 휴대폰에서 엽니다. 소스를 "카메라 + 마이크"로 고르고 시작합니다.
5. PC에서 `https://localhost/spike.html?mode=view&path=live/1`을 열어 시청합니다.

## 다시 측정하는 방법
`spike.html`은 `?mode=publish&source=timecode&path=live/1&auto=1`과 `?mode=view&path=live/1&auto=1`로 자동 시작합니다.
결과는 페이지의 `window.__spike`에 있습니다. 이번 측정은 playwright-core로 두 페이지를 열어 읽었습니다. 자동화 E2E는 #13에서 저장소에 정식으로 넣습니다.
