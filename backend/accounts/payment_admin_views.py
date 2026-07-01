"""
Payment Management — Super-Admin API.

Platform-admin only. One list endpoint (search / filter / sort / paging +
analytics), a detail endpoint, and an action dispatcher. Mark-as-paid /
mark-as-failed reuse the existing webhook service so provisioning + renewal
behave exactly like a real gateway callback.

    GET  admin/payments/                  list + analytics
    GET  admin/payments/<id>/             transaction detail
    POST admin/payments/<id>/actions/     { action } → verify|mark_paid|mark_failed|refund
"""
import logging
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Q, Sum, Count
from django.db.models.functions import TruncDate, TruncMonth
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status as http

from .models import Payment, PaymentAuditLog, PaymentGatewayConfig
from . import services

logger = logging.getLogger(__name__)

_GATEWAY_META_KEYS = (
    "gateway", "payment_method", "method", "card_type", "card_no", "bank_tran_id",
    "val_id", "store_amount", "currency", "risk_level", "tran_date", "status",
)


def _is_admin(user) -> bool:
    return bool(user and (user.is_staff or user.is_superuser))


def _audit(action, *, payment=None, actor=None, from_status="", to_status="",
           gateway_code="", note="", metadata=None):
    """Write a PaymentAuditLog row (never raises — auditing must not break an action)."""
    try:
        PaymentAuditLog.objects.create(
            payment=payment, action=action, from_status=from_status or "",
            to_status=to_status or "", gateway_code=gateway_code or "", note=note or "",
            metadata=metadata or {},
            performed_by=getattr(actor, "id", None),
            performed_by_email=getattr(actor, "email", "") or "",
        )
    except Exception:
        logger.exception("Failed to write payment audit log (%s)", action)


def _owner_name(p) -> str:
    if p.user:
        return p.user.name or p.user.email or "—"
    meta = p.metadata or {}
    return meta.get("name") or meta.get("email") or "—"


def _company_name(p) -> str:
    if p.user and p.user.business_name:
        return p.user.business_name
    meta = p.metadata or {}
    return meta.get("business_name") or _owner_name(p)


def _tenant_name(p) -> str:
    return _company_name(p)


def _plan_name(p):
    if p.subscription_id and p.subscription and p.subscription.plan:
        return p.subscription.plan.name
    return (p.metadata or {}).get("plan_name")


def serialize_row(p) -> dict:
    meta = p.metadata or {}
    return {
        "id":              str(p.id),
        "transaction_id":  p.transaction_id or "",
        "invoice_number":  meta.get("invoice_number") or p.transaction_id or str(p.id)[:8].upper(),
        "tenant_name":     _owner_name(p),
        "company_name":    _company_name(p),
        "tenant_email":    (p.user.email if p.user else meta.get("email")) or "",
        "plan_name":       _plan_name(p) or "—",
        "amount":          str(p.amount),
        "method":          p.method or meta.get("method") or meta.get("payment_method") or "—",
        "gateway":         p.gateway or meta.get("gateway") or "—",
        "status":          p.status,
        "refund_amount":   str(p.refund_amount) if p.refund_amount is not None else None,
        "paid_at":         p.paid_at.isoformat() if p.paid_at else None,
        "refunded_at":     p.refunded_at.isoformat() if p.refunded_at else None,
        "created_at":      p.created_at.isoformat() if p.created_at else None,
        "user_id":         str(p.user_id) if p.user_id else None,
    }


def serialize_detail(p) -> dict:
    row = serialize_row(p)
    meta = p.metadata or {}
    row["metadata"] = meta
    row["type"] = meta.get("type", "subscription")

    # Gateway response — the subset of metadata the gateway returned.
    row["gateway_response"] = {k: meta[k] for k in _GATEWAY_META_KEYS if k in meta}

    # Payment timeline — created → audit-log events.
    timeline = [{"event": "Created", "at": p.created_at.isoformat() if p.created_at else None, "by": "system"}]
    for a in p.audit_logs.all()[:100]:
        timeline.append({
            "event": a.get_action_display(),
            "note": a.note or "",
            "from_status": a.from_status, "to_status": a.to_status,
            "by": a.performed_by_email or "system",
            "at": a.created_at.isoformat(),
        })
    if p.paid_at:
        timeline.append({"event": "Paid", "at": p.paid_at.isoformat(), "by": "gateway"})
    timeline.sort(key=lambda t: t["at"] or "")
    row["timeline"] = timeline

    # Billing history — other payments by the same tenant.
    billing = []
    if p.user_id:
        for op in Payment.objects.filter(user_id=p.user_id).select_related("subscription__plan").order_by("-created_at")[:50]:
            billing.append({
                "id": str(op.id), "transaction_id": op.transaction_id,
                "amount": str(op.amount), "status": op.status,
                "plan_name": _plan_name(op) or "—",
                "created_at": op.created_at.isoformat() if op.created_at else None,
                "paid_at": op.paid_at.isoformat() if op.paid_at else None,
            })
    row["billing_history"] = billing
    return row


