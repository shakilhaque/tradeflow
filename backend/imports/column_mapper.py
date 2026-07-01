"""
Smart column mapper for tenant CSV / XLSX imports.

Why
───
Different tenants name their columns differently. One stationery shop's
file (Ongko, the real example that drove this work) has headers like:

    SKU | Product | Location | Unit Price | Current stock |
    Current Stock Value (By purchase price) | Total unit sold | ...

…but the import code originally expected the literal headers
"Product Name", "Opening Qty", "Unit Cost", "Stock Date". A header
mismatch silently dropped the column, every row failed validation,
and the user saw "Server flagged 156 rows."

What this module does
─────────────────────
1. Given a list of raw headers from the file, produce a `Mapping` of
   {our_field_name: source_header_string_or_None} using:

     a. Exact case-insensitive match on the synonym list
     b. Substring match (e.g. "current stock" contains "stock")
     c. Fuzzy match (difflib.SequenceMatcher) for typo-tolerance,
        with a confidence score 0..1

2. Headers that didn't map to any known field are returned as
   `extras` — the row loader stashes their values into the
   destination model's JSONField so nothing is lost.

3. The result includes per-field `confidence` so the frontend
   wizard can highlight low-confidence guesses and let the
   operator override before commit.

Why stdlib (difflib) and not rapidfuzz
──────────────────────────────────────
The header list per file is tiny (< 30 strings). difflib's quadratic
behaviour is irrelevant at that size, and avoiding a new C-extension
dependency simplifies deployment. If we ever do per-row fuzzy matching
in the validator, swap to rapidfuzz then.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Optional


# ──────────────────────────────────────────────────────────────────────────────
# Public types
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class FieldMatch:
    """One row in the resolved mapping."""
    our_field:        str                    # e.g. "name", "unit_cost"
    source_header:    Optional[str]          # the literal CSV header, or None
    confidence:       float = 0.0            # 0..1 — 1.0 = exact match
    match_kind:       str   = "none"         # "exact" | "substring" | "fuzzy" | "none"

    def to_json(self) -> dict:
        return {
            "field":          self.our_field,
            "source_header":  self.source_header,
            "confidence":     round(self.confidence, 2),
            "match_kind":     self.match_kind,
        }


@dataclass
class MappingResult:
    """What `auto_map_headers` returns."""
    matches: dict[str, FieldMatch] = field(default_factory=dict)  # our_field → FieldMatch
    extras:  list[str]             = field(default_factory=list)  # source headers that didn't map

    def to_json(self) -> dict:
        return {
            "matches": {f: m.to_json() for f, m in self.matches.items()},
            "extras":  self.extras,
        }


# ──────────────────────────────────────────────────────────────────────────────
# Synonym tables — per import type
# ──────────────────────────────────────────────────────────────────────────────
#
# Lowercase, punctuation-free, with as many real-world aliases as we've seen.
# Add entries here when a tenant's file uses a header you don't yet cover —
# no other code change needed.
#
# Note: aliases are tried in declared order. Put the most specific first so
# a heuristic ("stock value" → unit_cost via derivation) doesn't outrank a
# direct match ("current stock" → opening_qty).
# ──────────────────────────────────────────────────────────────────────────────

# Each value is a list of (normalised_header, weight) tuples. Weight 1.0 means
# "definitely this field"; lower means "could be this field but ambiguous"
# (e.g. "price" could be selling OR cost).
SYNONYMS_PRODUCT: dict[str, list[tuple[str, float]]] = {
    "name": [
        ("product name", 1.0), ("item name", 1.0), ("product", 1.0),
        ("item", 0.9), ("name", 0.9), ("title", 0.85), ("description", 0.5),
    ],
    "sku": [
        ("sku", 1.0), ("product code", 1.0), ("item code", 1.0),
        ("code", 0.85), ("product id", 0.9), ("item id", 0.9), ("ref", 0.7),
    ],
    "barcode": [
        ("barcode", 1.0), ("ean", 1.0), ("upc", 1.0), ("qr code", 0.9),
        ("bar code", 1.0),
    ],
    "category": [
        ("category", 1.0), ("product category", 1.0), ("group", 0.7),
        ("type", 0.5),
    ],
    "brand": [
        ("brand", 1.0), ("manufacturer", 0.95), ("make", 0.9), ("vendor", 0.5),
    ],
    "unit": [
        ("unit", 1.0), ("uom", 1.0), ("unit of measure", 1.0),
        ("measurement unit", 1.0), ("pack", 0.6),
    ],
    "unit_cost": [
        ("unit cost", 1.0), ("cost price", 1.0), ("buying price", 1.0),
        ("purchase price", 1.0), ("wholesale price", 0.9), ("cost", 0.85),
    ],
    "selling_price": [
        ("selling price", 1.0), ("sale price", 1.0), ("sell price", 1.0),
        ("retail price", 1.0), ("mrp", 1.0), ("unit price", 0.9),
        ("price", 0.7),
    ],
    "opening_qty": [
        ("opening qty", 1.0), ("opening quantity", 1.0), ("opening stock", 1.0),
        ("current stock", 1.0), ("stock qty", 1.0), ("stock quantity", 1.0),
        ("quantity", 0.85), ("qty", 0.85), ("stock", 0.85), ("in stock", 0.85),
        ("available", 0.8), ("on hand", 0.85),
    ],
    "reorder_level": [
        ("reorder level", 1.0), ("reorder point", 1.0), ("min stock", 1.0),
        ("minimum stock", 1.0), ("reorder qty", 1.0), ("low stock", 0.85),
        ("safety stock", 0.85),
    ],
    "location": [
        ("location", 1.0), ("branch", 1.0), ("warehouse", 1.0), ("store", 0.9),
        ("outlet", 0.9), ("shop", 0.7),
    ],
    "stock_date": [
        ("stock date", 1.0), ("as of date", 1.0), ("as of", 0.95),
        ("date", 0.85), ("opening date", 1.0),
    ],
    "warranty_days": [
        ("warranty days", 1.0), ("warranty", 0.85),
    ],
    "notes": [
        ("notes", 1.0), ("note", 1.0), ("remark", 0.95), ("remarks", 0.95),
        ("comment", 0.9), ("comments", 0.9), ("description", 0.7),
    ],
}


# ──────────────────────────────────────────────────────────────────────────────
# Supplier synonyms — used by /api/imports/supplier/analyze/ + /validate/
# ──────────────────────────────────────────────────────────────────────────────
SYNONYMS_SUPPLIER: dict[str, list[tuple[str, float]]] = {
    "name": [
        ("supplier name", 1.0), ("vendor name", 1.0), ("company name", 1.0),
        ("name", 0.9), ("supplier", 0.9), ("vendor", 0.9),
    ],
    "business_name": [
        ("business name", 1.0), ("trading name", 1.0), ("trade name", 1.0),
        ("legal name", 0.9), ("company", 0.85),
    ],
    "contact": [
        ("contact person", 1.0), ("contact name", 1.0), ("primary contact", 1.0),
        ("contact", 0.9), ("attn", 0.7),
    ],
    "email": [
        ("email", 1.0), ("email address", 1.0), ("e-mail", 1.0), ("mail", 0.8),
    ],
    "phone": [
        ("phone", 1.0), ("mobile", 1.0), ("cell", 0.95), ("contact number", 1.0),
        ("phone number", 1.0), ("mobile number", 1.0), ("tel", 0.85),
    ],
    "address": [
        ("address", 1.0), ("street address", 1.0), ("billing address", 0.95),
        ("location", 0.7),
    ],
    "tax_number": [
        ("tax number", 1.0), ("vat", 1.0), ("tin", 1.0), ("gst", 1.0),
        ("tax id", 1.0), ("vat number", 1.0),
    ],
    "pay_term_value": [
        ("pay term", 1.0), ("payment term", 1.0), ("net days", 1.0),
        ("credit days", 1.0), ("terms", 0.7),
    ],
    "opening_balance": [
        ("opening balance", 1.0), ("opening", 0.85), ("balance", 0.7),
    ],
    "notes": [
        ("notes", 1.0), ("remarks", 0.95), ("comment", 0.9), ("description", 0.7),
    ],
}


# ──────────────────────────────────────────────────────────────────────────────
# Contact synonyms — Customer / Supplier / Both contacts via /api/imports/contact/
# ──────────────────────────────────────────────────────────────────────────────
SYNONYMS_CONTACT: dict[str, list[tuple[str, float]]] = {
    # Type discriminator. Source value can be 1/2/3, "customer"/"supplier"/"both",
    # or "customer & supplier"; the validator normalises it.
    "contact_type": [
        ("contact type", 1.0), ("type", 0.9), ("category", 0.6),
        ("contact category", 1.0), ("role", 0.7),
    ],
    "prefix": [
        ("prefix", 1.0), ("title", 0.9), ("salutation", 0.95),
    ],
    "first_name": [
        ("first name", 1.0), ("firstname", 1.0), ("given name", 1.0),
        ("name", 0.7),
    ],
    "middle_name": [
        ("middle name", 1.0), ("middlename", 1.0),
    ],
    "last_name": [
        ("last name", 1.0), ("lastname", 1.0), ("surname", 0.95),
        ("family name", 0.95),
    ],
    "business_name": [
        ("business name", 1.0), ("company name", 1.0), ("company", 0.9),
        ("trading name", 1.0), ("organisation", 0.85), ("organization", 0.85),
    ],
    "email": [
        ("email", 1.0), ("email address", 1.0), ("e-mail", 1.0),
    ],
    "phone": [
        ("mobile", 1.0), ("phone", 1.0), ("phone number", 1.0),
        ("mobile number", 1.0), ("contact number", 1.0), ("cell", 0.9),
        ("tel", 0.85),
    ],
    "alternate_phone": [
        ("alternate contact", 1.0), ("alternate phone", 1.0),
        ("secondary phone", 1.0), ("alt phone", 0.9), ("alt mobile", 0.9),
    ],
    "landline": [
        ("landline", 1.0), ("home phone", 0.95), ("office phone", 0.95),
    ],
    "address": [
        ("address", 1.0), ("address line 1", 1.0), ("street", 0.9),
        ("street address", 1.0), ("billing address", 0.95),
    ],
    "address_line_2": [
        ("address line 2", 1.0), ("address 2", 0.9), ("apt", 0.6),
        ("suite", 0.7),
    ],
    "city": [
        ("city", 1.0), ("town", 0.9),
    ],
    "state": [
        ("state", 1.0), ("province", 0.95), ("region", 0.85),
    ],
    "country": [
        ("country", 1.0),
    ],
    "zip_code": [
        ("zip", 1.0), ("zip code", 1.0), ("postal code", 1.0),
        ("post code", 1.0),
    ],
    "tax_number": [
        ("tax number", 1.0), ("vat", 1.0), ("tin", 1.0), ("gst", 1.0),
        ("tax id", 1.0), ("vat number", 1.0),
    ],
    "pay_term_value": [
        ("pay term", 1.0), ("payment term", 1.0), ("net days", 1.0),
        ("credit days", 1.0), ("terms", 0.7),
    ],
    "opening_balance": [
        ("opening balance", 1.0), ("opening", 0.85), ("balance", 0.7),
    ],
    "credit_limit": [
        ("credit limit", 1.0), ("max credit", 0.9), ("limit", 0.6),
    ],
    "notes": [
        ("notes", 1.0), ("remarks", 0.95), ("comment", 0.9), ("description", 0.7),
    ],
}


# Master registry so other import types can be added in one place.
SYNONYMS_BY_TYPE: dict[str, dict[str, list[tuple[str, float]]]] = {
    "PRODUCT":  SYNONYMS_PRODUCT,
    "SUPPLIER": SYNONYMS_SUPPLIER,
    "CONTACT":  SYNONYMS_CONTACT,
    # TODO: SYNONYMS_STOCK, SYNONYMS_SALE, SYNONYMS_EXPENSE — follow-up commit.
    # The mapper itself is type-agnostic; only the table changes.
}


# ──────────────────────────────────────────────────────────────────────────────
# Normalisation
# ──────────────────────────────────────────────────────────────────────────────

_PUNCT_RE = re.compile(r"[^\w\s]+")
_WS_RE    = re.compile(r"\s+")


def normalize_header(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace.

    'Current Stock Value (By Purchase Price)' → 'current stock value by purchase price'
    'SKU#' → 'sku'
    'Unit Cost (BDT)' → 'unit cost bdt'
    """
    if not s:
        return ""
    s = s.strip().lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


