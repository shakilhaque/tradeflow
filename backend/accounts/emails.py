"""
Email service — account provisioning & password setup emails.
Uses Django's email backend so the transport layer (SMTP, SendGrid,
SES, console) can be swapped via settings without touching this file.
"""
import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.utils.html import strip_tags

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# URL builders
# ──────────────────────────────────────────────────────────────────────────────

def _login_url() -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/login"


def _set_password_url(token: str) -> str:
    return f"{settings.FRONTEND_URL.rstrip('/')}/set-password?token={token}"


# ──────────────────────────────────────────────────────────────────────────────
# Public helpers
# ──────────────────────────────────────────────────────────────────────────────

def send_password_setup_email(user, token) -> bool:
    """
    Welcome email sent after successful payment + account creation.
    Contains: login URL, username, one-time password-setup link (15 min).
    Returns True on success, False on failure (never raises — webhook must not
    fail just because SMTP is temporarily down).
    """
    context = {
        "user":             user,
        "login_url":        _login_url(),
        "set_password_url": _set_password_url(token.token),
        "expiry_minutes":   15,
        "support_email":    getattr(settings, "SUPPORT_EMAIL", settings.DEFAULT_FROM_EMAIL),
        "app_name":         getattr(settings, "APP_NAME", "Our App"),
    }

    try:
        html_body = render_to_string("emails/account_ready.html", context)
        text_body = render_to_string("emails/account_ready.txt",  context)
    except Exception:
        logger.exception("Failed to render account_ready templates for user=%s", user.email)
        return False

    try:
        msg = EmailMultiAlternatives(
            subject    = "Your Account is Ready",
            body       = text_body,
            from_email = settings.DEFAULT_FROM_EMAIL,
            to         = [user.email],
            reply_to   = [context["support_email"]],
        )
        msg.attach_alternative(html_body, "text/html")
        sent = msg.send(fail_silently=False)
        logger.info("Sent account_ready email to %s", user.email)
        return bool(sent)
    except Exception:
        logger.exception("Failed to send account_ready email to %s", user.email)
        return False


def send_subscription_invoice_email(user, subscription, payment) -> bool:
    """
    Invoice / payment-confirmation email sent right after a NEW subscription
    payment succeeds. Contains the plan, amount paid, transaction id, payment
    date and the next billing date, plus support contact details.

    Fire-and-forget — never raises, so a temporarily-down SMTP server can't
    fail the payment webhook.
    """
    from django.conf import settings as s
    from .views import get_bdt_plan_price  # local import — avoids cycles

    # Amount actually charged (honours referral discounts) falls back to the
    # plan's BDT price for legacy rows where payment.amount is unexpectedly 0.
    amount = getattr(payment, "amount", None)
    if not amount:
        amount = get_bdt_plan_price(subscription.plan)

    context = {
        "user":            user,
        "subscription":    subscription,
        "plan":            subscription.plan,
        "amount":          amount,
        "currency_symbol": "৳",
        "transaction_id":  getattr(payment, "transaction_id", ""),
        "paid_at":         getattr(payment, "paid_at", None),
        "start_date":      subscription.start_date,
        "next_billing_date": subscription.next_billing_date,
        "login_url":       _login_url(),
        "support_email":   getattr(s, "SUPPORT_EMAIL", s.DEFAULT_FROM_EMAIL),
        "support_phone":   getattr(s, "SUPPORT_PHONE", ""),
        "app_name":        getattr(s, "APP_NAME", "Our App"),
    }

    try:
        html_body = render_to_string("emails/subscription_invoice.html", context)
        text_body = strip_tags(html_body)
    except Exception:
        logger.exception("Failed to render subscription_invoice template for user=%s", user.email)
        return False

    try:
        msg = EmailMultiAlternatives(
            subject    = f"Your {context['app_name']} subscription invoice",
            body       = text_body,
            from_email = settings.DEFAULT_FROM_EMAIL,
            to         = [user.email],
            reply_to   = [context["support_email"]],
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=True)
        logger.info("Sent subscription invoice email to %s (txn=%s)", user.email, context["transaction_id"])
        return True
    except Exception:
        logger.exception("Failed to send subscription invoice email to %s", user.email)
        return False


