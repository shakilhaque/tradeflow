/**
 * Business Settings — Settings → Business Settings
 *
 * Tabbed configuration page that drives the tenant-scoped key/value
 * SystemSetting store (already exposed by /api/settings/). The Business
 * tab is fully wired; the rest are stubs with "Coming soon" placeholders
 * so the layout matches the source screenshot without shipping
 * half-finished forms. A single Update Settings button at the bottom
 * commits whatever the user touched via a single bulk PATCH.
 */
import { useEffect, useMemo, useState } from 'react'

import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import { getAllSettings, bulkUpdateSettings, getTaxGroups } from '../../api/settings'
import { getUnits } from '../../api/products'
import { useSettings } from '../../context/SettingsContext'
import PasswordInput from '../../components/ui/PasswordInput'

// ── Key catalog used by this page ─────────────────────────────────────────
// Other tabs will extend this; for now only the Business tab is wired.
const KEYS = {
  // Business
  BUSINESS_NAME:               'business.name',
  CURRENCY_CODE:               'currency.code',
  CURRENCY_SYMBOL:             'currency.symbol',
  CURRENCY_POSITION:           'currency.position',
  LOGO_URL:                    'business.logo_url',
  TRANSACTION_EDIT_DAYS:       'business.transaction_edit_days',
  START_DATE:                  'business.start_date',
  FINANCIAL_YEAR_START_MONTH:  'business.financial_year_start_month',
  DATE_FORMAT:                 'business.date_format',
  DEFAULT_PROFIT_PERCENT:      'business.default_profit_percent',
  TIMEZONE:                    'timezone',
  STOCK_ACCOUNTING_METHOD:     'business.stock_accounting_method',
  TIME_FORMAT:                 'business.time_format',
  // Invoice numbering — tenant-customisable so each business can
  // pick its own prefix / branch code / date / serial layout.
  INVOICE_PREFIX:              'invoice.prefix',
  INVOICE_USE_BRANCH_CODE:     'invoice.use_branch_code',
  INVOICE_DATE_FORMAT:         'invoice.date_format',
  INVOICE_SERIAL_DIGITS:       'invoice.serial_digits',
  // Tax
  TAX1_NAME:                   'tax.tax1_name',
  TAX1_NUMBER:                 'tax.tax1_number',
  TAX2_NAME:                   'tax.tax2_name',
  TAX2_NUMBER:                 'tax.tax2_number',
  TAX_INLINE_ENABLED:          'tax.inline_enabled',
  TAX_INCLUSIVE:               'tax.inclusive',
  TAX_DEFAULT_RATE:            'tax.default_rate',
  // Product
  PRODUCT_SKU_PREFIX:          'product.sku_prefix',
  PRODUCT_EXPIRY_ENABLED:      'product.expiry_enabled',
  PRODUCT_EXPIRY_TYPE:         'product.expiry_type',
  PRODUCT_DEFAULT_UNIT:        'product.default_unit',
  PRODUCT_ENABLE_BRANDS:       'product.enable_brands',
  PRODUCT_ENABLE_PRICE_TAX:    'product.enable_price_tax_info',
  PRODUCT_ENABLE_CATEGORIES:   'product.enable_categories',
  PRODUCT_ENABLE_SUBCATEGORIES:'product.enable_sub_categories',
  PRODUCT_ENABLE_SUB_UNITS:    'product.enable_sub_units',
  PRODUCT_ENABLE_RACKS:        'product.enable_racks',
  PRODUCT_ENABLE_ROW:          'product.enable_row',
  PRODUCT_ENABLE_POSITION:     'product.enable_position',
  PRODUCT_ENABLE_WARRANTY:     'product.enable_warranty',
  // Sale
  SALE_DEFAULT_DISCOUNT:       'sale.default_discount',
  SALE_DEFAULT_TAX:            'sale.default_tax',
  SALE_ITEM_ADDITION_METHOD:   'sale.item_addition_method',
  SALE_ROUNDING_METHOD:        'sale.rounding_method',
  SALE_PRICE_IS_MIN:           'sale.price_is_min_selling',
  SALE_ALLOW_OVERSELLING:      'sale.allow_overselling',
  SALE_ENABLE_SALES_ORDER:     'sale.enable_sales_order',
  SALE_PAY_TERM_REQUIRED:      'sale.pay_term_required',
  SALE_COMMISSION_AGENT:       'sale.commission_agent_mode',
  SALE_COMMISSION_CALC_TYPE:   'sale.commission_calc_type',
  SALE_COMMISSION_REQUIRED:    'sale.commission_required',
  SALE_PAYLINK_ENABLED:        'sale.payment_link_enabled',
  SALE_RAZORPAY_KEY_ID:        'sale.razorpay_key_id',
  SALE_RAZORPAY_KEY_SECRET:    'sale.razorpay_key_secret',
  SALE_STRIPE_PUBLIC_KEY:      'sale.stripe_public_key',
  SALE_STRIPE_SECRET_KEY:      'sale.stripe_secret_key',
  // Sales on POS — keyboard shortcuts
  POS_KS_EXPRESS_CHECKOUT:     'pos.ks.express_checkout',
  POS_KS_PAY_CHECKOUT:         'pos.ks.pay_checkout',
  POS_KS_DRAFT:                'pos.ks.draft',
  POS_KS_CANCEL:               'pos.ks.cancel',
  POS_KS_GOTO_QTY:             'pos.ks.goto_qty',
  POS_KS_WEIGHING_SCALE:       'pos.ks.weighing_scale',
  POS_KS_EDIT_DISCOUNT:        'pos.ks.edit_discount',
  POS_KS_EDIT_ORDER_TAX:       'pos.ks.edit_order_tax',
  POS_KS_ADD_PAYMENT_ROW:      'pos.ks.add_payment_row',
  POS_KS_FINALIZE_PAYMENT:     'pos.ks.finalize_payment',
  POS_KS_ADD_NEW_PRODUCT:      'pos.ks.add_new_product',
  // Sales on POS — behaviour toggles
  POS_DISABLE_MULTIPLE_PAY:    'pos.disable_multiple_pay',
  POS_DISABLE_DRAFT:           'pos.disable_draft',
  POS_DISABLE_EXPRESS:         'pos.disable_express_checkout',
  POS_HIDE_PRODUCT_SUGGEST:    'pos.hide_product_suggestion',
  POS_HIDE_RECENT_TX:          'pos.hide_recent_transactions',
  POS_DISABLE_DISCOUNT:        'pos.disable_discount',
  POS_DISABLE_ORDER_TAX:       'pos.disable_order_tax',
  POS_SUBTOTAL_EDITABLE:       'pos.subtotal_editable',
  POS_DISABLE_SUSPEND:         'pos.disable_suspend_sale',
  POS_TXDATE_ENABLED:          'pos.enable_transaction_date',
  POS_SERVICE_STAFF_LINE:      'pos.enable_service_staff_in_line',
  POS_SERVICE_STAFF_REQUIRED:  'pos.is_service_staff_required',
  POS_DISABLE_CREDIT_SALE:     'pos.disable_credit_sale',
  POS_ENABLE_WEIGHING:         'pos.enable_weighing_scale',
  POS_SHOW_INVOICE_SCHEME:     'pos.show_invoice_scheme',
  POS_SHOW_INVOICE_LAYOUT_DD:  'pos.show_invoice_layout_dropdown',
  POS_PRINT_ON_SUSPEND:        'pos.print_invoice_on_suspend',
  POS_SHOW_PRICE_TOOLTIP:      'pos.show_pricing_on_suggestion',
  // Sales on POS — cash denoms + weighing scale barcode
  POS_CASH_DENOMINATIONS:      'pos.cash_denominations',
  POS_WS_PREFIX:               'pos.ws.prefix',
  POS_WS_SKU_LEN:              'pos.ws.sku_length',
  POS_WS_QTY_INT_LEN:          'pos.ws.qty_int_length',
  POS_WS_QTY_FRAC_LEN:         'pos.ws.qty_frac_length',
  // System
  SYSTEM_THEME_COLOR:          'system.theme_color',
  SYSTEM_DATATABLE_PAGE_SIZE:  'system.datatable_page_size',
  SYSTEM_SHOW_HELP_TEXT:       'system.show_help_text',
}

const CURRENCIES = [
  { value: 'BDT', label: 'Bangladesh — Taka (BDT)', symbol: '৳' },
  { value: 'USD', label: 'United States — Dollar (USD)', symbol: '$' },
  { value: 'EUR', label: 'European Union — Euro (EUR)', symbol: '€' },
  { value: 'GBP', label: 'United Kingdom — Pound (GBP)', symbol: '£' },
  { value: 'INR', label: 'India — Rupee (INR)', symbol: '₹' },
  { value: 'PKR', label: 'Pakistan — Rupee (PKR)', symbol: '₨' },
  { value: 'AED', label: 'UAE — Dirham (AED)', symbol: 'د.إ' },
  { value: 'SAR', label: 'Saudi Arabia — Riyal (SAR)', symbol: '﷼' },
]

