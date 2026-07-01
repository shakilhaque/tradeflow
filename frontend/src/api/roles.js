/**
 * Tenant Roles API client.
 * Endpoints live under /api/roles/ via accounts/urls.py DRF router.
 * The list endpoint returns built-in + custom roles in one array;
 * mutations only succeed on custom rows (the backend rejects writes to
 * built-ins, but the UI hides the controls anyway).
 */
import { client, apiCall } from './client'

export const getRoles = () =>
  apiCall(() => client.get('/api/roles/'))

export const createRole = (data) =>
  apiCall(() => client.post('/api/roles/', data))

export const updateRole = (id, data) =>
  apiCall(() => client.patch(`/api/roles/${id}/`, data))

export const deleteRole = (id) =>
  apiCall(() => client.delete(`/api/roles/${id}/`))
