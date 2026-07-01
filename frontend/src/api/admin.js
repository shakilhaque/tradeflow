import { client, apiCall } from './client'

export async function getAdminOverview() {
  return apiCall(() => client.get('/api/admin/overview/'))
}

/**
 * Full client directory for the admin "Client's Info" page.
 * Returns { clients: [...full signup fields...], total }.
 */
export async function getAdminClientsInfo() {
  return apiCall(() => client.get('/api/admin/clients-info/'))
}

export async function getAdminAnalytics() {
  return apiCall(() => client.get('/api/admin/analytics/'))
}

export async function getAdminUsers() {
  return apiCall(() => client.get('/api/admin/users/'))
}

export async function createAdminUser(payload) {
  return apiCall(() => client.post('/api/admin/users/', payload))
}

export async function updateAdminUser(id, payload) {
  return apiCall(() => client.patch(`/api/admin/users/${id}/`, payload))
}

export async function deleteAdminUser(id) {
  return apiCall(() => client.delete(`/api/admin/users/${id}/`))
}

/** Catalogue of platform-admin sections that can be granted to a sub-admin. */
export async function getAdminPermissionCatalog() {
  return apiCall(() => client.get('/api/admin/permissions/'))
}

export async function cancelPendingPayment(id) {
  return apiCall(() => client.post(`/api/admin/payments/${id}/cancel/`))
}

export async function provisionTenant(userId) {
  return apiCall(() => client.post(`/api/admin/tenants/${userId}/provision/`))
}

export async function deleteClient(userId) {
  return apiCall(() => client.delete(`/api/admin/clients/${userId}/`))
}

// ── Subscription Management (Super-Admin) ──────────────────────────────
export async function getAdminSubscriptions(params = {}) {
  return apiCall(() => client.get('/api/admin/subscriptions/', { params }))
}

export async function getAdminSubscriptionPlans() {
  return apiCall(() => client.get('/api/admin/subscriptions/plans/'))
}

export async function getAdminSubscriptionDetail(id) {
  return apiCall(() => client.get(`/api/admin/subscriptions/${id}/`))
}

/** action: change_plan | extend | bonus_days | change_billing_date | suspend | reactivate */
export async function adminSubscriptionAction(id, payload) {
  return apiCall(() => client.post(`/api/admin/subscriptions/${id}/actions/`, payload))
}

// ── Website CMS (Super-Admin) ──────────────────────────────────────────
export async function getCmsBlocks() {
  return apiCall(() => client.get('/api/admin/cms/blocks/', { _silentToast: true }))
}
export async function saveCmsBlock(payload) {
  return apiCall(() => client.put('/api/admin/cms/blocks/', payload))
}
export async function getCmsItems(collection) {
  return apiCall(() => client.get('/api/admin/cms/items/', { params: { collection }, _silentToast: true }))
}
export async function createCmsItem(payload) {
  return apiCall(() => client.post('/api/admin/cms/items/', payload))
}
export async function updateCmsItem(id, payload) {
  return apiCall(() => client.patch(`/api/admin/cms/items/${id}/`, payload))
}
export async function deleteCmsItem(id) {
  return apiCall(() => client.delete(`/api/admin/cms/items/${id}/`))
}
export async function reorderCmsItems(collection, order) {
  return apiCall(() => client.post('/api/admin/cms/items/reorder/', { collection, order }))
}
export async function getCmsMedia(folder = '') {
  return apiCall(() => client.get('/api/admin/cms/media/', { params: folder ? { folder } : {}, _silentToast: true }))
}
export async function uploadCmsMedia(file, folder = '', name = '') {
  const fd = new FormData()
  fd.append('file', file)
  if (folder) fd.append('folder', folder)
  if (name) fd.append('name', name)
  return apiCall(() => client.post('/api/admin/cms/media/', fd, { headers: { 'Content-Type': undefined } }))
}
export async function deleteCmsMedia(id) {
  return apiCall(() => client.delete(`/api/admin/cms/media/${id}/`))
}
export async function getCmsAudit() {
  return apiCall(() => client.get('/api/admin/cms/audit/', { _silentToast: true }))
}

// ── Coupons & Promotions (Super-Admin) ─────────────────────────────────
export async function getAdminCoupons(params = {}) {
  return apiCall(() => client.get('/api/admin/coupons/', { params, _silentToast: true }))
}
export async function getAdminCouponAnalytics() {
  return apiCall(() => client.get('/api/admin/coupons/analytics/', { _silentToast: true }))
}
export async function getAdminCouponAudit(params = {}) {
  return apiCall(() => client.get('/api/admin/coupons/audit/', { params, _silentToast: true }))
}
export async function createCoupon(data) {
  return apiCall(() => client.post('/api/admin/coupons/', data))
}
export async function updateCoupon(id, data) {
  return apiCall(() => client.patch(`/api/admin/coupons/${id}/`, data))
}
export async function deleteCoupon(id) {
  return apiCall(() => client.delete(`/api/admin/coupons/${id}/`))
}
/** action: activate | deactivate | duplicate */
export async function couponAction(id, action) {
  return apiCall(() => client.post(`/api/admin/coupons/${id}/actions/`, { action }))
}
export async function getAdminCampaigns() {
  return apiCall(() => client.get('/api/admin/campaigns/', { _silentToast: true }))
}
export async function createCampaign(data) {
  return apiCall(() => client.post('/api/admin/campaigns/', data))
}
export async function updateCampaign(id, data) {
  return apiCall(() => client.patch(`/api/admin/campaigns/${id}/`, data))
}
export async function deleteCampaign(id) {
  return apiCall(() => client.delete(`/api/admin/campaigns/${id}/`))
}

