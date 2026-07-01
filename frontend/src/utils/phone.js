// Bangladesh mobile display helper.
//
// Some legacy rows / imported CSVs stored the phone WITHOUT the
// leading "0" (e.g. "1712345678" instead of "01712345678"). When the
// CustomersPage / All Sales / Shipments table rendered the raw string
// it looked broken to the cashier. fmtPhone() normalises any 10-digit
// BD national number to the 11-digit "01XXXXXXXXX" form for display.
// Leaves non-BD or already-correct strings unchanged so it's safe to
// run on every render.
export function fmtPhone(p) {
  if (p == null) return ''
  const s = String(p).trim()
  if (!s) return ''
  // Strip non-digits to detect well-known shapes; keep the original
  // for anything else (so international numbers, landlines, etc. stay
  // intact).
  const d = s.replace(/\D/g, '')
  // 10 digits starting with 1 → missing leading 0 → prepend.
  if (d.length === 10 && d.startsWith('1')) return `0${d}`
  // 13 digits starting with 880 (country code, no plus) → BD national.
  if (d.length === 13 && d.startsWith('880')) return `0${d.slice(3)}`
  // 14 digits starting with 8800 → odd export quirk; normalise.
  if (d.length === 14 && d.startsWith('8800')) return `0${d.slice(4)}`
  return s
}
