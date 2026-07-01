import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import { getProductStockHistory, getLocations } from '../../api/products'

/**
 * Product Stock History — drills into a single product's full
 * movement ledger. Header shows the product name; a Business
 * Location dropdown filters the aggregates + ledger; the ledger
 * lists Type / Quantity Change / New Quantity / Date / Reference.
 *
 * All data is pulled live from the per-tenant DB via
 * /api/inventory/products/<id>/stock-history/, so this page reflects
 * every sale / transfer / adjustment the moment the page loads.
 */
const fmtQty = (s, unit) => {
  const n = Number(s || 0)
  return `${n.toFixed(2)} ${unit || 'Pc(s)'}`
}
const fmtDT = (d) => d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function ProductStockHistoryPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [locations, setLocations] = useState([])
  const [locationId, setLocationId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [limit, setLimit] = useState(25)

  useEffect(() => {
    getLocations(true).then((res) => {
      const arr = Array.isArray(res) ? res : (res?.results ?? [])
      setLocations(arr)
      if (arr.length && !locationId) setLocationId(arr[0].id)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr('')
    getProductStockHistory(id, locationId ? { location_id: locationId, limit: 500 } : { limit: 500 })
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setErr(e?.message || 'Failed to load stock history.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, locationId])

  const unit = data?.product?.unit || 'Pc(s)'
  const visibleMovements = useMemo(() => (data?.movements || []).slice(0, limit), [data, limit])

  const exportCsv = () => {
    if (!data) return
    const rows = (data.movements || []).map((m) => [
      m.type,
      m.qty_change,
      m.new_quantity,
      fmtDT(m.date),
      m.reference_no || '',
    ])
    const csv = [['Type', 'Quantity change', 'New Quantity', 'Date', 'Reference No'], ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = 'product-stock-history.csv'; a.click()
  }
  const printReport = () => {
    if (!data) return
    const w = window.open('', '_blank', 'width=1200,height=800')
    if (!w) { window.alert('Allow popups to print this report.'); return }
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rows = (data.movements || []).map((m) => (
      `<tr><td>${esc(m.type)}</td><td class="num">${esc(m.qty_change)}</td><td class="num">${esc(m.new_quantity)}</td><td>${esc(fmtDT(m.date))}</td><td>${esc(m.reference_no || '')}</td></tr>`
    )).join('')
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Stock History</title>
<style>body{font-family:Inter,system-ui,sans-serif;margin:14mm 10mm;color:#111827}h1{margin:0 0 4px;font-size:20px}.meta{color:#6b7280;font-size:11px;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#f3f4f6;text-align:left;padding:6px 8px;border:1px solid #e5e7eb;font-weight:600;text-transform:uppercase;font-size:10px}td{padding:6px 8px;border:1px solid #e5e7eb}td.num{text-align:right;font-variant-numeric:tabular-nums}@page{size:A4 landscape;margin:8mm}</style>
</head><body>
<h1>Product Stock History — ${esc(data.product.name)}${data.product.sku ? ' (' + esc(data.product.sku) + ')' : ''}</h1>
<div class="meta">Location: ${esc(locations.find((l) => l.id === locationId)?.name || 'All')} · Generated: ${new Date().toLocaleString()}</div>
<table><thead><tr><th>Type</th><th>Quantity change</th><th>New Quantity</th><th>Date</th><th>Reference No</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:24px">No movements.</td></tr>'}</tbody></table>
<script>window.onload=()=>setTimeout(()=>window.print(),100)</script>
</body></html>`)
    w.document.close()
  }

  if (loading) return <div className="py-16 text-center text-gray-400">Loading…</div>
  if (err) return <div className="m-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-rose-700">{err}</div>
  if (!data) return null

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Product stock history</h1>

      {/* Brand-coloured header chip — matches the rest of the app
          (POS Add Expense, action buttons, etc.) instead of the
          orange used by the reference screenshot. */}
      <div className="rounded-lg bg-brand-600 text-white px-4 py-3 text-center text-sm font-semibold shadow-soft">
        {data.product.name}{data.product.sku ? ` (${data.product.sku})` : ''}
      </div>

      <Card padding="p-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Business Location</label>
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className="h-9 w-80 max-w-full rounded-md border border-emerald-200 bg-white px-2.5 text-sm text-emerald-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
        >
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}{l.code ? ` (${l.code})` : ''}</option>
          ))}
        </select>
      </Card>

      <Card padding="p-4">
        <div className="text-sm font-semibold text-navy-800 mb-3">
          {data.product.name}{data.product.sku ? ` (${data.product.sku})` : ''}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
          <KpiBlock title="Quantities In" rows={[
            ['Total Purchase',    fmtQty(data.quantities_in.total_purchase, unit)],
            ['Opening Stock',     fmtQty(data.quantities_in.opening_stock, unit)],
            ['Total Sell Return', fmtQty(data.quantities_in.total_sell_return, unit)],
            ['Stock Transfers (In)', fmtQty(data.quantities_in.stock_transfers_in, unit)],
          ]} />
          <KpiBlock title="Quantities Out" rows={[
            ['Total Sold',             fmtQty(data.quantities_out.total_sold, unit)],
            ['Total Stock Adjustment', fmtQty(data.quantities_out.total_stock_adjustment, unit)],
            ['Total Purchase Return',  fmtQty(data.quantities_out.total_purchase_return, unit)],
            ['Stock Transfers (Out)',  fmtQty(data.quantities_out.stock_transfers_out, unit)],
          ]} />
          <KpiBlock title="Totals" rows={[
            ['Current stock', fmtQty(data.current_stock, unit)],
          ]} />
        </div>
      </Card>

      <Card padding="p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="text-xs text-gray-500">
            Show
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="mx-2 rounded border border-gray-200 px-1.5 py-0.5">
              {[10, 25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            entries
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={exportCsv}>📄 Export to CSV</Button>
            <Button variant="secondary" size="sm" onClick={printReport}>🖨 Print</Button>
            <Button variant="secondary" size="sm" onClick={printReport}>📕 Export to PDF</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Quantity change</th>
                <th className="px-4 py-3">New Quantity</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Reference No</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleMovements.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No movements yet.</td></tr>
              ) : visibleMovements.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-emerald-700 font-medium">{m.type}</td>
                  <td className="px-4 py-2 tabular-nums">{Number(m.qty_change) >= 0 ? `+${Number(m.qty_change).toFixed(2)}` : Number(m.qty_change).toFixed(2)}</td>
                  <td className="px-4 py-2 tabular-nums">{Number(m.new_quantity).toFixed(2)}</td>
                  <td className="px-4 py-2 text-gray-700">{fmtDT(m.date)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-700">{m.reference_no || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="secondary" onClick={() => navigate('/products')}>← Back to Products</Button>
      </div>
    </div>
  )
}

function KpiBlock({ title, rows }) {
  return (
    <div>
      <div className="text-sm font-semibold text-gray-900 mb-2">{title}</div>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-gray-600">{k}</dt>
            <dd className="font-medium text-navy-800 tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
