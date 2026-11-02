import { expect, test } from 'bun:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { buildPortableArchive } from '../src/lib/portable-archive'

test('converts a backup into portable files with matching names and chat headers', async () => {
  const encode = (x: unknown) => strToU8(JSON.stringify(x))
  const backup = zipSync({
    'characters/aria.json': encode({ name: 'Aria', description: 'Hello', avatar: 'data:image/png;base64,AA==', _lorebookNames: { linked: ['A world'] } }),
    'worlds/a-world.json': encode({ name: 'A world', entries: { 0: { content: 'Lore' } } }),
    'chats/aria/chat.jsonl': strToU8('{"name":"Aria","mes":"Hello"}\n'),
    'chats/aria/chat.meta.json': encode({ characterId: 'aria' }),
    'chats/group/chat.jsonl': strToU8('{"mes":"Group"}\n'),
    'chats/group/chat.meta.json': encode({ groupId: 'group' }),
    'User Settings/openai_settings.json': encode({ 'One': { temperature: 1, prompts: [{ injection_position: 'absolute', injection_depth: 3 }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }] }, 'one': { temperature: 2 } }),
    'settings.json': encode({ private: true }),
  })
  let card: any
  const result = unzipSync(await buildPortableArchive(backup, async (_avatar, data) => { card = data; return new Uint8Array([1, 2, 3]) }))
  expect(card.data).toMatchObject({ name: 'Aria', description: 'Hello', extensions: { world: 'a-world' } })
  expect(result['characters/aria.png']).toEqual(new Uint8Array([1, 2, 3]))
  const lines = strFromU8(result['chats/aria/chat.jsonl']!).trim().split('\n').map(JSON.parse)
  expect(lines).toEqual([{ user_name: 'unused', character_name: 'unused', chat_metadata: {} }, { name: 'Aria', mes: 'Hello' }])
  expect(result['chats/group/chat.jsonl']).toBeUndefined()
  expect(result['settings.json']).toBeUndefined()
  expect(JSON.parse(strFromU8(result['OpenAI Settings/One.json']!))).toEqual({ temperature: 1, prompts: [{ injection_position: 1, injection_depth: 3 }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] })
  expect(JSON.parse(strFromU8(result['OpenAI Settings/one (2).json']!))).toEqual({ temperature: 2 })
  expect(JSON.parse(strFromU8(result['worlds/a-world.json']!)).entries[0].content).toBe('Lore')
})

test('writes an actual PNG card with readable UTF-8 metadata', async () => {
  const { extractCharaFromPng } = await import('../src/lib/import-shapes')
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGPUMLJhgAEmOAsvBwAePACeVGOb9QAAAABJRU5ErkJggg=='
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    width = 1; height = 1; onload: (() => void) | null = null
    set src(_value: string) { this.onload?.() }
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => png }),
  } })
  try {
    const backup = zipSync({ 'characters/cafe.json': strToU8(JSON.stringify({ name: 'Café', description: '雪', avatar: png })) })
    const files = unzipSync(await buildPortableArchive(backup))
    const card = await extractCharaFromPng(new File([files['characters/cafe.png']!], 'cafe.png'))
    expect(card).toMatchObject({ spec: 'chara_card_v2', data: { name: 'Café', description: '雪' } })
  } finally {
    if (imageDescriptor) Object.defineProperty(globalThis, 'Image', imageDescriptor)
    else Reflect.deleteProperty(globalThis, 'Image')
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('uses the current default avatar for older saved paths', async () => {
  const backup = zipSync({ 'characters/older.json': strToU8(JSON.stringify({ name: 'Older', avatar: '/app/roleplay/avatar-default.png' })) })
  let avatar = ''
  await buildPortableArchive(backup, async (src) => { avatar = src; return new Uint8Array([1]) })
  expect(avatar).toEndWith('avatar-default.png')
  expect(avatar).not.toBe('/app/roleplay/avatar-default.png')
})
