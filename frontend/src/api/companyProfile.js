import { client, apiCall } from './client'

/**
 * Tenant company-profile API — backed by SystemSetting on the tenant DB.
 *
 * Used by:
 *   - Sidebar header (displays company.name + company.logo_url)
 *   - Settings → Customer Profile page (lets the tenant edit + upload)
 *   - Invoices / receipts (so the header reads the tenant's brand)
 */

/** GET — returns {name, logo_url, address, phone, email, tax_number, website}. */
export const getCompanyProfile = () =>
  apiCall(() => client.get('/api/settings/company-profile/'))

/** PATCH — only fields present in `data` are touched. Empty string clears. */
export const updateCompanyProfile = (data) =>
  apiCall(() => client.patch('/api/settings/company-profile/', data))

/** POST multipart — uploads a logo file, saves it via storage backend,
 *  writes the new URL to company.logo_url, and returns {logo_url}. */
export const uploadCompanyLogo = (file) => {
  const fd = new FormData()
  fd.append('file', file)
  return apiCall(() =>
    client.post('/api/settings/company-profile/logo/', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  )
}
