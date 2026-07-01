# Ubuntu server deployment (Iffaa Accounting & POS)

This document describes end-to-end production deployment on **Ubuntu Server 22.04 or 24.04 LTS**.

## What you are deploying

| Layer | Technology | Role |
|--------|------------|------|
| Frontend | React 18 + Vite 5 + Tailwind | Static files under `frontend/dist/` |
| App server | Gunicorn (WSGI) | Django on `127.0.0.1:8003` |
| Reverse proxy | Nginx | Serves SPA, proxies `/api/` and `/admin/`, serves `/static/` and `/media/` |
| Database | PostgreSQL 14+ | Master DB + **CREATEDB** user (per-tenant DBs) |
| Cache / broker | Redis | **Required when `DEBUG=False`** (Django cache + Celery) |
| Background work | Celery + Redis | Subscription jobs, beat schedules (optional but recommended in prod) |

This guide is written for your server layout:

- **Project root**: ` /var/www/html/nsl-iffaa-application `
- **Deploy/service user**: `nsl`
- **Backend dir**: ` /var/www/html/nsl-iffaa-application/backend `
- **Frontend dir**: ` /var/www/html/nsl-iffaa-application/frontend `

Important: `deploy/deploy.sh` defaults to the paths above and can be overridden via env (`PROJECT_DIR=...`). The static unit files `deploy/gunicorn.service` and `deploy/nginx.conf` still have placeholder paths — review and edit them once before copying to `/etc/systemd/system/` and `/etc/nginx/sites-available/` respectively.

---

## 1. Server preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
  git curl build-essential \
  python3.11 python3.11-venv python3-pip \
  nginx postgresql postgresql-contrib \
  redis-server \
  certbot python3-certbot-nginx
```

**Node.js 20 LTS** (for `npm run build`):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

Optional: `ufw` firewall — allow SSH, HTTP, HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

---

## 2. PostgreSQL (master DB + privileged user)

The app provisions **one database per tenant**; the DB user must have **`CREATEDB`**.

```bash
sudo -u postgres psql <<'SQL'
CREATE USER saas_user WITH PASSWORD 'user@1233' CREATEDB;
CREATE DATABASE saas_master OWNER saas_user;
SQL
```

Tune `postgresql.conf` / `pg_hba.conf` if Django runs on another host; for same-machine default `localhost` this is enough.

---

## 3. Redis

With **`DEBUG=False`**, Django uses **Redis** for the default cache (`REDIS_URL`, default `redis://localhost:6379/3`). Celery also expects Redis.

```bash
sudo systemctl enable --now redis-server
redis-cli ping   # expect PONG
```

---

## 4. Application tree and Python venv

```bash
sudo mkdir -p /var/www/html
sudo chown -R nsl:nsl /var/www/html

cd /var/www/html
git clone https://github.com/netspheresolutionslimited/nsl-iffaa-application.git
cd /var/www/html/nsl-iffaa-application/backend

python3.11 -m venv .venv
source .venv/bin/activate

# NEVER use sudo pip inside a venv (it creates root-owned files and breaks installs)
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

`requirements.txt` already includes **gunicorn**; no separate `pip install gunicorn` is required.

---

## 5. Environment file (`backend/.env`)

From the repo root:

```bash
cp .env.example backend/.env
chmod 600 backend/.env
nano backend/.env
```

**Production-oriented minimum:**

| Variable | Notes |
|----------|--------|
| `SECRET_KEY` | Long random string; never reuse dev keys |
| `DEBUG` | `False` |
| `ALLOWED_HOSTS` | Your domain and/or public IP, comma-separated (no spaces) |
| `DATABASE_URL` | `postgresql://saas_user:PASSWORD@127.0.0.1:5432/saas_master` |
| `REDIS_URL` | e.g. `redis://127.0.0.1:6379/3` (must match a running Redis when `DEBUG=False`) |
| `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | Point at Redis DB indices you use |
| `FRONTEND_URL` | Public site URL, e.g. `https://accounting.example.com` |
| `BACKEND_BASE_URL` | Same origin in this layout: same as public URL (Nginx serves API under `/api/`) |
| `EMAIL_*` | Real SMTP for signup / password emails (`django.core.mail.backends.smtp.EmailBackend`) |
| SSL / cookies (behind HTTPS) | Set `SECURE_SSL_REDIRECT`, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE` to `True` when TLS is terminated at Nginx |

Frontend **does not need** `VITE_API_URL` if the browser talks to the **same host** as Nginx: axios uses relative `/api/...` when `VITE_API_URL` is empty (see `frontend/src/api/client.js`).

---

## 6. Django: migrate, static files, superuser

```bash
cd /var/www/html/nsl-iffaa-application/backend
source .venv/bin/activate

python manage.py migrate --noinput
python manage.py migrate_tenants
python manage.py collectstatic --noinput
python manage.py createsuperuser   # optional, for /admin/
```

Ensure directories exist for logs/media if you use local media (Nginx `alias` expects them):

```bash
sudo mkdir -p /var/www/html/nsl-iffaa-application/backend/media
sudo mkdir -p /var/www/html/nsl-iffaa-application/backend/staticfiles

