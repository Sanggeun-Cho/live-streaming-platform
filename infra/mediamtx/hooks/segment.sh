#!/bin/sh
# runOnRecordSegmentComplete 훅 (#12). 닫힌 녹화 세그먼트를 웹용 mp4로 바꾼 뒤 api에 등록을 요청한다.
#
# 왜 변환하나: MediaMTX 녹화는 H.264 + Opus fMP4다. Safari·iOS는 mp4 안의 Opus 재생이 확실하지 않아(#2 스파이크)
#   오디오만 AAC로 바꾼다. 영상은 그대로 복사한다(-c:v copy) — 1GB 서버에서 영상 재인코딩은 감당할 수 없다.
#   +faststart로 moov를 앞에 두어 Range 요청 한두 번으로 바로 재생·탐색을 시작하게 한다.
# 원본은 변환에 성공하면 웹용 파일로 바꿔치기한다(같은 경로). 영상은 같고 오디오만 다르므로 디스크를 두 배로 쓰지 않는다.
#   변환에 실패하면 원본을 그대로 등록한다 (Chrome·Firefox·Android에서는 재생된다).
# 임시 파일 이름은 점으로 시작해 api의 경로 검사(파일 이름이 점으로 시작하면 거절)와 Caddy 인가에 걸리지 않는다.
set -u
seg="${MTX_SEGMENT_PATH:?}"
tmp="$(dirname "$seg")/.$(basename "$seg" .mp4).web.tmp.mp4"

# 영상 0~1개 + 오디오 0~1개. 마이크 없는 송출도, 영상 트랙이 늦게 와서 MediaMTX가 오디오만 녹화한 경우도 있다
# ('?' 없이 없는 트랙을 지정하면 ffmpeg가 실패한다 — 직접 테스트에서 오디오만 있는 녹화로 재현).
# nice: 송출·시청 처리보다 우선순위를 낮춘다
if nice -n 10 ffmpeg -nostdin -hide_banner -loglevel error -y -i "$seg" \
  -map '0:v:0?' -map '0:a:0?' -c:v copy -c:a aac -b:a 128k -movflags +faststart -f mp4 "$tmp"; then
  mv -f "$tmp" "$seg"
else
  echo "segment.sh: 웹용 변환 실패, 원본을 등록한다: $seg" >&2
  rm -f "$tmp"
fi

MTX_SEGMENT_SIZE="$(stat -c %s "$seg" 2>/dev/null || echo '')"
export MTX_SEGMENT_SIZE
exec sh /hooks/notify.sh segment
