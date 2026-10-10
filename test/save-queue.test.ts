import { expect, test } from 'bun:test'
import { SaveQueue } from '../src/lib/save-queue'
const pause = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('replacements coalesce and protect reads during the debounce', async () => {
  const queue = new SaveQueue()
  const written: string[] = []
  const first = queue.replace('card', async () => { written.push('old'); return 'old' }, 10)
  const latest = queue.replace('card', async () => { written.push('new'); return 'new' }, 10)
  let read = false
  const waiting = queue.settled().then(() => { read = true })
  await pause()
  expect(queue.hasPending()).toBe(true)
  expect(read).toBe(false)
  expect(await first).toBe('new')
  expect(await latest).toBe('new')
  await waiting
  expect(written).toEqual(['new'])
  expect(read).toBe(true)
})

test('a slow earlier save cannot finish after the latest save', async () => {
  const queue = new SaveQueue()
  const held = gate()
  const events: string[] = []
  const first = queue.run('preset', async () => { events.push('first started'); await held.promise; events.push('first saved') })
  const next = queue.replace('preset', async () => { events.push('latest saved') }, 1)
  await pause(5)
  expect(events).toEqual(['first started'])
  held.resolve()
  await Promise.all([first, next, queue.settled()])
  expect(events).toEqual(['first started', 'first saved', 'latest saved'])
})

test('deleting after a pending replacement flushes it once before deletion', async () => {
  const queue = new SaveQueue()
  const events: string[] = []
  const save = queue.replace('persona', async () => { events.push('save') }, 10)
  const deletion = queue.run('persona', async () => { events.push('delete') })
  await Promise.all([save, deletion, queue.settled()])
  await pause(20)
  expect(events).toEqual(['save', 'delete'])
})

test('separate entities save independently and a failed save does not stall retries', async () => {
  const queue = new SaveQueue()
  const held = gate()
  const first = queue.run('first', async () => { await held.promise; throw new Error('offline') })
  const rejected = first.catch((error) => error as Error)
  expect(await queue.run('second', async () => 'saved')).toBe('saved')
  const retry = queue.run('first', async () => 'retried')
  held.resolve()
  expect((await rejected).message).toBe('offline')
  expect(await retry).toBe('retried')
  await queue.settled()
  expect(queue.hasPending()).toBe(false)
})
