import { describe, expect, it } from 'bun:test'
import { calendarDay, dailyCharacter } from '../src/lib/daily-character'
import type { Character } from '../src/lib/types'

const characters = Array.from({ length: 60 }, (_, i) => ({ id: String(i).padStart(2, '0'), isGroup: false }) as Character)
describe('daily character', () => {
  it('rotates through the entire library across month and year boundaries', () => {
    const start = calendarDay(new Date(2026, 11, 15))
    expect(new Set(Array.from({ length: 60 }, (_, i) => dailyCharacter(characters, start + i)?.id)).size).toBe(60)
    expect(calendarDay(new Date(2027, 0, 1)) - calendarDay(new Date(2026, 11, 31))).toBe(1)
  })
  it('is stable across library ordering and excludes groups', () => {
    const day = calendarDay(new Date(2026, 9, 10))
    expect(dailyCharacter([...characters].reverse(), day)?.id).toBe(dailyCharacter(characters, day)?.id)
    expect(dailyCharacter([{ id: 'group', isGroup: true } as Character], day)).toBeUndefined()
    expect(dailyCharacter([], day)).toBeUndefined()
  })
})
