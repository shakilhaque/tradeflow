"""
Shared helper — tenant user dropdown options for report filters.

The Register / Sales Representative / Service Staff reports used to
derive their user dropdowns from the SALE/PAYMENT rows themselves,
which had two visible bugs:

  1. Staff with no recorded activity never appeared (the Register
     report's Cashier filter showed only the owner even though the
     tenant had three cashiers).
  2. Django's `.values_list(..).distinct()` combined with the model's
     default ordering put the ORDER BY column into the DISTINCT
     clause, so the same user appeared once per sale — "Ismail
     Hossain" repeated dozens of times in the dropdown.

This helper lists the tenant's ACTUAL user roster from the master DB
— the same set the User Management page shows (owner + every
sub-user) — deduplicated by construction and sorted by name.
"""


def tenant_user_options(request_user):
    """Return [{id, name, role}] for every user of this tenant."""
    try:
        from django.db.models import Q  # noqa: PLC0415
        from accounts.models import User  # noqa: PLC0415

        owner_id = (
            getattr(request_user, "parent_owner_id", None)
            or getattr(request_user, "id", None)
        )
        if not owner_id:
            return []
        rows = (
            User.objects.using("default")
            .filter(Q(parent_owner_id=owner_id) | Q(id=owner_id))
            .values("id", "name", "email", "role")
        )
        opts = [
            {
                "id":   str(r["id"]),
                "name": r["name"] or r["email"] or "—",
                "role": r["role"] or "",
            }
            for r in rows
        ]
        return sorted(opts, key=lambda x: x["name"].lower())
    except Exception:
        return []
