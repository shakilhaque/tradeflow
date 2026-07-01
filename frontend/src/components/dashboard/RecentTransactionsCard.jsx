import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getSales, getQuotationSales } from '../../api/sales'
import { getPurchases } from '../../api/purchases'
import { getExpenses } from '../../api/accounting'

const fmtMoney = (n) => `৳${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`

const fmtDate = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

const toRows = (d) => (Array.isArray(d) ? d : d?.results ?? d?.rows ?? [])
const num = (v) => Number(v ?? 0)

// Normalise a row from any of the five sources into one shape.
const norm = (r) => ({
  id:     r.id ?? r.uuid ?? r.reference_no ?? r.invoice_number,
  ref:    r.invoice_number || r.invoice_no || r.reference_no || r.reference || '',
  date:   r.sale_date || r.purchase_date || r.expense_date || r.date || r.created_at,
  party:  r.customer_name || r.supplier_name || r.expense_for || r.category_name || r.category || r.reference || '—',
  status: r.status_display || r.status || r.payment_status || '',
  total:  r.total_amount ?? r.grand_total ?? r.amount ?? r.net_total ?? 0,
  // Sale / Invoice extras — present on the sales-list payload so the Sale
  // tab can mirror the full All Sales columns.
  invoice:       r.invoice_no || r.invoice_number || r.reference_no || '—',
  location:      r.location_name || '—',
  paymentStatus: r.payment_status || '',
  paid:          num(r.total_paid ?? r.amount_paid),
  due:           num(r.sell_due ?? r.balance_due ?? r.payment_due),
  items:         num(r.item_count ?? r.total_items),
  addedBy:       r.created_by_name || r.added_by_name || '—',
  serviceStaff:  r.service_staff_name || r.service_staff || '—',
  // Purchase extras (present on the purchases-list payload).
  referenceNo:   r.reference_no || r.invoice_no || r.invoice_number || '—',
  purchaseStatus: r.status || '',
  hasReturns:    Boolean(r.has_returns),
  returnTotal:   num(r.return_total),
  // Expense extras (present on the expense-list payload).
  categoryDisplay:  r.category_display || r.category || '—',
  recurring:        Boolean(r.recurring),
  recurringDetails: r.recurring_details || '',
  tax:              num(r.tax_amount),
  expenseFor:       r.expense_for || '—',
  contact:          r.contact_name || '—',
})

const PAGE_SIZE  = 5
const FETCH_LIMIT = 50

// Tabs — each pulls its real source. Party header + View-All route differ.
const TABS = [
  { key: 'sale',      label: 'Sale',      party: 'Customer', to: '/sells',              full: true,  fetch: () => getSales({ status: 'FINAL', limit: FETCH_LIMIT }) },
  { key: 'purchase',  label: 'Purchase',  party: 'Supplier', to: '/purchases/list',     purchaseFull: true, fetch: () => getPurchases({ limit: FETCH_LIMIT }) },
  { key: 'quotation', label: 'Quotation', party: 'Customer', to: '/sales/quotations',   full: true,  fetch: () => getQuotationSales({ limit: FETCH_LIMIT }) },
  { key: 'expenses',  label: 'Expenses',  party: 'Category', to: '/accounting/expenses', expenseFull: true, fetch: () => getExpenses({ limit: FETCH_LIMIT }) },
]

