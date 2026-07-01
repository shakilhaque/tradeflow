/**
 * OutOfStockModal — blocking pop-up shown when the operator tries to
 * sell a product that has no (or not enough) stock at the selected
 * location. Used by Add Sale, POS, and Add Quotation (same page as
 * Add Sale) so the experience is identical everywhere.
 *
 * `data` shape:
 *   {
 *     message?:    string                      — headline override
 *     shortfalls?: [{ product_name, requested, available, shortfall }]
 *   }
 * Render nothing when data is null.
 */
import Modal, { ModalFooter } from './ui/Modal'
import Button from './ui/Button'

const q = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })

export default function OutOfStockModal({ data, onClose }) {
  if (!data) return null
  const shortfalls = Array.isArray(data.shortfalls) ? data.shortfalls : []

  return (
    <Modal open onClose={onClose} title="Out of Stock" size="md">
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
          </span>
          <div className="text-sm text-rose-800">
            {data.message || 'The following product(s) do not have enough stock at this location. Stock can never go negative — reduce the quantity or restock first.'}
          </div>
        </div>

        {shortfalls.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-gray-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Requested</th>
                  <th className="px-3 py-2 text-right">Available</th>
                  <th className="px-3 py-2 text-right">Short</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {shortfalls.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-medium text-gray-900">{s.product_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{q(s.requested)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 font-semibold">{q(s.available)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600">{q(s.shortfall ?? Math.max(0, Number(s.requested || 0) - Number(s.available || 0)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ModalFooter>
        <Button onClick={onClose}>OK, got it</Button>
      </ModalFooter>
    </Modal>
  )
}
