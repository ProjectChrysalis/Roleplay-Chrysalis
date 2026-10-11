import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatSearchRevision, searchHighlight, searchTerms } from '../src/lib/chat-search'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrysalis-search-'))
  fs.mkdirSync(path.join(root, 'chats'))
  fs.mkdirSync(path.join(root, 'characters/aria'), { recursive: true })
  fs.writeFileSync(path.join(root, 'characters/aria/card.json'), JSON.stringify({ name: 'Aria' }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function chat(id: string, title: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(root, 'chats', id + '.meta.json'), JSON.stringify({ id, title, characterId: 'aria', createdAt: 1, updatedAt: 1, ...extra }))
  fs.writeFileSync(path.join(root, 'chats', id + '.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'))
}
async function search(body: Record<string, unknown>, method = 'POST') {
  const { handleRoute } = await import('../plugins/engine/plugin.js')
  return handleRoute({ method, path: '/chats/search', ...(method === 'GET' ? { query: body } : { body }) }, { fs: { list: (dir: string) => fs.readdirSync(path.join(root, dir)), read: (file: string) => fs.readFileSync(path.join(root, file), 'utf8') } }) as { status: number; json: { total: number; results: { meta: { id: string }; matchCount: number; snippets: { text: string; messageId: string }[] }[]; errors: { chatId: string }[] } }
}

describe('saved chat search', () => {
  it('finds old transcript text, with all words across messages and literal phrases', async () => {
    chat('old', 'Quiet night', [{ id: 'one', text: 'The BLUE lantern waits.' }, { id: 'two', text: 'We sail to the harbor.' }])
    chat('other', 'Blue', [{ id: 'three', text: 'Only a meadow.' }])
    const page = await search({ query: 'BLUE harbor' })
    expect(page.status).toBe(200)
    expect(page.json.total).toBe(1)
    expect(page.json.results[0]?.meta.id).toBe('old')
    expect(page.json.results[0]?.matchCount).toBe(2)
    expect(page.json.results[0]?.snippets.map((s) => s.messageId)).toEqual(['one', 'two'])
    expect((await search({ query: '"blue lantern"' })).json.total).toBe(1)
    expect((await search({ query: '"lantern harbor"' })).json.total).toBe(0)
    expect((await search({ query: '.*' })).json.total).toBe(0)
  })
  it('searches active swipes and ignores inactive alternatives and pictures', async () => {
    chat('swiped', 'Other', [{ id: 's', text: 'Old apple', swipes: ['Old apple', 'Current orange'], swipe: 1 }, { id: 'image', text: 'Hidden banana image prompt', picture: true }])
    expect((await search({ query: 'apple', mode: 'messages' })).json.total).toBe(0)
    expect((await search({ query: 'orange', mode: 'messages' })).json.total).toBe(1)
    expect((await search({ query: 'banana', mode: 'messages' })).json.total).toBe(0)
  })
  it('separates names and messages and applies character and folder filters', async () => {
    chat('a', 'Dock', [{ id: 'a1', text: 'Blue lantern' }], { folderId: 'work' })
    chat('b', 'Meadow', [{ id: 'b1', text: 'Blue flowers' }], { characterId: 'other', folderId: 'home' })
    expect((await search({ query: 'Aria', mode: 'messages' })).json.total).toBe(0)
    expect((await search({ query: 'Aria', mode: 'titles' })).json.total).toBe(1)
    expect((await search({ query: 'blue', mode: 'titles' })).json.total).toBe(0)
    const filtered = await search({ query: 'blue', characterId: 'aria', folderId: 'work' })
    expect(filtered.json.results.map((r) => r.meta.id)).toEqual(['a'])
  })
  it('paginates deterministic recent results with accurate totals and bounded snippets', async () => {
    for (let i = 0; i < 5; i++) chat('c' + i, 'Shared', Array.from({ length: 8 }, (_, n) => ({ id: 'm' + n, text: 'Needle '.repeat(100) })), { updatedAt: i + 1 })
    const page = await search({ query: 'needle', offset: 2, limit: 2 })
    expect(page.json.total).toBe(5)
    expect(page.json.results.map((r) => r.meta.id)).toEqual(['c2', 'c1'])
    expect(page.json.results[0]?.matchCount).toBe(8)
    expect(page.json.results[0]?.snippets).toHaveLength(3)
    expect(page.json.results[0]?.snippets.every((s) => s.text.length <= 242)).toBe(true)
  })
  it('reports missing and corrupt data while searching readable messages', async () => {
    chat('broken', 'Broken', [{ id: 'one', text: 'Needle survives' }])
    fs.appendFileSync(path.join(root, 'chats/broken.jsonl'), '\ninvalid\ninvalid\n')
    chat('missing', 'Missing', [])
    fs.rmSync(path.join(root, 'chats/missing.jsonl'))
    fs.writeFileSync(path.join(root, 'chats/meta.meta.json'), 'invalid')
    const page = await search({ query: 'needle' })
    expect(page.json.total).toBe(1)
    expect(page.json.errors.map((e) => e.chatId).sort()).toEqual(['broken', 'meta', 'missing'])
  })
  it('keeps different group names separate and allows group filters', async () => {
    fs.mkdirSync(path.join(root, 'groups'))
    fs.writeFileSync(path.join(root, 'groups/g1.json'), JSON.stringify({ name: 'Harbor group' }))
    fs.writeFileSync(path.join(root, 'groups/g2.json'), JSON.stringify({ name: 'Meadow group' }))
    chat('gchat1', 'First', [{ id: 'one', text: 'Needle' }], { characterId: null, groupId: 'g1' })
    chat('gchat2', 'Second', [{ id: 'two', text: 'Needle' }], { characterId: null, groupId: 'g2' })
    expect((await search({ query: 'harbor' })).json.results.map((r) => r.meta.id)).toEqual(['gchat1'])
    expect((await search({ query: 'needle', characterId: 'g2' })).json.results.map((r) => r.meta.id)).toEqual(['gchat2'])
  })
  it('rejects empty, oversized and invalid-mode queries', async () => {
    for (const body of [{ query: '' }, { query: '" "' }, { query: 'a'.repeat(201) }, { query: 'word', mode: 'regex' }]) expect((await search(body)).status).toBe(400)
  })
})

it('highlights quoted phrases and overlapping literal terms without losing text', () => {
  expect(searchTerms('"Blue lantern" BLUE')).toEqual(['blue lantern', 'blue'])
  const parts = searchHighlight('A BLUE lantern waits.', '"blue lantern" blue')
  expect(parts.map((p) => p.text).join('')).toBe('A BLUE lantern waits.')
  expect(parts.filter((p) => p.matched).map((p) => p.text).join('')).toBe('BLUE lantern')
})

it('searches through a read-only GET with encoded filter and paging values', async () => {
  chat('a', 'Selene', [{ id: 'one', text: 'A silver moon' }], { folderId: 'work' })
  chat('b', 'Selene', [{ id: 'two', text: 'Another moon' }], { folderId: 'home' })
  const options = { query: 'Selene', mode: 'all', folderId: 'work', characterId: 'aria', offset: '0', limit: '30' }
  const page = await search(options, 'GET')
  expect(page.json.results.map((hit) => hit.meta.id)).toEqual(['a'])
  expect(page).toEqual(await search(options))
  expect((await search({ query: '' }, 'GET')).status).toBe(400)
})

it('keeps search stable across hydration and invalidates saved text, filters and names', () => {
  const chats = [{ id: 'one', characterId: 'aria', title: 'Selene', folderId: null,
    updatedAt: 1, messageCount: 1, preview: 'Moon',
    messages: [{ id: 'm1', role: 'char', activeSwipe: 0, swipes: [{ content: 'Moon' }] }],
  }] as Parameters<typeof chatSearchRevision>[0]
  const characters = [{ id: 'aria', name: 'Aria' }]
  const revision = chatSearchRevision(chats, characters)
  const hydrated = JSON.parse(JSON.stringify(chats)) as typeof chats
  expect(hydrated).not.toBe(chats)
  expect(chatSearchRevision(hydrated, [...characters])).toBe(revision)
  for (const patch of [{ title: 'Other' }, { folderId: 'work' }, { updatedAt: 2 }, { messageCount: 2 }, { preview: 'Sun' }]) {
    expect(chatSearchRevision([{ ...hydrated[0]!, ...patch }], characters)).not.toBe(revision)
  }
  hydrated[0]!.messages[0]!.swipes[0]!.content = 'Sun'
  expect(chatSearchRevision(hydrated, characters)).not.toBe(revision)
  expect(chatSearchRevision(chats, [{ id: 'aria', name: 'Selene' }])).not.toBe(revision)
  expect(chatSearchRevision([], characters)).not.toBe(revision)
})
