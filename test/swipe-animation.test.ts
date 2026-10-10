import { expect, test } from 'bun:test'
import { animateSwipe, swipeDuration } from '../src/lib/swipe-animation'

function panel(zoom = 1) {
  const slides: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions; complete: () => void; cancelled: boolean }> = []
  const element = {
    isConnected: true,
    offsetWidth: 500,
    getBoundingClientRect: () => ({ width: 500 * zoom }),
    animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
      const deferred = Promise.withResolvers<Animation>()
      const slide = { frames, options, complete: () => deferred.resolve({} as Animation), cancelled: false }
      slides.push(slide)
      return {
        finished: deferred.promise,
        cancel() { slide.cancelled = true; deferred.reject(new Error('Cancelled')) },
      } as Animation
    },
  } as unknown as HTMLElement
  return { element, slides }
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('next and previous swipes swap only while all outgoing panels are offscreen', async () => {
  for (const direction of [-1, 1] as const) {
    const avatar = panel()
    const reply = panel()
    const controller = new AbortController()
    const events: string[] = []
    const run = animateSwipe([avatar.element, reply.element], direction, 600, 125,
      () => events.push('swap'), controller.signal, (phase) => events.push(phase))
    await flush()
    expect(events).toEqual(['out'])
    expect(reply.slides[0]?.frames).toEqual([{ transform: 'translateX(0px)' }, { transform: `translateX(${direction * 600}px)` }])
    avatar.slides[0]?.complete()
    await flush()
    expect(events).toEqual(['out'])
    reply.slides[0]?.complete()
    await flush()
    expect(events).toEqual(['out', 'swap', 'in'])
    expect(reply.slides[0]?.cancelled).toBe(true)
    expect(reply.slides[1]?.frames).toEqual([{ transform: `translateX(${-direction * 600}px)` }, { transform: 'translateX(0px)' }])
    avatar.slides[1]?.complete()
    reply.slides[1]?.complete()
    await run
    expect(reply.slides.every((slide) => slide.cancelled)).toBe(true)
  }
})

test('leaving the chat cancels both panels without swapping stale content', async () => {
  const avatar = panel()
  const reply = panel()
  const controller = new AbortController()
  let swaps = 0
  const run = animateSwipe([avatar.element, reply.element], -1, 600, 125, () => swaps++, controller.signal, () => {})
  await flush()
  controller.abort()
  await run
  expect(swaps).toBe(0)
  expect(avatar.slides[0]?.cancelled).toBe(true)
  expect(reply.slides[0]?.cancelled).toBe(true)
})

test('cancelling the incoming slide preserves the content already shown', async () => {
  const reply = panel()
  const controller = new AbortController()
  let swaps = 0
  const run = animateSwipe([reply.element], -1, 600, 125, () => swaps++, controller.signal, () => {})
  await flush()
  reply.slides[0]?.complete()
  await flush()
  controller.abort()
  await run
  expect(swaps).toBe(1)
  expect(reply.slides[1]?.cancelled).toBe(true)
})

test('reduced motion and unsupported animations switch immediately without waiting for events', async () => {
  const reply = panel()
  let swaps = 0
  await animateSwipe([reply.element], -1, 600, 0, () => swaps++, new AbortController().signal, () => {})
  expect(reply.slides).toHaveLength(0)
  expect(swaps).toBe(1)
  await animateSwipe([{} as HTMLElement], -1, 600, 125, () => swaps++, new AbortController().signal, () => {})
  expect(swaps).toBe(2)
})

test('a stalled animation cannot leave the reply frozen offscreen', async () => {
  const reply = panel()
  let swaps = 0
  await animateSwipe([reply.element], -1, 600, 1, () => swaps++, new AbortController().signal, () => {})
  expect(swaps).toBe(1)
  expect(reply.slides.every((slide) => slide.cancelled)).toBe(true)
})

test('rapid repeats get faster and eventually skip unreadably short transitions', () => {
  const durations = [1, 2, 3, 4, 5, 6].map(swipeDuration)
  expect(durations[0]).toBeGreaterThan(100)
  expect(durations[1]).toBeLessThan(durations[0] ?? 0)
  expect(durations[3]).toBeGreaterThan(50)
  expect(durations[5]).toBe(0)
})

test('resized avatars and replies travel the same distance on screen', async () => {
  const avatar = panel(2)
  const reply = panel()
  const controller = new AbortController()
  const run = animateSwipe([avatar.element, reply.element], -1, 600, 125, () => {}, controller.signal, () => {})
  await flush()
  expect(avatar.slides[0]?.frames[1]).toEqual({ transform: 'translateX(-300px)' })
  expect(reply.slides[0]?.frames[1]).toEqual({ transform: 'translateX(-600px)' })
  controller.abort()
  await run
})