# For a simple single-server setup, keep ownership with the deploy user and allow Nginx read-access.
sudo chown -R nsl:nsl /var/www/html/nsl-iffaa-application/backend/media
sudo chown -R nsl:nsl /var/www/html/nsl-iffaa-application/backend/staticfiles
chmod 755 /var/www/html/nsl-iffaa-application/backend/media /var/www/html/nsl-iffaa-application/backend/staticfiles
```

---

## 7. Frontend production build

```bash
cd /var/www/html/nsl-iffaa-application/frontend
npm ci
npm run build
```

Confirm `frontend/dist/index.html` exists.

---

## 8. Gunicorn (systemd)

1. Update `deploy/gunicorn.service` to match your paths and user:

- `WorkingDirectory=/var/www/html/nsl-iffaa-application/backend`
- `Environment=\"PATH=/var/www/html/nsl-iffaa-application/backend/.venv/bin\"`
- `EnvironmentFile=/var/www/html/nsl-iffaa-application/backend/.env`
- Prefer `User=nsl` / `Group=nsl` (instead of `root`)

2. Install the unit:

```bash
sudo cp /var/www/html/nsl-iffaa-application/deploy/gunicorn.service /etc/systemd/system/gunicorn.service
sudo systemctl daemon-reload
sudo systemctl enable --now gunicorn
sudo systemctl status gunicorn
```

If the service **times out** on start with `Type=notify`, switch the unit to `Type=simple` or consult [Gunicorn + systemd](https://docs.gunicorn.org/en/stable/deploy.html) for your Gunicorn version.

Logs (this guide prefers journal-only):

```bash
sudo journalctl -u gunicorn -f
```

---

## 9. Nginx

1. Set `server_name` in `deploy/nginx.conf` to your **domain**.

- If you haven't decided yet, use a placeholder and replace later.
- Placeholder: `server_name your.domain.example;`

2. Install the site:

```bash
sudo cp /var/www/html/nsl-iffaa-application/deploy/nginx.conf /etc/nginx/sites-available/iffaa-acc
sudo ln -sf /etc/nginx/sites-available/iffaa-acc /etc/nginx/sites-enabled/iffaa-acc
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS (after DNS points to the server):

```bash
sudo certbot --nginx -d your.domain.example
```

---

## 10. Celery (recommended in production)

When `DEBUG=False`, Celery is **not** eager; subscription and scheduled tasks need workers.

Example (run under `screen`, `tmux`, or separate systemd units from `backend/` with venv activated):

```bash
cd /var/www/html/nsl-iffaa-application/backend
source .venv/bin/activate
celery -A config worker -l info
# separate process:
celery -A config beat -l info
```

Use `django-celery-beat`’s database scheduler (already configured in settings). Ensure Redis and `CELERY_BROKER_URL` match.

---

## 11. Ongoing redeploys

One command does the entire deploy:

```bash
sudo bash /var/www/html/nsl-iffaa-application/deploy/deploy.sh
```

In order, this:

1. Backs up `backend/.env` under `/root/.env.iffaa.<timestamp>.backup`.
2. `git fetch && git reset --hard origin/main` (override branch with `BRANCH=microservices-scaffold` env if needed).
3. Restores `.env` if the reset removed it (recovers from accidental commits).
4. `pip install -r requirements.txt`.
5. `migrate` on the **master** DB.
6. `migrate_tenants` on **every** tenant DB — the easy-to-forget step that brings existing tenants to the same schema as fresh signups.
7. `audit_tenants --repair` — auto-fixes any tenant left at `is_provisioned=False` (e.g. Niloy / abc cases).
8. `collectstatic`.
9. `npm ci && npm run build` (falls back to `npm install` if the lockfile drifted).
10. `chown -R www-data:www-data` so gunicorn/nginx can read everything.
11. `systemctl restart gunicorn && systemctl reload nginx`.
12. Prints a final `audit_tenants` snapshot so you see the post-deploy tenant health.

Override paths via env if your server layout differs:

```bash
sudo PROJECT_DIR=/srv/iffaa SERVICE_USER=iffaa bash deploy/deploy.sh
```

If any step fails the script aborts with a clear marker — re-run after fixing.

---

## 12. Logs and operations

```bash
# Gunicorn (systemd)
sudo journalctl -u gunicorn -f

# Nginx
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

| Goal | Command |
|------|---------|
| Restart Django only | `sudo systemctl restart gunicorn` |
| Reload Nginx | `sudo nginx -t && sudo systemctl reload nginx` |
| Stop app | `sudo systemctl stop gunicorn` |

---

## 13. Checklist before go-live

- [ ] `DEBUG=False`, strong `SECRET_KEY`, correct `ALLOWED_HOSTS`
- [ ] PostgreSQL user has `CREATEDB`; `DATABASE_URL` correct
- [ ] Redis running; `REDIS_URL` and Celery URLs valid
- [ ] Real email backend for registration / password flows
- [ ] `collectstatic` run; Nginx `/static/` matches `STATIC_ROOT`
- [ ] TLS + secure cookie flags if using HTTPS
- [ ] Celery worker + beat running for background jobs
- [ ] Firewall and SSH hardening per your org policy

---

## File reference

| File | Purpose |
|------|---------|
| `deploy/gunicorn.service` | systemd unit for Gunicorn |
| `deploy/nginx.conf` | Site: SPA + `/api/` + `/admin/` + static/media |
| `deploy/deploy.sh` | Idempotent redeploy script |

Repository overview: see the root `README.md`.
