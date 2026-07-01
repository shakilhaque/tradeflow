import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm }    from 'react-hook-form'
import Card           from '../../components/ui/Card'
import Button         from '../../components/ui/Button'
import Badge          from '../../components/ui/Badge'
import Input          from '../../components/ui/Input'
import EmptyState     from '../../components/ui/EmptyState'
import UserAvatar     from '../../components/ui/UserAvatar'
import Modal, { ModalFooter } from '../../components/ui/Modal'
import { useAuth }    from '../../context/AuthContext'
import {
  getAllSettings, bulkUpdateSettings,
  getTaxGroups, createTaxGroup, updateTaxGroup, deleteTaxGroup,
} from '../../api/settings'
import { uploadAvatar, deleteAvatar } from '../../api/auth'

// ── Tax Group modal ───────────────────────────────────────────────────────────

function TaxGroupModal({ open, onClose, group, onSaved }) {
  const isEdit = Boolean(group)
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm()
  const [serverError, setServerError] = useState('')

  useEffect(() => {
    if (open) {
      reset(isEdit
        ? { name: group.name, rate: group.rate, description: group.description ?? '', is_active: group.is_active, is_default: group.is_default }
        : { code: '', name: '', rate: '0', description: '', is_default: false }
      )
      setServerError('')
    }
  }, [open, group, isEdit, reset])

  const onSubmit = async (data) => {
    setServerError('')
    try {
      if (isEdit) {
        await updateTaxGroup(group.id, {
          name:        data.name,
          rate:        data.rate,
          description: data.description ?? '',
          is_active:   data.is_active,
          is_default:  data.is_default,
        })
      } else {
        await createTaxGroup({
          code:        data.code.trim().toUpperCase(),
          name:        data.name.trim(),
          rate:        data.rate,
          description: data.description ?? '',
          is_default:  data.is_default,
        })
      }
      onSaved?.()
      onClose()
    } catch (err) {
      setServerError(err.message || 'Failed to save tax group')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Edit Tax Group' : 'New Tax Group'} size="sm">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {serverError}
          </div>
        )}
        {!isEdit && (
          <Input
            label="Code"
            required
            placeholder="e.g. VAT15"
            error={errors.code?.message}
            {...register('code', { required: 'Required' })}
          />
        )}
        <Input
          label="Name"
          required
          placeholder="e.g. Standard VAT"
          error={errors.name?.message}
          {...register('name', { required: 'Required' })}
        />
        <Input
          label="Rate (%)"
          required
          type="number"
          step="0.01"
          min="0"
          placeholder="15.00"
          error={errors.rate?.message}
          {...register('rate', { required: 'Required', min: { value: 0, message: '≥ 0' } })}
        />
        <Input
          label="Description"
          placeholder="Optional"
          {...register('description')}
        />
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" className="rounded" {...register('is_default')} />
            Set as default tax group
          </label>
          {isEdit && (
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" className="rounded" {...register('is_active')} />
              Active
            </label>
          )}
        </div>
      </form>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={isSubmitting} onClick={handleSubmit(onSubmit)}>
          {isEdit ? 'Save' : 'Create'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Delete confirmation ───────────────────────────────────────────────────────

function DeleteModal({ open, onClose, group, onDeleted }) {
  const [loading, setLoading]  = useState(false)
  const [error,   setError]    = useState('')

  useEffect(() => { if (open) setError('') }, [open])

  const confirm = async () => {
    setLoading(true); setError('')
    try {
      await deleteTaxGroup(group.id)
      onDeleted?.()
      onClose()
    } catch (err) {
      setError(err.message || 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Delete Tax Group" size="sm">
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}
        <p className="text-sm text-gray-700">
          Are you sure you want to delete <strong>{group?.name}</strong>? This cannot be undone.
        </p>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={loading} onClick={confirm}>Delete</Button>
      </ModalFooter>
    </Modal>
  )
}

// ── Settings editor ───────────────────────────────────────────────────────────

// Human-friendly labels for known setting keys
const SETTING_LABELS = {
  business_name:        'Business Name',
  business_email:       'Business Email',
  business_phone:       'Business Phone',
  business_address:     'Business Address',
  currency_code:        'Currency Code',
  currency_symbol:      'Currency Symbol',
  date_format:          'Date Format',
  fiscal_year_start:    'Fiscal Year Start (MM-DD)',
  low_stock_threshold:  'Low Stock Threshold',
  receipt_footer:       'Receipt Footer Message',
  receipt_header:       'Receipt Header',
  tax_number:           'Tax / VAT Number',
  invoice_prefix:       'Invoice Number Prefix',
  po_prefix:            'Purchase Order Prefix',
  default_tax_rate:     'Default Tax Rate (%)',
  timezone:             'Timezone',
}

function SettingsEditor({ settings, onSaved }) {
  const [editing, setEditing]  = useState({})    // { key: draftValue }
  const [saving,  setSaving]   = useState(false)
  const [success, setSuccess]  = useState(false)
  const [error,   setError]    = useState('')

  const handleChange = (key, value) => {
    setEditing((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    if (!Object.keys(editing).length) return
    setSaving(true); setError(''); setSuccess(false)
    try {
      await bulkUpdateSettings(editing)
      setEditing({})
      setSuccess(true)
      onSaved?.()
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err.message || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = Object.keys(editing).length > 0

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          ✓ Settings saved successfully
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {Object.entries(settings).map(([key, entry]) => {
          const label     = SETTING_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
          const rawValue  = entry?.value ?? entry?.value_str ?? entry ?? ''
          const draftVal  = editing[key] !== undefined ? editing[key] : String(rawValue)
          const isDirty   = editing[key] !== undefined

          return (
            <div key={key} className={`rounded-xl border p-3 transition-colors ${isDirty ? 'border-brand-300 bg-brand-50/30' : 'border-gray-100 bg-white'}`}>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                {label}
                {isDirty && <span className="ml-2 text-brand-500 normal-case text-[10px]">modified</span>}
              </label>
              <input
                type="text"
                value={draftVal}
                onChange={(e) => handleChange(key, e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800
                           outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500
                           bg-transparent"
              />
              {entry?.description && (
                <p className="mt-1 text-xs text-gray-400">{entry.description}</p>
              )}
            </div>
          )
        })}
      </div>

      {hasChanges && (
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={() => setEditing({})}>Discard Changes</Button>
          <Button loading={saving} onClick={handleSave}>Save All Changes</Button>
        </div>
      )}
    </div>
  )
}

// ── Profile picture card ──────────────────────────────────────────────────────

function ProfileCard() {
  const { user, updateUser } = useAuth()
  const fileRef              = useRef(null)
  const [busy,    setBusy]   = useState(false)
  const [error,   setError]  = useState('')
  const [success, setSuccess] = useState('')

  const handlePick = () => fileRef.current?.click()

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''  // reset so re-picking same file fires change
    if (!file) return

    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be 5 MB or smaller.')
      return
    }
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
      setError('Allowed formats: JPG, PNG, WEBP, GIF.')
      return
    }

    setBusy(true); setError(''); setSuccess('')
    try {
      const res = await uploadAvatar(file)
      updateUser({ profile_picture: res.profile_picture || res.url })
      setSuccess('Profile picture updated.')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError(err.message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    setBusy(true); setError(''); setSuccess('')
    try {
      await deleteAvatar()
      updateUser({ profile_picture: '' })
      setSuccess('Profile picture removed.')
      setTimeout(() => setSuccess(''), 3000)
    } catch (err) {
      setError(err.message || 'Failed to remove.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-full ring-2 ring-gray-100 p-1">
            <UserAvatar src={user?.profile_picture} name={user?.name} size="lg" className="!w-24 !h-24" />
          </div>
          <p className="text-xs text-gray-400">JPG / PNG / WEBP up to 5 MB</p>
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Profile picture</h3>
            <p className="mt-0.5 text-sm text-gray-500">
              This image is shown in your sidebar and the top-right user menu in
              place of your initials. Each tenant has their own — your picture
              is private to your workspace.
            </p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          {success && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-700">{success}</div>
          )}

          <div className="flex flex-wrap gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={handleFile}
              className="hidden"
            />
            <Button onClick={handlePick} loading={busy}>
              {user?.profile_picture ? 'Change picture' : 'Upload picture'}
            </Button>
            {user?.profile_picture && (
              <Button variant="secondary" onClick={handleRemove} loading={busy}>
                Remove
              </Button>
            )}
          </div>

          <div className="pt-3 border-t border-gray-100 text-xs text-gray-500 space-y-0.5">
            <p><span className="font-medium text-gray-700">Name:</span> {user?.name || '—'}</p>
            <p><span className="font-medium text-gray-700">Email:</span> {user?.email || '—'}</p>
            <p><span className="font-medium text-gray-700">Role:</span> <span className="capitalize">{user?.role || '—'}</span></p>
          </div>
        </div>
      </div>
    </Card>
  )
}


// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user }  = useAuth()
  const canManage = user?.permissions?.includes('can_manage_settings') ||
                    user?.role === 'owner'

  // Every authenticated user can manage their own profile — even cashiers who
  // can't edit system settings — so 'profile' is the default tab and isn't
  // gated by `canManage`.
  const [tab,        setTab]       = useState('profile')   // 'profile' | 'settings' | 'tax'
  const [settings,   setSettings]  = useState({})
  const [taxGroups,  setTaxGroups] = useState([])
  const [loading,    setLoading]   = useState(true)
  const [taxModal,   setTaxModal]  = useState(false)
  const [editGroup,  setEditGroup] = useState(null)
  const [deleteGroup, setDeleteGroup] = useState(null)

  const loadSettings = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAllSettings()
      setSettings(data ?? {})
    } catch {
      setSettings({})
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTaxGroups = useCallback(async () => {
    try {
      const data = await getTaxGroups()
      setTaxGroups(Array.isArray(data) ? data : [])
    } catch {
      setTaxGroups([])
    }
  }, [])

  useEffect(() => {
    loadSettings()
    loadTaxGroups()
  }, [loadSettings, loadTaxGroups])

  // Only the Profile tab is surfaced here. (System Settings + Tax Groups were
  // removed from this page per request.)
  const tabs = [
    { key: 'profile',  label: 'Profile' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="mt-0.5 text-sm text-gray-500">Your profile details</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              'px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              tab === t.key
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {tab === 'profile' && <ProfileCard />}

      {/* System Settings tab */}
      {tab === 'settings' && canManage && (
        <Card>
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            </div>
          ) : !Object.keys(settings).length ? (
            <EmptyState
              icon={<CogIcon />}
              title="No settings found"
              message="Settings are seeded automatically when the tenant database is provisioned."
            />
          ) : (
            <SettingsEditor settings={settings} onSaved={loadSettings} />
          )}
        </Card>
      )}

      {/* Tax Groups tab */}
      {tab === 'tax' && canManage && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setEditGroup(null); setTaxModal(true) }}>
              <PlusIcon /> New Tax Group
            </Button>
          </div>

          <Card padding="p-0">
            {!taxGroups.length ? (
              <EmptyState
                icon={<PercentIcon />}
                title="No tax groups"
                message="Create a tax group to apply it to sales and expenses."
                action={<Button size="sm" onClick={() => { setEditGroup(null); setTaxModal(true) }}><PlusIcon /> New Tax Group</Button>}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <th className="px-5 py-3">Code</th>
                      <th className="px-5 py-3">Name</th>
                      <th className="px-5 py-3 text-right">Rate</th>
                      <th className="px-5 py-3">Default</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {taxGroups.map((g) => (
                      <tr key={g.id} className="hover:bg-gray-50/60">
                        <td className="px-5 py-3 font-mono text-xs font-semibold text-gray-700">{g.code}</td>
                        <td className="px-5 py-3 font-medium text-gray-900">{g.name}</td>
                        <td className="px-5 py-3 text-right font-semibold text-gray-900">{g.rate}%</td>
                        <td className="px-5 py-3">
                          {g.is_default && <Badge variant="indigo" dot>Default</Badge>}
                        </td>
                        <td className="px-5 py-3">
                          {g.is_active
                            ? <Badge variant="green" dot>Active</Badge>
                            : <Badge variant="gray" dot>Inactive</Badge>
                          }
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex justify-end gap-3">
                            <button
                              onClick={() => { setEditGroup(g); setTaxModal(true) }}
                              className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                            >
                              Edit
                            </button>
                            {!g.is_default && (
                              <button
                                onClick={() => setDeleteGroup(g)}
                                className="text-xs font-medium text-red-500 hover:text-red-600 hover:underline"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Tax Group create/edit modal */}
      <TaxGroupModal
        open={taxModal}
        onClose={() => { setTaxModal(false); setEditGroup(null) }}
        group={editGroup}
        onSaved={loadTaxGroups}
      />

      {/* Delete confirmation */}
      {deleteGroup && (
        <DeleteModal
          open={Boolean(deleteGroup)}
          onClose={() => setDeleteGroup(null)}
          group={deleteGroup}
          onDeleted={() => { setDeleteGroup(null); loadTaxGroups() }}
        />
      )}
    </div>
  )
}

function PlusIcon() {
  return <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" /></svg>
}
function CogIcon() {
  return <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
}
function PercentIcon() {
  return <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 14.25l6-6m4.5-3.493V21.75l-3.75-1.5-3.75 1.5-3.75-1.5-3.75 1.5V4.757c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0c1.1.128 1.907 1.077 1.907 2.185zM9.75 9h.008v.008H9.75V9zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 4.5h.008v.008h-.008V13.5zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>
}
