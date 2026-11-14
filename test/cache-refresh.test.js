import { afterEach, beforeEach, expect, it } from 'bun:test'
import { handleRoute, llmRequest, llmResponse, onTick } from '../plugins/cache-refresh/plugin.js'
import { normalizeChatLines } from '../plugins/studio-import/src/chats.js'
import { continuedSwipeMeta, restoreSwipeThinking, syncSwipeThinking } from '../plugins/engine/src/thinking.js'

let now, originalNow, host, store, files, requests
beforeEach(() => {
  now = 100_000
  originalNow = Date.now
  Date.now = () => now
  store = {}
  files = {
    'settings.json': { presetId: 'preset', model: 'anthropic/test' },
    'chats/chat.meta.json': { id: 'chat' },
    'presets/preset.json': { studio: { samplers: { cache: { enabled: true, pinned: false, refresh: { enabled: true, intervalSeconds: 270, maxRefreshes: 3, notifications: true } } } } },
  }
  requests = []
  host = { fs: { read: (path) => { if (!files[path]) throw Error('missing'); return JSON.stringify(files[path]) } },
    store: { get: (key) => structuredClone(store[key]), put: (key, value) => { store[key] = structuredClone(value) } },
    llm: { results: {}, request: (key, req) => requests.push({ key, req }) } }
})
afterEach(() => { Date.now = originalNow })
const pulse = (body = {}) => handleRoute({ method: 'POST', path: '/cache-refresh', body: { clientId: 'client', chatId: 'chat', ...body } }, host).json
function arm() {
  pulse()
  const request = { sessionId: 'chat', captureCache: true }
  Object.assign(request, llmRequest({ key: 'reply', plugin: 'roleplay.engine', request }, host))
  expect(request.captureCache).toBeString()
  llmResponse({ key: 'reply', plugin: 'roleplay.engine', request,
    result: { cacheRefresh: { token: 'token', startedAt: now, expiresAt: now + 300_000 } } }, host)
}
function advance(ms) { for (let elapsed = 0; elapsed < ms; elapsed += 30_000) { now += Math.min(30_000, ms - elapsed); pulse() } }
function due() { advance(270_000); return onTick({}, host) }
function finish(ctx, cacheRead = 200) {
  host.llm.results.refresh = { model: 'anthropic/test', usage: { input: 1, output: 1, cacheRead, cacheWrite: 0, priced: false, costTotal: 0 }, cacheRefresh: { startedAt: now, expiresAt: now + 300_000 } }
  const result = onTick(ctx, host)
  host.llm.results = {}
  return result
}
it('uses one server cycle across clients, notifies only confirmed hits, and stops at the limit', () => {
  arm()
  pulse({ clientId: 'second' })
  for (let i = 0; i < 3; i++) {
    const ctx = due()
    expect(ctx.token).toBe('token')
    const result = finish(ctx)
    expect(result.events.at(-1).message).toBe('Cache refreshed')
    expect(result.usage.at(-1).costTotal).toBeUndefined()
    expect(result.remaining).toBe(2 - i)
  }
  expect(pulse().state).toBe('complete')
  expect(onTick({}, host)).toBeNull()
  expect(requests).toHaveLength(3)
})
it('pauses while generating and stops on a miss without claiming a refresh', () => {
  arm()
  advance(270_000)
  pulse({ busy: true })
  expect(onTick({}, host)).toBeNull()
  pulse({ busy: false })
  const ctx = onTick({}, host)
  const result = finish(ctx, 0)
  expect(result.state).toBe('paused')
  expect(result.events[0].type).toBe('warning')
  expect(result.nextAt).toBeNull()
  expect(onTick({}, host)).toBeNull()
})
it('does not revive a stopped or switched chat when an in-flight refresh returns', () => {
  arm()
  const ctx = due()
  pulse({ stop: true })
  expect(finish(ctx)).toBeNull()
  expect(pulse().state).toBe('stopped')
  arm()
  const switched = due()
  pulse({ chatId: null })
  expect(finish(switched)).toBeNull()
  expect(store.refresh.cycles).toEqual({})
})
it('expires presence leases, invalidates changed presets, and never warms an expired cache', () => {
  arm()
  now += 91_000
  expect(onTick({}, host)).toBeNull()
  expect(store.refresh.cycles).toEqual({})
  arm()
  files['presets/preset.json'].name = 'Changed'
  expect(pulse().state).toBe('waiting')
  arm()
  advance(301_000)
  expect(onTick({}, host)).toBeNull()
  expect(pulse().message).toBe('Refresh session expired')
  expect(requests).toHaveLength(0)
})
it('reports unsupported snapshots and has refresh disabled for old presets', () => {
  pulse()
  const request = { sessionId: 'chat', ...llmRequest({ key: 'reply', plugin: 'roleplay.engine', request: { sessionId: 'chat' } }, host) }
  llmResponse({ key: 'reply', plugin: 'roleplay.engine', request, result: { cacheRefresh: { reason: 'Thinking enabled', startedAt: now } } }, host)
  expect(pulse().message).toBe('Thinking enabled')
  delete files['presets/preset.json'].studio.samplers.cache.refresh
  expect(pulse().enabled).toBe(false)
  expect(llmRequest({ key: 'reply', plugin: 'roleplay.engine', request: { sessionId: 'chat' } }, host)).toEqual({ captureCache: false })
})
it('imports per-swipe times and opaque metadata without inventing historical dates', () => {
  const chat = normalizeChatLines({ lines: [{ mes: 'second', send_date: 1000, swipes: ['first', 'second', 'unknown'], swipe_id: 1,
    swipe_info: [{ send_date: 2000, gen_started: 1900, gen_finished: 2100, extra: { model: 'one', opaque: 42 } }, { send_date: 3000, extra: { model: 'two' } }] }] })
  expect(chat.msgs[0].at).toBe(1000)
  expect(chat.msgs[0].extra.swipeMeta).toMatchObject([{ createdAt: 2000, startedAt: 1900, finishedAt: 2100, genMs: 200, opaque: 42 }, { createdAt: 3000 }, null])
  const switched = restoreSwipeThinking(chat.msgs[0].extra, 0)
  expect(switched.createdAt).toBe(2000)
  expect(restoreSwipeThinking(switched, 2).createdAt).toBeUndefined()
})
it('keeps original creation and generation dates while recording each continuation separately', () => {
  const own = { createdAt: 100, startedAt: 90, finishedAt: 150, model: 'old' }
  const continued = continuedSwipeMeta(own, { createdAt: 200, startedAt: 190, finishedAt: 250, model: 'new', usage: { output: 5 } })
  const msg = syncSwipeThinking({ swipes: ['continued'], swipe: 0, extra: { ...continued, swipeMeta: [continued] } })
  expect(msg.extra.swipeMeta[0]).toMatchObject({ createdAt: 100, startedAt: 90, finishedAt: 150, continuations: [{ startedAt: 190, finishedAt: 250, usage: { output: 5 } }] })
  expect(continuedSwipeMeta(null, { createdAt: 200 }).createdAt).toBeUndefined()
})

