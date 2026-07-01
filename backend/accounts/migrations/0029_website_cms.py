"""Website CMS — blocks, items, media, audit (master DB)."""
import uuid

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0028_suspended_users_active"),
    ]

    operations = [
        migrations.CreateModel(
            name="CmsBlock",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("key", models.CharField(db_index=True, max_length=60, unique=True)),
                ("content", models.JSONField(blank=True, default=dict)),
                ("is_published", models.BooleanField(default=True)),
                ("sort_order", models.PositiveIntegerField(default=0)),
                ("updated_by", models.CharField(blank=True, default="", max_length=254)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"db_table": "cms_blocks", "ordering": ["sort_order", "key"]},
        ),
        migrations.CreateModel(
            name="CmsItem",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("collection", models.CharField(choices=[("features", "Features"), ("testimonials", "Testimonials"), ("faq", "FAQ"), ("services", "Services"), ("products", "Products"), ("stats", "Statistics")], db_index=True, max_length=20)),
                ("slug", models.CharField(blank=True, db_index=True, default="", max_length=120)),
                ("data", models.JSONField(blank=True, default=dict)),
                ("sort_order", models.PositiveIntegerField(default=0)),
                ("is_published", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"db_table": "cms_items", "ordering": ["collection", "sort_order", "created_at"]},
        ),
        migrations.AddIndex(
            model_name="cmsitem",
            index=models.Index(fields=["collection", "slug"], name="cms_items_collect_25254e_idx"),
        ),
        migrations.CreateModel(
            name="CmsMedia",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("file", models.FileField(upload_to="cms/%Y/%m/")),
                ("name", models.CharField(blank=True, default="", max_length=255)),
                ("folder", models.CharField(blank=True, db_index=True, default="", max_length=120)),
                ("content_type", models.CharField(blank=True, default="", max_length=100)),
                ("size", models.PositiveIntegerField(default=0)),
                ("uploaded_by", models.CharField(blank=True, default="", max_length=254)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={"db_table": "cms_media", "ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="CmsAuditLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(db_index=True, max_length=24)),
                ("target", models.CharField(blank=True, default="", max_length=120)),
                ("note", models.CharField(blank=True, default="", max_length=300)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("actor", models.UUIDField(blank=True, null=True)),
                ("actor_email", models.CharField(blank=True, default="", max_length=254)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
            ],
            options={"db_table": "cms_audit_log", "ordering": ["-created_at"]},
        ),
    ]
