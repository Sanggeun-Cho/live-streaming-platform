#!/bin/sh
# 운영 서버에서 최신 이미지를 받아 다시 띄우고, api가 healthy가 될 때까지 기다린다.
# 자동 배포: GitHub Actions의 SSH 키에 걸린 강제 명령이 `git pull` 뒤에 이 파일을 실행한다 (docs/INFRA_SETUP.md §6-4).
# 수동 배포: cd ~/live && git pull --ff-only && sh scripts/deploy.sh
set -eu
cd "$(dirname "$0")/.."

docker compose pull
# 서버에서는 빌드하지 않는다 (1GB VM에서 멈출 수 있다)
docker compose up -d --no-build

# mediamtx.yml은 파일 하나만 마운트한다. git pull이 파일을 새로 만들면 실행 중인 컨테이너는 옛 파일을 계속 보고,
# compose 정의가 그대로면 up -d도 다시 만들지 않는다. 컨테이너가 보는 내용과 다를 때만 다시 만든다
# (매번 다시 만들면 배포마다 방송이 끊긴다)
running=$(docker compose exec -T mediamtx cat /mediamtx.yml 2> /dev/null | cksum || true)
current=$(cksum < infra/mediamtx/mediamtx.yml)
if [ "$running" != "$current" ]; then
  echo "mediamtx.yml이 바뀌어 mediamtx를 다시 만듭니다"
  docker compose up -d --no-build --force-recreate mediamtx
fi

status=starting
i=0
while [ "$i" -lt 60 ]; do
  id=$(docker compose ps -q api || true)
  status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2> /dev/null || echo unknown)
  [ "$status" = healthy ] && break
  i=$((i + 1))
  sleep 3
done

if [ "$status" != healthy ]; then
  # 실패하면 옛 이미지를 지우지 않는다 (IMAGE_TAG 롤백 때 다시 받지 않아도 되게)
  echo "배포 실패: api 상태가 healthy가 아닙니다 ($status)" >&2
  docker compose logs --tail 50 api >&2
  exit 1
fi

docker image prune -f > /dev/null
echo "배포 완료: api healthy ($(git rev-parse --short HEAD))"
