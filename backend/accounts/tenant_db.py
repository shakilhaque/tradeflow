"""
Tenant database utilities.

Responsibilities
────────────────
• Thread-local state  — middleware writes the current alias; the DB router reads it.
• Deterministic naming — build_db_alias / build_db_name from a user UUID.
• Dynamic registration — register_tenant_db adds an alias to settings.DATABASES at
  runtime so the ORM can open connections to it (idempotent).
• PostgreSQL provisioning — create_postgres_database uses psycopg2 with autocommit
  because CREATE DATABASE cannot run inside a transaction block.
• Migration runner — run_tenant_migrations applies all pending tenant-app migrations
  to a newly created database.
• High-level helper — provision_tenant ties all of the above together and is called
  from the Celery task (runs outside of any Django transaction).
"""
import logging
import re
import threading
from typing import Optional, Tuple

import psycopg2
from psycopg2 import sql

from django.conf import settings
from django.db import connections
from django.utils import timezone

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Thread-local state
# Written by: TenantMiddleware (once per request)
# Read by:    TenantDatabaseRouter (once per ORM query)
# ──────────────────────────────────────────────────────────────────────────────

_thread_locals = threading.local()


def set_current_db_alias(alias: Optional[str]) -> None:
    _thread_locals.db_alias = alias


def get_current_db_alias() -> Optional[str]:
    return getattr(_thread_locals, "db_alias", None)


def clear_current_db_alias() -> None:
    _thread_locals.db_alias = None


# ──────────────────────────────────────────────────────────────────────────────
# Active branch (multi-branch data isolation)
# ──────────────────────────────────────────────────────────────────────────────
# The active branch is the Location (branch) the signed-in user has selected
# for the current request, conveyed via the `X-Branch-Id` header and validated
# by BranchMiddleware against the user's branch memberships. `None` means
# "consolidated / all branches" (tenant owner only). Phase-2+ querysets read
# this to scope per-branch data.

def set_current_branch_id(branch_id) -> None:
    _thread_locals.branch_id = str(branch_id) if branch_id else None


def get_current_branch_id() -> Optional[str]:
    return getattr(_thread_locals, "branch_id", None)


def clear_current_branch_id() -> None:
    _thread_locals.branch_id = None


# ──────────────────────────────────────────────────────────────────────────────
# Identifier helpers — human-readable DB names slugged from business_name
# ──────────────────────────────────────────────────────────────────────────────

# Postgres identifier limit is 63 chars. We reserve 8 chars for a uniqueness
# suffix like "_2"/"_3"/… so the base part is capped at 55.
_MAX_BASE_LEN = 55


def _slugify_for_db(s: str) -> str:
    """
    Turn a free-text label into a PostgreSQL-safe identifier fragment.
    Lowercase, alphanumerics + underscores only, no leading digit.
    """
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if s and s[0].isdigit():
        s = f"t_{s}"
    return s or "tenant"


def _pick_label(user) -> str:
    """
    Choose the friendliest available label for a user, in priority order:
    business_name → name → username → id.
    """
    if hasattr(user, "business_name"):
        return (
            getattr(user, "business_name", None)
            or getattr(user, "name", None)
            or getattr(user, "username", None)
            or str(getattr(user, "id", user))
        )
    return str(user)  # legacy: raw uuid string


def build_tenant_identifiers(user) -> Tuple[str, str]:
    """
    Return a deterministic, unique (db_alias, db_name) pair for this user.

    Slugifies the user's business name (or display name) so DB names look like:
        db_name  = "saas_ongko_stationery"
        db_alias = "tenant_ongko_stationery"

    If another tenant already owns that slug, appends "_2", "_3", … to stay unique.
    """
    from accounts.models import Tenant  # local import — avoids circular

    slug       = _slugify_for_db(_pick_label(user))
    base_alias = f"tenant_{slug}"[:_MAX_BASE_LEN]
    base_name  = f"saas_{slug}"[:_MAX_BASE_LEN]

    # Exclude this user's own Tenant row from the uniqueness check, otherwise
    # callers (e.g. rename_tenant_dbs) would always re-claim their existing
    # hex name as if it were a collision.
    own_id = getattr(user, "id", None)
    busy_alias = set(
        Tenant.objects.exclude(user_id=own_id).values_list("db_alias", flat=True)
    )
    busy_name = set(
        Tenant.objects.exclude(user_id=own_id).values_list("db_name", flat=True)
    )

    candidate_alias = base_alias
    candidate_name  = base_name
    i = 2
    while candidate_alias in busy_alias or candidate_name in busy_name:
        candidate_alias = f"{base_alias}_{i}"
        candidate_name  = f"{base_name}_{i}"
        i += 1
    return candidate_alias, candidate_name


# Backwards-compatible single-purpose helpers. Internal callers should prefer
# build_tenant_identifiers() so the alias/name pair stays in sync.
def build_db_alias(user) -> str:
    """Return the Django DATABASES key for this user (e.g. 'tenant_ongko_stationery')."""
    if isinstance(user, str) and "-" in user:
        # Legacy hex-style fallback for callers that still pass a raw UUID.
        return f"tenant_{user.replace('-', '')[:12]}"
    alias, _ = build_tenant_identifiers(user)
    return alias


def build_db_name(user) -> str:
    """Return the PostgreSQL database name for this user (e.g. 'saas_ongko_stationery')."""
    if isinstance(user, str) and "-" in user:
        return f"saas_tenant_{user.replace('-', '')[:12]}"
    _, name = build_tenant_identifiers(user)
    return name


# ──────────────────────────────────────────────────────────────────────────────
# Dynamic DB registration
# ──────────────────────────────────────────────────────────────────────────────