it('runs the refresher hooks in the real sandbox without model or network access', async () => {
  const { PluginSandbox } = await import('../../chrysalis-engine/src/plugins/sandbox.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-refresh-sandbox-'))
  const box = new PluginSandbox()
  try {
    for (const [name, data] of Object.entries(files)) {
      const target = path.join(root, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify(data))
    }
    const source = fs.readFileSync(new URL('../plugins/cache-refresh/plugin.js', import.meta.url), 'utf8')
    const result = await box.eval({ source, hook: 'handleRoute', ctx: { method: 'POST', path: '/cache-refresh', body: { clientId: 'sandbox', chatId: 'chat' } },
      storeSnapshot: {}, storeAllowed: true, llmAllowed: false, netAllowed: false, fsAllowed: true, fsRoot: root })
    expect(result.ok).toBe(true)
    expect(result.out.json).toMatchObject({ enabled: true, state: 'waiting' })
    const requestResult = await box.eval({ source, hook: 'llmRequest', ctx: { plugin: 'roleplay.engine', key: 'reply', request: { sessionId: 'chat' } },
      storeSnapshot: result.storeWrites, storeAllowed: true, llmAllowed: false, netAllowed: false, fsAllowed: true, fsRoot: root })
    expect(requestResult.ok).toBe(true)
    expect(requestResult.out.captureCache).toBeString()
  } finally { await box.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
})

function beginReply() {
  pulse()
  const request = { sessionId: 'chat' }
  Object.assign(request, llmRequest({ key: 'reply', plugin: 'roleplay.engine', request }, host))
  return request
}
function endReply(request, token = 'new-token') {
  return llmResponse({ key: 'reply', plugin: 'roleplay.engine', request,
    result: { cacheRefresh: { token, startedAt: now, expiresAt: now + 300_000 } } }, host)
}
it('rejects stale original replies after Stop, a newer reply, preset edits, and closing then reopening', () => {
  const stopped = beginReply()
  pulse({ stop: true })
  endReply(stopped)
  expect(pulse().state).toBe('stopped')
  const older = beginReply()
  const newer = beginReply()
  endReply(newer)
  endReply(older, 'obsolete')
  expect(store.refresh.cycles.chat.token).toBe('new-token')
  const edited = beginReply()
  files['presets/preset.json'].name = 'Changed during generation'
  endReply(edited)
  expect(pulse().state).toBe('waiting')
  const closed = beginReply()
  pulse({ chatId: null })
  pulse()
  endReply(closed)
  expect(pulse().state).toBe('waiting')
  expect(requests).toHaveLength(0)
})
it('requires explicit opt-in and bounds malformed or extreme settings', () => {
  const refresh = files['presets/preset.json'].studio.samplers.cache.refresh
  for (const enabled of [false, undefined, null, 'false', 1]) {
    refresh.enabled = enabled
    expect(pulse().enabled).toBe(false)
    expect(beginReply().captureCache).toBe(false)
  }
  refresh.enabled = true
  refresh.intervalSeconds = -100
  refresh.maxRefreshes = 1000000
  arm()
  expect(pulse().remaining).toBe(20)
  expect(pulse().nextAt).toBe(now + 30_000)
})
it('stress-tests 1000 cycles with 12 tabs, delayed results, Stops, misses, and bounded refresh counts', () => {
  for (let round = 0; round < 1000; round++) {
    store = {}
    requests.length = 0
    arm()
    for (let tab = 0; tab < 12; tab++) pulse({ clientId: 'tab_' + tab })
    for (let attempt = 0; attempt < 5; attempt++) {
      advance(270_000)
      const ctx = onTick({}, host)
      if (ctx) {
        if (round % 7 === 0) pulse({ stop: true })
        finish(ctx, round % 11 === 0 ? 0 : 200)
      }
    }
    expect(requests.length).toBeLessThanOrEqual(3)
    expect(['stopped', 'paused', 'complete']).toContain(pulse().state)
    expect(onTick({}, host)).toBeNull()
    expect(pulse().usage?.length || 0).toBeLessThanOrEqual(3)
  }
})
