import AllSales from './AllSales'

export default function AllSalesPage() {
  return (
    <AllSales
      pageTitle="All Sales"
      pageSubtitle="All sales with full filters, exports, and actions."
      addButtonLabel="+ Add Sale"
      addPath="/sales/add"
      bannerTitle="All Sales"
    />
  )
}
