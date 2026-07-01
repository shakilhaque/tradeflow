"""Re-enable JWT auth for already-suspended tenants.

Suspension used to set ``is_active = False``, which made SimpleJWT reject every
request from a suspended tenant with "User is inactive" — so they couldn't load
their billing status or pay their bill to reopen. Suspension is now enforced by
``status`` + middleware only, so flip existing suspended users back to
``is_active = True``.
"""
from django.db import migrations


def reactivate_suspended(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    User.objects.filter(status="suspended", is_active=False).update(is_active=True)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0027_coupons"),
    ]

    operations = [
        migrations.RunPython(reactivate_suspended, noop),
    ]
