/**
 * ChatbotWidget — AI assistant on the public website / landing page.
 *
 * A floating chat button (bottom-right) opens a small assistant that answers
 * prospect questions. Its knowledge comes live from the backend, never
 * hard-coded:
 *   • Plans / pricing / subscription questions → shows the real active plans
 *     pulled from /api/plans/ (name, price, billing cycle, features) plus a
 *     direct link to subscribe.
 *   • "Details" / contact / help questions → hands out the support phone +
 *     email from /api/public/support/ (admin-managed, so it changes without
 *     a deploy).
 *
 * Intent is matched on simple keyword sets (English + common Bangla terms) so
 * it works with no external LLM key and stays fast and private.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { getPlans, getPublicSupportInfo } from '../../api/subscription'

// ── Intent keyword sets (English + romanized Bangla) ──────────────────────
const PLAN_WORDS = [
  'plan', 'plans', 'pricing', 'price', 'prices', 'subscription', 'subscribe',
  'cost', 'costs', 'package', 'packages', 'fee', 'fees', 'charge', 'charges',
  'monthly', 'yearly', 'annual', 'trial', 'koto', 'taka', 'dam', 'mullo',
  'subscribe korbo', 'kinbo', 'rate',
]
const SUPPORT_WORDS = [
  'contact', 'support', 'help', 'number', 'phone', 'call', 'email', 'mail',
  'detail', 'details', 'more info', 'human', 'agent', 'talk', 'address',
  'office', 'location', 'jante', 'jogajog', 'sahajjo', 'jante chai',
]
const GREET_WORDS = ['hi', 'hello', 'hey', 'assalamu', 'salam', 'hola', 'good morning', 'good evening']
const THANKS_WORDS = ['thank', 'thanks', 'dhonnobad', 'thx']

const includesAny = (text, words) => words.some((w) => text.includes(w))

function fmtPrice(p) {
  const n = Number(p?.price ?? 0)
  const amount = n.toLocaleString('en-BD', { maximumFractionDigits: 2 })
  const cycle = (p?.billing_cycle || '').toString().toLowerCase()
  const per = cycle.includes('year') ? ' / year' : cycle.includes('month') ? ' / month' : ''
  return `৳${amount}${per}`
}

let _msgId = 0
const mkMsg = (from, body, extra = {}) => ({ id: ++_msgId, from, body, ...extra })

export default function ChatbotWidget() {
  const [open, setOpen]       = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput]     = useState('')
  const [plans, setPlans]     = useState(null)
  const [support, setSupport] = useState(null)
  const [typing, setTyping]   = useState(false)
  const scrollRef = useRef(null)

  // Lazy-load plans + support the first time the chat is opened.
  useEffect(() => {
    if (!open || plans !== null) return
    getPlans().then((d) => setPlans(Array.isArray(d) ? d : [])).catch(() => setPlans([]))
    getPublicSupportInfo().then(setSupport).catch(() => setSupport(null))
  }, [open, plans])

  // Greeting on first open.
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        mkMsg('bot', "Hi! 👋 I'm the Iffaa assistant. I can help you with our plans & pricing, or connect you to support. What would you like to know?", { chips: true }),
      ])
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, typing])

  const supportLine = useMemo(() => {
    const phone = support?.phone || ''
    const email = support?.email || ''
    return { phone, email, hours: support?.hours || '' }
  }, [support])

  const pushBot = (body, extra) => {
    setTyping(true)
    setTimeout(() => {
      setTyping(false)
      setMessages((m) => [...m, mkMsg('bot', body, extra)])
    }, 450)
  }

  const answer = (raw) => {
    const text = raw.toLowerCase().trim()

    if (includesAny(text, THANKS_WORDS)) {
      pushBot("You're welcome! 😊 Anything else about our plans or support?", { chips: true })
      return
    }
    // Contact / details first — the spec says detailed questions go to support.
    if (includesAny(text, SUPPORT_WORDS)) {
      pushBot('For details, our team is happy to help directly:', { support: true, chips: true })
      return
    }
    if (includesAny(text, PLAN_WORDS)) {
      pushBot('Here are our current subscription plans 👇', { plans: true, chips: true })
      return
    }
    if (includesAny(text, GREET_WORDS)) {
      pushBot('Hello! 👋 Ask me about our plans & pricing, or tap "Contact Support" for direct help.', { chips: true })
      return
    }
    // Fallback — point to plans + support.
    pushBot(
      "I can help with our plans & pricing. For anything more detailed, please reach our support team:",
      { support: true, chips: true },
    )
  }

  const send = (value) => {
    const v = (value ?? input).trim()
    if (!v) return
    setMessages((m) => [...m, mkMsg('user', v)])
    setInput('')
    answer(v)
  }

  const onChip = (kind) => {
    if (kind === 'plans') { setMessages((m) => [...m, mkMsg('user', 'Show me the plans')]); pushBot('Here are our current subscription plans 👇', { plans: true, chips: true }) }
    if (kind === 'support') { setMessages((m) => [...m, mkMsg('user', 'I need to talk to support')]); pushBot('Our team is happy to help directly:', { support: true, chips: true }) }
  }

  return (
    <>
      {/* Launcher button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close chat' : 'Chat with us'}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-xl ring-4 ring-brand-600/20 transition-transform hover:scale-105 hover:bg-brand-700"
      >
        {open ? <CloseIcon /> : <ChatIcon />}
        {!open && <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-white" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[34rem] max-h-[78vh] w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl animate-fade-in">
          {/* Header */}
          <div className="flex items-center gap-3 bg-[#0c2233] px-4 py-3 text-white">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600">
              <BotIcon />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">Iffaa Assistant</p>
              <p className="flex items-center gap-1.5 text-[11px] text-emerald-300">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online now
              </p>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-gray-50 px-3.5 py-4">
            {messages.map((m) => (
              <div key={m.id} className={m.from === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={[
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed shadow-sm',
                  m.from === 'user'
                    ? 'rounded-br-sm bg-brand-600 text-white'
                    : 'rounded-bl-sm bg-white text-gray-700 border border-gray-100',
                ].join(' ')}>
                  <p className="whitespace-pre-line">{m.body}</p>

                  {/* Plan cards */}
                  {m.plans && (
                    <div className="mt-2 space-y-2">
                      {plans === null && <p className="text-xs text-gray-400">Loading plans…</p>}
                      {plans?.length === 0 && <p className="text-xs text-gray-400">Plans aren't available right now — please contact support.</p>}
                      {(plans || []).map((p) => (
                        <div key={p.id} className="rounded-xl border border-gray-100 bg-gray-50 p-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold text-navy-800">{p.name}</span>
                            <span className="text-[13px] font-bold text-brand-600">{fmtPrice(p)}</span>
                          </div>
                          {p.description && <p className="mt-0.5 text-[11px] text-gray-500">{p.description}</p>}
                          {Array.isArray(p.features) && p.features.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5">
                              {p.features.slice(0, 4).map((f, i) => (
                                <li key={i} className="flex items-start gap-1 text-[11px] text-gray-600">
                                  <CheckMini /> <span>{typeof f === 'string' ? f : f?.label || ''}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {plans?.length > 0 && (
                        <div className="flex gap-2 pt-0.5">
                          <Link to="/pricing" className="flex-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-center text-[12px] font-semibold text-white hover:bg-brand-700">View plans &amp; subscribe</Link>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Support block */}
                  {m.support && (
                    <div className="mt-2 space-y-1.5 rounded-xl border border-gray-100 bg-gray-50 p-2.5">
                      {supportLine.phone && (
                        <a href={`tel:${supportLine.phone}`} className="flex items-center gap-2 text-[12px] font-medium text-navy-800 hover:text-brand-600">
                          <PhoneMini /> {supportLine.phone}
                        </a>
                      )}
                      {supportLine.email && (
                        <a href={`mailto:${supportLine.email}`} className="flex items-center gap-2 text-[12px] font-medium text-navy-800 hover:text-brand-600">
                          <MailMini /> {supportLine.email}
                        </a>
                      )}
                      {supportLine.hours && (
                        <p className="flex items-center gap-2 text-[11px] text-gray-500">
                          <ClockMini /> {supportLine.hours}
                        </p>
                      )}
                      {!supportLine.phone && !supportLine.email && (
                        <p className="text-[11px] text-gray-400">Loading contact details…</p>
                      )}
                    </div>
                  )}

                  {/* Quick-reply chips */}
                  {m.chips && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button onClick={() => onChip('plans')} className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-brand-600 hover:text-brand-600">💳 View plans</button>
                      <button onClick={() => onChip('support')} className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:border-brand-600 hover:text-brand-600">📞 Contact support</button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {typing && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm border border-gray-100 bg-white px-3.5 py-2.5 shadow-sm">
                  <span className="flex gap-1">
                    <Dot /> <Dot delay="150ms" /> <Dot delay="300ms" />
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={(e) => { e.preventDefault(); send() }}
            className="flex items-center gap-2 border-t border-gray-100 bg-white px-3 py-2.5"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about plans, pricing, support…"
              className="flex-1 rounded-full border border-gray-200 bg-gray-50 px-3.5 py-2 text-[13px] text-gray-700 outline-none focus:border-brand-600 focus:bg-white"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
              aria-label="Send"
            >
              <SendIcon />
            </button>
          </form>
        </div>
      )}
    </>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────
function ChatIcon() {
  return (<svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" /></svg>)
}
function CloseIcon() {
  return (<svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>)
}
function BotIcon() {
  return (<svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4M9 4h6M9 13h.01M15 13h.01" /></svg>)
}
function SendIcon() {
  return (<svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>)
}
function CheckMini() {
  return (<svg className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.29 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" /></svg>)
}
function PhoneMini() {
  return (<svg className="h-3.5 w-3.5 shrink-0 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0122 16.92z" /></svg>)
}
function MailMini() {
  return (<svg className="h-3.5 w-3.5 shrink-0 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" /></svg>)
}
function ClockMini() {
  return (<svg className="h-3.5 w-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>)
}
function Dot({ delay = '0ms' }) {
  return <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-300" style={{ animationDelay: delay }} />
}
