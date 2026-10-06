import { expect, it } from 'bun:test'
import { createAvatarMediaResolver } from '../src/lib/avatar-media'

it('fetches stored avatars once before detached image preloading', async () => {
  const paths: string[] = []
  let urls = 0
  const request = (async (input) => {
    paths.push(String(input))
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch
  const resolve = createAvatarMediaResolver(request, (blob) => {
    expect(blob.type).toBe('image/jpeg')
    urls++
    return 'blob:authenticated-photo'
  })
  const src = '/v1/apps/roleplay/__media/photo.jpeg'
  expect(await Promise.all([resolve(src), resolve(src)])).toEqual(['blob:authenticated-photo', 'blob:authenticated-photo'])
  expect(await resolve(src)).toBe('blob:authenticated-photo')
  expect(paths).toEqual([src])
  expect(urls).toBe(1)
  expect(await resolve('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA')
  expect(await resolve('/app/admin/roleplay/avatar-default.png')).toBe('/app/admin/roleplay/avatar-default.png')
  expect(paths).toHaveLength(1)
})

it('allows a retry after a stored avatar request fails', async () => {
  let calls = 0
  const request = (async () => new Response('image', { status: ++calls === 1 ? 401 : 200 })) as typeof fetch
  const resolve = createAvatarMediaResolver(request, () => 'blob:retry')
  await expect(resolve('/v1/assets/photo')).rejects.toThrow('Image 401')
  expect(await resolve('/v1/assets/photo')).toBe('blob:retry')
  expect(calls).toBe(2)
})
