import { afterAll, afterEach, expect, test } from 'bun:test'

const descriptors = new Map(['location', 'window', 'localStorage', 'WebSocket'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const previousBase = process.env.BASE_URL
process.env.BASE_URL = '/app/admin/roleplay/'
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/admin/roleplay/', protocol: 'http:', host: 'localhost' } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false }) } })
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class { close() {} } })
const { useApp } = await import('../src/lib/store')
const { cardToCharacter, characterToCard, enginePersonaToUI, enginePresetToUI, groupToCharacter, presetToEngine } = await import('../src/lib/engine')
const { buildDefaultPreset, defaultSettings } = await import('../src/lib/seed')
const { saves } = await import('../src/lib/save-queue')
import type { RegexScript } from '../src/lib/types'
const { engineMessageToUI, engineChatToUI } = await import('../src/lib/engine')
useApp.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const originalFetch = globalThis.fetch
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('swipe thinking and time override stale message metadata, including an empty thought', async () => {
  const stored = { id: 'thinking-reply', name: 'Test', charId: 'test', role: 'char' as const, at: 1,
    text: 'Second reply', swipes: ['First reply', 'Second reply', 'No thought'], swipe: 1,
    extra: { presetName: 'Stale preset', reasoning: 'First plan', reasoningMs: 11000, swipeMeta: [
      { presetName: 'First preset', reasoning: 'First plan', reasoningMs: 11000 }, { presetName: 'Second preset', reasoning: 'Second plan', reasoningMs: 22000 }, {},
    ] },
  }
  const adapted = engineMessageToUI(stored)
  expect(adapted.swipes[1]).toMatchObject({ reasoning: 'Second plan', reasoningTime: 22 })
  expect(engineMessageToUI({ ...stored, swipe: 2 }).swipes[2]?.reasoning).toBeUndefined()
  const meta = { id: 'thinking-chat', title: 'Test', characterId: 'test' }
  useApp.setState({ chats: [engineChatToUI(meta, [stored])], streaming: null })
  globalThis.fetch = (async (_input, init) => {
    const index = JSON.parse(String(init?.body)).index as number
    return Response.json({ message: { ...stored, swipe: index, text: stored.swipes[index] }, swipe: index, count: 3 })
  }) as typeof fetch
  for (const index of [0, 1, 2, 1]) {
    useApp.getState().setSwipe(meta.id, stored.id, index)
    await pause(20)
    const message = useApp.getState().chats[0]?.messages[0]
    const chosen = message?.swipes[message.activeSwipe]
    expect(chosen?.reasoning).toBe(index === 0 ? 'First plan' : index === 1 ? 'Second plan' : undefined)
    expect(chosen?.reasoningTime).toBe(index === 0 ? 11 : index === 1 ? 22 : undefined)
    expect(chosen?.presetName).toBe(index === 0 ? 'First preset' : index === 1 ? 'Second preset' : undefined)
  }
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

test('character edits retain opaque metadata and send explicit clears', () => {
  const card = { name: 'Test', spec: 'chara_card_v3', spec_version: '3.0', character_book: { entries: [] }, optional: null,
    extensions: { custom: { all: ['retained'] } }, studio: { future: { nested: true } }, system_prompt: 'old', tags: ['old'] }
  const character = cardToCharacter(card, 'test')
  const saved = characterToCard({ ...character, name: 'Edited', systemPromptOverride: '', tags: [] })
  expect(saved).toMatchObject({ name: 'Edited', spec: 'chara_card_v3', spec_version: '3.0', character_book: card.character_book,
    optional: null, extensions: card.extensions, studio: { future: { nested: true } }, system_prompt: '', tags: [] })
})

test('persona edits retain fields the UI does not know', () => {
  const persona = enginePersonaToUI({ id: 'test', name: 'Test', future: { fields: [1, 2] } }, null)
  expect({ ...persona, description: 'Edited' }).toMatchObject({ future: { fields: [1, 2] }, description: 'Edited' })
})

test('preset edits preserve unknown fields, prompt metadata and inactive layouts', () => {
  const wire = { ...presetToEngine(buildDefaultPreset()), name: 'Test', future: { exact: null }, studio: { ...buildDefaultPreset(), future: 'studio',
    sections: [{ ...buildDefaultPreset().sections[0]!, custom: 42 }] },
    prompts: [{ identifier: 'main', name: 'Main', marker: true, role: 'system', content: 'old', custom: { keep: true } },
      { identifier: 'inactive', content: 'retain inactive' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'inactive', enabled: true }] },
      { character_id: 100001, custom: 'layout', order: [{ identifier: 'main', enabled: true, extra: 'entry' }] }],
  }
  const preset = enginePresetToUI(wire, 'test')
  preset.sections[0] = { ...preset.sections[0]!, content: 'Edited', enabled: false }
  preset.samplers.temperature.enabled = false
  const saved = presetToEngine(preset)
  expect(saved).toMatchObject({ future: { exact: null }, studio: { future: 'studio' } })
  expect(saved.studio).not.toHaveProperty('engineExtras')
  expect(saved.prompts).toContainEqual({ identifier: 'inactive', content: 'retain inactive' })
  expect(saved.prompts?.find((p) => p.identifier === 'main')).toMatchObject({ content: 'Edited', custom: { keep: true } })
  expect(saved.prompt_order?.find((o) => o.character_id === 100000)).toEqual(wire.prompt_order[0])
  expect(saved.prompt_order?.find((o) => o.character_id === 100001)).toMatchObject({ custom: 'layout', order: [{ identifier: 'main', enabled: false, extra: 'entry' }] })
  expect(saved.temperature).toBeUndefined()
  expect(enginePresetToUI(saved, 'test').sections[0]?.content).toBe('Edited')
  expect(enginePresetToUI(saved, 'test').sections[0]?.enabled).toBe(false)
})

