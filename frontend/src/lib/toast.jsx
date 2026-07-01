import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Tiny global toast system (no dependency). `showToast(...)` can be called
 * from anywhere — including the API client — and <ToastHost/> (mounted once
 * in App) renders the stack. Matches the "Saved · Your changes are live."
 * design: a white card with a green check, bold title and a subtle message.
 */
let _id = 0
const listeners = new Set()
let toasts = []

function emit() {
  const snapshot = [...toasts]
  listeners.forEach((l) => l(snapshot))
}

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function showToast({
  title = 'Saved',
  message = 'Your changes are live.',
  variant = 'success',
  duration = 3000,
} = {}) {
  const id = ++_id
  toasts = [...toasts, { id, title, message, variant }]
  emit()
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration)
  }
  return id
}

const VARIANT = {
  success: { ring: 'border-emerald-300', icon: 'text-emerald-600', msg: 'text-emerald-700' },
  error:   { ring: 'border-rose-300',    icon: 'text-rose-600',    msg: 'text-rose-700' },
  info:    { ring: 'border-sky-300',     icon: 'text-sky-600',     msg: 'text-sky-700' },
}

function CheckIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 11.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
    </svg>
  )
}

function ToastCard({ id, title, message, variant }) {
  const v = VARIANT[variant] || VARIANT.success
  return (
    <div className={`pointer-events-auto flex w-72 items-start gap-2.5 rounded-xl border ${v.ring} bg-white px-4 py-3 shadow-lg`}>
      <CheckIcon className={`mt-0.5 h-5 w-5 shrink-0 ${v.icon}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        {message && <p className={`text-xs ${v.msg}`}>{message}</p>}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(id)}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
      </button>
    </div>
  )
}

export function ToastHost() {
  const [items, setItems] = useState([])
  useEffect(() => {
    const l = (next) => setItems(next)
    listeners.add(l)
    return () => listeners.delete(l)
  }, [])
  if (!items.length) return null
  return createPortal(
    <div className="pointer-events-none fixed right-4 top-4 z-[200] flex flex-col gap-2">
      {items.map((t) => <ToastCard key={t.id} {...t} />)}
    </div>,
    document.body,
  )
}
