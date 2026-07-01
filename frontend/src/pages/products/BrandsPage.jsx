import { useCallback, useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { getBrands, createBrand, updateBrand, deleteBrand } from '../../api/products'

const PAGE_SIZES = [10, 25, 50, 100]

export default function BrandsPage() {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [search,  setSearch]  = useState('')
  const [limit,   setLimit]   = useState(25)
  const [page,    setPage]    = useState(1)

  const [open,       setOpen]       = useState(false)
  const [editing,    setEditing]    = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await getBrands()
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
    } catch (err) {
      setError(err?.message || 'Failed to load brands.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      (r.name || '').toLowerCase().includes(q)
      || (r.note || r.description || '').toLowerCase().includes(q),
    )
  }, [rows, search])

  const total      = filtered.length
  const totalPages = Math.max(Math.ceil(total / limit), 1)
  const pageRows   = useMemo(() => filtered.slice((page - 1) * limit, page * limit), [filtered, page, limit])

  const openAdd = () => {
    setEditing(null); setOpen(true)
  }
  const openEdit = (row) => {
    setEditing(row); setOpen(true)
  }
  const onSaved = async () => {
    setOpen(false); setEditing(null)
    await load()
  }

  const handleDelete = async (row) => {
    if (!confirm(`Delete brand "${row.name}"? This cannot be undone.`)) return
    setDeletingId(row.id)
    try {
      await deleteBrand(row.id)
      await load()
    } catch (err) {
      alert(err?.message || 'Failed to delete brand.')
    } finally {
      setDeletingId(null)
    }
  }

  const exportCsv = () => {
    if (!filtered.length) return
    const head = ['Brand', 'Note']
    const lines = [head.join(',')].concat(filtered.map((r) => [
      (r.name || '').replace(/,/g, ' '),
      (r.note || r.description || '').replace(/[\r\n,]/g, ' '),
    ].join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `brands-${Date.now()}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Brands</h1>
        <p className="mt-0.5 text-sm text-gray-500">Manage your product brands.</p>
      </div>

      {/* Banner */}
      <div className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">All your brands</h3>
          <p className="text-xs text-white/85 mt-0.5">{total} brand{total === 1 ? '' : 's'}</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 shadow-soft transition"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          Add
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span>Show</span>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white"
            value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>entries</span>
          <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!filtered.length}>Export CSV</Button>
        </div>
        <SearchInput
          placeholder="Search brand / note…"
          value={search}
          onChange={(v) => { setSearch(v); setPage(1) }}
        />
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12">
            <EmptyState title="No brands yet" message='Click "Add" to register your first brand.' />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Brand</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pageRows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-brand-50 text-brand-700 text-xs font-bold">
                          {(r.name || '?').slice(0, 1).toUpperCase()}
                        </span>
                        <span className="font-medium text-navy-800">{r.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-md truncate" title={r.note || r.description}>
                      {r.note || r.description || '—'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => openEdit(r)}
                          className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-soft transition"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L4 13.172V16h2.828l7.379-7.379-2.828-2.828z" /></svg>
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(r)}
                          disabled={deletingId === r.id}
                          className="inline-flex items-center gap-1 rounded-md bg-rose-600 hover:bg-rose-700 px-2.5 py-1 text-xs font-medium text-white shadow-soft transition disabled:opacity-50"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 011 1v7a1 1 0 102 0V9a1 1 0 112 0v7a1 1 0 102 0V9a1 1 0 112 0v7a3 3 0 01-3 3H8a3 3 0 01-3-3V9a1 1 0 011-1z" clipRule="evenodd" /></svg>
                          {deletingId === r.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!loading && total > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            Showing <strong>{(page - 1) * limit + 1}</strong>–
            <strong>{Math.min(page * limit, total)}</strong> of <strong>{total}</strong>
          </span>
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(p - 1, 1))}>Previous</Button>
            <span className="px-3">{page} / {totalPages}</span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(p + 1, totalPages))}>Next</Button>
          </div>
        </div>
      )}

      {open && (
        <BrandModal
          editing={editing}
          onClose={() => { setOpen(false); setEditing(null) }}
          onSaved={onSaved}
        />
      )}
    </div>
  )
}

function BrandModal({ editing, onClose, onSaved }) {
  const [name,   setName]   = useState(editing?.name || '')
  const [note,   setNote]   = useState(editing?.note || editing?.description || '')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const save = async () => {
    setError('')
    if (!name.trim()) { setError('Brand name is required.'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description: note.trim(), note: note.trim() }
      if (editing) await updateBrand(editing.id, payload)
      else         await createBrand(payload)
      onSaved()
    } catch (err) {
      const f = err?.errors
      setError(
        f && typeof f === 'object'
          ? Object.entries(f).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')
          : (err?.message || 'Failed to save brand.'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit Brand' : 'Add Brand'} size="md">
      <div className="space-y-4">
        <Input
          label="Brand Name *"
          placeholder="e.g. DOMS, Fluro, PETRA"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Note</label>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional details about this brand"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </div>
        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">
            {error}
          </div>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
        <Button onClick={save} loading={saving}>Save</Button>
      </ModalFooter>
    </Modal>
  )
}
