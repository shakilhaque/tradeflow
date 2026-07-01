import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Global loading indicator driven by in-flight API requests (wired into the
 * axios client). It only appears when a request is actually SLOW (>250ms) so
 * fast calls never flash. Covers every page automatically — no per-page work.
 *
 *   incLoading()/decLoading()  — called by the axios request/response hooks.
 *   <GlobalLoadingBar/>        — mounted once in App; renders the bar.
 *
 * Also exports <Skeleton> / <PageSkeleton> for pages that want the spinner +
 * shimmer-rows placeholder while they load their own data.
 */
let _active = 0
const listeners = new Set()
const emit = () => listeners.forEach((l) => l(_active))

export function incLoading() { _active += 1; emit() }
export function decLoading() { _active = Math.max(0, _active - 1); emit() }

const SHOW_DELAY = 250  // ms — only show the bar for genuinely slow fetches

export function GlobalLoadingBar() {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    const onChange = (active) => {
      if (active > 0) {
        if (!timerRef.current && !visible) {
          timerRef.current = setTimeout(() => { setVisible(true); timerRef.current = null }, SHOW_DELAY)
        }
      } else {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
        setVisible(false)
      }
    }
    listeners.add(onChange)
    onChange(_active)
    return () => { listeners.delete(onChange); if (timerRef.current) clearTimeout(timerRef.current) }
  }, [visible])

  if (!visible) return null
  return createPortal(
    <>
      <div className="pointer-events-none fixed left-0 right-0 top-0 z-[300] h-[3px] overflow-hidden bg-brand-100">
        <div className="loadbar-indeterminate h-full w-1/3 bg-brand-600" />
      </div>
      <style>{`
        @keyframes loadbar { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }
        .loadbar-indeterminate { animation: loadbar 1.1s ease-in-out infinite; }
      `}</style>
    </>,
    document.body,
  )
}

// ── Reusable content placeholder (spinner + shimmer rows) ──────────────────
export function Skeleton({ className = '' }) {
  return <div className={`animate-pulse rounded bg-gray-100 ${className}`} />
}

export function PageSkeleton({ rows = 3, label = 'Loading' }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
      {label && <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        <div className="flex-1 space-y-2">
          {[...Array(rows)].map((_, i) => (
            <Skeleton key={i} className={`h-3 ${i === rows - 1 ? 'w-1/2' : 'w-full'}`} />
          ))}
        </div>
      </div>
    </div>
  )
}
