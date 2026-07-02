import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import Card from '../../components/ui/Card'
import Button from '../../components/ui/Button'
import BdPhoneInput, {
  validateBdPhone, validateBdPhoneOptional,
  validateLettersOnly, validateBusinessName,
  stripAtKeystroke, NON_LETTERS_RE, NON_BUSINESS_RE,
} from '../../components/form/BdPhoneInput'
import {
  getCompanyProfile, updateCompanyProfile, uploadCompanyLogo,
} from '../../api/companyProfile'

// Digits-only stripper for bank account numbers etc.
const DIGITS_ONLY_RE = /[^0-9]/g
const validateDigitsOnly = (label) => (v) => {
  if (!v) return true
  return /^\d+$/.test(String(v)) || `${label} must contain digits only.`
}
const validateEmailOptional = (v) =>
  !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'Enter a valid email address.'
const validateUrlOptional = (v) =>
  !v || /^https?:\/\/[^\s]+$/i.test(v) || 'Website must start with http:// or https://.'

/**
 * Customer Profile (Settings → Customer Profile).
 *
 * Sidebar header reads `name` and `logo_url` from here. Form fields:
 *   - Company name
 *   - Logo (upload + preview)
 *   - Address
 *   - Phone
 *   - Email
 *   - Tax / VAT number
 *   - Website (optional)
 *
 * Persisted via SystemSetting (the tenant DB key/value store), so the
 * change takes effect on the next page-load for every browser session
 * of that tenant.
 */