test('refresh waits for delayed settings, card and preset writes and never flashes old values', async () => {
  let ui = defaultSettings()
  let card = characterToCard(cardToCharacter({ name: 'Before' }, 'test'))
  let preset = { ...presetToEngine({ ...buildDefaultPreset(), id: 'test', name: 'Before', readOnly: false }), id: 'test' }
  const library = { qrSets: [], themes: [], backgrounds: [], tags: [], folders: [], connectionProfiles: [] }
  let bootstrapReads = 0
  const saved: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'PUT') {
      await pause(15)
      const body = JSON.parse(String(init.body))
      if (url.endsWith('/settings')) ui = body.ui ?? ui
      if (url.endsWith('/characters/test')) card = body
      if (url.endsWith('/presets/test')) preset = body
      saved.push(url)
      return Response.json({ ok: true })
    }
    if (url.includes('/bootstrap')) {
      bootstrapReads++
      return Response.json({ settings: { model: null, personaId: null, ui }, library, characters: [{ ...card, id: 'test' }], presets: [preset],
        personas: [], groups: [], lorebooks: [], regex: [], chats: [], databank: { files: [] }, activeChat: null })
    }
    if (url.endsWith('/models')) return Response.json({ models: [] })
    if (url.endsWith('/connections')) return Response.json({ connections: [] })
    return Response.json({})
  }) as typeof fetch
  useApp.setState({ boot: 'ready', activeChatId: null, settings: ui, characters: [cardToCharacter(card, 'test')], presets: [enginePresetToUI(preset, 'test')] })
  const states: string[] = []
  const stop = useApp.subscribe((state) => states.push(JSON.stringify({ name: state.characters[0]?.name, preset: state.presets[0]?.name, toggle: state.settings.showTimestamps })))
  useApp.getState().updateCharacter('test', { name: 'Newest card' })
  useApp.getState().updatePreset('test', { name: 'Newest preset' })
  useApp.getState().updateSettings({ showTimestamps: false })
  const from = states.length
  const hydrate = useApp.getState().hydrate()
  await pause(20)
  expect(bootstrapReads).toBe(0)
  expect(useApp.getState().characters[0]?.name).toBe('Newest card')
  await hydrate
  stop()
  expect(bootstrapReads).toBe(1)
  expect(saved).toHaveLength(3)
  expect(useApp.getState().bootError).toBeNull()
  expect(useApp.getState().characters[0]?.name).toBe('Newest card')
  expect(useApp.getState().presets[0]?.name).toBe('Newest preset')
  expect(useApp.getState().settings.showTimestamps).toBe(false)
  for (const state of states.slice(from)) expect(JSON.parse(state)).toEqual({ name: 'Newest card', preset: 'Newest preset', toggle: false })
})

