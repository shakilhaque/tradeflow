/**
 * Catalog of granular permissions a tenant role can grant.
 *
 * Mirrors role.txt verbatim — every line in the desktop spec is one
 * entry here. Used by both AddRolePage and the Edit Role modal in
 * RolesPage so a single source of truth drives both screens.
 *
 * Codes use dot-separated namespaces (group.action) so backend code
 * can do `if 'sell.delete' in role.permissions:` checks later. The
 * exact strings are stable — change a label freely but don't rename
 * a code once it's saved against a TenantRole row.
 */
export const PERMISSION_GROUPS = [
  {
    id: 'others', label: 'Others',
    perms: [
      { code: 'others.service_staff',       label: 'Service staff' },
      { code: 'others.view_export_buttons', label: 'View export buttons (CSV / Excel / Print / PDF) on tables' },
    ],
  },
  {
    id: 'user', label: 'User',
    perms: [
      { code: 'user.view',   label: 'View user' },
      { code: 'user.add',    label: 'Add user' },
      { code: 'user.edit',   label: 'Edit user' },
      { code: 'user.delete', label: 'Delete user' },
    ],
  },
  {
    id: 'role', label: 'Roles',
    perms: [
      { code: 'role.view',   label: 'View role' },
      { code: 'role.add',    label: 'Add role' },
      { code: 'role.edit',   label: 'Edit role' },
      { code: 'role.delete', label: 'Delete role' },
    ],
  },
  {
    id: 'supplier', label: 'Supplier',
    perms: [
      { code: 'supplier.view_all', label: 'View all suppliers' },
      { code: 'supplier.view_own', label: 'View own suppliers' },
      { code: 'supplier.add',      label: 'Add supplier' },
      { code: 'supplier.edit',     label: 'Edit supplier' },
      { code: 'supplier.delete',   label: 'Delete supplier' },
    ],
  },
  {
    id: 'customer', label: 'Customer',
    perms: [
      { code: 'customer.view_all',         label: 'View all customers' },
      { code: 'customer.view_own',         label: 'View own customers' },
      { code: 'customer.view_no_sell_1m',  label: 'View customers with no sell from one month only' },
      { code: 'customer.view_no_sell_3m',  label: 'View customers with no sell from three months only' },
      { code: 'customer.view_no_sell_6m',  label: 'View customers with no sell from six months only' },
      { code: 'customer.view_no_sell_1y',  label: 'View customers with no sell from one year only' },
      { code: 'customer.view_irrespective',label: 'View customers irrespective of their sell' },
      { code: 'customer.add',              label: 'Add customer' },
      { code: 'customer.edit',             label: 'Edit customer' },
      { code: 'customer.delete',           label: 'Delete customer' },
    ],
  },
  {
    id: 'product', label: 'Product',
    perms: [
      { code: 'product.view',                label: 'View product' },
      { code: 'product.add',                 label: 'Add product' },
      { code: 'product.edit',                label: 'Edit product' },
      { code: 'product.delete',              label: 'Delete product' },
      { code: 'product.add_opening_stock',   label: 'Add opening stock' },
      { code: 'product.view_purchase_price', label: 'View purchase price' },
    ],
  },
  {
    id: 'purchase', label: 'Purchase & Stock Adjustment',
    perms: [
      { code: 'purchase.view_all',       label: 'View all purchase & stock adjustment' },
      { code: 'purchase.view_own',       label: 'View own purchase & stock adjustment' },
      { code: 'purchase.add',            label: 'Add purchase & stock adjustment' },
      { code: 'purchase.edit',           label: 'Edit purchase & stock adjustment' },
      { code: 'purchase.delete',         label: 'Delete purchase & stock adjustment' },
      { code: 'purchase.payment_add',    label: 'Add purchase payment' },
      { code: 'purchase.payment_edit',   label: 'Edit purchase payment' },
      { code: 'purchase.payment_delete', label: 'Delete purchase payment' },
      { code: 'purchase.update_status',  label: 'Update status' },
    ],
  },
  {
    id: 'pos', label: 'Sales on POS',
    perms: [
      { code: 'pos.view',                 label: 'View POS sell' },
      { code: 'pos.add',                  label: 'Add POS sell' },
      { code: 'pos.edit',                 label: 'Edit POS sell' },
      { code: 'pos.delete',               label: 'Delete POS sell' },
      { code: 'pos.edit_product_price',   label: 'Edit product price from POS screen' },
      { code: 'pos.edit_product_discount',label: 'Edit product discount from POS screen' },
      { code: 'pos.print_invoice',        label: 'Print invoice' },
    ],
  },
  {
    id: 'sell', label: 'Sell',
    perms: [
      { code: 'sell.view_all',                  label: 'View all sell' },
      { code: 'sell.view_own',                  label: 'View own sell only' },
      { code: 'sell.view_paid',                 label: 'View paid sells only' },
      { code: 'sell.view_due',                  label: 'View due sells only' },
      { code: 'sell.view_partial',              label: 'View partially paid sells only' },
      { code: 'sell.view_overdue',              label: 'View overdue sells only' },
      { code: 'sell.add',                       label: 'Add sell' },
      { code: 'sell.update',                    label: 'Update sell' },
      { code: 'sell.delete',                    label: 'Delete sell' },
      { code: 'sell.commission_agent_view_own', label: 'Commission agent can view their own sell' },
      { code: 'sell.payment_add',               label: 'Add sell payment' },
      { code: 'sell.payment_edit',              label: 'Edit sell payment' },
      { code: 'sell.payment_delete',            label: 'Delete sell payment' },
      { code: 'sell.edit_product_price',        label: 'Edit product price from sales screen' },
      { code: 'sell.edit_product_discount',     label: 'Edit product discount from sale screen' },
      { code: 'sell.discount_manage',           label: 'Add / edit / delete discount' },
      { code: 'sell.return_view_all',           label: 'Access all sell return' },
      { code: 'sell.return_view_own',           label: 'Access own sell return' },
      { code: 'sell.invoice_number_edit',       label: 'Add / edit invoice number' },
    ],
  },
  {
    id: 'draft', label: 'Draft',
    perms: [
      { code: 'draft.view_all', label: 'View all drafts' },
      { code: 'draft.view_own', label: 'View own drafts' },
      { code: 'draft.edit',     label: 'Edit draft' },
      { code: 'draft.delete',   label: 'Delete draft' },
    ],
  },
  {
    id: 'quotation', label: 'Quotation',
    perms: [
      { code: 'quotation.view_all', label: 'View all quotations' },
      { code: 'quotation.view_own', label: 'View own quotations' },
      { code: 'quotation.edit',     label: 'Edit quotation' },
      { code: 'quotation.delete',   label: 'Delete quotation' },
    ],
  },
  {
    id: 'shipments', label: 'Shipments',
    perms: [
      { code: 'shipments.access_all',                 label: 'Access all shipments' },
      { code: 'shipments.access_own',                 label: 'Access own shipments' },
      { code: 'shipments.access_pending',             label: 'Access pending shipments only' },
      { code: 'shipments.commission_agent_view_own',  label: 'Commission agent can access their own shipments' },
    ],
  },
  {
    id: 'register', label: 'Cash Register',
    perms: [
      { code: 'register.view',  label: 'View cash register' },
      { code: 'register.close', label: 'Close cash register' },
    ],
  },
  {
    id: 'brand', label: 'Brand',
    perms: [
      { code: 'brand.view',   label: 'View brand' },
      { code: 'brand.add',    label: 'Add brand' },
      { code: 'brand.edit',   label: 'Edit brand' },
      { code: 'brand.delete', label: 'Delete brand' },
    ],
  },
  {
    id: 'tax', label: 'Tax rate',
    perms: [
      { code: 'tax.view',   label: 'View tax rate' },
      { code: 'tax.add',    label: 'Add tax rate' },
      { code: 'tax.edit',   label: 'Edit tax rate' },
      { code: 'tax.delete', label: 'Delete tax rate' },
    ],
  },
  {
    id: 'unit', label: 'Unit',
    perms: [
      { code: 'unit.view',   label: 'View unit' },
      { code: 'unit.add',    label: 'Add unit' },
      { code: 'unit.edit',   label: 'Edit unit' },
      { code: 'unit.delete', label: 'Delete unit' },
    ],
  },
  {
    id: 'category', label: 'Category',
    perms: [
      { code: 'category.view',   label: 'View category' },
      { code: 'category.add',    label: 'Add category' },
      { code: 'category.edit',   label: 'Edit category' },
      { code: 'category.delete', label: 'Delete category' },
    ],
  },
  {
    id: 'report', label: 'Report',
    perms: [
      { code: 'report.purchase_sell',             label: 'View purchase & sell report' },
      { code: 'report.tax',                       label: 'View tax report' },
      { code: 'report.supplier_customer',         label: 'View supplier & customer report' },
      { code: 'report.expense',                   label: 'View expense report' },
      { code: 'report.profit_loss',               label: 'View profit / loss report' },
      { code: 'report.stock',                     label: 'View stock report, stock adjustment report & stock expiry report' },
      { code: 'report.trending_product',          label: 'View trending product report' },
      { code: 'report.register',                  label: 'View register report' },
      { code: 'report.sales_representative',      label: 'View sales representative report' },
      { code: 'report.product_stock_value',       label: 'View product stock value' },
    ],
  },
  {
    id: 'settings', label: 'Settings',
    perms: [
      { code: 'settings.business', label: 'Access business settings' },
      { code: 'settings.barcode',  label: 'Access barcode settings' },
      { code: 'settings.invoice',  label: 'Access invoice settings' },
      { code: 'settings.printers', label: 'Access printers' },
    ],
  },
  {
    id: 'expense', label: 'Expense',
    perms: [
      { code: 'expense.view_all',  label: 'Access all expenses' },
      { code: 'expense.view_own',  label: 'View own expense only' },
      { code: 'expense.add',       label: 'Add expense' },
      { code: 'expense.edit',      label: 'Edit expense' },
      { code: 'expense.delete',    label: 'Delete expense' },
    ],
  },
  {
    id: 'home', label: 'Home',
    perms: [
      { code: 'home.view', label: 'View home data' },
    ],
  },
  {
    id: 'account', label: 'Account',
    perms: [
      { code: 'account.access',            label: 'Access accounts' },
      { code: 'account.transaction_edit',  label: 'Edit account transaction' },
      { code: 'account.transaction_delete',label: 'Delete account transaction' },
    ],
  },
  {
    id: 'repair', label: 'Repair',
    perms: [
      { code: 'repair.invoice_add',       label: 'Add invoice' },
      { code: 'repair.invoice_edit',      label: 'Edit invoice' },
      { code: 'repair.invoice_view_all',  label: 'View all invoices' },
      { code: 'repair.invoice_view_own',  label: 'View own invoice' },
      { code: 'repair.invoice_delete',    label: 'Delete invoice' },
      { code: 'repair.invoice_status',    label: 'Change invoice status' },
      { code: 'repair.job_sheet_manage_status', label: 'Add / edit / delete job sheet status' },
      { code: 'repair.job_sheet_add',     label: 'Add job sheet' },
      { code: 'repair.job_sheet_edit',    label: 'Edit job sheet' },
      { code: 'repair.job_sheet_delete',  label: 'Delete job sheet' },
      { code: 'repair.job_sheet_view_assigned', label: 'View only assigned job sheet' },
      { code: 'repair.job_sheet_view_all', label: 'View all job sheets' },
    ],
  },
  {
    id: 'superadmin', label: 'Superadmin',
    perms: [
      { code: 'superadmin.package_subscriptions', label: 'Access package subscriptions' },
    ],
  },
]

/** Flat list of every {code, label, group} for lookups. */
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) =>
  g.perms.map((p) => ({ ...p, group: g.id, groupLabel: g.label })),
)

/** O(1) lookup map: { code → label }. */
export const PERMISSION_LABEL = Object.fromEntries(
  ALL_PERMISSIONS.map((p) => [p.code, p.label]),
)
