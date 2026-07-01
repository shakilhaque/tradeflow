"""
Purchases API views.

Endpoints
─────────
Suppliers (CRUD via DRF router):
  GET/POST   /api/purchases/suppliers/
  GET/PUT/PATCH/DELETE  /api/purchases/suppliers/<id>/

Purchases:
  GET   /api/purchases/                        list with filters + pagination + summary
  POST  /api/purchases/                        create
  GET   /api/purchases/<id>/                   detail
  POST  /api/purchases/<id>/payments/          add payment

Purchase Returns:
  GET   /api/purchases/returns/                list returns
  POST  /api/purchases/returns/                create return
  GET   /api/purchases/returns/<id>/           detail
"""
from datetime import datetime, time
from decimal import Decimal

from django.db.models import Q, Case, When, Value, CharField, Sum, F, DecimalField
from django.db.models.functions import Coalesce
from django.utils import timezone
from rest_framework import status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

import logging

from accounts.permissions import require_perm_method
from accounts.branch_context import branch_scope, active_branch_id

from . import services
from .models import Supplier, Purchase, PurchaseReturn

logger = logging.getLogger(__name__)
from .serializers import (
    SupplierSerializer,
    CreatePurchaseSerializer,
    PurchaseListSerializer,
    PurchaseDetailSerializer,
    PurchasePaymentSerializer,
    CreatePurchaseReturnSerializer,
    PurchaseReturnListSerializer,
    PurchaseReturnDetailSerializer,
)


class SupplierViewSet(viewsets.ModelViewSet):
    queryset           = Supplier.objects.all()
    serializer_class   = SupplierSerializer
    permission_classes = [IsAuthenticated]

    # supplier.add / supplier.edit / supplier.delete — see role.txt. Owners /
    # admins always pass via require_perm_method's role short-circuit.
    @require_perm_method("supplier.add")
    def create(self, request, *args, **kwargs):
        return super().create(request, *args, **kwargs)

    @require_perm_method("supplier.edit")
    def update(self, request, *args, **kwargs):
        return super().update(request, *args, **kwargs)

    @require_perm_method("supplier.edit")
    def partial_update(self, request, *args, **kwargs):
        return super().partial_update(request, *args, **kwargs)

    @require_perm_method("supplier.delete")
    def destroy(self, request, *args, **kwargs):
        return super().destroy(request, *args, **kwargs)

    def get_queryset(self):
        from decimal import Decimal as _D
        from django.db.models import (
            DecimalField as _DF, ExpressionWrapper as _EW,
            F as _F, Sum as _Sum, Value as _V,
        )
        from django.db.models.functions import Coalesce as _Coalesce

        DEC  = _DF(max_digits=14, decimal_places=2)
        ZERO = _V(_D("0"), output_field=DEC)

        qs = super().get_queryset()

        # ── Filters ──────────────────────────────────────────────────────────
        params = self.request.query_params
        if params.get("active_only") == "true":
            qs = qs.filter(is_active=True)
        st = (params.get("status") or "").lower()
        if st == "active":
            qs = qs.filter(is_active=True)
        elif st == "inactive":
            qs = qs.filter(is_active=False)
        if search := params.get("search", "").strip():
            # All fields searched via parameterised ORM Q lookups — no raw
            # SQL, no string concatenation. The `name` filter alone wasn't
            # enough since Supplier was split into Individual/Business; we
            # now also match the underlying first_name/last_name/
            # business_name fields, the human-readable contact_id code
            # (e.g. S-7F8225), and alternate_phone. Operators copy any of
            # those off the row, paste into the search box, and it works.
            digits = "".join(ch for ch in search if ch.isdigit())
            phone_q = Q()
            if digits:
                # Match a phone search with or without the '+88' prefix and
                # any spacing the user typed — collapse to digits and look
                # the digit substring up against both phone columns.
                phone_q = Q(phone__icontains=digits) | Q(alternate_phone__icontains=digits)
            qs = qs.filter(
                Q(name__icontains=search) |
                Q(business_name__icontains=search) |
                Q(first_name__icontains=search) |
                Q(last_name__icontains=search) |
                Q(contact__icontains=search) |
                Q(contact_id__icontains=search) |
                Q(email__icontains=search) |
                Q(tax_number__icontains=search) |
                Q(phone__icontains=search) |
                Q(alternate_phone__icontains=search) |
                phone_q
            )

        # 'No purchase since' — drop suppliers with any non-cancelled purchase
        # on or after the given date. Useful for re-evaluating dormant
        # supplier relationships.
        no_purchase_since = (params.get("no_purchase_since") or "").strip()
        if no_purchase_since:
            from datetime import date as _date
            try:
                cutoff = _date.fromisoformat(no_purchase_since)
                qs = qs.exclude(
                    purchases__purchase_date__gte=cutoff,
                ).exclude(purchases__status="cancelled", purchases__purchase_date__gte=cutoff)
            except (ValueError, TypeError):
                pass

        # ── Annotations ─────────────────────────────────────────────────────
        qs = qs.annotate(
            total_purchase_due = _Coalesce(
                _Sum(
                    _EW(_F("purchases__grand_total") - _F("purchases__paid_amount"),
                        output_field=DEC),
                    filter=~Q(purchases__status="cancelled"),
                ),
                ZERO,
            ),
            total_purchase_return_due = _Coalesce(
                # PurchaseReturn doesn't track a paid_amount column today
                # (we just record the headline total). Surface that total as
                # the 'return due' until a refund-tracking field is added.
                _Sum("returns__total_amount", filter=~Q(returns__status="cancelled")),
                ZERO,
            ),
        )
        return qs


class PurchaseListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = branch_scope(
            Purchase.objects
            .select_related("supplier", "location")
            .prefetch_related("returns")
            .annotate(
                computed_due=F("grand_total") - F("paid_amount"),
            )
        )

        if s := request.query_params.get("status"):
            qs = qs.filter(status=s.lower())
        if ps := request.query_params.get("payment_status"):
            qs = qs.filter(payment_status=ps.lower())
        if sid := request.query_params.get("supplier_id"):
            qs = qs.filter(supplier_id=sid)
        if lid := request.query_params.get("location_id"):
            qs = qs.filter(location_id=lid)

        df = request.query_params.get("date_from")
        dt = request.query_params.get("date_to")
        if df:
            try:
                qs = qs.filter(purchase_date__gte=datetime.fromisoformat(df).date())
            except ValueError:
                return Response({"detail": "Invalid date_from. Use YYYY-MM-DD."}, status=400)
        if dt:
            try:
                qs = qs.filter(purchase_date__lte=datetime.fromisoformat(dt).date())
            except ValueError:
                return Response({"detail": "Invalid date_to. Use YYYY-MM-DD."}, status=400)

        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(
                Q(reference_no__icontains=search) |
                Q(supplier__name__icontains=search) |
                Q(supplier__phone__icontains=search)
            )

        sort_by = (request.query_params.get("sort_by") or "date").lower()
        sort_dir = (request.query_params.get("sort_dir") or "desc").lower()
        sort_map = {
            "date":          "purchase_date",
            "reference_no":  "reference_no",
            "supplier_name": "supplier__name",
            "location":      "location__name",
            "grand_total":   "grand_total",
            "paid_amount":   "paid_amount",
            "payment_due":   "computed_due",
        }
        sort_field = sort_map.get(sort_by, "purchase_date")
        qs = qs.order_by(sort_field if sort_dir == "asc" else f"-{sort_field}", "-id")

        zero = Value(Decimal("0"), output_field=DecimalField(max_digits=14, decimal_places=2))
        summary = qs.aggregate(
            total_purchase   = Coalesce(Sum("grand_total"), zero),
            total_paid       = Coalesce(Sum("paid_amount"), zero),
            total_due        = Coalesce(Sum("computed_due"), zero),
            count_paid       = Coalesce(Sum(Case(When(payment_status="paid",    then=1), default=0)), Value(0)),
            count_partial    = Coalesce(Sum(Case(When(payment_status="partial", then=1), default=0)), Value(0)),
            count_due        = Coalesce(Sum(Case(When(payment_status="due",     then=1), default=0)), Value(0)),
        )

        try:
            limit = int(request.query_params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        if limit not in {10, 25, 50, 100}:
            limit = 25
        try:
            page = int(request.query_params.get("page", 1))
        except (ValueError, TypeError):
            page = 1
        page = max(page, 1)

        total_count = qs.count()
        total_pages = max((total_count + limit - 1) // limit, 1)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * limit
        rows = list(qs[offset: offset + limit])

        return Response({
            "results": PurchaseListSerializer(rows, many=True).data,
            "count": total_count,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "summary": {
                "total_purchase": str(summary["total_purchase"]),
                "total_paid":     str(summary["total_paid"]),
                "total_due":      str(summary["total_due"]),
                "count_paid":     summary["count_paid"],
                "count_partial":  summary["count_partial"],
                "count_due":      summary["count_due"],
            },
        })

    def post(self, request):
        serializer = CreatePurchaseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Multi-branch: force the purchase into the active branch.
        if _bid := active_branch_id():
            serializer.validated_data["location_id"] = _bid

        # ── Insufficient-balance guard ───────────────────────────────
        # If the cashier picked a PaymentAccount + a payment_amount,
        # block the save when that account doesn't have enough money
        # to cover the supplier payment. The frontend's pop-up alert
        # surfaces this 400 directly to the operator.
        from decimal import Decimal as _D
        pay_amount = _D(str(request.data.get("payment_amount") or 0))
        pay_account_id = request.data.get("payment_account_id")
        if pay_amount > 0 and pay_account_id:
            try:
                from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
                from django.db.models import Sum  # noqa: PLC0415
                acct = (
                    PaymentAccount.objects
                    .filter(id=pay_account_id, is_active=True)
                    .first()
                )
                if acct:
                    agg = acct.transactions.aggregate(t=Sum("amount"))["t"] or _D("0")
                    current_balance = (acct.opening_balance or _D("0")) + agg
                    if current_balance < pay_amount:
                        return Response({
                            "detail": (
                                f"Not enough balance in {acct.name}: "
                                f"৳{current_balance} available, ৳{pay_amount} required."
                            ),
                            "errors": {
                                "payment_account_id": (
                                    f"Insufficient balance — {acct.name} has only "
                                    f"৳{current_balance}. Top up the account or pick a "
                                    f"different one."
                                ),
                            },
                        }, status=status.HTTP_400_BAD_REQUEST)
            except Exception:
                # Accounting tables missing on a legacy tenant —
                # don't block the save; the create proceeds as before.
                pass

        purchase = services.create_purchase(data=serializer.validated_data, user=request.user)
        purchase = (
            Purchase.objects
            .select_related("supplier", "location")
            .prefetch_related("items", "payments")
            .get(pk=purchase.pk)
        )
        return Response(PurchaseDetailSerializer(purchase).data, status=status.HTTP_201_CREATED)


class PurchaseDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            purchase = (
                Purchase.objects
                .select_related("supplier", "location")
                .prefetch_related("items", "payments")
                .get(pk=pk)
            )
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)
        return Response(PurchaseDetailSerializer(purchase).data)

    def delete(self, request, pk):
        try:
            purchase = Purchase.objects.get(pk=pk)
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)
        # Any status can be deleted now. services.delete_purchase
        # reverses the stock this purchase posted (pulls its FIFO
        # layers back out of ProductStock, clamped at 0) and refunds
        # the linked payment accounts, then removes the rows — so the
        # books stay consistent. DRAFT purchases have nothing to
        # reverse and just delete.
        try:
            services.delete_purchase(purchase)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Delete purchase failed")
            return Response(
                {"detail": f"Could not delete this purchase: {exc}"},
                status=400,
            )
        return Response(status=204)

    def patch(self, request, pk):
        """Partial update — used by:
          • the Edit Purchase page (full body incl. items[]);
          • the Update Status action menu modal (status only);
          • the View Purchase shipping-details edit.

        When `items` is supplied it REPLACES every PurchaseItem
        attached to this purchase and recomputes subtotal +
        grand_total from the new lines. Payments stay intact;
        recompute_payment_status() adjusts payment_status afterwards
        so paid_amount / balance / chips on the list page reflect
        the new totals.

        Every successful edit appends one row to `edit_history` so
        the new History action menu item has a real audit trail.
        """
        try:
            purchase = (
                Purchase.objects
                .select_related("supplier", "location")
                .prefetch_related("items")
                .get(pk=pk)
            )
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)

        from decimal import Decimal as _D
        from django.db import transaction
        from django.utils import timezone as _tz

        data = request.data or {}
        changes = []   # human-readable summary lines for edit_history
        with transaction.atomic():
            if "reference_no" in data and data["reference_no"]:
                if str(data["reference_no"])[:80] != purchase.reference_no:
                    changes.append(f"Reference No: {purchase.reference_no} → {data['reference_no']}")
                purchase.reference_no = str(data["reference_no"])[:80]
            if "supplier_id" in data and data["supplier_id"] and str(data["supplier_id"]) != str(purchase.supplier_id):
                changes.append("Supplier changed")
                purchase.supplier_id = data["supplier_id"]
            if "location_id" in data and data["location_id"] and str(data["location_id"]) != str(purchase.location_id):
                changes.append("Location changed")
                purchase.location_id = data["location_id"]
            if "purchase_date" in data and data["purchase_date"]:
                if str(data["purchase_date"])[:10] != str(purchase.purchase_date)[:10]:
                    changes.append(f"Date: {purchase.purchase_date} → {data['purchase_date']}")
                purchase.purchase_date = data["purchase_date"]
            if "status" in data and data["status"] and data["status"] != purchase.status:
                changes.append(f"Status: {purchase.status} → {data['status']}")
                old_status = purchase.status
                purchase.status = data["status"]
                # Transition INTO received → the goods just arrived,
                # post them into inventory (FIFO layer + ProductStock
                # + StockMovement) exactly like a purchase created as
                # RECEIVED does. received_qty acts as the idempotency
                # guard: only the still-pending quantity posts, so a
                # purchase created as RECEIVED (received_qty already
                # = quantity) can never double-post.
                if (
                    purchase.status == Purchase.Status.RECEIVED
                    and old_status != Purchase.Status.RECEIVED
                ):
                    from inventory.services import add_stock_fifo  # noqa: PLC0415
                    for it in purchase.items.all():
                        pending_qty = _D(str(it.quantity or 0)) - _D(str(it.received_qty or 0))
                        if pending_qty <= 0:
                            continue
                        add_stock_fifo(
                            product_id     = it.product_id,
                            location_id    = purchase.location_id,
                            quantity       = pending_qty,
                            unit_cost      = it.unit_cost,
                            reference_type = "purchase",
                            reference_id   = purchase.id,
                        )
                        it.received_qty = it.quantity
                        it.save(update_fields=["received_qty"])
            if "payment_status" in data and data["payment_status"]:
                purchase.payment_status = data["payment_status"]
            if "notes" in data:
                purchase.notes = str(data["notes"] or "")
            if "shipping_details" in data:
                if str(data["shipping_details"] or "") != (purchase.shipping_details or ""):
                    changes.append("Shipping details edited")
                purchase.shipping_details = str(data["shipping_details"] or "")
            for k in ("discount_amount", "tax_amount", "shipping_cost"):
                if k in data and data[k] not in (None, ""):
                    try:
                        new_val = _D(str(data[k]))
                        if new_val != _D(str(getattr(purchase, k, 0) or 0)):
                            changes.append(f"{k}: {getattr(purchase, k)} → {new_val}")
                        setattr(purchase, k, new_val)
                    except Exception:
                        pass

            # Items replacement — when supplied, blow away the old
            # rows and recompute subtotal. This fixes the bug where
            # changing qty on the Edit Purchase form looked like
            # nothing happened (PATCH was silently skipping items[]).
            if isinstance(data.get("items"), list):
                from .models import PurchaseItem, Product  # noqa: PLC0415
                old_lines = list(purchase.items.values_list("product_id", "quantity", "unit_cost"))
                purchase.items.all().delete()
                new_subtotal = _D("0")
                for raw in data["items"]:
                    pid = raw.get("product_id")
                    if not pid:
                        continue
                    qty = _D(str(raw.get("quantity") or 0))
                    uc  = _D(str(raw.get("unit_cost") or 0))
                    if qty <= 0:
                        continue
                    tax_rate = _D(str(raw.get("tax_rate") or 0))
                    discount = _D(str(raw.get("discount") or 0))
                    after_disc_per_unit = uc - (discount / qty if qty > 0 else _D("0"))
                    line_subtotal_pre_tax = after_disc_per_unit * qty
                    line_tax = line_subtotal_pre_tax * tax_rate / _D("100")
                    line_total = (line_subtotal_pre_tax + line_tax).quantize(_D("0.01"))
                    product = Product.objects.filter(pk=pid).only("name", "sku").first()
                    PurchaseItem.objects.create(
                        purchase    = purchase,
                        product_id  = pid,
                        product_name= (product.name if product else (raw.get("product_name") or "")),
                        sku         = (product.sku if product else (raw.get("sku") or "")),
                        quantity    = qty,
                        unit_cost   = uc,
                        tax_rate    = tax_rate,
                        discount    = discount,
                        line_total  = line_total,
                        received_qty= qty,
                    )
                    new_subtotal += (after_disc_per_unit * qty)
                purchase.subtotal = new_subtotal.quantize(_D("0.01"))
                changes.append(f"Items replaced: {len(old_lines)} → {sum(1 for _ in data['items'])}")

            # Recompute grand_total = subtotal − discount + tax + shipping
            old_grand_total = _D(str(purchase.grand_total or 0))
            purchase.grand_total = (
                (_D(str(purchase.subtotal or 0)))
                - (_D(str(purchase.discount_amount or 0)))
                + (_D(str(purchase.tax_amount or 0)))
                + (_D(str(purchase.shipping_cost or 0)))
            )

            # ── Auto-adjust the linked PaymentAccount when the total
            # changes. If the new grand_total is LOWER than the old
            # (operator dropped a qty, e.g. 100→200… err 100→50), the
            # supplier effectively owes the operator the difference,
            # so we credit it back to the cash/bank account the
            # original payment(s) came out of.
            # Symmetric in the other direction (rare on Edit Purchase
            # but supported): supply goes up, debit the same account
            # by the delta. The amounts post via
            # PaymentAccountTransaction so the List Accounts page
            # reflects the truth.
            delta = old_grand_total - purchase.grand_total
            if delta != 0:
                try:
                    from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415

                    # Resolution chain — first hit wins:
                    #   1. Most recent payment row's linked account.
                    #   2. The first active CASH PaymentAccount.
                    #   3. The first active account of any type.
                    # Without (2) and (3) the bug the user reported
                    # would recur on every legacy purchase whose
                    # payment rows were created before
                    # payment_account_id existed.
                    acct = None
                    target_pa_id = (
                        purchase.payments
                        .exclude(payment_account_id__isnull=True)
                        .order_by("-paid_at")
                        .values_list("payment_account_id", flat=True)
                        .first()
                    )
                    if target_pa_id:
                        acct = PaymentAccount.objects.filter(id=target_pa_id, is_active=True).first()
                    if not acct:
                        acct = PaymentAccount.objects.filter(
                            account_type=PaymentAccount.AccountType.CASH,
                            is_active=True,
                        ).order_by("name").first()
                    if not acct:
                        acct = PaymentAccount.objects.filter(is_active=True).order_by("name").first()

                    if acct:
                        PaymentAccountTransaction.objects.create(
                            account=acct,
                            kind=PaymentAccountTransaction.Kind.ADJUSTMENT,
                            # delta > 0 → grand_total dropped →
                            # money comes BACK (positive). delta < 0
                            # → grand_total rose → money goes out
                            # (negative).
                            amount=_D(str(delta)),
                            reference=purchase.reference_no or "",
                            note=(
                                f"Purchase {purchase.reference_no} edited — "
                                f"total {old_grand_total} → {purchase.grand_total}"
                            ),
                        )
                        # Backfill the linked account onto the
                        # most-recent payment row when it was empty,
                        # so the NEXT edit hits step (1) and stays in
                        # the same ledger.
                        most_recent = (
                            purchase.payments
                            .filter(payment_account_id__isnull=True)
                            .order_by("-paid_at")
                            .first()
                        )
                        if most_recent:
                            most_recent.payment_account_id = acct.id
                            most_recent.save(update_fields=["payment_account_id"])

                        changes.append(
                            f"Cash adjustment posted to {acct.name}: {delta:+}"
                        )
                except Exception as _exc:
                    # Ledger app missing on a legacy tenant — don't
                    # block the edit; the audit log still records
                    # the diff. The exception is swallowed to keep
                    # the transaction commit-able.
                    import logging as _lg
                    _lg.getLogger(__name__).exception(
                        "Purchase edit could not write PaymentAccount adjustment: %s",
                        _exc,
                    )

            # Audit trail — appended only when SOMETHING actually
            # changed, so a blank PATCH doesn't pollute the log.
            if changes:
                user = request.user
                actor = getattr(user, "name", "") or getattr(user, "email", "") or str(getattr(user, "id", ""))
                history = list(purchase.edit_history or [])
                history.append({
                    "at":      _tz.now().isoformat(),
                    "by":      actor,
                    "action":  "edit",
                    "summary": "; ".join(changes),
                })
                purchase.edit_history = history

            purchase.save()
            purchase.recompute_payment_status()
            purchase.save(update_fields=["payment_status"])

        return Response(PurchaseDetailSerializer(purchase).data)


