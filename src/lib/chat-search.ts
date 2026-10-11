import type { Chat } from './types'

export type ChatSearchMode = 'all' | 'messages' | 'titles'
export interface ChatSearchHit {
  chat: Chat
  matchCount: number
  snippets: { messageId: string | null; text: string; role: string }[]
}
export interface ChatSearchPage {
  total: number
  results: ChatSearchHit[]
  errors: { chatId: string; error: string }[]
}

export function searchTerms(query: string): string[] {
  return Array.from(new Set((query.toLowerCase().match(/"[^"]+"|[^\s"]+/g) ?? [])
    .map((term) => term.replace(/^"|"$/g, '').trim()).filter(Boolean)))
}

export function searchHighlight(text: string, query: string): { text: string; matched: boolean }[] {
  const terms = searchTerms(query)
  const lower = text.toLowerCase()
  const ranges: { start: number; end: number }[] = []
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) ranges.push({ start: at, end: at + term.length })
  }
  ranges.sort((a, b) => a.start - b.start)
  const parts: { text: string; matched: boolean }[] = []
  let last = 0
  for (const range of ranges) {
    if (range.end <= last) continue
    if (range.start > last) parts.push({ text: text.slice(last, range.start), matched: false })
    parts.push({ text: text.slice(Math.max(last, range.start), range.end), matched: true })
    last = range.end
  }
  if (last < text.length) parts.push({ text: text.slice(last), matched: false })
  return parts
}
