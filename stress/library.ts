/**
 * A synthetic library at the size heavy users bring over: 2,650 characters,
 * 735 lorebooks, 150 large presets, 850 regex scripts, 3,000 chats and one
 * chat of 3,000 messages. Written straight into data/ in the app's on-disk
 * format; the same seed always gives the same library.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export interface LibraryOptions { dataDir: string; model: string; scale: number }

export const LONG_CHAT_TITLE = 'Stress: the long voyage'

const SENTENCES = [
  'The lantern light sways as the rain needles the window.',
  'She keeps the old lighthouse, and the lighthouse keeps her secrets.',
  '*He leans against the doorframe, arms folded, watching the storm roll in.*',
  'Nobody in the harbor town remembers who lit the first fire on the cliff.',
  '"You came back," she says, voice low, eyes on the tide.',
  'Every map of the coast is wrong in a different place.',
  'The merchants trade in salt, silver and promises they never keep.',
  '{{char}} speaks softly but never lies to {{user}}.',
  'A bell rings somewhere below the waves when the moon is full.',
  'Her coat smells of smoke, cedar and something older than either.',
  'The guild hall stands empty since the winter of the long frost.',
  '*The fox settles onto the crooked post, tail curling around her paws.*',
  'Rumors say the archivist can read a lie in the way a person breathes.',
  'Three roads leave the valley; only one of them comes back.',
  'The tavern keeper pours without asking and listens without judging.',
  'Sparks drift up from the forge like small, impatient stars.',
]
const WORDS = 'amber ash bramble cinder copper dawn ember fable fern frost gale harbor hollow iris juniper lantern marrow moss nettle onyx pearl quill raven rook saffron sorrel thistle umber vale willow wren'.split(' ')

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Avatars: a few dozen distinct, photo-sized PNGs shared across the cards. */
function avatar(r: () => number): Buffer {
  const w = 400, h = 600
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const [a, b, c] = [r() * 255, r() * 255, r() * 255]
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      const n = (r() - 0.5) * 40
      raw[o] = (a + x / 3 + n) & 255
      raw[o + 1] = (b + y / 4 + n) & 255
      raw[o + 2] = (c + (x + y) / 5 + n) & 255
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export async function writeLibrary({ dataDir, model, scale }: LibraryOptions): Promise<void> {
  const r = rng(20261118)
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]!
  const n = (count: number) => Math.max(1, Math.round(count * scale))
  const text = (chars: number) => {
    let out = ''
    while (out.length < chars) out += (out ? (r() < 0.2 ? '\n\n' : ' ') : '') + pick(SENTENCES)
    return out
  }
  const name = () => `${pick(WORDS)[0]!.toUpperCase()}${pick(WORDS).slice(1)} ${pick(WORDS)}`
  const id = (prefix: string, i: number) => `${prefix}${i.toString(36).padStart(5, '0')}`
  const write = (rel: string, body: string | Buffer) => {
    const file = path.join(dataDir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  const now = Date.UTC(2026, 9, 1)

  const media: string[] = []
  for (let i = 0; i < 40; i++) {
    const png = avatar(r)
    const sha = crypto.createHash('sha256').update(png).digest('hex')
    write(`__media/${sha}.png`, png)
    media.push(`/v1/apps/roleplay/__media/${sha}.png`)
  }

  const characters: string[] = []
  for (let i = 0; i < n(2650); i++) {
    const cid = id('stress-char-', i)
    characters.push(cid)
    write(`characters/${cid}/card.json`, JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0', name: name(), creator: pick(WORDS),
      description: text(6000), personality: text(600), scenario: text(1200), first_mes: text(2000),
      mes_example: text(3000), alternate_greetings: [text(1500), text(1500)], creator_notes: text(1500),
      tags: [pick(WORDS), pick(WORDS), pick(WORDS)], system_prompt: '', post_history_instructions: '',
      character_version: '1.0', extensions: {}, avatar: pick(media), studio: { createdAt: now - i * 60_000, importedAt: now },
    }))
  }

  for (let i = 0; i < n(735); i++) {
    const entries = Array.from({ length: i % 50 === 0 ? 300 : 20 }, (_, uid) => ({
      uid, title: name(), memo: '', keys: [pick(WORDS), pick(WORDS)], keysRegex: false, secondaryKeys: [], selectiveLogic: 'and_any',
      content: text(900), enabled: true, order: 100, position: 'before_char', depth: 4, role: 'system', status: 'normal',
      group: '', groupWeight: 100, groupPrioritize: false, sticky: 0, cooldown: 0, delay: 0, characterFilter: [], characterFilterExclude: false,
      tagFilter: [], triggerFilters: [], nonRecursable: false, preventFurtherRecursion: false, ignoreBudget: false, delayUntilRecursion: false,
      automationId: '', matchSources: { description: false, personality: false, scenario: false, persona: false },
    }))
    const lid = id('stress-lore-', i)
    write(`lorebooks/${lid}.json`, JSON.stringify({ id: lid, name: `${name()} lore`, entries }))
  }

  // presets go through the app's own save shape: the app reads and writes
  // every preset that way, and a raw import file is normalized once on open
  ;(globalThis as { location?: unknown }).location ??= { pathname: '/app/stress/roleplay/' }
  const { enginePresetToUI, presetToEngine } = await import('../src/lib/engine.ts')
  for (let i = 0; i < n(150); i++) {
    const prompts = Array.from({ length: 30 }, (_, k) => ({
      identifier: `stress-${k}`, name: `${name()} rules`, role: 'system', content: text(i % 10 === 0 ? 8000 : 2000),
      injection_position: 0, injection_depth: 4, injection_trigger: [],
    }))
    const pid = id('stress-preset-', i)
    const raw = {
      id: pid, name: `${name()} preset`, temperature: 1, top_p: 1, top_k: 0, min_p: 0, frequency_penalty: 0, presence_penalty: 0,
      openai_max_tokens: 800, openai_max_context: 32000, prompts,
      prompt_order: [{ character_id: 100001, order: prompts.map((p) => ({ identifier: p.identifier, enabled: true })) }],
    }
    write(`presets/${pid}.json`, JSON.stringify({ ...presetToEngine(enginePresetToUI(raw as never, pid)), id: pid }))
  }

  for (let i = 0; i < n(850); i++) {
    const rid = id('stress-regex-', i)
    write(`regex/${rid}.json`, JSON.stringify({
      id: rid, scriptName: `${name()} cleanup`, findRegex: `/${pick(WORDS)}\\s+(${pick(WORDS)}|${pick(WORDS)})/gi`, replaceString: text(300),
      placement: ['ai_output'], markdownOnly: true, promptOnly: false, runOnEdit: true, trimStrings: [], flags: 'gi',
      minDepth: null, maxDepth: null, disabled: i % 3 !== 0, scope: 'global', order: i,
    }))
  }

  const message = (cid: string, k: number, at: number) => {
    const user = k % 2 === 1
    return JSON.stringify({ id: `m${k.toString(36)}`, name: user ? 'You' : 'Char', charId: user ? null : cid, role: user ? 'user' : 'char', text: text(user ? 300 : 1400), at, swipes: [], swipe: 0, ...(k === 0 ? { greeting: true } : {}) })
  }
  const chat = (cid: string, chatId: string, title: string, count: number, updated: number) => {
    const lines: string[] = []
    for (let k = 0; k < count; k++) lines.push(message(cid, k, updated - (count - k) * 60_000))
    // the summary the app keeps beside every chat it saves
    const last = JSON.parse(lines[lines.length - 1]!) as { text: string }
    const listing = { messageCount: count, preview: last.text.slice(0, 160), hasUser: count > 1 }
    write(`chats/${chatId}.meta.json`, JSON.stringify({ id: chatId, title, characterId: cid, groupId: null, presetId: null, personaId: null, model, userName: 'You', authorNote: '', lorebookIds: [], createdAt: updated - count * 60_000, updatedAt: updated, tainted: false, listing }))
    write(`chats/${chatId}.jsonl`, lines.join('\n') + '\n')
  }
  for (let i = 0; i < n(3000); i++) chat(characters[i % characters.length]!, id('stress-chat-', i), `${name()} chat`, 10 + Math.floor(r() * 40), now - i * 3_600_000)
  chat(characters[0]!, 'stress-chat-long', LONG_CHAT_TITLE, 3000, now + 3_600_000)

  write('settings.json', JSON.stringify({ model }))
}