class PurchasePaymentView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        try:
            purchase = Purchase.objects.get(pk=pk)
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)

        try:
            amount = Decimal(str(request.data.get("amount") or 0))
        except Exception:
            return Response({"detail": "Invalid amount."}, status=400)
        if amount <= 0:
            return Response({"detail": "Amount must be > 0."}, status=400)

        method    = request.data.get("method") or "cash"
        reference = request.data.get("reference", "") or ""
        notes     = request.data.get("notes", "") or request.data.get("note", "") or ""
        payment_account_id = request.data.get("payment_account_id") or None
        paid_at_raw = request.data.get("paid_at") or request.data.get("date") or None

        # ── Insufficient-balance guard ───────────────────────────────
        # Same shape as the Add Purchase guard above — if the chosen
        # ledger can't cover the payment, return 400 with a clear
        # message the frontend pop-up can surface verbatim.
        if payment_account_id:
            try:
                from accounting.models import PaymentAccount  # noqa: PLC0415
                from django.db.models import Sum  # noqa: PLC0415
                acct = (
                    PaymentAccount.objects
                    .filter(id=payment_account_id, is_active=True)
                    .first()
                )
                if acct:
                    agg = acct.transactions.aggregate(t=Sum("amount"))["t"] or Decimal("0")
                    current_balance = (acct.opening_balance or Decimal("0")) + agg
                    if current_balance < amount:
                        return Response({
                            "detail": (
                                f"Not enough balance in {acct.name}: "
                                f"৳{current_balance} available, ৳{amount} required."
                            ),
                            "errors": {
                                "payment_account_id": (
                                    f"Insufficient balance — {acct.name} has only "
                                    f"৳{current_balance}. Top up the account or pick a "
                                    f"different one."
                                ),
                            },
                        }, status=400)
            except Exception:
                pass

        # Parse the optional paid_at — accepts "YYYY-MM-DD HH:MM" or
        # ISO 8601. Falls back to "now" (default on the model) when
        # missing or unparseable.
        paid_at = None
        if paid_at_raw:
            from django.utils.dateparse import parse_datetime, parse_date  # noqa: PLC0415
            paid_at = parse_datetime(str(paid_at_raw)) or parse_date(str(paid_at_raw))

        payment = services.add_payment(
            purchase  = purchase,
            amount    = amount,
            method    = method,
            reference = reference,
            notes     = notes,
            payment_account_id = payment_account_id,
            paid_at   = paid_at,
        )
        return Response(PurchasePaymentSerializer(payment).data, status=201)


class PurchaseReturnListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = PurchaseReturn.objects.select_related("supplier", "location", "purchase")

        if sid := request.query_params.get("supplier_id"):
            qs = qs.filter(supplier_id=sid)
        if lid := request.query_params.get("location_id"):
            qs = qs.filter(location_id=lid)
        if st := request.query_params.get("status"):
            qs = qs.filter(status=st.lower())

        df = request.query_params.get("date_from")
        dt = request.query_params.get("date_to")
        if df:
            try:
                qs = qs.filter(return_date__gte=datetime.fromisoformat(df).date())
            except ValueError:
                return Response({"detail": "Invalid date_from."}, status=400)
        if dt:
            try:
                qs = qs.filter(return_date__lte=datetime.fromisoformat(dt).date())
            except ValueError:
                return Response({"detail": "Invalid date_to."}, status=400)

        if search := request.query_params.get("search", "").strip():
            qs = qs.filter(
                Q(reference_no__icontains=search) |
                Q(supplier__name__icontains=search) |
                Q(purchase__reference_no__icontains=search)
            )

        qs = qs.order_by("-return_date", "-created_at")

        try:
            limit = int(request.query_params.get("limit", 25))
        except (ValueError, TypeError):
            limit = 25
        if limit not in {10, 25, 50, 100}:
            limit = 25
        try:
            page = int(request.query_params.get("page", 1))
        except (ValueError, TypeError):
            page = 1
        page = max(page, 1)

        total_count = qs.count()
        total_pages = max((total_count + limit - 1) // limit, 1)
        if page > total_pages:
            page = total_pages
        offset = (page - 1) * limit
        rows = list(qs[offset: offset + limit])

        zero = Value(Decimal("0"), output_field=DecimalField(max_digits=14, decimal_places=2))
        summary = qs.aggregate(total_return=Coalesce(Sum("total_amount"), zero))

        return Response({
            "results": PurchaseReturnListSerializer(rows, many=True).data,
            "count": total_count,
            "page": page,
            "limit": limit,
            "total_pages": total_pages,
            "summary": {"total_return": str(summary["total_return"])},
        })

    def post(self, request):
        serializer = CreatePurchaseReturnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        pr = services.create_purchase_return(data=serializer.validated_data, user=request.user)
        pr = (
            PurchaseReturn.objects
            .select_related("supplier", "location", "purchase")
            .prefetch_related("items")
            .get(pk=pr.pk)
        )
        return Response(PurchaseReturnDetailSerializer(pr).data, status=201)


class PurchaseReturnDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        try:
            pr = (
                PurchaseReturn.objects
                .select_related("supplier", "location", "purchase")
                .prefetch_related("items")
                .get(pk=pk)
            )
        except PurchaseReturn.DoesNotExist:
            return Response({"detail": "Return not found."}, status=404)
        return Response(PurchaseReturnDetailSerializer(pr).data)

    def patch(self, request, pk):
        """Partial update — used by the Edit Purchase Return page.
        Whitelisted header fields update in place; `items` is
        special-cased: when supplied it REPLACES every existing
        PurchaseReturnItem on the return with the new list, and
        the total_amount is recomputed from the line totals. Past
        ledger / payment rows are untouched."""
        from django.db import transaction  # noqa: PLC0415
        from decimal import Decimal as _D  # noqa: PLC0415
        try:
            pr = PurchaseReturn.objects.get(pk=pk)
        except PurchaseReturn.DoesNotExist:
            return Response({"detail": "Return not found."}, status=404)

        data = request.data or {}
        with transaction.atomic():
            if "reference_no" in data and data["reference_no"]:
                pr.reference_no = str(data["reference_no"])[:80]
            if "supplier_id" in data and data["supplier_id"]:
                pr.supplier_id = data["supplier_id"]
            if "location_id" in data and data["location_id"]:
                pr.location_id = data["location_id"]
            if "return_date" in data and data["return_date"]:
                pr.return_date = data["return_date"]
            if "status" in data and data["status"]:
                pr.status = data["status"]
            if "notes" in data:
                pr.notes = str(data["notes"] or "")

            if "items" in data and isinstance(data["items"], list):
                # Replace items wholesale — the simplified Edit UI
                # ships the full new list, including untouched rows.
                pr.items.all().delete()
                total = _D("0")
                for raw in data["items"]:
                    pid = raw.get("product_id")
                    if not pid:
                        continue
                    qty = _D(str(raw.get("quantity") or 0))
                    uc  = _D(str(raw.get("unit_cost") or 0))
                    if qty <= 0:
                        continue
                    line = (qty * uc).quantize(_D("0.01"))
                    from .models import PurchaseReturnItem  # noqa: PLC0415
                    PurchaseReturnItem.objects.create(
                        purchase_return = pr,
                        product_id      = pid,
                        product_name    = raw.get("product_name") or "",
                        sku             = raw.get("sku") or "",
                        quantity        = qty,
                        unit_cost       = uc,
                        line_total      = line,
                    )
                    total += line
                pr.total_amount = total
            pr.save()

        # Refresh prefetch + return the updated detail payload.
        pr = (
            PurchaseReturn.objects
            .select_related("supplier", "location", "purchase")
            .prefetch_related("items", "payments")
            .get(pk=pr.pk)
        )
        return Response(PurchaseReturnDetailSerializer(pr).data)


# ─────────────────────────────────────────────────────────────────────────
# PurchaseNotificationView — Items Received Notification email send.
# Powers the "Items Received Notification" modal on the All Purchases
# action menu. Substitutes the {placeholder} tags using purchase +
# supplier + company-profile data, then delivers via Django's
# configured email backend.
# ─────────────────────────────────────────────────────────────────────────
class PurchaseNotificationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        """Return the tag substitutions + default template so the
        frontend modal can render a pre-filled message."""
        try:
            purchase = (
                Purchase.objects
                .select_related("supplier", "location")
                .get(pk=pk)
            )
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)

        # Pull tenant company profile from SystemSetting — no
        # hardcoded business name / logo URL.
        company = self._company_profile()

        ctx = self._context(purchase, company)
        default_subject = "Items received, from {business_name}"
        default_body = (
            "Dear {contact_name},\n\n"
            "We have received all items from invoice reference number "
            "{order_ref_number}. Thank you for processing it.\n\n"
            "{business_name}\n"
            "{business_logo}"
        )
        return Response({
            "purchase": {
                "id":           str(purchase.id),
                "reference_no": purchase.reference_no,
                "supplier_email": purchase.supplier.email if purchase.supplier else "",
                "supplier_name":  purchase.supplier.name if purchase.supplier else "",
            },
            "tags": ctx,
            "default_subject": default_subject,
            "default_body":    default_body,
        })

    def post(self, request, pk):
        """Substitute {placeholders} in the supplied subject + body
        with live purchase / supplier / company-profile values and
        send the email."""
        try:
            purchase = (
                Purchase.objects
                .select_related("supplier", "location")
                .get(pk=pk)
            )
        except Purchase.DoesNotExist:
            return Response({"detail": "Purchase not found."}, status=404)

        data    = request.data or {}
        to_raw  = (data.get("to") or "").strip()
        if not to_raw:
            return Response({"detail": "Recipient email is required."}, status=400)
        # Allow comma- or semicolon-separated lists.
        recipients = [s.strip() for s in to_raw.replace(";", ",").split(",") if s.strip()]
        cc_raw  = (data.get("cc")  or "").strip()
        bcc_raw = (data.get("bcc") or "").strip()
        cc      = [s.strip() for s in cc_raw.replace(";", ",").split(",")  if s.strip()]
        bcc     = [s.strip() for s in bcc_raw.replace(";", ",").split(",") if s.strip()]

        subject = data.get("subject") or ""
        body    = data.get("body")    or ""

        company = self._company_profile()
        ctx = self._context(purchase, company)
        subject = self._substitute(subject, ctx)
        body    = self._substitute(body, ctx)

        # Render the email — body may contain HTML (TinyMCE output).
        # Send as multipart so both plaintext + HTML clients render.
        from django.conf import settings as dj_settings  # noqa: PLC0415
        from django.core.mail import EmailMultiAlternatives  # noqa: PLC0415
        from_email = getattr(dj_settings, "DEFAULT_FROM_EMAIL", "") or (company.get("email") or "noreply@iffaa.local")
        try:
            msg = EmailMultiAlternatives(
                subject=subject,
                body=self._strip_tags(body),
                from_email=from_email,
                to=recipients,
                cc=cc or None,
                bcc=bcc or None,
            )
            if "<" in body and ">" in body:
                msg.attach_alternative(body, "text/html")
            msg.send(fail_silently=False)
        except Exception as exc:
            # Still record the attempt for the operator; surface the
            # underlying error verbatim so they can fix SMTP creds.
            return Response({"detail": f"Send failed: {exc}"}, status=400)

        return Response({
            "ok": True,
            "to": recipients,
            "cc": cc,
            "bcc": bcc,
            "subject": subject,
        })

    # ── helpers ─────────────────────────────────────────────────────

    @staticmethod
    def _company_profile():
        """Return the tenant company profile as a plain dict — pulls
        live from SystemSetting via the same source the company
        profile endpoint uses. Empty dict if the table is missing."""
        try:
            from system_config.models import SystemSetting  # noqa: PLC0415
        except Exception:
            return {}
        try:
            settings_qs = SystemSetting.objects.values_list("key", "value_str")
            return {k.replace("company.", ""): v for k, v in settings_qs if k.startswith("company.")}
        except Exception:
            return {}

    @staticmethod
    def _context(purchase, company):
        sup = purchase.supplier
        ctx = {
            "business_name":      company.get("business_name", "") or "",
            "business_logo":      company.get("logo_url", "") or "",
            "order_ref_number":   purchase.reference_no or "",
            "contact_name":       (sup.name if sup else "") or "Supplier",
            "contact_business_name": (sup.name if sup else "") or "",
        }
        # Custom contact fields 1..10 (Supplier model exposes
        # `custom_field_1..10` for the import flow). Default to "" so
        # the substitution never leaves a stray placeholder.
        for n in range(1, 11):
            key = f"contact_custom_field_{n}"
            ctx[key] = (getattr(sup, f"custom_field_{n}", "") if sup else "") or ""
        return ctx

    @staticmethod
    def _substitute(text, ctx):
        if not text:
            return ""
        out = text
        for k, v in ctx.items():
            out = out.replace("{" + k + "}", str(v or ""))
        return out

    @staticmethod
    def _strip_tags(html):
        """Lightweight HTML → plaintext fallback for the multipart
        text body. We don't pull bleach in just for this."""
        import re
        if not html:
            return ""
        return re.sub(r"<[^>]+>", "", html)


