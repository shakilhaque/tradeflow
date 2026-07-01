import { client, apiCall } from './client'

/**
 * Fetch all active subscription plans (public — no token needed).
 * Returns array of { id, name, price, billing_cycle, max_users, features, ... }
 *
 * `_t` is a cache-buster — without it, an aggressive browser / CDN cache
 * can hold onto a previously-failed response and the pricing page shows
 * "Network Error" until the user hard-refreshes. The query string is
 * ignored by the backend; its only job is to make the URL unique per call.
 */
export async function getPlans() {
  return apiCall(() => client.get('/api/plans/', {
    params:  { _t: Date.now() },
    headers: { 'Cache-Control': 'no-cache' },
  }))
}

/**
 * Public support contact info (email, phone, hours, office address) for the
 * landing-page chatbot. No token required — same source as the dashboard
 * Support card, so the platform owner can change it from the admin panel.
 */
export async function getPublicSupportInfo() {
  return apiCall(() => client.get('/api/public/support/', { _silentToast: true }))
}

/**
 * Live username-availability check used by the Subscribe form. Throttled
 * server-side; debounce in the caller to avoid hammering it on each keystroke.
 *
 * Returns { available: bool, reason: string, suggestions: string[] }.
 */
export async function checkUsernameAvailable(username) {
  return apiCall(() =>
    client.get('/api/auth/check-username/', {
      params:  { username },
      headers: { 'Cache-Control': 'no-cache' },
    })
  )
}

/**
 * Create a pending payment and get the gateway redirect URL.
 * Returns { payment_id, transaction_id, amount, payment_url }
 *
 * For the Multi-Branch (custom) plan, pass `extraBranches` so the backend
 * computes the final amount = base_price + extraBranches × per_branch_fee.
 *
 * `username` is the tenant-chosen login handle — validated server-side
 * for format + uniqueness before the gateway redirect.
 */
export async function subscribe({
  planId, name, username, email, phone, businessName,
  address = '', thana = '', district = '', postalCode = '',
  extraBranches = 0, referralPhone = '', couponCode = '',
}) {
  return apiCall(() =>
    client.post('/api/subscribe/', {
      plan_id:        planId,
      name,
      username,
      email,
      phone,
      business_name:  businessName,
      address,
      thana,
      district,
      postal_code:    postalCode,
      extra_branches: extraBranches,
      referral_phone: referralPhone,
      coupon_code:    couponCode,
    })
  )
}

/**
 * Validate a coupon code against a plan + amount (public — used on checkout).
 * Returns { valid, detail, discount, discount_type, free_trial_days, final_amount }.
 */
export async function validateCoupon({ code, planId, amount, email = '' }) {
  return apiCall(() =>
    client.post('/api/coupons/validate/', {
      code, plan_id: planId, amount, email,
    }, { _silentToast: true })
  )
}

/**
 * Provision a free 14-day trial — no payment.
 * Returns { detail, user_id, subscription_id, trial_expires_on, trial_days }
 */
export async function signupTrial({ name, username, email, phone, businessName, referralPhone = '' }) {
  return apiCall(() =>
    client.post('/api/signup-trial/', {
      name,
      username,
      email,
      phone,
      business_name:  businessName,
      referral_phone: referralPhone,
    })
  )
}

/**
 * Fetch the current user's referral programme summary.
 * Returns { summary, referrals, credits }.
 */
export async function getMyReferrals() {
  return apiCall(() => client.get('/api/me/referrals/'))
}

/**
 * Poll payment status until SUCCESS or FAILED.
 * Returns { transaction_id, status, amount, paid_at }
 */
export async function getPaymentStatus(transactionId) {
  return apiCall(() =>
    client.get(`/api/payment/status/${transactionId}/`)
  )
}

// ── Tenant-side billing (signed-in users) ────────────────────────────────────

/** Compact billing snapshot — used by the BillingGate / banner. */
export async function getBillingSummary() {
  return apiCall(() => client.get('/api/billing/summary/'))
}

/** Full billing status + recent payments. */
export async function getBillingStatus() {
  return apiCall(() => client.get('/api/billing/status/'))
}

/** Initiate a renewal payment. Returns { transaction_id, amount, payment_url }. */
export async function payNow(payload = {}) {
  return apiCall(() => client.post('/api/pay-now/', payload))
}

/** Platform admin — referral programme management. */
export const getAdminReferrals = (params = {}) =>
  apiCall(() => client.get('/api/admin/referrals/', { params }))

export const updateAdminReferral = (id, data) =>
  apiCall(() => client.patch(`/api/admin/referrals/${id}/`, data))

export const deleteAdminReferral = (id) =>
  apiCall(() => client.delete(`/api/admin/referrals/${id}/`))

export const updateAdminReferralCredit = (id, data) =>
  apiCall(() => client.patch(`/api/admin/referral-credits/${id}/`, data))

export const deleteAdminReferralCredit = (id) =>
  apiCall(() => client.delete(`/api/admin/referral-credits/${id}/`))
