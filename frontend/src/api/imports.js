import { client, apiCall } from './client'

/** Download CSV template (returns a Blob) */
export const downloadTemplate = (importType) =>
  client
    .get(`/api/imports/${importType.toLowerCase()}/template/`, { responseType: 'blob' })
    .then((r) => r.data)

/**
 * Step 1: ask the server what it thinks the columns mean.
 * Returns { headers, row_count, sample_rows, mapping: { matches, extras } }.
 * No DB writes — used by the "Map columns" wizard step.
 */
export const analyzeImport = (importType, file) => {
  const fd = new FormData()
  fd.append('file', file)
  return apiCall(() =>
    client.post(`/api/imports/${importType.toLowerCase()}/analyze/`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  )
}

/**
 * Upload a CSV/XLSX file for validation.
 * `mapping` (optional) is the operator-confirmed {our_field: source_header} dict
 * from the wizard. When omitted, the server auto-detects.
 * Returns the ImportBatch ({ id, status, total_rows, valid_rows, error_count, errors, ... }).
 */
export const validateImport = (importType, file, mapping = null) => {
  const fd = new FormData()
  fd.append('file', file)
  if (mapping) fd.append('mapping_json', JSON.stringify(mapping))
  return apiCall(() =>
    client.post(`/api/imports/${importType.toLowerCase()}/validate/`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  )
}

/** Commit a previously-validated batch. */
export const commitImport = (batchId) =>
  apiCall(() => client.post(`/api/imports/${batchId}/commit/`))