def _analytics() -> dict:
    qs = Payment.objects.all()

    def _amt(status):
        return qs.filter(status=status).aggregate(t=Sum("amount"))["t"] or Decimal("0")

    gateway_rows = (
        qs.filter(status="success")
        .values("gateway")
        .annotate(value=Sum("amount"), count=Count("id"))
        .order_by("-value")
    )
    gateway_revenue = [
        {"label": (r["gateway"] or "Unspecified"), "value": float(r["value"] or 0), "count": r["count"]}
        for r in gateway_rows
    ]

    today = timezone.localdate()
    month_start = today.replace(day=1)
    monthly_revenue = qs.filter(
        status="success", paid_at__date__gte=month_start, paid_at__date__lte=today
    ).aggregate(t=Sum("amount"))["t"] or Decimal("0")

    return {
        "total_payments":      qs.count(),
        "total_amount":        float(qs.aggregate(t=Sum("amount"))["t"] or 0),
        "successful_count":    qs.filter(status="success").count(),
        "successful_amount":   float(_amt("success")),
        "pending_count":       qs.filter(status="pending").count(),
        "pending_amount":      float(_amt("pending")),
        "failed_count":        qs.filter(status="failed").count(),
        "refunded_count":      qs.filter(status="refunded").count(),
        "refund_amount":       float(qs.filter(status="refunded").aggregate(t=Sum("refund_amount"))["t"] or 0),
        "monthly_revenue":     float(monthly_revenue),
        "gateway_revenue":     gateway_revenue,
    }


def _apply_date_filter(qs, params):
    """today | week | month | custom(date_from,date_to) on created_at."""
    period = (params.get("period") or "").lower()
    today = timezone.localdate()
    df = dt = None
    if period == "today":
        df = dt = today
    elif period == "week":
        df, dt = today - timedelta(days=today.weekday()), today
    elif period == "month":
        df, dt = today.replace(day=1), today
    else:
        for key, target in (("date_from", "df"), ("date_to", "dt")):
            raw = (params.get(key) or "").strip()
            if raw:
                try:
                    val = date.fromisoformat(raw)
                    if target == "df":
                        df = val
                    else:
                        dt = val
                except ValueError:
                    pass
    if df:
        qs = qs.filter(created_at__date__gte=df)
    if dt:
        qs = qs.filter(created_at__date__lte=dt)
    return qs


_SORT = {
    "created_at": "created_at", "paid_at": "paid_at", "amount": "amount",
    "status": "status", "tenant": "user__name",
}


class _Base(APIView):
    permission_classes = [IsAuthenticated]

    def _guard(self, request):
        if not _is_admin(request.user):
            return Response({"detail": "Platform-admin only."}, status=http.HTTP_403_FORBIDDEN)
        return None


