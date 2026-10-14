import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'

const previousBase = process.env.BASE_URL
process.env.BASE_URL = '/app/alice/roleplay/'
const keys = ['window', 'location', 'localStorage', 'WebSocket', 'requestAnimationFrame', 'cancelAnimationFrame'] as const
const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
class Socket {
  static latest: Socket
  onmessage?: (event: { data: string }) => void
  constructor() { Socket.latest = this }
  close() {}
  emit(payload: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify({ type: 'app_stream', payload: { app: 'roleplay', chatId: 'group-chat', ...payload } }) }) }
}
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/alice/roleplay/', protocol: 'http:', host: 'localhost:18878' } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage, matchMedia: () => ({ matches: false }) } })
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: () => void) => setTimeout(fn, 0) })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: clearTimeout })
const { useApp } = await import('../src/lib/store')
const { engineChatToUI, presetToEngine } = await import('../src/lib/engine')
const { buildDefaultPreset } = await import('../src/lib/seed')
const { saves } = await import('../src/lib/save-queue')
useApp.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const originalFetch = globalThis.fetch
const meta = { id: 'group-chat', title: 'Council', groupId: 'council' }
let cancelled: Record<string, unknown>[]
const idle = () => new Promise(resolve => setTimeout(resolve, 15))

beforeEach(async () => {
  cancelled = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return Response.json({
      characters: [{ id: 'fox', name: 'Shared name' }, { id: 'owl', name: 'Shared name' }],
      groups: [{ id: 'council', name: 'Council', memberIds: ['fox', 'owl'] }],
      chats: [meta], activeChat: { meta, messages: [] }, personas: [], presets: [{ id: 'default', ...presetToEngine(buildDefaultPreset()) }],
      lorebooks: [], regex: [], settings: {}, library: {}, databank: { files: [] },
    })
    if (url.endsWith('/cancelled')) cancelled.push(JSON.parse(String(init?.body)))
    if (url.endsWith('/chats/group-chat')) return Response.json({ meta, messages: [] })
    if (url.endsWith('/chats')) return Response.json({ chats: [meta] })
    return Response.json({ models: [], connections: [] })
  }) as typeof fetch
  useApp.setState({ activeChatId: meta.id, streaming: null })
  await useApp.getState().hydrate()
  expect(useApp.getState().bootError).toBeNull()
  expect(useApp.getState().boot).toBe('ready')
  const chat = engineChatToUI(meta, [{ id: 'pending-reply', name: 'Council', charId: 'council', role: 'char', text: '', at: 1 }])
  useApp.setState({ chats: [chat], streaming: { chatId: meta.id, messageId: 'pending-reply', operation: 'send', full: '', shown: 0, startedAt: Date.now() } })
})
afterEach(async () => { await saves.settled(); globalThis.fetch = originalFetch })
afterAll(() => {
  if (previousBase === undefined) delete process.env.BASE_URL
  else process.env.BASE_URL = previousBase
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

it('uses the streamed member ID even when group members have the same name, including interrupted saves', async () => {
  Socket.latest.emit({ speakerId: 'owl', name: 'Shared name', delta: 'Partial reply' })
  await idle()
  expect(useApp.getState().chats[0]?.messages[0]?.characterId).toBe('owl')
  useApp.getState().stopStreaming()
  await idle()
  expect(cancelled[0]).toMatchObject({ charId: 'owl', text: 'Partial reply' })
})

it('identifies a speaker before thinking or tool events and rejects nonmembers', async () => {
  Socket.latest.emit({ speakerId: 'outsider', name: 'Other', delta: '' })
  expect(useApp.getState().chats[0]?.messages[0]?.characterId).toBe('council')
  Socket.latest.emit({ speakerId: 'owl', name: 'Shared name', thinking: 'Plan' })
  await idle()
  expect(useApp.getState().chats[0]?.messages[0]?.characterId).toBe('owl')
  Socket.latest.emit({ speakerId: 'fox', name: 'Shared name', tool: { phase: 'start', name: 'lookup', args: {} } })
  expect(useApp.getState().chats[0]?.messages[0]?.characterId).toBe('fox')
})
