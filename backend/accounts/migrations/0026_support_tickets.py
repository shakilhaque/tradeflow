"""Support ticket system — tickets, messages, attachments, events (master DB)."""
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0025_payment_gateway_audit"),
    ]

    operations = [
        migrations.CreateModel(
            name="SupportTicket",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("ticket_number", models.CharField(db_index=True, max_length=20, unique=True)),
                ("subject", models.CharField(max_length=200)),
                ("category", models.CharField(choices=[("billing", "Billing"), ("subscription", "Subscription"), ("pos", "POS"), ("inventory", "Inventory"), ("accounting", "Accounting"), ("technical", "Technical Issue"), ("feature", "Feature Request"), ("general", "General Inquiry")], default="general", max_length=20)),
                ("priority", models.CharField(choices=[("low", "Low"), ("medium", "Medium"), ("high", "High"), ("urgent", "Urgent")], db_index=True, default="medium", max_length=10)),
                ("status", models.CharField(choices=[("open", "Open"), ("pending", "Pending"), ("in_progress", "In Progress"), ("resolved", "Resolved"), ("closed", "Closed")], db_index=True, default="open", max_length=15)),
                ("satisfaction", models.PositiveSmallIntegerField(blank=True, null=True, help_text="CSAT rating 1-5 set when the tenant closes the ticket.")),
                ("first_response_at", models.DateTimeField(blank=True, null=True)),
                ("resolved_at", models.DateTimeField(blank=True, null=True)),
                ("closed_at", models.DateTimeField(blank=True, null=True)),
                ("last_activity_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("admin_unread", models.BooleanField(default=True)),
                ("tenant_unread", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("assigned_to", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="assigned_tickets", to=settings.AUTH_USER_MODEL)),
                ("merged_into", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="merged_tickets", to="accounts.supportticket")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="support_tickets", to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "support_tickets", "ordering": ["-last_activity_at"]},
        ),
        migrations.CreateModel(
            name="SupportTicketMessage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("author_role", models.CharField(default="tenant", max_length=10)),
                ("body", models.TextField(blank=True, default="")),
                ("is_internal", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("author", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="support_messages", to=settings.AUTH_USER_MODEL)),
                ("ticket", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="messages", to="accounts.supportticket")),
            ],
            options={"db_table": "support_ticket_messages", "ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="SupportTicketAttachment",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("file", models.FileField(upload_to="support/%Y/%m/")),
                ("name", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("message", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="accounts.supportticketmessage")),
                ("ticket", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="accounts.supportticket")),
                ("uploaded_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL)),
            ],
            options={"db_table": "support_ticket_attachments", "ordering": ["created_at"]},
        ),
        migrations.CreateModel(
            name="SupportTicketEvent",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(db_index=True, max_length=20)),
                ("from_value", models.CharField(blank=True, default="", max_length=60)),
                ("to_value", models.CharField(blank=True, default="", max_length=60)),
                ("note", models.CharField(blank=True, default="", max_length=300)),
                ("actor", models.UUIDField(blank=True, null=True)),
                ("actor_email", models.CharField(blank=True, default="", max_length=254)),
                ("actor_role", models.CharField(blank=True, default="", max_length=10)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("ticket", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="events", to="accounts.supportticket")),
            ],
            options={"db_table": "support_ticket_events", "ordering": ["created_at"]},
        ),
    ]
