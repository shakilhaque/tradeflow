import { client, apiCall } from './client'

// ── System Settings ───────────────────────────────────────────────────────────

export const getAllSettings = () =>
  apiCall(() => client.get('/api/settings/'))

export const bulkUpdateSettings = (data) =>
  apiCall(() => client.patch('/api/settings/', data))

export const getSetting = (key) =>
  apiCall(() => client.get(`/api/settings/${key}/`))

export const updateSetting = (key, value) =>
  apiCall(() => client.put(`/api/settings/${key}/`, { value }))

// ── Tax Groups ────────────────────────────────────────────────────────────────

export const getTaxGroups = () =>
  apiCall(() => client.get('/api/settings/tax-groups/'))

export const createTaxGroup = (data) =>
  apiCall(() => client.post('/api/settings/tax-groups/', data))

export const updateTaxGroup = (id, data) =>
  apiCall(() => client.put(`/api/settings/tax-groups/${id}/`, data))

export const deleteTaxGroup = (id) =>
  apiCall(() => client.delete(`/api/settings/tax-groups/${id}/`))
