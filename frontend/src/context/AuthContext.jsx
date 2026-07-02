import { createContext, useContext, useState, useCallback } from 'react'
import { storage } from '../api/client'
import { login as apiLogin, logout as apiLogout } from '../api/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => storage.getUser())

  const persistAuth = useCallback((data) => {
    // data = { access, refresh, user_id, email, name, role, permissions, ... }
    storage.setTokens(data.access, data.refresh)
    const nested = data.user ?? {}
    const profile = {
      id:              data.user_id ?? nested.id,
      email:           data.email ?? nested.email,
      name:            data.name ?? nested.name,
      role:            data.role ?? nested.role,
      status:          data.status ?? nested.status ?? 'active',
      profile_picture: data.profile_picture ?? nested.profile_picture ?? '',
      permissions:     data.permissions ?? nested.permissions ?? [],
      isStaff:         Boolean(data.is_staff ?? nested.is_staff),
      isSuperuser:     Boolean(data.is_superuser ?? nested.is_superuser),
    }
    storage.setUser(profile)
    setUser(profile)
    return profile
  }, [])

  // Identifier may be an email, username, or mobile — the backend auto-detects.
  const login = useCallback(async (identifier, password) => {
    const data = await apiLogin(identifier, password)
    return persistAuth(data)
  }, [persistAuth])

  const logout = useCallback(() => {
    apiLogout()
    setUser(null)
  }, [])

  /** Merge fields into the cached profile (e.g. after avatar upload). */
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
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
