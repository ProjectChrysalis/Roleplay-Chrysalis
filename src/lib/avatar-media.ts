/** Detached image preloaders cannot authenticate stored media URLs. Resolve
 * them through fetch before handing them to an image component. */
export function createAvatarMediaResolver(
  request: typeof fetch = (url, init) => globalThis.fetch(url, init),
  objectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
) {
  const jobs = new Map<string, Promise<string>>()
  return (src: string): Promise<string> => {
    if (!src.startsWith('/v1/')) return Promise.resolve(src)
    const existing = jobs.get(src)
    if (existing) return existing
    const job = request(src).then(async (response) => {
      if (!response.ok) throw new Error(`Image ${response.status}`)
      return objectUrl(await response.blob())
    }).catch((error) => {
      jobs.delete(src)
      throw error
    })
    jobs.set(src, job)
    return job
  }
}

export const resolveAvatarMedia = createAvatarMediaResolver()
