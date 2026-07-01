"""
Add soft-delete fields to Customer.

is_deleted  — hides the customer from default queryset
deleted_at  — timestamp when the customer was soft-deleted
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("sales", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="customer",
            name="is_deleted",
            field=models.BooleanField(default=False, db_index=True, editable=False),
        ),
        migrations.AddField(
            model_name="customer",
            name="deleted_at",
            field=models.DateTimeField(null=True, blank=True, editable=False),
        ),
        # Performance index on customer name search
        migrations.AddIndex(
            model_name="customer",
            index=models.Index(fields=["name", "is_deleted"], name="customer_name_del_idx"),
        ),
    ]