class AdminPaymentsView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp

        p = request.query_params
        qs = Payment.objects.select_related("user", "subscription__plan")

        if search := (p.get("search") or "").strip():
            qs = qs.filter(
                Q(transaction_id__icontains=search)
                | Q(user__name__icontains=search)
                | Q(user__email__icontains=search)
                | Q(user__business_name__icontains=search)
            )

        flt = (p.get("filter") or p.get("status") or "all").lower()
        if flt in ("success", "pending", "failed", "refunded"):
            qs = qs.filter(status=flt)

        if gw := (p.get("gateway") or "").strip():
            qs = qs.filter(gateway__iexact=gw)

        qs = _apply_date_filter(qs, p)

        sort_by  = (p.get("sort_by") or "created_at").lower()
        sort_dir = (p.get("sort_dir") or "desc").lower()
        field = _SORT.get(sort_by, "created_at")
        qs = qs.order_by(f"-{field}" if sort_dir == "desc" else field)

        try:
            limit = min(max(int(p.get("limit", 25)), 1), 200)
        except (TypeError, ValueError):
            limit = 25
        try:
            page = max(int(p.get("page", 1)), 1)
        except (TypeError, ValueError):
            page = 1
        total = qs.count()
        total_pages = max((total + limit - 1) // limit, 1)
        page = min(page, total_pages)
        offset = (page - 1) * limit
        rows = [serialize_row(x) for x in qs[offset:offset + limit]]

        return Response({
            "results": rows, "count": total, "page": page,
            "limit": limit, "total_pages": total_pages,
            "analytics": _analytics(),
        })


class AdminPaymentDetailView(_Base):
    def get(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            payment = Payment.objects.select_related("user", "subscription__plan").get(id=pk)
        except Payment.DoesNotExist:
            return Response({"detail": "Payment not found."}, status=http.HTTP_404_NOT_FOUND)
        return Response(serialize_detail(payment))


class AdminPaymentActionView(_Base):
    def post(self, request, pk):
        if (resp := self._guard(request)) is not None:
            return resp
        try:
            payment = Payment.objects.select_related("user", "subscription__plan").get(id=pk)
        except Payment.DoesNotExist:
            return Response({"detail": "Payment not found."}, status=http.HTTP_404_NOT_FOUND)

        data   = request.data or {}
        action = (data.get("action") or "").strip().lower()
        actor  = request.user

        try:
            if action in ("verify", "retry", "retry_verification"):
                # Re-read current state — a lightweight "re-check" / retry.
                payment.refresh_from_db()
                act = PaymentAuditLog.Action.RETRY if action != "verify" else PaymentAuditLog.Action.VERIFY
                _audit(act, payment=payment, actor=actor, to_status=payment.status,
                       note=f"Status re-checked: {payment.get_status_display()}.")
                msg = f"Payment is currently {payment.get_status_display()}."

            elif action in ("mark_paid", "mark_as_paid"):
                if payment.status == Payment.Status.SUCCESS:
                    return Response({"detail": "Payment is already marked as paid."}, status=http.HTTP_400_BAD_REQUEST)
                if not payment.transaction_id:
                    return Response({"detail": "Payment has no transaction id to confirm."}, status=http.HTTP_400_BAD_REQUEST)
                prev = payment.status
                # Reuse the real webhook success path (provisions / renews).
                services.process_webhook_success(transaction_id=payment.transaction_id, amount=payment.amount)
                payment.refresh_from_db()
                _audit(PaymentAuditLog.Action.MARK_PAID, payment=payment, actor=actor,
                       from_status=prev, to_status=payment.status, note="Marked as paid by admin.")
                msg = "Payment marked as paid."

            elif action in ("mark_failed", "mark_as_failed"):
                if payment.status == Payment.Status.SUCCESS:
                    return Response({"detail": "A successful payment cannot be marked failed — issue a refund instead."}, status=http.HTTP_400_BAD_REQUEST)
                prev = payment.status
                services.process_failed_payment(payment.transaction_id)
                payment.refresh_from_db()
                _audit(PaymentAuditLog.Action.MARK_FAILED, payment=payment, actor=actor,
                       from_status=prev, to_status=payment.status, note="Marked as failed by admin.")
                msg = "Payment marked as failed."

            elif action == "refund":
                if payment.status != Payment.Status.SUCCESS:
                    return Response({"detail": "Only successful payments can be refunded."}, status=http.HTTP_400_BAD_REQUEST)
                try:
                    amt = Decimal(str(data.get("amount"))) if data.get("amount") not in (None, "") else payment.amount
                except Exception:
                    return Response({"detail": "Invalid refund amount."}, status=http.HTTP_400_BAD_REQUEST)
                if amt <= 0 or amt > payment.amount:
                    return Response({"detail": "Refund must be between 0 and the payment amount."}, status=http.HTTP_400_BAD_REQUEST)
                reason = (data.get("reason") or "").strip()
                payment.status        = Payment.Status.REFUNDED
                payment.refund_amount = amt
                payment.refunded_at   = timezone.now()
                meta = payment.metadata or {}
                meta["refund_reason"] = reason
                meta["refunded_by"]   = getattr(request.user, "email", "")
                payment.metadata = meta
                payment.save(update_fields=["status", "refund_amount", "refunded_at", "metadata"])
                _audit(PaymentAuditLog.Action.REFUND, payment=payment, actor=actor,
                       from_status="success", to_status="refunded", note=reason,
                       metadata={"refund_amount": str(amt)})
                msg = "Refund recorded."

            else:
                return Response({"detail": f"Unknown action '{action}'."}, status=http.HTTP_400_BAD_REQUEST)

        except services.DuplicateWebhookError:
            return Response({"detail": "This transaction was already processed."}, status=http.HTTP_400_BAD_REQUEST)
        except services.WebhookError as exc:
            return Response({"detail": str(exc)}, status=http.HTTP_400_BAD_REQUEST)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Payment admin action failed: %s", exc)
            return Response({"detail": "Action failed. Please try again."}, status=http.HTTP_500_INTERNAL_SERVER_ERROR)

        fresh = Payment.objects.select_related("user", "subscription__plan").get(id=pk)
        return Response({"detail": msg, "payment": serialize_detail(fresh)})


# ──────────────────────────────────────────────────────────────────────────────
# Analytics — charts for the payment dashboard
# ──────────────────────────────────────────────────────────────────────────────

class AdminPaymentAnalyticsView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp

        today = timezone.localdate()
        date_to = today
        raw_from = (request.query_params.get("date_from") or "").strip()
        try:
            date_from = date.fromisoformat(raw_from) if raw_from else (today - timedelta(days=29))
        except ValueError:
            date_from = today - timedelta(days=29)

        paid = Payment.objects.filter(status="success")
        paid_range = paid.filter(paid_at__date__gte=date_from, paid_at__date__lte=date_to)

        revenue_by_plan = [
            {"label": r["subscription__plan__name"] or "—", "value": float(r["v"] or 0)}
            for r in paid_range.filter(subscription__isnull=False)
            .values("subscription__plan__name").annotate(v=Sum("amount")).order_by("-v")
        ]
        revenue_by_gateway = [
            {"label": r["gateway"] or "Unspecified", "value": float(r["v"] or 0)}
            for r in paid_range.values("gateway").annotate(v=Sum("amount")).order_by("-v")
        ]

        day_rows = (
            paid_range.annotate(d=TruncDate("paid_at")).values("d")
            .annotate(v=Sum("amount")).order_by("d")
        )
        day_map = {r["d"].isoformat(): float(r["v"] or 0) for r in day_rows if r["d"]}
        daily_revenue = []
        cur = date_from
        while cur <= date_to:
            daily_revenue.append({"label": cur.strftime("%d %b"), "value": day_map.get(cur.isoformat(), 0)})
            cur += timedelta(days=1)

        month_start = date(today.year - 1, today.month, 1)
        mon_rows = (
            paid.filter(paid_at__date__gte=month_start)
            .annotate(m=TruncMonth("paid_at")).values("m")
            .annotate(v=Sum("amount")).order_by("m")
        )
        monthly_revenue = [{"label": r["m"].strftime("%b %Y"), "value": float(r["v"] or 0)} for r in mon_rows if r["m"]]

        fail_rows = (
            Payment.objects.filter(status="failed", created_at__date__gte=month_start)
            .annotate(m=TruncMonth("created_at")).values("m")
            .annotate(v=Count("id")).order_by("m")
        )
        failed_trends = [{"label": r["m"].strftime("%b %Y"), "value": r["v"]} for r in fail_rows if r["m"]]

        success_cnt = paid.count()
        failed_cnt = Payment.objects.filter(status="failed").count()
        settled = success_cnt + failed_cnt
        collection_rate = round((success_cnt / settled * 100), 1) if settled else 0.0

        return Response({
            "date_from": date_from.isoformat(), "date_to": date_to.isoformat(),
            "revenue_by_plan":    revenue_by_plan,
            "revenue_by_gateway": revenue_by_gateway,
            "daily_revenue":      daily_revenue,
            "monthly_revenue":    monthly_revenue,
            "failed_trends":      failed_trends,
            "collection_rate":    collection_rate,
        })


# ──────────────────────────────────────────────────────────────────────────────
# Audit log feed
# ──────────────────────────────────────────────────────────────────────────────

class AdminPaymentAuditView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        qs = PaymentAuditLog.objects.all()
        if act := (request.query_params.get("action") or "").strip():
            qs = qs.filter(action=act)
        if pid := (request.query_params.get("payment") or "").strip():
            qs = qs.filter(payment_id=pid)
        try:
            limit = min(max(int(request.query_params.get("limit", 50)), 1), 200)
        except (TypeError, ValueError):
            limit = 50
        rows = [{
            "id": str(a.id), "action": a.action, "action_label": a.get_action_display(),
            "payment_id": str(a.payment_id) if a.payment_id else None,
            "from_status": a.from_status, "to_status": a.to_status,
            "gateway_code": a.gateway_code, "note": a.note,
            "by": a.performed_by_email or "system", "at": a.created_at.isoformat(),
        } for a in qs[:limit]]
        return Response({"results": rows, "count": qs.count()})


# ──────────────────────────────────────────────────────────────────────────────
# Payment Gateway settings
# ──────────────────────────────────────────────────────────────────────────────

_DEFAULT_GATEWAYS = [
    {"code": "sslcommerz", "name": "SSLCommerz", "available": True},
    {"code": "stripe",     "name": "Stripe",     "available": False},
    {"code": "paypal",     "name": "PayPal",     "available": False},
]
_GATEWAY_FIELDS = {
    "sslcommerz": ["store_id", "store_password"],
    "stripe":     ["publishable_key", "secret_key"],
    "paypal":     ["client_id", "client_secret"],
}
_SECRET_KEYS = {"store_password", "secret_key", "client_secret"}
_GATEWAY_NAMES = {g["code"]: g["name"] for g in _DEFAULT_GATEWAYS}


def _mask(v):
    s = str(v or "")
    return ("••••••" + s[-4:]) if len(s) > 4 else ("•" * len(s) if s else "")


def _serialize_gateway(cfg, code, name, available):
    fields = _GATEWAY_FIELDS.get(code, [])
    creds = (cfg.credentials if cfg else {}) or {}
    cred_out = {}
    for f in fields:
        val = creds.get(f, "")
        cred_out[f] = {"set": bool(val), "value": _mask(val) if f in _SECRET_KEYS else val}
    return {
        "code": code,
        "name": (cfg.name if cfg and cfg.name else name),
        "available": available,
        "is_enabled": bool(cfg.is_enabled) if cfg else False,
        "is_test_mode": bool(cfg.is_test_mode) if cfg else True,
        "status": cfg.status if cfg else "not_configured",
        "last_tested_at": cfg.last_tested_at.isoformat() if cfg and cfg.last_tested_at else None,
        "fields": fields,
        "credentials": cred_out,
    }


def _all_gateways():
    configs = {c.code: c for c in PaymentGatewayConfig.objects.all()}
    return [_serialize_gateway(configs.get(g["code"]), g["code"], g["name"], g["available"]) for g in _DEFAULT_GATEWAYS]


class AdminPaymentGatewaysView(_Base):
    def get(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        return Response({"results": _all_gateways()})

    def put(self, request):
        if (resp := self._guard(request)) is not None:
            return resp
        data = request.data or {}
        code = (data.get("code") or "").strip().lower()
        if code not in _GATEWAY_NAMES:
            return Response({"detail": "Unknown gateway."}, status=http.HTTP_400_BAD_REQUEST)

        cfg, _ = PaymentGatewayConfig.objects.get_or_create(code=code, defaults={"name": _GATEWAY_NAMES[code]})
        changed = []
        if "is_enabled" in data:
            cfg.is_enabled = bool(data.get("is_enabled")); changed.append("enabled")
        if "is_test_mode" in data:
            cfg.is_test_mode = bool(data.get("is_test_mode")); changed.append("test_mode")
        incoming = data.get("credentials") or {}
        creds = cfg.credentials or {}
        for f in _GATEWAY_FIELDS.get(code, []):
            if f in incoming and incoming[f] not in (None, ""):
                creds[f] = incoming[f]; changed.append(f)
        cfg.credentials = creds
        required = _GATEWAY_FIELDS.get(code, [])
        if required and all(creds.get(f) for f in required) and cfg.status == "not_configured":
            cfg.status = "connected"
        cfg.save()
        _audit(PaymentAuditLog.Action.GATEWAY_CONFIG, actor=request.user, gateway_code=code,
               note=f"Updated {', '.join(changed) if changed else 'gateway'} settings.")
        return Response({"results": _all_gateways(), "detail": "Gateway settings saved."})


class AdminPaymentGatewayTestView(_Base):
    def post(self, request, code):
        if (resp := self._guard(request)) is not None:
            return resp
        code = (code or "").strip().lower()
        try:
            cfg = PaymentGatewayConfig.objects.get(code=code)
        except PaymentGatewayConfig.DoesNotExist:
            return Response({"detail": "Gateway is not configured yet."}, status=http.HTTP_400_BAD_REQUEST)
        required = _GATEWAY_FIELDS.get(code, [])
        creds = cfg.credentials or {}
        ok = bool(required) and all(creds.get(f) for f in required)
        cfg.status = "connected" if ok else "error"
        cfg.last_tested_at = timezone.now()
        cfg.save(update_fields=["status", "last_tested_at"])
        _audit(PaymentAuditLog.Action.GATEWAY_CONFIG, actor=request.user, gateway_code=code,
               note=f"Connection test: {'success' if ok else 'missing credentials'}.")
        return Response({
            "status": cfg.status, "ok": ok,
            "detail": "Credentials look valid — gateway reachable." if ok
                      else "Missing required credentials. Fill them in and save before testing.",
        })
