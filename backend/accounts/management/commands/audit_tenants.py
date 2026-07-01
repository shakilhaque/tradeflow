"""
Tenant + subscription audit — find every kind of inconsistency in one pass.

What it looks for
─────────────────
1.  PAID_NOT_PROVISIONED   — Payment.SUCCESS + Tenant exists + is_provisioned=False.
                             (The "logged in but nothing works" state. Repairable.)
2.  PAID_NO_TENANT_ROW     — Payment.SUCCESS for a User that has no Tenant row.
                             (Webhook crashed between user-creation and tenant-creation.)
3.  PAID_NO_USER           — Payment.SUCCESS where Payment.user_id is NULL.
                             (Webhook crashed even earlier. Money received, nothing built.)
4.  TENANT_DB_MISSING      — Tenant.is_provisioned=True but the PostgreSQL database
                             doesn't actually exist on disk. (Disk loss, manual drop, restore from old backup.)
5.  ORPHAN_USER            — User exists, no SUCCESS payment, no trial subscription,
                             no tenant row. (Created via shell, never paid.)
6.  STALE_PENDING_PAYMENT  — Payment.PENDING older than 24h. (User dropped off mid-payment;
                             probably safe to mark FAILED.)

Usage
─────
    # quick summary (exits 0 when healthy, 1 when issues found)
    python manage.py audit_tenants

    # full per-row detail
    python manage.py audit_tenants --details

    # machine-readable for cron / dashboards
    python manage.py audit_tenants --json

    # auto-repair what's safely repairable (currently: PAID_NOT_PROVISIONED only)
    python manage.py audit_tenants --repair

Suitable as a cron:
    */30 * * * * cd /var/www/html/nsl-iffaa-application/backend && \
        .venv/bin/python manage.py audit_tenants --json > /var/log/iffaa/tenant-audit.json 2>&1 \
        || echo "tenant audit found issues" | mail -s "[IFFAA] tenant audit" ops@example.com
"""
from __future__ import annotations

import json
import sys
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import connection
from django.utils import timezone

from accounts.models import Payment, Tenant, User
from accounts.tenant_db import provision_tenant


# Order matters — most actionable first.
ISSUE_LABELS = [
    ("paid_not_provisioned",  "PAID but tenant DB NOT PROVISIONED"),
    ("paid_no_tenant_row",    "PAID but no Tenant row exists"),
    ("paid_no_user",          "PAID but no User row exists (orphan payment)"),
    ("tenant_db_missing",     "Provisioned=True but PostgreSQL DB missing"),
    ("orphan_user",           "User without payment, trial, or tenant"),
    ("stale_pending_payment", "Pending payment older than 24h"),
]


