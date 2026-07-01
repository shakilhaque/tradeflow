"""Add Unit.allow_decimal, Category.code/description, and Warranty model."""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0005_product_extra_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="unit",
            name="allow_decimal",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="category",
            name="code",
            field=models.CharField(blank=True, db_index=True, default="", max_length=30),
        ),
        migrations.AddField(
            model_name="category",
            name="description",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.CreateModel(
            name="Warranty",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=100, unique=True)),
                ("description", models.TextField(blank=True, default="")),
                ("duration_value", models.PositiveIntegerField(default=0)),
                (
                    "duration_unit",
                    models.CharField(
                        choices=[("days", "Days"), ("months", "Months"), ("years", "Years")],
                        default="months",
                        max_length=10,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "db_table": "warranties",
                "ordering": ["name"],
            },
        ),
    ]
