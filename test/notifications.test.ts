import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { toast as sonner } from 'sonner'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configureNotifications, createToast, defaultNotifications, notificationAllowed, NOTIFICATION_AREAS, NOTIFICATION_TYPES, type NotificationSettings } from '../src/lib/notifications'

const originalRequestFrame = globalThis.requestAnimationFrame
const originalCancelFrame = globalThis.cancelAnimationFrame
beforeAll(() => {
  globalThis.requestAnimationFrame = (callback) => Number(setTimeout(() => callback(performance.now()), 0))
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
})
afterAll(() => {
  if (originalRequestFrame) globalThis.requestAnimationFrame = originalRequestFrame
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  if (originalCancelFrame) globalThis.cancelAnimationFrame = originalCancelFrame
  else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
})

const active = (id: string | number) => sonner.getToasts().find((t) => t.id === id)

afterEach(() => {
  sonner.dismiss()
  configureNotifications(() => undefined)
})

test('older and partial preferences keep unspecified notifications enabled', () => {
  for (const [area] of NOTIFICATION_AREAS) {
    for (const [type] of NOTIFICATION_TYPES) {
      expect(notificationAllowed(undefined, area, type)).toBe(true)
      expect(notificationAllowed(defaultNotifications(), area, type)).toBe(true)
    }
  }
  expect(notificationAllowed({ success: false }, 'chat', 'success')).toBe(false)
  expect(notificationAllowed({ success: false }, 'chat', 'error')).toBe(true)
})

test('types, areas and master switch filter producers using the latest preferences', () => {
  let settings: Partial<NotificationSettings> = { success: false }
  configureNotifications(() => settings)
  const chat = createToast('chat')
  const memory = createToast('memory')
  expect(active(chat.success('Saved'))).toBeUndefined()
  expect(active(chat.error('Save failed'))).toMatchObject({ type: 'error' })
  settings = { memory: false }
  expect(active(memory.error('Compaction failed'))).toBeUndefined()
  expect(active(chat.success('Saved'))).toMatchObject({ type: 'success' })
  settings = { enabled: false }
  expect(active(chat.error('Save failed'))).toBeUndefined()
  expect(active(chat('Tip'))).toBeUndefined()
  settings = {}
  expect(active(chat('Tip'))).toMatchObject({ type: 'info' })
})

test('muted progress can become a visible error with the same id and retry action', () => {
  configureNotifications(() => ({ loading: false }))
  const toast = createToast('imports')
  const id = toast.loading('Importing')
  expect(active(id)).toBeUndefined()
  const action = { label: 'Retry', onClick: () => {} }
  expect(toast.error('Import failed', { id, description: 'Invalid archive', action })).toBe(id)
  expect(active(id)).toMatchObject({ type: 'error', description: 'Invalid archive', action })
  toast.dismiss(id)
  expect(active(id)).toBeUndefined()
})

test('muted completions clear visible progress instead of leaving a spinner', () => {
  let settings: Partial<NotificationSettings> = { success: false }
  configureNotifications(() => settings)
  const toast = createToast('images')
  const id = toast.loading('Drawing')
  expect(active(id)).toMatchObject({ type: 'loading' })
  toast.success('Done', { id })
  expect(active(id)).toBeUndefined()
  const next = toast.loading('Drawing')
  settings = { enabled: false }
  toast.error('Drawing failed', { id: next })
  expect(active(next)).toBeUndefined()
})

test('every app popup producer goes through notification preferences', () => {
  const root = join(import.meta.dir, '../src')
  function check(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) check(path)
      else if (/\.tsx?$/.test(entry.name) && entry.name !== 'notifications.ts') {
        const source = readFileSync(path, 'utf8')
        expect(source).not.toMatch(/import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*['"]sonner['"]/)
      }
    }
  }
  check(root)
})
