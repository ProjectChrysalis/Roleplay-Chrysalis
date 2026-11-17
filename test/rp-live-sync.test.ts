import { afterAll, afterEach, expect, test } from 'bun:test'

const descriptors = new Map(['location', 'window', 'localStorage', 'WebSocket'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const previousBase = process.env.BASE_URL
process.env.BASE_URL = '/app/admin/roleplay/'
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/admin/roleplay/', protocol: 'http:', host: 'localhost' } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false }) } })
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class { close() {} } })
const { useApp, classifyDataPath, syncDataChanges } = await import('../src/lib/store')
const { cardToCharacter, engineChatToUI, engineLorebookToUI } = await import('../src/lib/engine')
const { saves } = await import('../src/lib/save-queue')
useApp.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const originalFetch = globalThis.fetch

/** Answers by route; records every path the store asked for. */
function serve(routes: Record<string, (url: URL) => Response>) {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost')
    const route = url.pathname.replace(/^.*\/v1\/apps\/[^/]+/, '')
    asked.push(route + url.search)
    const handler = routes[route]
    return handler ? handler(url) : Response.json({ error: 'not found' }, { status: 404 })
  }) as typeof fetch
  return asked
}

afterEach(async () => { await saves.settled(); globalThis.fetch = originalFetch })
afterAll(() => {
  if (previousBase === undefined) delete process.env.BASE_URL
  else process.env.BASE_URL = previousBase
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('changed paths name the record they belong to', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
  expect(classifyDataPath('data/chats/c1.jsonl')).toEqual({ kind: 'chat', id: 'c1' })
  expect(classifyDataPath('data/chats/c1.meta.json')).toEqual({ kind: 'chat', id: 'c1' })
  expect(classifyDataPath(`data/chats/c1.jsonl.${uuid}.tmp`)).toEqual({ kind: 'chat', id: 'c1' })
  expect(classifyDataPath('data\\chats\\c1.memories.json')).toEqual({ kind: 'chat', id: 'c1' })
  expect(classifyDataPath('data/characters/aria/card.json')).toEqual({ kind: 'characters', id: 'aria' })
  expect(classifyDataPath('data/characters/aria')).toEqual({ kind: 'characters', id: 'aria' })
  expect(classifyDataPath(`data/presets/p1.json.${uuid}.tmp`)).toEqual({ kind: 'presets', id: 'p1' })
  expect(classifyDataPath('data/lorebooks/world.json')).toEqual({ kind: 'lorebooks', id: 'world' })
  expect(classifyDataPath('data/settings.json')).toEqual({ kind: 'settings' })
  expect(classifyDataPath('data/databank/f1.json')).toEqual({ kind: 'settings' })
  for (const skipped of ['data/presets/_default.json', 'data/lorebooks/.vectors.json', 'data/variables.json', 'data/__media/ab.png', 'data/regex/_example.json']) {
    expect(classifyDataPath(skipped)).toEqual({ kind: 'skip' })
  }
  for (const unknown of ['data/tools/t1.json', 'data/README.md', 'data/presets/notes.txt', 'src/main.tsx']) {
    expect(classifyDataPath(unknown)).toBeNull()
  }
})

test('a saved message reads that chat alone, never the library', async () => {
  const meta = { id: 'c1', title: 'Chat', characterId: 'aria', updatedAt: 5 }
  const first = { id: 'm1', name: 'Aria', charId: 'aria', role: 'char' as const, at: 1, text: 'Hello', swipes: ['Hello'], swipe: 0 }
  const reply = { id: 'm2', name: 'User', role: 'user' as const, at: 2, text: 'Hi', swipes: ['Hi'], swipe: 0 }
  const other = { ...engineChatToUI({ id: 'c2', title: 'Other', characterId: 'kael' }, []) }
  useApp.setState({
    chats: [{ ...engineChatToUI(meta, [first]), cursor: 'v1' }, other],
    characters: [cardToCharacter({ name: 'Aria' }, 'aria', 1), cardToCharacter({ name: 'Kael' }, 'kael', 1)],
    streaming: null,
  })
  const asked = serve({
    '/chats/c1': () => Response.json({ meta: { ...meta, updatedAt: 9 }, messages: [reply], from: 1, beforeId: 'm1', total: 2, version: 'v2' }),
  })
  await syncDataChanges(['data/chats/c1.jsonl', 'data/chats/c1.meta.json'])
  expect(asked).toEqual(['/chats/c1?page=1&since=v1'])
  const s = useApp.getState()
  expect(s.chats[0]?.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  expect(s.chats[1]).toBe(other)
  expect(s.characters.find((c) => c.id === 'aria')?.lastChatAt).toBe(9)
})

test('the chat being generated is left to its own run', async () => {
  const chat = { ...engineChatToUI({ id: 'c1', title: 'Chat', characterId: 'aria' }, [{ id: 'm1', role: 'user', text: 'Hi', swipes: ['Hi'], swipe: 0 }]), cursor: 'v1' }
  useApp.setState({ chats: [chat], streaming: { chatId: 'c1' } as never })
  const asked = serve({})
  await syncDataChanges(['data/chats/c1.jsonl'])
  expect(asked).toEqual([])
  expect(useApp.getState().chats[0]).toBe(chat)
  useApp.setState({ streaming: null })
})

test('an edited card and a deleted lorebook are read back alone', async () => {
  const kael = cardToCharacter({ name: 'Kael' }, 'kael', 3)
  const keep = engineLorebookToUI({ name: 'Keep', entries: [] } as never, 'keep')
  useApp.setState({
    characters: [cardToCharacter({ name: 'Aria' }, 'aria', 7), kael],
    lorebooks: [engineLorebookToUI({ name: 'Old', entries: [] } as never, 'old'), keep],
  })
  const asked = serve({
    '/characters': (url) => Response.json({ characters: url.searchParams.get('ids') === 'aria' ? [{ id: 'aria', name: 'Aria Edited' }] : [] }),
  })
  await syncDataChanges(['data/characters/aria/card.json', 'data/lorebooks/old.json'])
  expect(asked.sort()).toEqual(['/characters?ids=aria', '/lorebooks/old'])
  const s = useApp.getState()
  expect(s.characters.map((c) => [c.id, c.name, c.lastChatAt])).toEqual([['aria', 'Aria Edited', 7], ['kael', 'Kael', 3]])
  expect(s.characters[1]).toBe(kael)
  expect(s.lorebooks).toEqual([keep])
})

test('a path nothing knows still reads everything', async () => {
  const asked = serve({ '/bootstrap': () => Response.json({ error: 'offline' }, { status: 503 }) })
  await syncDataChanges(['data/tools/t1.json'])
  expect(asked.some((p) => p.startsWith('/bootstrap'))).toBe(true)
})
