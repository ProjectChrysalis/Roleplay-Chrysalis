import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import type { EngineMessage } from '../src/lib/engine'

const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/admin/roleplay/' } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false }) } })
const { useApp } = await import('../src/lib/store')
const { engineChatToUI } = await import('../src/lib/engine')
const { toast } = await import('sonner')
useApp.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
afterAll(() => {
  for (const [key, descriptor] of [['window', oldWindow], ['location', oldLocation], ['localStorage', oldStorage]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const originalFetch = globalThis.fetch
let finish: (response: Response) => void
let cancelled: Record<string, unknown>[]
let transcript: EngineMessage[]
let failSave = false
const meta = { id: 'generation-test', title: 'Test', characterId: 'aria', updatedAt: 1, createdAt: 1 }
const json = (body: unknown, status = 200) => Response.json(body, { status })
const idle = () => new Promise((resolve) => setTimeout(resolve, 10))

beforeEach(() => {
  cancelled = []
  failSave = false
  transcript = [{ id: 'old-reply', role: 'char', charId: 'aria', name: 'Aria', text: 'Previous reply', at: 1, swipes: ['Previous reply'], swipe: 0 }]
  useApp.setState({ chats: [engineChatToUI(meta, transcript)], streaming: null, model: null })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (/\/(send|continue|swipe)$/.test(url)) {
      return new Promise<Response>((resolve, reject) => {
        finish = resolve
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
      })
    }
    if (url.endsWith('/__abort')) return json({ ok: true })
    if (url.endsWith('/cancelled')) {
      if (failSave) return json({ error: 'save unavailable' }, 503)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      cancelled.push(body)
      if (body.targetMessageId) {
        const target = transcript.find((m) => m.id === body.targetMessageId)!
        target.text = String(body.text)
        target.swipes = body.operation === 'continue' ? [target.text] : [...target.swipes!, target.text]
        target.swipe = target.swipes.length - 1
      } else {
        if (body.userText) transcript.push({ id: String(body.userMessageId), role: 'user', name: 'You', text: String(body.userText), at: 2 })
        if (body.text || (body.parts as unknown[])?.length) transcript.push({ id: String(body.replyMessageId), role: 'char', name: 'Aria', charId: 'aria', text: String(body.text), at: 3 })
      }
      return json({ ok: true })
    }
    if (url.endsWith('/chats/generation-test')) return json({ meta, messages: transcript })
    if (url.endsWith('/chats')) return json({ chats: [meta] })
    return json({})
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch })

it('a provider error preserves the streamed reply before refreshing the chat', async () => {
  useApp.getState().sendMessage(meta.id, 'Hello')
  await idle()
  const st = useApp.getState().streaming!
  useApp.setState({ streaming: { ...st, full: 'Unfinished reply', shown: 16 } })
  finish(json({ error: 'content_filter' }, 503))
  await idle()
  expect(cancelled).toHaveLength(1)
  expect(cancelled[0]!.text).toBe('Unfinished reply')
  const messages = useApp.getState().chats[0]!.messages
  expect(messages.map((m) => m.swipes[m.activeSwipe]!.content)).toEqual(['Previous reply', 'Hello', 'Unfinished reply'])
  expect(messages.at(-1)!.id.startsWith('pending-')).toBe(false)
  expect(useApp.getState().streaming).toBeNull()
})

it('Stop preserves only this generation and does not clone the preceding reply', async () => {
  useApp.getState().sendMessage(meta.id, 'Hello')
  await idle()
  const st = useApp.getState().streaming!
  useApp.setState({ streaming: { ...st, full: 'Partial', shown: 7 } })
  useApp.getState().stopStreaming()
  await idle()
  expect(cancelled).toHaveLength(1)
  expect(useApp.getState().chats[0]!.messages.map((m) => m.swipes[m.activeSwipe]!.content)).toEqual(['Previous reply', 'Hello', 'Partial'])
})

it('stopping an empty regeneration leaves existing swipes alone', async () => {
  useApp.getState().regenerate(meta.id)
  await idle()
  useApp.getState().stopStreaming()
  await idle()
  expect(cancelled).toHaveLength(0)
  const message = useApp.getState().chats[0]!.messages[0]!
  expect(message.swipes.map((s) => s.content)).toEqual(['Previous reply'])
})

it('interrupted Continue preserves its prefix and updates the current swipe', async () => {
  useApp.getState().continueReply(meta.id)
  await idle()
  const st = useApp.getState().streaming!
  expect(st.full).toBe('Previous reply ')
  useApp.setState({ streaming: { ...st, full: st.full + 'unfinished', shown: 25 } })
  useApp.getState().stopStreaming()
  await idle()
  expect(cancelled[0]!.operation).toBe('continue')
  expect(cancelled[0]!.expectedText).toBe('Previous reply')
  const message = useApp.getState().chats[0]!.messages[0]!
  expect(message.swipes.map((s) => s.content)).toEqual(['Previous reply unfinished'])
})

it('a failed save leaves the partial reply visible and Retry persists it', async () => {
  useApp.getState().sendMessage(meta.id, 'Hello')
  await idle()
  const st = useApp.getState().streaming!
  useApp.setState({ streaming: { ...st, full: 'Do not lose this', shown: 16 } })
  failSave = true
  useApp.getState().stopStreaming()
  await idle()
  expect(useApp.getState().chats[0]!.messages.at(-1)!.swipes[0]!.content).toBe('Do not lose this')
  const notice = toast.getHistory().at(-1)!
  expect(String(notice.title)).toContain('Could not save')
  const action = notice.action as { onClick: () => void }
  failSave = false
  action.onClick()
  await idle()
  expect(cancelled).toHaveLength(1)
  expect(useApp.getState().chats[0]!.messages.at(-1)!.id.startsWith('pending-')).toBe(false)
})
