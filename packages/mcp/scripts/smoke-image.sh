#!/usr/bin/env bash
# Smoke-tests a built MCP image against the deploy contract: starts with only
# env config, serves GET /healthz on PORT, and exits 0 on SIGTERM well inside
# the 30 s grace period.
#
# Usage: packages/mcp/scripts/smoke-image.sh <image>
set -euo pipefail

image="$1"
port=18080
name="mcp-smoke-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# The API and issuer are never contacted by /healthz; any well-formed URL works.
docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
  -e PORT=8080 \
  -e CLOUDCRUISE_API_BASE_URL=http://127.0.0.1:9 \
  -e CLOUDCRUISE_OAUTH_ISSUER=http://127.0.0.1:9/auth/v1 \
  -e MCP_PUBLIC_URL=http://localhost:8080 \
  "$image" >/dev/null

ok=""
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" = "200" ]; then
    ok=1
    break
  fi
  sleep 1
done
if [ -z "$ok" ]; then
  echo "healthz never returned 200" >&2
  docker logs "$name" >&2
  exit 1
fi
echo "healthz: 200"

if [ "$(docker exec "$name" id -u)" = "0" ]; then
  echo "container runs as root" >&2
  exit 1
fi

start=$(date +%s)
docker stop -t 30 "$name" >/dev/null
elapsed=$(( $(date +%s) - start ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
echo "SIGTERM: exit $code after ${elapsed}s"
if [ "$code" != "0" ] || [ "$elapsed" -ge 10 ]; then
  echo "expected exit 0 within 10s of SIGTERM" >&2
  docker logs "$name" >&2
  exit 1
fi
