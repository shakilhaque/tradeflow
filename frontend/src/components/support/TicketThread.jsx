import { useEffect, useRef } from 'react'
import { STATUS_STYLE, PRIORITY_STYLE } from '../../api/support'

const cap = (s) => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const fmtDT = (d) => (d ? new Date(d).toLocaleString() : '—')

export function StatusBadge({ status }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[status] ?? 'bg-gray-100 text-gray-600'}`}>{cap(status)}</span>
}
export function PriorityBadge({ priority }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${PRIORITY_STYLE[priority] ?? 'bg-gray-100 text-gray-600'}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{cap(priority)}
    </span>
  )
}

function Attachments({ items }) {
  if (!items || items.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((a) => (
        <a key={a.id} href={a.url} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-[11px] font-medium hover:bg-black/10">
          📎 {a.name || 'attachment'}
        </a>
      ))}
    </div>
  )
}

/**
 * Chat-style ticket thread. `viewerRole` = 'tenant' | 'admin' decides which
 * side bubbles sit on. Internal notes render as a distinct amber block.
 */
export default function TicketThread({ messages = [], viewerRole = 'tenant' }) {
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  return (
    <div className="space-y-3">
      {messages.map((m) => {
        if (m.is_internal) {
          return (
            <div key={m.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2">
              <p className="text-[11px] font-semibold text-amber-700">Internal note · {m.author_name}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-amber-900">{m.body}</p>
              <Attachments items={m.attachments} />
              <p className="mt-1 text-[10px] text-amber-600">{fmtDT(m.created_at)}</p>
            </div>
          )
        }
        const mine = m.author_role === viewerRole
        return (
          <div key={m.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${mine ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm border border-gray-100 bg-white text-gray-800'}`}>
              <p className={`text-[11px] font-semibold ${mine ? 'text-white/80' : 'text-gray-500'}`}>
                {m.author_name} · {m.author_role === 'admin' ? 'Support' : 'Tenant'}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
              <Attachments items={m.attachments} />
              <p className={`mt-1 text-[10px] ${mine ? 'text-white/70' : 'text-gray-400'}`}>{fmtDT(m.created_at)}</p>
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
