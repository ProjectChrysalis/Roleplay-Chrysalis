import { startTransition, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useApp } from '@/lib/store'

type AppState = ReturnType<typeof useApp.getState>
type Stream = NonNullable<AppState['streaming']>

// A streamed update may use about a fifth of the main thread; past that,
// typing anywhere in the app waits behind the reply's re-render.
const COST_SHARE = 4
const MAX_WAIT_MS = 300

/** The live stream of one message, delivered no faster than the row showing
 *  it can afford to re-render. Each update waits COST_SHARE times what the
 *  previous one cost (render through commit), so a fast machine keeps every
 *  typewriter tick and a slow one shows the reply in bigger steps. A stream
 *  starting or ending arrives at once. */
export function usePacedStream(messageId: string): Stream | null {
  const [stream, setStream] = useState(() => pick(useApp.getState(), messageId))
  const renderAt = useRef(0)
  const last = useRef({ at: 0, cost: 0 })
  renderAt.current = performance.now()

  useLayoutEffect(() => {
    if (!stream) return
    const now = performance.now()
    last.current = { at: now, cost: now - renderAt.current }
  }, [stream])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deliver = () => {
      timer = undefined
      const next = pick(useApp.getState(), messageId)
      startTransition(() => setStream(next))
    }
    const unsubscribe = useApp.subscribe((s, prev) => {
      const next = pick(s, messageId)
      const before = pick(prev, messageId)
      if (next === before) return
      if (!next || !before) {
        clearTimeout(timer)
        timer = undefined
        setStream(next)
        return
      }
      if (timer) return
      const wait = Math.min(MAX_WAIT_MS, last.current.cost * COST_SHARE) - (performance.now() - last.current.at)
      timer = setTimeout(deliver, Math.max(0, wait))
    })
    // the stream may have moved between the first render and subscribing
    setStream(pick(useApp.getState(), messageId))
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [messageId])

  return stream
}

function pick(s: AppState, messageId: string): Stream | null {
  return s.streaming?.messageId === messageId ? s.streaming : null
}
