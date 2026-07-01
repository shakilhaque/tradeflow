import { useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import SearchInput from '../../components/ui/SearchInput'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { getCompanyProfile } from '../../api/companyProfile'

/**
 * Reusable master-data CRUD page (Units / Categories / Warranties).
 *
 * Props:
 *   title         — page title shown in the header
 *   subtitle      — small text under title
 *   columns       — [{ key, label, render?(row), align? }]
 *   fetchAll      — () => Promise<row[]>
 *   create        — (payload) => Promise<row>
 *   update        — (id, payload) => Promise
 *   remove        — (id) => Promise
 *   demoRows      — fallback rows when API offline
 *   FormFields    — ({ form, setForm, errors }) => JSX
 *   blankForm     — initial form state
 *   normalize     — optional (row) => normalized fields for the table
 *   exportRow     — (row) => array of exported cell values matching columns order
 */
const PAGE_SIZES = [10, 25, 50, 100]

export default function MasterDataPage({
  title, subtitle, columns,
  fetchAll, create, update, remove,
  demoRows = [],
  FormFields, blankForm,
  normalize = (r) => r,
  exportRow,
}) {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')
  const [page, setPage]       = useState(1)
  const [limit, setLimit]     = useState(25)
  const [showCols, setShowCols]       = useState(false)
  const [visibleCols, setVisibleCols] = useState(() => columns.map((c) => c.key))

  const [open, setOpen]         = useState(false)
  const [editing, setEditing]   = useState(null)   // row being edited or null
  const [form, setForm]         = useState(blankForm)
  const [saving, setSaving]     = useState(false)
  const [confirm, setConfirm]   = useState(null)   // row to delete

  const reload = async () => {
    setLoading(true); setError('')
    try {
      const data = await fetchAll()
      const arr  = Array.isArray(data) ? data : (data?.results ?? [])
      setRows(arr.map(normalize))
    } catch (e) {
      setRows(demoRows.map(normalize))
      setError(`${e?.message || 'Failed to load'} — showing demo data.`)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { reload() }, [])  // eslint-disable-line

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(q)))
  }, [rows, search, columns])

  const totalPages = Math.max(Math.ceil(filtered.length / limit), 1)
  const pageStart  = (page - 1) * limit
  const visible    = filtered.slice(pageStart, pageStart + limit)

  const openAdd  = () => { setEditing(null); setForm(blankForm); setOpen(true) }
  const openEdit = (row) => { setEditing(row); setForm({ ...blankForm, ...row }); setOpen(true) }

  // Pull the most specific server message out of a DRF error and show
  // it as a popup AND in the inline banner. DRF sends {detail: "..."}
  // for our friendly 400s.
  // Surface server errors as ONE clean popup line. The backend wraps
  // responses in {status, data, message, errors}; we use `message`
  // directly and only append per-field validation entries from
  // `errors` when they exist. Previous version re-printed the same
  // text twice as "• message: ..." + "• errors: null".
  const showErr = (e, fallback) => {
    const payload = e?.payload || {}
    let msg = e?.message || payload?.message || payload?.detail || fallback

    // Append per-field validation errors only when `errors` is a
    // non-empty object/array.
    const errs = e?.errors ?? payload?.errors
    if (errs && typeof errs === 'object' && !Array.isArray(errs) && Object.keys(errs).length > 0) {
      const parts = []
      for (const [k, v] of Object.entries(errs)) {
        if (v == null || v === '') continue
        parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      }
      if (parts.length) msg = `${msg}\n\n• ${parts.join('\n• ')}`
    } else if (Array.isArray(errs) && errs.length > 0) {
      msg = `${msg}\n\n• ${errs.join('\n• ')}`
    }

    setError(typeof msg === 'string' ? msg.split('\n')[0] : fallback)
    window.alert(msg)
  }

  const handleSave = async () => {
    setSaving(true); setError('')
    try {
      if (editing) await update(editing.id, form)
      else         await create(form)
      setOpen(false); setEditing(null); setForm(blankForm)
      reload()
    } catch (e) {
      showErr(e, 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm) return
    try { await remove(confirm.id); setConfirm(null); reload() }
    catch (e) { setConfirm(null); showErr(e, 'Failed to delete.') }
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  const cellsForExport = (r) =>
    exportRow ? exportRow(r) : columns.filter((c) => visibleCols.includes(c.key)).map((c) => r[c.key] ?? '')

  const exportCsv = () => {
    const cols = columns.filter((c) => visibleCols.includes(c.key))
    const head = cols.map((c) => `"${c.label}"`).join(',')
    const body = filtered.map((r) => cellsForExport(r).map((v) =>
      typeof v === 'number' ? v : `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    download(`${head}\n${body}\n`, `${slug(title)}.csv`, 'text/csv')
  }
  const exportXls = () => {
    const cols = columns.filter((c) => visibleCols.includes(c.key))
    const head = cols.map((c) => c.label).join('\t')
    const body = filtered.map((r) => cellsForExport(r).join('\t')).join('\n')
    download(`${head}\n${body}\n`, `${slug(title)}.xls`, 'application/vnd.ms-excel')
  }
  // Clean table document (company header + green table), matching the
  // Sale Returns / Customers print — instead of printing the whole app page.
  const buildPrintDoc = (company = {}) => {
    const cols = columns.filter((c) => visibleCols.includes(c.key))
    const bodyRows = filtered.map((r, i) =>
      `<tr><td>${i + 1}</td>${cellsForExport(r).map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`
    ).join('') || `<tr><td colspan="${cols.length + 1}" class="empty">No ${title.toLowerCase()}.</td></tr>`
    return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)} — ${escapeHtml(company.business_name || '')}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:0;padding:10mm 8mm;font-size:11px}
  .row{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:8px;margin-bottom:10px}
  .title{font-size:20px;font-weight:700;color:#10b981;letter-spacing:.5px;margin:0}
  .sub{color:#6b7280;font-size:10px}
  .block{font-size:10px;line-height:1.45}
  table{width:100%;border-collapse:collapse;font-size:10px}
  th{background:#10b981;color:#fff;font-weight:600;text-align:left;padding:6px 7px;border:1px solid #0f9971;white-space:nowrap}
  td{padding:6px 7px;border:1px solid #e5e7eb;vertical-align:top}
  .empty{text-align:center;color:#9ca3af;padding:18px}
  .footer{margin-top:14px;display:flex;justify-content:space-between;font-size:9px;color:#6b7280}
  @page{size:A4;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">${escapeHtml(title)}</h1>
    <div class="block" style="margin-top:4px">
      <b>${escapeHtml(company.business_name || '')}</b><br>
      ${escapeHtml(company.address || '')}<br>
      ${company.phone ? 'Phone: ' + escapeHtml(company.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${escapeHtml(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">${filtered.length} record${filtered.length === 1 ? '' : 's'}</div>
  </div>
</div>
<table>
  <thead><tr><th>#</th>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${bodyRows}</tbody>
</table>
<div class="footer"><div>${escapeHtml(subtitle || '')}</div><div>Powered by Iffaa</div></div>
<script>window.onload=()=>setTimeout(()=>window.print(),200)</script>
</body></html>`
  }

  const handlePrint = async () => {
    const win = window.open('', '_blank', 'width=1100,height=800')
    if (!win) { window.alert('Allow popups to print this report.'); return }
    const company = await getCompanyProfile().catch(() => ({}))
    win.document.write(buildPrintDoc(company || {}))
    win.document.close()
  }
  const exportPdf = handlePrint

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 px-6 py-5 text-white shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="mt-0.5 text-sm text-emerald-50">{subtitle}</p>
          </div>
          <Button variant="secondary" onClick={openAdd}>+ Add</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <span>Show</span>
          <select value={limit} onChange={(e) => { setPage(1); setLimit(Number(e.target.value)) }}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>entries</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={exportCsv}>📄 Export CSV</Button>
          <Button variant="secondary" size="sm" onClick={exportXls}>📊 Export Excel</Button>
          <Button variant="secondary" size="sm" onClick={handlePrint}>🖨 Print</Button>
          <Button variant="secondary" size="sm" onClick={exportPdf}>📕 Export PDF</Button>
          <SearchInput value={search} onChange={setSearch} placeholder="Search…" />
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setShowCols((p) => !p)}>Column visibility ▾</Button>
            {showCols && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 py-1 text-xs text-slate-700">
                    <input type="checkbox" checked={visibleCols.includes(c.key)}
                           onChange={() => setVisibleCols((prev) =>
                             prev.includes(c.key) ? prev.filter((k) => k !== c.key) : [...prev, c.key])} />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState title="No data available in table"
                      message={search ? 'Try a different search term.' : `Click "+ Add" to create your first ${title.toLowerCase()}.`} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {/* Action column is LEFTMOST per spec across the app. */}
                  <th className="px-4 py-3">Action</th>
                  {columns.filter((c) => visibleCols.includes(c.key)).map((c) => (
                    <th key={c.key} className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button onClick={() => openEdit(r)}
                              className="mr-2 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
                        ✎ Edit
                      </button>
                      <button onClick={() => setConfirm(r)}
                              className="rounded-md bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">
                        🗑 Delete
                      </button>
                    </td>
                    {columns.filter((c) => visibleCols.includes(c.key)).map((c) => (
                      <td key={c.key} className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : ''} text-slate-700`}>
                        {c.render ? c.render(r) : (r[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
          <div className="text-xs text-slate-500">
            Showing {Math.min(pageStart + 1, filtered.length)} to {Math.min(pageStart + limit, filtered.length)} of {filtered.length} entries
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white">{page}</span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
          </div>
        </div>
      </Card>

      {/* Add / Edit modal */}
      <Modal open={open} onClose={() => setOpen(false)}
             title={editing ? `Edit ${title.replace(/s$/, '')}` : `Add ${title.replace(/s$/, '')}`}
             size="lg">
        <FormFields form={form} setForm={setForm} />
        <ModalFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={saving} onClick={handleSave}>{editing ? 'Update' : 'Save'}</Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Confirm delete" size="sm">
        <p className="text-sm text-slate-700">
          Delete <span className="font-semibold">{confirm?.name}</span>? This action cannot be undone.
        </p>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={handleDelete} className="!bg-rose-600 hover:!bg-rose-700">Delete</Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────
function slug(s) { return String(s).toLowerCase().replace(/\s+/g, '-') }
function escapeHtml(v) {
  if (v == null) return ''
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export { Badge }
