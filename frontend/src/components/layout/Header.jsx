import { useState, useRef, useEffect } from 'react'
import { useLocation, Link }            from 'react-router-dom'
import { useAuth }                      from '../../context/AuthContext'
import { useLang }                      from '../../context/LanguageContext'
import useUnreadCount                   from '../../hooks/useUnreadCount'
import { NotifBubble }                  from '../ui/Badge'
import UserAvatar                       from '../ui/UserAvatar'
import BranchSwitcher                   from '../branch/BranchSwitcher'
import { markAllRead }                  from '../../api/notifications'

// ── Route → breadcrumb map ───────────────────────────────────────────────────

const BREADCRUMBS = {
  '/dashboard':                       ['Workspace', 'Dashboard'],
  '/sells':                           ['Sales', 'All Sales'],
  '/sales':                           ['Sales', 'POS'],
  '/sales/pos':                       ['Sales', 'POS'],
  '/sales/add':                       ['Sales', 'New Sale'],
  '/sales/drafts':                    ['Sales', 'Drafts'],
  '/sales/add-draft':                 ['Sales', 'New Draft'],
  '/sales/returns':                   ['Sales', 'Sale Returns'],
  '/sales/returns/new':               ['Sales', 'Sale Returns', 'New Return'],
  '/sales/quotations':                ['Sales', 'Quotations'],
  '/sales/add-quotation':             ['Sales', 'Quotations', 'New'],
  '/sales/shipments':                 ['Sales', 'Shipments'],
  '/sales/discounts':                 ['Sales', 'Discounts'],
  '/sales/import':                    ['Sales', 'Import'],
  '/customers':                       ['Contacts', 'Customers'],
  '/contacts/customers':              ['Contacts', 'Customers'],
  '/contacts/customer-groups':        ['Contacts', 'Customer Groups'],
  '/contacts/suppliers':              ['Contacts', 'Suppliers'],
  '/contacts/import':                 ['Contacts', 'Import Contacts'],
  '/users':                           ['User Management', 'Users'],
  '/roles':                           ['User Management', 'Roles'],
  '/products':                        ['Products', 'List Products'],
  '/products/new':                    ['Products', 'Add Product'],
  '/products/import':                 ['Products', 'Import Products'],
  '/products/import-stock':           ['Products', 'Import Stock'],
  '/products/import-opening-stock':   ['Products', 'Import Opening Stock'],
  '/products/print-labels':           ['Products', 'Print Labels'],
  '/products/units':                  ['Products', 'Units'],
  '/products/categories':             ['Products', 'Categories'],
  '/products/brands':                 ['Products', 'Brands'],
  '/products/warranties':             ['Products', 'Warranties'],
  '/inventory/products':              ['Products', 'List Products'],
  '/inventory/stock':                 ['Products', 'Stock Report'],
  '/inventory/stock-transfers':       ['Stock Transfer', 'List Stock Transfer'],
  '/inventory/stock-transfers/add':   ['Stock Transfer', 'Add Stock Transfer'],
  '/purchases':                       ['Purchases', 'All Purchases'],
  '/purchases/list':                  ['Purchases', 'All Purchases'],
  '/purchases/add':                   ['Purchases', 'New Purchase'],
  '/purchases/returns':               ['Purchases', 'Purchase Returns'],
  '/purchases/returns/add':           ['Purchases', 'Purchase Returns', 'New'],
  '/accounting/expenses':             ['Expenses'],
  '/accounting/expenses/add':         ['Expenses', 'Record'],
  '/accounting/expenses/categories':  ['Expenses', 'Categories'],
  '/accounting/journal':              ['Accounting', 'Journal Entries'],
  '/accounting/accounts':             ['Accounting', 'Chart of Accounts'],
  '/reports/sales':                   ['Reports', 'Sales'],
  '/reports/profit-loss':             ['Reports', 'Profit / Loss Report'],
  '/reports/stock':                   ['Reports', 'Stock'],
  '/reports/expenses':                ['Reports', 'Expenses'],
  '/reports/tax':                     ['Reports', 'Tax'],
  '/reports/products':                ['Reports', 'Products'],
  '/reports/service-staff':           ['Reports', 'Service Staff'],
  '/reports/sales-representative':    ['Reports', 'Sales Representative'],
  '/reports/register':                ['Reports', 'Register'],
  '/reports/sell-payment':            ['Reports', 'Sell Payments'],
  '/reports/purchase-payment':        ['Reports', 'Purchase Payments'],
  '/reports/purchase-sale':           ['Reports', 'Purchase & Sale'],
  '/reports/contacts':                ['Reports', 'Customers & Suppliers'],
  '/reports/activity-log':            ['Reports', 'Activity Log'],
  '/imports':                         ['Manage', 'Imports'],
  '/audit':                           ['Manage', 'Audit Log'],
  '/settings':                        ['Manage', 'Settings'],
  '/settings/business':               ['Settings', 'Business Settings'],
  '/settings/locations':              ['Manage', 'Locations'],
  '/billing/status':                  ['Manage', 'Subscription'],
  '/platform/dashboard':              ['Platform', 'Dashboard'],
  '/platform/clients':                ['Platform', 'Clients & Billing'],
  '/platform/subscriptions':          ['Platform', 'Subscriptions'],
  '/platform/plans':                  ['Platform', 'Plans'],
  '/platform/users':                  ['Platform', 'Admin Users'],
}

function useBreadcrumb() {
  const { pathname } = useLocation()
  if (BREADCRUMBS[pathname]) return BREADCRUMBS[pathname]
  // Dynamic: invoice detail
  if (/^\/sales\/[^/]+$/.test(pathname))     return ['Sales', 'All Sales', pathname.split('/').pop()]
  if (/^\/purchases\/[^/]+$/.test(pathname)) return ['Purchases', 'Detail']
  return ['Workspace']
}

