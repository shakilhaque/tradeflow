// Demo data used by Sale-Return and Import-from-Excel pages.
// These pages fall back to this data when the API isn't available,
// so the UI is always testable end-to-end without a backend round-trip.

export const DEMO_LOCATIONS = [
  { id: 'loc-1', name: 'Main Branch' },
  { id: 'loc-2', name: 'Warehouse #2' },
  { id: 'loc-3', name: 'Mirpur Outlet' },
]

export const DEMO_CUSTOMERS = [
  { id: 'c-1', name: 'Walk-in Customer', phone: '' },
  { id: 'c-2', name: 'Karim Traders',    phone: '+880 1711 222333' },
  { id: 'c-3', name: 'Rahim Hossain',    phone: '+880 1611 998877' },
  { id: 'c-4', name: 'Fatima Begum',     phone: '+880 1811 445566' },
]

export const DEMO_PRODUCTS = [
  { id: 'p-1', name: 'iPhone 15 — 128GB',     sku: 'IP15-128',  price: 145000, unit: 'pcs' },
  { id: 'p-2', name: 'Samsung Galaxy S24',    sku: 'SGS24-256', price: 132000, unit: 'pcs' },
  { id: 'p-3', name: 'AirPods Pro (2nd gen)', sku: 'APP-2',     price:  28500, unit: 'pcs' },
  { id: 'p-4', name: 'USB-C Cable 1m',        sku: 'USBC-1M',   price:    650, unit: 'pcs' },
  { id: 'p-5', name: 'Wireless Mouse',        sku: 'WMS-001',   price:   2200, unit: 'pcs' },
]

// Sales available to "return against" — keyed by id, includes line items.
export const DEMO_SALES = [
  {
    id: 's-1001',
    invoice_no: 'INV-2026-001001',
    sale_date: '2026-04-12',
    customer_id: 'c-2',
    customer_name: 'Karim Traders',
    location_id: 'loc-1',
    location_name: 'Main Branch',
    payment_status: 'PAID',
    total_amount: 173500,
    items: [
      { product_id: 'p-1', product_name: 'iPhone 15 — 128GB',     sku: 'IP15-128', qty: 1, unit_price: 145000, line_total: 145000 },
      { product_id: 'p-3', product_name: 'AirPods Pro (2nd gen)', sku: 'APP-2',    qty: 1, unit_price:  28500, line_total:  28500 },
    ],
  },
  {
    id: 's-1002',
    invoice_no: 'INV-2026-001002',
    sale_date: '2026-04-18',
    customer_id: 'c-3',
    customer_name: 'Rahim Hossain',
    location_id: 'loc-1',
    location_name: 'Main Branch',
    payment_status: 'PARTIAL',
    total_amount: 134850,
    items: [
      { product_id: 'p-2', product_name: 'Samsung Galaxy S24', sku: 'SGS24-256', qty: 1, unit_price: 132000, line_total: 132000 },
      { product_id: 'p-4', product_name: 'USB-C Cable 1m',     sku: 'USBC-1M',   qty: 2, unit_price:    650, line_total:   1300 },
      { product_id: 'p-5', product_name: 'Wireless Mouse',     sku: 'WMS-001',   qty: 1, unit_price:   2200, line_total:   2200 },
    ],
  },
  {
    id: 's-1003',
    invoice_no: 'INV-2026-001003',
    sale_date: '2026-04-25',
    customer_id: 'c-4',
    customer_name: 'Fatima Begum',
    location_id: 'loc-3',
    location_name: 'Mirpur Outlet',
    payment_status: 'DUE',
    total_amount: 28500,
    items: [
      { product_id: 'p-3', product_name: 'AirPods Pro (2nd gen)', sku: 'APP-2', qty: 1, unit_price: 28500, line_total: 28500 },
    ],
  },
]

// Pre-existing returns shown on the returns list.
export const DEMO_RETURNS = [
  {
    id: 'r-2001',
    invoice_no: 'CRN-2026-000001',
    return_date: '2026-04-15',
    parent_sale_id: 's-1001',
    parent_invoice_no: 'INV-2026-001001',
    customer_id: 'c-2',
    customer_name: 'Karim Traders',
    location_id: 'loc-1',
    location_name: 'Main Branch',
    payment_status: 'REFUNDED',
    refund_method: 'CASH',
    items: [
      { product_id: 'p-3', product_name: 'AirPods Pro (2nd gen)', sku: 'APP-2', qty: 1, unit_price: 28500, line_total: 28500, reason: 'DEFECTIVE' },
    ],
    total_amount: 28500,
    refunded_amount: 28500,
    balance_due: 0,
    notes: 'Customer reported left earbud not charging.',
  },
  {
    id: 'r-2002',
    invoice_no: 'CRN-2026-000002',
    return_date: '2026-04-22',
    parent_sale_id: 's-1002',
    parent_invoice_no: 'INV-2026-001002',
    customer_id: 'c-3',
    customer_name: 'Rahim Hossain',
    location_id: 'loc-1',
    location_name: 'Main Branch',
    payment_status: 'PARTIAL',
    refund_method: 'STORE_CREDIT',
    items: [
      { product_id: 'p-4', product_name: 'USB-C Cable 1m', sku: 'USBC-1M', qty: 1, unit_price: 650, line_total: 650, reason: 'WRONG_ITEM' },
    ],
    total_amount: 650,
    refunded_amount: 400,
    balance_due: 250,
    notes: '',
  },
]

export const RETURN_REASONS = [
  { value: 'DEFECTIVE',    label: 'Defective / Damaged' },
  { value: 'WRONG_ITEM',   label: 'Wrong item shipped' },
  { value: 'NOT_AS_DESC',  label: 'Not as described' },
  { value: 'CHANGED_MIND', label: 'Customer changed mind' },
  { value: 'EXPIRED',      label: 'Expired product' },
  { value: 'OTHER',        label: 'Other' },
]

export const REFUND_METHODS = [
  { value: 'CASH',         label: 'Cash refund' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'STORE_CREDIT', label: 'Store credit' },
  { value: 'EXCHANGE',     label: 'Exchange (no refund)' },
]
