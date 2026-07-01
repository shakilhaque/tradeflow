/**
 * Axios client with automatic JWT attach + silent token refresh on 401.
 *
 * Storage keys:
 *   access_token  — short-lived JWT (30 min)
 *   refresh_token — rotating refresh JWT (1 day)
 *
 * We deliberately use sessionStorage (per-tab) instead of localStorage
 * (shared across all tabs of the same origin). That way, signing in as a
 * tenant in one tab doesn't clobber the admin session in another tab —
 * each tab maintains its own independent login.
 *
 * Trade-off: closing the tab clears the session. Closing only the browser
 * window also clears it. This is a reasonable default for a finance app.
 */
import axios from 'axios'
import { showToast } from '../lib/toast.jsx'
import { incLoading, decLoading } from '../lib/loading.jsx'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''   // '' → use Vite proxy /api/*

export const client = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

// ── Storage helpers ────────────────────────────────────────────────────────────
//
// Backed by sessionStorage. We also clean up any pre-existing localStorage
// keys from older builds so stale data doesn't leak across tabs anymore.

const KEYS = ['access_token', 'refresh_token', 'auth_user']

// Auth tokens are stored in localStorage (NOT sessionStorage) so they
// are SHARED across browser tabs. Earlier the app used sessionStorage,
// which is scoped per-tab — opening a nav item in a new tab (or
// right-click → "Open in new tab") landed on the login page because
// the new tab had no token. localStorage fixes that.
//
// One-time migration: if a token still lives in the old sessionStorage
// slot (from a build before this change), copy it into localStorage so
// the current tab stays logged in across the upgrade.
try {
  KEYS.forEach((k) => {
    const fromSession = sessionStorage.getItem(k)
    if (fromSession != null && localStorage.getItem(k) == null) {
      localStorage.setItem(k, fromSession)
    }
    sessionStorage.removeItem(k)
  })
} catch { /* ignore — private mode etc. */ }

// ── Portal namespaces ──────────────────────────────────────────────────────────
//
// The tenant app and the platform-admin app are two different "portals"
// served by the same SPA. They used to share ONE set of localStorage
// keys, so logging into one portal overwrote the other's session —
// refresh a tenant tab after an admin login (or vice versa) and the
// page hydrated with the WRONG portal's profile and bounced you across.
//
// Fix: each portal gets its own key namespace.
//   tenant → access_token / refresh_token / auth_user   (unchanged,
//            so existing tenant sessions survive this deploy)
//   admin  → admin_access_token / admin_refresh_token / admin_auth_user
//
// Which namespace is "active" is derived from the URL at call time:
// /platform/*, /platform-login and /admin-login belong to the admin
// portal; everything else is tenant. Both sessions can now coexist in
// the same browser — a refresh always rehydrates from the namespace
// that matches the page you're on.

export const isAdminContext = (path = window.location.pathname) =>
  path.startsWith('/platform') || path.startsWith('/admin-login')

const currentNs = () => (isAdminContext() ? 'admin' : 'tenant')
const nsKey = (base, ns) => (ns === 'admin' ? `admin_${base}` : base)

export const storage = {
  ns: currentNs,
  getAccess:  (ns = currentNs()) => localStorage.getItem(nsKey('access_token', ns)),
  getRefresh: (ns = currentNs()) => localStorage.getItem(nsKey('refresh_token', ns)),
  setTokens:  (a, r, ns = currentNs()) => {
    localStorage.setItem(nsKey('access_token', ns),  a)
    localStorage.setItem(nsKey('refresh_token', ns), r)
  },
  clearTokens: (ns = currentNs()) => {
    localStorage.removeItem(nsKey('access_token', ns))
    localStorage.removeItem(nsKey('refresh_token', ns))
  },
  setUser: (u, ns = currentNs()) => localStorage.setItem(nsKey('auth_user', ns), JSON.stringify(u)),
  getUser: (ns = currentNs()) => {
    try { return JSON.parse(localStorage.getItem(nsKey('auth_user', ns))) } catch { return null }
  },
  clearUser: (ns = currentNs()) => localStorage.removeItem(nsKey('auth_user', ns)),
  // Active branch (multi-branch isolation). 'all' = consolidated (owner).
  getBranch:   (ns = currentNs()) => localStorage.getItem(nsKey('active_branch', ns)),
  setBranch:   (b, ns = currentNs()) => localStorage.setItem(nsKey('active_branch', ns), b ?? ''),
  clearBranch: (ns = currentNs()) => localStorage.removeItem(nsKey('active_branch', ns)),
}

// One-time cleanup for the pre-namespace bug: if the shared (tenant)
// slot holds an ADMIN profile — left there by an admin login before
// this build — move it into the admin namespace so the tenant slot
// is free for a real tenant session and the admin session survives.
try {
  const legacy = JSON.parse(localStorage.getItem('auth_user') || 'null')
  if (legacy && legacy.loginSource === 'admin') {
    if (!localStorage.getItem('admin_auth_user')) {
      localStorage.setItem('admin_auth_user', JSON.stringify(legacy))
      const a = localStorage.getItem('access_token')
      const r = localStorage.getItem('refresh_token')
      if (a) localStorage.setItem('admin_access_token', a)
      if (r) localStorage.setItem('admin_refresh_token', r)
    }
    localStorage.removeItem('auth_user')
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
  }
} catch { /* ignore */ }

// ── Request interceptor — attach Bearer token ──────────────────────────────────

