import { expect, test } from 'bun:test'
import { characterBrowser, sortCharacters } from '../src/lib/character-browser'
import type { Character, Chat } from '../src/lib/types'

const card = (id: string, patch: Partial<Character> = {}) => ({ id, name: id, createdAt: 0, lastChatAt: 0, favorite: false, description: '', ...patch }) as Character

test('saved browser choices survive serialization and invalid choices use defaults', () => {
  const saved = { grid: false, sort: 'imported' }
  expect(characterBrowser(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  expect(characterBrowser({ grid: 'false', sort: 'invalid' })).toEqual({ grid: true, sort: 'recent' })
})
test('import order uses local import time, independently of source creation time', () => {
  const cards = [card('old-import', { createdAt: 900, importedAt: 100 }), card('new-import', { createdAt: 50, importedAt: 500 }), card('undated')]
  expect(sortCharacters(cards, [], 'imported').map((c) => c.id)).toEqual(['new-import', 'old-import', 'undated'])
  expect(sortCharacters(cards, [], 'newest').map((c) => c.id)).toEqual(['old-import', 'new-import', 'undated'])
  expect(sortCharacters(cards, [], 'oldest').map((c) => c.id)).toEqual(['new-import', 'old-import', 'undated'])
})
test('recent chats use actual chat activity even when the card timestamp is zero', () => {
  const cards = [card('a', { lastChatAt: 10 }), card('b')]
  const chats = [{ characterId: 'b', updatedAt: 200 }, { characterId: 'a', updatedAt: 5 }] as Chat[]
  expect(sortCharacters(cards, chats, 'recent').map((c) => c.id)).toEqual(['b', 'a'])
  expect(cards.map((c) => c.id)).toEqual(['a', 'b'])
})
test('ties are deterministic and random retains every character', () => {
  const cards = [card('c'), card('a'), card('b')]
  expect(sortCharacters(cards, [], 'favorites').map((c) => c.id)).toEqual(['a', 'b', 'c'])
  expect(sortCharacters(cards, [], 'random').map((c) => c.id).sort()).toEqual(['a', 'b', 'c'])
})
