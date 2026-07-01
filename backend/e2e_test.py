"""
End-to-End Backend Test
=======================
Tests every layer of the stack using Django ORM directly (no HTTP needed).

Flow:
  1.  Plans list
  2.  Subscription purchase  (create_pending_payment -> process_webhook_success)
  3.  Tenant DB provisioned  (tables migrated automatically)
  4.  Password setup via token -> JWT token issued
  5.  Master data:  Unit . Brand . Category . Location
  6.  Product created
  7.  Stock IN  ×2  (two FIFO layers)
  8.  Sale created (draft) -> finalized  -> FIFO deducted, COGS stamped
  9.  Payment recorded  (partial -> full)
  10. Restock  (third FIFO layer)
  11. Accounting:  chart of accounts . JEs balanced . expense . trial balance . P&L . balance sheet
  12. Reports:  sales . stock . expense . product . tax
  13. System config:  settings seeded . tax groups . notification templates

Run:  python e2e_test.py
"""

import sys, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django
django.setup()

from decimal import Decimal
from datetime import date

# -- colour / result helpers ----------------------------------------------------
G, R, Y, C, B, Z = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[1m", "\033[0m"

results = []

def hdr(t):
    print(f"\n{B}{C}{'-'*62}{Z}\n{B}{C}  {t}{Z}\n{B}{C}{'-'*62}{Z}")

def step(t):   print(f"\n{Y}  >>  {t}{Z}")
def ok(l, d=""): print(f"  {G}[PASS]  {l}{Z}" + (f"   ({d})" if d else "")); results.append(("PASS", l))
def fail(l, d=""): print(f"  {R}[FAIL]  {l}{Z}" + (f"   -> {d}" if d else "")); results.append(("FAIL", l))
def note(t):   print(f"       {C}.{Z} {t}")


# ══════════════════════════════════════════════════════════════════════════════
# 1 — Plans
# ══════════════════════════════════════════════════════════════════════════════
hdr("1 . Plans")
from accounts.models import Plan, User, Subscription, Payment, Tenant, PasswordSetupToken
from accounts import services as acct_svc

step("Load active plans")
try:
    plans = list(Plan.objects.filter(is_active=True))
    assert plans, "No active plans – seed the DB first"
    ok("Plans loaded", f"{len(plans)} plans: {[p.name for p in plans]}")
    plan = plans[0]
    note(f"Using: {plan.name}  price=${plan.price}")
except Exception as e:
    fail("Plans", str(e)); sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# 2 — Subscribe -> process_webhook_success -> tenant provisioned
# ══════════════════════════════════════════════════════════════════════════════
hdr("2 . Subscription & Account Creation")
import uuid as _uuid

step("Create pending payment")
try:
    uid   = _uuid.uuid4().hex[:6]
    email = f"e2e_{uid}@teststore.local"
    pmt   = acct_svc.create_pending_payment(
        plan=plan, name="E2E Store",
        email=email, phone="0700000001",
        business_name="E2E Business",
    )
    ok("Pending payment created", f"txn={pmt.transaction_id}")
except Exception as e:
    fail("create_pending_payment", str(e)); sys.exit(1)

step("Simulate successful payment webhook")
try:
    result = acct_svc.process_webhook_success(
        transaction_id=pmt.transaction_id,
        amount=pmt.amount,
    )
    user = result["user"]
    sub  = result["subscription"]
    ok("Webhook processed  -> user + subscription created",
       f"user_id={user.id}  sub_status={sub.status}")
    ok("Subscription active", f"next_billing={sub.next_billing_date}  status={sub.status}")
except Exception as e:
    fail("process_webhook_success", str(e)); sys.exit(1)

step("Verify tenant DB provisioned")
try:
    tenant = Tenant.objects.get(user=user)
    assert tenant.is_provisioned, "Tenant not marked provisioned"
    DB = tenant.db_alias
    ok("Tenant DB provisioned", f"alias={DB}  name={tenant.db_name}")
    note(f"All tenant queries now use alias: {DB}")
except Exception as e:
    fail("Tenant provisioning", str(e)); sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# 3 — Password setup -> JWT
# ══════════════════════════════════════════════════════════════════════════════
hdr("3 . Password Setup & JWT Login")

step("Set password via setup token")
try:
    tok = PasswordSetupToken.objects.filter(user=user).first()
    assert tok, "No unused setup token found"
    acct_svc.consume_setup_token(token_str=tok.token, new_password="E2ePass@2026!")
    user.refresh_from_db()
    ok("Password set via token")
except Exception as e:
    fail("consume_setup_token", str(e)); sys.exit(1)

step("Obtain JWT access token")
try:
    from accounts.tenant_db import set_current_db_alias
    set_current_db_alias(DB)
    from accounts.serializers import CustomTokenObtainPairSerializer
    token_obj   = CustomTokenObtainPairSerializer.get_token(user)
    access_tok  = str(token_obj.access_token)
    perms       = token_obj.get("permissions", [])
    ok("JWT token issued",
       f"role={token_obj.get('role')}  permissions={len(perms)}")
    note(f"Sample permissions: {perms[:4]}")
except Exception as e:
    fail("JWT token generation", str(e)); sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# 4 — Master data
# ══════════════════════════════════════════════════════════════════════════════
hdr("4 . Master Data Setup")

from inventory.models import (
    Unit, Brand, Category, Location,
    Product, FIFOLayer, ProductStock, StockMovement,
)

step("Unit")
try:
    unit = Unit.objects.using(DB).create(name="Piece", abbreviation="pcs")
    ok("Unit", f"id={unit.pk}  name={unit.name}")
except Exception as e:
    fail("Unit", str(e)); sys.exit(1)

step("Brand")
try:
    brand = Brand.objects.using(DB).create(name="TechBrand Pro")
    ok("Brand", f"id={brand.pk}")
except Exception as e:
    fail("Brand", str(e)); sys.exit(1)

step("Category")
try:
    cat = Category.objects.using(DB).create(name="Electronics")
    ok("Category", f"id={cat.pk}")
except Exception as e:
    fail("Category", str(e)); sys.exit(1)

step("Location (warehouse)")
try:
    loc = Location.objects.using(DB).create(
        name="Main Store", code="MAIN", address="123 Test Street",
    )
    ok("Location", f"id={loc.pk}  code={loc.code}")
except Exception as e:
    fail("Location", str(e)); sys.exit(1)


# ══════════════════════════════════════════════════════════════════════════════
# 5 — Product + FIFO Stock IN
# ══════════════════════════════════════════════════════════════════════════════
hdr("5 . Product Creation & Stock IN (FIFO)")

from inventory import services as inv_svc

step("Create product")
try:
    prod = inv_svc.create_product(
        name="Wireless Mouse X200",
        unit_id=unit.pk,
        category_id=cat.pk,
        brand_id=brand.pk,
        selling_price=Decimal("45.00"),
        notes="Test product",
    )
    ok("Product created", f"sku={prod.sku}  id={prod.pk}")
except Exception as e:
    fail("create_product", str(e)); sys.exit(1)

step("Stock IN – Layer 1: 20 units @ $18.00")
try:
    r1 = inv_svc.add_stock_fifo(
        product_id=prod.pk,
        location_id=loc.pk,
        quantity=Decimal("20"),
        unit_cost=Decimal("18.00"),
        reference_type="purchase"
    )
    ok("FIFO layer 1 created", f"qty=20  cost=$18.00  layer_id={r1.pk}")
except Exception as e:
    fail("add_stock_fifo (L1)", str(e)); sys.exit(1)

step("Stock IN – Layer 2: 10 units @ $19.50")
try:
    r2 = inv_svc.add_stock_fifo(
        product_id=prod.pk,
        location_id=loc.pk,
        quantity=Decimal("10"),
        unit_cost=Decimal("19.50"),
        reference_type="purchase"
    )
    ok("FIFO layer 2 created", f"qty=10  cost=$19.50  layer_id={r2.pk}")
except Exception as e:
    fail("add_stock_fifo (L2)", str(e)); sys.exit(1)

step("Verify total stock = 30 units")
try:
    prod.refresh_from_db()
    total = prod.total_stock
    val   = prod.inventory_value
    avg   = prod.avg_cost
    if total == Decimal("30"):
        ok("Total stock correct", f"qty={total}  value=${val}  avg_cost=${avg}")
    else:
        fail("Total stock wrong", f"expected=30  got={total}")
except Exception as e:
    fail("Stock verification", str(e))

step("Verify 2 FIFO layers (oldest -> newest order)")
try:
    layers = list(FIFOLayer.objects.using(DB)
                  .filter(product=prod).order_by("created_at"))
    assert len(layers) == 2
    ok("FIFO layers correct",
       f"L1: rem={layers[0].remaining_qty} @ ${layers[0].unit_cost} | "
       f"L2: rem={layers[1].remaining_qty} @ ${layers[1].unit_cost}")
except Exception as e:
    fail("FIFO layer check", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 6 — Sale: draft -> finalize -> FIFO deducted
# ══════════════════════════════════════════════════════════════════════════════
hdr("6 . Sale (Draft -> Finalize -> FIFO Deducted)")

from sales import services as sale_svc
from sales.models import Sale, SaleItem, Customer, SalePayment

step("Create customer")
try:
    cust = Customer.objects.using(DB).create(
        name="Jane Doe", phone="0711111111", email="jane@test.local",
    )
    ok("Customer created", f"id={cust.pk}")
except Exception as e:
    fail("Customer", str(e)); sys.exit(1)

step("Create draft sale — 8 units @ $45.00")
try:
    sale = sale_svc.create_sale(
        location_id=loc.pk,
        created_by_id=user.pk,
        customer_id=cust.pk,
        items=[{
            "product_id":    prod.pk,
            "quantity":      Decimal("8"),
            "unit_price":    Decimal("45.00"),
            "item_discount": Decimal("0"),
        }],
    )
    ok("Draft sale created",
       f"id={sale.pk}  status={sale.status}  total=${sale.total_amount}")
except Exception as e:
    fail("create_sale", str(e)); sys.exit(1)

step("Finalize sale -> consume FIFO stock")
try:
    sale = sale_svc.finalize_sale(sale_id=sale.pk, finalized_by_id=user.pk)
    ok("Sale finalized",
       f"status={sale.status}  invoice={sale.invoice_number}  total=${sale.total_amount}")
except Exception as e:
    fail("finalize_sale", str(e)); sys.exit(1)

step("FIFO deduction: 8 units consumed from oldest layer")
try:
    layers = list(FIFOLayer.objects.using(DB)
                  .filter(product=prod).order_by("created_at"))
    l1, l2 = layers[0].remaining_qty, layers[1].remaining_qty
    # 20 - 8 = 12  |  10 unchanged
    if l1 == Decimal("12") and l2 == Decimal("10"):
        ok("FIFO deduction correct",
           f"L1: 20->{l1}  L2: 10->{l2}  (8 taken from oldest)")
    else:
        fail("FIFO deduction wrong", f"L1={l1} (want 12)  L2={l2} (want 10)")
except Exception as e:
    fail("FIFO verification", str(e))

step("Total stock after sale = 22 units")
try:
    prod.refresh_from_db()
    remaining = prod.total_stock
    if remaining == Decimal("22"):
        ok("Post-sale stock correct", f"qty={remaining}")
    else:
        fail("Post-sale stock wrong", f"expected=22  got={remaining}")
except Exception as e:
    fail("Post-sale stock check", str(e))

step("COGS stamped on sale item = $144.00  (8 × $18.00 FIFO cost)")
try:
    item = SaleItem.objects.using(DB).get(sale=sale)
    expected_cogs = Decimal("144.00")
    if item.cogs == expected_cogs:
        ok("COGS correct", f"${item.cogs}  ({item.quantity} × ${layers[0].unit_cost})")
    else:
        fail("COGS wrong", f"expected=${expected_cogs}  got=${item.cogs}")
except Exception as e:
    fail("COGS check", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 7 — Payments
# ══════════════════════════════════════════════════════════════════════════════
hdr("7 . Payment Recording")

step("Partial payment: $200")
try:
    pay1 = sale_svc.add_payment(
        sale_id=sale.pk, amount=Decimal("200.00"),
        method="cash", received_by_id=user.pk,
    )
    sale.refresh_from_db()
    ok("Partial payment recorded",
       f"paid=${sale.amount_paid}  balance_due=${sale.balance_due}  "
       f"status={sale.payment_status}")
except Exception as e:
    fail("add_payment (partial)", str(e))

step("Final payment: $160 -> fully paid")
try:
    remaining_due = sale.balance_due
    pay2 = sale_svc.add_payment(
        sale_id=sale.pk, amount=remaining_due,
        method="bank_transfer", received_by_id=user.pk,
    )
    sale.refresh_from_db()
    if sale.payment_status in ("paid", "PAID"):
        ok("Sale fully paid",
           f"payment_status={sale.payment_status}  balance_due=${sale.balance_due}")
    else:
        fail("Sale not marked PAID", f"status={sale.payment_status}  balance={sale.balance_due}")
except Exception as e:
    fail("add_payment (final)", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 8 — Restock (Stock IN after sale)
# ══════════════════════════════════════════════════════════════════════════════
hdr("8 . Restock (Stock IN after sale)")

step("Add 15 units @ $20.00  (new cost layer)")
try:
    r3 = inv_svc.add_stock_fifo(
        product_id=prod.pk, location_id=loc.pk,
        quantity=Decimal("15"), unit_cost=Decimal("20.00"),
        reference_type="purchase"
    )
    ok("Restock FIFO layer 3 created", f"qty=15  cost=$20.00")
except Exception as e:
    fail("Restock add_stock_fifo", str(e))

step("Total stock after restock = 37 units")
try:
    prod.refresh_from_db()
    total_final = prod.total_stock
    if total_final == Decimal("37"):
        ok("Stock after restock correct", f"qty={total_final}")
    else:
        fail("Stock wrong", f"expected=37  got={total_final}")
except Exception as e:
    fail("Post-restock check", str(e))

step("Verify 3 FIFO layers in queue")
try:
    lcount = FIFOLayer.objects.using(DB).filter(product=prod).count()
    ok("FIFO layer count", f"{lcount} layers") if lcount == 3 \
        else fail("Wrong layer count", f"expected=3  got={lcount}")
except Exception as e:
    fail("FIFO layer count", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 9 — Accounting
# ══════════════════════════════════════════════════════════════════════════════
hdr("9 . Accounting Entries")

from accounting.models import Account, JournalEntry, JournalEntryLine, Expense
from accounting import services as acct_acc
from django.db.models import Sum

step("Chart of accounts seeded")
try:
    acct_count   = Account.objects.using(DB).count()
    system_count = Account.objects.using(DB).filter(is_system=True).count()
    assert acct_count >= 20, f"Only {acct_count} accounts"
    ok("Chart of accounts", f"{acct_count} accounts  ({system_count} system)")
except Exception as e:
    fail("Chart of accounts", str(e))

step("Journal entries created for sale (revenue + COGS)")
try:
    je_sale = JournalEntry.objects.using(DB).filter(
        reference_type=JournalEntry.ReferenceType.SALE,
        reference_id=sale.pk,
    )
    je_count = je_sale.count()
    if je_count >= 1:
        ok("Sale journal entries", f"{je_count} JE(s) for sale {str(sale.pk)[:8]}…")
    else:
        fail("No JEs for sale")
except Exception as e:
    fail("JE check", str(e))

step("Journal entries created for payments")
try:
    je_pmt = JournalEntry.objects.using(DB).filter(
        reference_type=JournalEntry.ReferenceType.PAYMENT,
    ).count()
    if je_pmt >= 1:
        ok("Payment journal entries", f"{je_pmt} payment JE(s)")
    else:
        fail("No payment JEs found")
except Exception as e:
    fail("Payment JE check", str(e))

step("All journal entries balanced  (Σ DR = Σ CR per entry)")
try:
    all_jes  = list(JournalEntry.objects.using(DB).all())
    bad      = []
    for je in all_jes:
        dr = je.lines.using(DB).aggregate(t=Sum("debit")) ["t"] or Decimal("0")
        cr = je.lines.using(DB).aggregate(t=Sum("credit"))["t"] or Decimal("0")
        if dr != cr:
            bad.append(f"{je.entry_number}: DR={dr} CR={cr}")
    if not bad:
        ok("All JEs balanced", f"checked {len(all_jes)} entries")
    else:
        fail("Unbalanced JEs", "; ".join(bad[:3]))
except Exception as e:
    fail("Balance check", str(e))

step("Record expense: $500 rent  (DR 6100 CR 1001)")
try:
    cash_acct = Account.objects.using(DB).get(code="1001")
    rent_acct = Account.objects.using(DB).get(code="6100")
    expense   = acct_acc.record_expense(
        category="RENT",
        expense_account_id=rent_acct.pk,
        payment_account_id=cash_acct.pk,
        amount=Decimal("500.00"),
        description="April 2026 office rent",
        expense_date=date(2026, 4, 1),
        created_by_id=user.pk,
    )
    ok("Expense recorded",
       f"id={str(expense.pk)[:8]}…  je={expense.journal_entry.entry_number}")
except Exception as e:
    fail("record_expense", str(e))

step("Trial balance  — grand DR == grand CR")
try:
    tb = acct_acc.get_trial_balance(date_to=date.today())
    if tb["is_balanced"]:
        ok("Trial balance balanced",
           f"DR={tb['grand_debit']}  CR={tb['grand_credit']}  "
           f"accounts={len(tb['accounts'])}")
    else:
        fail("Trial balance out of balance",
             f"DR={tb['grand_debit']}  CR={tb['grand_credit']}")
except Exception as e:
    fail("Trial balance", str(e))

step("Profit & Loss statement")
try:
    pl = acct_acc.get_profit_and_loss(
        date_from=date(2026, 1, 1), date_to=date.today()
    )
    ok("P&L generated",
       f"revenue=${pl.get('net_revenue',0)}  cogs=${pl.get('cogs',0)}  "
       f"net_profit=${pl.get('net_profit',0)}")
except Exception as e:
    fail("P&L", str(e))

step("Balance sheet")
try:
    bs = acct_acc.get_balance_sheet(as_of_date=date.today())
    ok("Balance sheet generated",
       f"assets=${bs.get('total_assets',0)}  "
       f"liabilities=${bs.get('total_liabilities',0)}  "
       f"equity=${bs.get('total_equity',0)}")
except Exception as e:
    fail("Balance sheet", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 10 — Reports
# ══════════════════════════════════════════════════════════════════════════════
hdr("10 . Reports")

# reports services read via _current_db() — must be set
from accounts.tenant_db import set_current_db_alias
set_current_db_alias(DB)

from reports import services as rpt_svc

step("Sales report")
try:
    sr = rpt_svc.get_sales_report(date_from=date(2026,1,1), date_to=date.today())
    ok("Sales report",
       f"orders={sr.get('summary',{}).get('total_orders','?')}  "
       f"revenue=${sr.get('summary',{}).get('total_revenue','?')}")
except Exception as e:
    fail("Sales report", str(e))

step("Stock report")
try:
    skr = rpt_svc.get_stock_report()
    prods = skr.get("products", [])
    ok("Stock report", f"{len(prods)} product(s) listed")
    if prods:
        p0 = prods[0]
        note(f"  {p0.get('name')}  qty={p0.get('total_qty')}  value=${p0.get('inventory_value')}")
except Exception as e:
    fail("Stock report", str(e))

step("Expense report")
try:
    er = rpt_svc.get_expense_report(date_from=date(2026,1,1), date_to=date.today())
    ok("Expense report",
       f"total=${er.get('summary',{}).get('total_amount','?')}")
except Exception as e:
    fail("Expense report", str(e))

step("Product performance report")
try:
    pr = rpt_svc.get_product_report(date_from=date(2026,1,1), date_to=date.today())
    prods = pr.get("products", [])
    ok("Product report", f"{len(prods)} product(s) ranked")
except Exception as e:
    fail("Product report", str(e))

step("Tax report")
try:
    tr = rpt_svc.get_tax_report(date_from=date(2026,1,1), date_to=date.today())
    ok("Tax report",
       f"total_tax=${tr.get('summary',{}).get('total_tax','?')}")
except Exception as e:
    fail("Tax report", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# 11 — System config & notification templates
# ══════════════════════════════════════════════════════════════════════════════
hdr("11 . System Config & Notifications")

step("System settings seeded")
try:
    from system_config.services import get_setting, SettingKeys
    curr     = get_setting(SettingKeys.CURRENCY_SYMBOL)
    barcode  = get_setting(SettingKeys.BARCODE_AUTO_GENERATE)
    tz_val   = get_setting(SettingKeys.TIMEZONE)
    assert curr, "currency.symbol missing"
    ok("System settings", f"currency={curr}  barcode_auto={barcode}  tz={tz_val}")
except Exception as e:
    fail("System settings", str(e))

step("Tax groups seeded")
try:
    from system_config.models import TaxGroup
    tg_count = TaxGroup.objects.using(DB).count()
    default  = TaxGroup.objects.using(DB).filter(is_default=True).first()
    assert tg_count >= 3 and default
    ok("Tax groups", f"{tg_count} groups  default='{default.name} ({default.rate}%)'")
except Exception as e:
    fail("Tax groups", str(e))

step("Notification templates seeded")
try:
    from notifications.models import NotificationTemplate
    total_tmpl  = NotificationTemplate.objects.using(DB).count()
    active_tmpl = NotificationTemplate.objects.using(DB).filter(is_active=True).count()
    assert total_tmpl >= 12
    ok("Notification templates", f"{total_tmpl} total  {active_tmpl} active")
except Exception as e:
    fail("Notification templates", str(e))

step("Stock movements audit trail")
try:
    movements = list(StockMovement.objects.using(DB)
                     .filter(product=prod).order_by("created_at"))
    in_mv  = [m for m in movements if m.movement_type == "IN"]
    out_mv = [m for m in movements if m.movement_type == "OUT"]
    ok("Stock movements",
       f"total={len(movements)}  IN={len(in_mv)}  OUT={len(out_mv)}")
    for m in movements:
        note(f"  [{m.movement_type}] qty={m.quantity}  ref={m.reference_type}  "
             f"cost={m.unit_cost}")
except Exception as e:
    fail("Stock movements", str(e))


# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
hdr("RESULTS")

passed = sum(1 for s, _ in results if s == "PASS")
failed = sum(1 for s, _ in results if s == "FAIL")

print(f"\n  Total : {len(results)}")
print(f"  {G}Passed: {passed}{Z}")
print(f"  {R}Failed: {failed}{Z}\n")

if failed:
    print(f"{R}{B}  FAILED:{Z}")
    for s, l in results:
        if s == "FAIL":
            print(f"    {R}[FAIL]  {l}{Z}")
    print()

if failed == 0:
    print(f"{G}{B}  [PASS]  ALL {passed} CHECKS PASSED — backend is solid.{Z}\n")
    sys.exit(0)
else:
    print(f"{R}{B}  {failed} check(s) failed — see output above.{Z}\n")
    sys.exit(1)
