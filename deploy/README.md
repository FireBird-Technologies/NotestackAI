# Deploying the backend to a DigitalOcean Droplet

One Droplet runs the API, the job worker and, optionally, the video renderer. HTTPS comes from the reverse
proxy already on the Droplet (Nginx, see nginx-notestack.conf), or from the bundled Caddy (`CADDY=1`) on a
Droplet with nothing else on ports 80 and 443.
The database is Neon. The frontend is on Cloudflare Pages.

## First time

1. **Droplet**: Ubuntu 24.04, 2 GB RAM for API + worker, 4 GB if you also run the renderer. Add your SSH key.
2. **DNS**: in Cloudflare, add an `A` record `api` pointing to the Droplet IP, **DNS only (grey cloud)** so long
   running progress streams are not cut at 100 seconds.
3. **Neon**: Dashboard > Connect, turn **Connection pooling off** (host without `-pooler`), copy the string and
   change `postgresql://` to `postgresql+psycopg://`.
4. On the Droplet:
   ```bash
   git clone https://github.com/FireBird-Technologies/NotestackAI.git /opt/notestack
   bash /opt/notestack/deploy/setup.sh        # installs Docker, firewall, swap, creates backend/.env
   nano /opt/notestack/backend/.env       # fill in every <...> value
   bash /opt/notestack/deploy/update.sh       # builds, starts, waits for https://API_DOMAIN/api/health
   ```
   Add `RENDER=1` before `update.sh` to also run the video renderer.
5. **Frontend**: in Cloudflare Pages set `VITE_API_URL=https://api.notestack.ai`, then retry the deployment.
6. **Google OAuth client**: redirect URI `https://api.notestack.ai/api/auth/google/callback`, JavaScript origin
   `https://notestackai.pages.dev`.

## Sharing the Droplet with other backends (Nginx)

The API listens on `127.0.0.1:8010` only (`API_PORT`). Point Nginx at it:

```bash
sudo cp /opt/notestack/deploy/nginx-notestack.conf /etc/nginx/sites-available/notestack
sudo ln -s /etc/nginx/sites-available/notestack /etc/nginx/sites-enabled/notestack
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.notestack.ai
```

## Every update

```bash
bash /opt/notestack/deploy/update.sh
```

## Useful commands (from /opt/notestack/deploy)

```bash
docker compose --env-file ../backend/.env -f docker-compose.prod.yml ps
docker compose --env-file ../backend/.env -f docker-compose.prod.yml logs -f api worker
docker compose --env-file ../backend/.env -f docker-compose.prod.yml restart worker
```

## Notes

- **Why the direct Neon URL**: the worker uses Postgres advisory locks for its scheduled tasks, which do not
  work through Neon's transaction pooler. Two processes need only a handful of connections.
- **Neon compute hours**: the worker polls for jobs every `WORKER_POLL_SECONDS`, so Neon's compute stays awake.
  That is roughly 720 compute hours a month, beyond the free tier; use a paid Neon plan in production.
- **Files**: with `STORAGE_BACKEND=local` uploads and generated media live in the `appdata` Docker volume on the
  Droplet (covered by Droplet backups). Switch to Cloudflare R2 before real traffic if you want them to survive
  losing the Droplet.
- **Migrations** are not applied automatically. After an update that adds one, run from `deploy/`:
  `docker compose --env-file ../backend/.env -f docker-compose.prod.yml run --rm api alembic upgrade head`
