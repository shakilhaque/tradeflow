import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Button from '../../components/ui/Button'
import Card from '../../components/ui/Card'
import Badge from '../../components/ui/Badge'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import { getCustomers, getShipments, deleteSale, getSale, updateSaleShipping } from '../../api/sales'
import { getLocations } from '../../api/products'
import { getCompanyProfile } from '../../api/companyProfile'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import EditShippingModal from '../../components/sales/EditShippingModal'
import InvoiceSlip from '../../components/invoice/InvoiceSlip'
import DateRangePresetPicker from '../../components/ui/DateRangePresetPicker'
import CustomerTypeahead from '../../components/form/CustomerTypeahead'
import { fmtPhone } from '../../utils/phone'

const PAGE_SIZES = [10, 25, 50, 100]
const currentYear = new Date().getFullYear()
const defaultDateFrom = `${currentYear}-01-01`
const defaultDateTo   = `${currentYear}-12-31`

const SHIPPING_VARIANT = {
  PENDING:   'yellow',
  SHIPPED:   'blue',
  DELIVERED: 'green',
  Done:      'green',
}
const PAYMENT_VARIANT = { PAID: 'green', PARTIAL: 'yellow', DUE: 'red' }

const FIELD = 'h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-navy-800 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100'

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, {
  month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—')

export default function ShipmentsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const [rows,        setRows]        = useState([])
  const [count,       setCount]       = useState(0)
  const [page,        setPage]        = useState(1)
  const [limit,       setLimit]       = useState(25)
  const [totalPages,  setTotalPages]  = useState(1)
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')

  const [locations,   setLocations]   = useState([])
  const [customers,   setCustomers]   = useState([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [users,       setUsers]       = useState([])         // [{id, name}]
  const [serviceStaff, setServiceStaff] = useState([])       // [{id, name}]

  const [filtersOpen, setFiltersOpen] = useState(true)
  const [filters, setFilters] = useState({
    location_id: '', customer_id: '', payment_status: '',
    shipping_status: '', user_id: '', service_staff: '',
    date_from: defaultDateFrom, date_to: defaultDateTo,
  })

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => `${c.name} ${c.phone || ''}`.toLowerCase().includes(q))
  }, [customers, customerSearch])

  // Edit Shipping + Print Invoice handlers — both load the full sale
  // first so the modal and the slip see every field, including the
  // ones the list endpoint doesn't surface.
  const [editShippingSale, setEditShippingSale] = useState(null)
  const [printSale,        setPrintSale]        = useState(null)
  const [companyProfile,   setCompanyProfile]   = useState(null)
  useEffect(() => {
    getCompanyProfile().then((p) => setCompanyProfile(p || {})).catch(() => setCompanyProfile({}))
  }, [])

  // Honor ?edit=<sale_id> from All Sales → opens Edit Shipping modal
  // directly. ?packing=<sale_id> triggers the print invoice flow.
  useEffect(() => {
    const editId = params.get('edit')
    const packId = params.get('packing')
    if (editId) {
      getSale(editId).then((full) => setEditShippingSale(full)).catch(() => {})
      setParams((p) => { p.delete('edit'); return p })
    }
    if (packId) {
      getSale(packId).then((full) => {
        setPrintSale(full)
        setTimeout(() => { window.print(); setTimeout(() => setPrintSale(null), 300) }, 80)
      }).catch(() => {})
      setParams((p) => { p.delete('packing'); return p })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onEditShipping = async (row) => {
    try {
      const full = await getSale(row.id)
      setEditShippingSale(full)
    } catch (e) {
      alert(e?.message || 'Could not load shipment.')
    }
  }
  const onPrintInvoice = async (row) => {
    try {
      const full = await getSale(row.id)
      setPrintSale(full)
      setTimeout(() => {
        window.print()
        setTimeout(() => setPrintSale(null), 300)
      }, 80)
    } catch (e) {
      alert(e?.message || 'Could not load sale for printing.')
    }
  }

  const loadMaster = useCallback(async () => {
    try {
      const [locs, custs] = await Promise.all([
        getLocations(true),
        getCustomers({ active_only: 'true' }),
      ])
      { const _l = Array.isArray(locs)   ? locs   : (locs?.results   ?? []); setLocations(_l); if (_l.length === 1) setFilters((f) => ({ ...f, location_id: f.location_id || String(_l[0].id) })) }
      setCustomers(Array.isArray(custs) ? custs : (custs?.results ?? []))
    } catch { /* ignore */ }
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getShipments({
        page, limit,
        search: search || undefined,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      })
      const results = data?.results ?? []
      setRows(results)
      setCount(data?.count ?? 0)
      setTotalPages(data?.total_pages ?? 1)

      // Build distinct user lists with NAME (fallback to id if name missing).
      const seenU = new Map(), seenS = new Map()
      results.forEach((r) => {
        if (r.created_by_id)   seenU.set(r.created_by_id,   r.created_by_name   || r.created_by_id)
        if (r.finalized_by_id) seenS.set(r.finalized_by_id, r.finalized_by_name || r.finalized_by_id)
      })
      setUsers([...seenU.entries()].map(([id, name]) => ({ id, name })))
      setServiceStaff([...seenS.entries()].map(([id, name]) => ({ id, name })))
    } finally {
      setLoading(false)
    }
  }, [page, limit, search, filters])

  useEffect(() => { loadMaster() }, [loadMaster])
  useEffect(() => { loadData().catch(() => setLoading(false)) }, [loadData])

  const onFilter = (k) => (e) => { setPage(1); setFilters((f) => ({ ...f, [k]: e.target.value })) }

  const resetFilters = () => {
    setFilters({
      location_id: '', customer_id: '', payment_status: '',
      shipping_status: '', user_id: '', service_staff: '',
      date_from: defaultDateFrom, date_to: defaultDateTo,
    })
    setCustomerSearch(''); setSearch(''); setPage(1)
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this shipment? This cannot be undone.')) return
    try {
      await deleteSale(id)
      await loadData()
    } catch (err) {
      alert(err?.message || 'Failed to delete')
    }
  }

  const exportCsv = () => {
    if (!rows.length) return
    const head = ['Date', 'Invoice', 'Customer', 'Contact', 'Location', 'Shipping', 'Payment', 'Service Staff']
    const csv  = [head.join(',')].concat(
      rows.map((r) => [
        fmtDateTime(r.date || r.created_at),
        r.invoice_no || '',
        (r.customer_name || 'Walk-in customer').replace(/,/g, ' '),
        r.contact_number || '',
        (r.location_name || '').replace(/,/g, ' '),
        r.shipping_status || '',
        r.payment_status  || '',
        (r.finalized_by_name || '').replace(/,/g, ' '),
      ].join(',')),
    ).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `shipments-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Shipments</h1>
        <p className="mt-0.5 text-sm text-emerald-50">Track sales that include shipping.</p>
      </div>

      {/* ── Filters card ── */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <button type="button" onClick={() => setFiltersOpen((v) => !v)} className="flex items-center gap-2 text-sm font-semibold text-brand-700">
            Filters
            <svg className={`h-4 w-4 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          <button onClick={resetFilters} className="text-xs font-medium text-brand-600 hover:text-brand-700">Reset</button>
        </div>

        <div className={`grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 ${filtersOpen ? '' : 'hidden'}`}>
          <select value={filters.location_id} onChange={onFilter('location_id')} className={FIELD}>
            <option value="">Business Location</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>

          {/* Modern typeahead — same component as AllSales. */}
          <div>
            <CustomerTypeahead
              customers={customers}
              value={customerSearch}
              onChange={(v) => setCustomerSearch(v)}
              onPick={(c) => {
                setPage(1)
                setCustomerSearch(c ? c.name : '')
                setFilters((f) => ({ ...f, customer_id: c ? c.id : '' }))
              }}
              inputClassName={`${FIELD} pl-8`}
            />
          </div>

          <div>
            <DateRangePresetPicker
              from={filters.date_from}
              to={filters.date_to}
              onChange={({ from, to }) => {
                setPage(1)
                setFilters((f) => ({ ...f, date_from: from, date_to: to }))
              }}
            />
          </div>

          {/* User (Salesperson) filter removed per spec. */}

          <select value={filters.payment_status} onChange={onFilter('payment_status')} className={FIELD}>
            <option value="">Payment Status</option>
            <option value="PAID">Paid</option>
            <option value="PARTIAL">Partial</option>
            <option value="DUE">Due</option>
          </select>

          <select value={filters.shipping_status} onChange={onFilter('shipping_status')} className={FIELD}>
            <option value="">Shipping Status</option>
            <option value="PENDING">Pending</option>
            <option value="SHIPPED">Shipped</option>
            <option value="DELIVERED">Delivered</option>
          </select>

          <select value={filters.service_staff} onChange={onFilter('service_staff')} className={FIELD}>
            <option value="">Service Staff</option>
            {serviceStaff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      </Card>

      {/* ── Toolbar ── */}
      <Card padding="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span>Show</span>
            <select
              value={limit}
              onChange={(e) => { setPage(1); setLimit(Number(e.target.value)) }}
              className="h-9 rounded-lg border border-gray-200 px-2 text-sm bg-white"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>entries</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={exportCsv}>Export CSV</Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>Print</Button>
          </div>
          <div className="w-full sm:w-72">
            <SearchInput value={search} onChange={(v) => { setPage(1); setSearch(v) }} placeholder="Search invoice, customer, contact..." />
          </div>
        </div>
      </Card>

      {/* ── Table ── */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12">
            <EmptyState title="No shipments" message="Shipped sales will appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Invoice No</th>
                  <th className="px-4 py-3">Customer Name</th>
                  <th className="px-4 py-3">Contact Number</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Shipping Status</th>
                  <th className="px-4 py-3">Payment Status</th>
                  <th className="px-4 py-3">Service Staff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <ActionMenu
                        row={r}
                        onView={() => navigate(`/sales/${r.invoice_number || r.invoice_no || r.id}`)}
                        onEditShipping={onEditShipping}
                        onPrintInvoice={onPrintInvoice}
                        onDelete={() => handleDelete(r.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{fmtDateTime(r.date || r.created_at)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{r.invoice_no || '—'}</td>
                    <td className="px-4 py-3 font-medium">{r.customer_name || <span className="italic text-gray-400">Walk-in</span>}</td>
                    <td className="px-4 py-3 text-gray-700">{fmtPhone(r.contact_number) || '—'}</td>
                    <td className="px-4 py-3 text-gray-700">{r.location_name || '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant={SHIPPING_VARIANT[r.shipping_status] ?? 'gray'}>
                        {r.shipping_status || '—'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={PAYMENT_VARIANT[r.payment_status] ?? 'gray'}>
                        {r.payment_status || 'DUE'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.finalized_by_name || r.service_staff_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!loading && count > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–
            <strong>{Math.min(page * limit, count)}</strong> of <strong>{count}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="px-3">{page} / {totalPages}</span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      )}

      {/* Edit Shipping modal */}
      {editShippingSale && (
        <EditShippingModal
          sale={editShippingSale}
          onClose={() => setEditShippingSale(null)}
          onSaved={() => { setEditShippingSale(null); loadData() }}
        />
      )}

      {/* Print-only InvoiceSlip — hidden on screen, takes over @media print */}
      {printSale && (
        <InvoiceSlip
          mode="print-only"
          company={companyProfile}
          invoice={{
            number:   printSale.invoice_number || printSale.invoice_no || '—',
            date:     printSale.finalized_at || printSale.created_at,
            location_code: printSale.location_code,
            location_name: printSale.location_name,
          }}
          customer={{
            name:    printSale.customer?.name || printSale.customer_name || 'Walk-in customer',
            address: printSale.customer?.address || printSale.shipping_address,
            phone:   printSale.customer?.phone,
            email:   printSale.customer?.email,
          }}
          items={(printSale.items || []).map((it) => ({
            id:          it.id,
            description: it.product_name,
            sku:         it.product_sku,
            unit_price:  it.unit_price,
            quantity:    it.quantity,
            line_total:  it.line_total,
          }))}
          totals={{
            subtotal:   printSale.subtotal,
            discount:   printSale.discount,
            tax_amount: printSale.tax_amount,
            tax_rate:   printSale.tax_rate,
            total:      printSale.total_amount,
            // Without these, the slip would default paid=0 and print
            // "Due (this invoice)" even on a fully-paid sale.
            paid:        printSale.amount_paid,
            balance_due: printSale.balance_due,
          }}
        />
      )}
    </div>
  )
}


function ActionMenu({ row, onView, onEditShipping, onPrintInvoice, onDelete }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  // Portal the menu out to <body> using viewport coords so the
  // overflow-x-auto wrapper around the table can't clip it and so
  // the dropdown isn't cut off by neighbour rows above/below.
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) {
      const MENU_H = 200
      const spaceBelow = window.innerHeight - r.bottom
      const top = spaceBelow >= MENU_H ? r.bottom + 4 : Math.max(8, r.top - MENU_H - 4)
      const MENU_W = 176
      const left = Math.min(r.left, window.innerWidth - MENU_W - 8)
      setPos({ top, left })
    }
    setOpen(true)
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-soft transition"
      >
        Actions
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M5 7l5 6 5-6z" /></svg>
      </button>
      {open && createPortal(
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[60] cursor-default"
          />
          <div
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[70] mt-0 w-44 rounded-lg border border-gray-100 bg-white shadow-pop overflow-hidden"
          >
            <button onClick={() => { setOpen(false); onView() }} className="block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">👁 View</button>
            <button onClick={() => { setOpen(false); onEditShipping?.(row) }} className="block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">✏ Edit Shipping</button>
            <button onClick={() => { setOpen(false); onPrintInvoice?.(row) }} className="block w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">🖨 Print Invoice</button>
            {row.id && <button onClick={() => { setOpen(false); onDelete() }} className="block w-full text-left px-3 py-2 text-xs text-rose-600 hover:bg-rose-50">🗑 Delete</button>}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