# ─────────────────────────────────────────────────────────────────────────
# Purchase Return payment helpers
# ─────────────────────────────────────────────────────────────────────────
def _post_return_ledger(payment, *, reversal=False):
    """Write a PaymentAccountTransaction for a refund payment.

    A purchase-return refund is money IN to the chosen account
    (DEPOSIT, positive amount). On reversal (delete / edit) we
    post a matching negative row so the running balance returns
    to where it was. Never raises — just logs and moves on if
    the accounting models aren't reachable.
    """
    if not payment.payment_account_id:
        return
    try:
        from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
    except Exception:
        return
    acct = PaymentAccount.objects.filter(id=payment.payment_account_id, is_active=True).first()
    if not acct:
        return
    sign = Decimal("-1") if reversal else Decimal("1")
    PaymentAccountTransaction.objects.create(
        account=acct,
        kind=PaymentAccountTransaction.Kind.DEPOSIT,
        amount=sign * Decimal(str(payment.amount or 0)),
        reference=payment.reference or "",
        note=(
            f"Purchase-return refund "
            f"(return {payment.purchase_return.reference_no})"
            + (" — reversal" if reversal else "")
        ),
    )


def _parse_paid_at(raw):
    if not raw:
        return None
    from django.utils.dateparse import parse_datetime, parse_date  # noqa: PLC0415
    return parse_datetime(str(raw)) or parse_date(str(raw))