const TIMEZONES = [
  'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh',
  'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles', 'UTC',
]

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const DATE_FORMATS = [
  { value: 'mm/dd/yyyy', label: 'mm/dd/yyyy (e.g. 12/31/2025)' },
  { value: 'dd/mm/yyyy', label: 'dd/mm/yyyy (e.g. 31/12/2025)' },
  { value: 'yyyy-mm-dd', label: 'yyyy-mm-dd (e.g. 2025-12-31)' },
  { value: 'dd-mm-yyyy', label: 'dd-mm-yyyy (e.g. 31-12-2025)' },
]

const TIME_FORMATS = [
  { value: '12h', label: '12 Hour (e.g. 02:30 PM)' },
  { value: '24h', label: '24 Hour (e.g. 14:30)' },
]

const STOCK_METHODS = [
  { value: 'fifo', label: 'FIFO (First In First Out)' },
  { value: 'lifo', label: 'LIFO (Last In First Out)' },
  { value: 'avg',  label: 'Weighted Average' },
]

const TABS = [
  { id: 'business',  label: 'Business',         hint: 'Identity, currency, dates, accounting' },
  { id: 'tax',       label: 'Tax',              hint: 'Tax numbers, default rate, inline tax' },
  { id: 'product',   label: 'Product',          hint: 'SKU prefix, expiry, units, brands, racks' },
  { id: 'sale',      label: 'Sale',             hint: 'Defaults, rounding, commission' },
  { id: 'pos',       label: 'Sales on POS',     hint: 'Keyboard shortcuts, toggles, weighing scale' },
  { id: 'system',    label: 'System',           hint: 'Theme color, page size, help text' },
]

// ── Component ────────────────────────────────────────────────────────────

