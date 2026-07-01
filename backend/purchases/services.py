"""
Purchases business logic.

Creating a purchase:
  1. Generate reference_no if not provided.
  2. Snapshot product_name/sku and compute line_total (qty * unit_cost - discount).
  3. Compute header totals (subtotal, tax, grand_total).
  4. If status == RECEIVED, set received_qty = quantity for each line.
  5. Record initial payment if payment_amount > 0.
"""
from decimal import Decimal
import logging
import secrets
from typing import List, Dict, Any

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

from inventory.models import Product, Location

from .models import (
    Supplier, Purchase, PurchaseItem, PurchasePayment,
    PurchaseReturn, PurchaseReturnItem,
)


def _gen_ref(prefix: str = "PO") -> str:
    return f"{prefix}-{timezone.now().strftime('%Y%m%d')}-{secrets.token_hex(3).upper()}"


def _calc_line(quantity: Decimal, unit_cost: Decimal,
               tax_rate: Decimal, discount: Decimal) -> Decimal:
    base = (quantity * unit_cost) - discount
    if base < 0:
        base = Decimal("0")
    tax = base * (tax_rate / Decimal("100"))
    return (base + tax).quantize(Decimal("0.01"))


def _calc_line_tax(quantity: Decimal, unit_cost: Decimal,
                   tax_rate: Decimal, discount: Decimal) -> Decimal:
    base = (quantity * unit_cost) - discount
    if base < 0:
        base = Decimal("0")
    return (base * (tax_rate / Decimal("100"))).quantize(Decimal("0.01"))


@transaction.atomic
def create_purchase(*, data: Dict[str, Any], user) -> Purchase:
    supplier = Supplier.objects.get(pk=data["supplier_id"])
    location = Location.objects.get(pk=data["location_id"])

    purchase = Purchase.objects.create(
        reference_no    = (data.get("reference_no") or "").strip() or _gen_ref(),
        supplier        = supplier,
        location        = location,
        purchase_date   = data.get("purchase_date") or timezone.localdate(),
        status          = data.get("status") or Purchase.Status.RECEIVED,
        discount_amount = Decimal(str(data.get("discount_amount") or 0)),
        shipping_cost   = Decimal(str(data.get("shipping_cost") or 0)),
        notes           = data.get("notes", "") or "",
        shipping_details = data.get("shipping_details", "") or "",
        added_by_id     = getattr(user, "id", None),
        added_by_name   = getattr(user, "name", "") or getattr(user, "email", "") or "",
    )

    subtotal   = Decimal("0")
    tax_total  = Decimal("0")

    for raw in data["items"]:
        product   = Product.objects.get(pk=raw["product_id"])
        quantity  = Decimal(str(raw["quantity"]))
        unit_cost = Decimal(str(raw["unit_cost"]))
        tax_rate  = Decimal(str(raw.get("tax_rate") or 0))
        discount  = Decimal(str(raw.get("discount") or 0))
        line_total = _calc_line(quantity, unit_cost, tax_rate, discount)
        line_tax   = _calc_line_tax(quantity, unit_cost, tax_rate, discount)

        PurchaseItem.objects.create(
            purchase     = purchase,
            product      = product,
            product_name = product.name,
            sku          = product.sku,
            quantity     = quantity,
            unit_cost    = unit_cost,
            tax_rate     = tax_rate,
            discount     = discount,
            line_total   = line_total,
            received_qty = quantity if purchase.status == Purchase.Status.RECEIVED else Decimal("0"),
        )

        subtotal  += (quantity * unit_cost) - discount
        tax_total += line_tax

        # ── Post the goods into inventory ─────────────────────────
        # A RECEIVED purchase means the items are physically in the
        # warehouse, so they must enter the FIFO queue + ProductStock
        # immediately — this is what makes the Current Stock column
        # on List Products (and POS availability checks) move after
        # a purchase. PENDING/ORDERED purchases post later, when the
        # status flips to received (see PurchaseDetailView.patch).
        if purchase.status == Purchase.Status.RECEIVED:
            from inventory.services import add_stock_fifo  # noqa: PLC0415
            add_stock_fifo(
                product_id     = product.id,
                location_id    = location.id,
                quantity       = quantity,
                unit_cost      = unit_cost,
                reference_type = "purchase",
                reference_id   = purchase.id,
            )

    purchase.subtotal        = subtotal.quantize(Decimal("0.01"))
    purchase.tax_amount      = tax_total
    purchase.grand_total     = (subtotal - purchase.discount_amount + tax_total + purchase.shipping_cost).quantize(Decimal("0.01"))
    purchase.recompute_payment_status()
    purchase.save()

    # Initial payment (optional). Route it through add_payment so — when a
    # payment account is chosen — the cash actually leaves that account
    # (a WITHDRAWAL posts to List Accounts) and the account is stored on the
    # payment row, which is what lets a later purchase return refund it back.
    pay_amount = Decimal(str(data.get("payment_amount") or 0))
    if pay_amount > 0:
        add_payment(
            purchase           = purchase,
            amount             = pay_amount,
            method             = data.get("payment_method") or PurchasePayment.Method.CASH,
            reference          = data.get("payment_reference", "") or "",
            payment_account_id = data.get("payment_account_id") or None,
        )
    return purchase


