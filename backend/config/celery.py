"""
Celery application — NSL-POS.

Workers:
    celery -A config worker -l info

Single-client build: no SaaS billing / subscription cron jobs.
"""
import os
from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("nsl_pos")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

app.conf.timezone = "UTC"
