import { client, apiCall } from './client'

// ── Tenant-facing reads ──────────────────────────────────────────────────────

/**
 * Active platform notices for the tenant dashboard.
 * Server filters by is_active + published_at <= now + (expires_at > now OR null).
 * Returns array of { id, title, body, kind, published_at, expires_at }.
 */
export const getActiveNotices = () =>
  apiCall(() => client.get('/api/notices/active/'))

/**
 * All currently-visible marquee notices (newest first) — the scrolling
 * banner the platform admin pins to every tenant page. Returns an array
 * of is_marquee=True PlatformNotices; the frontend scrolls them all in a
 * single bar. Empty array = no active marquee.
 */
export const getMarqueeNotice = () =>
  apiCall(() => client.get('/api/notices/marquee/'))

/**
 * Support contact info — email, phone, office address, hours.
 * Driven by env vars on the server so the platform owner can change without
 * a code deploy.
 */
export const getSupportInfo = () =>
  apiCall(() => client.get('/api/support/'))


// ── Platform-admin CRUD ──────────────────────────────────────────────────────

export const listNotices = (params = {}) =>
  apiCall(() => client.get('/api/admin/notices/', { params }))

export const createNotice = (data) =>
  apiCall(() => client.post('/api/admin/notices/', data))

export const updateNotice = (id, data) =>
  apiCall(() => client.patch(`/api/admin/notices/${id}/`, data))

export const deleteNotice = (id) =>
  apiCall(() => client.delete(`/api/admin/notices/${id}/`))

/** Admin: read / update the Support card shown on every tenant dashboard. */
export const getAdminSupportInfo = () =>
  apiCall(() => client.get('/api/admin/support-info/'))

export const updateAdminSupportInfo = (data) =>
  apiCall(() => client.put('/api/admin/support-info/', data))
