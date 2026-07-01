import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useAuth } from './AuthContext'
import { storage } from '../api/client'
import { getMyBranches } from '../api/branches'

/**
 * BranchContext — the app-wide ACTIVE BRANCH (multi-branch data isolation).
 *
 * After login it loads the branches the user may access:
 *   • exactly one option  → auto-select it, no prompt.
 *   • multiple options    → `needsSelection` so the shell shows the picker.
 * The active branch id (or 'all' = consolidated, owner-only) is persisted per
 * portal namespace and sent as the X-Branch-Id header on every API call, so
 * switching re-scopes the whole app.
 */
const BranchCtx = createContext(null)
export const CONSOLIDATED = 'all'

export function BranchProvider({ children }) {
  const { user, isAuthenticated } = useAuth() || {}
  // Branches only apply to the tenant portal, never the platform-admin one.
  const isTenantUser = Boolean(isAuthenticated && user && user.loginSource !== 'admin')

  const [branches,        setBranches]        = useState([])
  const [canConsolidated, setCanConsolidated] = useState(false)
  const [canManageAny,    setCanManageAny]    = useState(false)
  const [active,          setActive]          = useState(() => storage.getBranch() || '')
  const [loading,         setLoading]         = useState(true)
  const [needsSelection,  setNeedsSelection]  = useState(false)

  useEffect(() => {
    if (!isTenantUser) { setLoading(false); setNeedsSelection(false); return }
    let cancelled = false
    setLoading(true)
    getMyBranches()
      .then((res) => {
        if (cancelled) return
        const list = Array.isArray(res?.branches) ? res.branches : []
        // The consolidated "All Branches" view only matters when the tenant
        // actually has MORE THAN ONE branch. A single-branch tenant (e.g. the
        // free tier) has nothing to consolidate or choose between, so we
        // suppress consolidated + the post-login picker entirely for them —
        // only multi-branch subscribers see the chooser.
        const multiBranch  = list.length > 1
        const consolidated = Boolean(res?.can_view_consolidated) && multiBranch
        setBranches(list)
        setCanConsolidated(consolidated)
        setCanManageAny(Boolean(res?.can_manage_any_branch) && multiBranch)

        if (!multiBranch) {
          // 0 or 1 branch → auto-select the only branch (or none); never prompt.
          const only = list[0]?.id || ''
          storage.setBranch(only); setActive(only); setNeedsSelection(false)
          return
        }

        const options = [...(consolidated ? [CONSOLIDATED] : []), ...list.map((b) => b.id)]
        const stored = storage.getBranch() || ''
        if (stored && options.includes(stored)) {
          setActive(stored); setNeedsSelection(false)
        } else {
          setNeedsSelection(true)                           // multiple branches → must pick
        }
      })
      .catch(() => { if (!cancelled) { setBranches([]); setNeedsSelection(false) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isTenantUser, user?.id])

  // First selection from the post-login picker — no reload needed (the app
  // renders + fetches AFTER it's set). Switching later reloads so every
  // already-mounted module refetches against the new branch.
  const selectBranch = useCallback((value, { reload = false } = {}) => {
    storage.setBranch(value)
    setActive(value)
    setNeedsSelection(false)
    if (reload) window.location.reload()
  }, [])

  const value = useMemo(() => ({
    branches,
    canConsolidated,
    canManageAny,
    active,
    isConsolidated: active === CONSOLIDATED,
    activeBranchName: active === CONSOLIDATED
      ? 'All Branches'
      : (branches.find((b) => b.id === active)?.name || ''),
    loading,
    needsSelection,
    selectBranch,                                   // post-login pick (no reload)
    switchBranch: (v) => selectBranch(v, { reload: true }),  // header switch (reload app)
    CONSOLIDATED,
  }), [branches, canConsolidated, canManageAny, active, loading, needsSelection, selectBranch])

  return <BranchCtx.Provider value={value}>{children}</BranchCtx.Provider>
}

export function useBranch() {
  return useContext(BranchCtx) || {}
}
