import { toast as sonner } from 'sonner'

export const NOTIFICATION_TYPES = [
  ['success', 'Successes'],
  ['info', 'Tips and information'],
  ['loading', 'Progress'],
  ['warning', 'Warnings'],
  ['error', 'Errors'],
] as const

export const NOTIFICATION_AREAS = [
  ['chat', 'Chats and messages'],
  ['characters', 'Characters'],
  ['personas', 'Personas'],
  ['presets', 'Presets and samplers'],
  ['lorebooks', 'Lorebooks'],
  ['shortcuts', 'Shortcuts and commands'],
  ['regex', 'Regex scripts'],
  ['imports', 'Imports, exports and backups'],
  ['memory', 'Summaries and memory'],
  ['images', 'Image generation'],
  ['speech', 'Text to speech'],
  ['translation', 'Translation'],
  ['databank', 'Data bank'],
  ['connections', 'Models and connections'],
  ['plugins', 'Plugins and MCP'],
  ['appearance', 'Themes and backgrounds'],
  ['settings', 'Settings and sync'],
] as const

export type NotificationType = typeof NOTIFICATION_TYPES[number][0]
export type NotificationArea = typeof NOTIFICATION_AREAS[number][0]
export type NotificationSettings = Record<'enabled' | NotificationType | NotificationArea, boolean>

export function defaultNotifications(): NotificationSettings {
  return Object.fromEntries([
    ['enabled', true],
    ...NOTIFICATION_TYPES.map(([key]) => [key, true]),
    ...NOTIFICATION_AREAS.map(([key]) => [key, true]),
  ]) as NotificationSettings
}

let readSettings: () => Partial<NotificationSettings> | undefined = () => undefined
let mutedId = 0

export function configureNotifications(reader: typeof readSettings) {
  readSettings = reader
}

export function notificationAllowed(settings: Partial<NotificationSettings> | undefined, area: NotificationArea, type: NotificationType) {
  return settings?.enabled !== false && settings?.[area] !== false && settings?.[type] !== false
}

export function createToast(area: NotificationArea) {
  const emit = (type: NotificationType, args: Parameters<typeof sonner>) => {
    if (!notificationAllowed(readSettings(), area, type)) {
      // A muted completion must still remove its earlier progress popup.
      if (args[1]?.id !== undefined) sonner.dismiss(args[1].id)
      return args[1]?.id ?? `muted-notification-${++mutedId}`
    }
    return sonner[type](...args)
  }
  return Object.assign(
    (...args: Parameters<typeof sonner>) => emit('info', args),
    {
      success: (...args: Parameters<typeof sonner.success>) => emit('success', args),
      info: (...args: Parameters<typeof sonner.info>) => emit('info', args),
      loading: (...args: Parameters<typeof sonner.loading>) => emit('loading', args),
      warning: (...args: Parameters<typeof sonner.warning>) => emit('warning', args),
      error: (...args: Parameters<typeof sonner.error>) => emit('error', args),
      dismiss: sonner.dismiss,
    },
  )
}