export default function CompanyProfilePage() {
  const fileInput = useRef(null)
  const [profile,  setProfile]  = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error,    setError]    = useState('')
  const [okMsg,    setOkMsg]    = useState('')

  const { register, handleSubmit, reset, formState: { errors } } = useForm()

  const refresh = () => {
    setLoading(true)
    getCompanyProfile()
      .then((data) => { setProfile(data); reset(data) })
      .catch((e) => setError(e?.message || 'Failed to load profile.'))
      .finally(() => setLoading(false))
  }
  useEffect(refresh, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (data) => {
    setSaving(true); setError(''); setOkMsg('')
    try {
      const next = await updateCompanyProfile(data)
      setProfile(next)
      reset(next)
      setOkMsg('Saved. The new info will appear in the sidebar on next page-load.')
    } catch (e) {
      setError(e?.message || 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const onLogoPicked = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true); setError(''); setOkMsg('')
    try {
      const { logo_url } = await uploadCompanyLogo(file)
      setProfile((p) => ({ ...(p || {}), logo_url }))
      reset((cur) => ({ ...(cur || {}), logo_url }))
      setOkMsg('Logo uploaded. Refresh the page to see it in the sidebar.')
    } catch (err) {
      setError(err?.message || 'Logo upload failed.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const ipt = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-2xl bg-gradient-to-r from-indigo-600 via-indigo-600 to-cyan-500 px-6 py-5 text-white shadow-sm">
        <h1 className="text-xl font-semibold">Customer Profile</h1>
        <p className="mt-0.5 text-sm text-emerald-50">
          Your company info. Used in the sidebar header, invoices and receipts.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {okMsg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{okMsg}</div>
      )}

      {loading ? (
        <Card><div className="py-8 text-sm text-gray-400 text-center">Loading…</div></Card>
      ) : (
        <Card>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">

            {/* ── Logo block ─────────────────────────────────────────────── */}
            <div className="flex items-center gap-5">
              <div className="h-20 w-20 shrink-0 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center">
                {profile?.logo_url ? (
                  <img src={profile.logo_url} alt="Company logo" className="h-full w-full object-contain" />
                ) : (
                  <span className="text-gray-300 text-xs text-center">No logo</span>
                )}
              </div>
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Company logo</label>
                <p className="text-xs text-gray-500 mb-2">
                  PNG, JPG, WEBP or SVG. Up to 5 MB. The logo appears in the top-left sidebar card.
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  onChange={onLogoPicked}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInput.current?.click()}
                  loading={uploading}
                >
                  {profile?.logo_url ? 'Replace logo' : 'Upload logo'}
                </Button>
              </div>
            </div>

            <div className="border-t border-gray-100" />

            {/* ── Company name ───────────────────────────────────────────── */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Company name *</label>
              <input
                {...stripAtKeystroke(
                  register('name', {
                    required: 'Company name is required.',
                    validate: validateBusinessName,
                  }),
                  NON_BUSINESS_RE,
                )}
                placeholder="Iffaa Stationery"
                className={ipt}
              />
              {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
              <p className="mt-1 text-xs text-gray-500">
                Letters only (with spaces, ., -, &amp; and ,). Replaces the workspace title in the top-left sidebar card.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <BdPhoneInput
                  {...register('phone', { validate: validateBdPhoneOptional })}
                  placeholder="01XXXXXXXXX"
                />
                {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone.message}</p>}
                <p className="mt-1 text-xs text-gray-500">11 digits, +88 fixed. Leave blank to clear.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  {...register('email', { validate: validateEmailOptional })}
                  placeholder="info@iffaa.com"
                  className={ipt}
                />
                {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
              <textarea
                {...register('address')}
                rows={2}
                placeholder="House 12, Road 7, Dhanmondi, Dhaka 1209"
                className={ipt}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tax / VAT / TIN</label>
                <input {...register('tax_number')} placeholder="VAT-12345" className={ipt} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
                <input
                  {...register('website', { validate: validateUrlOptional })}
                  placeholder="https://iffaa.com"
                  className={ipt}
                />
                {errors.website && <p className="mt-1 text-xs text-red-600">{errors.website.message}</p>}
              </div>
            </div>

            {/* ── Invoice slip design (per-tenant) ─────────────────────── */}
            <div className="border-t border-gray-100 pt-5">
              <h2 className="text-sm font-semibold text-gray-900">Invoice slip design</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                These fields appear on every printed invoice and POS receipt
                for your tenant. Leave any blank to use the default text.
              </p>
            </div>

            {/* Invoice number prefix — drives every freshly-generated
                invoice number. Default 'INV'. The full pattern at
                render time is <PREFIX>-<COMPANY/BRANCH>-DDMMYYYY-NNN
                (e.g. INV-ONG-06062026-001). The tenant can replace
                'INV' with anything they like — BILL, SO, etc. */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Invoice number prefix</label>
              <input
                {...register('invoice_prefix', {
                  maxLength: { value: 10, message: 'Max 10 characters.' },
                  pattern:   { value: /^[A-Za-z0-9-]*$/, message: 'Letters, digits and dashes only.' },
                })}
                placeholder="INV"
                className={ipt}
              />
              {errors.invoice_prefix && (
                <p className="mt-1 text-xs text-red-600">{errors.invoice_prefix.message}</p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                Generates invoice numbers like <code className="font-mono">{'<PREFIX>'}-COMPANY-DDMMYYYY-001</code>{' '}
                — e.g. <code className="font-mono">INV-ONG-06062026-001</code>. Leave blank to use the default <code className="font-mono">INV</code>.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Brand tagline</label>
                <input {...register('invoice_tagline')} placeholder="TAGLINE SPACE HERE" className={ipt} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Primary accent color</label>
                <input
                  type="color"
                  {...register('invoice_primary_color')}
                  className="h-10 w-20 rounded-lg border border-gray-200"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Colors the invoice table header rule. Default teal.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Thank-you note</label>
              <input
                {...register('invoice_thank_you')}
                placeholder="Thank you for your business"
                className={ipt}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank account number</label>
                <input
                  inputMode="numeric"
                  {...stripAtKeystroke(
                    register('invoice_payment_bank_account', {
                      validate: validateDigitsOnly('Bank account number'),
                    }),
                    DIGITS_ONLY_RE,
                  )}
                  placeholder="123456789012"
                  className={ipt}
                />
                {errors.invoice_payment_bank_account && (
                  <p className="mt-1 text-xs text-red-600">{errors.invoice_payment_bank_account.message}</p>
                )}
                <p className="mt-1 text-xs text-gray-500">Digits only.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank account name</label>
                <input
                  {...stripAtKeystroke(
                    register('invoice_payment_ac_name', {
                      validate: (v) => !v || validateBusinessName(v),
                    }),
                    NON_BUSINESS_RE,
                  )}
                  placeholder="Iffaa Stationery Ltd"
                  className={ipt}
                />
                {errors.invoice_payment_ac_name && (
                  <p className="mt-1 text-xs text-red-600">{errors.invoice_payment_ac_name.message}</p>
                )}
                <p className="mt-1 text-xs text-gray-500">Letters only.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank details</label>
                <input {...register('invoice_payment_bank_details')} placeholder="ABC Bank, Gulshan Branch" className={ipt} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Terms & Conditions</label>
              <textarea
                {...register('invoice_terms')}
                rows={3}
                placeholder="Payment terms: Net 7. Goods once sold are not returnable without prior approval."
                className={ipt}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Signature label</label>
                <input
                  {...stripAtKeystroke(
                    register('invoice_authorised_sign', {
                      validate: (v) => !v || validateLettersOnly('Signature label')(v),
                    }),
                    NON_LETTERS_RE,
                  )}
                  placeholder="Authorised Sign"
                  className={ipt}
                />
                {errors.invoice_authorised_sign && (
                  <p className="mt-1 text-xs text-red-600">{errors.invoice_authorised_sign.message}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Footer note (optional)</label>
                <input {...register('invoice_footer_note')} placeholder="" className={ipt} />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={refresh}
                className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-300"
              >
                Reset
              </button>
              <Button type="submit" loading={saving}>Save changes</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  )
}
