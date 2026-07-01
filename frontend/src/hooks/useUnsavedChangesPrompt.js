import { useEffect } from 'react'

/**
 * useUnsavedChangesPrompt — warn the user before they leave a page
 * with unsaved work.
 *
 * Two layers, because BrowserRouter (which this app uses) does NOT
 * expose React Router's useBlocker:
 *
 *   1. window 'beforeunload' — covers tab close, refresh, browser
 *      back/forward, and address-bar nav. The browser owns the
 *      "Leave site? Changes that you made may not be saved." dialog.
 *
 *   2. Document-level capture-phase 'click' — covers SPA link clicks
 *      (sidebar NavLinks, in-page <Link>s, raw <a href> tags). When
 *      `when` is true and the clicked anchor would navigate AWAY from
 *      the current URL, we pop window.confirm; cancelling stops the
 *      navigation. We only intercept same-origin nav with target≠_blank,
 *      no modifier keys, so middle-click / cmd-click / external links
 *      still open in a new tab as expected.
 *
 * Usage:
 *     const dirty = cart.length > 0 || hasUnsavedFormFields
 *     useUnsavedChangesPrompt(dirty)
 *
 * Pass false (or unmount the hook) once you've saved.
 */
export default function useUnsavedChangesPrompt(when) {
  useEffect(() => {
    if (!when) return undefined

    const MSG = 'Changes that you made may not be saved. Leave anyway?'

    // ── Layer 1 — browser-level guard ──────────────────────────────
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = MSG
      return MSG
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    // ── Layer 2 — SPA link-click guard ─────────────────────────────
    const onClick = (e) => {
      // Ignore modifier-clicks (new tab / window / download) and
      // middle / right clicks — those don't replace the current page.
      if (e.defaultPrevented) return
      if (e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return

      // Walk up to the nearest <a> with an href.
      let el = e.target
      while (el && el !== document.body) {
        if (el.tagName === 'A' && el.getAttribute('href')) break
        el = el.parentElement
      }
      if (!el || el.tagName !== 'A') return
      if (el.target === '_blank') return
      if (el.hasAttribute('download')) return

      const href = el.getAttribute('href') || ''
      // Skip mailto:, tel:, javascript:, hash-only links.
      if (/^(mailto|tel|javascript|sms):/i.test(href)) return
      if (href.startsWith('#')) return

      // Only block same-origin nav.
      let dest
      try {
        dest = new URL(el.href, window.location.href)
      } catch {
        return
      }
      if (dest.origin !== window.location.origin) return

      // Same path (incl. hash → same screen) — no nav happens.
      if (dest.pathname === window.location.pathname && dest.search === window.location.search) {
        return
      }

      // The cashier confirms in the browser's native dialog. Cancel →
      // we eat the click so the route never changes.
      // eslint-disable-next-line no-alert
      if (!window.confirm(MSG)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Capture phase so we intercept BEFORE React Router's NavLink
    // handler swallows the click.
    document.addEventListener('click', onClick, true)

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [when])
}
