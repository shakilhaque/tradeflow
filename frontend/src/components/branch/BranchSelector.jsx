import { useBranch, CONSOLIDATED } from '../../context/BranchContext'

/**
 * Full-screen branch picker shown after login when the user can access more
 * than one branch (multi-branch data isolation). Selecting one scopes the
 * whole app to that branch; the owner also gets a consolidated option.
 */
export default function BranchSelector() {
  const { branches, canConsolidated, selectBranch } = useBranch()

  const Tile = ({ onClick, title, sub, accent }) => (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition hover:shadow-md ${accent}`}
    >
      <div>
        <p className="font-semibold text-gray-900">{title}</p>
        {sub && <p className="text-xs text-gray-500">{sub}</p>}
      </div>
      <span className="text-gray-300">→</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-gray-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-bold text-gray-900">Select a branch</h2>
        <p className="mt-1 text-sm text-gray-500">
          Choose the branch you want to work in. Everything — sales, stock,
          reports — will be limited to it. You can switch any time from the top bar.
        </p>

        <div className="mt-5 space-y-2">
          {canConsolidated && (
            <Tile
              onClick={() => selectBranch(CONSOLIDATED)}
              title="All Branches (Consolidated)"
              sub="Owner view — combined data across every branch"
              accent="border-emerald-200 bg-emerald-50/60 hover:border-emerald-400"
            />
          )}
          {branches.map((b) => (
            <Tile
              key={b.id}
              onClick={() => selectBranch(b.id)}
              title={b.name}
              sub={b.code ? `Code: ${b.code}` : ''}
              accent="border-gray-200 hover:border-brand-400"
            />
          ))}
          {branches.length === 0 && !canConsolidated && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              You have not been assigned to any branch yet. Please contact the
              account owner.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
