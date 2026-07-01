"""
Granular permission codes — server-side mirror of the front-end
``rolePermissions.js`` catalog. Imported by ``accounts.permissions`` so the
existing has_permission() helper can also evaluate custom TenantRole
permissions (and the granular-only codes from role.txt).

Layout
──────
ALL_PERMISSIONS      — frozenset of every code in the catalog.
BUILTIN_GRANULAR     — { built-in role code → frozenset(granular codes) }.
                       What each built-in role gets out-of-the-box.
LEGACY_ALIAS         — { legacy Perm.* code → frozenset(granular codes) }.
                       When an endpoint asks for a coarse legacy code,
                       any granular alias in the user's perm set counts
                       as a match (e.g. `user.delete` ⇒ `CAN_MANAGE_USERS`).
"""
from __future__ import annotations


# ──────────────────────────────────────────────────────────────────────────────
# Full granular catalog — must match frontend/src/pages/users/rolePermissions.js
# ──────────────────────────────────────────────────────────────────────────────

ALL_PERMISSIONS: frozenset[str] = frozenset({
    # Others
    "others.service_staff", "others.view_export_buttons",
    # User
    "user.view", "user.add", "user.edit", "user.delete",
    # Roles
    "role.view", "role.add", "role.edit", "role.delete",
    # Supplier
    "supplier.view_all", "supplier.view_own",
    "supplier.add", "supplier.edit", "supplier.delete",
    # Customer
    "customer.view_all", "customer.view_own",
    "customer.view_no_sell_1m", "customer.view_no_sell_3m",
    "customer.view_no_sell_6m", "customer.view_no_sell_1y",
    "customer.view_irrespective",
    "customer.add", "customer.edit", "customer.delete",
    # Product
    "product.view", "product.add", "product.edit", "product.delete",
    "product.add_opening_stock", "product.view_purchase_price",
    # Purchase
    "purchase.view_all", "purchase.view_own",
    "purchase.add", "purchase.edit", "purchase.delete",
    "purchase.payment_add", "purchase.payment_edit", "purchase.payment_delete",
    "purchase.update_status",
    # POS
    "pos.view", "pos.add", "pos.edit", "pos.delete",
    "pos.edit_product_price", "pos.edit_product_discount", "pos.print_invoice",
    # Sell
    "sell.view_all", "sell.view_own", "sell.view_paid", "sell.view_due",
    "sell.view_partial", "sell.view_overdue",
    "sell.add", "sell.update", "sell.delete",
    "sell.commission_agent_view_own",
    "sell.payment_add", "sell.payment_edit", "sell.payment_delete",
    "sell.edit_product_price", "sell.edit_product_discount",
    "sell.discount_manage",
    "sell.return_view_all", "sell.return_view_own",
    "sell.invoice_number_edit",
    # Draft
    "draft.view_all", "draft.view_own", "draft.edit", "draft.delete",
    # Quotation
    "quotation.view_all", "quotation.view_own",
    "quotation.edit", "quotation.delete",
    # Shipments
    "shipments.access_all", "shipments.access_own",
    "shipments.access_pending", "shipments.commission_agent_view_own",
    # Cash register
    "register.view", "register.close",
    # Brand / Tax / Unit / Category
    "brand.view", "brand.add", "brand.edit", "brand.delete",
    "tax.view", "tax.add", "tax.edit", "tax.delete",
    "unit.view", "unit.add", "unit.edit", "unit.delete",
    "category.view", "category.add", "category.edit", "category.delete",
    # Reports
    "report.purchase_sell", "report.tax", "report.supplier_customer",
    "report.expense", "report.profit_loss",
    "report.stock", "report.trending_product", "report.register",
    "report.sales_representative", "report.product_stock_value",
    # Settings
    "settings.business", "settings.barcode", "settings.invoice", "settings.printers",
    # Expense
    "expense.view_all", "expense.view_own",
    "expense.add", "expense.edit", "expense.delete",
    # Home / Account / Repair / Superadmin
    "home.view",
    "account.access", "account.transaction_edit", "account.transaction_delete",
    "repair.invoice_add", "repair.invoice_edit",
    "repair.invoice_view_all", "repair.invoice_view_own",
    "repair.invoice_delete", "repair.invoice_status",
    "repair.job_sheet_manage_status",
    "repair.job_sheet_add", "repair.job_sheet_edit", "repair.job_sheet_delete",
    "repair.job_sheet_view_assigned", "repair.job_sheet_view_all",
    "superadmin.package_subscriptions",
})


