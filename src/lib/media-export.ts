/** Stored image references become inline bytes only at the portable export boundary. */
export async function portableMedia(value: unknown): Promise<unknown> {
  const images = new Map<string, Promise<string>>()
  const walk = async (item: unknown): Promise<unknown> => {
    if (typeof item === 'string' && /^\/v1\/apps\/[^/]+\/__media\/[a-f0-9]{64}\.(png|jpeg|webp|gif)$/.test(item)) {
      if (!images.has(item)) images.set(item, (async () => {
        const response = await fetch(item)
        if (!response.ok) throw new Error('Could not read the stored image')
        const blob = await response.blob()
        return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the stored image')); reader.readAsDataURL(blob) })
      })())
      return images.get(item)
    }
    if (Array.isArray(item)) return Promise.all(item.map(walk))
    if (!item || typeof item !== 'object') return item
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(item)) out[key] = await walk(value)
    return out
  }
  return walk(value)
}
