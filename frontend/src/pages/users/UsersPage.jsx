/**
 * User Management → Users
 *
 * Tenant-scoped staff users (owner + sub-users). Role-aware:
 * Owner/Admin can create/edit/delete; everyone else sees a read-only
 * table. Indigo "Manage" theme to set this category apart from the
 * green Contacts pages.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'

import Modal, { ModalFooter } from '../../components/ui/Modal'
import {
  getUsers, createUser, updateUser, deleteUser,
} from '../../api/users'
import { getCustomers } from '../../api/sales'
import { getRoles } from '../../api/roles'
import { getLocations } from '../../api/inventory'
import { getBranchAssignments, assignBranches } from '../../api/branches'
import { getCompanyProfile } from '../../api/companyProfile'
import BdPhoneInput, {
  validateBdPhone, validateLettersOnly,
  stripAtKeystroke, NON_LETTERS_RE,
} from '../../components/form/BdPhoneInput'
import { useAuth } from '../../context/AuthContext'
import { useDefaultPageSize } from '../../context/SettingsContext'
import PasswordInput from '../../components/ui/PasswordInput'

const ROLES = [
  { value: 'admin',   label: 'Admin'   },
  { value: 'manager', label: 'Manager' },
  { value: 'cashier', label: 'Cashier' },
]

const STATUS_OPTIONS = [
  { value: 'active',    label: 'Active'    },
  { value: 'suspended', label: 'Suspended' },
]

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export default function UsersPage() {
  const { user: me } = useAuth() || {}
  const canManage = !!me && (me.role === 'owner' || me.role === 'admin')

  // ── Data ───────────────────────────────────────────────────────────────────
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  // ── Filters ────────────────────────────────────────────────────────────────
  const [search, setSearch]   = useState('')
  const [roleFilter, setRoleFilter] = useState('')

  // ── Paging ─────────────────────────────────────────────────────────────────
  const defaultPageSize = useDefaultPageSize(25)
  const [page, setPage]   = useState(1)
  const [limit, setLimit] = useState(defaultPageSize)
  useEffect(() => { setLimit(defaultPageSize) }, [defaultPageSize])

  // ── Modal state ────────────────────────────────────────────────────────────
  const [editing,  setEditing]  = useState(null)   // null | 'new' | user object
  const [viewing,  setViewing]  = useState(null)
  const [deleting, setDeleting] = useState(null)

  const fetchData = async () => {
    setLoading(true); setError('')
    try {
      const res = await getUsers()
      setRows(Array.isArray(res) ? res : (res?.results ?? []))
      setPage(1)
    } catch (err) {
      setError(err.message || 'Failed to load users')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (roleFilter && r.role !== roleFilter) return false
      if (!q) return true
      return [r.name, r.email, r.username, r.phone]
        .some((v) => (v || '').toLowerCase().includes(q))
    })
  }, [rows, search, roleFilter])

  const count      = filtered.length
  const totalPages = Math.max(Math.ceil(count / limit), 1)
  const pageRows   = filtered.slice((page - 1) * limit, page * limit)
  const csvHref    = useMemo(() => buildCsv(filtered), [filtered])

  // Print the user list as a clean table document (company header + table),
  // not the whole app page.
  const handlePrint = async () => {
    const win = window.open('', '_blank', 'width=1100,height=900')
    if (!win) { window.alert('Allow popups to print this report.'); return }
    const c = await getCompanyProfile().catch(() => ({})) || {}
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
    const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—')
    const bodyRows = filtered.map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td><b>${esc(r.name || '—')}</b></td>
      <td>${esc(r.username || '—')}</td>
      <td>${esc(r.email || '—')}</td>
      <td>${esc(r.phone || '—')}</td>
      <td>${esc(cap(r.role))}</td>
      <td>${r.is_active && r.status === 'active' ? 'Active' : 'Inactive'}</td>
      <td>${esc(fmtDate(r.created_at))}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No users.</td></tr>'
    win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>Users — ${esc(c.business_name || '')}</title>
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
  @page{size:A4 landscape;margin:8mm}
</style></head><body>
<div class="row">
  <div>
    <h1 class="title">Users</h1>
    <div class="block" style="margin-top:4px">
      <b>${esc(c.business_name || '')}</b><br>
      ${esc(c.address || '')}<br>
      ${c.phone ? 'Phone: ' + esc(c.phone) : ''}
    </div>
  </div>
  <div style="text-align:right">
    <div class="sub">Generated</div>
    <div><b>${esc(new Date().toLocaleString())}</b></div>
    <div class="sub" style="margin-top:4px">${filtered.length} record${filtered.length === 1 ? '' : 's'}</div>
  </div>
</div>
<table>
  <thead><tr>
    <th>#</th><th>Name</th><th>Username</th><th>Email</th><th>Phone</th>
    <th>Role</th><th>Status</th><th>Joined</th>
  </tr></thead>
  <tbody>${bodyRows}</tbody>
</table>
<div class="footer"><div>Total users: <b>${filtered.length}</b></div><div>Powered by Iffaa</div></div>
<script>window.onload=()=>setTimeout(()=>window.print(),250)</script>
</body></html>`)
    win.document.close()
  }

  const stats = useMemo(() => {
    let admins = 0, others = 0, inactive = 0
    for (const r of rows) {
      if (!r.is_active) inactive += 1
      if (r.role === 'owner' || r.role === 'admin') admins += 1
      else others += 1
    }
    return { total: rows.length, admins, others, inactive }
  }, [rows])

  return (
    <div className="space-y-5">
      {/* ── Heading ───────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-sky-500 px-6 py-5 shadow-sm flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Users</h1>
          <p className="text-xs text-indigo-50 mt-0.5">
            Manage staff who can sign in to this account — Admins,
            Managers and Cashiers — and control their access.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
          >
            <PlusIcon /> Add User
          </button>
        )}
      </div>

      {!canManage && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You&rsquo;re viewing this page in read-only mode. Only Owner or
          Admin roles can add, edit or remove users.
        </div>
      )}

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Total users"     value={stats.total}    accent="indigo" />
        <Kpi label="Admins / Owner"  value={stats.admins}   accent="sky" />
        <Kpi label="Staff"           value={stats.others}   accent="emerald" />
        <Kpi label="Suspended"       value={stats.inactive} accent="amber" />
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4 text-indigo-700">
          <FilterIcon />
          <h2 className="text-sm font-semibold uppercase tracking-wider">Filters</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <FieldText
            label="Search"
            value={search}
            onChange={setSearch}
            placeholder="Name, email, username, phone…"
          />
          <FieldSelect
            label="Role"
            value={roleFilter}
            onChange={setRoleFilter}
            options={[
              { value: '', label: 'All' },
              { value: 'owner',   label: 'Owner'   },
              { value: 'admin',   label: 'Admin'   },
              { value: 'manager', label: 'Manager' },
              { value: 'cashier', label: 'Cashier' },
            ]}
          />
          <div className="self-end flex justify-end gap-2">
            <button
              onClick={() => { setSearch(''); setRoleFilter('') }}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 hover:border-gray-300"
            >
              Reset
            </button>
            <button
              onClick={fetchData}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
            >
              Refresh
            </button>
          </div>
        </div>
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
            placeholder="Search users…"
            className="flex-1 sm:flex-initial sm:w-80 rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={csvHref}
              download={`users-${new Date().toISOString().slice(0, 10)}.csv`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-indigo-500 hover:text-indigo-700"
            >
              <DownloadIcon /> CSV
            </a>
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:border-indigo-500 hover:text-indigo-700"
            >
              <PrintIcon /> Print
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
            <EmptyState onAdd={canManage ? () => setEditing('new') : null} />
          ) : (
            <UsersTable
              rows={pageRows}
              me={me}
              canManage={canManage}
              onEdit={(u) => setEditing(u)}
              onView={(u) => setViewing(u)}
              onDelete={(u) => setDeleting(u)}
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
        <UserModal
          open={Boolean(editing)}
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetchData() }}
        />
      )}
      {viewing && (
        <ViewModal
          open={Boolean(viewing)}
          user={viewing}
          onClose={() => setViewing(null)}
          onEdit={canManage ? () => { setEditing(viewing); setViewing(null) } : null}
        />
      )}
      {deleting && (
        <DeleteModal
          open={Boolean(deleting)}
          user={deleting}
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

function UsersTable({ rows, me, canManage, onEdit, onView, onDelete }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
          <th className="px-5 py-3">User</th>
          <th className="px-5 py-3">Username</th>
          <th className="px-5 py-3">Email</th>
          <th className="px-5 py-3">Phone</th>
          <th className="px-5 py-3">Role</th>
          <th className="px-5 py-3 text-center">Status</th>
          <th className="px-5 py-3">Joined</th>
          <th className="px-5 py-3 text-right w-44">Action</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {rows.map((r) => {
          const isMe   = me && r.id === me.id
          const isOwner = r.role === 'owner'
          const initials = String(r.name || r.email || '?')
            .split(' ').slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('')
          return (
            <tr key={r.id} className={`hover:bg-indigo-50/40 transition-colors ${isMe ? 'bg-indigo-50/20' : ''}`}>
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  {r.profile_picture
                    ? <img src={r.profile_picture} alt="" className="h-9 w-9 rounded-full object-cover" />
                    : <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-100 to-sky-100 text-xs font-semibold text-indigo-700">{initials}</div>}
                  <div>
                    <div className="font-medium text-gray-900">
                      {r.name || '—'}
                      {isMe && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-600">You</span>}
                    </div>
                    <div className="text-[11px] text-gray-400">ID {String(r.id).slice(0, 8)}</div>
                  </div>
                </div>
              </td>
              <td className="px-5 py-3 font-mono text-xs text-gray-600">{r.username || '—'}</td>
              <td className="px-5 py-3 text-gray-700">{r.email || '—'}</td>
              <td className="px-5 py-3 text-gray-700">{r.phone || '—'}</td>
              <td className="px-5 py-3">
                <RoleBadge role={r.role} />
              </td>
              <td className="px-5 py-3 text-center">
                <span className={[
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
                  r.is_active && r.status === 'active'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-gray-100 text-gray-600',
                ].join(' ')}>
                  {r.is_active && r.status === 'active' ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
              <td className="px-5 py-3 text-right">
                <div className="inline-flex items-center gap-1.5">
                  <button
                    onClick={() => onView(r)}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-700 hover:border-indigo-500 hover:text-indigo-700"
                  >
                    View
                  </button>
                  {canManage && !isOwner && (
                    <button
                      onClick={() => onEdit(r)}
                      className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700"
                    >
                      Edit
                    </button>
                  )}
                  {canManage && !isOwner && !isMe && (
                    <button
                      onClick={() => onDelete(r)}
                      className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-700"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function RoleBadge({ role }) {
  const map = {
    owner:   { label: 'Owner',   cls: 'bg-amber-100 text-amber-800' },
    admin:   { label: 'Admin',   cls: 'bg-indigo-100 text-indigo-700' },
    manager: { label: 'Manager', cls: 'bg-sky-100 text-sky-700' },
    cashier: { label: 'Cashier', cls: 'bg-emerald-100 text-emerald-700' },
  }
  const m = map[role] || { label: role || '—', cls: 'bg-gray-100 text-gray-600' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${m.cls}`}>
      {m.label}
    </span>
  )
}

function EmptyState({ onAdd }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
        <UsersIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">No users found.</p>
      <p className="mt-1 text-xs text-gray-500">Adjust the filters above or add a new staff user.</p>
      {onAdd && (
        <button
          onClick={onAdd}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          <PlusIcon /> Add User
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function UserModal({ open, user, onClose, onSaved }) {
  const isEdit = Boolean(user)
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm()
  const [error, setError] = useState('')

  // Customers list for the "Select Contacts" multi-pick. Lazy-loaded on
  // first open. We use the existing /api/sales/customers/ endpoint.
  const [contacts, setContacts] = useState([])
  const [contactSearch, setContactSearch] = useState('')
  // Custom roles available for assignment. Built-in role rows are
  // filtered out — they're already selectable via the "Role" dropdown
  // (Admin / Manager / Cashier).
  const [customRoles, setCustomRoles] = useState([])
  const [branches, setBranches] = useState([])
  // Multi-branch: the set of branches this user may access (UserBranch rows),
  // plus the subset they MANAGE (branch managers → all-branches dashboard).
  const [branchIds, setBranchIds] = useState([])
  const [manageBranchIds, setManageBranchIds] = useState([])
  useEffect(() => {
    if (!open) { setBranchIds([]); setManageBranchIds([]); return }
    let cancelled = false
    if (isEdit && user?.id) {
      getBranchAssignments(user.id)
        .then((r) => {
          if (cancelled) return
          setBranchIds((r?.branch_ids || []).map(String))
          setManageBranchIds((r?.manage_branch_ids || []).map(String))
        })
        .catch(() => { if (!cancelled) setBranchIds(user?.branch_id ? [String(user.branch_id)] : []) })
    } else {
      setBranchIds([]); setManageBranchIds([])
    }
    ;(async () => {
      try {
        const res = await getCustomers({ active_only: 'true' })
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        if (!cancelled) setContacts(arr)
      } catch { /* ignore — restriction picker just stays empty */ }
      try {
        const rs = await getRoles()
        const ra = Array.isArray(rs) ? rs : (rs?.results ?? [])
        if (!cancelled) setCustomRoles(ra.filter((r) => !r.is_system))
      } catch { /* ignore — custom role picker just stays empty */ }
      try {
        const ls = await getLocations({ active_only: 'true' })
        const la = Array.isArray(ls) ? ls : (ls?.results ?? [])
        if (!cancelled) setBranches(la)
      } catch { /* ignore — branch picker just stays empty */ }
    })()
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (open) {
      reset(isEdit ? {
        name:                       user.name || '',
        username:                   user.username || '',
        email:                      user.email || '',
        phone:                      user.phone || '',
        role:                       user.role && user.role !== 'owner' ? user.role : 'cashier',
        tenant_role:                user.tenant_role || '',
        branch_id:                  user.branch_id || '',
        status:                     user.status || 'active',
        password:                   '',
        sales_commission_percent:   user.sales_commission_percent ?? '',
        max_sales_discount_percent: user.max_sales_discount_percent ?? '',
        allow_selected_contacts:    !!user.allow_selected_contacts,
        allowed_contact_ids:        Array.isArray(user.allowed_contact_ids) ? user.allowed_contact_ids : [],
      } : {
        name: '', username: '', email: '', phone: '',
        role: 'cashier', tenant_role: '', branch_id: '', status: 'active', password: '',
        sales_commission_percent:   '',
        max_sales_discount_percent: '',
        allow_selected_contacts:    false,
        allowed_contact_ids:        [],
      })
      setError('')
      setContactSearch('')
    }
  }, [open, user, isEdit, reset])

  // The custom-role <select> options load asynchronously (getRoles). The
  // reset() above runs immediately on open — before those options exist —
  // so the native <select> can't show the saved role and renders blank.
  // Re-apply the saved value once the options are present, otherwise a
  // later save would silently clear the user's custom role.
  useEffect(() => {
    if (open && isEdit && customRoles.length) {
      setValue('tenant_role', user?.tenant_role || '')
    }
  }, [open, isEdit, customRoles, user, setValue])

  const allowContacts  = !!watch('allow_selected_contacts')
  const selectedIds    = watch('allowed_contact_ids') || []
  const filteredContacts = contacts.filter((c) => {
    const q = contactSearch.trim().toLowerCase()
    if (!q) return true
    return [c.name, c.phone, c.email]
      .some((v) => (v || '').toLowerCase().includes(q))
  })

  const toggleContact = (id) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id]
    setValue('allowed_contact_ids', next, { shouldDirty: true })
  }

  const onSubmit = async (data) => {
    setError('')
    try {
      const payload = {
        ...data,
        sales_commission_percent:   data.sales_commission_percent   === '' ? null : Number(data.sales_commission_percent),
        max_sales_discount_percent: data.max_sales_discount_percent === '' ? null : Number(data.max_sales_discount_percent),
        allow_selected_contacts:    !!data.allow_selected_contacts,
        allowed_contact_ids:        data.allow_selected_contacts
          ? (data.allowed_contact_ids || [])
          : [],
        email:        (data.email || '').trim(),
        tenant_role:  data.tenant_role || null,
        // Branch: keep the legacy single branch_id (+ denormalised name) in
        // sync with the FIRST selected branch, for back-compat with the
        // Super Admin "Users per Branch" view. The full set is saved via
        // assignBranches() below.
        branch_id:    branchIds[0] || null,
        branch_name:  branchIds[0]
          ? ((branches.find((b) => String(b.id) === String(branchIds[0])) || {}).name || '')
          : '',
      }
      if (!payload.password) delete payload.password   // don't send blank on edit
      let savedId = isEdit ? user.id : null
      if (isEdit) {
        await updateUser(user.id, payload)
      } else {
        const created = await createUser(payload)
        savedId = created?.id || created?.user?.id || created?.user_id || null
      }
      // Multi-branch: persist which branches this user may access. The
      // endpoint is owner-only and non-fatal if it fails (older server).
      if (savedId) {
        try { await assignBranches(savedId, branchIds, manageBranchIds) } catch { /* ignore */ }
      }
      onSaved?.()
    } catch (err) {
      // Surface DRF field-level errors directly so the operator sees
      // exactly what's wrong instead of "Request failed with status
      // code 500".
      const fieldErrors = err?.errors
      if (fieldErrors && typeof fieldErrors === 'object') {
        const parts = []
        for (const [k, v] of Object.entries(fieldErrors)) {
          const msg = Array.isArray(v) ? v.join(', ') : String(v)
          parts.push(`${k}: ${msg}`)
        }
        setError(parts.join('  ·  ') || err.message || 'Failed to save user')
      } else {
        setError(err.message || 'Failed to save user')
      }
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit User' : 'Add User'} size="2xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Full name" required hint="Letters only — no digits." error={errors.name?.message}>
            <input
              {...stripAtKeystroke(
                register('name', {
                  required: 'Name is required',
                  validate: validateLettersOnly('Full name'),
                }),
                NON_LETTERS_RE,
              )}
              placeholder="e.g. Anika Rahman"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </Field>
          <Field label="Username" required hint="Letters only — no digits." error={errors.username?.message}>
            <input
              {...stripAtKeystroke(
                register('username', {
                  required: 'Username is required',
                  validate: validateLettersOnly('Username'),
                }),
                NON_LETTERS_RE,
              )}
              placeholder="anika"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Mobile number" required hint="11 digits, +88 fixed. Used for SMS OTP and tenant login." error={errors.phone?.message}>
            <BdPhoneInput
              {...register('phone', {
                required: 'Mobile number is required.',
                validate: validateBdPhone,
              })}
              placeholder="01XXXXXXXXX"
            />
          </Field>
          <Field label="Email" hint="Optional." error={errors.email?.message}>
            <input
              type="email"
              {...register('email', {
                validate: (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Enter a valid email address.',
              })}
              placeholder="name@company.com"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Built-in role" hint="Baseline access level: Admin / Manager / Cashier.">
            <select
              {...register('role')}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select
              {...register('status')}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            >
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
        </div>

        <Field
          label="Custom role (optional)"
          hint={customRoles.length === 0
            ? 'Create a custom role under User Management → Roles first.'
            : 'Granular permissions added on top of the built-in role above.'}
        >
          <select
            {...register('tenant_role')}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            <option value="">— Use built-in role only —</option>
            {customRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({Array.isArray(r.permissions) ? r.permissions.length : 0} permissions)
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Branch access"
          hint={branches.length === 0
            ? 'Add business locations under Settings → Business Locations first.'
            : 'Tick every branch this user may access. They see only these branches’ data; with more than one, they pick a branch after login.'}
        >
          {branches.length === 0 ? (
            <p className="text-xs text-gray-400">No branches yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
              {branches.map((b) => {
                const id = String(b.id)
                const checked = branchIds.includes(id)
                const manages = manageBranchIds.includes(id)
                return (
                  <div key={id} className="flex items-center justify-between gap-2 text-sm text-gray-700">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setBranchIds((prev) =>
                            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
                          // Dropping access also drops the manager flag.
                          if (checked) setManageBranchIds((prev) => prev.filter((x) => x !== id))
                        }}
                      />
                      {b.name}
                    </label>
                    {checked && (
                      <label className="flex items-center gap-1.5 text-xs font-medium text-indigo-700"
                             title="Branch manager — can open the all-branches dashboard for this branch">
                        <input
                          type="checkbox"
                          checked={manages}
                          onChange={() => setManageBranchIds((prev) =>
                            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
                        />
                        Manager
                      </label>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Field>

        <Field
          label={isEdit ? 'Reset password (optional)' : 'Password'}
          hint={isEdit
            ? 'Leave blank to keep the current password.'
            : 'Minimum 6 characters. Share this with the user — they can change it after first login.'}
          error={errors.password?.message}
        >
          <PasswordInput
            {...register('password', isEdit ? {} : { required: 'Password is required', minLength: { value: 6, message: 'At least 6 characters.' } })}
            placeholder={isEdit ? 'Leave blank to keep current' : 'Minimum 6 characters'}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
        </Field>

        {/* ── Sales staff settings ─────────────────────────────────────── */}
        <div className="rounded-xl border border-amber-100 bg-amber-50/40 px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-700 mb-3">
            Sales
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Sales commission percentage (%)"
              hint="Percentage of each finalized sale credited to this user. Leave blank for none."
            >
              <input
                type="number" min="0" max="100" step="0.01"
                {...register('sales_commission_percent')}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
            </Field>
            <Field
              label="Max sales discount percent"
              hint="Highest discount % this user can apply without supervisor override."
            >
              <input
                type="number" min="0" max="100" step="0.01"
                {...register('max_sales_discount_percent')}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />
            </Field>
          </div>

          <label className="mt-4 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              {...register('allow_selected_contacts')}
              className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-200"
            />
            <div>
              <p className="text-sm font-medium text-gray-800">Allow selected contacts</p>
              <p className="text-[11px] text-gray-500">
                When on, this user can only ring up sales to the customers ticked below.
              </p>
            </div>
          </label>

          {allowContacts && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <input
                  type="text"
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="Search name / phone / email…"
                  className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs outline-none focus:border-indigo-500"
                />
                <span className="text-[11px] text-gray-500">
                  {selectedIds.length} selected
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-gray-100 divide-y divide-gray-50">
                {filteredContacts.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-gray-400">No customers match.</p>
                ) : filteredContacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-indigo-50/30 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(c.id)}
                      onChange={() => toggleContact(c.id)}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-200"
                    />
                    <span className="flex-1 text-gray-800">{c.name}</span>
                    <span className="text-gray-400">{c.phone || c.email || ''}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
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
          {isEdit ? 'Save changes' : 'Create user'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function ViewModal({ open, user, onClose, onEdit }) {
  if (!user) return null
  return (
    <Modal open={open} onClose={onClose} title="User Details" size="md">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-100 to-sky-100 text-base font-semibold text-indigo-700">
            {(user.name || '?').split(' ').slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('')}
          </div>
          <div>
            <p className="text-base font-semibold text-gray-900">{user.name}</p>
            <p className="text-xs text-gray-500">{user.email}</p>
          </div>
          <div className="ml-auto">
            <RoleBadge role={user.role} />
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Info label="Username" value={user.username} mono />
          <Info label="Phone"    value={user.phone || '—'} />
          <Info label="Status"   value={user.is_active && user.status === 'active' ? 'Active' : 'Inactive'} />
          <Info label="Joined"   value={fmtDate(user.created_at)} />
        </dl>
      </div>
      <ModalFooter>
        {onEdit && (
          <button
            onClick={onEdit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Edit user
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
        >
          Close
        </button>
      </ModalFooter>
    </Modal>
  )
}

function DeleteModal({ open, user, onClose, onDeleted }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteUser(user.id)
      onDeleted?.()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Suspend / Delete User" size="sm">
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <p className="text-sm text-gray-700">
          Suspend <strong>{user?.name}</strong>? Their account will be
          deactivated and they will no longer be able to sign in. You can
          re-enable them later by editing the user.
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
          {loading ? 'Working…' : 'Suspend user'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

function buildCsv(rows) {
  if (!rows?.length) return '#'
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['Name', 'Username', 'Email', 'Phone', 'Role', 'Status', 'Joined']
  const lines = rows.map((r) => [
    r.name, r.username, r.email, r.phone, r.role,
    r.is_active && r.status === 'active' ? 'Active' : 'Inactive',
    r.created_at,
  ].map(esc).join(','))
  return URL.createObjectURL(
    new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
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
    amber:   'from-amber-50 to-amber-100 ring-amber-200 text-amber-700',
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

function FieldText({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <input
        type="text" value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </div>
  )
}

function FieldSelect({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function Info({ label, value, mono }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-sm text-gray-800 ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
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

function FilterIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM4 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H4.75A.75.75 0 014 10zm3 5.25a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75z" clipRule="evenodd" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
    </svg>
  )
}
function UsersIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
function DownloadIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
      <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
    </svg>
  )
}
function PrintIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5 2.75A2.75 2.75 0 017.75 0h4.5A2.75 2.75 0 0115 2.75v1.5h.25A2.75 2.75 0 0118 7v3.25A2.75 2.75 0 0115.25 13H15v3.25A1.75 1.75 0 0113.25 18h-6.5A1.75 1.75 0 015 16.25V13h-.25A2.75 2.75 0 012 10.25V7a2.75 2.75 0 012.75-2.75H5v-1.5zm1.5 0v1.5h7v-1.5a1.25 1.25 0 00-1.25-1.25h-4.5A1.25 1.25 0 006.5 2.75zM5 11.5h10v-1.25a1.25 1.25 0 00-1.25-1.25h-7.5A1.25 1.25 0 005 10.25v1.25zm1.5 1.5v3.25c0 .138.112.25.25.25h6.5a.25.25 0 00.25-.25V13h-7z" clipRule="evenodd" />
    </svg>
  )
}
