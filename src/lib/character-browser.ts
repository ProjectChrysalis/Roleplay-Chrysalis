import type { Character, Chat } from './types'
import { estimateTokens } from './tokens'

export const CHARACTER_SORTS = ['az', 'newest', 'oldest', 'imported', 'favorites', 'recent', 'chats', 'tokens', 'random'] as const
export type CharacterSort = (typeof CHARACTER_SORTS)[number]

export function characterBrowser(value: unknown): { grid: boolean; sort: CharacterSort } {
  const saved = value && typeof value === 'object' ? value as { grid?: unknown; sort?: unknown } : {}
  return {
    grid: typeof saved.grid === 'boolean' ? saved.grid : true,
    sort: CHARACTER_SORTS.includes(saved.sort as CharacterSort) ? saved.sort as CharacterSort : 'recent',
  }
}

export function sortCharacters(characters: Character[], chats: Chat[], sort: CharacterSort): Character[] {
  const counts = new Map<string, number>()
  const recent = new Map<string, number>()
  for (const chat of chats) {
    counts.set(chat.characterId, (counts.get(chat.characterId) ?? 0) + 1)
    recent.set(chat.characterId, Math.max(recent.get(chat.characterId) ?? 0, chat.updatedAt))
  }
  const lastChat = (c: Character) => Math.max(c.lastChatAt, recent.get(c.id) ?? 0)
  const list = [...characters]
  if (sort === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j]!, list[i]!]
    }
    return list
  }
  return list.sort((a, b) => {
    let difference = 0
    switch (sort) {
      case 'az': return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
      case 'newest': difference = b.createdAt - a.createdAt; break
      case 'oldest': difference = (a.createdAt || Infinity) - (b.createdAt || Infinity); break
      case 'imported': difference = (b.importedAt ?? 0) - (a.importedAt ?? 0); break
      case 'favorites': difference = Number(b.favorite) - Number(a.favorite); break
      case 'recent': difference = lastChat(b) - lastChat(a); break
      case 'chats': difference = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0); break
      case 'tokens': difference = estimateTokens(b.description) - estimateTokens(a.description); break
    }
    return difference || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}
