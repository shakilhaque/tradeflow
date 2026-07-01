import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import { getLocations } from '../../api/inventory'
import { getProducts } from '../../api/products'
import { createStockTransfer } from '../../api/inventory'
import OutOfStockModal from '../../components/OutOfStockModal'

const fmtMoney = (n) => `৳ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const STATUS_OPTIONS = [
  { value: 'pending',    label: 'Pending' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'completed',  label: 'Completed' },
  { value: 'cancelled',  label: 'Cancelled' },
]

const todayIso = () => new Date().toISOString().slice(0, 10)

export default function AddStockTransferPage() {
  const navigate = useNavigate()

  // Header
  const [transferDate, setTransferDate] = useState(todayIso())
  const [referenceNo,  setReferenceNo]  = useState('')
  const [status,       setStatus]       = useState('completed')
  const [fromId,       setFromId]       = useState('')
  const [toId,         setToId]         = useState('')

  // Items
  const [items, setItems] = useState([])

  // Footer
  const [shipping, setShipping] = useState('0')
  const [notes,    setNotes]    = useState('')

  // Master data
  const [locations, setLocations] = useState([])

  // Product search
  const [search,        setSearch]        = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [showResults,   setShowResults]   = useState(false)
  const [searching,     setSearching]     = useState(false)
  const searchBoxRef = useRef(null)

  // Submit state
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  // Out-of-stock pop-up payload — { message, shortfalls } | null.
  const [stockAlert, setStockAlert] = useState(null)

  // Load locations
  useEffect(() => {
    (async () => {
      try {
        const locs = await getLocations({ active_only: 'true' })
        const locArr = Array.isArray(locs) ? locs : (locs?.results ?? [])
        setLocations(locArr)
        // Single-branch (free tier) → pre-fill the "From" location with the
        // only branch (a transfer still needs a distinct "To").
        if (locArr.length === 1) setFromId((v) => v || String(locArr[0].id))
      } catch { /* ignore */ }
    })()
  }, [])

  // Debounced product search
  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]); setShowResults(false); return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await getProducts({ search: search.trim(), limit: 10 })
        const list = Array.isArray(res) ? res : (res?.results ?? [])
        setSearchResults(list)
        setShowResults(true)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  // Click-outside hides dropdown
  useEffect(() => {
    const handler = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setShowResults(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addItem = (p) => {
    // Out-of-stock hard stop — a product with nothing on hand can't
    // be transferred; the operator gets the same pop-up the sales
    // pages show. The server re-checks against the SOURCE location
    // at save time (this snapshot is the product's overall stock),
    // so this is the early warning and the 409 below is the
    // authoritative guard.
    const onHand = Number(p.total_stock ?? p.stock ?? p.on_hand ?? 0)
    const tracksStock = (p.manage_stock ?? p.meta?.manage_stock ?? true) !== false && p.product_type !== 'service'
    if (tracksStock && onHand <= 0) {
      setStockAlert({
        message: `"${p.name}" is out of stock (0 available) — there is nothing to transfer. Restock it first.`,
        shortfalls: [{ product_name: p.name, requested: 1, available: onHand, shortfall: 1 }],
      })
      setSearch(''); setSearchResults([]); setShowResults(false)
      return
    }
    setItems((prev) => {
      const existing = prev.find((it) => it.product_id === p.id)
      if (existing) {
        return prev.map((it) =>
          it.product_id === p.id ? { ...it, quantity: Number(it.quantity) + 1 } : it
        )
      }
      const unitCost = Number(p.cost_price ?? p.purchase_price ?? p.price ?? 0)
      return [...prev, {
        product_id: p.id,
        name:       p.name,
        sku:        p.sku || '',
        quantity:   1,
        unit_cost:  unitCost,
      }]
    })
    setSearch('')
    setSearchResults([])
    setShowResults(false)
  }

  const updateItem = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  }
  const removeItem = (idx) => setItems((prev) => prev.filter((_, i) => i !== idx))

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0), 0),
    [items],
  )
  const grandTotal = subtotal + (Number(shipping) || 0)

  const handleSave = async () => {
    setError('')
    if (!fromId || !toId) {
      setError('Please select both source and destination locations.'); return
    }
    if (fromId === toId) {
      setError('Source and destination locations must differ.'); return
    }
    if (!items.length) {
      setError('Add at least one product to transfer.'); return
    }
    for (const it of items) {
      if (!Number(it.quantity) || Number(it.quantity) <= 0) {
        setError(`Quantity must be greater than zero for "${it.name}".`); return
      }
    }

    const payload = {
      transfer_date:    transferDate,
      from_location_id: fromId,
      to_location_id:   toId,
      status,
      shipping_charges: Number(shipping) || 0,
      notes:            notes.trim(),
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity:   Number(it.quantity),
        unit_cost:  Number(it.unit_cost) || 0,
      })),
    }
    if (referenceNo.trim()) {
      // Backend auto-generates ref; only some installs honor a custom one.
      payload.reference_no = referenceNo.trim()
    }

    setSaving(true)
    try {
      await createStockTransfer(payload)
      navigate('/inventory/stock-transfers', { replace: true })
    } catch (err) {
      // The standard envelope nests the flags under payload.data;
      // older builds had them at the top level — accept both.
      const pd = err?.payload?.data || err?.payload || {}
      if (err?.status === 409 && pd.out_of_stock) {
        // Server stock guard — the source location can't cover one
        // or more lines. Pop the modal with the per-product table.
        setStockAlert({
          message: err.message || 'Not enough stock at the source location.',
          shortfalls: pd.shortfalls || [],
        })
      } else {
        setError(err?.message || 'Failed to save stock transfer.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5 pb-28">
      <div className="rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-green-600 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Add Stock Transfer</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Move inventory between business locations.
        </p>
      </div>

      {/* ── Header card ──────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center gap-3 mb-5">
          <span className="h-7 w-1 rounded bg-gradient-to-b from-indigo-500 to-violet-500" />
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Transfer Information</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Input
            label="Date *"
            type="date"
            value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)}
          />
          <Input
            label="Reference No"
            placeholder="Auto-generated if left blank"
            value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
          />
          <Select
            label="Status *"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
          <Select
            label="Location (From) *"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
          >
            <option value="">Please select</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id} disabled={l.id === toId}>{l.name}</option>
            ))}
          </Select>
          <Select
            label="Location (To) *"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
          >
            <option value="">Please select</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id} disabled={l.id === fromId}>{l.name}</option>
            ))}
          </Select>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          When the status is <span className="font-medium text-gray-700">Completed</span>,
          stock is moved immediately. For Pending or In Transit, items are recorded but
          stock is not adjusted until you mark the transfer Completed.
        </p>
      </Card>

      {/* ── Items card ───────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center gap-3 mb-5">
          <span className="h-7 w-1 rounded bg-gradient-to-b from-indigo-500 to-violet-500" />
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Search Products</h2>
        </div>

        {/* Search box */}
        <div ref={searchBoxRef} className="relative">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-indigo-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-100">
            <svg className="h-4 w-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3zM4.5 9a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, SKU, or barcode…"
              className="flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
            />
            {searching && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            )}
          </div>

          {showResults && searchResults.length > 0 && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-lg max-h-72 overflow-auto">
              {searchResults.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addItem(p)}
                  className="w-full text-left px-4 py-2.5 hover:bg-indigo-50 border-b border-gray-50 last:border-0"
                >
                  <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                  <div className="text-xs text-gray-500">
                    {p.sku || '—'}{p.barcode ? ` · ${p.barcode}` : ''}
                    {p.cost_price ? ` · ${fmtMoney(p.cost_price)}` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
          {showResults && !searching && searchResults.length === 0 && search.trim() && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-lg px-4 py-3 text-sm text-gray-500">
              No matching products.
            </div>
          )}
        </div>

        {/* Items table */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 w-32">Quantity</th>
                <th className="px-4 py-3 w-40">Unit Price</th>
                <th className="px-4 py-3 text-right w-32">Subtotal</th>
                <th className="px-4 py-3 w-12 text-center">
                  <svg className="h-4 w-4 inline text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8h10v9a3 3 0 01-3 3H8a3 3 0 01-3-3V8z" clipRule="evenodd" />
                  </svg>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-gray-400">
                    No products added yet. Use the search above.
                  </td>
                </tr>
              ) : (
                items.map((it, idx) => {
                  const lineTotal = (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0)
                  return (
                    <tr key={`${it.product_id}-${idx}`} className="hover:bg-gray-50/60">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{it.name}</div>
                        {it.sku && <div className="text-xs text-gray-500 font-mono">{it.sku}</div>}
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={it.quantity}
                          onChange={(e) => updateItem(idx, { quantity: e.target.value })}
                          className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={it.unit_cost}
                          onChange={(e) => updateItem(idx, { unit_cost: e.target.value })}
                          className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                        />
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{fmtMoney(lineTotal)}</td>
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-rose-500 hover:bg-rose-50"
                          title="Remove"
                        >
                          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 011 1v7a1 1 0 102 0V9a1 1 0 112 0v7a1 1 0 102 0V9a1 1 0 112 0v7a3 3 0 01-3 3H8a3 3 0 01-3-3V9a1 1 0 011-1z" clipRule="evenodd" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {items.length > 0 && (
              <tfoot>
                <tr className="bg-gray-50 text-sm font-semibold text-gray-800 border-t border-gray-200">
                  <td className="px-4 py-3 text-right" colSpan={3}>Items subtotal:</td>
                  <td className="px-4 py-3 text-right">{fmtMoney(subtotal)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {/* ── Shipping / Notes card ────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center gap-3 mb-5">
          <span className="h-7 w-1 rounded bg-gradient-to-b from-indigo-500 to-violet-500" />
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Shipping &amp; Notes</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Input
            label="Shipping Charges"
            type="number"
            min="0"
            step="0.01"
            value={shipping}
            onChange={(e) => setShipping(e.target.value)}
          />
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Additional Notes</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any handling instructions, courier ref, etc."
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        </div>
      </Card>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── Sticky bottom action bar ─────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-[var(--sidebar-w,256px)] z-30 border-t border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
        <div className="mx-auto flex max-w-[100rem] items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-6 text-sm">
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Items</p>
              <p className="font-semibold text-gray-900">{items.length}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Subtotal</p>
              <p className="font-semibold text-gray-900">{fmtMoney(subtotal)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-gray-500">Shipping</p>
              <p className="font-semibold text-gray-900">{fmtMoney(shipping)}</p>
            </div>
            <div className="border-l border-gray-200 pl-6">
              <p className="text-xs uppercase tracking-wider text-gray-500">Total Amount</p>
              <p className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                {fmtMoney(grandTotal)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/inventory/stock-transfers')}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving} disabled={saving || !items.length}>
              {saving ? 'Saving…' : 'Save Transfer'}
            </Button>
          </div>
        </div>
      </div>

      {/* Out-of-stock pop-up — fires on add of a 0-stock product and
          on the server's 409 source-location stock guard at save. */}
      <OutOfStockModal data={stockAlert} onClose={() => setStockAlert(null)} />
    </div>
  )
}