export default function BusinessSettingsPage() {
  const { reload: reloadSettingsCtx } = useSettings()
  const [tab,     setTab]     = useState('business')
  const [search,  setSearch]  = useState('')

  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [info,    setInfo]    = useState('')
  const [units,      setUnits]      = useState([])
  const [taxGroups,  setTaxGroups]  = useState([])

  // The page tracks the *initial* values it loaded (so we only PATCH what
  // actually changed) and the working draft the user is editing.
  const [initial, setInitial] = useState({})
  const [form,    setForm]    = useState({
    // Business defaults
    business_name:              '',
    start_date:                 '',
    default_profit_percent:     '40',
    currency_code:              'BDT',
    currency_position:          'before',
    financial_year_start_month: 'January',
    timezone:                   'Asia/Dhaka',
    logo_url:                   '',
    transaction_edit_days:      '180',
    date_format:                'mm/dd/yyyy',
    stock_accounting_method:    'fifo',
    time_format:                '12h',
    // Invoice numbering defaults — match the existing _generate_
    // invoice_number behaviour so a tenant who hasn't touched the
    // setting still gets INV-<branch>-<date>-NNN.
    invoice_prefix:             'INV',
    invoice_use_branch_code:    true,
    invoice_date_format:        'DDMMYYYY',
    invoice_serial_digits:      '3',
    // Tax defaults
    tax1_name:                  '',
    tax1_number:                '',
    tax2_name:                  '',
    tax2_number:                '',
    tax_inline_enabled:         false,
    tax_inclusive:              false,
    tax_default_rate:           '0',
    // Product defaults
    product_sku_prefix:          '',
    product_expiry_enabled:      false,
    product_expiry_type:         'add_item_expiry',
    product_default_unit:        '',
    product_enable_brands:       true,
    product_enable_price_tax:    true,
    product_enable_categories:   true,
    product_enable_subcategories:true,
    product_enable_sub_units:    false,
    product_enable_racks:        false,
    product_enable_row:          false,
    product_enable_position:     false,
    product_enable_warranty:     false,
    // Sale defaults
    sale_default_discount:       '0',
    sale_default_tax:            '',
    sale_item_addition_method:   'increase_qty',
    sale_rounding_method:        'none',
    sale_price_is_min:           false,
    sale_allow_overselling:      true,
    sale_enable_sales_order:     false,
    sale_pay_term_required:      false,
    sale_commission_agent:       'disable',
    sale_commission_calc_type:   'invoice_value',
    sale_commission_required:    false,
    sale_paylink_enabled:        false,
    sale_razorpay_key_id:        '',
    sale_razorpay_key_secret:    '',
    sale_stripe_public_key:      '',
    sale_stripe_secret_key:      '',
    // POS — keyboard shortcut defaults (match the source screenshot)
    pos_ks_express_checkout:     'shift+e',
    pos_ks_pay_checkout:         'shift+p',
    pos_ks_draft:                'shift+d',
    pos_ks_cancel:               'shift+c',
    pos_ks_goto_qty:             'f2',
    pos_ks_weighing_scale:       '',
    pos_ks_edit_discount:        'shift+i',
    pos_ks_edit_order_tax:       'shift+t',
    pos_ks_add_payment_row:      'shift+r',
    pos_ks_finalize_payment:     'shift+f',
    pos_ks_add_new_product:      'f4',
    // POS — behaviour toggles
    pos_disable_multiple_pay:    false,
    pos_disable_draft:           false,
    pos_disable_express:         false,
    pos_hide_product_suggest:    false,
    pos_hide_recent_tx:          false,
    pos_disable_discount:        false,
    pos_disable_order_tax:       false,
    pos_subtotal_editable:       false,
    pos_disable_suspend:         false,
    pos_txdate_enabled:          false,
    pos_service_staff_line:      false,
    pos_service_staff_required:  false,
    pos_disable_credit_sale:     false,
    pos_enable_weighing:         false,
    pos_show_invoice_scheme:     false,
    pos_show_invoice_layout_dd:  false,
    pos_print_on_suspend:        false,
    pos_show_price_tooltip:      false,
    // POS — cash denoms + weighing scale barcode layout
    pos_cash_denominations:      '',
    pos_ws_prefix:               '',
    pos_ws_sku_len:              '5',
    pos_ws_qty_int_len:          '4',
    pos_ws_qty_frac_len:         '3',
    // System
    system_theme_color:          'emerald',
    system_datatable_page_size:  '25',
    system_show_help_text:        true,
  })

  // ── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError('')
      try {
        const res = await getAllSettings()
        // Backend can return {key: {value, ...}} or {key: value} — handle both.
        const map = {}
        if (res && typeof res === 'object' && !Array.isArray(res)) {
          for (const [k, v] of Object.entries(res)) {
            map[k] = v && typeof v === 'object' && 'value' in v ? v.value : v
          }
        }
        if (cancelled) return
        const seeded = {
          business_name:              map[KEYS.BUSINESS_NAME] ?? '',
          start_date:                 map[KEYS.START_DATE] ?? '',
          default_profit_percent:     map[KEYS.DEFAULT_PROFIT_PERCENT] ?? '40',
          currency_code:              map[KEYS.CURRENCY_CODE] ?? 'BDT',
          currency_position:          map[KEYS.CURRENCY_POSITION] ?? 'before',
          financial_year_start_month: map[KEYS.FINANCIAL_YEAR_START_MONTH] ?? 'January',
          timezone:                   map[KEYS.TIMEZONE] ?? 'Asia/Dhaka',
          logo_url:                   map[KEYS.LOGO_URL] ?? '',
          transaction_edit_days:      map[KEYS.TRANSACTION_EDIT_DAYS] ?? '180',
          date_format:                map[KEYS.DATE_FORMAT] ?? 'mm/dd/yyyy',
          stock_accounting_method:    map[KEYS.STOCK_ACCOUNTING_METHOD] ?? 'fifo',
          time_format:                map[KEYS.TIME_FORMAT] ?? '12h',
          invoice_prefix:             map[KEYS.INVOICE_PREFIX] ?? 'INV',
          invoice_use_branch_code:    String(map[KEYS.INVOICE_USE_BRANCH_CODE] ?? 'true') === 'true',
          invoice_date_format:        map[KEYS.INVOICE_DATE_FORMAT] ?? 'DDMMYYYY',
          invoice_serial_digits:      String(map[KEYS.INVOICE_SERIAL_DIGITS] ?? '3'),
          // Tax
          tax1_name:                  map[KEYS.TAX1_NAME] ?? '',
          tax1_number:                map[KEYS.TAX1_NUMBER] ?? '',
          tax2_name:                  map[KEYS.TAX2_NAME] ?? '',
          tax2_number:                map[KEYS.TAX2_NUMBER] ?? '',
          tax_inline_enabled:         coerceBool(map[KEYS.TAX_INLINE_ENABLED], false),
          tax_inclusive:              coerceBool(map[KEYS.TAX_INCLUSIVE], false),
          tax_default_rate:           map[KEYS.TAX_DEFAULT_RATE] != null
            ? String(map[KEYS.TAX_DEFAULT_RATE]) : '0',
          // Product
          product_sku_prefix:           map[KEYS.PRODUCT_SKU_PREFIX] ?? '',
          product_expiry_enabled:       coerceBool(map[KEYS.PRODUCT_EXPIRY_ENABLED], false),
          product_expiry_type:          map[KEYS.PRODUCT_EXPIRY_TYPE] ?? 'add_item_expiry',
          product_default_unit:         map[KEYS.PRODUCT_DEFAULT_UNIT] ?? '',
          product_enable_brands:        coerceBool(map[KEYS.PRODUCT_ENABLE_BRANDS], true),
          product_enable_price_tax:     coerceBool(map[KEYS.PRODUCT_ENABLE_PRICE_TAX], true),
          product_enable_categories:    coerceBool(map[KEYS.PRODUCT_ENABLE_CATEGORIES], true),
          product_enable_subcategories: coerceBool(map[KEYS.PRODUCT_ENABLE_SUBCATEGORIES], true),
          product_enable_sub_units:     coerceBool(map[KEYS.PRODUCT_ENABLE_SUB_UNITS], false),
          product_enable_racks:         coerceBool(map[KEYS.PRODUCT_ENABLE_RACKS], false),
          product_enable_row:           coerceBool(map[KEYS.PRODUCT_ENABLE_ROW], false),
          product_enable_position:      coerceBool(map[KEYS.PRODUCT_ENABLE_POSITION], false),
          product_enable_warranty:      coerceBool(map[KEYS.PRODUCT_ENABLE_WARRANTY], false),
          // Sale
          sale_default_discount:        map[KEYS.SALE_DEFAULT_DISCOUNT] != null
            ? String(map[KEYS.SALE_DEFAULT_DISCOUNT]) : '0',
          sale_default_tax:             map[KEYS.SALE_DEFAULT_TAX] ?? '',
          sale_item_addition_method:    map[KEYS.SALE_ITEM_ADDITION_METHOD] ?? 'increase_qty',
          sale_rounding_method:         map[KEYS.SALE_ROUNDING_METHOD] ?? 'none',
          sale_price_is_min:            coerceBool(map[KEYS.SALE_PRICE_IS_MIN], false),
          sale_allow_overselling:       coerceBool(map[KEYS.SALE_ALLOW_OVERSELLING], true),
          sale_enable_sales_order:      coerceBool(map[KEYS.SALE_ENABLE_SALES_ORDER], false),
          sale_pay_term_required:       coerceBool(map[KEYS.SALE_PAY_TERM_REQUIRED], false),
          sale_commission_agent:        map[KEYS.SALE_COMMISSION_AGENT] ?? 'disable',
          sale_commission_calc_type:    map[KEYS.SALE_COMMISSION_CALC_TYPE] ?? 'invoice_value',
          sale_commission_required:     coerceBool(map[KEYS.SALE_COMMISSION_REQUIRED], false),
          sale_paylink_enabled:         coerceBool(map[KEYS.SALE_PAYLINK_ENABLED], false),
          sale_razorpay_key_id:         map[KEYS.SALE_RAZORPAY_KEY_ID] ?? '',
          sale_razorpay_key_secret:     map[KEYS.SALE_RAZORPAY_KEY_SECRET] ?? '',
          sale_stripe_public_key:       map[KEYS.SALE_STRIPE_PUBLIC_KEY] ?? '',
          sale_stripe_secret_key:       map[KEYS.SALE_STRIPE_SECRET_KEY] ?? '',
          // POS — keyboard shortcuts
          pos_ks_express_checkout:      map[KEYS.POS_KS_EXPRESS_CHECKOUT] ?? 'shift+e',
          pos_ks_pay_checkout:          map[KEYS.POS_KS_PAY_CHECKOUT] ?? 'shift+p',
          pos_ks_draft:                 map[KEYS.POS_KS_DRAFT] ?? 'shift+d',
          pos_ks_cancel:                map[KEYS.POS_KS_CANCEL] ?? 'shift+c',
          pos_ks_goto_qty:              map[KEYS.POS_KS_GOTO_QTY] ?? 'f2',
          pos_ks_weighing_scale:        map[KEYS.POS_KS_WEIGHING_SCALE] ?? '',
          pos_ks_edit_discount:         map[KEYS.POS_KS_EDIT_DISCOUNT] ?? 'shift+i',
          pos_ks_edit_order_tax:        map[KEYS.POS_KS_EDIT_ORDER_TAX] ?? 'shift+t',
          pos_ks_add_payment_row:       map[KEYS.POS_KS_ADD_PAYMENT_ROW] ?? 'shift+r',
          pos_ks_finalize_payment:      map[KEYS.POS_KS_FINALIZE_PAYMENT] ?? 'shift+f',
          pos_ks_add_new_product:       map[KEYS.POS_KS_ADD_NEW_PRODUCT] ?? 'f4',
          // POS — toggles
          pos_disable_multiple_pay:     coerceBool(map[KEYS.POS_DISABLE_MULTIPLE_PAY], false),
          pos_disable_draft:            coerceBool(map[KEYS.POS_DISABLE_DRAFT], false),
          pos_disable_express:          coerceBool(map[KEYS.POS_DISABLE_EXPRESS], false),
          pos_hide_product_suggest:     coerceBool(map[KEYS.POS_HIDE_PRODUCT_SUGGEST], false),
          pos_hide_recent_tx:           coerceBool(map[KEYS.POS_HIDE_RECENT_TX], false),
          pos_disable_discount:         coerceBool(map[KEYS.POS_DISABLE_DISCOUNT], false),
          pos_disable_order_tax:        coerceBool(map[KEYS.POS_DISABLE_ORDER_TAX], false),
          pos_subtotal_editable:        coerceBool(map[KEYS.POS_SUBTOTAL_EDITABLE], false),
          pos_disable_suspend:          coerceBool(map[KEYS.POS_DISABLE_SUSPEND], false),
          pos_txdate_enabled:           coerceBool(map[KEYS.POS_TXDATE_ENABLED], false),
          pos_service_staff_line:       coerceBool(map[KEYS.POS_SERVICE_STAFF_LINE], false),
          pos_service_staff_required:   coerceBool(map[KEYS.POS_SERVICE_STAFF_REQUIRED], false),
          pos_disable_credit_sale:      coerceBool(map[KEYS.POS_DISABLE_CREDIT_SALE], false),
          pos_enable_weighing:          coerceBool(map[KEYS.POS_ENABLE_WEIGHING], false),
          pos_show_invoice_scheme:      coerceBool(map[KEYS.POS_SHOW_INVOICE_SCHEME], false),
          pos_show_invoice_layout_dd:   coerceBool(map[KEYS.POS_SHOW_INVOICE_LAYOUT_DD], false),
          pos_print_on_suspend:         coerceBool(map[KEYS.POS_PRINT_ON_SUSPEND], false),
          pos_show_price_tooltip:       coerceBool(map[KEYS.POS_SHOW_PRICE_TOOLTIP], false),
          // POS — denoms + weighing barcode
          pos_cash_denominations:       map[KEYS.POS_CASH_DENOMINATIONS] ?? '',
          pos_ws_prefix:                map[KEYS.POS_WS_PREFIX] ?? '',
          pos_ws_sku_len:               map[KEYS.POS_WS_SKU_LEN] != null
            ? String(map[KEYS.POS_WS_SKU_LEN]) : '5',
          pos_ws_qty_int_len:           map[KEYS.POS_WS_QTY_INT_LEN] != null
            ? String(map[KEYS.POS_WS_QTY_INT_LEN]) : '4',
          pos_ws_qty_frac_len:          map[KEYS.POS_WS_QTY_FRAC_LEN] != null
            ? String(map[KEYS.POS_WS_QTY_FRAC_LEN]) : '3',
          // System
          system_theme_color:           map[KEYS.SYSTEM_THEME_COLOR] ?? 'emerald',
          system_datatable_page_size:   map[KEYS.SYSTEM_DATATABLE_PAGE_SIZE] != null
            ? String(map[KEYS.SYSTEM_DATATABLE_PAGE_SIZE]) : '25',
          system_show_help_text:        coerceBool(map[KEYS.SYSTEM_SHOW_HELP_TEXT], true),
        }
        setInitial(seeded)
        setForm(seeded)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load settings.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Fetch units + tax groups once for the picker dropdowns ──────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getUnits()
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        if (!cancelled) setUnits(arr)
      } catch { /* picker just shows the saved value as raw text */ }
      try {
        const res = await getTaxGroups()
        const arr = Array.isArray(res) ? res : (res?.results ?? [])
        if (!cancelled) setTaxGroups(arr)
      } catch { /* same */ }
    })()
    return () => { cancelled = true }
  }, [])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }))

  // Convenience: derive currency symbol from the picked code.
  const currentCurrency = CURRENCIES.find((c) => c.value === form.currency_code) || CURRENCIES[0]

  // Pre-filter the left-tab list when the user types in the search input.
  const visibleTabs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return TABS
    return TABS.filter((t) => t.label.toLowerCase().includes(q))
  }, [search])

  const dirty = useMemo(
    () => Object.keys(form).some((k) => String(form[k] ?? '') !== String(initial[k] ?? '')),
    [form, initial]
  )

  const onSave = async () => {
    setError(''); setInfo('')
    setSaving(true)
    try {
      const payload = {
        [KEYS.BUSINESS_NAME]:              form.business_name,
        [KEYS.START_DATE]:                 form.start_date,
        [KEYS.DEFAULT_PROFIT_PERCENT]:     Number(form.default_profit_percent || 0),
        [KEYS.CURRENCY_CODE]:              form.currency_code,
        [KEYS.CURRENCY_SYMBOL]:            currentCurrency.symbol,
        [KEYS.CURRENCY_POSITION]:          form.currency_position,
        [KEYS.FINANCIAL_YEAR_START_MONTH]: form.financial_year_start_month,
        [KEYS.TIMEZONE]:                   form.timezone,
        [KEYS.LOGO_URL]:                   form.logo_url,
        [KEYS.TRANSACTION_EDIT_DAYS]:      Number(form.transaction_edit_days || 0),
        [KEYS.DATE_FORMAT]:                form.date_format,
        [KEYS.STOCK_ACCOUNTING_METHOD]:    form.stock_accounting_method,
        [KEYS.TIME_FORMAT]:                form.time_format,
        [KEYS.INVOICE_PREFIX]:             form.invoice_prefix,
        [KEYS.INVOICE_USE_BRANCH_CODE]:    String(!!form.invoice_use_branch_code),
        [KEYS.INVOICE_DATE_FORMAT]:        form.invoice_date_format,
        [KEYS.INVOICE_SERIAL_DIGITS]:      String(form.invoice_serial_digits || '3'),
        // Tax
        [KEYS.TAX1_NAME]:                  form.tax1_name,
        [KEYS.TAX1_NUMBER]:                form.tax1_number,
        [KEYS.TAX2_NAME]:                  form.tax2_name,
        [KEYS.TAX2_NUMBER]:                form.tax2_number,
        [KEYS.TAX_INLINE_ENABLED]:         !!form.tax_inline_enabled,
        [KEYS.TAX_INCLUSIVE]:              !!form.tax_inclusive,
        [KEYS.TAX_DEFAULT_RATE]:           Number(form.tax_default_rate || 0),
        // Product
        [KEYS.PRODUCT_SKU_PREFIX]:          form.product_sku_prefix,
        [KEYS.PRODUCT_EXPIRY_ENABLED]:      !!form.product_expiry_enabled,
        [KEYS.PRODUCT_EXPIRY_TYPE]:         form.product_expiry_type,
        [KEYS.PRODUCT_DEFAULT_UNIT]:        form.product_default_unit,
        [KEYS.PRODUCT_ENABLE_BRANDS]:       !!form.product_enable_brands,
        [KEYS.PRODUCT_ENABLE_PRICE_TAX]:    !!form.product_enable_price_tax,
        [KEYS.PRODUCT_ENABLE_CATEGORIES]:   !!form.product_enable_categories,
        [KEYS.PRODUCT_ENABLE_SUBCATEGORIES]:!!form.product_enable_subcategories,
        [KEYS.PRODUCT_ENABLE_SUB_UNITS]:    !!form.product_enable_sub_units,
        [KEYS.PRODUCT_ENABLE_RACKS]:        !!form.product_enable_racks,
        [KEYS.PRODUCT_ENABLE_ROW]:          !!form.product_enable_row,
        [KEYS.PRODUCT_ENABLE_POSITION]:     !!form.product_enable_position,
        [KEYS.PRODUCT_ENABLE_WARRANTY]:     !!form.product_enable_warranty,
        // Sale
        [KEYS.SALE_DEFAULT_DISCOUNT]:       Number(form.sale_default_discount || 0),
        [KEYS.SALE_DEFAULT_TAX]:            form.sale_default_tax,
        [KEYS.SALE_ITEM_ADDITION_METHOD]:   form.sale_item_addition_method,
        [KEYS.SALE_ROUNDING_METHOD]:        form.sale_rounding_method,
        [KEYS.SALE_PRICE_IS_MIN]:           !!form.sale_price_is_min,
        [KEYS.SALE_ALLOW_OVERSELLING]:      !!form.sale_allow_overselling,
        [KEYS.SALE_ENABLE_SALES_ORDER]:     !!form.sale_enable_sales_order,
        [KEYS.SALE_PAY_TERM_REQUIRED]:      !!form.sale_pay_term_required,
        [KEYS.SALE_COMMISSION_AGENT]:       form.sale_commission_agent,
        [KEYS.SALE_COMMISSION_CALC_TYPE]:   form.sale_commission_calc_type,
        [KEYS.SALE_COMMISSION_REQUIRED]:    !!form.sale_commission_required,
        [KEYS.SALE_PAYLINK_ENABLED]:        !!form.sale_paylink_enabled,
        [KEYS.SALE_RAZORPAY_KEY_ID]:        form.sale_razorpay_key_id,
        [KEYS.SALE_RAZORPAY_KEY_SECRET]:    form.sale_razorpay_key_secret,
        [KEYS.SALE_STRIPE_PUBLIC_KEY]:      form.sale_stripe_public_key,
        [KEYS.SALE_STRIPE_SECRET_KEY]:      form.sale_stripe_secret_key,
        // POS — keyboard shortcuts
        [KEYS.POS_KS_EXPRESS_CHECKOUT]:     form.pos_ks_express_checkout,
        [KEYS.POS_KS_PAY_CHECKOUT]:         form.pos_ks_pay_checkout,
        [KEYS.POS_KS_DRAFT]:                form.pos_ks_draft,
        [KEYS.POS_KS_CANCEL]:               form.pos_ks_cancel,
        [KEYS.POS_KS_GOTO_QTY]:             form.pos_ks_goto_qty,
        [KEYS.POS_KS_WEIGHING_SCALE]:       form.pos_ks_weighing_scale,
        [KEYS.POS_KS_EDIT_DISCOUNT]:        form.pos_ks_edit_discount,
        [KEYS.POS_KS_EDIT_ORDER_TAX]:       form.pos_ks_edit_order_tax,
        [KEYS.POS_KS_ADD_PAYMENT_ROW]:      form.pos_ks_add_payment_row,
        [KEYS.POS_KS_FINALIZE_PAYMENT]:     form.pos_ks_finalize_payment,
        [KEYS.POS_KS_ADD_NEW_PRODUCT]:      form.pos_ks_add_new_product,
        // POS — toggles
        [KEYS.POS_DISABLE_MULTIPLE_PAY]:    !!form.pos_disable_multiple_pay,
        [KEYS.POS_DISABLE_DRAFT]:           !!form.pos_disable_draft,
        [KEYS.POS_DISABLE_EXPRESS]:         !!form.pos_disable_express,
        [KEYS.POS_HIDE_PRODUCT_SUGGEST]:    !!form.pos_hide_product_suggest,
        [KEYS.POS_HIDE_RECENT_TX]:          !!form.pos_hide_recent_tx,
        [KEYS.POS_DISABLE_DISCOUNT]:        !!form.pos_disable_discount,
        [KEYS.POS_DISABLE_ORDER_TAX]:       !!form.pos_disable_order_tax,
        [KEYS.POS_SUBTOTAL_EDITABLE]:       !!form.pos_subtotal_editable,
        [KEYS.POS_DISABLE_SUSPEND]:         !!form.pos_disable_suspend,
        [KEYS.POS_TXDATE_ENABLED]:          !!form.pos_txdate_enabled,
        [KEYS.POS_SERVICE_STAFF_LINE]:      !!form.pos_service_staff_line,
        [KEYS.POS_SERVICE_STAFF_REQUIRED]:  !!form.pos_service_staff_required,
        [KEYS.POS_DISABLE_CREDIT_SALE]:     !!form.pos_disable_credit_sale,
        [KEYS.POS_ENABLE_WEIGHING]:         !!form.pos_enable_weighing,
        [KEYS.POS_SHOW_INVOICE_SCHEME]:     !!form.pos_show_invoice_scheme,
        [KEYS.POS_SHOW_INVOICE_LAYOUT_DD]:  !!form.pos_show_invoice_layout_dd,
        [KEYS.POS_PRINT_ON_SUSPEND]:        !!form.pos_print_on_suspend,
        [KEYS.POS_SHOW_PRICE_TOOLTIP]:      !!form.pos_show_price_tooltip,
        // POS — denoms + weighing barcode
        [KEYS.POS_CASH_DENOMINATIONS]:      form.pos_cash_denominations,
        [KEYS.POS_WS_PREFIX]:               form.pos_ws_prefix,
        [KEYS.POS_WS_SKU_LEN]:              Number(form.pos_ws_sku_len || 0),
        [KEYS.POS_WS_QTY_INT_LEN]:          Number(form.pos_ws_qty_int_len || 0),
        [KEYS.POS_WS_QTY_FRAC_LEN]:         Number(form.pos_ws_qty_frac_len || 0),
        // System
        [KEYS.SYSTEM_THEME_COLOR]:          form.system_theme_color,
        [KEYS.SYSTEM_DATATABLE_PAGE_SIZE]:  Number(form.system_datatable_page_size || 25),
        [KEYS.SYSTEM_SHOW_HELP_TEXT]:       !!form.system_show_help_text,
      }
      await bulkUpdateSettings(payload)
      setInitial(form)
      setInfo('Settings saved.')
      // Push the freshly-saved values into the global SettingsContext so
      // other open pages (POS, Add Product, …) react without a refresh.
      reloadSettingsCtx?.()
    } catch (err) {
      setError(err?.message || 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 pb-24">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 shadow-sm">
        <h1 className="text-xl font-bold text-white tracking-tight">Business Settings</h1>
        <p className="text-xs text-emerald-50 mt-0.5">
          Identity, currency, dates and accounting defaults. Changes take
          effect immediately on save and apply to every screen in the app.
        </p>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {info  && <Banner kind="info">{info}</Banner>}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-5">
        {/* ── Left tab nav ────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-3 py-2">
            <div className="relative">
              <SearchIcon />
              <input
                type="text" value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search settings…"
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>
          </div>
          <nav className="py-1">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={[
                  'w-full text-left px-4 py-2.5 text-sm transition-colors',
                  tab === t.id
                    ? 'bg-emerald-50 text-emerald-700 font-semibold border-l-2 border-emerald-600'
                    : 'text-gray-700 hover:bg-gray-50 border-l-2 border-transparent',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{t.label}</span>
                  {!['business', 'tax', 'product', 'sale', 'pos', 'system'].includes(t.id) && (
                    <span className="text-[10px] text-gray-400 uppercase">Soon</span>
                  )}
                </div>
                {t.hint && tab === t.id && (
                  <p className="mt-0.5 text-[10px] font-normal text-emerald-600/80">{t.hint}</p>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* ── Right content ───────────────────────────────────────────── */}
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-6 py-4 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-900">
              {(TABS.find((t) => t.id === tab) || {}).label}
            </h2>
            {tab === 'business' && (
              <span className={`text-[11px] font-semibold ${dirty ? 'text-amber-600' : 'text-gray-400'}`}>
                {dirty ? 'Unsaved changes' : 'No changes'}
              </span>
            )}
          </div>

          <div className="p-6">
            {loading ? (
              <div className="flex justify-center py-16">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
              </div>
            ) : tab === 'business' ? (
              <BusinessTab
                form={form}
                set={set}
                currencies={CURRENCIES}
                timezones={TIMEZONES}
                months={MONTHS}
                dateFormats={DATE_FORMATS}
                timeFormats={TIME_FORMATS}
                stockMethods={STOCK_METHODS}
              />
            ) : tab === 'tax' ? (
              <TaxTab form={form} set={set} setForm={setForm} />
            ) : tab === 'product' ? (
              <ProductTab form={form} set={set} setForm={setForm} units={units} />
            ) : tab === 'sale' ? (
              <SaleTab form={form} set={set} setForm={setForm} taxGroups={taxGroups} />
            ) : tab === 'pos' ? (
              <PosTab form={form} set={set} setForm={setForm} />
            ) : tab === 'system' ? (
              <SystemTab form={form} set={set} setForm={setForm} />
            ) : (
              <ComingSoon label={(TABS.find((t) => t.id === tab) || {}).label} />
            )}
          </div>
        </div>
      </div>

      {/* ── Sticky save bar ─────────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white/90 px-6 py-3 shadow-lg backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            {dirty
              ? <span className="text-amber-600 font-semibold">You have unsaved changes.</span>
              : 'All settings are saved.'}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm"
                    disabled={!dirty || saving}
                    onClick={() => setForm(initial)}>
              Discard
            </Button>
            <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
              {saving ? 'Saving…' : 'Update Settings'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Business tab body
// ─────────────────────────────────────────────────────────────────────────

function BusinessTab({ form, set, currencies, timezones, months, dateFormats, timeFormats, stockMethods }) {
  return (
    <div className="space-y-6">
      <Section title="Identity">
        <Grid>
          <Field label="Business name" required>
            <input className={inputCls} value={form.business_name} onChange={set('business_name')} />
          </Field>
          <Field label="Start date">
            <input type="date" className={inputCls} value={form.start_date} onChange={set('start_date')} />
          </Field>
          <Field label="Default profit percent" hint="Used by the Add Product page to pre-fill margin.">
            <div className="flex">
              <input type="number" min="0" step="0.01" className={`${inputCls} rounded-r-none`}
                     value={form.default_profit_percent} onChange={set('default_profit_percent')} />
              <span className="inline-flex items-center rounded-r-lg border border-l-0 border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">%</span>
            </div>
          </Field>
        </Grid>
      </Section>

      <Section title="Currency & locale">
        <Grid>
          <Field label="Currency">
            <select className={inputCls} value={form.currency_code} onChange={set('currency_code')}>
              {currencies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Currency symbol placement">
            <select className={inputCls} value={form.currency_position} onChange={set('currency_position')}>
              <option value="before">Before amount</option>
              <option value="after">After amount</option>
            </select>
          </Field>
          <Field label="Time zone">
            <select className={inputCls} value={form.timezone} onChange={set('timezone')}>
              {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
        </Grid>
      </Section>

      <Section title="Branding">
        <Grid>
          <Field label="Logo URL" hint="Paste a hosted image URL. Use the Image Upload screen elsewhere to get one.">
            <input className={inputCls} value={form.logo_url} onChange={set('logo_url')} placeholder="https://…" />
          </Field>
          <Field label="Financial year start month">
            <select className={inputCls} value={form.financial_year_start_month} onChange={set('financial_year_start_month')}>
              {months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Stock accounting method" required hint="Drives COGS calculations on every sale.">
            <select className={inputCls} value={form.stock_accounting_method} onChange={set('stock_accounting_method')}>
              {stockMethods.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
        </Grid>
      </Section>

      <Section title="Transactions & formats">
        <Grid>
          <Field label="Transaction edit days" required hint="How many days back a user can edit a finalised sale or purchase.">
            <input type="number" min="0" step="1" className={inputCls}
                   value={form.transaction_edit_days} onChange={set('transaction_edit_days')} />
          </Field>
          <Field label="Date format" required>
            <select className={inputCls} value={form.date_format} onChange={set('date_format')}>
              {dateFormats.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Time format" required>
            <select className={inputCls} value={form.time_format} onChange={set('time_format')}>
              {timeFormats.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </Grid>
      </Section>

      <Section
        title="Invoice numbering"
        hint="Drives the auto-generated invoice format. Example with the defaults: INV-MAIN-06062026-001 (prefix · branch code · date · daily serial)."
      >
        <Grid>
          <Field label="Invoice prefix" hint="Leading literal — e.g. INV, BILL, SO. Letters / digits / dash only.">
            <input
              className={inputCls}
              value={form.invoice_prefix}
              onChange={(e) => set('invoice_prefix')({ target: { value: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10) } })}
              placeholder="INV"
            />
          </Field>
          <Field label="Include branch code" hint="Adds the branch code (or first 3 chars of the company name for single-branch tenants) after the prefix.">
            <label className="inline-flex items-center gap-2 h-10">
              <input
                type="checkbox"
                checked={!!form.invoice_use_branch_code}
                onChange={(e) => set('invoice_use_branch_code')({ target: { value: e.target.checked } })}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="text-sm text-gray-700">Yes</span>
            </label>
          </Field>
          <Field label="Date format in invoice" hint="Embedded between branch code and serial.">
            <select className={inputCls} value={form.invoice_date_format} onChange={set('invoice_date_format')}>
              <option value="DDMMYYYY">DDMMYYYY (06062026)</option>
              <option value="DDMMYY">DDMMYY (060626)</option>
              <option value="YYYYMMDD">YYYYMMDD (20260606)</option>
              <option value="YYMMDD">YYMMDD (260606)</option>
              <option value="NONE">No date in invoice number</option>
            </select>
          </Field>
          <Field label="Serial digits" hint="Zero-padding for the daily serial. 3 → 001, 4 → 0001.">
            <select className={inputCls} value={form.invoice_serial_digits} onChange={set('invoice_serial_digits')}>
              <option value="3">3 (001)</option>
              <option value="4">4 (0001)</option>
              <option value="5">5 (00001)</option>
              <option value="6">6 (000001)</option>
            </select>
          </Field>
        </Grid>
        <p className="mt-2 text-xs text-gray-500">
          Live preview:{' '}
          <code className="font-mono text-emerald-700">
            {previewInvoiceNumber(form)}
          </code>
        </p>
      </Section>

      {form.logo_url && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 flex items-center gap-4">
          <img src={form.logo_url} alt="Logo preview"
               onError={(e) => { e.currentTarget.style.display = 'none' }}
               className="h-16 w-16 rounded-lg object-contain bg-white border border-gray-200" />
          <div>
            <p className="text-xs font-semibold text-gray-600">Logo preview</p>
            <p className="text-[11px] text-gray-400 break-all max-w-md">{form.logo_url}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Tax tab body
// ─────────────────────────────────────────────────────────────────────────

function TaxTab({ form, set, setForm }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-emerald-50/60 border border-emerald-100 px-4 py-3 text-xs text-emerald-800">
        Set up to two tax registrations (e.g. <strong>VAT</strong> and{' '}
        <strong>Income Tax</strong>) plus an optional default rate. Enable
        <em> inline tax</em> to type the rate directly on each sale and
        purchase line instead of relying on the default.
      </div>

      <Section title="Tax 1">
        <Grid>
          <Field
            label="Tax 1 name"
            hint="The label printed on invoices, e.g. GST, VAT, BIN."
          >
            <input
              className={inputCls}
              value={form.tax1_name}
              onChange={set('tax1_name')}
              placeholder="GST / VAT / Other"
            />
          </Field>
          <Field label="Tax 1 number" hint="Registration / TIN / BIN as it appears on the certificate.">
            <input
              className={inputCls}
              value={form.tax1_number}
              onChange={set('tax1_number')}
              placeholder="e.g. 003123456-0202"
            />
          </Field>
          <div /> {/* keep the row aligned on the 3-col grid */}
        </Grid>
      </Section>

      <Section title="Tax 2 (optional)">
        <Grid>
          <Field
            label="Tax 2 name"
            hint="A second registration, e.g. Income Tax, ETIN."
          >
            <input
              className={inputCls}
              value={form.tax2_name}
              onChange={set('tax2_name')}
              placeholder="GST / VAT / Other"
            />
          </Field>
          <Field label="Tax 2 number">
            <input
              className={inputCls}
              value={form.tax2_number}
              onChange={set('tax2_number')}
              placeholder="e.g. ETIN-987654"
            />
          </Field>
          <div />
        </Grid>
      </Section>

      <Section title="Defaults">
        <Grid>
          <Field
            label="Default tax rate"
            hint="Pre-fills the tax % field when adding a product."
          >
            <div className="flex">
              <input
                type="number" min="0" step="0.01"
                className={`${inputCls} rounded-r-none`}
                value={form.tax_default_rate}
                onChange={set('tax_default_rate')}
              />
              <span className="inline-flex items-center rounded-r-lg border border-l-0 border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">%</span>
            </div>
          </Field>
          <Field label="Price tax treatment">
            <select
              className={inputCls}
              value={form.tax_inclusive ? 'inclusive' : 'exclusive'}
              onChange={(e) => setForm((f) => ({ ...f, tax_inclusive: e.target.value === 'inclusive' }))}
            >
              <option value="exclusive">Exclusive — tax added on top</option>
              <option value="inclusive">Inclusive — tax already in the price</option>
            </select>
          </Field>
          <div />
        </Grid>
      </Section>

      <Section title="Behaviour">
        <Toggle
          checked={!!form.tax_inline_enabled}
          onChange={(v) => setForm((f) => ({ ...f, tax_inline_enabled: v }))}
          title="Enable inline tax in purchase and sell"
          description="When on, every Add Sale and Add Purchase line gets its own tax % input so cashiers can override the default per line."
        />
      </Section>
    </div>
  )
}

function Toggle({ checked, onChange, title, description }) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50/40 px-4 py-3 cursor-pointer hover:bg-emerald-50/40">
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); onChange(!checked) }}
        className={`mt-0.5 relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${checked ? 'bg-emerald-600' : 'bg-gray-300'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <div>
        <p className="text-sm font-medium text-gray-800">{title}</p>
        {description && <p className="mt-0.5 text-[11px] text-gray-500">{description}</p>}
      </div>
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Product tab body
// ─────────────────────────────────────────────────────────────────────────

const EXPIRY_TYPES = [
  { value: 'add_item_expiry',  label: 'Add item expiry — set a date per stock-in' },
  { value: 'add_manufacturing', label: 'Add manufacturing + expiry — both per stock-in' },
]

function ProductTab({ form, set, setForm, units }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-emerald-50/60 border border-emerald-100 px-4 py-3 text-xs text-emerald-800">
        Control which optional product fields show up across the catalog —
        SKU prefix, expiry tracking, the Add Product form&rsquo;s
        Brand/Category/Sub-category pickers, sub-units, warranty and
        rack/row/position placement.
      </div>

      <Section title="Identification & expiry">
        <Grid>
          <Field label="SKU prefix" hint="Prepended to every auto-generated SKU (e.g. ‘OS-’ → OS-12345678).">
            <input
              className={inputCls}
              value={form.product_sku_prefix}
              onChange={set('product_sku_prefix')}
              placeholder="Leave blank for none"
              maxLength={20}
            />
          </Field>
          <Field label="Enable product expiry" hint="When on, Add Product surfaces an expiry-tracking section.">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, product_expiry_enabled: !f.product_expiry_enabled }))}
                className={`relative inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border transition ${form.product_expiry_enabled ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-white text-gray-300'}`}
                title="Toggle product expiry"
              >
                {form.product_expiry_enabled ? <CheckIcon /> : <span className="text-xs">—</span>}
              </button>
              <select
                className={`${inputCls} flex-1`}
                value={form.product_expiry_type}
                onChange={set('product_expiry_type')}
                disabled={!form.product_expiry_enabled}
              >
                {EXPIRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Default unit" hint="Pre-selects on the Add Product form.">
            <select
              className={inputCls}
              value={form.product_default_unit}
              onChange={set('product_default_unit')}
            >
              <option value="">— None —</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}
                </option>
              ))}
              {/* Preserve a saved value even if it didn't load from /units/ */}
              {form.product_default_unit && !units.some((u) => u.id === form.product_default_unit) && (
                <option value={form.product_default_unit}>{form.product_default_unit}</option>
              )}
            </select>
          </Field>
        </Grid>
      </Section>

      <Section title="Catalog fields">
        <ToggleGrid>
          <Toggle
            checked={!!form.product_enable_brands}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_brands: v }))}
            title="Enable Brands"
            description="Show the Brand picker on Add/Edit Product."
          />
          <Toggle
            checked={!!form.product_enable_categories}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_categories: v }))}
            title="Enable Categories"
            description="Show the Category picker on Add/Edit Product."
          />
          <Toggle
            checked={!!form.product_enable_subcategories}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_subcategories: v }))}
            title="Enable Sub-Categories"
            description="Surface a Sub-category dropdown under each Category."
          />
          <Toggle
            checked={!!form.product_enable_price_tax}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_price_tax: v }))}
            title="Enable Price & Tax info"
            description="Show the Pricing & Tax block on Add/Edit Product."
          />
          <Toggle
            checked={!!form.product_enable_sub_units}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_sub_units: v }))}
            title="Enable Sub Units"
            description="Track multiple units per product (e.g. carton ⇄ piece)."
          />
          <Toggle
            checked={!!form.product_enable_warranty}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_warranty: v }))}
            title="Enable Warranty"
            description="Print warranty days on invoices and on the product card."
          />
        </ToggleGrid>
      </Section>

      <Section title="Warehouse placement">
        <ToggleGrid>
          <Toggle
            checked={!!form.product_enable_racks}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_racks: v }))}
            title="Enable Racks"
            description="Track which rack a product lives on per location."
          />
          <Toggle
            checked={!!form.product_enable_row}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_row: v }))}
            title="Enable Row"
            description="Track which row of the rack the product sits in."
          />
          <Toggle
            checked={!!form.product_enable_position}
            onChange={(v) => setForm((f) => ({ ...f, product_enable_position: v }))}
            title="Enable Position"
            description="Track an exact slot within the row."
          />
        </ToggleGrid>
      </Section>
    </div>
  )
}

