#!/usr/bin/env bash
# Iffaa Accounting — one-shot redeploy script.
#
# Run as root (or via sudo). Pulls main, installs deps, applies
# migrations to BOTH the master DB and every tenant DB, rebuilds the
# frontend, restarts services, and auto-repairs any tenant left in a
# broken provisioning state.
#
# Idempotent — safe to re-run after a failure.
#
# Override PROJECT_DIR / SERVICE_USER via env if your layout differs:
#   sudo PROJECT_DIR=/srv/iffaa SERVICE_USER=iffaa bash deploy/deploy.sh
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/var/www/html/nsl-iffaa-application}"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
SERVICE_USER="${SERVICE_USER:-www-data}"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
BRANCH="${BRANCH:-main}"

log() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$PROJECT_DIR" ] || die "PROJECT_DIR does not exist: $PROJECT_DIR"
cd "$PROJECT_DIR"

# Git refuses to touch a repo it thinks has dubious ownership (commonly
# when root runs in a www-data-owned tree). Whitelist it once per root user.
git config --global --add safe.directory "$PROJECT_DIR" 2>/dev/null || true

log "1. Backup .env"
if [ -f "$BACKEND_DIR/.env" ]; then
    cp "$BACKEND_DIR/.env" "/root/.env.iffaa.$(date +%Y%m%d-%H%M%S).backup"
else
    printf "  (no .env to back up — fresh install?)\n"
fi

log "2. Pull latest code on branch $BRANCH"
git fetch origin
git reset --hard "origin/$BRANCH"

log "3. Restore .env if reset removed it"
if [ ! -f "$BACKEND_DIR/.env" ]; then
    latest="$(ls -t /root/.env.iffaa.*.backup 2>/dev/null | head -1 || true)"
    if [ -n "$latest" ]; then
        cp "$latest" "$BACKEND_DIR/.env"
        chmod 600 "$BACKEND_DIR/.env"
        printf "  restored from %s\n" "$latest"
    else
        die ".env missing and no backup found in /root/.env.iffaa.*.backup"
    fi
fi

log "4. Update Python deps"
cd "$BACKEND_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet

log "5. Apply migrations to master DB"
python manage.py migrate --noinput

log "6. Apply migrations to EVERY tenant DB (the easy-to-forget step)"
# Brings every existing tenant up to whatever schema the new code expects.
# Tenants that were already at the latest revision are a no-op.
python manage.py migrate_tenants

log "7. Repair any tenant stuck at is_provisioned=False"
# audit_tenants --repair re-runs provision_tenant() on every tenant
# whose payment succeeded but whose DB was never finished (e.g. because
# Celery was down or an earlier migration was broken). Exits non-zero if
# any unrepairable issues remain — we DON'T fail the deploy on that,
# we just surface it.
python manage.py audit_tenants --repair || \
    printf '\n  ⚠ audit_tenants reported issues — review the output above.\n'

log "8. Collect static"
python manage.py collectstatic --noinput

log "9. Frontend build"
cd "$FRONTEND_DIR"
# npm ci needs a clean lock match; fall back to install if jsbarcode-style drift.
npm ci --silent || npm install --silent
npm run build

log "10. Fix ownership (so gunicorn / nginx can read everything)"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR"

log "11. Restart services"
systemctl restart gunicorn
systemctl reload nginx

log "12. Post-deploy tenant health snapshot"
cd "$BACKEND_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
python manage.py audit_tenants || true

printf '\n\033[1;32m✓ Deploy complete — %s\033[0m\n' "$(date)"
