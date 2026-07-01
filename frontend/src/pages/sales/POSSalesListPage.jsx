import AllSales from './AllSales'
import { getPosSales } from '../../api/sales'

/**
 * Sales List POS — reuses the AllSales table component but is hardwired
 * to the POS-source list endpoint. Sales created from the /sales/pos page
 * are tagged with meta.source = "POS" and show up here.
 */
export default function POSSalesListPage() {
  return (
    <AllSales
      pageTitle="Sales List POS"
      pageSubtitle="All sales recorded through the POS terminal."
      addButtonLabel="+ New Sale"
      addPath="/sales/pos"
      bannerTitle="Sales List POS"
      forcedSource="POS"
      visibleFilters={[
        'location', 'customer', 'payment_status', 'date_range',
        'added_by', 'service_staff', 'shipping_status',
      ]}
      listApi={getPosSales}
    />
  )
}