class PurchaseReturnPaymentView(APIView):
    """GET (list) + POST (create) /api/purchases/returns/<id>/payments/"""
    permission_classes = [IsAuthenticated]

    def get(self, request, pk):
        from .models import PurchaseReturn, PurchaseReturnPayment  # noqa: PLC0415
        if not PurchaseReturn.objects.filter(pk=pk).exists():
            return Response({"detail": "Return not found."}, status=404)
        rows = PurchaseReturnPayment.objects.filter(purchase_return_id=pk)
        from .serializers import PurchaseReturnPaymentSerializer  # noqa: PLC0415
        return Response(PurchaseReturnPaymentSerializer(rows, many=True).data)

    def post(self, request, pk):
        from django.db import transaction  # noqa: PLC0415
        from .models import PurchaseReturn, PurchaseReturnPayment  # noqa: PLC0415
        try:
            pr = PurchaseReturn.objects.get(pk=pk)
        except PurchaseReturn.DoesNotExist:
            return Response({"detail": "Return not found."}, status=404)
        data = request.data or {}
        try:
            amount = Decimal(str(data.get("amount") or 0))
        except Exception:
            return Response({"detail": "Invalid amount."}, status=400)
        if amount <= 0:
            return Response({"detail": "Amount must be > 0."}, status=400)

        with transaction.atomic():
            p = PurchaseReturnPayment.objects.create(
                purchase_return = pr,
                reference_no = (data.get("reference_no") or "")[:80],
                amount = amount,
                method = data.get("method") or "cash",
                reference = data.get("reference") or "",
                notes = data.get("notes") or data.get("note") or "",
                payment_account_id = data.get("payment_account_id") or None,
                paid_at = _parse_paid_at(data.get("paid_at") or data.get("date")) or timezone.now(),
            )
            _post_return_ledger(p)
        from .serializers import PurchaseReturnPaymentSerializer  # noqa: PLC0415
        return Response(PurchaseReturnPaymentSerializer(p).data, status=201)


