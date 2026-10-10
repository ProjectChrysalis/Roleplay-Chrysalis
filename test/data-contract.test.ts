import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

test('every agent guide and template can arrive through older engine updates', () => {
  const data = path.resolve(import.meta.dir, '../data')
  const catalog = JSON.parse(fs.readFileSync(path.join(data, '_catalog.json'), 'utf8')) as {
    guide: string; entities: Record<string, { template?: string }>;
  }
  expect(path.basename(catalog.guide).startsWith('_')).toBe(true)
  expect(fs.existsSync(path.join(data, catalog.guide))).toBe(true)
  for (const [kind, entity] of Object.entries(catalog.entities)) {
    if (!entity.template) { expect(kind).toBe('chat'); continue }
    expect(path.basename(entity.template).startsWith('_')).toBe(true)
    const record = JSON.parse(fs.readFileSync(path.join(data, entity.template), 'utf8'))
    if (kind === 'preset') {
      expect(record.id).toBe(record.studio.id)
      expect(record.name).toBe(record.studio.name)
      expect(record.studio.readOnly).toBe(false)
      expect(record.studio.isDefault).toBe(false)
      expect(record.prompt_order[0].order.map((entry: { identifier: string }) => entry.identifier)).toEqual(record.studio.sections.map((entry: { id: string }) => entry.id))
    }
  }
})
