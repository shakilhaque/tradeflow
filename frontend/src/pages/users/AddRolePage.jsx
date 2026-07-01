/**
 * Add Role — full permission catalog matching role.txt.
 *
 * The same page also handles "Edit role" when ?id=<uuid> is in the URL
 * (or when navigated to from RolesPage with a role row in location state)
 * so the operator gets a wide-screen layout for the long permission list
 * instead of a cramped modal.
 *
 * Indigo "Manage" theme to match the rest of User Management.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { createRole, updateRole, getRoles } from '../../api/roles'
import { useAuth } from '../../context/AuthContext'
import { PERMISSION_GROUPS } from './rolePermissions'

export default function AddRolePage() {
  const navigate = useNavigate()
  const { id }   = useParams()                  // /roles/new vs /roles/:id/edit
  const editing  = Boolean(id)
  const { user: me } = useAuth() || {}
  const canManage = !!me && (me.role === 'owner' || me.role === 'admin')

  const [name,        setName]        = useState('')
  const [description, setDescription] = useState('')
  const [selected,    setSelected]    = useState(() => new Set())
  const [loading,     setLoading]     = useState(editing)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')
  const [search,      setSearch]      = useState('')

  // ── Hydrate when editing ──────────────────────────────────────────────
  useEffect(() => {
    if (!editing) return
    let cancelled = false
    ;(async () => {
      setLoading(true); setError('')
      try {
        const res = await getRoles()
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        const row = arr.find((r) => String(r.id) === String(id))
        if (!row) {
          setError("Role not found, or you don't have access to it.")
          return
        }
        if (cancelled) return
        if (row.is_system) {
          setError('Built-in roles cannot be edited.')
        }
        setName(row.name || '')
        setDescription(row.description || '')
        setSelected(new Set(Array.isArray(row.permissions) ? row.permissions : []))
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load role.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [editing, id])

  // ── Helpers ───────────────────────────────────────────────────────────
  const toggleOne = (code) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(code)) next.delete(code); else next.add(code)
    return next
  })
  const toggleGroup = (group, on) => setSelected((prev) => {
    const next = new Set(prev)
    for (const p of group.perms) {
      if (on) next.add(p.code); else next.delete(p.code)
    }
    return next
  })
  const selectAll = () => {
    const next = new Set()
    for (const g of PERMISSION_GROUPS) for (const p of g.perms) next.add(p.code)
    setSelected(next)
  }
  const clearAll = () => setSelected(new Set())

  const totalCount = useMemo(
    () => PERMISSION_GROUPS.reduce((s, g) => s + g.perms.length, 0),
    [],
  )

  // Filter groups by search — show a group if any of its perms or its
  // label match. Inside the group, only matching perms are highlighted
  // (but the rest still render so "select all" works.)
  const q = search.trim().toLowerCase()
  const matches = useCallback((perm) => {
    if (!q) return true
    return perm.label.toLowerCase().includes(q) || perm.code.toLowerCase().includes(q)
  }, [q])

  const visibleGroups = useMemo(() => {
    if (!q) return PERMISSION_GROUPS
    return PERMISSION_GROUPS.filter((g) =>
      g.label.toLowerCase().includes(q) || g.perms.some((p) => matches(p))
    )
  }, [q, matches])

  const onSave = async () => {
    setError('')
    if (!name.trim()) { setError('Role name is required.'); return }
    setSaving(true)
    try {
      const payload = {
        name:        name.trim(),
        description: description.trim(),
        permissions: Array.from(selected),
      }
      if (editing) await updateRole(id, payload)
      else         await createRole(payload)
      navigate('/roles')
    } catch (err) {
      setError(err?.message || 'Failed to save role.')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  if (!canManage) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Only Owner or Admin roles can manage roles.
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-24">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-sky-500 px-6 py-5 shadow-sm flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">
            {editing ? 'Edit Role' : 'Add Role'}
          </h1>
          <p className="text-xs text-indigo-50 mt-0.5">
            Tick the permissions this role should grant. {selected.size} of {totalCount} selected.
          </p>
        </div>
        <button
          onClick={() => navigate('/roles')}
          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
        >
          ← Back to roles
        </button>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* ── Role meta ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Role name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sales Executive"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </Field>
          <Field label="Description" hint="Helps your team pick the right role.">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Sells over the counter, no settings access…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </Field>
        </div>
      </div>

      {/* ── Permissions toolbar ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search permissions…"
          className="flex-1 sm:flex-initial sm:w-72 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={selectAll}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-gray-700 hover:border-indigo-500 hover:text-indigo-700"
          >
            Select all
          </button>
          <button
            onClick={clearAll}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 font-semibold text-gray-700 hover:border-rose-500 hover:text-rose-700"
          >
            Clear all
          </button>
          <span className="ml-2 inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
            {selected.size} / {totalCount}
          </span>
        </div>
      </div>

      {/* ── Permission groups ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {visibleGroups.map((g) => {
          const groupSelected = g.perms.filter((p) => selected.has(p.code)).length
          const allOn  = groupSelected === g.perms.length
          const someOn = groupSelected > 0 && !allOn
          return (
            <div key={g.id} className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50 px-5 py-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => { if (el) el.indeterminate = someOn }}
                    onChange={(e) => toggleGroup(g, e.target.checked)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-200"
                  />
                  <span className="text-sm font-semibold text-gray-900">{g.label}</span>
                </label>
                <span className="text-[11px] text-gray-500">
                  {groupSelected} / {g.perms.length}
                </span>
              </div>
              <ul className="divide-y divide-gray-50">
                {g.perms.map((p) => {
                  const hit = matches(p)
                  return (
                    <li
                      key={p.code}
                      className={`px-5 py-2 flex items-start gap-3 text-sm transition ${hit ? '' : 'opacity-40'} hover:bg-indigo-50/30`}
                    >
                      <input
                        type="checkbox"
                        id={`perm-${p.code}`}
                        checked={selected.has(p.code)}
                        onChange={() => toggleOne(p.code)}
                        className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-200"
                      />
                      <label htmlFor={`perm-${p.code}`} className="flex-1 cursor-pointer">
                        <span className="text-gray-800">{p.label}</span>
                        <span className="ml-2 text-[10px] font-mono text-gray-400">{p.code}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
        {visibleGroups.length === 0 && (
          <div className="lg:col-span-2 rounded-2xl border border-dashed border-gray-200 bg-gray-50/40 px-6 py-10 text-center text-sm text-gray-500">
            No permissions match &ldquo;{search}&rdquo;.
          </div>
        )}
      </div>

      {/* ── Sticky save bar ───────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white/90 px-6 py-3 shadow-lg backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            <span className="font-semibold text-gray-800">{selected.size}</span> permission{selected.size === 1 ? '' : 's'} selected
            {name && <> · Role <span className="font-semibold text-gray-800">"{name}"</span></>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate('/roles')}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:border-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create role'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, hint, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-gray-400">{hint}</p>}
    </div>
  )
}