def _master_conn_params() -> dict:
    """Extract connection params from the master (default) database config."""
    m = settings.DATABASES["default"]
    return {
        "ENGINE":   m.get("ENGINE", "django.db.backends.postgresql"),
        "USER":     m.get("USER", ""),
        "PASSWORD": m.get("PASSWORD", ""),
        "HOST":     m.get("HOST", "localhost"),
        "PORT":     str(m.get("PORT", "5432")),
    }


def register_tenant_db(db_alias: str, db_name: str) -> None:
    """
    Add the tenant database to settings.DATABASES if not already registered.
    Must be called before any ORM query targeting this alias.
    Safe to call repeatedly (idempotent).
    """
    if db_alias in settings.DATABASES:
        return

    p = _master_conn_params()
    settings.DATABASES[db_alias] = {
        "ENGINE":            p["ENGINE"],
        "NAME":              db_name,
        "USER":              p["USER"],
        "PASSWORD":          p["PASSWORD"],
        "HOST":              p["HOST"],
        "PORT":              p["PORT"],
        "CONN_MAX_AGE":      getattr(settings, "TENANT_DB_CONN_MAX_AGE", 60),
        "OPTIONS":           {"connect_timeout": 10},
        # Required by Django's DatabaseWrapper.check_settings() — must be
        # present even if None; Django's ensure_defaults() normally sets these
        # but it only runs at startup, not for dynamically registered databases.
        "TIME_ZONE":         None,
        "ATOMIC_REQUESTS":   False,
        "AUTOCOMMIT":        True,
        "CONN_HEALTH_CHECKS": False,
        "TEST":              {},
    }
    logger.info("Registered tenant DB: alias=%s  name=%s", db_alias, db_name)


# ──────────────────────────────────────────────────────────────────────────────
# PostgreSQL database creation
# ──────────────────────────────────────────────────────────────────────────────

def create_postgres_database(db_name: str) -> bool:
    """
    Connect to the PostgreSQL 'postgres' maintenance database and issue
    CREATE DATABASE <db_name>.

    Autocommit is required — CREATE DATABASE is forbidden inside a
    transaction block.  Returns True if the database was created,
    False if it already existed (idempotent).
    """
    p = _master_conn_params()
    conn = psycopg2.connect(
        dbname="postgres",
        user=p["USER"],
        password=p["PASSWORD"],
        host=p["HOST"],
        port=p["PORT"],
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (db_name,)
            )
            if cur.fetchone():
                logger.info("Database '%s' already exists — skipping creation.", db_name)
                return False

            cur.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name))
            )
            logger.info("Created PostgreSQL database: %s", db_name)
            return True
    finally:
        conn.close()


# ──────────────────────────────────────────────────────────────────────────────
# Migration runner
# ──────────────────────────────────────────────────────────────────────────────

def run_tenant_migrations(db_alias: str) -> None:
    """
    Apply all pending migrations to the tenant database.

    The TenantDatabaseRouter.allow_migrate() ensures only non-master-app
    migrations are executed here (master-app tables stay in 'default').

    Closes any stale pooled connection before running to avoid
    "connection already closed" errors after a fresh DB creation.
    """
    from django.core.management import call_command

    # Flush stale connection (the DB was just created — no existing pool entry).
    if db_alias in connections:
        connections[db_alias].close()

    logger.info("Running migrations on tenant DB: alias=%s", db_alias)
    call_command(
        "migrate",
        "--database", db_alias,
        verbosity=0,
        interactive=False,
    )
    logger.info("Migrations complete for tenant DB: alias=%s", db_alias)


# ──────────────────────────────────────────────────────────────────────────────
# High-level provisioning — called by the Celery task
# ──────────────────────────────────────────────────────────────────────────────

def provision_tenant(user_id: str) -> None:
    """
    Full tenant database provisioning pipeline:

      1. Build deterministic DB name and alias.
      2. Create the physical PostgreSQL database (autocommit / idempotent).
      3. Register the alias in settings.DATABASES.
      4. Run all tenant-app migrations against the new database.
      5. Mark the Tenant record as provisioned.

    This function is intentionally not wrapped in a Django transaction —
    it spans multiple databases and relies on psycopg2 autocommit for
    step 2.  Celery handles retries on failure.
    """
    # Local import — avoids circular dependency at module load time.
    from accounts.models import Tenant  # noqa: PLC0415

    # The Tenant row was created with the names already resolved
    # (slug-from-business-name). Read them back so creation, registration
    # and migration all target the same database.
    tenant_row = Tenant.objects.filter(user_id=user_id).first()
    if tenant_row and tenant_row.db_name and tenant_row.db_alias:
        db_alias = tenant_row.db_alias
        db_name  = tenant_row.db_name
    else:
        # Defensive fallback for legacy/test rows that lack stored names.
        from accounts.models import User  # noqa: PLC0415
        user = User.objects.get(pk=user_id)
        db_alias, db_name = build_tenant_identifiers(user)

    logger.info(
        "Provisioning tenant DB: user_id=%s  alias=%s  name=%s",
        user_id, db_alias, db_name,
    )

    # 1+2. Create the physical database.
    create_postgres_database(db_name)

    # 3. Make Django aware of it.
    register_tenant_db(db_alias, db_name)

    # 4. Migrate tenant-app tables.
    run_tenant_migrations(db_alias)

    # 4.1 Seed baseline inventory master data so product creation works
    # immediately for every newly provisioned tenant.
    from inventory.services import ensure_default_master_data  # noqa: PLC0415
    ensure_default_master_data(db_alias=db_alias)

    # 5. Mark ready in master DB.
    Tenant.objects.filter(user_id=user_id).update(
        is_provisioned=True,
        provisioned_at=timezone.now(),
    )
    logger.info("Tenant provisioning complete: user_id=%s", user_id)
