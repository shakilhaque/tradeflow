import DateRangePresetPicker from './DateRangePresetPicker'

/**
 * DateRangeField — a labelled single date-range control for the report
 * filter bars. Wraps DateRangePresetPicker (Today / Last 7 Days / This
 * Month / … / Custom Range) so every report shares the same picker, and
 * reports the chosen range as { from, to }.
 *
 * Props
 *   from, to            — ISO date strings ("YYYY-MM-DD") or ""
 *   onChange({from,to}) — called when a preset/custom range is picked
 *   label               — field label (default "Date Range")
 */
export default function DateRangeField({ from, to, onChange, label = 'Date Range', fiscalStartMonth = 7 }) {
  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <DateRangePresetPicker
        from={from}
        to={to}
        onChange={onChange}
        fiscalStartMonth={fiscalStartMonth}
        className="!h-[38px] text-sm"
      />
    </div>
  )
}
