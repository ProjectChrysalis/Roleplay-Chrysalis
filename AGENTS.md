# AGENTS.md — Roleplay app (the studio)

You are operating on the official Roleplay app's files. First-party but
unprivileged: everything here is plain files you may read, edit, and commit —
same as any user-made app. Keep this file current when you change the app.

## Create and edit data

Use the focused skill matching the request under `.agents/skills/`: character,
persona, preset, lorebook, regex, chat, group, settings, library, or databank,
all with the `-editing` suffix. Skills cover reading as well as editing. Load
only the relevant skill; use its inspector to resolve known records and nested
items in one call. Its editor preserves fields and checks inspected revisions.
Preset helpers also synchronize portable/editor values; chat helpers preserve
inactive swipes and generation metadata. Structural chat actions use app routes.

The app publishes its current entity IDs to the shell for explicit attachment
in agent Settings. Preset focus follows the selected preset. The attachment preview shows its type and name. Attached
selection is evidence, not permission, and is consumed by the next message.

For creation or unfamiliar fields, consult `data/_catalog.json`: entity paths, routes, complete templates, and
source types. Read only the matching section of `data/_EDITING.md` for field meanings,
paired representations, bindings, and safe writes. Copy `data/_templates/_<kind>.json` to a new
unique non-underscore ID, replace names/text/IDs, and use actual millisecond
timestamps. For an edit, read the existing record and preserve every field
you are not changing, including opaque metadata, extensions, and studio bags.
Character cards are flat; their stored example-dialogue key is `mes_example`.
Preset text/order live in prompts/prompt_order and their matching studio
sections. Keep both copies consistent. Persona and preset defaults live in
settings.json.personaId and settings.json.presetId. Never overwrite live settings/library with a template.
UI data saves coalesce rapid replacements and serialize writes per entity;
refresh reads wait for pending saves, including the debounce period.

## Where a change goes — decide this first

Pick the lightest place that can carry the request. All three are supported and
all three survive an update (a three-way merge against the version the app was
installed from; only an edit overlapping the same lines conflicts, and then
nothing is written until the user settles it). `data/` is never part of an
update at all.

1. **`data/`** — content and configuration. A great deal of this app's
   behavior is already data-driven, and reaching for `src/` for something a
   data file already controls is the one wrong answer here. Before writing any
   code, check whether what was asked for is one of these:
   `data/settings.json` `ui` (the WHOLE AppSettings object: theme, fonts,
   hotkeys, TTS, translation, memory, chat behavior), presets (prompt order,
   samplers, utility prompts, world-info budget, prompt format),
   lorebooks (what fires and when), regex scripts (rewrite text in or out),
   personas, quick replies in `data/library.json` (which have real automation
   hooks: onStartup/onChatChange/onUser/onAi), and character cards including
   their variants and versions. Edits here need no rebuild and open clients
   pick them up in about a second.
2. **`plugins/<your-id>/`** — new backend behavior: routes, model tools,
   scheduled work. Prefer a NEW plugin folder over editing `plugins/engine/`
   or `plugins/studio-import/`: a file only you added has no upstream version
   to disagree with, so it can never conflict on an update. A plugin can also
   patch a sibling's model request (`llmRequest`), which is how you change what
   the model receives without touching the assembly code.
3. **`src/`** — the UI. Editing it is normal and expected; it is how the app
   changes shape. It rebuilds in the user's browser (call `app_check`
   afterwards) and puts that file in the merge path on the next update.

## What this app is

