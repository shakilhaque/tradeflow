import AllSales from './AllSales'
import { getQuotationSales } from '../../api/sales'

export default function QuotationSalesPage() {
  return (
    <AllSales
      forcedStatus="QUOTATION"
      pageTitle="Quotations"
      pageSubtitle="Manage quotations with full filters and exports."
      addButtonLabel="+ Add Quotation"
      addPath="/sales/add-quotation"
      bannerTitle="Quotations"
      visibleFilters={['location', 'customer', 'date_range', 'added_by']}
      searchUnderAddBar
      listApi={getQuotationSales}
    />
  )
}
