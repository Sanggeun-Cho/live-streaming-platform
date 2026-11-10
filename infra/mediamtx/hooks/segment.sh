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

# 변환 차례(flock)를 기다리는 동안에도 api 복구 스캔이 "변환 중"으로 보고 원본을 등록하지 않도록 임시 파일을 먼저 만든다.
# 대기가 길어져(35분 초과) 스캔이 원본을 먼저 등록해도, 변환 후 훅이 크기·길이를 고치고 recording 이벤트를 다시 보낸다 (#31).
# 60분 넘게 기다리면 앞선 변환의 정리(find -mmin +60)가 이 표식을 지울 수 있다 → 스캔이 원본을 등록하고, 같은 훅 갱신 경로로 회복된다.
# 훅이 대기 중에 죽으면(종료 신호) 표식을 지운다. 지우지 못하고 남아도 스캔은 35분 뒤 원본을 등록하고 find가 60분 뒤 정리한다
: > "$tmp"
trap 'rm -f "$tmp"' EXIT
trap 'rm -f "$tmp"; exit 143' INT TERM
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
# 여기서는 임시 파일이 이미 mv됐거나 지워졌다. exec 전에 trap을 해제한다 (notify.sh로 바뀐 프로세스에 남지 않게)
rm -f "$tmp"
trap - EXIT INT TERM

MTX_SEGMENT_SIZE="$(stat -c %s "$seg" 2>/dev/null || echo '')"
export MTX_SEGMENT_SIZE
exec sh /hooks/notify.sh segment
