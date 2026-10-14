import { describe, expect, it } from 'bun:test'
import { libraryOrder, placeInOrder, sortByOrder } from '../src/lib/library-order'

const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
const ids = (list: { id: string }[]) => list.map((item) => item.id)

describe('library order', () => {
  it('reads only a list of ids for the requested collection', () => {
    expect(libraryOrder({ presets: ['b', 4, 'a'], lorebooks: 'x' }, 'presets')).toEqual(['b', 'a'])
    expect(libraryOrder({ presets: ['b'], lorebooks: 'x' }, 'lorebooks')).toEqual([])
    expect(libraryOrder(null, 'presets')).toEqual([])
  })

  it('keeps the given sequence without a saved order', () => {
    expect(sortByOrder(items, [])).toBe(items)
  })

  it('puts unseen items after ordered ones and ignores ids that are gone', () => {
    expect(ids(sortByOrder(items, ['c', 'gone', 'a']))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('places an item in front of another, behind one, or last', () => {
    expect(placeInOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(placeInOrder(['a', 'b', 'c', 'd'], 'a', null, 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(placeInOrder(['a', 'b', 'c', 'd'], 'b', null)).toEqual(['a', 'c', 'd', 'b'])
    expect(placeInOrder(['a', 'b'], 'a', 'missing')).toEqual(['b', 'a'])
  })
})
