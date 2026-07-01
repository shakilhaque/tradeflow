import AllSales from './AllSales'
import { getDraftSales } from '../../api/sales'

export default function DraftSalesPage() {
  return (
    <AllSales
      forcedStatus="DRAFT"
      pageTitle="Drafts"
      pageSubtitle="Manage all draft sales with full filters and exports."
      addButtonLabel="+ Add Draft"
      addPath="/sales/add-draft"
      bannerTitle="Drafts"
      visibleFilters={['location', 'customer', 'date_range']}
      searchUnderAddBar
      listApi={getDraftSales}
    />
  )
}
