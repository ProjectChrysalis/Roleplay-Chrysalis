export type LibraryScope = 'presets' | 'lorebooks'
export type LibraryOrder = Partial<Record<LibraryScope, string[]>>

/** The saved manual order of one collection, or none. */
export function libraryOrder(value: unknown, scope: LibraryScope): string[] {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>)[scope] : null
  return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
}

/** Items in their saved order. Ones the order has never seen keep their own
 *  sequence and follow the rest. */
export function sortByOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (!order.length) return items
  const rank = new Map(order.map((id, index) => [id, index]))
  return items
    .map((item, index) => ({ item, key: rank.get(item.id) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.item)
}

/** `ids` with `id` taken out and put back in front of `beforeId`, or behind
 *  `afterId` when there is nothing to sit in front of, or last. */
export function placeInOrder(ids: string[], id: string, beforeId: string | null, afterId: string | null = null): string[] {
  const next = ids.filter((other) => other !== id)
  const before = beforeId ? next.indexOf(beforeId) : -1
  const after = afterId ? next.indexOf(afterId) : -1
  next.splice(before >= 0 ? before : after >= 0 ? after + 1 : next.length, 0, id)
  return next
}
