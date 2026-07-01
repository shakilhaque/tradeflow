from decimal import Decimal
import uuid

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0001_initial"),
        ("sales", "0006_sellreturn"),
    ]

    operations = [
        migrations.CreateModel(
            name="Discount",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(db_index=True, max_length=140)),
                ("starts_at", models.DateTimeField()),
                ("ends_at", models.DateTimeField()),
                ("discount_amount", models.DecimalField(decimal_places=2, default=Decimal("0"), max_digits=14)),
                ("priority", models.PositiveIntegerField(db_index=True, default=1)),
                ("brand", models.CharField(blank=True, default="", max_length=120)),
                ("category", models.CharField(blank=True, default="", max_length=120)),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("created_by_id", models.UUIDField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("location", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="discount_rules", to="inventory.location")),
                ("products", models.ManyToManyField(blank=True, related_name="discount_rules", to="inventory.product")),
            ],
            options={
                "db_table": "discounts",
                "ordering": ["-priority", "-created_at"],
            },
        ),
    ]
