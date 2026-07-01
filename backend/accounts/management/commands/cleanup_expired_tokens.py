"""
Delete expired PasswordSetupToken rows.
Run every 10 minutes via cron or Celery Beat.

    python manage.py cleanup_expired_tokens
"""
from django.core.management.base import BaseCommand
from django.utils import timezone


class Command(BaseCommand):
    help = "Delete expired password-setup tokens."

    def handle(self, *args, **options):
        from accounts.models import PasswordSetupToken
        count, _ = PasswordSetupToken.objects.filter(expires_at__lt=timezone.now()).delete()
        self.stdout.write(self.style.SUCCESS(f"Deleted {count} expired token(s)."))