# ──────────────────────────────────────────────────────────────────────────────
# Auto-mapping
# ──────────────────────────────────────────────────────────────────────────────

# Fuzzy match threshold. 0.78 catches typos like "Producet Name" / "Sku Code"
# but doesn't bleed into wrong fields. Tune cautiously.
FUZZY_THRESHOLD = 0.78


def _score(normalised_header: str, alias: str) -> tuple[float, str]:
    """Return (score, match_kind) for one header against one alias.

    score in [0, 1]. kind ∈ {"exact", "substring", "fuzzy"}.
    """
    if normalised_header == alias:
        return 1.0, "exact"
    # Substring — the alias is contained in the header, or vice versa, but
    # require the alias be at least 4 chars so "id" doesn't match "voidship".
    if len(alias) >= 4:
        if alias in normalised_header or normalised_header in alias:
            return 0.92, "substring"
    # Fuzzy fallback
    ratio = SequenceMatcher(None, normalised_header, alias).ratio()
    if ratio >= FUZZY_THRESHOLD:
        return ratio, "fuzzy"
    return 0.0, "none"


def auto_map_headers(headers: list[str], *, import_type: str = "PRODUCT") -> MappingResult:
    """Greedy best-fit assignment of source headers → our fields.

    Algorithm (1 pass, deterministic):
      For each source header, find the (field, alias) pair with the
      highest weighted score. Records every header→field candidate.
      Then pick one source header per field (the one with the highest
      score for THAT field). Headers that didn't win any field land in
      `extras`.

    This handles the ambiguous "Unit Price" → could match `selling_price`
    via alias "unit price" (weight 0.9) AND `unit_cost` via alias "unit"
    via substring rule (0.92 × default weight 1.0). The higher-weighted
    direct alias wins on the tie-break.
    """
    syn = SYNONYMS_BY_TYPE.get(import_type.upper())
    if syn is None:
        raise ValueError(f"No synonym table for import_type='{import_type}'")

    # Build per-(header, field) best score.
    #   {source_header: {field: (score, kind)}}
    candidates: dict[str, dict[str, tuple[float, str]]] = {}
    for src in headers:
        norm = normalize_header(src)
        if not norm:
            continue
        per_field: dict[str, tuple[float, str]] = {}
        for our_field, aliases in syn.items():
            best_score = 0.0
            best_kind  = "none"
            for alias, weight in aliases:
                raw_score, kind = _score(norm, alias)
                weighted = raw_score * weight
                if weighted > best_score:
                    best_score = weighted
                    best_kind  = kind
            if best_score > 0.0:
                per_field[our_field] = (best_score, best_kind)
        if per_field:
            candidates[src] = per_field

    # Greedy: assign each field its best header, headers can only be used once.
    # Order fields by their highest single-candidate score so the most-confident
    # field claims its preferred header first.
    field_best: dict[str, tuple[str, float, str]] = {}  # field → (src, score, kind)
    for src, per_field in candidates.items():
        for f, (score, kind) in per_field.items():
            prev = field_best.get(f)
            if prev is None or score > prev[1]:
                field_best[f] = (src, score, kind)

    # Resolve conflicts: a header might be the best for two fields. The field
    # whose top header has the higher score keeps it; the other field looks
    # for its next-best UNCLAIMED header.
    sorted_fields = sorted(field_best.items(), key=lambda kv: kv[1][1], reverse=True)
    claimed_headers: set[str] = set()
    matches: dict[str, FieldMatch] = {}

    for f, (src, score, kind) in sorted_fields:
        if src in claimed_headers:
            # Try the next-best header for this field.
            alt = _next_best(candidates, f, claimed_headers)
            if alt is None:
                matches[f] = FieldMatch(our_field=f, source_header=None)
                continue
            src, score, kind = alt
        matches[f] = FieldMatch(our_field=f, source_header=src,
                                confidence=score, match_kind=kind)
        claimed_headers.add(src)

    # Any of our fields that never got a match → empty FieldMatch
    for our_field in syn:
        matches.setdefault(our_field, FieldMatch(our_field=our_field, source_header=None))

    # Extras = headers we didn't claim for any field
    extras = [h for h in headers if h and h not in claimed_headers]

    return MappingResult(matches=matches, extras=extras)