function ToggleGrid({ children }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{children}</div>
}

// ─────────────────────────────────────────────────────────────────────────
// Sale tab body
// ─────────────────────────────────────────────────────────────────────────

const ITEM_ADDITION_METHODS = [
  { value: 'increase_qty', label: 'Increase item quantity if it already exists' },
  { value: 'add_new_row',  label: 'Always add a new row' },
]

const ROUNDING_METHODS = [
  { value: 'none',     label: 'None — keep exact amount' },
  { value: 'nearest',  label: 'Round to nearest whole unit' },
  { value: 'up',       label: 'Round up' },
  { value: 'down',     label: 'Round down' },
]

const COMMISSION_AGENT_MODES = [
  { value: 'disable',          label: 'Disable — no commission tracking' },
  { value: 'logged_in_user',   label: 'Logged-in user takes the commission' },
  { value: 'select_per_sale',  label: 'Pick an agent per sale' },
]

const COMMISSION_CALC_TYPES = [
  { value: 'invoice_value', label: 'Invoice value' },
  { value: 'payment_received', label: 'Payment received' },
]

function SaleTab({ form, set, setForm, taxGroups }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-emerald-50/60 border border-emerald-100 px-4 py-3 text-xs text-emerald-800">
        Defaults that pre-fill every sale, plus commission tracking and
        the payment-link providers used in invoice emails.
      </div>

      <Section title="Defaults & cart behaviour">
        <Grid>
          <Field label="Default sale discount" required hint="Pre-applied to every new sale.">
            <div className="flex">
              <span className="inline-flex items-center rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">%</span>
              <input type="number" min="0" step="0.01"
                     className={`${inputCls} rounded-l-none`}
                     value={form.sale_default_discount}
                     onChange={set('sale_default_discount')} />
            </div>
          </Field>
          <Field label="Default sale tax" hint="Tax group pre-selected on Add Sale and POS.">
            <select className={inputCls} value={form.sale_default_tax} onChange={set('sale_default_tax')}>
              <option value="">None</option>
              {taxGroups.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>
              ))}
              {form.sale_default_tax && !taxGroups.some((t) => String(t.id) === String(form.sale_default_tax)) && (
                <option value={form.sale_default_tax}>{form.sale_default_tax}</option>
              )}
            </select>
          </Field>
          <Field label="Sales item addition method" hint="What happens when the same product is added twice.">
            <select className={inputCls}
                    value={form.sale_item_addition_method}
                    onChange={set('sale_item_addition_method')}>
              {ITEM_ADDITION_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Amount rounding method" hint="Applies to the grand total at checkout.">
            <select className={inputCls}
                    value={form.sale_rounding_method}
                    onChange={set('sale_rounding_method')}>
              {ROUNDING_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <div className="md:col-span-2" />
        </Grid>

        <ToggleGrid>
          <Toggle
            checked={!!form.sale_price_is_min}
            onChange={(v) => setForm((f) => ({ ...f, sale_price_is_min: v }))}
            title="Sales price is the minimum selling price"
            description="Block discounts that would push a line below the product's selling price."
          />
          <Toggle
            checked={!!form.sale_allow_overselling}
            onChange={(v) => setForm((f) => ({ ...f, sale_allow_overselling: v }))}
            title="Allow overselling"
            description="Let cashiers complete a sale even when stock would go negative."
          />
          <Toggle
            checked={!!form.sale_enable_sales_order}
            onChange={(v) => setForm((f) => ({ ...f, sale_enable_sales_order: v }))}
            title="Enable Sales Order"
            description="Surface the Sales Order workflow (book now, fulfil later)."
          />
          <Toggle
            checked={!!form.sale_pay_term_required}
            onChange={(v) => setForm((f) => ({ ...f, sale_pay_term_required: v }))}
            title="Is pay term required?"
            description="Force every customer to have a credit term set before a credit sale."
          />
        </ToggleGrid>
      </Section>

      <Section title="Commission agent">
        <Grid>
          <Field label="Sales commission agent">
            <select className={inputCls}
                    value={form.sale_commission_agent}
                    onChange={set('sale_commission_agent')}>
              {COMMISSION_AGENT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Commission calculation type">
            <select className={inputCls}
                    value={form.sale_commission_calc_type}
                    onChange={set('sale_commission_calc_type')}
                    disabled={form.sale_commission_agent === 'disable'}>
              {COMMISSION_CALC_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <div className="flex items-end">
            <Toggle
              checked={!!form.sale_commission_required}
              onChange={(v) => setForm((f) => ({ ...f, sale_commission_required: v }))}
              title="Is commission agent required?"
              description="Force a commission-agent selection on every sale."
            />
          </div>
        </Grid>
      </Section>

    </div>
  )
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 011.42-1.42l2.79 2.79 6.79-6.79a1 1 0 011.42 0z" clipRule="evenodd" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Sales on POS tab body
// ─────────────────────────────────────────────────────────────────────────

const POS_SHORTCUTS = [
  { key: 'pos_ks_express_checkout', label: 'Express Checkout' },
  { key: 'pos_ks_pay_checkout',     label: 'Pay & Checkout' },
  { key: 'pos_ks_draft',            label: 'Save as Draft' },
  { key: 'pos_ks_cancel',           label: 'Cancel sale' },
  { key: 'pos_ks_goto_qty',         label: 'Go to product quantity' },
  { key: 'pos_ks_weighing_scale',   label: 'Weighing scale' },
  { key: 'pos_ks_edit_discount',    label: 'Edit Discount' },
  { key: 'pos_ks_edit_order_tax',   label: 'Edit Order Tax' },
  { key: 'pos_ks_add_payment_row',  label: 'Add Payment Row' },
  { key: 'pos_ks_finalize_payment', label: 'Finalize Payment' },
  { key: 'pos_ks_add_new_product',  label: 'Add new product' },
]

const POS_TOGGLES = [
  ['pos_disable_multiple_pay',    'Disable Multiple Pay',           'Force a single payment method per sale.'],
  ['pos_disable_draft',           'Disable Draft',                  'Hide the "Save as Draft" button on the POS toolbar.'],
  ['pos_disable_express',         'Disable Express Checkout',       'Hide the one-click Express Checkout button.'],
  ['pos_hide_product_suggest',    "Don't show product suggestion",  'Hide the recommended-products strip under the search bar.'],
  ['pos_hide_recent_tx',          "Don't show recent transactions", 'Hide the recent-sales list on the right sidebar.'],
  ['pos_disable_discount',        'Disable Discount',               'Block all per-sale discounts at the till.'],
  ['pos_disable_order_tax',       'Disable Order Tax',              "Hide the per-sale tax editor (uses Sale tab's default only)."],
  ['pos_subtotal_editable',       'Subtotal Editable',              'Let cashiers type the final subtotal directly (rare).'],
  ['pos_disable_suspend',         'Disable Suspend Sale',           'Hide the Suspend / hold-cart button.'],
  ['pos_txdate_enabled',          'Enable transaction date on POS', 'Let cashiers backdate or post-date a sale.'],
  ['pos_service_staff_line',      'Enable service staff in product line', 'Show a "Served by" picker per line item.'],
  ['pos_service_staff_required',  'Is service staff required?',     'Force a Served-by selection before checkout.'],
  ['pos_disable_credit_sale',     'Disable credit sale button',     'Hide the "Charge on credit" payment shortcut.'],
  ['pos_enable_weighing',         'Enable Weighing Scale',          'Surface the weighing-scale barcode parser in the cart.'],
  ['pos_show_invoice_scheme',     'Show invoice scheme',            'Let cashiers pick an invoice numbering scheme.'],
  ['pos_show_invoice_layout_dd',  'Show invoice layout dropdown',   'Let cashiers pick from configured invoice layouts.'],
  ['pos_print_on_suspend',        'Print invoice on suspend',       'Auto-print a hold-cart slip when suspending a sale.'],
  ['pos_show_price_tooltip',      'Show pricing on suggestion tooltip', 'Show price + stock on hover in the product picker.'],
]

function ShortcutInput({ value, onChange }) {
  // Capture the key combo when the input is focused — Esc clears.
  const onKeyDown = (e) => {
    if (e.key === 'Tab') return                // allow tab navigation
    e.preventDefault()
    if (e.key === 'Escape') { onChange(''); return }
    const parts = []
    if (e.ctrlKey)  parts.push('ctrl')
    if (e.altKey)   parts.push('alt')
    if (e.shiftKey) parts.push('shift')
    // Use the printable key, normalised; ignore lone modifiers.
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
    if (!['shift', 'control', 'alt', 'meta'].includes(k)) parts.push(k)
    if (parts.length) onChange(parts.join('+'))
  }
  return (
    <input
      className={`${inputCls} font-mono tracking-wider`}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Press a key combo, or type one"
    />
  )
}

function PosTab({ form, set, setForm }) {
  const updateKs = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-emerald-50/60 border border-emerald-100 px-4 py-3 text-xs text-emerald-800">
        Tune the POS experience: which buttons appear, which keys
        trigger them, and how the optional weighing-scale barcode
        parser splits a barcode into SKU + quantity.
      </div>

      <Section title="Keyboard shortcuts">
        <p className="-mt-2 mb-3 text-[11px] text-gray-500">
          Focus a field and press the desired combination — modifiers like
          <code className="mx-1 px-1 rounded bg-gray-100 text-gray-700">shift</code>,
          <code className="mx-1 px-1 rounded bg-gray-100 text-gray-700">ctrl</code>,
          <code className="mx-1 px-1 rounded bg-gray-100 text-gray-700">alt</code>
          combine with letters or function keys (e.g.{' '}
          <code className="px-1 rounded bg-gray-100 text-gray-700">shift+e</code>,{' '}
          <code className="px-1 rounded bg-gray-100 text-gray-700">f2</code>). Press
          <code className="mx-1 px-1 rounded bg-gray-100 text-gray-700">Esc</code>
          to clear a binding.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {POS_SHORTCUTS.map((row) => (
            <Field key={row.key} label={row.label}>
              <ShortcutInput
                value={form[row.key]}
                onChange={updateKs(row.key)}
              />
            </Field>
          ))}
        </div>
      </Section>

      <Section title="POS behaviour">
        <ToggleGrid>
          {POS_TOGGLES.map(([key, title, desc]) => (
            <Toggle
              key={key}
              checked={!!form[key]}
              onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
              title={title}
              description={desc}
            />
          ))}
        </ToggleGrid>
      </Section>

      <Section title="Cash denominations">
        <Field
          label="Denominations"
          hint="Comma-separated list of notes/coins the cashier can tally at till close. Example: 1,2,5,10,20,50,100,500,1000"
        >
          <input
            className={inputCls}
            value={form.pos_cash_denominations}
            onChange={set('pos_cash_denominations')}
            placeholder="e.g. 1,2,5,10,20,50,100,500,1000"
          />
        </Field>
      </Section>

      <Section title="Weighing scale barcode">
        <p className="-mt-2 mb-3 text-[11px] text-gray-500">
          Parses scale-printed barcodes into a product SKU + a quantity.
          Total barcode length = Prefix + SKU + Integer + Fractional.
        </p>
        <Grid>
          <Field label="Prefix" hint="Optional fixed prefix on every scale barcode (e.g. ‘2’ for EAN-13).">
            <input className={inputCls}
                   value={form.pos_ws_prefix}
                   onChange={set('pos_ws_prefix')}
                   placeholder="e.g. 2" />
          </Field>
          <Field label="Product SKU length">
            <input type="number" min="1" step="1" className={inputCls}
                   value={form.pos_ws_sku_len}
                   onChange={set('pos_ws_sku_len')} />
          </Field>
          <Field label="Quantity integer part length">
            <input type="number" min="1" step="1" className={inputCls}
                   value={form.pos_ws_qty_int_len}
                   onChange={set('pos_ws_qty_int_len')} />
          </Field>
          <Field label="Quantity fractional part length">
            <input type="number" min="0" step="1" className={inputCls}
                   value={form.pos_ws_qty_frac_len}
                   onChange={set('pos_ws_qty_frac_len')} />
          </Field>
        </Grid>
        <div className="mt-3 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-[11px] text-gray-600">
          <span className="font-semibold text-gray-700">Layout preview:</span>{' '}
          <code className="font-mono text-emerald-700">
            [{form.pos_ws_prefix || '-'}]
            [{'S'.repeat(Math.max(1, Number(form.pos_ws_sku_len) || 0))}]
            [{'I'.repeat(Math.max(1, Number(form.pos_ws_qty_int_len) || 0))}]
            [{'F'.repeat(Math.max(0, Number(form.pos_ws_qty_frac_len) || 0)) || '·'}]
          </code>
        </div>
      </Section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// System tab body
// ─────────────────────────────────────────────────────────────────────────

const THEME_COLORS = [
  { value: 'emerald', label: 'Green (default)', swatch: 'bg-emerald-500', ring: 'ring-emerald-200' },
  { value: 'blue',    label: 'Blue',            swatch: 'bg-blue-500',    ring: 'ring-blue-200' },
  { value: 'indigo',  label: 'Indigo',          swatch: 'bg-indigo-500',  ring: 'ring-indigo-200' },
  { value: 'purple',  label: 'Purple',          swatch: 'bg-purple-500',  ring: 'ring-purple-200' },
  { value: 'rose',    label: 'Red',             swatch: 'bg-rose-500',    ring: 'ring-rose-200' },
  { value: 'amber',   label: 'Amber',           swatch: 'bg-amber-500',   ring: 'ring-amber-200' },
  { value: 'slate',   label: 'Black / Slate',   swatch: 'bg-slate-800',   ring: 'ring-slate-200' },
]

const PAGE_SIZE_OPTIONS = ['10', '25', '50', '100', '200']

function SystemTab({ form, set, setForm }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-emerald-50/60 border border-emerald-100 px-4 py-3 text-xs text-emerald-800">
        App-wide UI preferences — accent color, how many rows tables show
        by default, and whether helper text shows under form fields.
      </div>

      <Section title="Theme color">
        <p className="-mt-2 mb-3 text-[11px] text-gray-500">
          Sets the accent color for headers, buttons and highlights across
          the whole app. The chosen color is applied as soon as you click
          Update Settings.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {THEME_COLORS.map((t) => {
            const active = form.system_theme_color === t.value
            return (
              <button
                type="button"
                key={t.value}
                onClick={() => setForm((f) => ({ ...f, system_theme_color: t.value }))}
                className={[
                  'flex items-center gap-3 rounded-xl border bg-white px-4 py-3 text-left transition',
                  active
                    ? `border-transparent ring-2 ${t.ring} shadow-sm`
                    : 'border-gray-200 hover:border-gray-300',
                ].join(' ')}
              >
                <span className={`inline-block h-8 w-8 rounded-lg ${t.swatch} shadow-inner`} />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-800">{t.label}</p>
                  <p className="text-[10px] uppercase tracking-wider text-gray-400 font-mono">{t.value}</p>
                </div>
                {active && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                    Selected
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="Tables & forms">
        <Grid>
          <Field
            label="Default datatable page entries"
            hint="How many rows are shown per page in lists like Customers, Products and Sales."
          >
            <select
              className={inputCls}
              value={form.system_datatable_page_size}
              onChange={set('system_datatable_page_size')}
            >
              {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
          </Field>
          <div className="md:col-span-2 flex items-end">
            <Toggle
              checked={!!form.system_show_help_text}
              onChange={(v) => setForm((f) => ({ ...f, system_show_help_text: v }))}
              title="Show help text"
              description="Show the small grey hint lines under form fields. Turn off for a more compact layout."
            />
          </div>
        </Grid>
      </Section>
    </div>
  )
}

function coerceBool(v, fallback = false) {
  if (v == null) return fallback
  if (typeof v === 'boolean') return v
  if (typeof v === 'number')  return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s))  return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return fallback
}

// ─────────────────────────────────────────────────────────────────────────
// Placeholder for the other tabs
// ─────────────────────────────────────────────────────────────────────────

function ComingSoon({ label }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/40 px-6 py-16 text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <SparkIcon />
      </div>
      <p className="text-sm font-medium text-gray-700">{label} settings coming soon.</p>
      <p className="mt-1 text-xs text-gray-500">This tab is being built next. The Business tab is fully functional today.</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────────────────

const inputCls =
  'block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm ' +
  'placeholder:text-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100'

// Mirror backend _generate_invoice_number so the Business Settings
// page can show the cashier exactly what the next auto-number will
// look like. Tenant types prefix / picks branch toggle / date
// format / serial digits — preview updates live.
function previewInvoiceNumber(form) {
  const pad = (n) => String(n).padStart(2, '0')
  const now = new Date()
  const yyyy = now.getFullYear()
  const yy   = String(yyyy).slice(2)
  const mm   = pad(now.getMonth() + 1)
  const dd   = pad(now.getDate())
  const dateStr = (
    form.invoice_date_format === 'DDMMYY'   ? `${dd}${mm}${yy}`   :
    form.invoice_date_format === 'YYYYMMDD' ? `${yyyy}${mm}${dd}` :
    form.invoice_date_format === 'YYMMDD'   ? `${yy}${mm}${dd}`   :
    form.invoice_date_format === 'NONE'     ? ''                  :
    `${dd}${mm}${yyyy}`
  )
  const prefix = (form.invoice_prefix || 'INV').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10) || 'INV'
  const sourceName = form.business_name || 'COMPANY'
  const branch = form.invoice_use_branch_code
    ? (sourceName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'MAIN')
    : ''
  const digits = Math.max(2, Math.min(8, Number(form.invoice_serial_digits) || 3))
  const serial = '1'.padStart(digits, '0')
  return [prefix, branch, dateStr, serial].filter(Boolean).join('-')
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-800">
        <span className="inline-block h-3 w-1 rounded-full bg-emerald-600" />
        {title}
      </h3>
      {children}
    </div>
  )
}

function Grid({ children }) {
  return <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{children}</div>
}

function Field({ label, required, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        {label}{required && <span className="text-red-500"> *</span>}
      </span>
      {children}
      {hint && <span className="text-[10px] text-gray-400">{hint}</span>}
    </label>
  )
}

function Banner({ kind, children }) {
  const cls = kind === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-emerald-200 bg-emerald-50 text-emerald-800'
  return <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>
}

// ─────────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
         viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}
