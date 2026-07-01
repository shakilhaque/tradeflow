"""
Quick way to look up the most recently issued login OTP for a tenant —
useful when testing without a real SIM (the console SMS backend already
logs it, but `python manage.py show_last_otp <identifier>` is faster).

Usage:
    # by email
    python manage.py show_last_otp ruhanhaque29@gmail.com

    # by mobile (BD format — 017…, +88017…, 88017…, with/without spaces)
    python manage.py show_last_otp 01830566126

    # by username
    python manage.py show_last_otp iffaa_demo_3f9a

    # most recent OTP across all users (no identifier)
    python manage.py show_last_otp
"""
from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import LoginOtp
from accounts.services import resolve_user_by_identifier


class Command(BaseCommand):
    help = "Show the most recent LoginOtp row (active or not) for diagnostics."

    def add_arguments(self, parser):
        parser.add_argument(
            "identifier",
            nargs="?",
            default="",
            help="Email, mobile number, or username. Omit to show the latest OTP overall.",
        )

    def handle(self, *args, **opts):
        ident = (opts.get("identifier") or "").strip()
        qs = LoginOtp.objects.select_related("user").order_by("-created_at")
        if ident:
            user = resolve_user_by_identifier(ident)
            if not user:
                self.stderr.write(self.style.ERROR(f"No user matches '{ident}'."))
                return
            qs = qs.filter(user=user)

        otp = qs.first()
        if not otp:
            self.stdout.write(self.style.WARNING("No OTP rows found."))
            return

        now = timezone.now()
        state = (
            "consumed" if otp.consumed_at
            else "expired" if otp.expires_at <= now
            else "ACTIVE"
        )
        # Email is optional on User (mobile is the primary identifier now),
        # so prefer whichever contact we actually have.
        contact = otp.user.email or otp.user.phone or "(no contact)"
        self.stdout.write(self.style.SUCCESS(f"Code:     {otp.code}"))
        self.stdout.write(f"User:     {contact}  (username: {otp.user.username})")
        self.stdout.write(f"State:    {state}")
        self.stdout.write(f"Attempts: {otp.attempts} / {LoginOtp.MAX_ATTEMPTS}")
        self.stdout.write(f"Issued:   {otp.created_at:%Y-%m-%d %H:%M:%S} UTC")
        self.stdout.write(f"Expires:  {otp.expires_at:%Y-%m-%d %H:%M:%S} UTC")
