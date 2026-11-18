import { useEffect, useState } from 'react'
import { isBadPattern, runRegexChainSafe, runRegexSafe } from '@/lib/safe-regex'

/** One display-stage script, fully resolved: macros already substituted into
 *  `find`; `replace` keeps its macros because capture values need them too. */
export interface DisplayScript {
  find: string
  flags: string
  replace: string
  trims: string[]
  macros: Record<string, string>
}

// Display results per exact (text, script list). Streaming produces new keys
// every tick, so the map is bounded.
const cache = new Map<string, string[]>()
const CACHE_MAX = 256

// Long enough for a slow pattern on a long reply on a phone; still stops
// catastrophic backtracking, which runs for seconds or forever.
const TIMEOUT_MS = 1000

async function applyChain(texts: string[], scripts: DisplayScript[], priority: number, alive: () => boolean): Promise<string[] | null> {
  const out: string[] = []
  for (const text of texts) {
    // a row that moved on (a streaming tick, a swipe) queues no more work
    if (!alive()) return null
    const whole = await runRegexChainSafe(scripts, text, { timeoutMs: TIMEOUT_MS, priority })
    if (!whole.timedOut) {
      out.push(whole.ok && typeof whole.output === 'string' ? whole.output : text)
      continue
    }
    // one of the scripts is slow on this text: a pattern at a time finds it,
    // remembers it, and the rest still apply
    let cur = text
    for (const s of scripts) {
      if (!alive()) return null
      if (isBadPattern(s.find, s.flags, cur.length)) continue
      const r = await runRegexSafe(s.find, s.flags, s.replace, cur, { trims: s.trims, timeoutMs: TIMEOUT_MS, macros: s.macros, priority })
      if (r.timedOut) continue
      if (r.ok && typeof r.output === 'string') cur = r.output
    }
    out.push(cur)
  }
  return out
}

/** A script list as a short cache-key part, worked out once per list: rows
 *  keep their list across renders, and it runs to hundreds of entries. Equal
 *  lists in different rows share a number, so they share results too. */
const scriptIds = new WeakMap<DisplayScript[], number>()
const idsByContent = new Map<string, number>()
let lastId = 0
function scriptsKey(scripts: DisplayScript[]): number {
  let id = scriptIds.get(scripts)
  if (id === undefined) {
    const content = JSON.stringify(scripts)
    id = idsByContent.get(content)
    if (id === undefined) {
      // editing a script makes a new list per keystroke; old ones go
      if (idsByContent.size >= 32) idsByContent.clear()
      idsByContent.set(content, id = ++lastId)
    }
    scriptIds.set(scripts, id)
  }
  return id
}

/** Apply display-stage regex scripts to rendered text. The work runs in the
 *  regex worker, never synchronously in render: a hostile imported pattern
 *  would otherwise freeze the tab before any timeout could fire. Until a
 *  result is ready the row keeps its previous transformed text (raw text only
 *  on first render): a raw frame between two transformed ones changes the
 *  row's height, and a reader scrolled up in the log gets moved.
 *  `priority` orders the shared queue: the newest messages pass 0 and render
 *  first. */
export function useDisplayTexts(texts: string[], scripts: DisplayScript[], priority = 0): string[] {
  const cacheKey = scripts.length > 0 ? `${scriptsKey(scripts)}\n${JSON.stringify(texts)}` : ''
  // the row's own last result outlives the shared cache, which streaming
  // fills with a new entry every tick
  const [held, setHeld] = useState<{ key: string; out: string[] } | null>(null)
  const cached = cacheKey ? (held?.key === cacheKey ? held.out : cache.get(cacheKey)) : undefined
  useEffect(() => {
    if (!cacheKey) return
    const hit = cache.get(cacheKey)
    if (hit) {
      if (held?.key !== cacheKey) setHeld({ key: cacheKey, out: hit })
      return
    }
    let alive = true
    void applyChain(texts, scripts, priority, () => alive).then((out) => {
      if (!alive || !out) return
      cache.set(cacheKey, out)
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      setHeld({ key: cacheKey, out })
    })
    return () => { alive = false }
  }, [cacheKey]) // eslint-disable-line react-hooks/exhaustive-deps
  if (cached) return cached
  return cacheKey && held && held.out.length === texts.length ? held.out : texts
}
