import { useBranch, CONSOLIDATED } from '../../context/BranchContext'

/**
 * Header dropdown to switch the active branch. Hidden when the user only has
 * a single option (nothing to switch). Switching reloads the app so every
 * module refetches scoped to the chosen branch.
 */
export default function BranchSwitcher() {
  const { branches, canConsolidated, active, switchBranch, loading } = useBranch()
  if (loading) return null

  const options = [
    ...(canConsolidated ? [{ id: CONSOLIDATED, name: 'All Branches' }] : []),
    ...branches,
  ]
  if (options.length <= 1) return null

  return (
    <label className="hidden items-center gap-1.5 sm:flex" title="Active branch">
      <svg className="h-4 w-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M3 4.75A1.75 1.75 0 014.75 3h3.5A1.75 1.75 0 0110 4.75V8h6.25A1.75 1.75 0 0118 9.75v5.5A1.75 1.75 0 0116.25 17H3.75A1.75 1.75 0 012 15.25V4.75z" />
      </svg>
      <select
        value={active}
        onChange={(e) => switchBranch(e.target.value)}
        className="h-8 max-w-[160px] rounded-md border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </label>
  )
}