// ── Payment Management (Super-Admin) ───────────────────────────────────
export async function getAdminPayments(params = {}) {
  return apiCall(() => client.get('/api/admin/payments/', { params, _silentToast: true }))
}
export async function getAdminPaymentDetail(id) {
  return apiCall(() => client.get(`/api/admin/payments/${id}/`, { _silentToast: true }))
}
/** action: verify | retry | mark_paid | mark_failed | refund */
export async function adminPaymentAction(id, payload) {
  return apiCall(() => client.post(`/api/admin/payments/${id}/actions/`, payload))
}
export async function getAdminPaymentAnalytics(params = {}) {
  return apiCall(() => client.get('/api/admin/payments/analytics/', { params, _silentToast: true }))
}
export async function getAdminPaymentAudit(params = {}) {
  return apiCall(() => client.get('/api/admin/payments/audit/', { params, _silentToast: true }))
}
export async function getAdminPaymentGateways() {
  return apiCall(() => client.get('/api/admin/payment-gateways/', { _silentToast: true }))
}
export async function savePaymentGateway(payload) {
  return apiCall(() => client.put('/api/admin/payment-gateways/', payload))
}
export async function testPaymentGateway(code) {
  return apiCall(() => client.post(`/api/admin/payment-gateways/${code}/test/`))
}

// ── Revenue & Billing Analytics (Super-Admin) ──────────────────────────
export async function getAdminRevenueAnalytics(params = {}) {
  return apiCall(() => client.get('/api/admin/revenue-analytics/', { params, _silentToast: true }))
}

// ── Tenant Management (Super-Admin) ────────────────────────────────────
export async function getAdminTenants(params = {}) {
  return apiCall(() => client.get('/api/admin/tenants/', { params, _silentToast: true }))
}
export async function getAdminTenantPlans() {
  return apiCall(() => client.get('/api/admin/tenants/plans/', { _silentToast: true }))
}
export async function getAdminTenantDetail(userId) {
  return apiCall(() => client.get(`/api/admin/tenants/${userId}/`, { _silentToast: true }))
}
/** action: change_plan | extend | bonus_days | suspend | reactivate | edit | reset_password | impersonate */
export async function adminTenantAction(userId, payload) {
  return apiCall(() => client.post(`/api/admin/tenants/${userId}/actions/`, payload))
}

// ── Tenant Users (Super-Admin) ─────────────────────────────────────────
/** Cross-tenant user directory. params: { search, tenant, branch, role, status, sort_by, sort_dir, page, limit } */
export async function getTenantUsers(params = {}) {
  return apiCall(() => client.get('/api/admin/tenant-users/', { params, _silentToast: true }))
}
export async function getTenantUsersAnalytics() {
  return apiCall(() => client.get('/api/admin/tenant-users/analytics/', { _silentToast: true }))
}
export async function getTenantUserDetail(id) {
  return apiCall(() => client.get(`/api/admin/tenant-users/${id}/`, { _silentToast: true }))
}
export async function updateTenantUser(id, payload) {
  return apiCall(() => client.patch(`/api/admin/tenant-users/${id}/`, payload))
}
/** action: lock | unlock | activate | deactivate | force_logout | reset_password */
export async function tenantUserAction(id, payload) {
  return apiCall(() => client.post(`/api/admin/tenant-users/${id}/actions/`, payload))
}

// ── Subscription Plans Management (Super-Admin) ────────────────────────
export async function getAdminPlans(params = {}) {
  return apiCall(() => client.get('/api/admin/plans/', { params }))
}
export async function createAdminPlan(data) {
  return apiCall(() => client.post('/api/admin/plans/', data))
}
export async function updateAdminPlan(id, data) {
  return apiCall(() => client.patch(`/api/admin/plans/${id}/`, data))
}
export async function deleteAdminPlan(id) {
  return apiCall(() => client.delete(`/api/admin/plans/${id}/`))
}
export async function cloneAdminPlan(id) {
  return apiCall(() => client.post(`/api/admin/plans/${id}/clone/`))
}
export async function toggleAdminPlanActive(id) {
  return apiCall(() => client.post(`/api/admin/plans/${id}/toggle_active/`))
}
export async function getAdminPlanSubscribers(id) {
  return apiCall(() => client.get(`/api/admin/plans/${id}/subscribers/`, { _silentToast: true }))
}
export async function getAdminPlanUsage(id) {
  return apiCall(() => client.get(`/api/admin/plans/${id}/usage/`, { _silentToast: true }))
}
