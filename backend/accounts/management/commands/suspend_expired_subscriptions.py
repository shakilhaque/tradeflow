"""
Suspend users whose subscription period has elapsed.

Run nightly via cron / Celery beat:
    python manage.py suspend_expired_subscriptions

For each ACTIVE subscription whose next_billing_date is in the past, the
command flips the subscription status to EXPIRED and the user status to
SUSPENDED so the SubscriptionMiddleware blocks access until they pay.

Trial accounts (plan.is_trial=True) get the same treatment after 14 days.
"""
from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import Subscription, User


class Command(BaseCommand):
    help = "Suspend users whose subscription (incl. trial) has expired."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Print what would change without writing.",
        )

    def handle(self, *args, **opts):
        today = timezone.localdate()
        dry   = opts["dry_run"]

        expired = (
            Subscription.objects
            .filter(status=Subscription.Status.ACTIVE, next_billing_date__lt=today)
            .select_related("user", "plan")
        )

        count = expired.count()
        if not count:
            self.stdout.write(self.style.SUCCESS("No expired subscriptions found."))
            return

        self.stdout.write(f"Found {count} expired subscription(s) as of {today}.")

        for sub in expired:
            label = f"{sub.user.email} (plan={sub.plan.name}, expired {sub.next_billing_date})"
            if dry:
                self.stdout.write(f"  [dry-run] would suspend: {label}")
                continue

            sub.status = Subscription.Status.EXPIRED
            sub.save(update_fields=["status"])

            sub.user.status    = User.Status.SUSPENDED
            sub.user.is_active = False
            sub.user.save(update_fields=["status", "is_active"])

            self.stdout.write(self.style.WARNING(f"  Suspended: {label}"))

        if not dry:
            self.stdout.write(self.style.SUCCESS(f"Done. {count} account(s) suspended."))