class PurchaseReturnPaymentDetailView(APIView):
    """GET / PATCH / DELETE /api/purchases/returns/payments/<pid>/"""
    permission_classes = [IsAuthenticated]

    def _get_payment(self, pk):
        from .models import PurchaseReturnPayment  # noqa: PLC0415
        try:
            return PurchaseReturnPayment.objects.select_related("purchase_return").get(pk=pk)
        except PurchaseReturnPayment.DoesNotExist:
            return None

    def get(self, request, pk):
        p = self._get_payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        from .serializers import PurchaseReturnPaymentSerializer  # noqa: PLC0415
        return Response(PurchaseReturnPaymentSerializer(p).data)

    def patch(self, request, pk):
        from django.db import transaction  # noqa: PLC0415
        p = self._get_payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        data = request.data or {}
        with transaction.atomic():
            # Reverse the OLD ledger row before applying changes so
            # the running balance is correct regardless of what the
            # operator edits (amount, account, method).
            _post_return_ledger(p, reversal=True)

            if "amount" in data and data["amount"] not in (None, ""):
                try:
                    p.amount = Decimal(str(data["amount"]))
                except Exception:
                    return Response({"detail": "Invalid amount."}, status=400)
            if "method" in data and data["method"]:
                p.method = data["method"]
            if "reference" in data:
                p.reference = str(data["reference"] or "")
            if "notes" in data or "note" in data:
                p.notes = str(data.get("notes") or data.get("note") or "")
            if "payment_account_id" in data:
                p.payment_account_id = data["payment_account_id"] or None
            paid_at = _parse_paid_at(data.get("paid_at") or data.get("date"))
            if paid_at is not None:
                p.paid_at = paid_at
            if "reference_no" in data:
                p.reference_no = str(data["reference_no"] or "")[:80]
            p.save()
            _post_return_ledger(p)

        from .serializers import PurchaseReturnPaymentSerializer  # noqa: PLC0415
        return Response(PurchaseReturnPaymentSerializer(p).data)

    def delete(self, request, pk):
        from django.db import transaction  # noqa: PLC0415
        p = self._get_payment(pk)
        if not p:
            return Response({"detail": "Payment not found."}, status=404)
        with transaction.atomic():
            _post_return_ledger(p, reversal=True)
            p.delete()
        return Response(status=204)
