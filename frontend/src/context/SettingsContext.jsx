/**
 * SettingsContext — single source of truth for tenant SystemSetting values.
 *
 * Loaded once at app boot (after login). Every page that needs to gate UI on
 * a Business Settings toggle calls `useSettings()` instead of re-fetching.
 * `reload()` lets the Business Settings page push the freshly-saved values
 * back into the cache so all other open pages react immediately.
 *
 * Values are stored as a flat `{ [key]: value }` map and accessed via
 * helpers (`get`, `bool`, `num`, `str`) so consumers don't have to remember
 * the value_str → typed-value coercion rules.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react'

import { getAllSettings } from '../api/settings'
import { useAuth } from './AuthContext'

// ── Theme color palettes ──────────────────────────────────────────────────
// Each palette maps the 50→900 stops used by Tailwind utilities so we can
// rewrite CSS variables on <html> and let the rest of the app pick the
// accent up via `var(--theme-…)`. Components opt in by using `--theme-600`
// instead of hard-coded `bg-emerald-600`; older components keep their
// hard-coded colors and remain unaffected (they're still green / etc).
const THEME_PALETTES = {
  // Full Tailwind scales (50–950) so the accent token (`brand`, mapped to
  // var(--theme-*) in tailwind.config) re-colours every shade cleanly.
  emerald: { 50:'#ecfdf5', 100:'#d1fae5', 200:'#a7f3d0', 300:'#6ee7b7', 400:'#34d399', 500:'#10b981', 600:'#059669', 700:'#047857', 800:'#065f46', 900:'#064e3b', 950:'#022c22' },
  blue:    { 50:'#eff6ff', 100:'#dbeafe', 200:'#bfdbfe', 300:'#93c5fd', 400:'#60a5fa', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8', 800:'#1e40af', 900:'#1e3a8a', 950:'#172554' },
  indigo:  { 50:'#eef2ff', 100:'#e0e7ff', 200:'#c7d2fe', 300:'#a5b4fc', 400:'#818cf8', 500:'#6366f1', 600:'#4f46e5', 700:'#4338ca', 800:'#3730a3', 900:'#312e81', 950:'#1e1b4b' },
  purple:  { 50:'#faf5ff', 100:'#f3e8ff', 200:'#e9d5ff', 300:'#d8b4fe', 400:'#c084fc', 500:'#a855f7', 600:'#9333ea', 700:'#7e22ce', 800:'#6b21a8', 900:'#581c87', 950:'#3b0764' },
  rose:    { 50:'#fff1f2', 100:'#ffe4e6', 200:'#fecdd3', 300:'#fda4af', 400:'#fb7185', 500:'#f43f5e', 600:'#e11d48', 700:'#be123c', 800:'#9f1239', 900:'#881337', 950:'#4c0519' },
  amber:   { 50:'#fffbeb', 100:'#fef3c7', 200:'#fde68a', 300:'#fcd34d', 400:'#fbbf24', 500:'#f59e0b', 600:'#d97706', 700:'#b45309', 800:'#92400e', 900:'#78350f', 950:'#451a03' },
  slate:   { 50:'#f8fafc', 100:'#f1f5f9', 200:'#e2e8f0', 300:'#cbd5e1', 400:'#94a3b8', 500:'#64748b', 600:'#475569', 700:'#334155', 800:'#1e293b', 900:'#0f172a', 950:'#020617' },
}

// Theme-key aliases — the picker labels green as "emerald" etc., but accept a
// couple of friendly synonyms so older saved values still resolve.
const THEME_ALIASES = { green: 'emerald', red: 'rose' }

const SettingsCtx = createContext(null)

// ── Defaults (kept in one place so every consumer agrees) ────────────────
// When a setting hasn't been written yet, the helpers fall back to this map
// so the UI looks sensible on a brand-new tenant.
const DEFAULTS = {
  // Business
  'business.name':                       '',
  'currency.code':                       'BDT',
  'currency.symbol':                     '৳',
  'currency.position':                   'before',
  'timezone':                            'Asia/Dhaka',
  'business.date_format':                'mm/dd/yyyy',
  'business.time_format':                '12h',
  'business.transaction_edit_days':      180,
  'business.default_profit_percent':     40,
  'business.financial_year_start_month': 'January',
  'business.stock_accounting_method':    'fifo',
  // Tax
  'tax.tax1_name':                       '',
  'tax.tax1_number':                     '',
  'tax.tax2_name':                       '',
  'tax.tax2_number':                     '',
  'tax.default_rate':                    0,
  'tax.inclusive':                       false,
  'tax.inline_enabled':                  false,
  // Product
  'product.sku_prefix':                  '',
  'product.expiry_enabled':              false,
  'product.expiry_type':                 'add_item_expiry',
  'product.default_unit':                '',
  'product.enable_brands':               true,
  'product.enable_categories':           true,
  'product.enable_sub_categories':       true,
  'product.enable_price_tax_info':       true,
  'product.enable_sub_units':            false,
  'product.enable_warranty':             false,
  'product.enable_racks':                false,
  'product.enable_row':                  false,
  'product.enable_position':             false,
  // Sale
  'sale.default_discount':               0,
  'sale.default_tax':                    '',
  'sale.item_addition_method':           'increase_qty',
  'sale.rounding_method':                'none',
  'sale.price_is_min_selling':           false,
  'sale.allow_overselling':              true,
  'sale.enable_sales_order':             false,
  'sale.pay_term_required':              false,
  'sale.commission_agent_mode':          'disable',
  'sale.commission_calc_type':           'invoice_value',
  'sale.commission_required':            false,
  'sale.payment_link_enabled':           false,
  // POS — keyboard shortcuts (match the spec table)
  'pos.ks.express_checkout':             'shift+e',
  'pos.ks.pay_checkout':                 'shift+p',
  'pos.ks.draft':                        'shift+d',
  'pos.ks.cancel':                       'shift+c',
  'pos.ks.goto_qty':                     'f2',
  'pos.ks.weighing_scale':               '',
  'pos.ks.edit_discount':                'shift+i',
  'pos.ks.edit_order_tax':               'shift+t',
  'pos.ks.add_payment_row':              'shift+r',
  'pos.ks.finalize_payment':             'shift+f',
  'pos.ks.add_new_product':              'f4',
  // POS — behaviour toggles
  'pos.disable_multiple_pay':            false,
  'pos.disable_draft':                   false,
  'pos.disable_express_checkout':        false,
  'pos.hide_product_suggestion':         false,
  'pos.hide_recent_transactions':        false,
  'pos.disable_discount':                false,
  'pos.disable_order_tax':               false,
  'pos.subtotal_editable':               false,
  'pos.disable_suspend_sale':            false,
  'pos.enable_transaction_date':         false,
  'pos.enable_service_staff_in_line':    false,
  'pos.is_service_staff_required':       false,
  'pos.disable_credit_sale':             false,
  'pos.enable_weighing_scale':           false,
  'pos.show_invoice_scheme':             false,
  'pos.show_invoice_layout_dropdown':    false,
  'pos.print_invoice_on_suspend':        false,
  'pos.show_pricing_on_suggestion':      false,
}

function coerceBool(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number')  return v !== 0
  if (v == null) return false
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s))  return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return false
}

export function SettingsProvider({ children }) {
  const { user, isAuthenticated } = useAuth() || {}
  const [data,    setData]    = useState({})
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!isAuthenticated) { setData({}); return }
    setLoading(true)
    try {
      const res = await getAllSettings()
      // Backend returns either {key: {value, ...}} or {key: value} — accept either.
      const flat = {}
      if (res && typeof res === 'object' && !Array.isArray(res)) {
        for (const [k, v] of Object.entries(res)) {
          flat[k] = v && typeof v === 'object' && 'value' in v ? v.value : v
        }
      }
      setData(flat)
    } catch {
      // Non-fatal: most users without can_manage_settings 403 here. Just
      // fall back to defaults so the UI still renders.
      setData({})
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated])

  // Load on first authenticated render, reload whenever the user changes.
  useEffect(() => { reload() }, [reload, user?.id])

  // ── Apply System tab settings to the document ────────────────────────
  // Theme color writes CSS variables on <html>; show-help-text writes a
  // body class so global CSS can hide `.field-hint` etc.
  useEffect(() => {
    const rawKey   = String(data['system.theme_color'] || 'emerald').toLowerCase()
    const themeKey = THEME_ALIASES[rawKey] || rawKey
    const palette  = THEME_PALETTES[themeKey] || THEME_PALETTES.emerald
    const root = document.documentElement
    for (const [stop, hex] of Object.entries(palette)) {
      root.style.setProperty(`--theme-${stop}`, hex)
      // Also expose an "R G B" triplet so Tailwind opacity modifiers
      // (e.g. bg-brand-600/20) still work via rgb(var(...) / <alpha>).
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
      if (m) {
        root.style.setProperty(
          `--theme-${stop}-rgb`,
          `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`,
        )
      }
    }
    root.dataset.theme = themeKey

    const showHelp = coerceBool(
      data['system.show_help_text'] != null ? data['system.show_help_text'] : true
    )
    document.body.classList.toggle('hide-help-text', !showHelp)
  }, [data])

  const value = useMemo(() => {
    const get  = (k, fallback) =>
      (data[k] !== undefined ? data[k] : (fallback !== undefined ? fallback : DEFAULTS[k]))
    const bool = (k) => coerceBool(get(k, DEFAULTS[k]))
    const num  = (k, fallback = 0) => {
      const v = get(k, fallback)
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    const str  = (k, fallback = '') => {
      const v = get(k, fallback)
      return v == null ? fallback : String(v)
    }
    return { data, loading, reload, get, bool, num, str }
  }, [data, loading, reload])

  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsCtx)
  if (!ctx) {
    // Allow components to render outside the provider (login screen, etc.)
    // by returning a no-op shim with defaults.
    return {
      data: {}, loading: false, reload: async () => {},
      get:  (k, fb) => (fb !== undefined ? fb : DEFAULTS[k]),
      bool: (k) => coerceBool(DEFAULTS[k]),
      num:  (k, fb = 0) => {
        const v = DEFAULTS[k]
        const n = Number(v == null ? fb : v)
        return Number.isFinite(n) ? n : fb
      },
      str:  (k, fb = '') => {
        const v = DEFAULTS[k]
        return v == null ? fb : String(v)
      },
    }
  }
  return ctx
}

// ── Convenience hook: default datatable page size ────────────────────────
// Tables and lists can call this to honor Settings → System → "Default
// datatable page entries". Returns a sensible 25 if nothing's saved yet.
export function useDefaultPageSize(fallback = 25) {
  const s = useSettings()
  const n = Number(s.num('system.datatable_page_size', fallback))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ── Currency formatter that respects settings ─────────────────────────────
// Drop-in replacement for the scattered `fmtBDT` / `fmtMoney` helpers. Pass
// a settings object (from useSettings()) so the formatter is pure-functional
// and easy to memoise.
export function fmtCurrency(amount, settings) {
  const symbol   = (settings?.str?.('currency.symbol') ?? '৳') || '৳'
  const position = (settings?.str?.('currency.position') ?? 'before').toLowerCase()
  const n = Number(amount || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return position === 'after' ? `${n} ${symbol}` : `${symbol} ${n}`
}
