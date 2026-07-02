import { useCallback, useEffect, useMemo, useState } from 'react'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import SearchInput from '../../components/ui/SearchInput'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
} from '../../api/accounting'

export default function ExpenseCategoriesPage() {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [search,  setSearch]  = useState('')

  // Modal state
  const [open,    setOpen]    = useState(false)
  const [editing, setEditing] = useState(null)
  const [form,    setForm]    = useState({ name: '', code: '', is_subcategory: false, parent: '' })
  const [formErr, setFormErr] = useState('')
  const [saving,  setSaving]  = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await getExpenseCategories()
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
    } catch (err) {
      setError(err?.message || 'Failed to load expense categories.')
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
      || (r.code || '').toLowerCase().includes(q)
      || (r.parent_name || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  // Only top-level categories are eligible parents (one level deep allowed).
  const parentOptions = useMemo(
    () => rows.filter((r) => !r.parent && (!editing || r.id !== editing.id)),
    [rows, editing],
  )

  const openAdd = () => {
    setEditing(null)
    setForm({ name: '', code: '', is_subcategory: false, parent: '' })
    setFormErr('')
    setOpen(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      name:           row.name || '',
      code:           row.code || '',
      is_subcategory: Boolean(row.parent),
      parent:         row.parent || '',
    })
    setFormErr('')
    setOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setOpen(false)
    setEditing(null)
  }

  const handleSave = async () => {
    setFormErr('')
    if (!form.name.trim()) {
      setFormErr('Category name is required.'); return
    }
    if (form.is_subcategory && !form.parent) {
      setFormErr('Pick a parent when "Add as sub-category" is checked.'); return
    }
    const payload = {
      name:   form.name.trim(),
      code:   form.code.trim(),
      parent: form.is_subcategory ? form.parent : null,
    }
    setSaving(true)
    try {
      if (editing) {
        await updateExpenseCategory(editing.id, payload)
      } else {
        await createExpenseCategory(payload)
      }
      await load()
      setOpen(false)
      setEditing(null)
    } catch (err) {
      // Try to surface the field error from DRF.
      const fieldErrs = err?.errors
      if (fieldErrs && typeof fieldErrs === 'object') {
        const msg = Object.entries(fieldErrs)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join(' | ')
        setFormErr(msg)
      } else {
        setFormErr(err?.message || 'Failed to save category.')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (row) => {
    if (!confirm(`Delete "${row.name}"? This cannot be undone.`)) return
    setDeletingId(row.id)
    try {
      await deleteExpenseCategory(row.id)
      await load()
    } catch (err) {
      alert(err?.message || 'Failed to delete category.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Expense Categories</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Group operational expenses. Sub-categories can be nested one level deep.
        </p>
      </div>

      {/* Banner */}
      <div className="rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-500 px-5 py-3.5 text-white shadow flex items-center justify-between">
        <h3 className="text-base font-semibold">All Expense Categories</h3>
        <span className="text-sm">{filtered.length} item{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchInput
          placeholder="Search by name or code..."
          value={search}
          onChange={(v) => setSearch(v)}
        />
        <Button onClick={openAdd}>
          <span className="mr-1">+</span> Add Category
        </Button>
      </div>

      <Card padding="p-0">
        {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">{error}</div>}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12">
            <EmptyState title="No expense categories" message="Add your first category to start grouping expenses." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Category Name</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Parent</th>
                  <th className="px-4 py-3 text-center">Sub-categories</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(r)}
                          className="inline-flex items-center gap-1 rounded-md bg-brand-600 hover:bg-brand-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L4 13.172V16h2.828l7.379-7.379-2.828-2.828z" /></svg>
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(r)}
                          disabled={deletingId === r.id}
                          className="inline-flex items-center gap-1 rounded-md bg-rose-600 hover:bg-rose-700 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition disabled:opacity-50"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2h12a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM5 8a1 1 0 011 1v7a1 1 0 102 0V9a1 1 0 112 0v7a1 1 0 102 0V9a1 1 0 112 0v7a3 3 0 01-3 3H8a3 3 0 01-3-3V9a1 1 0 011-1z" clipRule="evenodd" /></svg>
                          {deletingId === r.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {r.parent && <span className="text-gray-300">└</span>}
                        <span className={`${r.parent ? '' : 'font-semibold'} text-gray-900`}>
                          {r.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{r.code || '—'}</td>
                    <td className="px-4 py-3 text-gray-700">{r.parent_name || '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-700">{r.children_count || 0}</td>
                    <td className="px-4 py-3">
                      <span className={[
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                        r.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500',
                      ].join(' ')}>
                        <span className={`h-1.5 w-1.5 rounded-full ${r.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                        {r.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add / Edit modal */}
      <Modal
        open={open}
        onClose={closeModal}
        title={editing ? 'Edit Expense Category' : 'Add Expense Category'}
        size="md"
      >
        <div className="space-y-4">
          <Input
            label="Category name *"
            placeholder="Category name"
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          />
          <Input
            label="Category code"
            placeholder="Optional short code"
            value={form.code}
            onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
          />

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.is_subcategory}
              onChange={(e) => setForm((p) => ({
                ...p,
                is_subcategory: e.target.checked,
                parent: e.target.checked ? p.parent : '',
              }))}
              className="h-4 w-4 rounded border-gray-300 text-amber-500 focus:ring-amber-200"
            />
            Add as sub-category
          </label>

          {form.is_subcategory && (
            <Select
              label="Parent category *"
              value={form.parent}
              onChange={(e) => setForm((p) => ({ ...p, parent: e.target.value }))}
            >
              <option value="">Please select a parent</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          )}

          {formErr && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {formErr}
            </div>
          )}
        </div>

        <ModalFooter>
          <Button variant="secondary" onClick={closeModal} disabled={saving}>Close</Button>
          <Button onClick={handleSave} loading={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}
