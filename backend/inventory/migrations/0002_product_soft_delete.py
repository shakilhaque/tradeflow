"""
Add soft-delete fields to Product.

is_deleted  — hides the row from the default manager
deleted_at  — timestamp when the product was soft-deleted

The SoftDeleteManager default filters is_deleted=False so all existing
ORM queries continue to work without modification.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="product",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True, editable=False),
        ),
        migrations.AddField(
            model_name="product",
            name="deleted_at",
            field=models.DateTimeField(null=True, blank=True, editable=False),
        ),
        # Additional performance indexes requested in the BRD
        migrations.AddIndex(
            model_name="product",
            index=models.Index(fields=["name"],    name="product_name_idx"),
        ),
        migrations.AddIndex(
            model_name="product",
            index=models.Index(fields=["sku"],     name="product_sku_idx"),
        ),
        migrations.AddIndex(
            model_name="product",
            index=models.Index(fields=["is_active", "is_deleted"], name="product_active_idx"),
        ),
    ]