# ──────────────────────────────────────────────────────────────────────────────
# Built-in role → granular permission set
# ──────────────────────────────────────────────────────────────────────────────
# Owners get every code (treated specially in code too). Admin = owner minus
# superadmin. Manager runs the day-to-day shop. Cashier is POS-only.

_ALL_MINUS_SUPERADMIN = ALL_PERMISSIONS - {"superadmin.package_subscriptions"}

BUILTIN_GRANULAR: dict[str, frozenset[str]] = {
    "owner": ALL_PERMISSIONS,
    "admin": _ALL_MINUS_SUPERADMIN,
    "manager": frozenset({
        # Customers / suppliers
        "customer.view_all", "customer.add", "customer.edit",
        "customer.view_no_sell_1m", "customer.view_no_sell_3m",
        "customer.view_no_sell_6m", "customer.view_no_sell_1y",
        "supplier.view_all", "supplier.add", "supplier.edit",
        # Products
        "product.view", "product.add", "product.edit",
        "product.add_opening_stock", "product.view_purchase_price",
        # Sales / POS / Drafts / Quotations / Returns
        "sell.view_all", "sell.add", "sell.update",
        "sell.view_paid", "sell.view_due", "sell.view_partial", "sell.view_overdue",
        "sell.payment_add", "sell.payment_edit",
        "sell.discount_manage", "sell.return_view_all",
        "sell.edit_product_price", "sell.edit_product_discount",
        "pos.view", "pos.add", "pos.edit",
        "pos.edit_product_price", "pos.edit_product_discount", "pos.print_invoice",
        "draft.view_all", "draft.edit",
        "quotation.view_all", "quotation.edit",
        # Purchases
        "purchase.view_all", "purchase.add", "purchase.edit",
        "purchase.payment_add", "purchase.payment_edit", "purchase.update_status",
        # Master data
        "brand.view", "brand.add", "brand.edit",
        "category.view", "category.add", "category.edit",
        "unit.view", "unit.add", "unit.edit",
        "tax.view",
        # Expense / Register / Reports
        "expense.view_all", "expense.add", "expense.edit",
        "register.view", "register.close",
        "report.purchase_sell", "report.tax", "report.supplier_customer",
        "report.expense", "report.stock", "report.trending_product",
        "report.register", "report.sales_representative",
        # Other
        "shipments.access_all", "shipments.access_pending",
        "user.view", "role.view",
        "account.access",
        "home.view",
        "others.view_export_buttons",
    }),
    "cashier": frozenset({
        "pos.view", "pos.add", "pos.print_invoice",
        "sell.view_own", "sell.add", "sell.payment_add",
        "draft.view_own",
        "customer.view_all", "customer.add",
        "product.view",
        "register.view",
        "home.view",
    }),
}


# ──────────────────────────────────────────────────────────────────────────────
# Legacy Perm.* code → equivalent granular codes
# ──────────────────────────────────────────────────────────────────────────────
# Endpoints that still ask for the older coarse codes accept ANY of the
# granular aliases as a match — keeps the existing decorators valid while
# also honouring per-role granular customisation.

LEGACY_ALIAS: dict[str, frozenset[str]] = {
    "can_create_sale":         frozenset({"sell.add", "pos.add"}),
    "can_edit_sale":           frozenset({"sell.update", "sell.delete", "pos.edit", "pos.delete"}),
    "can_void_sale":           frozenset({"sell.delete", "pos.delete"}),
    "can_view_purchase_price": frozenset({"product.view_purchase_price"}),
    "can_apply_discount":      frozenset({"sell.discount_manage", "sell.edit_product_discount", "pos.edit_product_discount"}),
    "can_view_reports":        frozenset({
        "report.purchase_sell", "report.tax", "report.supplier_customer",
        "report.expense", "report.stock", "report.trending_product",
        "report.register", "report.sales_representative",
    }),
    "can_view_profit_loss":    frozenset({"report.profit_loss"}),
    "can_manage_products":     frozenset({
        "product.add", "product.edit", "product.delete",
        "category.add", "category.edit", "brand.add", "brand.edit",
        "unit.add", "unit.edit",
    }),
    "can_manage_users":        frozenset({
        "user.add", "user.edit", "user.delete",
        "role.add", "role.edit", "role.delete",
    }),
    "can_manage_accounts":     frozenset({
        "account.access", "account.transaction_edit", "account.transaction_delete",
    }),
    "can_record_expense":      frozenset({"expense.add", "expense.edit", "expense.delete"}),
    "can_view_audit_log":      frozenset({"others.view_export_buttons"}),   # closest fit
    "can_manage_settings":     frozenset({"settings.business", "settings.barcode", "settings.invoice", "settings.printers"}),
}
