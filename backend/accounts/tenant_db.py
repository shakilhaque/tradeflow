"""
Request-scoped thread-local state for the active branch (multi-branch data
isolation). Single-client build — no multi-tenant database provisioning.

The active branch is the Location the signed-in user selected for the current
request, conveyed via the `X-Branch-Id` header and validated by
BranchMiddleware. `None` means the consolidated / all-branches view.
"""
import threading
from typing import Optional

_thread_locals = threading.local()


# ── DB alias (kept as a harmless no-op shim for any legacy caller) ────────────

def set_current_db_alias(alias: Optional[str]) -> None:
    _thread_locals.db_alias = alias


def get_current_db_alias() -> Optional[str]:
    return getattr(_thread_locals, "db_alias", None)


def clear_current_db_alias() -> None:
    _thread_locals.db_alias = None


# ── Active branch ─────────────────────────────────────────────────────────────

def set_current_branch_id(branch_id) -> None:
    _thread_locals.branch_id = str(branch_id) if branch_id else None


def get_current_branch_id() -> Optional[str]:
    return getattr(_thread_locals, "branch_id", None)


def clear_current_branch_id() -> None:
    _thread_locals.branch_id = None
