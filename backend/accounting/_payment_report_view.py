"""
Helper module — Payment Account Report view. Imported by views.py.

The report lists every payment event recorded in the system (Sale Payment,
Expense, Purchase) and shows which PaymentAccount it has been linked to via
the lightweight PaymentLink mapping.
"""
from datetime import date as _date
from decimal import Decimal as _D

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Expense, PaymentAccount, PaymentLink


@extend_schema(tags=["Accounting"])
class PaymentAccountReportView(APIView):
    """
    GET  /api/accounting/payment-account-report/
    POST /api/accounting/payment-account-report/link/

    Filters (GET): account_id, date_from, date_to, search, page, limit
    POST body:     { source_ref, payment_account_id, source_type? }
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            page = max(int(request.query_params.get("page", 1)), 1)
            limit = max(min(int(request.query_params.get("limit", 25)), 200), 1)
        except (TypeError, ValueError):
            page, limit = 1, 25

        account_id = request.query_params.get("account_id") or None
        date_from  = request.query_params.get("date_from")  or None
        date_to    = request.query_params.get("date_to")    or None
        search     = (request.query_params.get("search") or "").strip().lower()

        df = _date.fromisoformat(date_from) if date_from else None
        dt = _date.fromisoformat(date_to)   if date_to   else None

        def in_range(d):
            day = d.date() if hasattr(d, "date") else d
            if df and day < df: return False
            if dt and day > dt: return False
            return True

        # Pre-fetch every legacy link as a fallback. Modern source
        # models (SalePayment, PurchasePayment, Expense) carry the
        # payment_account_id directly, so we hit PaymentLink only
        # when the source row is unlinked.
        links = {
            pl.source_ref: pl for pl in PaymentLink.objects.select_related("payment_account")
        }
        acct_map = { str(a.id): a for a in PaymentAccount.objects.all() }

        def _resolve_account(source_account_id, source_ref):
            """Linkage resolution chain — first hit wins:
              1. The source row's own payment_account_id (the modern
                 column on SalePayment / PurchasePayment / Expense).
              2. A legacy PaymentLink mapping keyed by source_ref.
            Returns (account_id, account_name, account_type, linked)."""
            if source_account_id:
                acct = acct_map.get(str(source_account_id))
                if acct:
                    return str(acct.id), acct.name, acct.get_account_type_display(), True
            pl = links.get(source_ref)
            if pl and pl.payment_account_id:
                a = pl.payment_account
                return str(a.id), a.name, a.get_account_type_display(), True
            return None, "", "", False

        rows = []

        # ── Sale payments. DB-side date filter so the slow Python
        # loop only walks the rows that matter for this period.
        try:
            from sales.models import SalePayment
            sp_qs = (
                SalePayment.objects
                .select_related("sale", "sale__customer")
            )
            if df:
                sp_qs = sp_qs.filter(created_at__date__gte=df)
            if dt:
                sp_qs = sp_qs.filter(created_at__date__lte=dt)
            for sp in sp_qs.iterator():
                ref = sp.reference or f"SP-{str(sp.id)[:8]}"
                invoice_no = getattr(sp.sale, "invoice_number", None) or str(sp.sale_id)[:8]
                aid, aname, atype, linked = _resolve_account(
                    getattr(sp, "payment_account_id", None), ref,
                )
                rows.append({
                    "kind": "SALE_PAYMENT",
                    "source_ref":   ref,
                    "date":         sp.created_at.isoformat(),
                    "payment_ref":  ref,
                    "invoice_ref":  invoice_no,
                    "invoice_id":   str(sp.sale_id),
                    "payment_type": "Sell",
                    "amount":       str(sp.amount),
                    "method":       sp.method,
                    "account_id":   aid,
                    "account_name": aname,
                    "account_type": atype,
                    "linked":       linked,
                })
        except Exception:
            pass

        # ── Expenses (paid via payment_account_picked_id).
        try:
            e_qs = Expense.objects.all()
            if df:
                e_qs = e_qs.filter(created_at__date__gte=df)
            if dt:
                e_qs = e_qs.filter(created_at__date__lte=dt)
            for e in e_qs.iterator():
                paid = _D(str(e.paid_amount or 0))
                if paid <= 0: continue
                ref = e.reference_no or f"EP-{str(e.id)[:8]}"
                aid, aname, atype, linked = _resolve_account(
                    getattr(e, "payment_account_picked_id", None), ref,
                )
                rows.append({
                    "kind": "EXPENSE",
                    "source_ref":   ref,
                    "date":         e.created_at.isoformat(),
                    "payment_ref":  ref,
                    "invoice_ref":  ref,
                    "invoice_id":   str(e.id),
                    "payment_type": "Expense",
                    "amount":       str(paid),
                    "method":       e.payment_method or "",
                    "account_id":   aid,
                    "account_name": aname,
                    "account_type": atype,
                    "linked":       linked,
                })
        except Exception:
            pass

        # ── Purchases — iterate PurchasePayment rows so each
        # instalment shows up individually instead of one lumped
        # paid_amount per purchase. Falls back to the legacy
        # purchase.paid_amount aggregate when no payment rows exist
        # (older tenants).
        try:
            from purchases.models import Purchase, PurchasePayment
            pp_qs = PurchasePayment.objects.select_related("purchase", "purchase__supplier")
            if df:
                pp_qs = pp_qs.filter(created_at__date__gte=df)
            if dt:
                pp_qs = pp_qs.filter(created_at__date__lte=dt)
            covered_purchase_ids = set()
            for pp in pp_qs.iterator():
                covered_purchase_ids.add(pp.purchase_id)
                ref = pp.reference or f"PP-{str(pp.id)[:8]}"
                inv = getattr(pp.purchase, "reference_no", "") or str(pp.purchase_id)[:8]
                aid, aname, atype, linked = _resolve_account(
                    getattr(pp, "payment_account_id", None), ref,
                )
                rows.append({
                    "kind": "PURCHASE_PAYMENT",
                    "source_ref":   ref,
                    "date":         pp.created_at.isoformat(),
                    "payment_ref":  ref,
                    "invoice_ref":  inv,
                    "invoice_id":   str(pp.purchase_id),
                    "payment_type": "Purchase",
                    "amount":       str(pp.amount),
                    "method":       pp.method or "",
                    "account_id":   aid,
                    "account_name": aname,
                    "account_type": atype,
                    "linked":       linked,
                })
            # Legacy fallback — purchases that were marked paid but
            # have no PurchasePayment rows (pre-payment-table data).
            legacy_qs = Purchase.objects.exclude(pk__in=covered_purchase_ids).select_related("supplier")
            if df:
                legacy_qs = legacy_qs.filter(created_at__date__gte=df)
            if dt:
                legacy_qs = legacy_qs.filter(created_at__date__lte=dt)
            for p in legacy_qs.iterator():
                paid = _D(str(p.paid_amount or 0))
                if paid <= 0: continue
                ref = getattr(p, "reference_no", None) or f"PP-{str(p.id)[:8]}"
                aid, aname, atype, linked = _resolve_account(None, ref)
                rows.append({
                    "kind": "PURCHASE",
                    "source_ref":   ref,
                    "date":         p.created_at.isoformat(),
                    "payment_ref":  ref,
                    "invoice_ref":  ref,
                    "invoice_id":   str(p.id),
                    "payment_type": "Purchase",
                    "amount":       str(paid),
                    "method":       "",
                    "account_id":   aid,
                    "account_name": aname,
                    "account_type": atype,
                    "linked":       linked,
                })
        except Exception:
            pass

        # Filter by account / search
        if account_id:
            rows = [r for r in rows if r.get("account_id") == account_id]
        if search:
            def hit(r):
                blob = " ".join(filter(None, [
                    r.get("payment_ref"), r.get("invoice_ref"),
                    r.get("source_ref"),  r.get("invoice_id"),
                    r.get("payment_type"), r.get("account_name"),
                    r.get("method"),
                ])).lower()
                return search in blob
            rows = [r for r in rows if hit(r)]

        # Sort newest first
        rows.sort(key=lambda r: r["date"], reverse=True)

        # ── Summary totals across the FULL filtered set (not just
        # the paginated slice) so the chips at the top of the page
        # reflect the entire result regardless of which page the
        # operator is on. Breaks down linked vs unlinked + by
        # payment_type so the operator can spot reconciliation gaps.
        linked_total   = _D("0")
        unlinked_total = _D("0")
        by_type        = {}
        for r in rows:
            amt = _D(str(r.get("amount") or 0))
            if r.get("linked"): linked_total += amt
            else:               unlinked_total += amt
            t = r.get("payment_type") or "—"
            by_type[t] = by_type.get(t, _D("0")) + amt

        # Paginate
        total = len(rows)
        offset = (page - 1) * limit
        page_rows = rows[offset:offset + limit]
        total_pages = max((total + limit - 1) // limit, 1)

        return Response({
            "results":     page_rows,
            "count":       total,
            "page":        page,
            "limit":       limit,
            "total_pages": total_pages,
            "summary": {
                "total":          str(linked_total + unlinked_total),
                "linked_total":   str(linked_total),
                "unlinked_total": str(unlinked_total),
                "linked_count":   sum(1 for r in rows if r.get("linked")),
                "unlinked_count": sum(1 for r in rows if not r.get("linked")),
                "by_type":        {k: str(v) for k, v in by_type.items()},
            },
        })


@extend_schema(tags=["Accounting"])
class PaymentLinkView(APIView):
    """POST /api/accounting/payment-account-report/link/"""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        source_ref = (request.data.get("source_ref") or "").strip()
        account_id = request.data.get("payment_account_id")
        if not source_ref:
            return Response({"detail": "source_ref is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not account_id:
            return Response({"detail": "payment_account_id is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            acct = PaymentAccount.objects.get(pk=account_id)
        except PaymentAccount.DoesNotExist:
            return Response({"detail": "Payment account not found."}, status=status.HTTP_404_NOT_FOUND)

        link, _created = PaymentLink.objects.update_or_create(
            source_ref=source_ref,
            defaults={
                "payment_account": acct,
                "source_type":     (request.data.get("source_type") or "").strip(),
                "note":            (request.data.get("note") or "").strip(),
            },
        )
        return Response({
            "source_ref":    link.source_ref,
            "payment_account_id":   str(link.payment_account_id),
            "payment_account_name": link.payment_account.name,
        }, status=status.HTTP_200_OK)
