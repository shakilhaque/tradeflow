"""
Custom password validators wired into AUTH_PASSWORD_VALIDATORS.

Django ships MinimumLengthValidator / CommonPasswordValidator /
NumericPasswordValidator. Those cover "long, not in the top-N list,
not all digits" but don't enforce character-class diversity, which
the product spec requires:

    Password must contain at least:
      • 1 uppercase letter (A–Z)
      • 1 lowercase letter (a–z)
      • 1 number (0–9)
      • 1 special character (!@#$%^&*)

This validator is the server-side gate. The SetPasswordPage frontend
also shows a live checklist, but the validator here is the authority —
any code path that calls user.set_password(...) eventually runs every
validator in AUTH_PASSWORD_VALIDATORS, so admin createsuperuser,
password reset, /api/set-password/, and shell User.objects.create_user
all get the same rule.
"""
from __future__ import annotations
import re
from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _


# We deliberately use the EXACT character set listed in the user-facing
# hint (!@#$%^&*). Anything else (`(`, `)`, `_`, etc.) is still allowed
# in the password, but at least ONE character from this set must appear.
SPECIAL_CHARS = r"!@#$%^&*"
_SPECIAL_RE = re.compile(f"[{re.escape(SPECIAL_CHARS)}]")


class ComplexityValidator:
    """Require at least one of each: uppercase, lowercase, digit, special."""

    def validate(self, password: str, user=None) -> None:
        problems = []
        if not re.search(r"[A-Z]", password):
            problems.append("1 uppercase letter (A–Z)")
        if not re.search(r"[a-z]", password):
            problems.append("1 lowercase letter (a–z)")
        if not re.search(r"\d", password):
            problems.append("1 number (0–9)")
        if not _SPECIAL_RE.search(password):
            problems.append(f"1 special character ({SPECIAL_CHARS})")

        if problems:
            # Single ValidationError so DRF surfaces one clean message.
            raise ValidationError(
                _("Password must contain at least: %(missing)s.") % {
                    "missing": ", ".join(problems),
                },
                code="password_too_simple",
            )

    def get_help_text(self) -> str:
        return _(
            "Your password must contain at least 1 uppercase letter, "
            "1 lowercase letter, 1 number, and 1 special character "
            f"({SPECIAL_CHARS})."
        )