// Column sets. The Sale / Invoices tabs mirror the full All Sales table;
// the other tabs keep the compact 4-column shape.
const BASIC_COLUMNS = (party) => [
  { label: 'Date', cell: (r) => fmtDate(r.date), cls: 'text-gray-600 whitespace-nowrap' },
  {
    label: party,
    cell: (r) => (
      <>
        <div className="font-semibold text-gray-900 truncate max-w-[12rem]">{r.party}</div>
        {r.ref && <div className="text-[11px] text-gray-500 font-mono truncate">{r.ref}</div>}
      </>
    ),
  },
  { label: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
  { label: 'Total', cell: (r) => fmtMoney(r.total), align: 'right', cls: 'font-semibold text-gray-900 tabular-nums whitespace-nowrap' },
]

const FULL_COLUMNS = (party) => [
  { label: 'Date',           cell: (r) => fmtDate(r.date),                 cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Invoice',        cell: (r) => r.invoice,                       cls: 'font-mono text-gray-700 whitespace-nowrap' },
  { label: party,            cell: (r) => <span className="font-semibold text-gray-900">{r.party}</span> },
  { label: 'Location',       cell: (r) => r.location,                      cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Payment Status', cell: (r) => <StatusBadge status={r.paymentStatus} /> },
  { label: 'Total',          cell: (r) => fmtMoney(r.total), align: 'right', cls: 'font-semibold text-gray-900 tabular-nums whitespace-nowrap' },
  { label: 'Paid',           cell: (r) => fmtMoney(r.paid),  align: 'right', cls: 'text-gray-700 tabular-nums whitespace-nowrap' },
  { label: 'Due',            cell: (r) => fmtMoney(r.due),   align: 'right', cls: 'text-gray-700 tabular-nums whitespace-nowrap' },
  { label: 'Items',          cell: (r) => r.items,           align: 'right', cls: 'text-gray-700 tabular-nums' },
  { label: 'Added By',       cell: (r) => r.addedBy,                       cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Service Staff',  cell: (r) => r.serviceStaff,                  cls: 'text-gray-600 whitespace-nowrap' },
]

// Purchase tab → mirrors the All Purchases table.
const PURCHASE_COLUMNS = (party) => [
  { label: 'Date',          cell: (r) => fmtDate(r.date),       cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Reference No',  cell: (r) => r.referenceNo,         cls: 'font-mono text-gray-700 whitespace-nowrap' },
  { label: 'Location',      cell: (r) => r.location,            cls: 'text-gray-600 whitespace-nowrap' },
  { label: party,           cell: (r) => <span className="font-semibold text-gray-900">{r.party}</span> },
  { label: 'Status',        cell: (r) => <StatusBadge status={r.hasReturns ? 'Returned' : r.purchaseStatus} /> },
  { label: 'Return Marked', cell: (r) => (r.hasReturns ? <StatusBadge status={`Returned · ${fmtMoney(r.returnTotal)}`} /> : <span className="text-gray-400">—</span>) },
  { label: 'Payment',       cell: (r) => <StatusBadge status={r.paymentStatus} /> },
  { label: 'Grand Total',   cell: (r) => fmtMoney(r.total), align: 'right', cls: 'font-semibold text-gray-900 tabular-nums whitespace-nowrap' },
  { label: 'Payment Due',   cell: (r) => fmtMoney(r.due),   align: 'right', cls: 'text-gray-700 tabular-nums whitespace-nowrap' },
  { label: 'Added By',      cell: (r) => r.addedBy,             cls: 'text-gray-600 whitespace-nowrap' },
]

// Expenses tab → mirrors the All Expenses table.
const EXPENSE_COLUMNS = () => [
  { label: 'Date',             cell: (r) => fmtDate(r.date),    cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Reference No',     cell: (r) => r.referenceNo,      cls: 'font-mono text-gray-700 whitespace-nowrap' },
  { label: 'Recurring',        cell: (r) => (r.recurring ? (r.recurringDetails || 'Recurring') : <span className="text-gray-400">—</span>), cls: 'text-gray-600' },
  { label: 'Expense Category', cell: (r) => <span className="font-semibold text-gray-900">{r.categoryDisplay}</span> },
  { label: 'Location',         cell: (r) => r.location,         cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Payment Status',   cell: (r) => <StatusBadge status={r.paymentStatus} /> },
  { label: 'Tax',              cell: (r) => fmtMoney(r.tax),    align: 'right', cls: 'text-gray-700 tabular-nums whitespace-nowrap' },
  { label: 'Total Amount',     cell: (r) => fmtMoney(r.total),  align: 'right', cls: 'font-semibold text-gray-900 tabular-nums whitespace-nowrap' },
  { label: 'Payment Due',      cell: (r) => fmtMoney(r.due),    align: 'right', cls: 'text-gray-700 tabular-nums whitespace-nowrap' },
  { label: 'Expense For',      cell: (r) => r.expenseFor,       cls: 'text-gray-600 whitespace-nowrap' },
  { label: 'Contact',          cell: (r) => r.contact,          cls: 'text-gray-600 whitespace-nowrap' },
]

function StatusBadge({ status }) {
  const s = String(status || '').toLowerCase()
  let cls = 'bg-gray-100 text-gray-600'
  if (/final|complete|paid|approved|received|done|active/.test(s)) cls = 'bg-emerald-100 text-emerald-700'
  else if (/pending|partial|draft|due|unpaid|ordered/.test(s))     cls = 'bg-sky-100 text-sky-700'
  else if (/cancel|void|fail|refund|return|overdue/.test(s))       cls = 'bg-rose-100 text-rose-700'
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  )
}

/**
 * RecentTransactionsCard — tabbed dashboard widget showing the latest
 * Sale / Purchase / Quotation / Expense / Invoice records. Each tab pulls
 * live from its own list endpoint, so it always reflects real data for the
 * tenant. Lazy-loads (and caches) each tab the first time it's opened.
 */
export default function RecentTransactionsCard() {
  const [active,  setActive]  = useState('sale')
  const [cache,   setCache]   = useState({})   // { [tabKey]: rows[] }
  const [loading, setLoading] = useState(false)
  const [page,    setPage]    = useState(1)

  const tab = TABS.find((t) => t.key === active) ?? TABS[0]

  useEffect(() => {
    setPage(1)                            // reset paging when the tab changes
    if (cache[active]) return            // already loaded
    let cancelled = false
    setLoading(true)
    tab.fetch()
      .then((d) => { if (!cancelled) setCache((c) => ({ ...c, [active]: toRows(d).map(norm) })) })
      .catch(() => { if (!cancelled) setCache((c) => ({ ...c, [active]: [] })) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const allRows    = cache[active] || []
  const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const rows       = allRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const columns    = tab.full ? FULL_COLUMNS(tab.party)
    : tab.purchaseFull ? PURCHASE_COLUMNS(tab.party)
    : tab.expenseFull ? EXPENSE_COLUMNS()
    : BASIC_COLUMNS(tab.party)

  return (
    <div className="rounded-2xl bg-white shadow-soft border border-gray-100 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 22V4a1 1 0 011-1h14a1 1 0 011 1v18l-3-2-3 2-3-2-3 2-3-2z" /><path d="M8 7h8M8 11h8M8 15h5" /></svg>
          </span>
          <h3 className="text-base font-semibold text-gray-900">Recent Transactions</h3>
        </div>
        <Link to={tab.to} className="whitespace-nowrap text-sm font-semibold text-brand-600 hover:text-brand-700">
          View All
        </Link>
      </div>

      {/* Tabs */}
      <div className="mt-3 flex items-center gap-5 border-b border-gray-100 px-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={[
              '-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors',
              active === t.key
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="px-2 pb-2">
        {loading && allRows.length === 0 ? (
          <div className="flex justify-center py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          </div>
        ) : allRows.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">No recent {tab.label.toLowerCase()} transactions.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
                {columns.map((c) => (
                  <th key={c.label} className={`px-3 py-2 font-semibold ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                  {columns.map((c) => (
                    <td key={c.label} className={`px-3 py-2.5 ${c.align === 'right' ? 'text-right' : ''} ${c.cls || 'text-gray-700'}`}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {/* Pagination */}
        {allRows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-3 pt-2.5">
            <span className="text-[11px] text-gray-500">
              Page {safePage} of {totalPages} · {allRows.length} records
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
