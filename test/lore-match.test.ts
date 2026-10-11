import { describe, expect, it } from 'bun:test'
import { loreEntryMatch } from '../src/lib/lore-match'
import { newLoreEntry } from '../src/lib/seed'
import type { LoreEntry } from '../src/lib/types'

const book = { caseSensitive: false, wholeWords: true }
const entry = (patch: Partial<LoreEntry>): LoreEntry => ({ ...newLoreEntry(), ...patch })

describe('keyword test matching', () => {
  it('matches whole words unless the book or the entry turns that off', () => {
    const e = entry({ keys: ['art'] })
    expect(loreEntryMatch('The start of it', e, book).fires).toBe(false)
    expect(loreEntryMatch('Her Art, mostly.', e, book)).toEqual({ fires: true, keys: ['art'] })
    expect(loreEntryMatch('The start of it', e, { ...book, wholeWords: false }).fires).toBe(true)
    expect(loreEntryMatch('The start of it', entry({ keys: ['art'], wholeWordsOverride: false }), book).fires).toBe(true)
    expect(loreEntryMatch('The start of it', entry({ keys: ['art'], wholeWordsOverride: true }), { ...book, wholeWords: false }).fires).toBe(false)
  })

  it('keeps case only when asked', () => {
    const e = entry({ keys: ['Harbor'] })
    expect(loreEntryMatch('the harbor', e, book).fires).toBe(true)
    expect(loreEntryMatch('the harbor', e, { ...book, caseSensitive: true }).fires).toBe(false)
    expect(loreEntryMatch('the Harbor', entry({ keys: ['Harbor'], caseSensitiveOverride: true }), book).fires).toBe(true)
  })

  it('reads slashed keys and regex entries as patterns', () => {
    expect(loreEntryMatch('two wolves', entry({ keys: ['/wol(f|ves)/'] }), book).fires).toBe(true)
    expect(loreEntryMatch('two wolves', entry({ keys: ['wol(f|ves)'], keysRegex: true }), book).fires).toBe(true)
    expect(loreEntryMatch('two wolves', entry({ keys: ['wol(f|ves)'] }), book).fires).toBe(false)
    expect(loreEntryMatch('a ( b', entry({ keys: ['('], keysRegex: true }), book).fires).toBe(true)
  })

  it('applies the secondary keys by the chosen logic', () => {
    const base = { keys: ['harbor'], secondaryKeys: ['winter', 'ice'] }
    const fires = (logic: LoreEntry['logic'], text: string) => loreEntryMatch(text, entry({ ...base, logic }), book).fires
    expect(fires('AND_ANY', 'harbor in winter')).toBe(true)
    expect(fires('AND_ANY', 'harbor in summer')).toBe(false)
    expect(fires('AND_ALL', 'harbor in winter')).toBe(false)
    expect(fires('AND_ALL', 'harbor, winter, ice')).toBe(true)
    expect(fires('NOT_ANY', 'harbor in summer')).toBe(true)
    expect(fires('NOT_ANY', 'harbor in winter')).toBe(false)
    expect(fires('NOT_ALL', 'harbor in winter')).toBe(true)
    expect(fires('NOT_ALL', 'harbor, winter, ice')).toBe(false)
  })

  it('a constant entry is always on and an entry without a matching key never is', () => {
    expect(loreEntryMatch('', entry({ status: 'constant' }), book)).toEqual({ fires: true, keys: [] })
    expect(loreEntryMatch('anything', entry({ keys: [] }), book).fires).toBe(false)
  })
})
