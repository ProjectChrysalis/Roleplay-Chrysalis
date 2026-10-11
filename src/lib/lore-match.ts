import type { LoreEntry, Lorebook } from '@/lib/types'

type ScanSettings = Pick<Lorebook['settings'], 'caseSensitive' | 'wholeWords'>

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does one key occur in the text, by the rules a generation scans with: whole
 * words unless the book or the entry says otherwise, "/pattern/flags" keys and
 * regex entries as patterns, case kept only when the book or entry asks.
 */
export function loreKeyMatches(text: string, key: string, entry: LoreEntry, settings: ScanSettings): boolean {
  const k = key.trim()
  if (!k) return false
  const slashed = k.length > 2 && k.startsWith('/')
  if (entry.caseSensitiveOverride === true || settings.caseSensitive === true) return slashed ? false : text.includes(k)
  const scan = text.toLowerCase()
  if (slashed) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(k)
    if (m) {
      try { return new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i').test(scan) } catch { /* bad pattern: read as plain text */ }
    }
  } else if (entry.keysRegex) {
    try { return new RegExp(k, 'i').test(scan) } catch { /* bad pattern: read as plain text */ }
  }
  const whole = entry.wholeWordsOverride ?? settings.wholeWords !== false
  const lk = k.toLowerCase()
  if (whole && /^[\w\s'-]+$/.test(k)) {
    try {
      return new RegExp('(^|[^\\p{L}\\p{N}])' + esc(lk) + '([^\\p{L}\\p{N}]|$)', 'u').test(scan)
    } catch {
      return scan.includes(lk)
    }
  }
  return scan.includes(lk)
}

/**
 * Whether an entry would switch on for this text, and the keys that did it.
 * The trigger chance is left out, so the answer is the same every time.
 */
export function loreEntryMatch(text: string, entry: LoreEntry, settings: ScanSettings): { fires: boolean; keys: string[] } {
  if (entry.status === 'constant') return { fires: true, keys: [] }
  const keys = entry.keys.filter((k) => loreKeyMatches(text, k, entry, settings))
  if (!keys.length) return { fires: false, keys }
  const secondary = entry.secondaryKeys
  if (secondary.length) {
    const hits = secondary.filter((k) => loreKeyMatches(text, k, entry, settings)).length
    if (entry.logic === 'AND_ANY' && hits < 1) return { fires: false, keys }
    if (entry.logic === 'AND_ALL' && hits < secondary.length) return { fires: false, keys }
    if (entry.logic === 'NOT_ANY' && hits > 0) return { fires: false, keys }
    if (entry.logic === 'NOT_ALL' && hits === secondary.length) return { fires: false, keys }
  }
  return { fires: true, keys }
}
