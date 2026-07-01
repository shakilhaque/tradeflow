"""
Fix a Referral that was attributed to the wrong tenant.

Background
──────────
`record_referral_from_phone()` matches existing users by phone-tail and
then double-checks with the MSISDN normaliser. If two User rows share
the same normalised phone (typically because a tenant typed someone
else's number into their own profile), `next(...)` picks whichever
candidate the DB happens to return first. That ends up giving the
referral credit to the wrong owner.

This command lets an operator move a misattributed Referral from one
referrer to another, dragging any DiscountCredit row along with it.

Usage
─────
  # Dry-run — show who'd be touched, no writes:
  python manage.py fix_referral_attribution \\
      --referred shakilhaque.devops@gmail.com \\
      --new-referrer shakilhaque29@gmail.com \\
      --dry-run

  # Apply:
  python manage.py fix_referral_attribution \\
      --referred shakilhaque.devops@gmail.com \\
      --new-referrer shakilhaque29@gmail.com

  # Also report all users sharing the same normalised phone so the
  # operator can clean up the duplicate that caused the mismatch:
  python manage.py fix_referral_attribution \\
      --referred shakilhaque.devops@gmail.com \\
      --new-referrer shakilhaque29@gmail.com \\
      --audit-phone 01830566126
"""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction


class Command(BaseCommand):
    help = "Move a misattributed Referral (and its DiscountCredit) to the correct referrer."

    def add_arguments(self, parser):
        parser.add_argument("--referred", required=True,
                            help="Email of the user whose referral is wrong.")
        parser.add_argument("--new-referrer", required=True,
                            help="Email of the tenant who SHOULD have been credited.")
        parser.add_argument("--audit-phone", default="",
                            help="Print every User whose phone normalises to this value.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Show the planned changes, write nothing.")

    def handle(self, *args, **opts):
        from accounts.models import DiscountCredit, Referral, User
        from accounts.sms import _normalize_msisdn

        dry = bool(opts["dry_run"])
        if dry:
            self.stdout.write(self.style.WARNING("DRY RUN — no writes."))

        try:
            referred = User.objects.get(email__iexact=opts["referred"].strip())
        except User.DoesNotExist:
            raise CommandError(f"No user with email '{opts['referred']}'.")
        try:
            new_referrer = User.objects.get(email__iexact=opts["new_referrer"].strip())
        except User.DoesNotExist:
            raise CommandError(f"No user with email '{opts['new_referrer']}'.")

        if referred.pk == new_referrer.pk:
            raise CommandError("Referred user and new referrer must be different.")

        # ── Audit phone duplicates (so the operator can fix the root cause) ──
        audit_phone = opts["audit_phone"].strip()
        if audit_phone:
            msisdn = _normalize_msisdn(audit_phone) or audit_phone
            tail = msisdn[-9:]
            shared = [
                u for u in User.objects.filter(phone__icontains=tail).only("id", "email", "phone")
                if _normalize_msisdn(u.phone) == msisdn
            ]
            self.stdout.write(self.style.NOTICE(
                f"\nUsers sharing the normalised phone '{msisdn}':"
            ))
            for u in shared:
                marker = (" ← new referrer" if u.pk == new_referrer.pk else
                          " (referred user)" if u.pk == referred.pk else "")
                self.stdout.write(f"  · {u.email}  phone={u.phone!r}{marker}")
            if len(shared) > 1:
                self.stdout.write(self.style.WARNING(
                    "  ⚠ More than one User has this phone — fix the duplicates "
                    "to prevent future misattributions."
                ))

        # ── Locate the Referral row pointing at the referred user ──────────
        try:
            referral = Referral.objects.select_related("referrer").get(referred=referred)
        except Referral.DoesNotExist:
            raise CommandError(
                f"No Referral row found pointing at {referred.email}. Nothing to fix."
            )

        self.stdout.write("")
        self.stdout.write(self.style.NOTICE("Referral found:"))
        self.stdout.write(
            f"  · {referral.referrer.email}  →  {referred.email}\n"
            f"  · awarded:    {bool(referral.awarded_at)}\n"
            f"  · created_at: {referral.created_at}\n"
            f"  · phone_snap: {referral.referrer_phone_snapshot!r}"
        )

        if referral.referrer_id == new_referrer.pk:
            self.stdout.write(self.style.SUCCESS(
                "Referrer is already correct — nothing to change."
            ))
            return

        # ── Find any DiscountCredit awarded for this Referral ─────────────
        credit = DiscountCredit.objects.filter(referral=referral).first()
        if credit:
            self.stdout.write("")
            self.stdout.write(self.style.NOTICE("DiscountCredit attached:"))
            self.stdout.write(
                f"  · current owner: {credit.user.email}\n"
                f"  · percent:       {credit.percent}\n"
                f"  · applied:       {bool(credit.applied_at)}\n"
                f"  · earned_at:     {credit.earned_at}"
            )
            if credit.applied_at:
                self.stdout.write(self.style.WARNING(
                    "  ⚠ This credit has already been APPLIED to a renewal "
                    "payment. Moving it now would not refund the original "
                    "owner — handle the refund manually if needed."
                ))

        # ── Apply ──────────────────────────────────────────────────────────
        self.stdout.write("")
        self.stdout.write(self.style.NOTICE("Plan:"))
        self.stdout.write(
            f"  · Move Referral.referrer  "
            f"{referral.referrer.email} → {new_referrer.email}"
        )
        if credit:
            self.stdout.write(
                f"  · Move DiscountCredit.user "
                f"{credit.user.email} → {new_referrer.email}"
            )

        if dry:
            self.stdout.write(self.style.SUCCESS("\nDRY RUN complete — re-run without --dry-run to apply."))
            return

        with transaction.atomic():
            old_referrer_id = referral.referrer_id
            referral.referrer = new_referrer
            referral.save(update_fields=["referrer"])
            if credit and credit.user_id == old_referrer_id:
                credit.user = new_referrer
                credit.save(update_fields=["user"])

        self.stdout.write(self.style.SUCCESS(
            "\nReattribution complete. The new referrer's "
            "/api/me/referrals/ will reflect the change immediately."
        ))
