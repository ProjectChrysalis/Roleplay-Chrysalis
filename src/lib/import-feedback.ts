export interface CardImportResult {
  characters: string[]
  lorebooks?: string[]
  regex?: string[]
  errors?: string[]
  name?: string
  warning?: string
}

export function cardImportDetails(result: CardImportResult, enableRegex: boolean): string {
  const parts: string[] = []
  const books = result.lorebooks?.length ?? 0
  const scripts = result.regex?.length ?? 0
  if (books) parts.push(`${books} lorebook${books === 1 ? '' : 's'} imported and linked`)
  if (scripts) parts.push(`${scripts} regex script${scripts === 1 ? '' : 's'} imported${enableRegex ? ', enabled unless disabled in the card' : ', off until enabled in the character editor'}`)
  return parts.join('. ')
}
