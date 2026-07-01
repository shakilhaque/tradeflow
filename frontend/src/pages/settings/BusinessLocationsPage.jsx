import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import SearchInput from '../../components/ui/SearchInput'
import Badge from '../../components/ui/Badge'
import EmptyState from '../../components/ui/EmptyState'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getLocations, createLocation, updateLocation, deleteLocation, getLocationLimits,
} from '../../api/inventory'

const inputCls =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'

const blankForm = { name: '', code: '', address: '', is_active: true }

export default function BusinessLocationsPage() {
  const [rows, setRows]       = useState([])
  const [limits, setLimits]   = useState(null)        // { limit, current, can_add, multi_branch_enabled, plan_name }
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')

  const [open, setOpen]       = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm]       = useState(blankForm)
  const [saving, setSaving]   = useState(false)
  const [confirm, setConfirm] = useState(null)

  const reload = async () => {
    setLoading(true); setError('')
    try {
      const [list, lim] = await Promise.all([
        getLocations(),
        getLocationLimits().catch(() => null),
      ])
      const arr = Array.isArray(list) ? list : (list?.results ?? [])
      setRows(arr)
      if (lim) setLimits(lim)
    } catch (e) {
      setError(e?.message || 'Failed to load locations.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { reload() }, [])

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter((r) =>
      [r.name, r.code, r.address].some((v) => String(v ?? '').toLowerCase().includes(q)))
  }, [rows, search])

  // ── Plan gating ────────────────────────────────────────────────────────────
  const planLimit       = limits?.limit ?? 1            // 0 = unlimited
  const isUnlimited     = planLimit === 0
  const activeUsed      = rows.filter((r) => r.is_active).length
  const remaining       = isUnlimited ? null : Math.max(0, planLimit - activeUsed)
  const canAdd          = isUnlimited || activeUsed < planLimit
  const multiBranch     = limits?.multi_branch_enabled ?? (planLimit > 1)

  const openAdd = () => {
    if (!canAdd) return
    setEditing(null); setForm(blankForm); setOpen(true)
  }
  const openEdit = (row) => {
    setEditing(row); setForm({ ...blankForm, ...row }); setOpen(true)
  }

  const handleSave = async () => {
    setSaving(true); setError('')
    try {
      if (editing) await updateLocation(editing.id, form)
      else         await createLocation(form)
      setOpen(false); setEditing(null); setForm(blankForm)
      reload()
    } catch (e) {
      const data = e?.data || e?.response?.data
      if (data?.code === 'BRANCH_LIMIT' || data?.detail?.code === 'BRANCH_LIMIT') {
        const d = data.detail || data
        setError(d.detail || 'Branch limit reached. Upgrade your plan to add more.')
      } else {
        setError(e?.message || 'Failed to save.')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm) return
    try {
      const res = await deleteLocation(confirm.id)
      // Backend may return a 200 with `{soft_deleted: true, detail}` when
      // the branch had historical records (invoices/purchases/stock) and
      // it couldn't be hard-deleted. Treat that as a successful close
      // and surface the friendly explanation.
      setConfirm(null)
      if (res && res.soft_deleted) {
        setError('')
        alert(res.detail || 'Branch deactivated (historical records preserved).')
      }
      reload()
    } catch (e) {
      setError(e?.message || 'Failed to delete.')
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="rounded-2xl bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 px-6 py-5 text-white shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Business Locations</h1>
            <p className="mt-0.5 text-sm text-emerald-50">
              Manage branches, outlets and warehouses
            </p>
          </div>
          <div className="flex items-center gap-3">
            {limits && (
              <span className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium">
                {activeUsed} / {isUnlimited ? '∞' : planLimit} branches
                {limits.plan_name && <> · {limits.plan_name}</>}
              </span>
            )}
            <Button variant="secondary" onClick={openAdd} disabled={!canAdd}
                    title={canAdd ? '' : 'Branch limit reached — upgrade your plan'}>
              + Add Location
            </Button>
          </div>
        </div>
      </div>

      {/* Plan gate banner */}
      {limits && !multiBranch && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-center justify-between">
          <span>
            Your <strong>{limits.plan_name || 'current'}</strong> plan supports a single branch.
            Upgrade to manage multiple outlets and warehouses.
          </span>
          <Link to="/pricing/accounting" className="ml-4 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
            View plans →
          </Link>
        </div>
      )}

      {limits && multiBranch && !canAdd && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 flex items-center justify-between">
          <span>You've reached your plan's limit of {planLimit} active branches.</span>
          <Link to="/pricing/accounting" className="ml-4 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700">
            Upgrade →
          </Link>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <SearchInput value={search} onChange={setSearch} placeholder="Search branches…" />
        {!isUnlimited && (
          <span className="text-xs text-slate-500">
            {remaining} slot{remaining === 1 ? '' : 's'} remaining
          </span>
        )}
      </div>

      {/* Table */}
      <Card padding="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No branches yet"
                      message='Click "+ Add Location" to create your first branch.' />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Address</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-medium text-slate-800">{r.name}</td>
                    <td className="px-4 py-3 text-slate-700">{r.code}</td>
                    <td className="px-4 py-3 text-slate-600">{r.address || '—'}</td>
                    <td className="px-4 py-3">
                      {r.is_active
                        ? <Badge variant="green">Active</Badge>
                        : <Badge variant="gray">Inactive</Badge>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(r)}
                              className="mr-2 rounded-md bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100">
                        ✎ Edit
                      </button>
                      <button onClick={() => setConfirm(r)}
                              className="rounded-md bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100">
                        🗑 Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add / Edit modal */}
      <Modal open={open} onClose={() => setOpen(false)}
             title={editing ? 'Edit Location' : 'Add Location'} size="lg">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Name *</label>
            <input className={inputCls} value={form.name}
                   onChange={(e) => setForm({ ...form, name: e.target.value })}
                   placeholder="e.g. Mirpur Outlet" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Code *</label>
            <input className={inputCls} value={form.code}
                   onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                   placeholder="e.g. MRP" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Address</label>
            <textarea className={inputCls + ' min-h-[80px]'} value={form.address || ''}
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                      placeholder="Street, area, city" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={!!form.is_active}
                   onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Active
          </label>
        </div>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={saving} onClick={handleSave}>{editing ? 'Update' : 'Save'}</Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="Confirm delete" size="sm">
        <p className="text-sm text-slate-700">
          Delete <span className="font-semibold">{confirm?.name}</span>? This cannot be undone.
        </p>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={handleDelete} className="!bg-rose-600 hover:!bg-rose-700">Delete</Button>
        </ModalFooter>
      </Modal>
    </div>
  )
}