test('agent-authored generation controls survive a UI round trip', () => {
  const wire = { name: 'Controls', reasoning: 'medium', reasoningTags: { open: '<think>', close: '</think>' }, thinkingBudget: 1234,
    prompts: [{ identifier: 'custom', content: 'Only swipes', injection_position: 1, injection_depth: 2, injection_trigger: ['swipe'] }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'custom', enabled: true }] }] }
  const ui = enginePresetToUI(wire, 'controls')
  expect(ui.sections[0]).toMatchObject({ position: 'in-chat', depth: 2, injectionTriggers: ['swipe'] })
  const saved = presetToEngine(ui)
  expect(saved).toMatchObject({ reasoning: 'medium', reasoningTags: wire.reasoningTags, thinkingBudget: 1234 })
  expect(saved.prompts?.[0]).toMatchObject({ injection_position: 'absolute', injection_depth: 2, injection_trigger: ['swipe'] })
})

test('editing the first fallback layout does not switch to a different layout', () => {
  const wire = { name: 'Layouts', prompts: [{ identifier: 'first', content: 'first' }, { identifier: 'second', content: 'second' }],
    prompt_order: [{ character_id: 7, order: [{ identifier: 'first', enabled: true }] }, { character_id: 8, order: [{ identifier: 'second', enabled: true }] }] }
  const ui = enginePresetToUI(wire, 'layouts')
  ui.sections[0]!.content = 'edited'
  const saved = presetToEngine(ui)
  expect(saved.prompt_order?.map((layout) => layout.character_id)).toEqual([7, 8])
  expect(enginePresetToUI(saved, 'layouts').sections[0]).toMatchObject({ id: 'first', content: 'edited' })
})

test('a snapshot read before an edit cannot overwrite that edit when it arrives late', async () => {
  let ui = defaultSettings()
  let card = characterToCard(cardToCharacter({ name: 'Before' }, 'test'))
  const preset = { ...presetToEngine({ ...buildDefaultPreset(), id: 'test', readOnly: false }), id: 'test' }
  const library = { qrSets: [], themes: [], backgrounds: [], tags: [], folders: [], connectionProfiles: [] }
  let first = true
  let deliver!: () => void
  let started!: () => void
  const reading = new Promise<void>((resolve) => { started = resolve })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      if (url.endsWith('/settings')) ui = body.ui ?? ui
      if (url.endsWith('/characters/test')) card = body
      return Response.json({ ok: true })
    }
    if (url.includes('/bootstrap')) {
      const snapshot = Response.json({ settings: { model: null, personaId: null, ui }, library, characters: [{ ...card, id: 'test' }], presets: [preset],
        personas: [], groups: [], lorebooks: [], regex: [], chats: [], databank: { files: [] }, activeChat: null })
      if (first) {
        first = false
        return new Promise<Response>((resolve) => { deliver = () => resolve(snapshot); started() })
      }
      return snapshot
    }
    return Response.json(url.endsWith('/models') ? { models: [] } : { connections: [] })
  }) as typeof fetch
  useApp.setState({ boot: 'ready', activeChatId: null, settings: ui, characters: [cardToCharacter(card, 'test')], presets: [enginePresetToUI(preset, 'test')] })
  const hydrate = useApp.getState().hydrate()
  await reading
  useApp.getState().updateCharacter('test', { name: 'Latest' })
  useApp.getState().updateSettings({ showTimestamps: false })
  deliver()
  await hydrate
  expect(useApp.getState().characters[0]?.name).toBe('Latest')
  expect(useApp.getState().settings.showTimestamps).toBe(false)
  await saves.settled()
  await useApp.getState().hydrate()
  expect(useApp.getState().characters[0]?.name).toBe('Latest')
  expect(useApp.getState().settings.showTimestamps).toBe(false)
})

