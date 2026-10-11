import { describe, expect, it } from 'bun:test'
import { formatModelRate } from '../src/lib/model-pricing'

describe('model price display', () => {
  it('removes floating point artifacts', () => {
    expect(formatModelRate(0.09999999999999999)).toBe('0.1')
    expect(formatModelRate(0.19999999999999998)).toBe('0.2')
    expect(formatModelRate(0.1 + 0.2)).toBe('0.3')
  })
  it('keeps free and very small rates readable', () => {
    expect(formatModelRate(0)).toBe('0')
    expect(formatModelRate(0.0000000000001)).toBe('0.0000000000001')
    expect(formatModelRate(0.0123456789)).toBe('0.0123456789')
    expect(formatModelRate(12500)).toBe('12500')
  })
})
