
import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { X } from '@phosphor-icons/react'
import { popupInitialFocus } from "@/lib/popup-focus"
import { useBackClosable } from "@/hooks/use-back-close"

function Sheet({ open, defaultOpen, onOpenChange, ...props }: Omit<SheetPrimitive.Root.Props, "actionsRef">) {
  const back = useBackClosable<SheetPrimitive.Root.ChangeEventDetails, SheetPrimitive.Root.Actions>(open, defaultOpen, onOpenChange)
  return <SheetPrimitive.Root data-slot="sheet" {...props} {...back} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
}

/** Clips a sheet to a box (see clipClassName). The box itself never takes a
 *  click, so the backdrop beside the sheet still does. */
function SheetClip({ className, children }: { className?: string; children: React.ReactNode }) {
  if (!className) return <>{children}</>
  return <div data-slot="sheet-clip" className={cn("pointer-events-none fixed z-50 overflow-hidden", className)}>{children}</div>
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  initialFocus,
  overlayClassName,
  onOverlayClick,
  clipClassName,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  /** merged into the backdrop classes (e.g. to leave a strip of the page live) */
  overlayClassName?: string
  /** click handler for the backdrop (self-managed close when pointer dismissal is off) */
  onOverlayClick?: () => void
  /** the fixed box the sheet lives in and is clipped by, for a sheet that
   *  starts beside a bar instead of at the screen edge: it slides out from
   *  under that bar and back, never across it. The sheet is positioned
   *  inside this box. */
  clipClassName?: string
}) {
  // no auto-focus into text fields on open (mobile keyboards) — see popup-focus
  const popupRef = React.useRef<HTMLDivElement | null>(null)
  return (
    <SheetPortal>
      <SheetOverlay className={overlayClassName} onClick={onOverlayClick} />
      <SheetClip className={clipClassName}>
      <SheetPrimitive.Popup
        ref={popupRef}
        data-slot="sheet-content"
        data-side={side}
        initialFocus={initialFocus ?? popupInitialFocus(popupRef)}
        className={cn(
          // a real slide: the sheet travels its whole size from the edge it
          // belongs to and back, with no fade standing in for the movement
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:duration-200 data-ending-style:ease-in motion-reduce:transition-none data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:max-h-[90dvh] data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-full data-[side=bottom]:data-starting-style:translate-y-full data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:-translate-x-full data-[side=left]:data-starting-style:-translate-x-full data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-full data-[side=right]:data-starting-style:translate-x-full data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:max-h-[90dvh] data-[side=top]:border-b data-[side=top]:data-ending-style:-translate-y-full data-[side=top]:data-starting-style:-translate-y-full data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          clipClassName && "pointer-events-auto absolute",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <X
            />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
      </SheetClip>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
