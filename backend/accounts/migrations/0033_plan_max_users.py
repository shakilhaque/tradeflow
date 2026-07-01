"""
Seed the per-plan "max users" (max_sub_accounts) limits requested by the
business:

    Basic        → 5   (monthly + yearly)
    Standard     → 7   (monthly + yearly)
    Premium      → 10  (monthly + yearly)
    Multi-Branch → 15  (the custom plan)

These are one-time seed values on the master-DB Plan catalogue. The Super
Admin can still change any of them later from Plans → Edit; this migration
only sets a sensible starting point so the plan cards/landing show the
intended limits out of the box. Matching is by name keyword (case-
insensitive) so it is safe across environments where the rows already
exist. Trial plans are left untouched.
"""
from django.db import migrations


# keyword (lower-case, matched with __icontains) → max_sub_accounts
NAME_LIMITS = [
    ("basic",    5),
    ("standard", 7),
    ("premium",  10),
    ("multi",    15),
]


def seed_limits(apps, schema_editor):
    Plan = apps.get_model("accounts", "Plan")

    for keyword, limit in NAME_LIMITS:
        (Plan.objects
            .filter(name__icontains=keyword)
            .exclude(is_trial=True)
            .update(max_sub_accounts=limit))

    # Any custom (Multi-Branch) plan whose name doesn't contain "multi"
    # still gets the 15-user limit.
    (Plan.objects
        .filter(is_custom=True)
        .exclude(is_trial=True)
        .update(max_sub_accounts=15))


def noop(apps, schema_editor):
    # Irreversible seed — there is no meaningful previous value to restore.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0032_user_force_logout_at"),
    ]

    operations = [
        migrations.RunPython(seed_limits, noop),
    ]
