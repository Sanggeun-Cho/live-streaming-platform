#!/bin/sh
# MediaMTX 훅에서 호출해 api에 이벤트를 전달한다.
# 사용: sh /hooks/notify.sh <online|offline|segment>  (segment는 hooks/segment.sh가 변환 후 호출한다)
# MediaMTX가 MTX_PATH, MTX_SOURCE_TYPE, MTX_SEGMENT_PATH, MTX_SEGMENT_DURATION을 환경변수로 넘긴다.
# MTX_SEGMENT_SIZE는 segment.sh가 붙인다.
# api가 잠시 내려가 있어도 훅 유실은 api의 Control API 주기 대조(30초)로 보정한다.
# INTERNAL_SECRET은 compose가 컨테이너 환경변수로 넣는다.
set -eu
type="$1"
body=$(printf '{"type":"%s","path":"%s","sourceType":"%s","segmentPath":"%s","segmentDuration":"%s","segmentSize":"%s"}' \
  "$type" "${MTX_PATH:-}" "${MTX_SOURCE_TYPE:-}" "${MTX_SEGMENT_PATH:-}" "${MTX_SEGMENT_DURATION:-}" "${MTX_SEGMENT_SIZE:-}")
exec wget -q -O /dev/null -T 5 -t 2 \
  --header 'Content-Type: application/json' \
  --header "X-Internal-Secret: ${INTERNAL_SECRET:-}" \
  --post-data "$body" \
  "${API_INTERNAL_URL:-http://api:3000}/internal/media/events"
