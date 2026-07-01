import { client, apiCall, storage } from './client'

/**
 * Tenant login.
 *
 * The first parameter is a free-form identifier: either the user's mobile
 * number (preferred — what the form now collects) or their email. The
 * backend auto-detects which by the presence of '@'. Returns
 * { access, refresh, role, permissions, email, name, user_id }.
 */
export async function login(identifier, password) {
  return apiCall(() =>
    client.post('/api/auth/login/', { identifier, password })
  )
}

/**
 * Platform admin login (staff/superuser only).
 */
export async function loginAdmin(email, password) {
  return apiCall(() =>
    client.post('/api/auth/admin/login/', { email, password })
  )
}

/**
 * Verify a first-login SMS OTP.
 * Returns { setup_token, expires_at, user: { username, name, phone_mask } }.
 * Caller should then redirect to /set-password?token=<setup_token>.
 */
export async function loginWithOtp(username, otp) {
  return apiCall(() =>
    client.post('/api/auth/login-otp/', { username, otp })
  )
}

/**
 * Verify an OTP by a generic identifier (username / email / mobile) — used by
 * the forgot-password reset flow where only the mobile number is known.
 */
export async function verifyOtpByIdentifier(identifier, otp) {
  return apiCall(() =>
    client.post('/api/auth/login-otp/', { identifier, otp })
  )
}

/**
 * Re-issue an SMS OTP. Always resolves to 200 — even for unknown identifiers
 * (anti-enumeration). In DEBUG / console-backend mode the response also
 * carries `_dev_otp` so the dev frontend can auto-fill it.
 */
export async function resendOtp({ username = '', email = '', identifier = '' } = {}) {
  return apiCall(() =>
    client.post('/api/auth/resend-otp/', { username, email, identifier })
  )
}

/**
 * Self-service forgot-password: send a reset OTP by SMS to the account that
 * matches `identifier` (username / email / mobile). Always 200 (anti-enum).
 */
export async function forgotPassword(identifier) {
  return apiCall(() =>
    client.post('/api/auth/forgot-password/', { identifier })
  )
}

/**
 * Set first-time password using the one-time token issued by /login-otp/.
 */
export async function setPassword(token, newPassword, confirmPassword) {
  return apiCall(() =>
    client.post('/api/set-password/', {
      token,
      new_password: newPassword,
      confirm_password: confirmPassword,
    })
  )
}

/**
 * Request a new setup email if the original link expired.
 */
export async function resendSetupLink(email) {
  return apiCall(() =>
    client.post('/api/resend-setup-link/', { email })
  )
}

/**
 * Logout — clear local tokens. The refresh token is rotated so the old one
 * is already invalid; no server-side logout endpoint required.
 */
export function logout() {
  storage.clearTokens()
  storage.clearUser()
}

/**
 * Fetch the current user's profile, including profile_picture URL.
 */
export async function getMe() {
  return apiCall(() => client.get('/api/auth/me/'))
}

/**
 * Patch the current user's editable profile fields (name, phone, business_name).
 */
export async function updateMe(payload) {
  return apiCall(() => client.patch('/api/auth/me/', payload))
}

/**
 * Upload a new profile picture. `file` must be a File / Blob.
 * Returns { url, profile_picture }.
 */
export async function uploadAvatar(file) {
  const fd = new FormData()
  fd.append('file', file)
  return apiCall(() =>
    client.post('/api/auth/me/avatar/', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  )
}

/**
 * Remove the current profile picture (revert to initials).
 */
export async function deleteAvatar() {
  return apiCall(() => client.delete('/api/auth/me/avatar/'))
}
