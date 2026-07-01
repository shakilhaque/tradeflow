/**
 * DateRangePicker — two date inputs (from / to) with quick-select presets.
 *
 * Props:
 *   from        string  YYYY-MM-DD
 *   to          string  YYYY-MM-DD
 *   onChange    ({ from, to }) => void
 *   onApply     () => void   — called when "Apply" button clicked
 *   loading     bool
 */
export default function DateRangePicker({ from, to, onChange, onApply, loading = false }) {
  const today    = new Date().toISOString().slice(0, 10)
  const thisYear = today.slice(0, 4)

  const presets = [
    {
      label: 'Today',
      from: today, to: today,
    },
    {
      label: 'This Week',
      from: getMonday(new Date()).toISOString().slice(0, 10),
      to:   today,
    },
    {
      label: 'This Month',
      from: `${today.slice(0, 7)}-01`,
      to:   today,
    },
    {
      label: 'Last Month',
      from: lastMonthStart(),
      to:   lastMonthEnd(),
    },
    {
      label: 'This Year',
      from: `${thisYear}-01-01`,
      to:   today,
    },
    {
      label: 'Last 30 Days',
      from: daysAgo(30),
      to:   today,
    },
    {
      label: 'Last 90 Days',
      from: daysAgo(90),
      to:   today,
    },
  ]

  const applyPreset = (preset) => {
    onChange({ from: preset.from, to: preset.to })
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
      {/* Preset chips */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p)}
            className={[
              'px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
              from === p.from && to === p.to
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400 hover:text-brand-600',
            ].join(' ')}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom range inputs */}
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={from}
          max={to || today}
          onChange={(e) => onChange({ from: e.target.value, to })}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700
                     outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
        />
        <span className="text-gray-400 text-sm">→</span>
        <input
          type="date"
          value={to}
          min={from}
          max={today}
          onChange={(e) => onChange({ from, to: e.target.value })}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700
                     outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
        />
        <button
          onClick={onApply}
          disabled={!from || !to || loading}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
                     bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 transition-colors"
        >
          {loading ? (
            <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
          )}
          Run Report
        </button>
      </div>
    </div>
  )
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function getMonday(d) {
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(d.setDate(diff))
}

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function lastMonthStart() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10)
}

function lastMonthEnd() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10)
}
