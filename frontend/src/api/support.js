import { client, apiCall } from './client'

// Multipart helper — let axios set the boundary by clearing the JSON default.
const MULTI = { headers: { 'Content-Type': undefined } }

function toFormData(fields = {}, files = []) {
  const fd = new FormData()
  Object.entries(fields).forEach(([k, v]) => { if (v != null) fd.append(k, v) })
  files.forEach((f) => fd.append('attachments', f))
  return fd
}

// ── Tenant ─────────────────────────────────────────────────────────────────
export const getMyTickets = (params = {}) =>
  apiCall(() => client.get('/api/support/tickets/', { params, _silentToast: true }))

export const createTicket = (fields, files = []) =>
  apiCall(() => client.post('/api/support/tickets/', toFormData(fields, files), MULTI))

export const getMyTicket = (id) =>
  apiCall(() => client.get(`/api/support/tickets/${id}/`, { _silentToast: true }))

export const replyTicket = (id, body, files = []) =>
  apiCall(() => client.post(`/api/support/tickets/${id}/reply/`, toFormData({ body }, files), MULTI))

export const closeTicket = (id, satisfaction) =>
  apiCall(() => client.post(`/api/support/tickets/${id}/close/`, { satisfaction }))

// ── Admin ──────────────────────────────────────────────────────────────────
export const getAdminTickets = (params = {}) =>
  apiCall(() => client.get('/api/admin/support/tickets/', { params, _silentToast: true }))

export const getAdminTicket = (id) =>
  apiCall(() => client.get(`/api/admin/support/tickets/${id}/`, { _silentToast: true }))

export const replyAdminTicket = (id, body, files = [], isInternal = false) =>
  apiCall(() => client.post(`/api/admin/support/tickets/${id}/reply/`,
    toFormData({ body, is_internal: isInternal ? 'true' : 'false' }, files), MULTI))

/** action: assign | change_status | change_priority | close | reopen | merge */
export const ticketAction = (id, payload) =>
  apiCall(() => client.post(`/api/admin/support/tickets/${id}/actions/`, payload))

export const getSupportAgents = () =>
  apiCall(() => client.get('/api/admin/support/agents/', { _silentToast: true }))

export const getSupportAnalytics = () =>
  apiCall(() => client.get('/api/admin/support/analytics/', { _silentToast: true }))

// ── Shared constants ─────────────────────────────────────────────────────────
export const TICKET_CATEGORIES = [
  { value: 'billing', label: 'Billing' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'pos', label: 'POS' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'accounting', label: 'Accounting' },
  { value: 'technical', label: 'Technical Issue' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'general', label: 'General Inquiry' },
]
export const TICKET_PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
]
export const TICKET_STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
]

export const STATUS_STYLE = {
  open: 'bg-sky-100 text-sky-700', pending: 'bg-amber-100 text-amber-700',
  in_progress: 'bg-indigo-100 text-indigo-700', resolved: 'bg-emerald-100 text-emerald-700',
  closed: 'bg-gray-200 text-gray-600',
}
export const PRIORITY_STYLE = {
  low: 'bg-gray-100 text-gray-600', medium: 'bg-sky-100 text-sky-700',
  high: 'bg-amber-100 text-amber-700', urgent: 'bg-rose-100 text-rose-700',
}
