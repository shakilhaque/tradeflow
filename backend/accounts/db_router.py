"""
TenantDatabaseRouter

Routes every ORM query to either:
  • 'default'        — the master PostgreSQL database (accounts, auth, admin …)
  • '<tenant_alias>' — the per-tenant PostgreSQL database (future business models)

How it works
────────────
1. TenantMiddleware resolves the current user's tenant alias from the JWT
   and stores it in a thread-local variable (accounts.tenant_db module).
2. Every ORM call invokes db_for_read / db_for_write here.
3. If the queried app is in MASTER_APPS → 'default'.
   Otherwise → the thread-local alias (or 'default' if none is set, e.g. in
   management commands, Celery tasks that don't set a tenant context, or
   unauthenticated requests).

Migration routing
─────────────────
• `manage.py migrate`                  → master DB only (MASTER_APPS only).
• `manage.py migrate --database alias` → tenant DB only (non-MASTER_APPS).
This prevents cross-contamination: master tables never appear in tenant DBs
and vice versa.
"""
from .tenant_db import get_current_db_alias

# ──────────────────────────────────────────────────────────────────────────────
# Apps whose models always live in the master (default) database.
# Add any third-party or built-in app that should never go to a tenant DB.
# ──────────────────────────────────────────────────────────────────────────────

MASTER_APPS: frozenset = frozenset({
    "accounts",
    "auth",
    "contenttypes",
    "sessions",
    "admin",
    "django_celery_beat",
    "messages",
    # SimpleJWT refresh-token blacklist — its OutstandingToken FKs accounts.User,
    # so its tables must live in the master DB alongside users.
    "token_blacklist",
})


class TenantDatabaseRouter:

    # ── Read / write routing ──────────────────────────────────────────────────

    def _route(self, app_label: str) -> str:
        if app_label in MASTER_APPS:
            return "default"
        alias = get_current_db_alias()
        return alias if alias else "default"

    def db_for_read(self, model, **hints):
        return self._route(model._meta.app_label)

    def db_for_write(self, model, **hints):
        return self._route(model._meta.app_label)

    # ── Relation consistency ──────────────────────────────────────────────────

    def allow_relation(self, obj1, obj2, **hints):
        """
        Allow relations between objects that live in the same DB family.
        Returning None lets other routers decide for cross-family cases.
        """
        l1 = obj1._meta.app_label
        l2 = obj2._meta.app_label
        if (l1 in MASTER_APPS) == (l2 in MASTER_APPS):
            return True   # both in master or both in tenant — allowed
        return None       # undecided; defer to Django's default behaviour

    # ── Migration routing ─────────────────────────────────────────────────────

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if db == "default":
            # Master DB: only accept master-app migrations.
            return app_label in MASTER_APPS
        else:
            # Tenant DB aliases: only accept non-master-app migrations.
            return app_label not in MASTER_APPS