test('a chat reads its summaries as parts, and an edit sends the parts instead of the flat text', async () => {
  const { chatPatchOf } = await import('../src/lib/engine')
  const base = { id: 'sum-chat', title: 'Test', characterId: 'test' }
  const parts = [{ id: 'a', text: 'They met.', from: null, to: 'm4' }, { id: 'b', text: 'They argued.', from: 'm4', to: 'm9' }]
  expect(engineChatToUI({ ...base, summary: 'They met.\n\nThey argued.', summaryParts: parts }, []).summaryParts).toEqual(parts)
  // a chat from before parts, or one whose summary was rewritten on disk: one part
  expect(engineChatToUI({ ...base, summary: 'Old running summary.' }, []).summaryParts).toEqual([{ id: 's0', text: 'Old running summary.' }])
  expect(engineChatToUI({ ...base, summary: 'Rewritten by hand.', summaryParts: parts }, []).summaryParts).toEqual([{ id: 's0', text: 'Rewritten by hand.' }])
  expect(engineChatToUI(base, []).summaryParts).toEqual([])
  expect(chatPatchOf({ summaryParts: [{ ...parts[0]!, text: 'They met at the bar.' }, parts[1]!], summary: 'ignored' }))
    .toEqual({ summaryParts: [{ id: 'a', text: 'They met at the bar.' }, { id: 'b', text: 'They argued.' }] })
  expect(chatPatchOf({ summary: 'typed with no parts yet' })).toEqual({ summary: 'typed with no parts yet' })
})

test('saving a scene writes the whole lorebook once, then binds it to the chat', async () => {
  const meta = { id: 'scene-chat', title: 'Harbor night', characterId: 'test' }
  useApp.setState({ chats: [engineChatToUI(meta, [])], lorebooks: [] })
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ method: String(init?.method), url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({ ok: true })
  }) as typeof fetch
  const entry = { title: 'The compass', keys: ['compass', 'brass'], content: 'The traveler gave Aria a brass compass.' }
  const bookId = await useApp.getState().saveSceneEntry(meta.id, entry, null)
  // a new book named after the chat, already holding the entry when it is first stored
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PATCH'])
  expect(calls[0]!.url).toContain(`/lorebooks/${bookId}`)
  expect(calls[1]!.body).toEqual({ chatLorebookIds: [bookId] })
  const book = useApp.getState().lorebooks.find((b) => b.id === bookId)!
  expect(book.name).toBe('Harbor night scenes')
  expect(book.entries[0]).toMatchObject({ ...entry, status: 'normal', enabled: true })
  expect(useApp.getState().chats[0]!.chatLorebookIds).toEqual([bookId])
  // a second scene goes into the same book, on top, with no second binding
  calls.length = 0
  await useApp.getState().saveSceneEntry(meta.id, { ...entry, title: 'The storm' }, bookId)
  expect(calls.map((c) => c.method)).toEqual(['PUT'])
  expect(useApp.getState().lorebooks.find((b) => b.id === bookId)!.entries.map((e) => e.title)).toEqual(['The storm', 'The compass'])
  await expect(useApp.getState().saveSceneEntry(meta.id, entry, 'missing-book')).rejects.toThrow('Lorebook not found')
})

