/**
 * Pure-SVG chart primitives. No external library — keeps the bundle lean and
 * matches the existing Sparkline / KpiCard visual language.
 *
 * Exports:
 *   <LineChart  data height accent yFormat />
 *   <BarChart   data height accent yFormat horizontal />
 *   <DonutChart data size   thickness centerLabel centerValue />
 *   <ChartLegend items />
 *
 * Data shapes:
 *   LineChart / BarChart:  [{ label: string, value: number }, ...]
 *   DonutChart:            [{ label: string, value: number, color?: string }, ...]
 */
import { useState } from 'react'

const PALETTE = ['#2563eb', '#059669', '#d97706', '#e11d48', '#7c3aed', '#0891b2', '#65a30d', '#db2777']

const ACCENTS = {
  brand:   { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.12)',  dot: '#2563eb' },
  emerald: { stroke: '#059669', fill: 'rgba(5, 150, 105, 0.12)',  dot: '#059669' },
  amber:   { stroke: '#d97706', fill: 'rgba(217, 119, 6, 0.14)',  dot: '#d97706' },
  rose:    { stroke: '#e11d48', fill: 'rgba(225, 29, 72, 0.14)',  dot: '#e11d48' },
  violet:  { stroke: '#7c3aed', fill: 'rgba(124, 58, 237, 0.14)', dot: '#7c3aed' },
}

const niceTickStep = (range) => {
  if (range <= 0) return 1
  const raw = range / 4
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  let step
  if (norm < 1.5) step = 1
  else if (norm < 3) step = 2
  else if (norm < 7) step = 5
  else step = 10
  return step * mag
}

// ─────────────────────────────────────────────────────────────────────────────
// LineChart
// ─────────────────────────────────────────────────────────────────────────────

