import type { Character } from './types'

export function calendarDay(now = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000)
}

export function dailyCharacter(characters: Character[], day: number): Character | undefined {
  const solo = characters.filter(character => !character.isGroup).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (!solo.length) return undefined
  return solo[((day % solo.length) + solo.length) % solo.length]
}