@transaction.atomic
def add_payment(*, purchase: Purchase, amount: Decimal, method: str,
                reference: str = "", notes: str = "",
                payment_account_id=None,
                paid_at=None) -> PurchasePayment:
    """Create one PurchasePayment row and, when a payment_account_id
    is supplied, also write a PaymentAccountTransaction so the
    supplier payment shows up on the Account Book / List Accounts
    page as money OUT of the chosen cash box / bank account / MFS
    wallet.

    Mirrors the sales.services pattern for sale payments — the
    purchase ledger side just uses a negative-amount WITHDRAWAL
    instead of a positive SALE row.
    """
    create_kwargs = dict(
        purchase  = purchase,
        amount    = amount,
        method    = method,
        reference = reference,
        notes     = notes,
        payment_account_id = payment_account_id,
    )
    if paid_at is not None:
        create_kwargs["paid_at"] = paid_at
    payment = PurchasePayment.objects.create(**create_kwargs)

    purchase.paid_amount = (purchase.paid_amount or Decimal("0")) + amount
    purchase.recompute_payment_status()
    purchase.save(update_fields=["paid_amount", "payment_status", "updated_at"])

    # Money OUT of the linked payment account.
    if payment_account_id:
        try:
            from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
            acct = (
                PaymentAccount.objects
                .filter(id=payment_account_id, is_active=True)
                .first()
            )
            if acct:
                PaymentAccountTransaction.objects.create(
                    account=acct,
                    kind=PaymentAccountTransaction.Kind.WITHDRAWAL,
                    # Negative amount — supplier payment is money OUT.
                    amount=Decimal("-1") * Decimal(str(amount or 0)),
                    reference=reference or "",
                    note=f"Supplier payment (purchase {purchase.reference_no or purchase.id})",
                )
        except Exception:
            # Don't bomb the payment write if the accounting tables
            # aren't fully migrated on this tenant yet.
            pass

    return payment


# ── Returns ──────────────────────────────────────────────────────────────────

