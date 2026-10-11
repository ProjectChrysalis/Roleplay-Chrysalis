const rateFormatter = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumSignificantDigits: 12,
})

export function formatModelRate(rate: number): string {
  return rateFormatter.format(rate)
}
