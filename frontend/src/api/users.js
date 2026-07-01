/**
 * Tenant User Management API client.
 *
 * Endpoints live under /api/users/ (mounted from accounts/urls.py via the
 * DRF router). All calls require the authenticated JWT — the axios client
 * attaches it automatically.
 */
import { client, apiCall } from './client'

export const getUsers = (params = {}) =>
  apiCall(() => client.get('/api/users/', { params }))

export const getUser = (id) =>
  apiCall(() => client.get(`/api/users/${id}/`))

export const createUser = (data) =>
  apiCall(() => client.post('/api/users/', data))

export const updateUser = (id, data) =>
  apiCall(() => client.patch(`/api/users/${id}/`, data))

export const deleteUser = (id) =>
  apiCall(() => client.delete(`/api/users/${id}/`))