test('a preset saved without its studio sections is completed once, under its own id', async () => {
  const full = { ...presetToEngine({ ...buildDefaultPreset(), id: 'alpha', name: 'Alpha', readOnly: false }), id: 'alpha' }
  const stored = new Map<string, Record<string, unknown>>([
    // newest first on disk, so the boot order differs from the sorted list
    ['zeta', { id: 'zeta', name: 'Zeta', temperature: 0.7, studio: { folderId: 'fold_a' } }],
    ['alpha', full],
  ])
  const puts: string[] = []
  const library = { qrSets: [], themes: [], backgrounds: [], tags: [], folders: [{ id: 'fold_a', name: 'Imported', scope: 'presets' }], connectionProfiles: [] }
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === 'PUT') {
      const id = url.split('/presets/')[1]
      if (id) { puts.push(id); stored.set(id, JSON.parse(String(init.body))) }
      return Response.json({ ok: true })
    }
    if (url.includes('/bootstrap')) {
      return Response.json({ settings: { model: null, personaId: null, ui: defaultSettings() }, library, characters: [], presets: [...stored.values()],
        personas: [], groups: [], lorebooks: [], regex: [], chats: [], databank: { files: [] }, activeChat: null })
    }
    return Response.json(url.endsWith('/models') ? { models: [] } : { connections: [] })
  }) as typeof fetch
  useApp.setState({ boot: 'ready', activeChatId: null, characters: [], presets: [] })
  await useApp.getState().hydrate()
  await saves.settled()
  expect(puts).toEqual(['zeta'])
  expect((stored.get('zeta') as { studio?: { sections?: unknown[]; folderId?: string } }).studio).toMatchObject({ folderId: 'fold_a', sections: expect.any(Array) })
  expect(stored.get('alpha')).toBe(full)
  // the saved shape is complete: reading it back writes nothing
  await useApp.getState().hydrate()
  await saves.settled()
  expect(puts).toEqual(['zeta'])
})

test('duplicating a preset copies its own regex scripts onto the copy', async () => {
  const preset = { ...buildDefaultPreset(), id: 'source', name: 'Source', readOnly: false, isDefault: false }
  const script: RegexScript = { id: 'rx_one', name: 'Tidy', scope: 'preset', scopeTargetId: 'source', find: 'a', replace: 'b', flags: 'g',
    placements: { userInput: false, aiOutput: true, slash: false, wi: false, reasoning: false }, markdownOnly: true, promptOnly: false,
    minDepth: null, maxDepth: null, trimStrings: [], runOnEdit: true, macroMode: 'none', enabled: true, order: 0 }
  const global: RegexScript = { ...script, id: 'rx_global', scope: 'global', scopeTargetId: null }
  useApp.setState({ presets: [preset], regexScripts: [script, global] })
  const puts: string[] = []
  globalThis.fetch = (async (input, init) => { if (init?.method === 'PUT') puts.push(new URL(String(input), 'http://x').pathname); return Response.json({ ok: true }) }) as typeof fetch
  const copyId = useApp.getState().duplicatePreset('source')
  await saves.settled()
  const copied = useApp.getState().regexScripts.filter((r) => r.scopeTargetId === copyId)
  expect(copied).toHaveLength(1)
  expect(copied[0]).toMatchObject({ name: 'Tidy', find: 'a', enabled: true })
  expect(copied[0]?.id).not.toBe('rx_one')
  expect(useApp.getState().regexScripts).toHaveLength(3)
  expect(puts.some((p) => p.endsWith(`/regex/${copied[0]?.id}`))).toBe(true)
})

test('a group names only its own members, whatever list it is built from', () => {
  const library = ['Ann', 'Bo', 'Cy', 'Di'].map((name) => cardToCharacter({ name }, name.toLowerCase()))
  const group = groupToCharacter({ id: 'g', name: 'Party', memberIds: ['cy', 'ann'] }, library)
  expect(group.description).toBe('Group chat with Cy, Ann.')
  expect(group.firstMessage).toBe('*Cy, Ann are here.*')
  expect(group.avatar).toBe(library[2]?.avatar)
})
