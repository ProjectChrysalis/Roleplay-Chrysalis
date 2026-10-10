/** Keep complete replacements in order and hold reads until saves settle. */
export class SaveQueue {
  private pending = new Set<Promise<unknown>>()
  private tails = new Map<string, Promise<unknown>>()
  private scheduled = new Map<string, { timer: ReturnType<typeof setTimeout>; task: () => Promise<unknown>; promise: Promise<unknown>; launch: () => void }>()

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    const done = () => { this.pending.delete(promise) }
    void promise.then(done, done)
    return promise
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.scheduled.get(key)?.launch()
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = this.track(previous.then(task, task))
    this.tails.set(key, next)
    const done = () => { if (this.tails.get(key) === next) this.tails.delete(key) }
    void next.then(done, done)
    return next
  }

  replace<T>(key: string, task: () => Promise<T>, delay = 250): Promise<T> {
    const existing = this.scheduled.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.task = task
      existing.timer = setTimeout(existing.launch, delay)
      return existing.promise as Promise<T>
    }
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = this.track(new Promise<unknown>((yes, no) => { resolve = yes; reject = no }))
    const launch = (): void => {
      const entry = this.scheduled.get(key)
      if (entry?.promise !== promise) return
      clearTimeout(entry.timer)
      this.scheduled.delete(key)
      void this.run(key, entry.task).then(resolve, reject)
    }
    this.scheduled.set(key, { timer: setTimeout(launch, delay), task, promise, launch })
    return promise as Promise<T>
  }

  hasPending(): boolean { return this.pending.size > 0 }

  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

export const saves = new SaveQueue()
