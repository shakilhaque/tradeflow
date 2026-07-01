"""
Celery application — SaaS Subscription System.

Workers:
    celery -A config worker -l info

Beat scheduler (cron jobs):
    celery -A config beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler
"""
import os
from celery import Celery
from celery.schedules import crontab

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("saas")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

# ── Periodic task schedule ───────────────────────────────────────────────────
app.conf.beat_schedule = {

    # 00:05 daily — suspend every subscription whose next_billing_date has passed
    "suspend-expired-subscriptions": {
        "task":     "accounts.tasks.suspend_expired_subscriptions",
        "schedule": crontab(hour=0, minute=5),
    },

    # 09:00 daily — remind users whose subscription expires in 3 days
    "send-renewal-reminders": {
        "task":     "accounts.tasks.send_renewal_reminders",
        "schedule": crontab(hour=9, minute=0),
    },

    # 01:30 daily — safety net for the referral programme. The synchronous
    # path on payment-success already awards referrals; this catches any
    # trial→paid conversions where the webhook didn't fire or crashed.
    "award-pending-referrals": {
        "task":     "accounts.tasks.award_pending_referrals",
        "schedule": crontab(hour=1, minute=30),
    },
}

app.conf.timezone = "UTC"
