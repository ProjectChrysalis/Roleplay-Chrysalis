/**
 * Stress suite: the roleplay app against a library the size heavy users
 * bring. Run from the engine checkout beside this repo:
 *
 *   bun ../chrysalis-engine/scripts/stress/run.ts --app ../chrysalis-roleplay
 */
import type { StressPage, StressSuite } from '../../chrysalis-engine/scripts/stress/types.ts'
import { LONG_CHAT_TITLE, writeLibrary } from './library.ts'

const TEXT = 'The lantern swings; she counts the waves.'

/** In-page helpers, prepended to every snippet below. */
const H = `
const $ = (sel) => document.querySelector(sel);
const nav = (label) => [...document.querySelectorAll("nav button")].find((b) => b.getAttribute("aria-label") === label).click();
const drawer = (label) => $('[role=dialog][aria-label="' + label + '"]');
const leaf = (root, text) => [...root.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === text);
const press = (el) => (el.closest("button, [role=button]") ?? el).click();
`

async function step(page: StressPage, body: string, until: string) {
  await page.eval(`${H}${body}; return 1`)
  await page.waitFor(until, 30_000)
}

/** Back to Home with every drawer closed. */
async function home(page: StressPage) {
  await page.eval(`${H}
    for (let i = 0; i < 4 && $("[role=dialog]"); i++) {
      $("[role=dialog] button[aria-label=Close]")?.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    nav("Home"); return 1`)
  await page.waitFor('!document.querySelector("[role=dialog]") && !document.querySelector("[data-chat-log]")')
}

const has = (s: string) => `!!document.querySelector(${JSON.stringify(s)})`
const CHAT_SEARCH = 'main input[placeholder^="Search chats"]'
const CHAR_SEARCH = '[role=dialog][aria-label="Characters"] input[aria-label="Search characters"]'
const CHAR_GRID = '[role=dialog][aria-label="Characters"] [data-has-overflow-y]'
const CHAR_DESCRIPTION = '[role=dialog][aria-label="Characters"] textarea[aria-label="Description"]'
const PROMPT_CONTENT = '[role=dialog][aria-label="Presets"] textarea[aria-label$=" content"]'
const ENTRY_SEARCH = '[role=dialog][aria-label="Lorebooks"] input[aria-label="Search entries"]'
const ENTRY_CONTENT = '[role=dialog][aria-label="Lorebooks"] textarea[aria-label="Entry content"]'
const COMPOSER = 'textarea[aria-label="Message input"]'
const STOP = 'button[aria-label="Stop generating"]'

/** The chat list: from Home, "Chats" returns to the open chat first. */
async function chatList(page: StressPage) {
  await home(page)
  await step(page, `nav("Chats")`, `${has(CHAT_SEARCH)} || ${has('[data-chat-log]')}`)
  if (await page.eval<boolean>(`return ${has(CHAT_SEARCH)}`)) return
  await step(page, `$('button[aria-label="Back to chats"]').click()`, has(CHAT_SEARCH))
}

const settle = (r: { settleMs: number; worstFrame: number }, prefix: string) => ({ [`${prefix}Ms`]: r.settleMs, [`${prefix}Frame`]: r.worstFrame })
const typing = (r: { landed: number; typed: number; p90: number; max: number }, prefix: string) => ({ [`${prefix}KeyP90`]: r.p90, [`${prefix}KeyMax`]: r.max, [`${prefix}Lost`]: r.typed - r.landed })

