interface InputLayout {
  clientWidth: number
  offsetHeight: number
  scrollHeight: number
  getClientRects: () => { length: number }
  style: { height: string }
}

/** A hidden frame reports zero dimensions; keep its last valid height. */
export function fitComposerInput(input: InputLayout): number {
  if (input.getClientRects().length === 0 || input.clientWidth === 0) return 0
  const before = input.offsetHeight
  input.style.height = '1px'
  input.style.height = `${Math.max(36, input.scrollHeight)}px`
  return input.offsetHeight - before
}