The roleplay studio, v4: a power-user roleplay UI. Left icon rail (Home / Chats / Characters / Marketplace / Personas /
Presets / Lorebooks / Shortcuts / Tools / Connections / Settings) + Ctrl+K
command palette. Sections open as drawers over the page (components/shell/
sections.ts is the one list). A drawer slides its whole width out from under
the rail and back under it; sheets everywhere travel their full size with no
fade (components/ui/sheet.tsx, `clipClassName` is the box a sheet beside a
bar is clipped to). On desktop the drawer's right edge and the border
between a view's list and its editor (MasterDetail, keyed by `resizeKey`) are
components/ui/resize-handle.tsx: drag to resize, arrow keys step, double-click
goes back to the default. A drawer dragged to the window's edge, or the header
button, fills the window. Widths and the filled state are persistent view
memory (`layout.*`), so they belong to the browser, not the data folder. On
mobile, only over an open chat, whose header
becomes a row of section icons (tap to drop the section down over the chat,
tap again to close); elsewhere on mobile a section is the page, reached from
the bottom tab bar. Views are components/views/*, the chat experience lives in
components/chat/*, the tabbed character editor in components/character/*.
The Marketplace (components/views/marketplace-view.tsx) searches Chub and
Datacat through studio-import routes (/marketplace/search, /marketplace/detail,
/marketplace/tags, /marketplace/import). Public Datacat definitions import inside
the app with attribution, embedded lore, and artwork. Disabled/private/placeholder
cards are blocked; the official file-download endpoint can still require website
verification. Anonymous sessions are cached in the backend plugin store, never in
card data. Creator catalogs use their actual IDs and chat order; entering a search
or applying filters returns to the whole catalog. Tag searches reach beyond the
popular subset. Rating tags, minimum tokens, recent additions and score order are
supported by the catalog endpoint.
Do not send Chub-specific controls to Datacat. Remote art uses /img.
Chub needs explicit nsfw/nsfl/nsfw_only flags; trending selects a separate pool;
tags use topics and inclusive_or for any-tag matching.
Characters grid/list and sort preferences live in settings.ui.characterBrowser.
Imported cards record studio.importedAt and initialize studio.createdAt when
missing. Unknown historical import dates stay unknown. Recent-chat ordering
also uses chat activity instead of relying only on the card timestamp.
The chat header’s Lore button and the Chat lorebooks menu item open a compact
searchable selector with removable selected chips. Lorebook activity stays a
separate panel. The selector searches the entire library and renders up to 60
matches at a time. `chatLorebookIds`
stores explicit chat bindings separately from the inherited `lorebookIds` scope.
Both prompt assembly and semantic preparation include them; backups remap the
explicit bindings through `_chatLorebookNames`. Forks inherit the selection.
The preset and lorebook editors keep one line of everyday controls and fold
the rest. A preset prompt shows name, role, a macro button (inserts at the
cursor) and its text. Position, group, condition, triggers and forbid overrides
sit under Options, which names whatever is set away from the default while
closed. Groups are created from a prompt's Group picker. A lorebook entry shows
title, status, keys, content, position, order and trigger chance. Secondary
keys, timing, inclusion group, recursion flags, extra scan sources and the
automation id sit under More options the same way. Both folds are one
remembered switch for every row. Book and preset actions that are not everyday
are in the header's menu. The position picker offers only the three places an
entry can be sent to. Keyword test matches with `lib/lore-match.ts`, which
follows the engine plugin's key rules: change the two together.
Stored avatar URLs must pass through `lib/avatar-media.ts` before the UI kit
preloads them. Detached image preloaders cannot carry the frame’s session; the
resolver shares authenticated fetches and gives the component a blob URL.
Settings → Notifications controls popups by type and area through
lib/notifications.ts. Popups use neutral borders. All popup producers use createToast(area), including
store actions. Swipe transitions use hooks/use-swipe-animation.ts and lib/swipe-animation.ts.
The avatar and message content slide out, swap offscreen, and enter from the
opposite side. New generations reveal the stream at the midpoint; commits
and interrupted replies stay in place. One transition runs at a time.
Preferences live in settings.ui.notifications; missing keys
are enabled for older settings. settings.ui.notificationPosition chooses
the popup position, defaulting to bottom-center.
The composer’s Speak as submenu shows titles to the right when same-name personas have different titles.
State is a zustand store (lib/store.ts) hydrated from the engine and mirrored
to it on every change. Chats search uses GET /chats/search to search saved active message text, names
and titles, including unloaded transcripts. Words must all occur somewhere in the
chat; quoted phrases stay intact. Results are paginated with matched-message
snippets, character/folder filters and a transient message focus for jumping to
older turns. Pictures and inactive swipes are excluded. Missing/corrupt data is
reported. Search responses do not hydrate whole transcripts. Unchanged hydrated chat lists do not restart search. The composer skips
hidden-frame measurements, keeps a one-line minimum and refits on visibility,
width, viewport and font changes.
Generation data shows the preset name saved at generation time for each swipe; older replies without a snapshot show Not recorded.

Messages are a FLAT list with swipes. Interrupted generations freeze and save streamed output through /cancelled; sends use stable user/reply IDs to avoid duplicate saves, Continue updates the active swipe, and failed saves protect the local transcript until Retry succeeds.

Markdown horizontal rules use a brighter line. Thinking disclosure and panel borders
use the standard muted theme styles.
Single tildes stay literal in Markdown; strikethrough requires double tildes.
Section drawers retain their title and view until the sheet's closing animation completes.

Expanded thinking panels have a Copy button and an actions menu above the scrollable
text. Edit thinking and Remove all thinking live in that menu; collapsed panels
show only the disclosure label. Thinking controls remove all saved thinking from the displayed reply, including
interleaved thinking parts, without changing text or tool results. Presets choose
Thinking history: preserve (default) replays native assistant/tool sequences and
signatures on the same provider, API and model; individual sends reply text only.
Edits clear invalid signatures and send changed thinking as ordinary context.
Deletion clears thought text and signatures; swipes retain their own thinking.
Stopped replies store their thinking parts on their own swipe. Swipe navigation
snapshots the outgoing metadata and restores the chosen swipe's metadata.
Saved swipe metadata is authoritative in the UI and during navigation; stale
message metadata must not overwrite a swipe's thought text or duration.
Older replies retain readable thinking but cannot recover missing signatures.

## Phase status

- v4.0: initial studio release (fixed one latent upstream component bug on the way:
  ui/command.tsx CommandDialog now wraps children in <Command> — without it
  every cmdk consumer crashes on undefined.subscribe when the palette opens).
- v4.1: FULLY WIRED to the engine. src/lib/engine.ts is the only network
  layer (fetch + adapters + the /v1/ws app_stream client); src/lib/store.ts
  hydrates from the engine and mirrors every mutation optimistically.
  Generation is real (send/swipe/continue/next/impersonate stay open while
  the kernel runs the model; deltas render live; Stop aborts). Characters,
  chats, swipes (set/generate/delete), messages (edit/hide/move/
  truncate), forks+branch tree, groups (mute/strategy/force-speak),
  personas (the default in settings is what a NEW chat starts with; every
  chat pins its own persona and only an explicit switch changes it), presets (sections ⇄ portable prompts[]),
  lorebooks (global/linked scope → engine world-info), regex, model catalog
  (GET /v1/models), import (PNG tEXt cards/JSON/chats/regex/presets via
  plugins/studio-import) and backup zip export/restore are all server-backed.
  Quick replies now have REAL automation hooks (onStartup/onChatChange/
  onUser/onAi → store actions, see runAutoExecutes in lib/store.ts).
  Translation (plugin /translate: llm/google/lingva/deepl), TTS (engine
  /v1/audio/speech: keyless Edge voices or a speech endpoint), the data bank
  (plugin /databank) and image generation are all engine-backed.
  Purely local: themes, quick replies, tags/folders, hotkeys, backgrounds.

## Backups (the zip, both directions)

`GET /export/backup` writes public formats plus what those formats have no
room for, so a restore on another machine is not lossy:

- `characters/<slug>.json` whole cards, `worlds/<slug>.json` books with a
  `_studio` bag (settings, globalActive, folderId, `_linkedNames`).
- `personas/<slug>.json` the full record (avatar, title, pronouns, bindings,
  isDefault) with `_lorebookNames` / `_boundNames`; `User Settings/personas.json`
  keeps the flat name→description map other tools read.
- `chats/<owner>/<slug>-<id>.jsonl` plus a `.meta.json` sidecar (the whole
  chat meta, with `_presetName` / `_personaName` / `_lorebookNames`) and a
  `.memories.json` vault. Per-message fields the public line shape cannot
  carry (`hidden`, `bookmark`, `picture`, `translation`, `extra`) ride in
  `extra.chry`.
- `settings.json` carries `settings` (the real `ui` object), `library.json`
  the local collections, `variables.json` the shared macro variables (merged
  into what is already there on restore), `databank/` the retrieval chunks.

IDS DO NOT TRAVEL. Anything pointing at another entity exports a `_…Names`
sibling and the importer re-resolves it; ids are re-minted on the way in.
Zip text is UTF-8 — never write latin1 into the archive.

Reading a zip: `normalizeEntryName` anchors on the collection folder, so any
wrapper above `characters/` or `worlds/` (a data folder, a whole install
directory, a tool's own backup) is cut. Binary entries arrive from the kernel
as `{ __b64__: true, base64 }` — use `entryBase64`, never the raw key.
Entries are handled in phase order (characters → books → presets → regex →
personas → groups → chats → databank), because the later phases resolve the
earlier ones by name.
Foreign settings restore personal tag names, colors and folder display, plus
global and auxiliary character lorebook links. `user/images/` imports before
chats; both legacy image fields and media arrays resolve to stored attachments.
The `chatImages` lookup outlives batches and is removed at finish.

## Memory, pictures, regex, groups, MCP (how they work now)

- Memory = summaries in parts + a cutoff (meta.summaryParts,
  meta.memoryCutoffMessageId). POST /chats/:id/compact summarizes ONLY the
  turns between the cutoff and the newest `keepRecent` as a new part
  ({ id, text, from, to }: message ids, `to` not included) and moves the
  cutoff. Earlier parts go to the model as context and are never rewritten,
  so old detail does not wear away with each compaction. Only when the parts
  would pass ui.summary.maxWords is the oldest half merged into one, by a
  second request in the same pass (a failed merge is skipped). meta.summary
  is always the parts joined, which is what the prompt and {{summary}} read;
  summaryParts()/setSummaryParts() in the engine plugin keep the two in
  step. A summary written straight into meta.summary (an older chat, an edit
  on disk, PATCH {summary}) counts as one part. PATCH {summaryParts:
  [{id,text}]} edits parts in place; one left out or emptied is gone. Every
  compaction records what it did on meta.compactions (max 20) so
  /compact/undo takes it back exactly, merged parts included, and
  {redo:true} rewrites the latest part over the same messages. Messages
  above the cutoff stay in the chat (dimmed) but leave the prompt. Auto mode
  compacts when a send reports `trimmed` (history fell out of the context)
  or every `interval` turns. The Memory panel shows one box per part.
- Facts: the per-chat vault (/memories, Memory → Facts). Pinned facts ride
  every prompt, the rest come back when the recent chat shares words with
  them. Words only: facts are not embedded, so recalling them costs no extra
  call. Embeddings are used for one thing, lorebook entries whose status is
  Vectorized, and only when a connection offers them.
- Scenes: POST /chats/:id/scene { from, to } has the model draft a lorebook
  entry (title, keys, content) from that stretch and saves nothing. The
  Save scene dialog (a message's menu) edits the draft and stores it with
  the store's saveSceneEntry: one PUT of the whole book, then the book is
  bound to the chat (chatLorebookIds). A chat with no lorebook of its own
  gets one named after it. The usual key scan brings the entry back.
- Summaries, fact extraction (manual and automatic) and scene drafts run on
  ui.memory.model when set (memoryModelOf in the engine plugin), otherwise
  on the chat's model.
- Pictures: /chats/:id/image-prompt has the chat model describe the scene
  (modes scene/character/face/user/background); the engine's /v1/images
  draws it into the asset store (/v1/assets/<sha>); POST /chats/:id/messages
  posts it as a hidden `picture` message (never in the prompt, never a swipe
  target) and it lands in the character's gallery. The tools plugin's
  built-in `generate_image` lets the model ask for one mid-reply; the client
  draws it after the reply commits.
- Character imports report imported/linked lorebooks and regex counts. Embedded
  scripts start disabled unless enableEmbeddedRegex is true; source-disabled scripts
  stay disabled. Both card and preset import paths extract scoped scripts. Character
  and preset editors expose switches; focusRegex/focusLorebook open the selected
  item directly. Opening a chat reports linked lore and scoped regex once per
  owner per page session, with review shortcuts. Regex search includes owner names and scope. URL imports also accept
  catalog JSON and additional PNG card sources declared in the import manifest.
  Explicit empty regex flags mean one replacement; missing legacy flags keep g.
  The display worker preserves flags and advances Unicode empty matches safely.
- Regex has two axes like the portable format: placement = where
  (user_input, ai_output, slash, wi, reasoning), markdownOnly/promptOnly =
  when. Neither flag rewrites text as it is SAVED (send, reply, greeting,
  edit with runOnEdit); markdownOnly is display-only (client); promptOnly
  runs at assembly (history + world info). Preset text is never regexed.
  Scripts saved before the flags read via regexAxes(). Imported cards and
  presets bring their embedded scripts as character/preset-scoped scripts.
- Macros: expandMacros(text, mc) in the engine plugin walks the text once, in
  document order, so a variable set earlier in the prompt is visible to
  everything after it (sections expand in prompt order and share one context).
  `{{name}}`, `{{name::a::b}}` and `{{name a}}` are calls; arguments are
  trimmed and may hold nested macros. Blocks: `{{if cond}}…{{else}}…{{/if}}`
  (also spelled `{{#if}}`), and the block forms of setvar / addvar /
  setglobalvar / addglobalvar / trim. A condition is false when it is empty,
  `0`, `false` or `off`; `!` negates; it can be a nested macro, a variable
  (`.name` chat-local, `$name` shared) or a bare macro name. Variable
  shorthand: `{{.name}}` reads, `{{.name = v}}` assigns, `+= -= ++ --` change,
  `== != > >= < <=` compare, `|| ??` fall back. Block output is trimmed and
  dedented unless the opener carries `#`. `{{// note}}` and
  `{{//}}…{{///}}` are comments. Anything unknown, a block missing its closer,
  or a variable call missing its name stays as written, so a typo shows up in
  the prompt peek instead of vanishing. Chat variables live in the chat meta
  (`chatVars`); shared variables live in `data/variables.json`. Both are only
  written when a turn is saved: a prompt peek works on copies, and a
  generation carries its changes in the stash until pass B. Deleting stores
  `null` so the write survives that merge, then the null is stripped. New
  macros go in the MACROS table; test/rp-macros.test.ts covers the language.
- Groups: groupTurnPlan() decides a turn. list = every unmuted member in
  order; natural = members named in the user's message, else one pick
  weighted by card talkativeness (never who just spoke). Send answers the
  first and returns `queue`; the client runs /next for the rest.
- The app page runs in a `sandbox="allow-scripts ..."` iframe (opaque origin):
  no cookies, no localStorage, `connect-src 'none'`. It is served cookieless
  from `/app/<user>/<app>/` (built in the browser with relative URLs).
  Every engine call goes through `client/app-bridge.js` to the shell's
  `app-bridge-host.js`, which allows only this app's routes plus models,
  images, audio, embeddings, assets and read-only catalogs. The shell's own
  localStorage backs the app's localStorage (snapshot rides the frame URL).
  Hot updates ride the same bridge (the app_built event). Never widen the host
  allowlist to agent/shell/settings/admin/mcp routes.
- MCP servers are engine-level: add and share them in Chrysalis settings.
  Each app starts with every shared server off and opts in per server
  (GET/PATCH /v1/apps/<app>/mcp[/<id>] {use}); an app cannot register
  servers of its own. Opted-in tools join tool-calling generations next to
  the tools plugin's.

## Layout

```
apps/roleplay/
├─ manifest.json        app identity (name/version — the engine registry)
├─ package.json         REAL npm deps (react 19, @base-ui/react, zustand,
│                       cmdk, sonner, react-markdown + katex/highlight.js,
│                       react-resizable-panels, @phosphor-icons/react; fonts via
│                       @fontsource-variable) — shadcn/ui on Base UI
├─ index.html           entry html (dark by default, favicon set)
├─ src/
│  ├─ main.tsx          mounts <AppShell/> (fonts + globals.css)
│  ├─ globals.css       tailwind v4 + shadcn tokens (light/dark) + RP prose
│  │                    classes (.mes_text q/em, .chat-column, quote styles)
│  ├─ components/
│  │  ├─ shell/         app-shell (rail, palette, hotkeys), master-detail,
│  │  │                 mobile-tab-bar
│  │  ├─ views/         home, chats, characters, personas, presets,
│  │  │                 lorebooks, quickreplies, regex, samplers, settings,
│  │  │                 connections, extensions + settings/* sections
│  │  ├─ chat/          chat-view, message-row, composer (+autocomplete,
│  │  │                 expanded editor), group dialogs, memory panel, …
│  │  ├─ character/     character editor pieces
│  │  ├─ ui/            shadcn components on Base UI (43 files)
│  │  ├─ markdown.tsx   react-markdown + gfm/math/highlight, quote tinting
│  │  └─ theme-applier.tsx  theme preset → CSS vars on <html>
│  ├─ hooks/            use-mobile
│  └─ lib/              store.ts (zustand+persist), types.ts, seed.ts,
│                       tokens.ts (real BPE counts, o200k), interop.ts
│                       (portable-format import/export), card-fields.ts, export.ts,
│                       image-gen.ts, lore-match.ts (which entries a text
│                       switches on), utils.ts (cn)
├─ plugins/             engine/ (chats, characters, presets, generation) +
│                       studio-import/ — import/marketplace backend; each
│                       plugin.js only re-exports, the code is in its src/
└─ data/                characters/, presets/, personas/, settings.json
```

## Editing the UI

React + tailwind — write what you know. shadcn/ui
components drop in natively (components.json: style base-nova, css
src/globals.css). Save a src/ file and the user's open tab hot-updates in
place (the build runs in their browser; errors show over the app and land in
dist/.chrysalis-build.json).
Dependencies install engine-side with scripts disabled: edit package.json and
call app_deps (remove one with app_deps { remove: ["name"] }). The sandbox has
no npm itself. After src/ or dependency edits, app_check waits for the browser
build and returns its errors.

## Engine contract (wired in v4.1)

All app behavior (chats, swipes, presets, world info, characters, import)
lives in plugins/ as engine plugins over the plugin API; the UI talks to
/v1/apps/roleplay/* routes and the WS bus (app_stream deltas for live
replies). Chats are flat JSONL with swipes; each character is one card.json.
src/lib/engine.ts owns every route call + the studio↔engine adapters; the store
actions are thin wrappers (optimistic write → API call → refresh). A feature
without a working backend is marked unavailable in the UI, never stubbed.

Plugin code is split by concern, and the header of each plugin.js maps it.
In the engine plugin, src/routes/index.js builds the request context
(`req`, `fsx`, `id`, `op`, `ok`, `err`, `readJson`, `writeJson`, `body`, …) and
tries each route group in order; a group returns a response, or `undefined`
to let the next one look. Per-chat routes (chat-messages.js, generate.js,
memory.js) get the loaded chat on the same object (`chat`, `meta`, `members`,
`onSave`, …), listed in CHAT_ROUTES in chats.js. A new route is a function in
the file it belongs to, added to ROUTES or CHAT_ROUTES. Values shared across
modules for one call live on `state` (src/state.js): an imported binding
cannot be assigned. Imports are relative and stay inside the plugin folder.

The plugins set `keepLoaded` in their manifests: the engine evaluates them
once and calls them again in place, so module scope outlives a call. Keep
module scope to constants; anything a call fills in goes on `state` and is
reset where handleRoute starts. Never keep `host` past its call (the engine
refuses a stale one).

## Agent-editable data (live sync, v4.2)

EVERYTHING lives in `data/` — one directory, plain JSON. This section is the
authoritative map (updates deliver this file; `data/README.md` is the copy a
fresh install seeds). Keep both in step. Small state is in TWO files:
`data/settings.json` (`ui` = the whole AppSettings) and `data/library.json`
(quick replies, themes, backgrounds, tags, folders, connection profiles).
`data/variables.json` holds the variables every chat shares (see Macros).
Big collections stay in their subdirectories (characters/ chats/ groups/
presets/ lorebooks/ regex/ personas/ databank/). The tree below is the summary:

EVERYTHING the studio shows lives in this app's `data/` tree as plain JSON —
you may read and edit any of it directly, and every open client picks your
changes up within ~a second (the engine's data watcher emits `look_changed`
on the WS bus; the app re-hydrates). No restart, no reload needed.

```
data/
├─ settings.json        { model, personaId, presetId, ui: {…} }  — `ui` is the ENTIRE
│                       AppSettings object (theme, fonts, hotkeys, TTS,
│                       translation, chat behavior…). Edit a key → the UI
│                       applies it live. (UI writes back on user changes.)
├─ variables.json       { name: value } shared macro variables (`{{$name}}`,
│                       getglobalvar / setglobalvar). Absent until one is set.
├─ characters/<id>/card.json   full character cards (portable card fields + `studio` bag:
│                       favorites, colors, stats, sprites, gallery, versions,
│                       descVariants/personalityVariants/scenarioVariants)
├─ chats/<id>.jsonl     one message per line; <id>.meta.json holds title,
│                       folderId, personaId, presetId, model, branch
│                       parentage (parentChatId/parentMessageId), summaryParts
│                       (one summary per compacted stretch) and summary
│                       (their text joined; edit it alone = one part),
├─ groups/<id>.json     { memberIds, mode, mutedIds }
├─ presets/<id>.json    portable shape (prompts[] + prompt_order[]) + `studio` bag
│                       (library, variables, samplers, utility prompts)
├─ lorebooks/<id>.json  world-info books (entries[], settings, vectorized)
├─ regex/<id>.json      regex scripts (find/replace/placements/flags)
├─ databank/<id>.json   { name, scope, enabled, size, chunks: [{i, text}] }
└─ personas/<id>.json   user personas
```

Card images are stored in `data/__media/<sha256>.<ext>`. Cards, personas and
other records reference `/v1/apps/<app>/__media/<name>` instead of inline image
bytes. Image writes deduplicate identical content and remove PNG text metadata.
The update hook migrates older character cards one at a time; failed migrations
retain the original card and retry when the library is read. PNG exports carry
the main image once, while portable JSON and backup exports resolve image refs.
Keep unknown metadata and timestamps during migration. Never remove shared
media just because one character was deleted.

Archive imports use the engine's `/__imports` upload jobs: 8 MB raw chunks,
disk-backed archive indexing, phase-ordered bounded entry batches, progress,
pause and resume by reselecting the same file. Limits are 32 GB compressed,
256 GB expanded and one million files. Large text entries are read in slices;
card images are limited to 64 MB and other binary entries to 256 MB. Oversized
images are reported rather than silently dropped. Temporary name lookups live
in `data/__lookup/` and are removed after import. Old engines use the legacy
path only for archives up to 16 MB; larger imports request an engine update.

Characters: alternates, versions, character-wide selection. Exact shapes:
- `card.studio.descVariants` / `personalityVariants` / `scenarioVariants`:
  `[{ id: "var_…", label, content }]`. The card's base `description` /
  `personality` / `scenario` stays the default; append to an array to add an
  alternate, never overwrite the base.
- `card.studio.versions`: `[{ id, label, savedAt, snapshot }]`, `snapshot`
  carrying `description`, `personality`, `scenario`, `firstMessage`,
  `exampleDialogue`, `systemPromptOverride`, `postHistoryInstructions`.
- The card selects alternates with `studio.variantSelection: { desc?,
  personality?, scenario? }` (values are variant ids; absent key = base text).
  The character editor changes this selection. Generation and prompt peek
  resolve through it in every chat.

Rules of thumb:
- JSON edits: keep the exact same shape the files already use; the app's
  hydrate is tolerant but not a migrator.
- The `studio` bags are the studio's own fields riding alongside public formats —
  copy them through untouched when rewriting a file.
- Editing `src/` instead rebuilds the app (~5 s) — that's for CODE changes;
  for content/settings always prefer `data/`.
- Writes you make through the app's own HTTP routes (POST /v1/apps/roleplay/…)
  commit to the app's git automatically; direct file edits stay pending until
  you commit them (or the engine sweeps them under an `out-of-band:` label).

## Section position and model browsing

`src/lib/view-memory.ts` keeps editor navigation in session storage, including
selected lorebooks/personas/presets, detail state, preset tabs, lore entries and
scroll positions. Explicit focus links override the remembered selection.
Connections tests the model in use through POST /connections/test with a fixed short prompt, without chat or preset data. The button reports measured response time or the provider error.
Connections renders 40 model rows initially and appends batches as its scroll
sentinel approaches the viewport; its search still filters the full catalog. Streaming state snapshots the requested model for message badges and
interrupted replies. Company icons are local paths with the license in
`licenses/model-icons.txt`.

Marketplace also supports Wyvern public search/detail/import through the import
plugin, preserving advanced greetings, embedded lore and regex. Image requests
use declared hosts. Hidden definition fields block imports. Source failures
surface as errors, and catalog counts/metrics come from the response.

Character Tavern uses serialized public page data for search and previews, with
deferred fields decoded from response chunks. Imports download the complete PNG
card. Guest content preferences remain the catalog's own. Marketplace previews
render sanitized Markdown without author styles, proxy remote images, and keep
import controls outside the scrolling content. Daily picks rotate by local
calendar day across the full library, independent of listing order.

Marketplace card tabs live in `marketplace-card-content.tsx`. Public lorebook
previews are bounded to 100 entries; the reported total and complete imports
remain intact. `ui/image-lightbox.tsx` is shared by chat portraits, attachments
and marketplace artwork, with pinch zoom and constrained panning.

New card imports set deferEmbeddedLore and preserve character_book. The shell queues Import / Later prompts from studio.embeddedLorebookPending. POST /import/embedded-lorebook persists the choice; Later creates no book, and importing links one book without overwriting existing books. The character editor can import retained lore later. Archive restores retain their existing import behavior.

Preset regex appears only as a compact shortcut for the active preset. RegexImportChoice supplies the Enable / Keep off dialog for preset and standalone imports. The Regex manager lists scripts in four fixed scope sections (Global, Preset, Character, Chat), each with a one-line hint, an enabled/total tally and its own add button; scoped sections group by owner, with the open chat's preset, character and chat marked current, sorted first and expanded, and scripts whose owner is unset or gone gathered in one group since they never run. Folders are sub-headings inside an owner. Each row has a direct switch, and each owner (and Global) has a menu to turn all on, turn all off or export. Adding from a scoped section assigns the current owner (addRegex takes an optional target). Collapse state is kept in view memory; folder metadata survives portable and engine saves. Sampler and bias sliders use full-width rows in narrow panels. Removing an imported extra sampler removes its forwarded field while preserving unrelated source metadata.

Tools uses one page scroller for its header, tab strip and Regex workspace. Regex passes pageScroll to MasterDetail and uses content-sized panes so nested scrollers do not trap the tab strip.

Presets and lorebooks share LibraryFolderTree (components/shell/library-folder-tree.tsx), which owns the sidebar's search box, New folder button, scroll area and rows: folders first, then items without a folder. The views pass renderLabel (row content) and renderMenu (their own menu items); the tree adds Move to. Rows are 28px (36px on mobile) and the whole row is the drag surface through lib/tree-drag.ts: press and move with a mouse, hold then move on touch, Escape cancels, the list scrolls at its edges, and a floating label follows the pointer. An item dropped between rows lands there, in that row's folder, shown as a line; dropped on a folder header (open or closed) it goes to the end of that folder. While an item is dragged a bar under the list offers No folder and New folder (the new folder holds the item and opens for naming). Item order is one id list per collection in settings.ui.libraryOrder (lib/library-order.ts): rows sort by it inside every folder, and items it has never seen follow in their stored sequence. A folder dragged past another header reorders, shown as a line. Folder dragging is off while searching. Children marked data-no-drag never start a drag. Folders are created with a unique default name and renamed in place (also double-click or F2); names stay unique per collection. Folder order is the order of library.folders (reorderFolders keeps other scopes' slots); open folders are kept in view memory. Folder headers show a check for the actual active preset, independent of editor selection. Folder membership uses preset studio.folderId and lorebook folderId. Deleting a folder clears membership without removing items. Stock presets allow folder placement while prompt content stays locked. Agents handle folders through the skills: library-editing adds folders (name and scope are required), preset-editing and lorebook-editing set and report folderId (checked against the folders of that list; a locked preset accepts only that change), preset inspection takes `folder` to list a folder's presets, and settings-editing patches ui.libraryOrder. data/_EDITING.md has the Folders and list order section.