// ── Language switcher ─────────────────────────────────────────────────────────

function LanguageSwitcher() {
  const { lang, setLang, t, languages } = useLang()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const current = languages.find((l) => l.code === lang) ?? languages[0]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('Language')}
        aria-label={t('Language')}
        className="flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-2 text-gray-600 hover:bg-gray-50 hover:text-navy-800 transition-colors duration-150 focus:outline-none"
      >
        <GlobeIcon />
        <span className="text-xs font-semibold">{current.native}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-40 bg-white rounded-xl shadow-pop border border-gray-100 py-1 z-50 animate-fade-in">
          <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{t('Language')}</p>
          {languages.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLang(l.code); setOpen(false) }}
              className={[
                'w-full flex items-center justify-between px-3 py-2 text-sm transition-colors',
                l.code === lang ? 'text-brand-600 font-semibold bg-brand-50' : 'text-gray-700 hover:bg-gray-50',
              ].join(' ')}
            >
              <span>{l.native}</span>
              {l.code === lang && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── User dropdown ─────────────────────────────────────────────────────────────

function UserDropdown({ user, logout }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const ref             = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', manager: 'Manager', cashier: 'Cashier' }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-gray-50 transition-colors duration-150 focus:outline-none"
      >
        <UserAvatar src={user?.profile_picture} name={user?.name} size="sm" />
        <div className="hidden sm:block text-left leading-tight pr-1">
          <p className="text-sm font-semibold text-navy-800 max-w-[140px] truncate">{user?.name}</p>
          <p className="text-[11px] text-gray-500">{t(ROLE_LABEL[user?.role] ?? user?.role)}</p>
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-60 bg-white rounded-xl shadow-pop border border-gray-100 py-1 z-50 animate-fade-in">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-navy-800 truncate">{user?.name}</p>
            <p className="text-xs text-gray-500 truncate">{user?.email}</p>
          </div>
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <CogIcon /> {t('Settings')}
          </Link>
          <div className="border-t border-gray-100 mt-1 pt-1">
            <button
              onClick={() => { setOpen(false); logout() }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <LogoutIcon /> {t('Sign out')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Notification bell ─────────────────────────────────────────────────────────

function NotificationBell({ count, onMarkAll }) {
  return (
    <button
      onClick={onMarkAll}
      title={count ? `${count} unread notifications` : 'No unread notifications'}
      className="relative rounded-full p-2 text-gray-500 hover:bg-gray-50 hover:text-navy-800 transition-colors duration-150 focus:outline-none border border-gray-200"
    >
      <BellIcon />
      <NotifBubble count={count} />
    </button>
  )
}

// ── Main Header ───────────────────────────────────────────────────────────────

export default function Header({ onMenuToggle, onDesktopMenuToggle }) {
  const { user, logout }   = useAuth()
  const crumbs             = useBreadcrumb()
  const { count, refresh } = useUnreadCount()
  const { t }              = useLang()

  const handleMarkAll = async () => {
    try { await markAllRead(); refresh() } catch { /* ignore */ }
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3 sm:gap-4
                       bg-white border-b border-gray-200 px-4 sm:px-6">
      {/* Hamburger — mobile = open drawer, desktop = toggle collapse */}
      <button
        onClick={onMenuToggle}
        className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors duration-150 focus:outline-none lg:hidden"
        aria-label="Open navigation"
      >
        <HamburgerIcon />
      </button>
      <button
        onClick={onDesktopMenuToggle}
        className="hidden lg:inline-flex rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors duration-150 focus:outline-none"
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
      >
        <HamburgerIcon />
      </button>

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-gray-500 flex-1 min-w-0 truncate" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span className="text-gray-300">/</span>}
            <span className={[
              'truncate',
              i === crumbs.length - 1 ? 'text-navy-800 font-semibold' : 'text-gray-500',
            ].join(' ')}>
              {t(c)}
            </span>
          </span>
        ))}
      </nav>

      {/* Right actions */}
      <div className="flex items-center gap-2 sm:gap-3">
        <BranchSwitcher />
        <LanguageSwitcher />
        <NotificationBell count={count} onMarkAll={handleMarkAll} />
        <UserDropdown user={user} logout={logout} />
      </div>
    </header>
  )
}

// ── Micro-icons ───────────────────────────────────────────────────────────────

function BellIcon() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 004 0" />
    </svg>
  )
}
function GlobeIcon() {
  return (
    <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.29 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
    </svg>
  )
}
function HamburgerIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 012 10z" clipRule="evenodd" />
    </svg>
  )
}
function ChevronDown({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
    </svg>
  )
}
function LogoutIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z" clipRule="evenodd" />
      <path fillRule="evenodd" d="M19 10a.75.75 0 00-.75-.75H8.704l1.048-1.083a.75.75 0 10-1.004-1.114l-2.5 2.5a.75.75 0 000 1.114l2.5 2.5a.75.75 0 101.004-1.114L8.704 10.75H18.25A.75.75 0 0019 10z" clipRule="evenodd" />
    </svg>
  )
}
function BillingIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path d="M2.5 4A1.5 1.5 0 001 5.5V6h18v-.5A1.5 1.5 0 0017.5 4h-15zM19 8.5H1v6A1.5 1.5 0 002.5 16h15a1.5 1.5 0 001.5-1.5v-6zM3 13.25a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5a.75.75 0 01-.75-.75zm4.75-.75a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" />
    </svg>
  )
}
function CogIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
    </svg>
  )
}
