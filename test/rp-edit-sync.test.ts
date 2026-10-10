import { afterAll, afterEach, expect, test } from 'bun:test'

const descriptors = new Map(['location', 'window', 'localStorage', 'WebSocket'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
const previousBase = process.env.BASE_URL
process.env.BASE_URL = '/app/admin/roleplay/'
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/admin/roleplay/', protocol: 'http:', host: 'localhost' } })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: globalThis.localStorage, matchMedia: () => ({ matches: false }) } })
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class { close() {} } })
const { useApp } = await import('../src/lib/store')
const { cardToCharacter, characterToCard, enginePersonaToUI, enginePresetToUI, presetToEngine } = await import('../src/lib/engine')
const { buildDefaultPreset, defaultSettings } = await import('../src/lib/seed')
const { saves } = await import('../src/lib/save-queue')
const { engineMessageToUI, engineChatToUI } = await import('../src/lib/engine')
useApp.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const originalFetch = globalThis.fetch
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('swipe thinking and time override stale message metadata, including an empty thought', async () => {
  const stored = { id: 'thinking-reply', name: 'Test', charId: 'test', role: 'char' as const, at: 1,
    text: 'Second reply', swipes: ['First reply', 'Second reply', 'No thought'], swipe: 1,
    extra: { reasoning: 'First plan', reasoningMs: 11000, swipeMeta: [
      { reasoning: 'First plan', reasoningMs: 11000 }, { reasoning: 'Second plan', reasoningMs: 22000 }, {},
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
