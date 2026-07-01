import { useRef, useState } from 'react'
import Modal, { ModalFooter } from '../ui/Modal'
import Button from '../ui/Button'
import { updateSaleShipping } from '../../api/sales'
import { uploadProductImage } from '../../api/products'

/**
 * EditShippingModal — shared "Edit Shipping" dialog used by both the
 * Shipments page and the All Sales action menu. Saves via the dedicated
 * shipping endpoint (works on FINAL sales) and stays on the calling page.
 *
 * Fields: Shipping Details / Address / Status / Delivered To / Charges /
 * Note, plus a Shipping Documents uploader and a read-only Activities log
 * (both persisted in Sale.meta and shown here + on the Shipments page).
 */
const normDocs = (raw) =>
  (Array.isArray(raw) ? raw : []).map((d) =>
    typeof d === 'string' ? { name: d, url: d } : { name: d?.name || d?.url || 'Document', url: d?.url || '' },
  )

const fmtDateTime = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function EditShippingModal({ sale, onClose, onSaved }) {
  const meta = sale.meta || {}
  const [form, setForm] = useState({
    shipping_details:  meta.shipping_details || sale.shipping_details || '',
    shipping_address:  sale.shipping_address || meta.shipping_address || '',
    shipping_status:   sale.shipping_status  || meta.shipping_status || 'Ordered',
    delivered_to:      sale.delivered_to     || meta.delivered_to    || '',
    shipping_charges:  sale.shipping_charges ?? meta.shipping_charges ?? '',
    shipping_note:     meta.shipping_note    || '',
  })
  const set = (k) => (e) => setForm({ ...form, [k]: e.target?.value ?? e })

  const [docs, setDocs]     = useState(normDocs(meta.shipping_documents))
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')
  const fileRef = useRef(null)

  // Activities are read-only — the backend appends one row per save.
  const activities = [...(Array.isArray(meta.shipping_activities) ? meta.shipping_activities : [])].reverse()

  const onFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setErr(''); setUploading(true)
    try {
      const uploaded = []
      for (const f of files) {
        const res = await uploadProductImage(f)
        if (res?.url) uploaded.push({ name: f.name, url: res.url })
      }
      setDocs((d) => [...d, ...uploaded])
    } catch (e) {
      setErr(e?.message || 'Failed to upload document.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const removeDoc = (i) => setDocs((d) => d.filter((_, idx) => idx !== i))

  const submit = async () => {
    setErr('')
    if (!form.shipping_details.trim()) { setErr('Shipping Details is required.'); return }
    setSaving(true)
    try {
      await updateSaleShipping(sale.id, {
        shipping_details:   form.shipping_details,
        shipping_address:   form.shipping_address,
        shipping_status:    form.shipping_status,
        delivered_to:       form.delivered_to,
        shipping_charges:   Number(form.shipping_charges) || 0,
        shipping_note:      form.shipping_note,
        shipping_documents: docs,
      })
      onSaved?.()
    } catch (e) {
      const msg = e?.errors?.detail || e?.payload?.detail || e?.message || 'Failed to update shipping.'
      setErr(msg)
      window.alert(msg)
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1'
  const ipt = 'h-9 w-full rounded-md border border-gray-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100'

  const invNo = sale.invoice_number || sale.invoice_no || String(sale.id).slice(0, 8)

  return (
    <Modal open onClose={onClose} title={`Edit Shipping — ${invNo}`} size="2xl">
      <div className="space-y-3">
        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Shipping Details: <span className="text-rose-500">*</span></label>
            <textarea rows={3} value={form.shipping_details} onChange={set('shipping_details')} className={`${ipt} h-auto py-2`} />
          </div>
          <div>
            <label className={lbl}>Shipping Address:</label>
            <textarea rows={3} value={form.shipping_address} onChange={set('shipping_address')} className={`${ipt} h-auto py-2`} />
          </div>
          <div>
            <label className={lbl}>Shipping Status:</label>
            <select value={form.shipping_status} onChange={set('shipping_status')} className={ipt}>
              <option value="">Please Select</option>
              <option>Ordered</option>
              <option>Packed</option>
              <option>Shipped</option>
              <option>Delivered</option>
              <option>Cancelled</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Delivered To:</label>
            <input value={form.delivered_to} onChange={set('delivered_to')} className={ipt} />
          </div>
          <div>
            <label className={lbl}>Shipping Charges:</label>
            <input type="number" min="0" value={form.shipping_charges} onChange={set('shipping_charges')} className={ipt} />
          </div>
        </div>

        <div>
          <label className={lbl}>Shipping note:</label>
          <textarea rows={2} value={form.shipping_note} onChange={set('shipping_note')} placeholder="Shipping note" className={`${ipt} h-auto py-2`} />
        </div>

        {/* Shipping Documents */}
        <div>
          <label className={lbl}>Shipping Documents:</label>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-24 w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-gray-300 bg-gray-50/60 text-sm text-gray-500 hover:border-brand-400 hover:bg-brand-50/40"
          >
            {uploading ? 'Uploading…' : 'Drop files here to upload'}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          {docs.length === 0 ? (
            <p className="mt-2 text-center text-xs text-gray-400">No attachment found</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-100">
              {docs.map((d, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                  <a href={d.url} target="_blank" rel="noreferrer" className="truncate text-brand-600 hover:underline">{d.name}</a>
                  <button type="button" onClick={() => removeDoc(i)} className="shrink-0 text-rose-500 hover:text-rose-700">Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Activities */}
        <div>
          <label className={lbl}>Activities:</label>
          <div className="overflow-x-auto rounded-md border border-gray-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {activities.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">No records found</td></tr>
                ) : activities.map((a, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-gray-600">{fmtDateTime(a.date)}</td>
                    <td className="px-3 py-1.5 text-gray-800">{a.action || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600">{a.by || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600">{a.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} loading={saving}>Update</Button>
      </ModalFooter>
    </Modal>
  )
}
