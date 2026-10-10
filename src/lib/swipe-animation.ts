export type SwipePhase = 'out' | 'in'
export type SwipeDirection = 1 | -1

export function swipeDuration(count: number): number {
  const duration = Math.round(125 / (1 + Math.exp(count - 4)))
  return duration > 50 ? duration : 0
}

export async function animateSwipe(
  panels: HTMLElement[],
  direction: SwipeDirection,
  range: number,
  duration: number,
  swap: () => void,
  signal: AbortSignal,
  phase: (value: SwipePhase) => void,
): Promise<void> {
  let animations: Animation[] = []
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { for (const animation of animations) animation.cancel() }
  signal.addEventListener('abort', cancel, { once: true })
  const slide = async (from: number, to: number) => {
    animations = []
    const completions: Promise<unknown>[] = []
    for (const panel of panels.filter((panel) => panel.isConnected)) {
      // A zoomed avatar still travels the same screen distance as the reply.
      const scale = panel.offsetWidth > 0 ? panel.getBoundingClientRect().width / panel.offsetWidth : 1
      const zoom = scale > 0 ? scale : 1
      const animation = panel.animate(
        [{ transform: `translateX(${from / zoom}px)` }, { transform: `translateX(${to / zoom}px)` }],
        { duration, easing: 'ease-in-out', fill: 'forwards' },
      )
      animations.push(animation)
      completions.push(animation.finished.catch(() => undefined))
    }
    // Removed or backgrounded documents may never deliver a completion event.
    await Promise.race([
      Promise.all(completions),
      new Promise<void>((resolve) => { watchdog = setTimeout(resolve, duration * 2 + 100) }),
    ])
    clearTimeout(watchdog)
  }
  try {
    // Even an instant swap runs after the caller's layout effect has finished.
    await Promise.resolve()
    if (signal.aborted) return
    if (!duration || !panels.length || !panels.every((panel) => typeof panel.animate === 'function')) {
      swap()
      return
    }
    phase('out')
    await slide(0, direction * range)
    if (signal.aborted) return
    swap()
    cancel()
    phase('in')
    await slide(-direction * range, 0)
  } finally {
    clearTimeout(watchdog)
    cancel()
    signal.removeEventListener('abort', cancel)
  }
}
