"""Schema migration — add the `register_closures` table on every tenant DB.

The table records each "Close Register" event a cashier triggers from
the POS. The Register Details endpoint uses the latest row per
(user × location) as the lower bound of the "current register" window
so the next session starts fresh.

Defensive: wrapped so it's a no-op on tenant DBs that already have
the table (e.g. partial reruns during deploy). New tenants get the
table on first provisioning via the standard migrate flow.
"""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales",     "0016_normalize_customer_phones"),
        ("inventory", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="RegisterClosure",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("user_id", models.UUIDField(db_index=True, help_text="UUID of the cashier who closed the register.")),
                ("closed_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("expected_cash",   models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("expected_card",   models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("expected_cheque", models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("expected_total",  models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("counted_cash",    models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("counted_card",    models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("counted_cheque",  models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("closing_note",    models.TextField(blank=True, default="")),
                ("location", models.ForeignKey(
                    blank=True, null=True,
                    on_delete=models.deletion.PROTECT,
                    related_name="register_closures",
                    to="inventory.location",
                )),
            ],
            options={
                "db_table": "register_closures",
                "ordering": ["-closed_at"],
                "indexes":  [models.Index(fields=["user_id", "location", "closed_at"], name="rc_user_loc_date_idx")],
            },
        ),
    ]
