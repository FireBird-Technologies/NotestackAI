#!/usr/bin/env bash
# Deploy the latest code: pull, rebuild, restart, then check health.
#   bash /opt/notestack/deploy/update.sh            # API, worker, Caddy
#   RENDER=1 bash /opt/notestack/deploy/update.sh   # also the video renderer
set -euo pipefail

cd "$(dirname "$0")"
git -C .. pull --ff-only

# Placeholders look like =<...> or <user>/<password> inside DATABASE_URL (FROM_EMAIL's <address> is fine).
if grep -qE '=<|<(user|password|ep-xxxx|region|db)>' .env.prod; then
  echo "deploy/.env.prod still has <placeholders>; fill them in first."
  exit 1
fi

profile=()
[ "${RENDER:-0}" = "1" ] && profile=(--profile render)

docker compose --env-file .env.prod -f docker-compose.prod.yml "${profile[@]}" up -d --build --remove-orphans
docker image prune -f >/dev/null

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