export function LineChart({
  data = [],
  height = 220,
  accent = 'brand',
  yFormat = (v) => v.toLocaleString(),
  showDots = true,
}) {
  const [hover, setHover] = useState(null)
  const acc = ACCENTS[accent] ?? ACCENTS.brand

  if (!data.length) {
    return <div className="flex items-center justify-center text-sm text-gray-400" style={{ height }}>No data</div>
  }

  const w = 600
  const h = height
  const padL = 50, padR = 12, padT = 12, padB = 28
  const innerW = w - padL - padR
  const innerH = h - padT - padB

  const values = data.map((d) => Number(d.value || 0))
  const maxV   = Math.max(...values, 0)
  const minV   = Math.min(...values, 0)
  const range  = (maxV - minV) || 1
  const step   = niceTickStep(range)
  const yMax   = Math.ceil(maxV / step) * step || step
  const yMin   = Math.floor(minV / step) * step
  const yRange = (yMax - yMin) || step

  const xFor = (i) => padL + (data.length === 1 ? innerW / 2 : (i * innerW) / (data.length - 1))
  const yFor = (v) => padT + innerH - ((v - yMin) / yRange) * innerH

  const points = data.map((d, i) => [xFor(i), yFor(Number(d.value || 0))])
  let path  = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) path += ` L ${points[i][0]} ${points[i][1]}`
  const areaPath = `${path} L ${points[points.length - 1][0]} ${padT + innerH} L ${points[0][0]} ${padT + innerH} Z`

  // Y-axis ticks (5 lines)
  const ticks = []
  for (let v = yMin; v <= yMax + 0.0001; v += step) ticks.push(v)

  // X-axis labels — show ~6 evenly distributed
  const labelEvery = Math.max(1, Math.ceil(data.length / 6))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
        {/* Y grid + labels */}
        {ticks.map((v, i) => {
          const y = yFor(v)
          return (
            <g key={i}>
              <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="#f1f5f9" strokeWidth="1" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
                {yFormat(v)}
              </text>
            </g>
          )
        })}

        {/* X labels */}
        {data.map((d, i) => {
          if (i % labelEvery !== 0 && i !== data.length - 1) return null
          return (
            <text
              key={i}
              x={xFor(i)}
              y={h - 8}
              textAnchor="middle"
              fontSize="10"
              fill="#94a3b8"
            >
              {d.label}
            </text>
          )
        })}

        {/* Area + line */}
        <path d={areaPath} fill={acc.fill} />
        <path d={path} fill="none" stroke={acc.stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Hover dots */}
        {showDots && points.map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="3" fill="white" stroke={acc.dot} strokeWidth="2" />
            {/* Invisible hit area */}
            <circle
              cx={x} cy={y} r="14" fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
            {hover === i && (
              <g>
                <line x1={x} x2={x} y1={padT} y2={padT + innerH} stroke={acc.dot} strokeWidth="1" strokeDasharray="3,3" opacity="0.4" />
                <circle cx={x} cy={y} r="5" fill={acc.dot} />
              </g>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute rounded-md bg-gray-900 text-white text-[11px] px-2 py-1 shadow-lg"
          style={{
            left:  `${(points[hover][0] / w) * 100}%`,
            top:   `${(points[hover][1] / h) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 10px))',
            whiteSpace: 'nowrap',
          }}
        >
          <div className="font-semibold">{yFormat(data[hover].value)}</div>
          <div className="text-gray-300 text-[10px]">{data[hover].label}</div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// BarChart (vertical or horizontal)
// ─────────────────────────────────────────────────────────────────────────────

export function BarChart({
  data = [],
  height = 220,
  accent = 'brand',
  yFormat = (v) => v.toLocaleString(),
  horizontal = false,
}) {
  const [hover, setHover] = useState(null)
  const acc = ACCENTS[accent] ?? ACCENTS.brand

  if (!data.length) {
    return <div className="flex items-center justify-center text-sm text-gray-400" style={{ height }}>No data</div>
  }

  const w = 600
  const h = height
  const padL = horizontal ? 110 : 50
  const padR = 12, padT = 12, padB = 28
  const innerW = w - padL - padR
  const innerH = h - padT - padB

  const values = data.map((d) => Number(d.value || 0))
  const maxV   = Math.max(...values, 1)
  const step   = niceTickStep(maxV)
  const yMax   = Math.ceil(maxV / step) * step || step

  if (horizontal) {
    const rowH = innerH / data.length
    const barH = Math.min(28, rowH * 0.65)
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
        {/* Axis labels */}
        {data.map((d, i) => {
          const y = padT + i * rowH + rowH / 2
          const v = Number(d.value || 0)
          const len = (v / yMax) * innerW
          return (
            <g key={i}
               onMouseEnter={() => setHover(i)}
               onMouseLeave={() => setHover(null)}>
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="11" fill="#475569" className="truncate">
                {d.label.length > 18 ? d.label.slice(0, 17) + '…' : d.label}
              </text>
              <rect
                x={padL} y={y - barH / 2}
                width={Math.max(2, len)} height={barH}
                fill={hover === i ? acc.dot : acc.stroke}
                rx="4"
                opacity={hover === i ? 1 : 0.85}
              />
              <text
                x={padL + Math.max(2, len) + 6}
                y={y + 3}
                fontSize="10"
                fill="#64748b"
              >
                {yFormat(v)}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }

  // Vertical bars
  const colW = innerW / data.length
  const barW = Math.min(40, colW * 0.6)

  const ticks = []
  for (let v = 0; v <= yMax + 0.0001; v += step) ticks.push(v)

  const labelEvery = Math.max(1, Math.ceil(data.length / 8))

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      {/* Y grid */}
      {ticks.map((v, i) => {
        const y = padT + innerH - (v / yMax) * innerH
        return (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="#f1f5f9" />
            <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {yFormat(v)}
            </text>
          </g>
        )
      })}

      {data.map((d, i) => {
        const v = Number(d.value || 0)
        const barH = (v / yMax) * innerH
        const x = padL + i * colW + (colW - barW) / 2
        const y = padT + innerH - barH
        return (
          <g key={i}
             onMouseEnter={() => setHover(i)}
             onMouseLeave={() => setHover(null)}>
            <rect
              x={x} y={y}
              width={barW} height={Math.max(2, barH)}
              fill={hover === i ? acc.dot : acc.stroke}
              opacity={hover === i ? 1 : 0.85}
              rx="3"
            />
            {(i % labelEvery === 0 || i === data.length - 1) && (
              <text x={x + barW / 2} y={h - 8} textAnchor="middle" fontSize="10" fill="#94a3b8">
                {d.label}
              </text>
            )}
            {hover === i && (
              <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="11" fill="#0f172a" fontWeight="600">
                {yFormat(v)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DonutChart
// ─────────────────────────────────────────────────────────────────────────────

export function DonutChart({
  data = [],
  size = 200,
  thickness = 28,
  centerLabel = '',
  centerValue = '',
}) {
  const [hover, setHover] = useState(null)
  if (!data.length) {
    return <div className="flex items-center justify-center text-sm text-gray-400" style={{ height: size, width: size }}>No data</div>
  }

  const total = data.reduce((s, d) => s + Number(d.value || 0), 0)
  const r     = size / 2
  const innerR = r - thickness
  const cx = r, cy = r

  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-sm text-gray-400" style={{ height: size, width: size }}>
        No data
      </div>
    )
  }

  let cursor = -Math.PI / 2  // start at top
  const slices = data.map((d, i) => {
    const v = Number(d.value || 0)
    const angle = (v / total) * Math.PI * 2
    const start = cursor
    const end   = cursor + angle
    cursor = end
    const color = d.color || PALETTE[i % PALETTE.length]

    const x0 = cx + Math.cos(start) * r
    const y0 = cy + Math.sin(start) * r
    const x1 = cx + Math.cos(end) * r
    const y1 = cy + Math.sin(end) * r
    const x2 = cx + Math.cos(end) * innerR
    const y2 = cy + Math.sin(end) * innerR
    const x3 = cx + Math.cos(start) * innerR
    const y3 = cy + Math.sin(start) * innerR
    const largeArc = angle > Math.PI ? 1 : 0
    const path = [
      `M ${x0} ${y0}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`,
      `L ${x2} ${y2}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x3} ${y3}`,
      'Z',
    ].join(' ')

    return { path, color, label: d.label, value: v, pct: (v / total) * 100 }
  })

  return (
    <div className="flex items-center justify-center" style={{ width: size, height: size, position: 'relative' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {slices.map((s, i) => (
          <path
            key={i}
            d={s.path}
            fill={s.color}
            opacity={hover === null || hover === i ? 1 : 0.35}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            style={{ transition: 'opacity 0.15s' }}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
        {hover !== null ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 truncate max-w-[80%]">
              {slices[hover].label}
            </div>
            <div className="text-lg font-bold text-gray-900">{slices[hover].pct.toFixed(1)}%</div>
            <div className="text-xs text-gray-500">{slices[hover].value.toLocaleString()}</div>
          </>
        ) : (
          <>
            {centerLabel && (
              <div className="text-[10px] uppercase tracking-wider text-gray-500">{centerLabel}</div>
            )}
            <div className="text-lg font-bold text-gray-900">{centerValue || total.toLocaleString()}</div>
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend (used with DonutChart)
// ─────────────────────────────────────────────────────────────────────────────

export function ChartLegend({ items = [], format = (v) => v.toLocaleString() }) {
  if (!items.length) return null
  const total = items.reduce((s, d) => s + Number(d.value || 0), 0)
  return (
    <ul className="space-y-1.5 text-xs">
      {items.map((it, i) => {
        const color = it.color || PALETTE[i % PALETTE.length]
        const pct = total > 0 ? ((Number(it.value || 0) / total) * 100).toFixed(1) : '0.0'
        return (
          <li key={i} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: color }} />
            <span className="flex-1 text-gray-700 truncate">{it.label}</span>
            <span className="font-medium text-gray-900">{format(Number(it.value || 0))}</span>
            <span className="text-gray-400 text-[10px] w-10 text-right">{pct}%</span>
          </li>
        )
      })}
    </ul>
  )
}

export { PALETTE }