// Auth endpoints must go out WITHOUT an Authorization header. DRF runs
// JWTAuthentication on every request, so a stale token from an already
// logged-in tab would make even an AllowAny login 401 with "Given token
// not valid for any token type" before the login view runs. Logging in
// from a second tab is exactly that case — so we strip the token here.
const _NO_TOKEN_PATHS = [
  '/auth/login', '/auth/admin/login', '/auth/login-otp',
  '/auth/otp', '/auth/token', '/auth/register', '/auth/signup',
]
client.interceptors.request.use((config) => {
  const url = config.url || ''
  const isAuthEndpoint = _NO_TOKEN_PATHS.some((p) => url.includes(p))
  const token = storage.getAccess()
  if (token && !isAuthEndpoint) config.headers.Authorization = `Bearer ${token}`
  // Active branch (multi-branch isolation). Sent on every tenant request so
  // the backend scopes data to the branch the user selected. Empty/absent
  // → backend default (owner: consolidated, staff: their branch).
  if (!isAuthEndpoint) {
    const branch = storage.getBranch()
    if (branch) config.headers['X-Branch-Id'] = branch
  }
  // Track in-flight requests for the global loading bar (skipped for
  // background polls that pass { _silentLoading: true }).
  if (!config._silentLoading) { config._counted = true; incLoading() }
  return config
})

// ── Response interceptor — silent refresh on 401 ──────────────────────────────

let _refreshing = false
let _waitQueue  = []   // requests queued while refresh is in-flight

const _flush = (error, token) => {
  _waitQueue.forEach(({ resolve, reject }) =>
    error ? reject(error) : resolve(token)
  )
  _waitQueue = []
}

client.interceptors.response.use(
  (response) => {
    if (response.config?._counted) { response.config._counted = false; decLoading() }
    return response
  },
  async (error) => {
    const original = error.config
    if (original?._counted) { original._counted = false; decLoading() }

    // Only attempt refresh once per request; skip login / refresh endpoints
    if (
      error.response?.status === 401 &&
      !original._retried &&
      !original.url?.includes('/auth/login') &&
      !original.url?.includes('/auth/token/refresh')
    ) {
      original._retried = true

      if (_refreshing) {
        // Queue this request until the ongoing refresh resolves
        return new Promise((resolve, reject) => {
          _waitQueue.push({ resolve, reject })
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`
          return client(original)
        })
      }

      _refreshing = true

      // Pin the namespace for the whole refresh cycle so a
      // navigation mid-flight can't mix the two portals' tokens.
      const ns = storage.ns()

      try {
        const refresh = storage.getRefresh(ns)
        if (!refresh) throw new Error('No refresh token')

        const res = await axios.post(`${BASE_URL}/api/auth/token/refresh/`, { refresh })
        const { access, refresh: newRefresh } = res.data?.data ?? res.data

        storage.setTokens(access, newRefresh, ns)
        _flush(null, access)

        original.headers.Authorization = `Bearer ${access}`
        return client(original)
      } catch (refreshError) {
        _flush(refreshError, null)
        // Clear ONLY the active portal's session and land on its
        // own login page — the other portal's session is untouched.
        storage.clearTokens(ns)
        storage.clearUser(ns)
        window.location.replace(ns === 'admin' ? '/admin-login' : '/login')
        return Promise.reject(refreshError)
      } finally {
        _refreshing = false
      }
    }

    return Promise.reject(error)
  }
)

// ── Convenience: unwrap the standard envelope ──────────────────────────────────
// Backend returns { status, data, message, errors? }
// This helper returns `data` or throws a clean Error with `message`.

// Endpoints that are NOT user "saves" — auth, payment, exports, polling,
// search, notification-reads — must never pop a "Saved" toast.
const _TOAST_SAVE_METHODS = new Set(['post', 'put', 'patch', 'delete'])
const _TOAST_DENY = [
  '/auth', '/login', '/logout', '/token', '/otp', '/refresh',
  '/pay-now', '/payment', '/billing', '/export', '/bulk-sms',
  '/scan', '/marquee', '/notifications', '/search',
]
function _maybeSaveToast(res) {
  try {
    const cfg = res?.config || {}
    if (cfg._silentToast) return
    const method = (cfg.method || '').toLowerCase()
    if (!_TOAST_SAVE_METHODS.has(method)) return
    const url = (cfg.url || '').toLowerCase()
    if (_TOAST_DENY.some((p) => url.includes(p))) return
    if (method === 'delete') showToast({ title: 'Deleted', message: 'The change is live.' })
    else showToast({ title: 'Saved', message: 'Your changes are live.' })
  } catch { /* a toast must never break a request */ }
}

export async function apiCall(fn) {
  try {
    const res = await fn()
    _maybeSaveToast(res)
    return res.data?.data ?? res.data
  } catch (err) {
    const payload = err.response?.data
    let message =
      payload?.message ||
      payload?.detail ||
      err.message ||
      'An unexpected error occurred.'
    // SimpleJWT's raw token errors are meaningless to a user — show a clear
    // session-expired message instead (e.g. when a stale token slips through).
    if (
      payload?.code === 'token_not_valid' ||
      /token (is )?(not valid|invalid|expired)|not valid for any token/i.test(String(message))
    ) {
      message = 'Your session has expired. Please sign in again.'
    }
    // A suspended tenant hitting a locked endpoint: show a friendly message
    // and route them to the Pay Bill page so they can self-serve (instead of
    // leaving them on a broken page with raw API text + demo data).
    const code403 = err.response?.status === 403 && payload?.errors?.code
    if (code403 === 'subscription_suspended') {
      message = 'Your subscription is paused. Please pay your bill to reopen your account.'
      try {
        if (!isAdminContext() && !window.location.pathname.startsWith('/billing/pay')) {
          window.location.replace('/billing/pay')
        }
      } catch { /* ignore */ }
    }
    const errors  = payload?.errors ?? null
    const apiErr  = new Error(message)
    apiErr.errors = errors
    apiErr.status = err.response?.status
    apiErr.payload = payload
    throw apiErr
  }
}
