#!/bin/sh
# runOnRecordSegmentComplete 훅 (#12). 닫힌 녹화 세그먼트를 웹용 mp4로 바꾼 뒤 api에 등록을 요청한다.
#
# 왜 변환하나: MediaMTX 녹화는 H.264 + Opus fMP4다. Safari·iOS는 mp4 안의 Opus 재생이 확실하지 않아(#2 스파이크)
#   오디오만 AAC로 바꾼다. 영상은 그대로 복사한다(-c:v copy) — 1GB 서버에서 영상 재인코딩은 감당할 수 없다.
#   +faststart로 moov를 앞에 두어 Range 요청 한두 번으로 바로 재생·탐색을 시작하게 한다.
# 원본은 변환에 성공하면 웹용 파일로 바꿔치기한다(같은 경로). 영상은 같고 오디오만 다르므로 디스크를 두 배로 쓰지 않는다.
#   변환에 실패하면 원본을 그대로 등록한다 (Chrome·Firefox·Android에서는 재생된다).
# 임시 파일 이름은 점으로 시작해 api의 경로 검사(파일 이름이 점으로 시작하면 거절)와 Caddy 인가에 걸리지 않는다.
#
# 1GB 서버 보호: 변환은 컨테이너 전체에서 한 번에 하나만(flock), ffmpeg 스레드 1개, 우선순위 낮춤(nice), 30분 제한(timeout).
# 이 훅이 실패하거나 도중에 죽어도(mediamtx 재시작) api의 복구 스캔(5분 주기)이 원본을 등록한다.
# MediaMTX는 이 훅 프로세스를 path offline과 묶어 끝내지 않는다 (WORKLOG #12 참고).
set -u
seg="${MTX_SEGMENT_PATH:?}"
tmp="$(dirname "$seg")/.$(basename "$seg" .mp4).web.tmp.mp4"
LOCK=/tmp/segment-convert.lock
TIMEOUT_SECONDS=1800

(
  # 앞선 변환이 끝날 때까지 기다린다 (방송 여러 개가 동시에 끝나도 ffmpeg는 하나)
  flock 9
  # 이전에 죽은 변환이 남긴 임시 파일 정리 (timeout보다 충분히 오래된 것만)
  find "$(dirname "$(dirname "$seg")")" -name '.*.web.tmp.mp4' -mmin +60 -delete 2>/dev/null

  # 영상 0~1개 + 오디오 0~1개. 마이크 없는 송출도, 영상 트랙이 늦게 와서 MediaMTX가 오디오만 녹화한 경우도 있다
  # ('?' 없이 없는 트랙을 지정하면 ffmpeg가 실패한다 — 직접 테스트에서 오디오만 있는 녹화로 재현)
  if timeout "$TIMEOUT_SECONDS" nice -n 10 ffmpeg -nostdin -hide_banner -loglevel error -y -threads 1 -i "$seg" \
    -map '0:v:0?' -map '0:a:0?' -c:v copy -c:a aac -b:a 128k -movflags +faststart -f mp4 "$tmp"; then
    mv -f "$tmp" "$seg"
  else
    echo "segment.sh: 웹용 변환 실패, 원본을 등록한다: $seg" >&2
    rm -f "$tmp"
  fi
) 9>"$LOCK"

MTX_SEGMENT_SIZE="$(stat -c %s "$seg" 2>/dev/null || echo '')"
export MTX_SEGMENT_SIZE
exec sh /hooks/notify.sh segment
