#!/bin/sh
# MediaMTX 훅에서 호출해 api에 이벤트를 전달한다.
# 사용: sh /hooks/notify.sh <online|offline|segment>
# MediaMTX가 MTX_PATH, MTX_SOURCE_TYPE, MTX_SEGMENT_PATH, MTX_SEGMENT_DURATION을 환경변수로 넘긴다.
# api가 잠시 내려가 있어도 훅 유실은 #6의 Control API 주기 대조로 보정한다.
set -eu
type="$1"
body=$(printf '{"type":"%s","path":"%s","sourceType":"%s","segmentPath":"%s","segmentDuration":"%s"}' \
  "$type" "${MTX_PATH:-}" "${MTX_SOURCE_TYPE:-}" "${MTX_SEGMENT_PATH:-}" "${MTX_SEGMENT_DURATION:-}")
exec wget -q -O /dev/null -T 5 -t 2 \
  --header 'Content-Type: application/json' \
  --post-data "$body" \
  "${API_INTERNAL_URL:-http://api:3000}/internal/media/events"
