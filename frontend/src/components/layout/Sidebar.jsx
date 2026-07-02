import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLang } from '../../context/LanguageContext'
import { useBranch } from '../../context/BranchContext'
import Logo from '../Logo'
import UserAvatar from '../ui/UserAvatar'

// ── Permission-aware nav config ───────────────────────────────────────────────

const NAV_GROUPS = [
  {
    group: 'WORKSPACE',
    items: [
      { label: 'Dashboard', path: '/dashboard', icon: <IconDashboard /> },
      {
        label: 'Sales', icon: <IconReceipt />, perm: 'can_create_sale',
        children: [
          { label: 'All Sales',         path: '/sells',           perm: 'can_create_sale' },
          { label: 'Sales on POS',      path: '/sales/pos',       perm: 'can_create_sale' },
          { label: 'Sale Return',       path: '/sales/returns',   perm: 'can_create_sale' },
          { label: 'List Quotation',    path: '/sales/quotations',     perm: 'can_create_sale' },
          { label: 'Add Quotation',     path: '/sales/add-quotation',  perm: 'can_create_sale' },
          { label: 'Shipments',         path: '/sales/shipments', perm: 'can_create_sale' },
          { label: 'Discounts',         path: '/sales/discounts', perm: 'can_create_sale' },
          { label: 'Import from Excel', path: '/sales/import',    perm: 'can_create_sale' },
        ],
      },
      {
        label: 'Products', icon: <IconBox />, perm: 'can_manage_products',
        children: [
          { label: 'List Products',         path: '/products',                       perm: 'can_manage_products' },
          { label: 'Add Product',           path: '/products/new',                   perm: 'can_manage_products' },
          { label: 'Import Products',       path: '/products/import',                perm: 'can_manage_products' },
          { label: 'Import Opening Stock',  path: '/products/import-opening-stock',  perm: 'can_manage_products' },
          { label: 'Print Labels',          path: '/products/print-labels',          perm: 'can_manage_products' },
          { label: 'Categories',            path: '/products/categories',            perm: 'can_manage_products' },
          { label: 'Brands',                path: '/products/brands',                perm: 'can_manage_products' },
          { label: 'Units',                 path: '/products/units',                 perm: 'can_manage_products' },
          { label: 'Warranties',            path: '/products/warranties',            perm: 'can_manage_products' },
        ],
      },
      {
        label: 'Stock Transfer', icon: <IconTransfer />, perm: 'can_manage_products',
        children: [
          { label: 'List Stock Transfer', path: '/inventory/stock-transfers',     perm: 'can_manage_products' },
          { label: 'Add Stock Transfer',  path: '/inventory/stock-transfers/add', perm: 'can_manage_products' },
        ],
      },
      {
        label: 'Purchases', icon: <IconInbox />, perm: 'can_manage_products',
        children: [
          { label: 'All Purchases',     path: '/purchases/list',        perm: 'can_manage_products' },
          { label: 'New Purchase',      path: '/purchases/add',         perm: 'can_manage_products' },
          { label: 'Purchase Returns',  path: '/purchases/returns',     perm: 'can_manage_products' },
        ],
      },
      {
        label: 'Contacts', icon: <IconUsers />, perm: 'can_create_sale',
        children: [
          { label: 'Customers',         path: '/contacts/customers',       perm: 'can_create_sale' },
          { label: 'Customer Groups',   path: '/contacts/customer-groups', perm: 'can_create_sale' },
          { label: 'Suppliers',         path: '/contacts/suppliers',       perm: 'can_manage_products' },
          { label: 'Import Contacts',   path: '/contacts/import',          perm: 'can_create_sale' },
        ],
      },
      {
        label: 'Expenses', icon: <IconWallet />, perm: 'can_record_expense',
        children: [
          { label: 'All Expenses',      path: '/accounting/expenses',            perm: 'can_record_expense' },
          { label: 'Record Expense',    path: '/accounting/expenses/add',        perm: 'can_record_expense' },
          { label: 'Expense Categories', path: '/accounting/expenses/categories', perm: 'can_record_expense' },
        ],
      },
      {
        label: 'Payment Accounts', icon: <IconCard />, perm: 'can_manage_settings',
        children: [
          { label: 'List Accounts',           path: '/accounting/payment-accounts', perm: 'can_manage_settings' },
          { label: 'Balance Sheet',           path: '/accounting/balance-sheet',    perm: 'can_view_profit_loss' },
          { label: 'Trial Balance',           path: '/accounting/trial-balance',    perm: 'can_view_profit_loss' },
          { label: 'Cash Flow',               path: '/accounting/cash-flow',        perm: 'can_view_profit_loss' },
          { label: 'Payment Account Report',  path: '/accounting/payment-account-report', perm: 'can_view_reports' },
        ],
      },
      {
        // No parent perm: the group shows whenever at least one child is
        // visible. Every user can see Activity Log (ungated below), so the
        // Reports group always appears; the heavier reports stay gated per
        // child by their own perms.
        label: 'Reports', icon: <IconChart />,
        children: [
          // All-branches dashboard — owner + branch managers (UserBranch.can_manage).
          { label: 'Branch Dashboard',     path: '/reports/branch-dashboard',  branchAdmin: true },
          // Owner-only consolidated multi-branch comparison (Phase 4).
          { label: 'Branch Comparison',    path: '/reports/branch-comparison', perm: 'can_view_reports', ownerOnly: true },
          { label: 'Profit / Loss Report', path: '/reports/profit-loss', perm: 'can_view_profit_loss' },
          { label: 'Sales Report',         path: '/reports/sales',       perm: 'can_view_reports' },
          { label: 'Stock Report',         path: '/reports/stock',       perm: 'can_view_reports' },
          { label: 'Expense Report',       path: '/reports/expenses',    perm: 'can_view_reports' },
          { label: 'Tax Report',           path: '/reports/tax',         perm: 'can_view_profit_loss' },
          { label: 'Product Report',       path: '/reports/products',    perm: 'can_view_reports' },
          { label: 'Service Staff Report', path: '/reports/service-staff', perm: 'can_view_reports' },
          { label: 'Sales Representative Report', path: '/reports/sales-representative', perm: 'can_view_reports' },
          { label: 'Register Report',      path: '/reports/register',    perm: 'can_view_reports' },
          { label: 'Sell Payment Report',     path: '/reports/sell-payment',     perm: 'can_view_reports' },
          { label: 'Purchase Payment Report', path: '/reports/purchase-payment', perm: 'can_view_reports' },
          { label: 'Purchase & Sale Report',  path: '/reports/purchase-sale',    perm: 'can_view_reports' },
          { label: 'Customers & Suppliers',   path: '/reports/contacts',         perm: 'can_view_reports' },
          // Visible to ALL tenant users — everyone can see what every other
          // user did (sales, edits, deletes, logins) in this tenant.
          { label: 'Activity Log',            path: '/reports/activity-log' },
        ],
      },
    ],
  },
  {
    group: 'MANAGE',
    items: [
      {
        label: 'User Management', icon: <IconUsers2 />, perm: 'can_manage_settings',
        children: [
          { label: 'Users', path: '/users', perm: 'can_manage_settings' },
          { label: 'Roles', path: '/roles', perm: 'can_manage_settings' },
        ],
      },
      {
        label: 'Settings', icon: <IconCog />, perm: 'can_manage_settings',
        children: [
          { label: 'Business Settings', path: '/settings/business',  perm: 'can_manage_settings' },
          { label: 'Customer Profile',  path: '/settings/company-profile', perm: 'can_manage_settings' },
        ],
      },
      { label: 'Locations',     path: '/settings/locations', icon: <IconMapPin />, perm: 'can_manage_settings' },
    ],
  },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function Sidebar({
  mobileOpen,
  onMobileClose,
  collapsed,
  onToggleCollapsed,
  onLeafClick,
}) {
  const { user, logout } = useAuth()
  const { t } = useLang()
  const perms = user?.permissions ?? []
  // Suspended / overdue tenants get a prominent Pay Bill nav item.
  const requiresPayment = Boolean(
    user?.billing?.requires_payment ||
    user?.status === 'suspended' ||
    user?.billing?.subscription_status === 'suspended'
  )

  // Tenant brand for the header (name + logo URL). Pulled live from
  // SystemSetting via /api/settings/company-profile/ so no hard-coded
  // "Iffaa" text or default logo appears in the sidebar.
  const [companyProfile, setCompanyProfile] = useState(null)
  useEffect(() => {
    if (!user || user.hasTenant === false) return
    let cancelled = false
    import('../../api/companyProfile').then(({ getCompanyProfile }) => {
      getCompanyProfile()
        .then((data) => { if (!cancelled) setCompanyProfile(data) })
        .catch(() => { /* silent — falls back to user.business_name */ })
    })
    return () => { cancelled = true }
  }, [user?.id, user?.hasTenant])

  // Drives which sidebar group set renders. loginSource is the
  // source of truth for portal identity — see ProtectedRoute
  // for the rationale (the hasTenant heuristic flipped on
  // refresh when localStorage swapped portals across tabs).
  const isPlatformAdmin = user?.loginSource
    ? user.loginSource === 'admin'
    : (user?.hasTenant === false && Boolean(user?.isStaff || user?.isSuperuser))

  const hasPerms = (perm) => !perm || perms.includes(perm)

  // Platform-admin section access (RBAC). A superuser sees every section;
  // a sub-admin sees only the sections granted via Admin Users → checkboxes.
  const adminPerms = Array.isArray(user?.adminPermissions) ? user.adminPermissions : []
  const adminCan = (key) => Boolean(user?.isSuperuser) || adminPerms.includes(key)

  // Single-client build: one nav set (no platform-admin portal).
  const groups = NAV_GROUPS

  // Accordion: only ONE nav group is expanded at a time. Work out which
  // group owns the current route so it opens on load + after navigation;
  // clicking another group's header opens it and closes the previous one.
  const { pathname } = useLocation()
  let activeGroupLabel = null
  for (const g of groups) {
    for (const it of (g.items || [])) {
      if (it.children?.some((c) => pathname === c.path || pathname.startsWith(c.path + '/'))) {
        activeGroupLabel = it.label
        break
      }
    }
    if (activeGroupLabel) break
  }
  const [openGroup, setOpenGroup] = useState(activeGroupLabel)
  useEffect(() => { if (activeGroupLabel) setOpenGroup(activeGroupLabel) }, [activeGroupLabel])

  // ── Nav search / quick-jump ──────────────────────────────────────────────
  // Flatten every reachable leaf page (permission-filtered) into a searchable
  // index, then filter by what the user types and let them jump straight to it.
  const navigate = useNavigate()
  const { canConsolidated, canManageAny } = useBranch()
  const [query, setQuery]   = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeIdx, setActiveIdx]   = useState(0)
  const searchInputRef = useRef(null)
  const searchBoxRef   = useRef(null)

  const searchIndex = useMemo(() => {
    const out = []
    for (const g of groups) {
      for (const it of (g.items || [])) {
        if (it.billingOnly && !requiresPayment) continue
        if (it.adminPerm && !adminCan(it.adminPerm)) continue
        if (it.path && hasPerms(it.perm)) {
          out.push({ label: it.label, path: it.path, parent: g.group || '' })
        }
        if (it.children && hasPerms(it.perm)) {
          for (const c of it.children) {
            if (c.ownerOnly && !canConsolidated) continue
            if (c.branchAdmin && !(canConsolidated || canManageAny)) continue
            if (c.path && hasPerms(c.perm)) {
              out.push({ label: c.label, path: c.path, parent: it.label })
            }
          }
        }
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, requiresPayment, canConsolidated, canManageAny, perms.join(',')])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return searchIndex
      .filter((r) =>
        r.label.toLowerCase().includes(needle) ||
        r.parent.toLowerCase().includes(needle))
      .slice(0, 8)
  }, [query, searchIndex])

  useEffect(() => { setActiveIdx(0) }, [query])

  const goToResult = (r) => {
    if (!r) return
    navigate(r.path)
    setQuery('')
    setSearchOpen(false)
    onMobileClose?.()
    onLeafClick?.()
  }

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); goToResult(results[activeIdx]) }
    else if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); searchInputRef.current?.blur() }
  }

  // ⌘K / Ctrl+K focuses the search box from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close the results dropdown on outside click.
  useEffect(() => {
    if (!searchOpen) return
    const onDoc = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [searchOpen])

  // On mobile, the drawer is full-width-when-open; collapsed only applies to desktop.
  const widthClass = collapsed ? 'lg:w-[68px]' : 'lg:w-64'

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-white border-r border-gray-200',
          'transition-[width,transform] duration-200 ease-out',
          widthClass,
          'lg:translate-x-0 lg:static lg:z-auto',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        {/* ── Workspace card ── */}
        <div className="px-3 pt-4 pb-3 shrink-0">
          <div className={[
            'flex items-center rounded-xl border border-gray-200 bg-gray-50 shadow-sm',
            collapsed ? 'justify-center p-1.5' : 'gap-2 px-2.5 py-2',
          ].join(' ')}>
            {/* Sidebar brand.
                 - Platform admins always see the platform Logo.
                 - Tenants prefer (in order):
                     1. company.logo_url uploaded via Settings → Customer Profile
                     2. user.profile_picture (their avatar)
                     3. a NEUTRAL initial badge (NOT the platform Logo) —
                        early feedback was that brand-new tenants were
                        seeing the platform's own logo in the workspace
                        card by default, which made every workspace look
                        like it belonged to the platform owner. The
                        neutral fallback uses the company's first letter
                        on a slate background so the slot is clearly
                        "yours, set a logo" instead of "iffaa". */}
            {isPlatformAdmin ? (
              <Logo variant="icon" size={collapsed ? 'md' : 'lg'} />
            ) : companyProfile?.logo_url ? (
              <img
                src={companyProfile.logo_url}
                alt={companyProfile?.name || user?.business_name || 'Company'}
                className={collapsed ? 'h-9 w-9 rounded-md object-contain' : 'h-11 w-11 rounded-md object-contain'}
              />
            ) : user?.profile_picture ? (
              <UserAvatar
                src={user.profile_picture}
                name={user?.name}
                size={collapsed ? 'md' : 'lg'}
              />
            ) : (
              <TenantInitialBadge
                name={companyProfile?.name || user?.business_name || user?.name || '?'}
                collapsed={collapsed}
              />
            )}
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-navy-800 truncate leading-tight">
                    {isPlatformAdmin
                      ? 'Platform Admin'
                      : (companyProfile?.name || user?.business_name || '—')}
                  </p>
                  <p className="text-xs text-gray-400 truncate leading-tight">
                    {user?.email || 'Workspace'}
                  </p>
                </div>
                <button
                  onClick={onToggleCollapsed}
                  className="hidden lg:flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-navy-900 hover:bg-gray-100"
                  aria-label="Collapse sidebar"
                  title="Collapse"
                >
                  <ToggleIcon collapsed={collapsed} />
                </button>
                <button
                  onClick={onMobileClose}
                  className="lg:hidden text-gray-400 hover:text-navy-900"
                  aria-label="Close menu"
                >
                  <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </>
            )}
          </div>
          {collapsed && (
            <button
              onClick={onToggleCollapsed}
              className="hidden lg:flex mt-2 w-full items-center justify-center h-7 rounded-md text-gray-400 hover:text-navy-900 hover:bg-gray-100"
              aria-label="Expand sidebar"
              title="Expand"
            >
              <ToggleIcon collapsed={collapsed} />
            </button>
          )}
        </div>

        {/* ── Search ── */}
        {!collapsed && (
          <div className="px-3 pb-3 shrink-0">
            <div ref={searchBoxRef} className="relative">
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 hover:border-gray-300 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 transition">
                <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3zM4.5 9a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSearchOpen(true) }}
                  onFocus={() => setSearchOpen(true)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Search pages…"
                  className="flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
                />
                <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded border border-gray-200 bg-white text-[10px] font-medium text-gray-400">
                  ⌘K
                </kbd>
              </div>

              {searchOpen && query.trim() && (
                <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl">
                  {results.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-gray-400">No matching pages.</div>
                  ) : (
                    results.map((r, idx) => (
                      <button
                        key={r.path}
                        type="button"
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => goToResult(r)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition ${
                          idx === activeIdx ? 'bg-brand-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        <span className="truncate">{r.label}</span>
                        <span className={`shrink-0 text-[10px] ${idx === activeIdx ? 'text-brand-100' : 'text-gray-500'}`}>{r.parent}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {collapsed && (
          <div className="px-3 pb-3 shrink-0">
            <button
              onClick={onToggleCollapsed}
              className="hidden lg:flex w-full items-center justify-center h-9 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-500"
              title="Search"
              aria-label="Search"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 3a6 6 0 104.472 10.03l3.249 3.247a.75.75 0 101.06-1.06l-3.247-3.249A6 6 0 009 3zM4.5 9a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Nav ── */}
        <nav className="flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
          {groups.map(({ group, items }) => {
            const visible = items.filter((it) =>
              hasPerms(it.perm) && (!it.billingOnly || requiresPayment))
            if (!visible.length) return null

            return (
              <div key={group ?? '__root__'} className="mb-4">
                {group && !collapsed && (
                  <p className="mt-3 mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400">
                    {t(group)}
                  </p>
                )}
                {group && collapsed && (
                  <div className="mt-3 mb-1.5 border-t border-gray-200" />
                )}
                <ul className="space-y-0.5">
                  {visible.map((item) =>
                    item.children
                      ? <CollapsibleItem
                          key={item.label}
                          item={item}
                          hasPerms={hasPerms}
                          collapsed={collapsed}
                          onLeafClick={onLeafClick}
                          onMobileClose={onMobileClose}
                          onExpandRequest={onToggleCollapsed}
                          isOpen={openGroup === item.label}
                          onToggle={() => setOpenGroup((g) => (g === item.label ? null : item.label))}
                          onForceOpen={() => setOpenGroup(item.label)}
                        />
                      : <LeafItem
                          key={item.path}
                          item={item}
                          collapsed={collapsed}
                          onLeafClick={onLeafClick}
                          onMobileClose={onMobileClose}
                        />
                  )}
                </ul>
              </div>
            )
          })}
        </nav>

        {/* ── User footer ── */}
        <div className="border-t border-gray-200 px-3 py-3 shrink-0">
          <div className={[
            'flex items-center rounded-lg hover:bg-gray-100 transition cursor-default',
            collapsed ? 'justify-center py-1' : 'gap-2.5 px-1 py-1.5',
          ].join(' ')}>
            <UserAvatar src={user?.profile_picture} name={user?.name} size="md" />
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-navy-800 truncate leading-tight">{user?.name || '—'}</p>
                  <p className="text-xs text-gray-400 truncate leading-tight capitalize">
                    {user?.role || (isPlatformAdmin ? 'Platform admin' : 'Member')}
                  </p>
                </div>
                <button
                  onClick={logout}
                  title="Sign out"
                  className="text-gray-400 hover:text-rose-600 transition p-1.5 rounded hover:bg-rose-50"
                >
                  <LogoutIcon />
                </button>
              </>
            )}
          </div>
          {collapsed && (
            <button
              onClick={logout}
              title="Sign out"
              className="mt-1 hidden lg:flex w-full items-center justify-center h-8 rounded-md text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition"
            >
              <LogoutIcon />
            </button>
          )}
        </div>
      </aside>
    </>
  )
}

// ── Leaf nav item ────────────────────────────────────────────────────────────

function LeafItem({ item, collapsed, onLeafClick, onMobileClose }) {
  const { t } = useLang()
  const handleClick = () => {
    onMobileClose?.()
    onLeafClick?.()
  }
  return (
    <li>
      <NavLink
        to={item.path}
        end
        onClick={handleClick}
        title={collapsed ? t(item.label) : undefined}
        className={({ isActive }) => [
          'group relative flex items-center rounded-lg text-[13.5px] font-medium transition-colors duration-100',
          collapsed ? 'lg:justify-center lg:px-0 lg:py-2.5 gap-2.5 px-2.5 py-2' : 'gap-2.5 px-2.5 py-2',
          isActive
            ? 'bg-brand-600 text-white shadow-sm'
            : 'text-gray-600 hover:bg-gray-100 hover:text-navy-900',
        ].join(' ')}
      >
        {({ isActive }) => (
          <>
            <span className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-white' : 'text-gray-400'}`}>
              {item.icon}
            </span>
            {!collapsed && <span className="flex-1">{t(item.label)}</span>}
            {collapsed && (
              <span className="hidden lg:group-hover:flex absolute left-full ml-2 px-2 py-1 rounded-md bg-navy-800 text-white text-xs whitespace-nowrap shadow-lg z-50 pointer-events-none">
                {t(item.label)}
              </span>
            )}
          </>
        )}
      </NavLink>
    </li>
  )
}

// ── Collapsible parent item ───────────────────────────────────────────────────

function CollapsibleItem({ item, hasPerms, collapsed, onLeafClick, onMobileClose, onExpandRequest, isOpen, onToggle, onForceOpen }) {
  const { t } = useLang()
  const { pathname } = useLocation()
  // ownerOnly items (e.g. Branch Comparison) only show for the tenant owner.
  // branchAdmin items (e.g. Branch Dashboard) show for the owner OR any branch
  // manager (UserBranch.can_manage).
  const { canConsolidated, canManageAny } = useBranch()
  const visibleChildren = item.children.filter(
    (c) => hasPerms(c.perm)
      && (!c.ownerOnly || canConsolidated)
      && (!c.branchAdmin || canConsolidated || canManageAny),
  )
  if (!visibleChildren.length) return null

  const childActive = visibleChildren.some(
    (c) => pathname === c.path || pathname.startsWith(c.path + '/')
  )
  // Open state is owned by the parent (accordion — one group at a time).
  const open = isOpen

  const handleHeaderClick = () => {
    if (collapsed) {
      // Expand the entire sidebar and open this group
      onExpandRequest?.()
      onForceOpen?.()
    } else {
      onToggle?.()
    }
  }

  const handleChildClick = () => {
    onMobileClose?.()
    onLeafClick?.()
  }

  return (
    <li>
      <button
        type="button"
        onClick={handleHeaderClick}
        title={collapsed ? t(item.label) : undefined}
        className={[
          'group relative w-full flex items-center rounded-lg text-[13.5px] font-medium transition-colors duration-100',
          collapsed ? 'lg:justify-center lg:px-0 lg:py-2.5 gap-2.5 px-2.5 py-2' : 'gap-2.5 px-2.5 py-2',
          childActive
            ? (collapsed ? 'bg-brand-600 text-white' : 'text-brand-700')
            : 'text-gray-600 hover:bg-gray-100 hover:text-navy-900',
        ].join(' ')}
      >
        <span className={`w-[18px] h-[18px] shrink-0 ${childActive ? 'text-brand-600' : 'text-gray-400'}`}>
          {item.icon}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 text-left">{t(item.label)}</span>
            <svg
              viewBox="0 0 20 20" fill="currentColor"
              className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            >
              <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
            </svg>
          </>
        )}
        {collapsed && (
          <span className="hidden lg:group-hover:flex absolute left-full ml-2 px-2 py-1 rounded-md bg-navy-800 text-white text-xs whitespace-nowrap shadow-lg z-50 pointer-events-none">
            {t(item.label)}
          </span>
        )}
      </button>

      {open && !collapsed && (
        <ul className="mt-0.5 ml-3 pl-3.5 border-l border-gray-200 space-y-0.5">
          {visibleChildren.map((child) => (
            <li key={child.path}>
              <NavLink
                to={child.path}
                end
                onClick={handleChildClick}
                className={({ isActive }) => [
                  'block rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-100',
                  isActive
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-navy-900',
                ].join(' ')}
              >
                {t(child.label)}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ToggleIcon({ collapsed }) {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
      {collapsed ? (
        <path d="M13.5 9l3 3-3 3" />
      ) : (
        <path d="M16.5 9l-3 3 3 3" />
      )}
    </svg>
  )
}

/**
 * TenantInitialBadge — neutral fallback for the sidebar brand slot.
 *
 * Shows the first letter of the tenant's company / business name on a
 * slate background. Used when the tenant has NOT uploaded a logo yet
 * and has no profile picture, so the workspace card never falls back
 * to the platform's own logo.
 */
function TenantInitialBadge({ name, collapsed }) {
  const letter = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const cls = collapsed
    ? 'h-9 w-9 text-base'
    : 'h-11 w-11 text-lg'
  return (
    <div
      className={`${cls} shrink-0 inline-flex items-center justify-center rounded-md bg-slate-200 text-slate-700 font-bold tracking-tight`}
      aria-label="No company logo set"
      title="No company logo yet — upload one in Settings → Customer Profile."
    >
      {letter}
    </div>
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

// ── Icons ────────────────────────────────────────────────────────────────────

function IconDashboard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <rect x="3" y="3"  width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  )
}
function IconReceipt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M6 4a1 1 0 011-1h10a1 1 0 011 1v17l-3-2-3 2-3-2-3 2V4z" />
    </svg>
  )
}
function IconBox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M21 7.5l-9-4.5-9 4.5M21 7.5v9l-9 4.5m9-13.5l-9 4.5m0 0v9m0-9L3 7.5m0 0v9l9 4.5" />
    </svg>
  )
}
function IconInbox() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M5 5h14l1 9h-5a3 3 0 11-6 0H4l1-9z" />
      <path d="M4 14v4a1 1 0 001 1h14a1 1 0 001-1v-4" />
    </svg>
  )
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M14.5 20a4.5 4.5 0 016.8-3.8" />
    </svg>
  )
}
function IconUsers2() { return IconUsers() }
function IconWallet() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
      <path d="M16 12.5h2.5" />
      <path d="M3 7h18" />
    </svg>
  )
}
function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 21l1.4-4.2A7.94 7.94 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}
function IconBook() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M4 4h7a3 3 0 013 3v13a2 2 0 00-2-2H4V4z" />
      <path d="M20 4h-7a3 3 0 00-3 3v13a2 2 0 012-2h8V4z" />
    </svg>
  )
}
function IconChart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </svg>
  )
}
function IconCog() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8L4.2 7.6a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function IconAddressBook() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M4 4.5A1.5 1.5 0 015.5 3h13A1.5 1.5 0 0120 4.5v15a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 19.5v-15z" />
      <circle cx="12" cy="11" r="2.5" />
      <path d="M8 17a4 4 0 018 0" />
      <path d="M3 7h1.5M3 11h1.5M3 15h1.5" />
    </svg>
  )
}

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}
function IconCard() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </svg>
  )
}
function IconTransfer() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M3 7h13l-3-3M21 17H8l3 3" />
    </svg>
  )
}
function IconMapPin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full">
      <path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  )
}
