import { useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

const STEP = 24

/**
 * The draggable right edge of a pane. Place it inside the pane (which must be
 * positioned); it straddles the pane's border and reports the width the pane
 * would have with its edge under the pointer, kept between `min` and what the
 * pane's container holds minus `reserve`. Arrow keys step the edge and a
 * double-click asks for the default back.
 */
export function ResizeHandle({ label, min, reserve = 0, onResize, onReset, className }: {
  label: string
  min: number
  /** width left for whatever shares the container with the pane */
  reserve?: number
  onResize: (width: number, available: number) => void
  onReset: () => void
  className?: string
}) {
  const [dragging, setDragging] = useState(false)
  const resize = (handle: HTMLElement, width: (pane: HTMLElement) => number) => {
    const pane = handle.parentElement
    const available = pane?.parentElement?.clientWidth
    if (!pane || !available) return
    onResize(Math.round(Math.min(Math.max(width(pane), min), Math.max(min, available - reserve))), available)
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    setDragging(false)
  }
  return <div
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    title="Drag to resize, double-click to reset"
    tabIndex={0}
    data-dragging={dragging || undefined}
    className={cn('group/resize absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none', className)}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      e.preventDefault()
      // captured, so the edge keeps following a pointer that outruns it
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      setDragging(true)
    }}
    onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(e.currentTarget, (pane) => e.clientX - pane.getBoundingClientRect().left) }}
    onPointerUp={end}
    onPointerCancel={end}
    onDoubleClick={onReset}
    onKeyDown={(e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      resize(e.currentTarget, (pane) => pane.offsetWidth + (e.key === 'ArrowLeft' ? -STEP : STEP))
    }}
  >
    <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary opacity-0 transition-opacity delay-100 group-hover/resize:opacity-60 group-focus-visible/resize:opacity-60 group-data-dragging/resize:opacity-100" />
  </div>
}
