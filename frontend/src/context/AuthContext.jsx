import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { storage, isAdminContext } from '../api/client'
import { login as apiLogin, loginAdmin as apiLoginAdmin, logout as apiLogout } from '../api/auth'
import { getBillingSummary } from '../api/subscription'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => storage.getUser())
  const location = useLocation()

  // When navigation crosses the portal boundary (tenant ↔ /platform/*),
  // re-hydrate the in-memory user from the matching storage namespace.
  // Each portal keeps its own session, so moving between them must
  // swap WHICH session is live instead of letting one leak into the
  // other's UI. (Refresh already does this naturally because the
  // initial useState reads the namespace of the landing URL.)
  const nsRef = useRef(isAdminContext() ? 'admin' : 'tenant')
  useEffect(() => {
    const ns = isAdminContext(location.pathname) ? 'admin' : 'tenant'
    if (ns !== nsRef.current) {
      nsRef.current = ns
      setUser(storage.getUser(ns))
    }
  }, [location.pathname])

  const persistAuth = useCallback((data, loginSource = 'tenant') => {
    // data = { access, refresh, role, permissions, email, name, user_id }
    // loginSource = 'tenant' | 'admin' — captures HOW the user signed in,
    // so a staff user logging in via /login still gets the tenant UI.
    //
    // The session is persisted into the storage namespace that matches
    // the portal ('admin' keys vs tenant keys) so the two logins can
    // coexist in one browser without overwriting each other. See
    // api/client.js for the namespace rationale.
    const ns = loginSource === 'admin' ? 'admin' : 'tenant'
    storage.setTokens(data.access, data.refresh, ns)
    const nestedUser = data.user ?? {}
    const profile = {
      id:              data.user_id ?? nestedUser.id,
      email:           data.email ?? nestedUser.email,
      name:            data.name ?? nestedUser.name,
      role:            data.role ?? nestedUser.role,
      status:          data.status ?? nestedUser.status ?? 'active',
      profile_picture: data.profile_picture ?? nestedUser.profile_picture ?? '',
      permissions:     data.permissions ?? nestedUser.permissions ?? [],
      adminPermissions: data.admin_permissions ?? nestedUser.admin_permissions ?? [],
      isStaff:         Boolean(data.is_staff ?? nestedUser.is_staff),
      isSuperuser:     Boolean(data.is_superuser ?? nestedUser.is_superuser),
      hasTenant:       Boolean(data.has_tenant ?? nestedUser.has_tenant),
      billing:         data.billing ?? nestedUser.billing ?? null,
      loginSource,
    }
    storage.setUser(profile, ns)
    setUser(profile)
    return profile
  }, [])

  // First arg is a free-form identifier — either a mobile number or an
  // email. The backend auto-detects. Kept named `identifier` here for
  // clarity; the variable was previously called `email`.
  const login = useCallback(async (identifier, password) => {
    const data = await apiLogin(identifier, password)
    return persistAuth(data, 'tenant')
  }, [persistAuth])

  const loginAdmin = useCallback(async (email, password) => {
    const data = await apiLoginAdmin(email, password)
    return persistAuth(data, 'admin')
  }, [persistAuth])

  const logout = useCallback(() => {
    apiLogout()
    setUser(null)
  }, [])

  /**
   * Re-fetch the billing snapshot and merge it into the cached user profile.
   * Used by BillingGate after navigation and by PayBillPage after a payment.
   */
  const refreshBilling = useCallback(async () => {
    try {
      const billing = await getBillingSummary()
      setUser((prev) => {
        if (!prev) return prev
        const next = { ...prev, billing }
        storage.setUser(next)
        return next
      })
      return billing
    } catch {
      return null
    }
  }, [])

  /**
   * Merge arbitrary fields into the cached user profile (e.g. after the user
   * uploads a new profile picture, so Sidebar/Header avatars update instantly
   * without waiting for the next login).
   */
  const updateUser = useCallback((patch) => {
    setUser((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      storage.setUser(next)
      return next
    })
  }, [])

  const isAuthenticated = Boolean(user && storage.getAccess())

  return (
    <AuthContext.Provider value={{ user, login, loginAdmin, logout, isAuthenticated, refreshBilling, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
