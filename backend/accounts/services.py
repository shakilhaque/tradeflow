"""
Account services — username validation helpers (single-client build).

The SaaS payment / subscription / OTP / tenant-provisioning services have been
removed. Only the username helpers used by staff-user creation remain.
"""
import re as _re
import secrets

USERNAME_MIN_LEN = 3
USERNAME_MAX_LEN = 30
_USERNAME_RE = _re.compile(r"^[a-z][a-z0-9_]{2,29}$")


class UsernameError(Exception):
    """Raised when a chosen username is invalid or already taken."""


def normalize_username(raw: str) -> str:
    """Lowercase + strip. Caller still has to validate the result."""
    return (raw or "").strip().lower()


def is_valid_username_format(username: str) -> bool:
    return bool(_USERNAME_RE.match(username or ""))


def is_username_available(username: str) -> bool:
    """True if no User row owns this username (case-insensitive)."""
    from .models import User
    return not User.objects.filter(username__iexact=username).exists()


def generate_username(name: str) -> str:
    """Build a unique username from a display name (fallback for shell/admin)."""
    from .models import User
    base = "".join(c for c in name.lower().replace(" ", "_") if c.isalnum() or c == "_")
    base = base or "user"
    for _ in range(5):
        candidate = f"{base}_{secrets.token_hex(2)}"
        if not User.objects.filter(username=candidate).exists():
            return candidate
    return f"user_{secrets.token_hex(8)}"


def suggest_usernames(base: str, *, max_suggestions: int = 5) -> list:
    """Given a taken username (or a free-form name), return unused alternatives."""
    from .models import User

    seed = _re.sub(r"[^a-z0-9_]", "_", (base or "").strip().lower())
    seed = _re.sub(r"_+", "_", seed).strip("_")
    if not seed or seed[0].isdigit():
        seed = f"user_{seed}".rstrip("_")
    seed = seed[:USERNAME_MAX_LEN - 5]

    out = []
    taken = set(
        User.objects.filter(username__startswith=seed).values_list("username", flat=True)
    )
    for n in range(2, 10):
        cand = f"{seed}{n}"
        if len(cand) > USERNAME_MAX_LEN or not is_valid_username_format(cand) or cand in taken:
            continue
        out.append(cand)
        if len(out) >= max_suggestions:
            return out
    for _ in range(20):
        cand = f"{seed}_{secrets.token_hex(2)}"
        if len(cand) > USERNAME_MAX_LEN or not is_valid_username_format(cand) or cand in taken:
            continue
        out.append(cand)
        if len(out) >= max_suggestions:
            break
    return out


def validate_and_reserve_username(raw: str, *, fallback_seed: str = "") -> str:
    """Normalise + validate a chosen username. Raises UsernameError on failure."""
    username = normalize_username(raw)
    if not username:
        if fallback_seed:
            for cand in suggest_usernames(fallback_seed, max_suggestions=1):
                return cand
        raise UsernameError("Username is required.")
    if not is_valid_username_format(username):
        raise UsernameError(
            f"Username must be {USERNAME_MIN_LEN}-{USERNAME_MAX_LEN} characters, "
            "start with a lowercase letter, and contain only lowercase letters, "
            "digits, or underscores."
        )
    if not is_username_available(username):
        raise UsernameError("This username has already been used.")
    return username
