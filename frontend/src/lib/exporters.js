/**
 * Lightweight table exporters — CSV, Excel (.xlsx) and PDF (print).
 *
 *   exportCsv(filename, headers, rows)
 *   exportExcel(filename, headers, rows)   // dynamic-imports the xlsx lib
 *   exportPdf(title, headers, rows)        // opens a printable window
 *
 * `headers` is an array of column labels. `rows` is an array of arrays whose
 * cells line up with `headers`. Cells are coerced to strings.
 */

const _download = (blob, filename) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const _csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportCsv(filename, headers, rows) {
  const lines = [headers.map(_csvCell).join(',')]
  rows.forEach((r) => lines.push(r.map(_csvCell).join(',')))
  // BOM so Excel opens UTF-8 (Bangla / ৳) correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  _download(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`)
}

export async function exportExcel(filename, headers, rows) {
  try {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
  } catch {
    // Fall back to CSV if the xlsx lib isn't available for any reason.
    exportCsv(filename, headers, rows)
  }
}

export function exportPdf(title, headers, rows) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const thead = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>`
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px}
      h1{font-size:18px;margin:0 0 4px} .meta{color:#666;font-size:12px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left}
      th{background:#f3f4f6}
      @media print{.noprint{display:none}}
    </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="meta">Generated ${new Date().toLocaleString()}</div>
    <button class="noprint" onclick="window.print()" style="margin-bottom:12px;padding:8px 16px;cursor:pointer">Print / Save as PDF</button>
    <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    <script>window.onload=function(){setTimeout(function(){window.print()},300)}</script>
    </body></html>`
  const w = window.open('', '_blank')
  if (!w) return
  w.document.open()
  w.document.write(html)
  w.document.close()
}
