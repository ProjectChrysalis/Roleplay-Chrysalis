import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { buildCardPng } from './png-card'
import { DEFAULT_AVATAR } from './utils'
import type { EngineCard } from './engine'

export async function buildPortableArchive(backup: Uint8Array, makeCard = buildCardPng): Promise<Uint8Array> {
  const source = unzipSync(backup)
  const out: Record<string, Uint8Array> = {}
  const text = (name: string) => strFromU8(source[name]!)
  const bookFiles = new Map<string, string>()
  for (const name of Object.keys(source)) {
    if (!name.startsWith('worlds/') || !name.endsWith('.json')) continue
    const book = JSON.parse(text(name))
    bookFiles.set(book.name, name.slice('worlds/'.length, -5))
    out[name] = source[name]!
  }
  for (const name of Object.keys(source)) {
    if (!name.startsWith('characters/') || !name.endsWith('.json')) continue
    const card = JSON.parse(text(name)) as EngineCard & { _lorebookNames?: { embedded?: string; linked?: string[] } }
    const { _lorebookNames, avatar: _avatar, ...data } = card
    const linked = _lorebookNames?.embedded || _lorebookNames?.linked?.[0]
    const world = linked ? bookFiles.get(linked) : undefined
    const extensions = { ...(data.extensions as Record<string, unknown> | undefined), ...(world ? { world } : {}) }
    const portable = { ...data, spec: 'chara_card_v2', spec_version: '2.0', data: { ...data, extensions } } as EngineCard
    const storedAvatar = typeof card.avatar === 'string' ? card.avatar : ''
    const avatar = !storedAvatar || /(?:^|\/)avatar-default\.png(?:[?#].*)?$/.test(storedAvatar) ? DEFAULT_AVATAR : storedAvatar
    out[name.replace(/\.json$/, '.png')] = await makeCard(avatar, portable)
  }
  for (const name of Object.keys(source)) {
    if (!name.startsWith('chats/') || !name.endsWith('.jsonl')) continue
    const sidecar = name.replace(/\.jsonl$/, '.meta.json')
    const meta = source[sidecar] ? JSON.parse(text(sidecar)) : {}
    if (meta.groupId) continue
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: {} }
    out[name] = strToU8(JSON.stringify(header) + '\n' + text(name))
  }
  const presets = source['User Settings/openai_settings.json']
  if (presets) {
    const used = new Set<string>()
    for (const [name, preset] of Object.entries(JSON.parse(strFromU8(presets)))) {
      const base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '') || 'Preset'
      let filename = base, n = 2
      while (used.has(filename.toLowerCase())) filename = `${base} (${n++})`
      used.add(filename.toLowerCase())
      const value = preset as Record<string, unknown>
      const prompts = Array.isArray(value.prompts) ? value.prompts.map((prompt: Record<string, unknown>) => ({
        ...prompt,
        ...(prompt.injection_position === 'absolute' ? { injection_position: 1 } : prompt.injection_position === 'relative' ? { injection_position: 0 } : {}),
      })) : value.prompts
      const orders = Array.isArray(value.prompt_order) ? value.prompt_order as Array<Record<string, unknown>> : []
      const order = orders.find((item) => item.character_id === 100001 && Array.isArray(item.order) && item.order.length)
        ?? orders.find((item) => Array.isArray(item.order) && item.order.length)
      const promptOrder = order ? [{ ...order, character_id: 100001 }] : orders
      out[`OpenAI Settings/${filename}.json`] = strToU8(JSON.stringify({ ...value, ...(prompts ? { prompts } : {}), ...(orders.length ? { prompt_order: promptOrder } : {}) }, null, 2))
    }
  }
  out['README.txt'] = strToU8('This archive contains character PNG cards, individual chats, lorebooks and chat completion presets. Extract its folders into the destination user data folder. Back up existing data first and avoid overwriting files. Group chats, personas, settings, scripts, and other app-specific data are not included. Character links include the first linked lorebook.\n')
  return zipSync(out)
}
