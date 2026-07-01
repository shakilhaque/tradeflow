import { client, apiCall } from './client'

/**
 * Platform-admin bulk SMS — broadcast a single message to every tenant
 * (or a custom recipient list provided via xlsx or JSON).
 *
 * Backed by /api/admin/bulk-sms/*. Auth tier: staff / superuser only
 * (the backend enforces; we just send the request).
 */

/**
 * Download the canonical "all clients" xlsx so the admin can edit it
 * and re-upload a custom recipient subset. Returns the raw Blob so
 * the caller can trigger a browser download.
 */
export const exportClientsXlsx = () =>
  apiCall(() => client.get('/api/admin/bulk-sms/export/', { responseType: 'blob' }))

/**
 * Send the bulk SMS.
 *
 * @param {Object} args
 * @param {string} args.message  — body, ≤ 1000 chars
 * @param {File}   [args.file]   — optional xlsx with a 'phone' column
 * @param {string[]} [args.phones] — optional explicit JSON list of numbers
 *
 * If neither file nor phones is supplied, the backend broadcasts to
 * EVERY tenant owner on the platform.
 *
 * Returns: { backend, sender_id, total_input, attempted, sent, failed,
 *            invalid_inputs, failed_numbers }
 */
export const sendBulkSms = ({ message, file, phones }) => {
  if (file) {
    const fd = new FormData()
    fd.append('message', message)
    fd.append('file', file)
    return apiCall(() =>
      client.post('/api/admin/bulk-sms/send/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    )
  }
  return apiCall(() =>
    client.post('/api/admin/bulk-sms/send/', { message, phones }),
  )
}