class Command(BaseCommand):
    help = "Audit tenants + subscriptions for inconsistencies. Exit 1 if any found."

    def add_arguments(self, parser):
        parser.add_argument(
            # NOTE: Django's BaseCommand already reserves -v for its
            # verbosity level (0/1/2/3), so we only expose --details here.
            # Don't add a short alias.
            "--details",
            action="store_true",
            help="Print every offending row, not just counts.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit the full report as a single JSON object (for cron/dashboards).",
        )
        parser.add_argument(
            "--repair",
            action="store_true",
            help="Attempt to auto-repair PAID_NOT_PROVISIONED rows.",
        )

    def handle(self, *args, **opts):
        report = self._collect()

        if opts["json"]:
            self._emit_json(report, repair=opts["repair"])
        else:
            self._emit_human(report, details=opts["details"], repair=opts["repair"])

        if opts["repair"]:
            repaired, failed = self._repair_paid_not_provisioned(report["paid_not_provisioned"])
            if not opts["json"]:
                self.stdout.write("")
                self.stdout.write(self.style.SUCCESS(
                    f"Repair: {repaired} provisioned, {failed} failed."
                ))
            if failed:
                sys.exit(1)
            # If repair cleared everything, exit clean even if pre-repair was dirty.
            if repaired and not any(report[k] for k, _ in ISSUE_LABELS if k != "paid_not_provisioned"):
                return

        if any(report[k] for k, _ in ISSUE_LABELS):
            sys.exit(1)

    # ── Detection ─────────────────────────────────────────────────────────────

    def _collect(self) -> dict[str, list[dict]]:
        now = timezone.now()
        stale_cutoff = now - timedelta(hours=24)

        # 1. PAID_NOT_PROVISIONED — successful payment, tenant exists, not provisioned.
        paid_not_provisioned = list(
            Tenant.objects
            .filter(
                is_provisioned=False,
                user__payments__status=Payment.Status.SUCCESS,
            )
            .select_related("user")
            .distinct()
            .values("user_id", "user__email", "user__phone", "db_name", "db_alias", "created_at")
        )

        # 2. PAID_NO_TENANT_ROW — user paid, but no Tenant row.
        paid_no_tenant_row = list(
            User.objects
            .filter(
                payments__status=Payment.Status.SUCCESS,
                tenant__isnull=True,
                parent_owner__isnull=True,  # sub-users legitimately have no tenant row
            )
            .distinct()
            .values("id", "email", "phone", "created_at")
        )

        # 3. PAID_NO_USER — successful payment with no user_id attached.
        paid_no_user = list(
            Payment.objects
            .filter(status=Payment.Status.SUCCESS, user__isnull=True)
            .values("transaction_id", "amount", "paid_at", "metadata")
        )

        # 4. TENANT_DB_MISSING — Postgres says no such DB but we think we provisioned one.
        provisioned = list(
            Tenant.objects
            .filter(is_provisioned=True)
            .values_list("db_name", flat=True)
        )
        existing = self._existing_pg_databases(set(provisioned))
        missing  = sorted(set(provisioned) - existing)
        tenant_db_missing = [
            {"db_name": name, **self._tenant_info_by_db(name)}
            for name in missing
        ]

        # 5. ORPHAN_USER — exists, never paid, no trial sub, no tenant. Most often
        #    created via createsuperuser or shell — usually fine, but worth listing.
        orphan_user = list(
            User.objects
            .filter(
                payments__isnull=True,
                subscriptions__isnull=True,
                tenant__isnull=True,
                parent_owner__isnull=True,
                is_superuser=False,
                is_staff=False,
            )
            .distinct()
            .values("id", "email", "phone", "created_at")
        )

        # 6. STALE_PENDING_PAYMENT — pending > 24h. Caller abandoned the checkout.
        stale_pending_payment = list(
            Payment.objects
            .filter(status=Payment.Status.PENDING, created_at__lt=stale_cutoff)
            .values("transaction_id", "amount", "created_at", "metadata")
        )

        return {
            "paid_not_provisioned":   paid_not_provisioned,
            "paid_no_tenant_row":     paid_no_tenant_row,
            "paid_no_user":           paid_no_user,
            "tenant_db_missing":      tenant_db_missing,
            "orphan_user":            orphan_user,
            "stale_pending_payment":  stale_pending_payment,
        }

    @staticmethod
    def _existing_pg_databases(candidates: set[str]) -> set[str]:
        """Ask Postgres which of these database names actually exist."""
        if not candidates:
            return set()
        with connection.cursor() as cur:
            cur.execute(
                "SELECT datname FROM pg_database WHERE datname = ANY(%s)",
                [list(candidates)],
            )
            return {row[0] for row in cur.fetchall()}

    @staticmethod
    def _tenant_info_by_db(db_name: str) -> dict:
        t = (
            Tenant.objects
            .filter(db_name=db_name)
            .select_related("user")
            .values("user__email", "user__phone", "db_alias", "provisioned_at")
            .first()
        )
        return t or {}

    # ── Output ────────────────────────────────────────────────────────────────

    def _emit_human(self, report: dict, *, details: bool, repair: bool) -> None:
        total_issues = sum(len(report[k]) for k, _ in ISSUE_LABELS)
        header = "Tenant + subscription audit"
        self.stdout.write(self.style.MIGRATE_HEADING(header))
        self.stdout.write("─" * len(header))

        if total_issues == 0:
            self.stdout.write(self.style.SUCCESS("✓ All clean. No inconsistencies found."))
            return

        for key, label in ISSUE_LABELS:
            rows = report[key]
            if not rows:
                continue
            self.stdout.write("")
            self.stdout.write(self.style.WARNING(f"[{len(rows):>3}]  {label}"))
            if not details:
                continue
            for row in rows[:50]:  # cap at 50 in --details mode to keep output sane
                self.stdout.write("       · " + self._fmt_row(key, row))
            if len(rows) > 50:
                self.stdout.write(f"       … and {len(rows) - 50} more.")

        self.stdout.write("")
        self.stdout.write(self.style.WARNING(f"Total problem rows: {total_issues}"))

        if not repair and report["paid_not_provisioned"]:
            self.stdout.write("")
            self.stdout.write(
                "Repair PAID_NOT_PROVISIONED rows with:\n"
                "    python manage.py audit_tenants --repair\n"
                "Or one at a time:\n"
                "    python manage.py provision_tenant_now <email>"
            )

    def _emit_json(self, report: dict, *, repair: bool) -> None:
        # Make UUIDs / datetimes JSON-safe.
        def _stringify(v):
            if hasattr(v, "isoformat"):
                return v.isoformat()
            return str(v) if v is not None and not isinstance(v, (str, int, float, bool, list, dict)) else v

        clean = {
            k: [{kk: _stringify(vv) for kk, vv in row.items()} for row in v]
            for k, v in report.items()
        }
        out = {
            "checked_at":   timezone.now().isoformat(),
            "issue_counts": {k: len(v) for k, v in clean.items()},
            "total_issues": sum(len(v) for v in clean.values()),
            "issues":       clean,
            "repair_mode":  repair,
        }
        self.stdout.write(json.dumps(out, indent=2, sort_keys=True))

    @staticmethod
    def _fmt_row(key: str, row: dict) -> str:
        if key in ("paid_not_provisioned",):
            return (
                f"{row.get('user__email') or row.get('user__phone') or '?'}  "
                f"db={row.get('db_name')}"
            )
        if key in ("paid_no_tenant_row", "orphan_user"):
            return f"{row.get('email') or row.get('phone') or '?'}  id={row.get('id')}"
        if key == "paid_no_user":
            return f"txn={row.get('transaction_id')}  amount={row.get('amount')}"
        if key == "tenant_db_missing":
            return f"db={row.get('db_name')}  owner={row.get('user__email') or '?'}"
        if key == "stale_pending_payment":
            return (
                f"txn={row.get('transaction_id')}  "
                f"created={row.get('created_at')}  amount={row.get('amount')}"
            )
        return str(row)

    # ── Repair ────────────────────────────────────────────────────────────────

    def _repair_paid_not_provisioned(self, rows: list[dict]) -> tuple[int, int]:
        ok = fail = 0
        for row in rows:
            user_id = row["user_id"]
            email   = row.get("user__email") or row.get("user__phone") or user_id
            try:
                provision_tenant(str(user_id))
                self.stdout.write(self.style.SUCCESS(f"  ✓ repaired {email}"))
                ok += 1
            except Exception as exc:  # noqa: BLE001
                self.stderr.write(self.style.ERROR(f"  ✗ {email}: {exc}"))
                fail += 1
        return ok, fail
