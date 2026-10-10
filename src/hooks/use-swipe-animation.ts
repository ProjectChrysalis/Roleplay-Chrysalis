import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { animateSwipe, swipeDuration, type SwipeDirection, type SwipePhase } from '@/lib/swipe-animation'

export function useSwipeAnimation(log: RefObject<HTMLElement | null>, chatId: string | null, reducedMotion: boolean) {
  const [swipeFx, setSwipeFx] = useState<{ index: number; phase: SwipePhase } | null>(null)
  const active = useRef<AbortController | null>(null)
  const stats = useRef({ now: 0, direction: 0, count: 0 })

  useLayoutEffect(() => {
    active.current?.abort()
    active.current = null
    stats.current = { now: 0, direction: 0, count: 0 }
    setSwipeFx(null)
    return () => { active.current?.abort(); active.current = null }
  }, [chatId, reducedMotion])

  const onSwipeFx = useCallback((index: number, direction: SwipeDirection, swap: () => void): boolean => {
    if (active.current || !log.current) return false
    const rows = Array.from(log.current.querySelectorAll<HTMLElement>('[data-message-index]'))
      .filter((row) => Number(row.dataset.messageIndex) >= index).slice(0, 100)
    const source = rows.find((row) => Number(row.dataset.messageIndex) === index)
    if (!source) return false
    const panels = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>(':scope > [data-swipe-panel]')))
    const range = source.getBoundingClientRect().width + 30
    const now = performance.now()
    if (now - stats.current.now >= 550 || direction !== stats.current.direction) stats.current.count = 0
    stats.current.now = now
    stats.current.direction = direction
    stats.current.count++
    const duration = reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : swipeDuration(stats.current.count)
    const controller = new AbortController()
    active.current = controller
    setSwipeFx({ index, phase: 'out' })
    void animateSwipe(panels, direction, range, duration, () => flushSync(swap), controller.signal,
      (phase) => { if (active.current === controller) setSwipeFx({ index, phase }) },
    ).catch(() => {
      if (!controller.signal.aborted) flushSync(swap)
    }).finally(() => {
      if (active.current === controller) { active.current = null; setSwipeFx(null) }
    })
    return true
  }, [log, reducedMotion])

  return { swipeFx, onSwipeFx }
}
