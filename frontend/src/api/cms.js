import { client, apiCall } from './client'

/**
 * Public CMS content for the marketing site. Returns { blocks, collections }.
 * Pages read this and fall back to their built-in defaults for missing keys.
 */
export async function getPublicCms() {
  return apiCall(() => client.get('/api/cms/public/', { _silentToast: true }))
}
