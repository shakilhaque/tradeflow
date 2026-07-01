"""
Cell-value cleaners for tenant imports.

Real-world export files have currency symbols, unit suffixes, thousand
separators, and "no data" placeholders embedded in the cell text. The
old validator treated every such cell as un-parseable. This module is
the toolbox the new validator uses to peel those layers off before
trying to coerce to Decimal / int / date.

Examples (from the Ongko Stationery file that drove this work):

    "৳ 1,500.00"      → Decimal("1500.00")
    "৳ 40.00"         → Decimal("40.00")
    "4.00 Pc(s)"      → (Decimal("4.00"), "Pc")
    "29.00 Pc(s)"     → (Decimal("29.00"), "Pc")
    "--"              → None       (sentinel for "no value")
    ""                → None
    "20,005.00 Pc(s)" → (Decimal("20005.00"), "Pc")
"""
from __future__ import annotations
import re
from decimal import Decimal, InvalidOperation
from typing import Optional


# Sentinels that some exporters use to mean "no value".
NULL_SENTINELS = {"", "--", "-", "n/a", "na", "null", "none", "—"}


# Currency markers and other prefixes we should strip before parsing numbers.
# Bengali Taka U+09F3 (৳) is the one Bangladesh ERP exports use.
# Add more here if a tenant's file uses something else (e.g. "Rs", "$").
_CURRENCY_RE = re.compile(r"[৳$€£₹]\s*", flags=re.UNICODE)

# Common units that exporters append to qty cells, in priority order so
# "Pc(s)" matches before "Pcs" / "Pc".
_QTY_UNIT_RE = re.compile(
    r"""\s*(
        Pc\(s\) | Pcs | Pieces | Piece | Pc |
        Kgs | Kg |
        Ltrs | Litres | Litre | Liters | Liter | Ltr |
        Boxes | Box |
        Packs | Pack |
        Dozens | Dozen | Doz |
        Units? | Bags? | Bottles?
    )\s*$""",
    flags=re.IGNORECASE | re.VERBOSE,
)


def is_null(raw: object) -> bool:
    """True if the cell should be treated as 'no value' regardless of type."""
    if raw is None:
        return True
    if isinstance(raw, str):
        return raw.strip().lower() in NULL_SENTINELS
    return False


def clean_currency(raw: object) -> Optional[Decimal]:
    """
    Strip currency symbol + thousand commas + whitespace, return Decimal.
    None when the input is empty / "--" / unparseable.

    "৳ 1,500.00" → Decimal("1500.00")
    "1,234.56"   → Decimal("1234.56")
    "--"         → None
    """
    if is_null(raw):
        return None
    s = str(raw).strip()
    s = _CURRENCY_RE.sub("", s)
    s = s.replace(",", "").strip()
    if not s:
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def clean_qty_with_unit(raw: object) -> tuple[Optional[Decimal], Optional[str]]:
    """
    Split a quantity cell that may have a unit suffix.

    Returns (qty, unit_name_or_None). qty is None when the cell is empty
    or unparseable.

    "4.00 Pc(s)"   → (Decimal("4.00"), "Pc")
    "29 pcs"       → (Decimal("29"),   "Pc")
    "20,005.00 Pc(s)" → (Decimal("20005.00"), "Pc")
    "100"          → (Decimal("100"), None)
    "--"           → (None, None)
    """
    if is_null(raw):
        return None, None
    s = str(raw).strip()

    # Extract the trailing unit if present.
    unit_match = _QTY_UNIT_RE.search(s)
    unit = None
    if unit_match:
        raw_unit = unit_match.group(1).lower()
        # Normalise to a canonical name. We collapse "Pc(s)" / "Pcs" / "Pc" /
        # "Piece" / "Pieces" all into "Pc" — keeps the inventory.Unit table
        # from accumulating five synonyms for the same physical unit.
        unit = _canonicalise_unit(raw_unit)
        s = s[: unit_match.start()].strip()

    s = s.replace(",", "").strip()
    if not s:
        return None, unit
    try:
        return Decimal(s), unit
    except InvalidOperation:
        return None, unit


_UNIT_CANONICAL = {
    "pc": "Pc", "pcs": "Pc", "piece": "Pc", "pieces": "Pc", "pc(s)": "Pc",
    "kg": "Kg", "kgs": "Kg",
    "ltr": "Ltr", "liter": "Ltr", "litre": "Ltr", "liters": "Ltr", "litres": "Ltr", "ltrs": "Ltr",
    "box": "Box", "boxes": "Box",
    "pack": "Pack", "packs": "Pack",
    "doz": "Dozen", "dozen": "Dozen", "dozens": "Dozen",
    "unit": "Unit", "units": "Unit",
    "bag": "Bag", "bags": "Bag",
    "bottle": "Bottle", "bottles": "Bottle",
}


def _canonicalise_unit(raw: str) -> str:
    return _UNIT_CANONICAL.get(raw, raw.title())


def clean_text(raw: object, *, max_length: Optional[int] = None) -> Optional[str]:
    """Strip + null-sentinel handling for plain text cells."""
    if is_null(raw):
        return None
    s = str(raw).strip()
    if not s:
        return None
    if max_length:
        s = s[:max_length]
    return s


def looks_like_total_row(row: dict) -> bool:
    """Skip 'Total:' summary rows that some exports append at the bottom.

    Heuristic: any non-blank cell equals 'Total:' (case-insensitive). Tight
    enough that real product names like 'Total Tape Pack' don't match.
    """
    for v in row.values():
        if not v:
            continue
        s = str(v).strip().lower()
        if s in ("total:", "total", "grand total:", "grand total"):
            return True
    return False
