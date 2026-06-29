# Origin Docker Compose Deployment

This repository deploys as a Next.js web/API process, a durable worker process,
and optional VevDemo API/frontend services behind host Nginx and HTTPS.

Placeholders in this document:

- Domain: `origin.tj.cn`
- App directory: `/var/www/myapp`
- Secret values: `CHANGE_ME`

Do not commit `.env`. It is ignored and must stay on the server.

## 1. Server Initialization

Run on Ubuntu 22.04 or Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git nginx rsync certbot python3-certbot-nginx
```

Install Docker from Docker's official apt repository:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Prepare the deployment directory:

```bash
sudo mkdir -p /var/www
sudo chown "$USER":"$USER" /var/www
git clone CHANGE_ME_REPOSITORY_URL /var/www/myapp
cd /var/www/myapp
```

## 2. Environment Configuration

Create the server env file:

```bash
cd /var/www/myapp
cp .env.example .env
chmod 600 .env
```

Replace every `CHANGE_ME` before starting production.

Required security values:

```bash
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_JWT_SECRET=$(openssl rand -hex 32)
ASSET_URL_SECRET=$(openssl rand -hex 32)
ADMIN_BOOTSTRAP_USERNAME=origin-admin
ADMIN_BOOTSTRAP_PASSWORD=CHANGE_ME_STRONG_PASSWORD
VEVDEMO_CALLBACK_SECRET=$(openssl rand -hex 32)
```

`ADMIN_BOOTSTRAP_PASSWORD` must be at least 12 characters and include at least
two character classes. Keep `JWT_SECRET`, `ADMIN_JWT_SECRET`, and
`ASSET_URL_SECRET` different.

Required runtime paths:

```bash
ORIGIN_DATA_DIR=/var/lib/origin/data
DB_PATH=/var/lib/origin/data/qd.sqlite
ORIGIN_SQLITE_BACKUP_DIR=/var/lib/origin/data/backups
```

In Docker Compose these paths refer to the container. The host bind mount is
`/var/www/myapp/data`.

Required public VevDemo values for the example Nginx layout:

```bash
ORIGIN_PUBLIC_BASE_URL=https://origin.tj.cn
ADMIN_ALLOWED_ORIGINS=https://origin.tj.cn,https://www.origin.tj.cn
VEVDEMO_EDITOR_URL=https://origin.tj.cn/vevdemo/
VEVDEMO_API_URL=https://origin.tj.cn/vevdemo-api
VEVDEMO_EDITOR_PROJECT_URL=https://origin.tj.cn/vevdemo/
VITE_VEVDEMO_API_BASE=https://origin.tj.cn/vevdemo-api
```

`VEVDEMO_BASE_PATH` is owned by `docker-compose.yml` and `Dockerfile`; do not
add it to the production `.env`.

## 3. Data Directory

Create the persistent data directory:

```bash
cd /var/www/myapp
mkdir -p data/bgm
```

For a clean first deployment, copy only seed BGM from a trusted local checkout:

```bash
rsync -a /path/to/local/origin/data/bgm/ /var/www/myapp/data/bgm/
```

Do not copy local `data/qd.sqlite`, local generated media, local `.env.local`,
or local `node_modules` into production.

## 4. Docker Compose

Build and start:

```bash
cd /var/www/myapp
docker compose build
docker compose up -d
```

The Dockerfile defaults to `docker.1panel.live/library/node:20-bookworm-slim`
because the current server cannot reliably reach Docker Hub. Override it with
`NODE_IMAGE=<registry>/library/node:20-bookworm-slim docker compose build` if
your server uses another registry.

Provision the workspace smoke account after `.env` contains
`ORIGIN_WORKSPACE_SMOKE_PHONE` and `ORIGIN_WORKSPACE_SMOKE_PASSWORD`:

```bash
docker compose exec origin-web npm run provision:workspace-smoke
```

Run the production health check:

```bash
docker compose exec origin-web npm run health:production
curl -fsS http://127.0.0.1:3000/api/health
```

## 5. Nginx Reverse Proxy

Issue the initial certificate before enabling the HTTPS config:

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d origin.tj.cn -d www.origin.tj.cn
sudo systemctl start nginx
```

For a fresh server only, install the example Nginx config:

```bash
cd /var/www/myapp
sudo cp nginx.conf.example /etc/nginx/sites-available/origin
sudo ln -sf /etc/nginx/sites-available/origin /etc/nginx/sites-enabled/origin
sudo nginx -t
sudo systemctl reload nginx
```

For an existing server, do not copy `nginx.conf.example` over the live config.
Inspect `/etc/nginx/sites-available/origin.conf` first and only hand-edit the
specific server names or proxy locations needed; overwriting it can remove
Certbot-managed TLS directives.

Renewal is handled by the certbot system timer:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

## 6. Deployment Script

Normal deploy:

```bash
cd /var/www/myapp
bash scripts/deploy.sh
```

The script runs:

- `git fetch --all --prune`
- `git pull --ff-only`
- `docker compose build`
- `docker compose up -d --remove-orphans`
- `curl` health checks against `http://127.0.0.1:3000/api/health`
- Docker Compose status and logs on failure

Override defaults when needed:

```bash
APP_DIR=/var/www/myapp HEALTH_URL=http://127.0.0.1:3000/api/health bash scripts/deploy.sh
```

## 7. Clean Redeployment

Use this only when production users, projects, media, credits, and subscription
state may be discarded.

```bash
cd /var/www/myapp
docker compose down
rm -rf data
mkdir -p data/bgm
rsync -a /path/to/local/origin/data/bgm/ /var/www/myapp/data/bgm/
bash scripts/deploy.sh
docker compose exec origin-web npm run provision:workspace-smoke
docker compose exec origin-web npm run health:production
```

SQLite is not created manually. The app creates tables on first database open.
The first production admin is created from `ADMIN_BOOTSTRAP_USERNAME` and
`ADMIN_BOOTSTRAP_PASSWORD`.

## 8. Logs and Operations

List containers:

```bash
docker compose ps
```

Tail all logs:

```bash
docker compose logs -f --tail=200
```

Tail one service:

```bash
docker compose logs -f --tail=200 origin-web
docker compose logs -f --tail=200 origin-worker
docker compose logs -f --tail=200 vevdemo-api
docker compose logs -f --tail=200 vevdemo-fe
```

Restart services:

```bash
docker compose restart origin-web origin-worker
docker compose restart vevdemo-api vevdemo-fe
```

## 9. Health Checks

Run:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/workspace >/dev/null
curl -fsS http://127.0.0.1:3000/api/config/client >/dev/null
docker compose exec origin-web npm run health:production
```

From a local checkout, compare production with local:

```bash
bash scripts/check-prod-vs-local.sh
```

## 10. Rollback

Rollback to the previous Git commit:

```bash
cd /var/www/myapp
bash scripts/rollback.sh
```

Rollback to a specific commit or tag:

```bash
cd /var/www/myapp
bash scripts/rollback.sh <commit-or-tag>
```

The rollback script resets code, rebuilds images, restarts services, checks
health, and prints recent logs on failure. It does not delete the data volume.

## 11. Local Verification Before Push

Run before handing a deployment commit to the server:

```bash
npm run typecheck
npm run test:production-secret-safety
npm run test:cache-busting
npm run build:workspace-css
npm run build
```

`npm run lint` currently invokes `next lint`, but this repository does not have
a completed ESLint setup. Record its output, but do not treat it as a production
release gate until ESLint is configured.
