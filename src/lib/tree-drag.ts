import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const SLOP = 5
const HOLD_MS = 280
const HOLD_SLOP = 12
const EDGE = 36
const MAX_SCROLL = 14

/**
 * Drag a row of a tree onto a target, started from anywhere on the row:
 *  - mouse/pen: press and move past a small slop; press and release is still
 *    a plain click on whatever sits inside the row
 *  - touch: hold, then move, so a flick keeps scrolling the list
 *  - children marked `data-no-drag` (menus, inputs) never start a drag
 *
 * The caller decides what is under the pointer: `resolve` returns a target
 * key (or null for "nothing would change") on every move, and `onDrop` runs
 * once with the last key. Render a floating label with `ghostRef` while
 * `dragging` is set. Escape cancels.
 */
export function useTreeDrag<S>(options: {
  resolve: (source: S, x: number, y: number) => string | null
  onDrop: (source: S, target: string) => void
}) {
  const [dragging, setDragging] = useState<S | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  // handlers registered at press time must see the current callbacks
  const live = useRef(options)
  live.current = options
  const ghost = useRef<HTMLDivElement | null>(null)
  const placeGhost = useRef<(() => void) | null>(null)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])

  const ghostRef = useCallback((node: HTMLDivElement | null) => {
    ghost.current = node
    placeGhost.current?.()
  }, [])

  const press = (source: S, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || stop.current) return
    const row = e.currentTarget
    // presses inside a menu or dialog opened from the row bubble here through
    // the component tree without being inside the row
    if (!(e.target instanceof Element) || !row.contains(e.target) || e.target.closest('[data-no-drag]')) return
    const pointerId = e.pointerId
    const touch = e.pointerType === 'touch'
    const startX = e.clientX
    const startY = e.clientY
    const viewport = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    let x = startX
    let y = startY
    let active = false
    let aborted = false
    let current: string | null = null
    let frame = 0
    let hold: ReturnType<typeof setTimeout> | null = null

    const place = () => {
      if (ghost.current) ghost.current.style.transform = `translate(${x + 12}px, ${y + 10}px)`
    }
    const aim = () => {
      if (aborted) return
      const next = live.current.resolve(source, x, y)
      if (next === current) return
      current = next
      setTarget(next)
    }
    // rows beyond the fold are reachable by holding the pointer at an edge
    const scroll = () => {
      frame = requestAnimationFrame(scroll)
      if (!viewport || aborted) return
      const rect = viewport.getBoundingClientRect()
      const before = viewport.scrollTop
      if (y < rect.top + EDGE) viewport.scrollTop -= Math.min(MAX_SCROLL, Math.ceil((rect.top + EDGE - y) / 3))
      else if (y > rect.bottom - EDGE && y <= rect.bottom) viewport.scrollTop += Math.min(MAX_SCROLL, Math.ceil((y - rect.bottom + EDGE) / 3))
      if (viewport.scrollTop !== before) aim()
    }
    const begin = () => {
      active = true
      // captured, the drag keeps receiving moves and its release even when the
      // pointer leaves the app's frame
      if (!touch) { try { row.setPointerCapture(pointerId) } catch { /* pointer already gone */ } }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'
      placeGhost.current = place
      setDragging(source)
      aim()
      frame = requestAnimationFrame(scroll)
    }
    const hide = () => {
      current = null
      setDragging(null)
      setTarget(null)
    }
    // the release that ends a drag is followed by a click on the row
    const swallowClick = () => {
      const eat = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', eat, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', eat, true), 50)
    }
    const finish = (commit: boolean) => {
      if (hold) clearTimeout(hold)
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('touchmove', claimTouch)
      window.removeEventListener('contextmenu', noMenu, true)
      stop.current = null
      placeGhost.current = null
      if (!active) return
      try { row.releasePointerCapture(pointerId) } catch { /* never captured */ }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      const dropped = commit && !aborted ? current : null
      hide()
      if (dropped) live.current.onDrop(source, dropped)
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      x = ev.clientX
      y = ev.clientY
      if (!active) {
        const far = Math.hypot(x - startX, y - startY)
        // a finger that travels before the hold elapses is scrolling
        if (touch) { if (far > HOLD_SLOP) finish(false); return }
        if (far < SLOP) return
        begin()
      }
      place()
      aim()
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (active) swallowClick()
      finish(true)
    }
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(false) }
    // Escape drops the drag but keeps listening for the release, so its click
    // is still swallowed
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active || aborted) return
      ev.preventDefault()
      ev.stopPropagation()
      aborted = true
      hide()
    }
    // Without preventDefault the browser takes the gesture for scrolling as
    // soon as the finger twitches and cancels the pointer. Claimed only while
    // the finger rests inside the hold circle or the drag is running.
    const claimTouch = (ev: TouchEvent) => {
      if (active) { ev.preventDefault(); return }
      const t = ev.touches[0]
      if (t && Math.hypot(t.clientX - startX, t.clientY - startY) <= HOLD_SLOP) ev.preventDefault()
    }
    const noMenu = (ev: Event) => ev.preventDefault()

    stop.current = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
    if (touch) {
      window.addEventListener('touchmove', claimTouch, { passive: false })
      window.addEventListener('contextmenu', noMenu, true)
      hold = setTimeout(() => { hold = null; begin() }, HOLD_MS)
    }
  }

  return { dragging, target, ghostRef, press }
}