const suite: StressSuite = {
  app: 'roleplay',
  fixture: (ctx) => writeLibrary(ctx),
  ready: 'document.querySelector("main") && document.querySelector("nav button")',
  scenarios: [
    {
      name: 'load',
      run: async (page) => ({ ...(await page.reload()) }),
      limits: { readyMs: 4000 },
    },
    {
      name: 'chats',
      run: async (page) => {
        await home(page)
        const open = await page.act(`${H} nav("Chats")`, has(CHAT_SEARCH))
        const search = await page.type(CHAT_SEARCH, 'lantern')
        return { ...settle(open, 'open'), ...typing(search, 'search') }
      },
      limits: { openMs: 800, searchKeyP90: 50, searchLost: 0 },
    },
    {
      name: 'characters',
      run: async (page) => {
        await home(page)
        await step(page, `nav("Characters")`, has('[role=dialog][aria-label="Characters"]'))
        const open = await page.act(`${H} drawer("Characters").querySelector('button[aria-label="Back to characters"]')?.click()`, `${has(CHAR_SEARCH)} && ${has(`${CHAR_GRID} img`)}`)
        const scroll = await page.scroll(CHAR_GRID, 6000)
        const search = await page.type(CHAR_SEARCH, 'amber')
        return { ...settle(open, 'open'), scrollFrame: scroll.worstFrame, scrollLong: scroll.longFrames, ...typing(search, 'search') }
      },
      limits: { openMs: 800, scrollFrame: 100, searchKeyP90: 50, searchLost: 0 },
    },
    {
      name: 'character editor',
      run: async (page) => {
        const open = await page.act(`${H} press($(${JSON.stringify(`${CHAR_GRID} img`)}))`, has(CHAR_DESCRIPTION))
        const edit = await page.type(CHAR_DESCRIPTION, TEXT)
        return { ...settle(open, 'open'), ...typing(edit, 'type') }
      },
      limits: { openMs: 800, typeKeyP90: 50, typeLost: 0 },
    },
    {
      name: 'preset editor',
      run: async (page) => {
        await home(page)
        await step(page, `nav("Presets")`, has('[role=dialog][aria-label="Presets"] input[aria-label="Search presets"]'))
        const open = await page.act(`${H} [...drawer("Presets").querySelectorAll("button")].find((b) => !b.getAttribute("aria-label") && / preset$/.test(b.textContent.trim())).click()`,
          has('[role=dialog][aria-label="Presets"] [aria-label^="Enable "]'))
        await step(page, `const name = drawer("Presets").querySelector('[aria-label^="Enable "]').getAttribute("aria-label").slice(7); leaf(drawer("Presets"), name).click()`, has(PROMPT_CONTENT))
        const edit = await page.type(PROMPT_CONTENT, TEXT)
        return { ...settle(open, 'open'), ...typing(edit, 'type') }
      },
      limits: { openMs: 800, typeKeyP90: 50, typeLost: 0 },
    },
    {
      name: 'lorebook editor',
      run: async (page) => {
        await home(page)
        await step(page, `nav("Lorebooks")`, has('[role=dialog][aria-label="Lorebooks"] input[aria-label="Search lorebooks"]'))
        const open = await page.act(`${H} press([...drawer("Lorebooks").querySelectorAll("button")].find((b) => / lore300$/.test(b.textContent.trim())))`, has(ENTRY_SEARCH))
        const search = await page.type(ENTRY_SEARCH, 'iris')
        await step(page, `const title = drawer("Lorebooks").querySelector('input[aria-label^="Select "]').getAttribute("aria-label").slice(7); leaf(drawer("Lorebooks"), title).click()`, has(ENTRY_CONTENT))
        const edit = await page.type(ENTRY_CONTENT, TEXT)
        return { ...settle(open, 'open'), ...typing(search, 'search'), ...typing(edit, 'type') }
      },
      limits: { openMs: 800, searchKeyP90: 50, searchLost: 0, typeKeyP90: 50, typeLost: 0 },
    },
    {
      name: 'long chat',
      run: async (page) => {
        await chatList(page)
        const open = await page.act(`${H} press([...document.querySelectorAll("main button")].find((b) => b.textContent.includes(${JSON.stringify(LONG_CHAT_TITLE)})))`, `${has('[data-chat-log] [data-message-id]')} && ${has(COMPOSER)}`)
        const scroll = await page.scroll('[data-chat-log]', -8000)
        const compose = await page.type(COMPOSER, TEXT)
        return { ...settle(open, 'open'), scrollFrame: scroll.worstFrame, scrollLong: scroll.longFrames, ...typing(compose, 'type') }
      },
      limits: { openMs: 1000, scrollFrame: 100, typeKeyP90: 50, typeLost: 0 },
    },
    {
      name: 'typing while streaming',
      run: async (page) => {
        page.model.deltas = 1500
        page.model.delayMs = 20
        await step(page, `$('button[aria-label="Send message"]').click()`, has(STOP))
        await new Promise((r) => setTimeout(r, 1500))
        const compose = await page.type(COMPOSER, TEXT)
        const streaming = await page.eval<boolean>(`return !!document.querySelector(${JSON.stringify(STOP)})`)
        if (!streaming) throw new Error('the reply finished before typing did')
        await step(page, `$(${JSON.stringify(STOP)}).click()`, `!${has(STOP)}`)
        return { ...typing(compose, 'type'), longFrames: compose.longFrames }
      },
      limits: { typeKeyP90: 50, typeLost: 0, longFrames: 2 },
    },
    {
      name: 'switch chat',
      run: async (page) => {
        const rows = '[...document.querySelectorAll("main button")].filter((b) => / msgs$/.test(b.textContent.trim()))'
        const out: Record<string, number> = {}
        for (const [i, key] of [[1, 'first'], [2, 'second']] as const) {
          await chatList(page)
          const open = await page.act(`${H} ${rows}[${i}].click()`, `${has('[data-chat-log] [data-message-id]')} && ${has(COMPOSER)}`)
          Object.assign(out, settle(open, key))
        }
        return out
      },
      limits: { firstMs: 800, secondMs: 800 },
    },
  ],
}
export default suite