@transaction.atomic
@transaction.atomic
def create_purchase_return(*, data: Dict[str, Any], user) -> PurchaseReturn:
    supplier = Supplier.objects.get(pk=data["supplier_id"])
    location = Location.objects.get(pk=data["location_id"])

    purchase = None
    if data.get("purchase_id"):
        purchase = Purchase.objects.filter(pk=data["purchase_id"]).first()

    pr = PurchaseReturn.objects.create(
        reference_no  = (data.get("reference_no") or "").strip() or _gen_ref("PR"),
        purchase      = purchase,
        supplier      = supplier,
        location      = location,
        return_date   = data.get("return_date") or timezone.localdate(),
        notes         = data.get("notes", "") or "",
        added_by_id   = getattr(user, "id", None),
        added_by_name = getattr(user, "name", "") or getattr(user, "email", "") or "",
    )

    total = Decimal("0")
    return_lines = []
    for raw in data["items"]:
        product   = Product.objects.get(pk=raw["product_id"])
        quantity  = Decimal(str(raw["quantity"]))
        unit_cost = Decimal(str(raw["unit_cost"]))
        line      = (quantity * unit_cost).quantize(Decimal("0.01"))
        PurchaseReturnItem.objects.create(
            purchase_return = pr,
            product         = product,
            product_name    = product.name,
            sku             = product.sku,
            quantity        = quantity,
            unit_cost       = unit_cost,
            line_total      = line,
        )
        total += line
        return_lines.append((product, quantity, unit_cost))

    pr.total_amount = total
    pr.save(update_fields=["total_amount", "updated_at"])

    # ── Reverse inventory ───────────────────────────────────────────────────
    # Returned goods leave the warehouse, so on-hand stock must DROP by the
    # returned quantity (the purchase had increased it). Pull the qty back out
    # of ProductStock (clamped at 0), draw down this purchase's FIFO layers
    # (oldest first) to keep cost layers honest, and log a StockMovement OUT.
    try:
        from inventory.models import FIFOLayer, ProductStock, StockMovement  # noqa: PLC0415
        for product, quantity, unit_cost in return_lines:
            if quantity <= 0:
                continue
            ps = (
                ProductStock.objects
                .filter(product_id=product.id, location_id=location.id)
                .first()
            )
            if ps:
                new_qty = (ps.quantity or Decimal("0")) - quantity
                ps.quantity = new_qty if new_qty > 0 else Decimal("0")
                ps.save(update_fields=["quantity"])
            if purchase:
                remaining = quantity
                for layer in FIFOLayer.objects.filter(
                    reference_type="purchase", reference_id=purchase.id,
                    product_id=product.id,
                ).order_by("created_at"):
                    if remaining <= 0:
                        break
                    avail = layer.remaining_qty or Decimal("0")
                    take = avail if avail < remaining else remaining
                    if take > 0:
                        layer.remaining_qty = avail - take
                        layer.save(update_fields=["remaining_qty"])
                        remaining -= take
            StockMovement.objects.create(
                product_id     = product.id,
                location_id    = location.id,
                movement_type  = StockMovement.Type.OUT,
                quantity       = quantity,
                unit_cost      = unit_cost,
                reference_type = "purchase_return",
                reference_id   = pr.id,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Purchase return %s: inventory reversal failed", pr.id)

    # ── Refund cash to the account the purchase was paid from ───────────────
    # If the original purchase was paid (e.g. cash from "Cash on Hand"), a
    # return puts that money back IN to the same account. Record it as a
    # PurchaseReturnPayment + a DEPOSIT so the List Accounts balance rises and
    # the refund is tracked / reversible. Unpaid (credit) purchases move no
    # cash — there was nothing to refund.
    if purchase and total > 0:
        try:
            from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
            from .models import PurchaseReturnPayment  # noqa: PLC0415
            pays = list(purchase.payments.all())
            paid_total = sum((Decimal(str(p.amount or 0)) for p in pays), Decimal("0"))
            acct_id = next(
                (p.payment_account_id for p in pays if getattr(p, "payment_account_id", None)),
                None,
            )
            refund_amt = total if paid_total >= total else paid_total
            if acct_id and refund_amt > 0:
                acct = PaymentAccount.objects.filter(id=acct_id).first()
                if acct:
                    PurchaseReturnPayment.objects.create(
                        purchase_return    = pr,
                        amount             = refund_amt,
                        method             = PurchaseReturnPayment.Method.CASH,
                        payment_account_id = acct_id,
                        notes              = "Auto refund on purchase return",
                    )
                    PaymentAccountTransaction.objects.create(
                        account   = acct,
                        kind      = PaymentAccountTransaction.Kind.DEPOSIT,
                        amount    = refund_amt,
                        reference = "",
                        note      = f"Purchase-return refund (return {pr.reference_no})",
                    )
        except Exception:  # noqa: BLE001
            logger.exception("Purchase return %s: cash refund failed", pr.id)

    return pr


# ── Delete (with full reversal of stock + payment-account effects) ───────────

@transaction.atomic
def delete_purchase(purchase: Purchase) -> None:
    """Delete a purchase of ANY status, reversing everything it posted so
    the books stay consistent:

      1. Inventory — for every FIFO layer this purchase created
         (reference_type="purchase", reference_id=purchase.id) pull the
         still-on-hand quantity back out of ProductStock (clamped at 0 so
         partially-sold stock never goes negative), write a reversing
         StockMovement(OUT) for audit, then delete the layers.
      2. Payment accounts — for every PurchasePayment that posted a
         WITHDRAWAL into a PaymentAccount, post the opposite (positive)
         ADJUSTMENT so the cash/bank balance is restored.
      3. Delete the purchase (cascades PurchaseItem + PurchasePayment).

    DRAFT purchases (no stock, no payments) just fall straight through to
    the delete with nothing to reverse.
    """
    from decimal import Decimal as _D  # noqa: PLC0415

    # ── 1. Reverse inventory ────────────────────────────────────────────
    try:
        from inventory.models import FIFOLayer, ProductStock, StockMovement  # noqa: PLC0415
        layers = FIFOLayer.objects.filter(
            reference_type="purchase", reference_id=purchase.id,
        )
        for layer in layers:
            pull = _D(str(layer.remaining_qty or 0))
            if pull > 0:
                ps = (
                    ProductStock.objects
                    .filter(product_id=layer.product_id, location_id=layer.location_id)
                    .first()
                )
                if ps:
                    new_qty = _D(str(ps.quantity or 0)) - pull
                    if new_qty < 0:
                        new_qty = _D("0")
                    ps.quantity = new_qty
                    ps.save(update_fields=["quantity"])
                StockMovement.objects.create(
                    product_id     = layer.product_id,
                    location_id    = layer.location_id,
                    movement_type  = StockMovement.Type.OUT,
                    quantity       = pull,
                    unit_cost      = layer.unit_cost,
                    reference_type = "purchase_delete",
                    reference_id   = purchase.id,
                )
        layers.delete()
    except Exception:
        # Inventory tables missing on a legacy tenant — don't block the
        # delete; the purchase rows still come out.
        pass

    # ── 2. Reverse payment-account transactions ─────────────────────────
    try:
        from accounting.models import PaymentAccount, PaymentAccountTransaction  # noqa: PLC0415
        for pay in purchase.payments.all():
            acct_id = getattr(pay, "payment_account_id", None)
            amt = _D(str(pay.amount or 0))
            if acct_id and amt > 0:
                acct = PaymentAccount.objects.filter(id=acct_id).first()
                if acct:
                    PaymentAccountTransaction.objects.create(
                        account = acct,
                        kind    = PaymentAccountTransaction.Kind.ADJUSTMENT,
                        # Money back IN — reverses the original WITHDRAWAL.
                        amount  = amt,
                        reference = pay.reference or "",
                        note    = f"Reversal — deleted purchase {purchase.reference_no or purchase.id}",
                    )
    except Exception:
        pass

    # ── 3. Delete the purchase (cascades items + payments) ──────────────
    purchase.delete()
