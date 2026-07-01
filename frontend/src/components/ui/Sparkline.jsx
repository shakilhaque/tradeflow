/**
 * Tiny inline-SVG sparkline used by KpiCard.
 * Accepts a number[] and renders a smooth area with a top stroke.
 */
const ACCENTS = {
  brand:  { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.10)' },
  teal:   { stroke: '#059669', fill: 'rgba(5, 150, 105, 0.10)' },
  amber:  { stroke: '#d97706', fill: 'rgba(217, 119, 6, 0.12)' },
  rose:   { stroke: '#e11d48', fill: 'rgba(225, 29, 72, 0.12)' },
}

export default function Sparkline({ data = [], accent = 'brand', className = '' }) {
  if (!data || data.length < 2) {
    return <div className={className} />
  }

  const w = 100
  const h = 32
  const padding = 2
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const stepX = (w - padding * 2) / (data.length - 1)
  const points = data.map((v, i) => {
    const x = padding + i * stepX
    const y = h - padding - ((v - min) / range) * (h - padding * 2)
    return [x, y]
  })

  // Smooth path using catmull-rom-ish interpolation
  let path = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]
    path += ` L ${x} ${y}`
  }
  const areaPath = `${path} L ${points[points.length - 1][0]} ${h} L ${points[0][0]} ${h} Z`

  const { stroke, fill } = ACCENTS[accent] ?? ACCENTS.brand

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className}>
      <path d={areaPath} fill={fill} stroke="none" />
      <path d={path}     fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
