#!/usr/bin/env bash
# Deploy the latest code: pull, rebuild, restart, then check health.
#   bash /opt/notestack/deploy/update.sh            # API, worker, Caddy
#   RENDER=1 bash /opt/notestack/deploy/update.sh   # also the video renderer
#   CADDY=1  bash /opt/notestack/deploy/update.sh   # bundled Caddy (only if nothing else uses ports 80/443)
set -euo pipefail

cd "$(dirname "$0")"
git -C .. pull --ff-only

# Placeholders look like =<...> or <user>/<password> inside DATABASE_URL (FROM_EMAIL's <address> is fine).
if grep -qE '=<|<(user|password|ep-xxxx|region|db)>' .env.prod; then
  echo "deploy/.env.prod still has <placeholders>; fill them in first."
  exit 1
fi

profile=()
[ "${RENDER:-0}" = "1" ] && profile+=(--profile render)
[ "${CADDY:-0}" = "1" ] && profile+=(--profile caddy)

docker compose --env-file .env.prod -f docker-compose.prod.yml "${profile[@]}" up -d --build --remove-orphans
docker image prune -f >/dev/null

port=$(grep -E '^API_PORT=' .env.prod | cut -d= -f2)
port=${port:-8010}
echo "==> Waiting for the API on 127.0.0.1:$port"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break
  sleep 4
done
curl -fsS "http://127.0.0.1:$port/api/health" || { echo "API not up. Logs: cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api"; exit 1; }
echo

domain=$(grep -E '^API_DOMAIN=' .env.prod | cut -d= -f2)
echo "==> Waiting for https://$domain/api/health"
for _ in $(seq 1 30); do
  if curl -fsS "https://$domain/api/health" >/dev/null 2>&1; then
    curl -fsS "https://$domain/api/health"
    echo
    echo "==> Live."
    exit 0
  fi
  sleep 4
done
echo "Health check did not pass yet. Logs: cd deploy && docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api"
exit 1
