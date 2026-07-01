import { useState, useEffect } from 'react'
import { useLocation }         from 'react-router-dom'
import Sidebar from './Sidebar'
import Header  from './Header'
import { useBranch } from '../../context/BranchContext'
import BranchSelector from '../branch/BranchSelector'

const COLLAPSED_KEY = 'iffaa_sidebar_collapsed'

/**
 * AppLayout — persistent shell for all authenticated routes.
 *
 *  • Mobile (<lg)  : sidebar is an off-canvas drawer toggled by the hamburger.
 *  • Desktop (lg+) : sidebar is always docked; user can collapse it to icon-only.
 *
 * Clicking a leaf nav item auto-collapses the sidebar to icon mode (per design).
 * The "expanded vs collapsed" choice is persisted in sessionStorage so it
 * survives page reloads inside the same tab.
 */
export default function AppLayout({ children }) {
  const [mobileOpen,  setMobileOpen]  = useState(false)
  const [collapsed,   setCollapsed]   = useState(() => {
    try { return sessionStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
  })
  const location = useLocation()

  // Persist collapse choice per tab
  useEffect(() => {
    try { sessionStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed])

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  // Sidebar width as a CSS var so sticky bottom bars can clear it correctly
  // in both expanded (256px) and collapsed (68px) states.
  const sidebarWidth = collapsed ? '68px' : '256px'

  // Multi-branch: block the shell with the branch picker until the user
  // chooses (only when they can access more than one branch).
  const { needsSelection } = useBranch()

  return (
    <div
      className="flex h-screen bg-surface-subtle overflow-hidden"
      style={{ '--sidebar-w': sidebarWidth }}
    >
      {needsSelection && <BranchSelector />}
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        // Sidebar stays locked at whatever the user chose — only collapses
        // via the hamburger / panel-toggle button. Clicking a nav item does
        // NOT auto-collapse anymore.
      />

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <Header
          onMenuToggle={() => setMobileOpen((v) => !v)}
          onDesktopMenuToggle={() => setCollapsed((v) => !v)}
        />

        {/* Content area now uses the full available width — the previous
            max-w-7xl (≈1280px) cap left ~30% of every wide monitor
            unused. Padding still scales by breakpoint so phones don't
            get cramped. Pages that NEED a narrower reading width
            (settings, forms) can wrap their own content in
            <div className="max-w-5xl mx-auto"> locally. */}
        <main className="relative flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 scrollbar-thin">
          <div className="relative w-full animate-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
