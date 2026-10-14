import { useViewMemory, useViewScroll } from '@/lib/view-memory'

import type { ReactNode } from 'react'
import { CaretLeft } from '@phosphor-icons/react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useBackClose } from '@/hooks/use-back-close'
import { cn } from '@/lib/utils'
import { ResizeHandle } from '@/components/ui/resize-handle'

/**
 * Two-pane master/detail layout.
 *
 * Desktop (>=768px): master and detail sit side by side. The border between
 *                    them drags, and the width is remembered per `resizeKey`.
 * Mobile  (<768px):  only one pane is mounted at a time. The detail pane takes
 *                    the full width in a single page scroller whose first row
 *                    is the back header — it scrolls WITH the page instead of
 *                    pinning over the content (a pinned row keeps eating the
 *                    viewport once the keyboard opens). The detail's own
 *                    ScrollArea auto-heights to its content inside that page
 *                    scroller, so there is exactly one scroll: the page.
 */
export function MasterDetail({
  detailOpen,
  onBack,
  detailTitle,
  memoryKey,
  resizeKey,
  masterWidth = 'w-64',
  pageScroll = false,
  master,
  detail,
}: {
  /** True when the detail pane should take over the screen on mobile. */
  detailOpen: boolean
  onBack: () => void
  /** Shown in the mobile back header. */
  detailTitle?: string
  memoryKey?: string
  /** Names this layout: the master width the user dragged is kept under it. */
  resizeKey: string
  /** Tailwind width class for the master pane on desktop, until resized. */
  masterWidth?: string
  pageScroll?: boolean
  master: ReactNode
  detail: ReactNode
}) {
  const isMobile = useIsMobile()
  useBackClose(detailOpen, onBack)
  const scrollRef = useViewScroll(`${memoryKey}.mobile`, !!memoryKey && isMobile && detailOpen, true)
  // 0 until the user picks a width
  const [width, setWidth] = useViewMemory(`layout.${resizeKey}.master`, 0, true)

  if (isMobile) {
    if (!detailOpen) {
      return <div className={cn('flex min-h-0 min-w-0 flex-col', !pageScroll && 'h-full overflow-hidden')}>{master}</div>
    }
    return (
      // inner ScrollArea viewports get overscroll-auto: with their default
      // overscroll-contain, a wheel over the (auto-height, non-scrolling)
      // viewport never chains up to this page scroller and the page won't move
      <div ref={scrollRef} className={cn('min-h-0 min-w-0', !pageScroll && 'h-full overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] [&_[data-slot=scroll-area-viewport]]:overscroll-auto')}>
        <div className="flex min-h-full flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
            <button
              type="button"
              onClick={onBack}
              className="-ml-1 flex min-h-9 items-center gap-0.5 rounded-md pr-2 pl-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <CaretLeft className="size-5" aria-hidden="true" />
              Back
            </button>
            {detailTitle && (
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{detailTitle}</span>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </div>
      </div>
    )
  }

  return (
    // `min-h-0` on both panes is load-bearing: a flex item defaults to
    // `min-height:auto`, which refuses to shrink below its content. Without it
    // a tall pane grows past the viewport, its inner ScrollArea inherits that
    // grown height, and the overflow becomes unreachable instead of scrolling
    // (the Lorebooks / Presets / Regex "can't scroll down" bug).
    <div className={cn('flex min-h-0', !pageScroll && 'h-full overflow-hidden')}>
      <div
        className={cn('relative flex min-h-0 shrink-0 flex-col border-r border-border', masterWidth, 'max-w-[calc(100%-15rem)] min-w-40')}
        style={width ? { width } : undefined}
      >
        {master}
        <ResizeHandle label="Resize the list" min={160} reserve={240} onResize={setWidth} onReset={() => setWidth(0)} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
    </div>
  )
}
