/**
 * User Management → Roles
 *
 * Catalog of role labels for this tenant. Built-in roles (Admin /
 * Manager / Cashier) are shown read-only at the top; custom roles can
 * be added, edited and deleted. Matches the indigo "Manage" theme of
 * the Users page.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'

import { Link, useNavigate } from 'react-router-dom'

import Modal, { ModalFooter } from '../../components/ui/Modal'
import { getRoles, createRole, updateRole, deleteRole } from '../../api/roles'
import { useAuth } from '../../context/AuthContext'
import { useDefaultPageSize } from '../../context/SettingsContext'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function RolesPage() {
  const { user: me } = useAuth() || {}
  const navigate = useNavigate()
  const canManage = !!me && (me.role === 'owner' || me.role === 'admin')

  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const [search,  setSearch]  = useState('')
  const defaultPageSize = useDefaultPageSize(25)
  const [page,    setPage]    = useState(1)
  const [limit,   setLimit]   = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  const [editing,  setEditing]  = useState(null)   // null | 'new' | role obj
  const [deleting, setDeleting] = useState(null)

  const fetchData = async () => {
    setLoading(true); setError('')
    try {
      const res = await getRoles()
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
      setPage(1)
    } catch (err) {
      setError(err.message || 'Failed to load roles')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.name, r.description].some((v) => (v || '').toLowerCase().includes(q))
    )
  }, [rows, search])

  const count      = filtered.length
  const totalPages = Math.max(Math.ceil(count / limit), 1)
  const pageRows   = filtered.slice((page - 1) * limit, page * limit)

  const stats = useMemo(() => {
    let system = 0, custom = 0
    for (const r of rows) (r.is_system ? system : custom)
    for (const r of rows) { if (r.is_system) system++; else custom++ }
    return { total: rows.length, system, custom }
  }, [rows])

  return (
    <div className="space-y-5">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-sky-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Roles</h1>
          <p className="text-xs text-indigo-50 mt-0.5">
            Manage the catalog of role labels available when adding or
            editing a user. Built-in roles cannot be removed.
          </p>
        </div>
        {canManage && (
          <Link
            to="/roles/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
          >
            <PlusIcon /> Add Role
          </Link>
        )}
      </div>

      {!canManage && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You&rsquo;re viewing this page in read-only mode. Only Owner or
          Admin roles can add, edit or remove roles.
        </div>
      )}

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi label="Total roles"  value={stats.total}  accent="indigo" />
        <Kpi label="Built-in"     value={stats.system} accent="sky" />
        <Kpi label="Custom"       value={stats.custom} accent="emerald" />
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Table card ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-indigo-500 hover:text-indigo-700"
            >
              Refresh
            </button>
            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1) }}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} / page</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
            </div>
          ) : pageRows.length === 0 ? (
            <EmptyState onAdd={canManage ? () => navigate('/roles/new') : null} />
          ) : (
            <RolesTable
              rows={pageRows}
              canManage={canManage}
              onEdit={(r) => navigate(`/roles/${r.id}/edit`)}
              onDelete={(r) => setDeleting(r)}
            />
          )}
        </div>

        {!loading && pageRows.length > 0 && (
          <Pager
            page={page}
            totalPages={totalPages}
            count={count}
            limit={limit}
            onChange={setPage}
          />
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {editing && (
        <RoleModal
          open={Boolean(editing)}
          role={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchData() }}
        />
      )}
      {deleting && (
        <DeleteModal
          open={Boolean(deleting)}
          role={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); fetchData() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

function RolesTable({ rows, canManage, onEdit, onDelete }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">Role</th>
          <th className="px-5 py-3">Description</th>
          <th className="px-5 py-3 text-center">Permissions</th>
          <th className="px-5 py-3 text-center">Type</th>
          <th className="px-5 py-3">Created</th>
          <th className="px-5 py-3 text-right w-44">Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-indigo-50/40 transition-colors">
            <td className="px-5 py-3">
              <div className="flex items-center gap-3">
                <RoleAvatar name={r.name} system={r.is_system} />
                <div className="font-medium text-gray-900">{r.name}</div>
              </div>
            </td>
            <td className="px-5 py-3 text-xs text-gray-500 max-w-md truncate">{r.description || '—'}</td>
            <td className="px-5 py-3 text-center text-xs">
              {r.is_system ? (
                <span className="text-gray-400">—</span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-700">
                  {Array.isArray(r.permissions) ? r.permissions.length : 0}
                </span>
              )}
            </td>
            <td className="px-5 py-3 text-center">
              <span className={[
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                r.is_system ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700',
              ].join(' ')}>
                {r.is_system ? 'Built-in' : 'Custom'}
              </span>
            </td>
            <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
            <td className="px-5 py-3 text-right">
              {r.is_system ? (
                <span className="text-[11px] text-gray-400 italic">System role</span>
              ) : canManage ? (
                <div className="inline-flex items-center gap-1.5">
                  <button
                    onClick={() => onEdit(r)}
                    className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(r)}
                    className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <span className="text-[11px] text-gray-400">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RoleAvatar({ name, system }) {
  const initials = String(name || '?')
    .split(' ').slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('')
  const cls = system
    ? 'bg-gradient-to-br from-amber-100 to-orange-100 text-amber-700'
    : 'bg-gradient-to-br from-indigo-100 to-sky-100 text-indigo-700'
  return (
    <div className={`flex h-9 w-9 items-center justify-center rounded-lg text-xs font-semibold ${cls}`}>
      {initials}
    </div>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
        <ShieldIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No roles match your search.</p>
      {onAdd && (
        <button
          onClick={onAdd}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          <PlusIcon /> Add Role
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function RoleModal({ open, role, onClose, onSaved }) {
  const isEdit = Boolean(role)
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      reset(isEdit ? {
        name:        role.name || '',
        description: role.description || '',
      } : {
        name: '', description: '',
      })
      setError('')
    }
  }, [open, role, isEdit, reset])

  const onSubmit = async (data) => {
    setError('')
    try {
      if (isEdit) await updateRole(role.id, data)
      else        await createRole(data)
      onSaved?.()
    } catch (err) {
      setError(err.message || 'Failed to save role')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Role' : 'Add Role'} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <Field label="Role name" required error={errors.name?.message}>
          <input
            {...register('name', { required: 'Role name is required' })}
            placeholder="e.g. Sub Company, Stock Auditor"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </Field>
        <Field label="Description" hint="What can this role do? Helps your team pick the right one.">
          <textarea
            {...register('description')}
            rows={3}
            placeholder="Describe the scope of this role…"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </Field>
      </form>
      <ModalFooter>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {isEdit ? 'Save changes' : 'Create role'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function DeleteModal({ open, role, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteRole(role.id)
      onDeleted?.()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete Role" size="sm">
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <p className="text-sm text-gray-700">
          Delete <strong>{role?.name}</strong>? Users currently assigned
          this label will keep their assignment but the label will no
          longer appear in pickers.
        </p>
      </div>
      <ModalFooter>
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Cancel
        </button>
        <button
          onClick={confirm}
          disabled={loading}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
        >
          {loading ? 'Deleting…' : 'Delete'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent = 'indigo' }) {
  const COLORS = {
    indigo:  'from-indigo-50 to-indigo-100 ring-indigo-200 text-indigo-700',
    sky:     'from-sky-50 to-sky-100 ring-sky-200 text-sky-700',
    emerald: 'from-emerald-50 to-emerald-100 ring-emerald-200 text-emerald-700',
  }
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${COLORS[accent] ?? COLORS.indigo} ring-1 px-5 py-4`}>
      <p className="text-[11px] font-bold uppercase tracking-wider opacity-80">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums truncate">{value}</p>
    </div>
  )
}

function Field({ label, required, hint, error, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint  && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

function Pager({ page, totalPages, count, limit, onChange }) {
  const start = (page - 1) * limit + 1
  const end   = Math.min(page * limit, count)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3 text-sm">
      <p className="text-xs text-gray-500">
        Showing <span className="font-semibold text-gray-700">{start.toLocaleString()}</span>
        {' – '}
        <span className="font-semibold text-gray-700">{end.toLocaleString()}</span>
        {' of '}
        <span className="font-semibold text-gray-700">{count.toLocaleString()}</span>
      </p>
      <div className="inline-flex items-center gap-1">
        <PagerButton onClick={() => onChange(1)} disabled={page === 1}>«</PagerButton>
        <PagerButton onClick={() => onChange(page - 1)} disabled={page === 1}>‹</PagerButton>
        <span className="px-3 py-1.5 text-xs font-semibold text-gray-700">Page {page} of {totalPages}</span>
        <PagerButton onClick={() => onChange(page + 1)} disabled={page >= totalPages}>›</PagerButton>
        <PagerButton onClick={() => onChange(totalPages)} disabled={page >= totalPages}>»</PagerButton>
      </div>
    </div>
  )
}

function PagerButton({ children, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 hover:border-indigo-500 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
    </svg>
  )
}
function ShieldIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}