def _next_best(
    candidates: dict[str, dict[str, tuple[float, str]]],
    field: str,
    claimed: set[str],
) -> Optional[tuple[str, float, str]]:
    """Return the highest-scoring still-unclaimed header for `field`, or None."""
    best: Optional[tuple[str, float, str]] = None
    for src, per_field in candidates.items():
        if src in claimed:
            continue
        entry = per_field.get(field)
        if entry is None:
            continue
        score, kind = entry
        if best is None or score > best[1]:
            best = (src, score, kind)
    return best


# ──────────────────────────────────────────────────────────────────────────────
# Apply mapping — convert a list of raw rows into our-field-keyed rows
# ──────────────────────────────────────────────────────────────────────────────

def apply_mapping(
    rows: list[dict],
    mapping: dict[str, Optional[str]],
    *,
    extras_keys: Optional[list[str]] = None,
) -> list[dict]:
    """
    Translate raw rows into our internal schema.

    Each output row has:
      - <our_field>: <value>  for every field with a non-None source_header in `mapping`
      - "_extras": {raw_header: raw_value, ...} for everything in `extras_keys`

    `extras_keys` is the list of source headers the auto-mapper left over.
    Pass it through so the row loader can stash the values on the destination
    model's JSONField.
    """
    extras_keys = extras_keys or []
    out: list[dict] = []

    # Lower-cased source-header → raw_header lookup so we can read each row
    # case-insensitively (Excel users mix casing).
    def _read(row: dict, header: Optional[str]) -> str:
        if header is None:
            return ""
        if header in row:
            return (row[header] or "").strip() if isinstance(row[header], str) else str(row[header])
        # Fallback: case-insensitive lookup
        lower = header.lower()
        for k, v in row.items():
            if k.lower() == lower:
                return (v or "").strip() if isinstance(v, str) else str(v)
        return ""

    for raw in rows:
        translated: dict = {}
        for our_field, source_header in mapping.items():
            translated[our_field] = _read(raw, source_header)
        extras = {}
        for h in extras_keys:
            val = _read(raw, h)
            if val:
                extras[h] = val
        translated["_extras"] = extras
        out.append(translated)
    return out
