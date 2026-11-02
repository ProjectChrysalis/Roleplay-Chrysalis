import { afterAll, expect, test } from 'bun:test'
import { exportLorebook } from '../src/lib/lorebook-export'
import { newLorebook, newLoreEntry } from '../src/lib/seed'
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/app/admin/roleplay/', protocol: 'http:', host: 'localhost' } })
const { engineLorebookToUI, importLorebookFiles } = await import('../src/lib/engine')
afterAll(() => {
  if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor)
  else Reflect.deleteProperty(globalThis, 'location')
})

test('exports world-info entries and restores app settings and empty entries', async () => {
  const book = newLorebook('original', 'Moon & stars')
  book.globalActive = true
  book.settings.scanDepth = 9
  book.entries = [{ ...newLoreEntry(), title: 'Moon', memo: 'Memo', content: '', keys: ['moon'], secondaryKeys: ['night'], logic: 'NOT_ALL', status: 'vectorized', useProbability: false, probability: 23, scanDepthOverride: 7, wholeWordsOverride: false }]
  const exported = exportLorebook(book)
  expect(exported.entries[0]).toMatchObject({ key: ['moon'], keysecondary: ['night'], selectiveLogic: 1, vectorized: true, content: '' })
  const originalFetch = globalThis.fetch
  let saved: any
  globalThis.fetch = (async (_input, init) => { saved = JSON.parse(String(init?.body)); return Response.json({}) }) as typeof fetch
  try {
    const errors: string[] = []
    const ids = await importLorebookFiles([new File([JSON.stringify(exported)], 'Moon.json')], (error) => errors.push(error))
    expect(errors).toEqual([])
    expect(ids).toHaveLength(1)
    const restored = engineLorebookToUI(saved, ids[0]!)
    expect(restored).toMatchObject({ name: book.name, globalActive: true, settings: book.settings })
    expect(restored.entries[0]).toMatchObject({ title: 'Moon', memo: 'Memo', content: '', logic: 'NOT_ALL', status: 'vectorized', useProbability: false, probability: 23, scanDepthOverride: 7, wholeWordsOverride: false })
    expect(exportLorebook(newLorebook('empty', 'Empty')).entries).toEqual({})
  } finally { globalThis.fetch = originalFetch }
})
