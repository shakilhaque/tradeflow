import AllSales from './AllSales'
import { getPosSales } from '../../api/sales'

export default function SalesPage() {
  return (
    <AllSales
      forcedSource="POS"
      pageTitle="Sales List POS"
      pageSubtitle="POS sales with full filters, exports, and actions."
      addButtonLabel="+ Add"
      addPath="/sales/add"
      bannerTitle="Sales List POS"
      listApi={getPosSales}
    />
  )
}
