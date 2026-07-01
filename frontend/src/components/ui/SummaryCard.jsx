/**
 * SummaryCard — compact KPI tile used inside report pages.
 *
 * Props:
 *   label    string
 *   value    string | number
 *   sub      string   optional sub-label
 *   color    'blue' | 'green' | 'red' | 'yellow' | 'indigo'  default 'blue'
 */
const COLORS = {
  blue:   'bg-blue-50   text-blue-700   border-blue-100',
  green:  'bg-green-50  text-green-700  border-green-100',
  red:    'bg-red-50    text-red-700    border-red-100',
  yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  gray:   'bg-gray-50   text-gray-700   border-gray-100',
}

export default function SummaryCard({ label, value, sub, color = 'blue' }) {
  return (
    <div className={`rounded-2xl border p-5 ${COLORS[color] ?? COLORS.blue}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-1">{label}</p>
      <p className="text-2xl font-bold leading-tight">{value ?? '—'}</p>
      {sub && <p className="mt-1 text-xs opacity-60">{sub}</p>}
    </div>
  )
}
