#!/usr/bin/env bash
# One time setup for a fresh Ubuntu 24.04 Droplet. Run as root:
#   git clone https://github.com/FireBird-Technologies/NotestackAI.git /opt/notestack
#   bash /opt/notestack/deploy/setup.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> Swap (helps builds and the renderer on small Droplets)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f .env.prod ]; then
  cp env.prod.example .env.prod
  chmod 600 .env.prod
  echo
  echo "Created deploy/.env.prod. Fill in every <...> value, then run: bash deploy/update.sh"
  exit 0
fi

echo "==> .env.prod exists; starting the stack"
bash ./update.sh
