import uuid
from decimal import Decimal

import django.db.models.deletion
from django.db import migrations, models


def _to_decimal(v, default=Decimal("0")):
    if v is None or v == "":
        return default
    try:
        return Decimal(str(v))
    except Exception:
        return default


def migrate_meta_variations_forward(apps, schema_editor):
    """
    Promote any variations that were previously stored as JSON inside
    Product.meta.variations[] to real Variation rows. Idempotent — products
    that already have Variation rows in the new table are skipped so this
    migration is safe to re-run.
    """
    Product   = apps.get_model("inventory", "Product")
    Variation = apps.get_model("inventory", "Variation")
    db        = schema_editor.connection.alias

    for product in Product.objects.using(db).all():
        meta = product.meta or {}
        rows = meta.get("variations") or []
        if not rows:
            continue
        if Variation.objects.using(db).filter(product=product).exists():
            continue  # already migrated
        variation_type = (meta.get("variation_type") or "")[:50]
        for idx, row in enumerate(rows):
            Variation.objects.using(db).create(
                id            = uuid.uuid4(),
                product       = product,
                type          = variation_type,
                value         = (row.get("value") or "")[:100],
                sku           = (row.get("sku") or "")[:50],
                cost_price    = _to_decimal(row.get("exc_tax")),
                selling_price = _to_decimal(row.get("selling")),
                image_url     = (row.get("image_url") or "")[:500],
                sort_order    = idx,
                is_active     = True,
            )


def migrate_meta_variations_backward(apps, schema_editor):
    """No-op — we don't drop the Variation rows on reverse to avoid
    accidental data loss. The migration's CreateModel step takes care of
    removing the table when fully reversed."""
    return


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0008_merge_stock_transfer"),
    ]

    operations = [
        migrations.CreateModel(
            name="Variation",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False,
                        primary_key=True, serialize=False,
                    ),
                ),
                ("type",          models.CharField(blank=True, max_length=50)),
                ("value",         models.CharField(max_length=100)),
                ("sku",           models.CharField(blank=True, db_index=True, max_length=50)),
                ("cost_price",    models.DecimalField(decimal_places=4, default=Decimal("0"), max_digits=14)),
                ("selling_price", models.DecimalField(decimal_places=4, default=Decimal("0"), max_digits=14)),
                ("image_url",     models.URLField(blank=True, default="", max_length=500)),
                ("sort_order",    models.PositiveIntegerField(db_index=True, default=0)),
                ("is_active",     models.BooleanField(db_index=True, default=True)),
                ("created_at",    models.DateTimeField(auto_now_add=True)),
                ("updated_at",    models.DateTimeField(auto_now=True)),
                (
                    "product",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="variations",
                        to="inventory.product",
                    ),
                ),
            ],
            options={
                "db_table": "product_variations",
                "ordering": ["sort_order", "created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="variation",
            index=models.Index(
                fields=["product", "sort_order"], name="variation_prod_order_idx",
            ),
        ),
        migrations.RunPython(
            migrate_meta_variations_forward,
            migrate_meta_variations_backward,
        ),
    ]
