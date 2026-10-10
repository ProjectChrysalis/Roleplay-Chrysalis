# data/ — the ENTIRE app, in this one directory

For agent inspection and editing, load the matching focused skill from
`../.agents/skills/`. Use its inspector and revision-checked editor first.
For unfamiliar fields or creation, consult `_catalog.json` and the matching
section of `_EDITING.md`. Starting records for templated entities live in
`_templates/`; structural chat actions use the existing app routes. Copy a
template to a new unique ID and set real timestamps; preserve existing records
when editing. Preset portable prompt text/order and studio sections must agree.
UI edits retain opaque metadata, and refreshes wait for pending saves.

Everything the Roleplay studio shows lives here as plain JSON. Read or edit
any file; every open client picks your changes up live within ~1 second (the
engine watches this tree and broadcasts `look_changed`; the app re-hydrates).
No restart, no reload. Keep shapes identical when editing — hydrate is
tolerant, not a migrator. `studio` bags inside files are the studio's own fields
riding alongside public formats: copy them through untouched.

| Path | What's inside |
|---|---|
| `settings.json` | `{ model, personaId, ui }` — `ui` is the WHOLE AppSettings object: theme preset, chat font + scale, hotkeys, display/chat/streaming behavior, TTS, translation, `summary` (mode/interval/word budget, prompt, injection position/template), memory, `notifications` (master switch, popup types and areas), `notificationPosition` (popup position, bottom-center by default)… edit any key and the UI applies it live. |
| `library.json` | `{ qrSets, themes, backgrounds, tags, folders, connectionProfiles }` — every local collection in ONE file: quick-reply sets (incl. auto-execute hooks), theme palettes, chat backgrounds, tags, folders, connection profiles (named connection+model pairs). |
| `characters/<id>/card.json` | Full character cards: portable card fields (name, description, personality, scenario, first_mes, alternate_greetings, mes_example, tags…) + `studio` bag (avatar, favorites, colors, stats, sprites, gallery, versions, variants). |
| `chats/<id>.jsonl` + `.meta.json` | One message per line (swipes, per-message `translation`, hidden/bookmarked flags); meta holds title, folderId, persona/preset/model, author's note, `summary` + `memoryCutoffMessageId` (what the summarizer covers / what the prompt drops), `chatVars` (chat-local {{setvar}}/{{getvar}} variables), branch parentage (parentChatId/parentMessageId). |
| `groups/<id>.json` | Group chats: `{ memberIds, mode, mutedIds }`. |
| `presets/<id>.json` | Portable prompt-list shape (`prompts[]` + `prompt_order[]`) + `studio` bag (prompt library, variables, sampler objects, utility prompts). `studio.readOnly` controls whether the UI can edit it. |
| `lorebooks/<id>.json` | World-info books: entries (keys, positions, probability…), scan settings, vectorization config. Entry `status` is the source of truth: `"normal"` (keyed), `"constant"` (always injected), `"vectorized"` (embedding match). Don't write the legacy `constant` boolean — when both exist, `status` wins. |
| `regex/<id>.json` | Regex scripts: find/replace, flags, placements (which surfaces they touch). |
| `personas/<id>.json` | User personas: name, description, pronouns, bindings. |
| `databank/<id>.json` | Data-bank documents: `{ name, scope, enabled, size, chunks: [{i, text}] }`. The engine chunks uploaded text (1000 chars, 150 overlap) and injects the top term-matching chunks into the prompt when a message is sent. |

## Characters: alternates, versions, character-wide selection

- `card.studio.descVariants` / `personalityVariants` / `scenarioVariants`:
  `[{ id: "var_…", label, content }]` — alternates for the three always-resident
  text fields. The card's base `description` / `personality` / `scenario` stays
  the default; add an alternate by appending to the array, never by overwriting
  the base.
- `card.studio.versions`: snapshots `[{ id, label, savedAt, snapshot }]` where
  `snapshot` carries `description`, `personality`, `scenario`, `firstMessage`,
  `exampleDialogue`, `systemPromptOverride`, `postHistoryInstructions`.
- The card selects alternates with `studio.variantSelection: { desc?,
  personality?, scenario? }`, values are `studio.<field>Variants[].id`.
  An absent key means the card's base text. The character editor changes this
  selection. Generation and prompt peek resolve through it in every chat.

Rules of thumb:
- Content/settings changes → edit here. CODE changes → `../src/` (triggers a
  ~5 s rebuild instead).
- Writes through the app's HTTP routes (`/v1/apps/roleplay/*`) auto-commit to
  the app's git; direct file edits commit when the engine next sweeps (under
  an `out-of-band:` label) or when you commit them yourself.
- Deleting a file removes the entity on the next hydrate.
- Files/dirs whose name starts with `_` are AI-ONLY TEMPLATES: the app never
  lists them in the UI. Copy one to a non-underscore name to make the entity
  real (it appears live). `_example.json` in `lorebooks/`, `regex/` and
  `databank/` shows the exact current shape — start from it. `groups/` appears
  once you create a first group chat.

Thinking history lives in `preset.studio.samplers.reasoning.history`: `preserve`
(default) replays saved thinking and native signatures with the same provider, API
and model; `individual` sends reply text only. Messages keep native replay data in
`extra.replay` and each swipe’s `extra.swipeMeta` entry. Use the message routes to
edit or remove thinking so signatures and swipe metadata stay consistent.