def send_suspension_email(user, subscription) -> bool:
    """Notify a user their account has been suspended due to non-payment."""
    from django.conf import settings as s
    context = {
        "user":         user,
        "subscription": subscription,
        "pay_now_url":  f"{s.FRONTEND_URL.rstrip('/')}/billing",
        "support_email": getattr(s, "SUPPORT_EMAIL", s.DEFAULT_FROM_EMAIL),
        "app_name":     getattr(s, "APP_NAME", "Our App"),
    }
    try:
        html_body = render_to_string("emails/subscription_suspended.html", context)
        text_body = strip_tags(html_body)
        msg = EmailMultiAlternatives(
            "Your subscription has expired",
            text_body, settings.DEFAULT_FROM_EMAIL, [user.email],
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=True)
        logger.info("Sent suspension email to %s", user.email)
        return True
    except Exception:
        logger.exception("Failed to send suspension email to %s", user.email)
        return False


def send_renewal_reminder_email(user, subscription) -> bool:
    """Remind user their subscription expires in N days."""
    from django.conf import settings as s
    from .views import get_bdt_plan_price  # local import — avoids cycles
    context = {
        "user":            user,
        "subscription":    subscription,
        "expiry_date":     subscription.next_billing_date,
        "amount_due":      get_bdt_plan_price(subscription.plan),
        "currency":        "BDT",
        "currency_symbol": "৳",
        "pay_now_url":     f"{s.FRONTEND_URL.rstrip('/')}/billing/pay",
        "support_email":   getattr(s, "SUPPORT_EMAIL", s.DEFAULT_FROM_EMAIL),
        "app_name":        getattr(s, "APP_NAME", "Our App"),
    }
    try:
        html_body = render_to_string("emails/renewal_reminder.html", context)
        text_body = render_to_string("emails/renewal_reminder.txt",  context)
        msg = EmailMultiAlternatives(
            f"Your {context['app_name']} subscription expires soon",
            text_body, settings.DEFAULT_FROM_EMAIL, [user.email],
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=True)
        logger.info("Sent renewal reminder to %s (expires %s)", user.email, subscription.next_billing_date)
        return True
    except Exception:
        logger.exception("Failed to send renewal reminder to %s", user.email)
        return False


def send_reactivation_email(user, subscription) -> bool:
    """Confirm account has been reactivated after a successful renewal payment."""
    from django.conf import settings as s
    context = {
        "user":         user,
        "subscription": subscription,
        "login_url":    _login_url(),
        "app_name":     getattr(s, "APP_NAME", "Our App"),
    }
    try:
        html_body = render_to_string("emails/subscription_reactivated.html", context)
        text_body = strip_tags(html_body)
        msg = EmailMultiAlternatives(
            "Your account has been reactivated",
            text_body, settings.DEFAULT_FROM_EMAIL, [user.email],
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=True)
        logger.info("Sent reactivation email to %s", user.email)
        return True
    except Exception:
        logger.exception("Failed to send reactivation email to %s", user.email)
        return False


def send_renewal_confirmation_email(user, subscription) -> bool:
    """Quiet renewal confirmation for users who weren't suspended."""
    return send_reactivation_email(user, subscription)   # re-use same template


def send_password_changed_confirmation(user) -> bool:
    """
    Brief confirmation email sent after /set-password succeeds.
    Fire-and-forget — failure is logged but not raised.
    """
    context = {
        "user":      user,
        "login_url": _login_url(),
        "app_name":  getattr(settings, "APP_NAME", "Our App"),
    }
    try:
        html_body = render_to_string("emails/password_changed.html", context)
        text_body = strip_tags(html_body)
        msg = EmailMultiAlternatives(
            subject    = "Your password has been set",
            body       = text_body,
            from_email = settings.DEFAULT_FROM_EMAIL,
            to         = [user.email],
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=True)
        logger.info("Sent password_changed email to %s", user.email)
        return True
    except Exception:
        logger.exception("Failed to send password_changed email to %s", user.email)
        return False
