# Editing Roleplay data

Start with `_catalog.json` for file paths, routes, templates, and authoritative
source types. `_templates/` contains complete starting records for characters,
personas, presets, groups, lorebooks, regex, settings, library, and data bank.
Templates never appear in the app. Existing records are the source of truth.

## Create or edit

1. Read the existing record before changing it. For a new record, copy its
   template, choose a unique ID using letters, digits, `_`, and `-`, and replace
   its example name and text. The ID must not begin with `_`.
2. Use the catalog's path. Character IDs are directory names; other entity IDs
   match the JSON filename and its `id`. Presets also have `studio.id`.
3. Set creation timestamps to the actual current Unix time in milliseconds.
   Template zero timestamps mean unset, not a historical creation date.
4. Keep every field you did not edit, including nulls, unknown metadata,
   `extensions`, and `studio`. Deeply merge nested objects; replacing a bag
   with one field destroys the rest of it.
5. Write complete, valid JSON atomically through a temporary sibling and
   rename, or use the app route. `PUT` replaces generic entities; `PATCH`
   merges top-level fields. Character `PUT` merges the incoming card with the
   stored card. An explicit empty string or array clears an editable field.
6. Read the saved record back. Check referenced IDs exist and inspect the UI
   or prompt preview when changing prompt behavior. Open clients sync after
   pending UI saves finish. Avoid editing the same entity simultaneously in
   the UI and through files.

Do not edit code to change a bot's writing or a user's preferences. Do not
replace live settings/library with a template. Do not create chats by writing
transcript files; use the chat routes so metadata and messages stay consistent.

## Characters (bots)

`characters/<id>/card.json` is a flat card, not an outer `{data: ...}` envelope.
The directory supplies its ID. Text supports `{{char}}` and `{{user}}` macros.

| Stored field | Meaning / UI field |
|---|---|
| `name` | Character name |
| `description`, `personality`, `scenario` | Resident character text |
| `first_mes`, `alternate_greetings`, `group_only_greetings` | First message, alternate greetings, group greetings |
| `mes_example` | Example dialogue; this is the stored key, not `example_dialogue` |
| `system_prompt`, `post_history_instructions` | Overrides for main / post-history prompt sections |
| `creator_notes`, `creator`, `character_version`, `tags` | Author-facing metadata |
| `spec`, `spec_version`, `extensions`, `character_book` | Format and opaque imported data; preserve |
| `avatar` | Stored media reference; keep existing references |
| `studio.altAvatars`, `gallery`, `expressions`, `defaultExpression` | Alternate avatars, gallery records, expression images |
| `studio.favorite`, `folderId`, `colors`, `stats`, `css` | Browser/display customization; CSS applies in the character's chat |
| `studio.createdAt`, `importedAt`, `lastChatAt` | Actual millisecond timestamps; do not invent import or chat activity |
| `studio.embeddedLorebookId`, `linkedLorebookIds`, `characterRegexIds` | IDs of bound books/scripts |
| `studio.voiceProvider`, `voiceId` | Speech binding |
| `studio.depthPrompt` | `{text, depth, role}`; role is system, user, or assistant |
| `studio.descVariants`, `personalityVariants`, `scenarioVariants` | Arrays of `{id, label, content}` |
| `studio.variantSelection` | `{desc?, personality?, scenario?}` with variant IDs; missing = base text |
| `studio.versions` | `{id, label, savedAt, snapshot}` records; snapshot uses UI names (`firstMessage`, `exampleDialogue`, etc.) |

Keys after a `studio.` key in the table remain inside `studio`. The character
schema and all nested field types live in `src/lib/types.ts` (`Character`).
Wire mappings live in `src/lib/engine.ts` (`characterToCard`). UI edits keep
unknown card/studio fields and explicit clears. Images use
`/v1/apps/<app>/__media/<hash>.<ext>`; the app's media/import routes create them.
Do not embed large base64 images in agent-authored cards.

## Personas

`personas/<id>.json` stores `id`, `name`, `avatar`, `title`, `description`,
`pronouns`, `lorebookIds`, `folderId`, `binding`, `boundCharacterIds`, `autoLock`,
and `createdAt`. Binding is `default`, `character`, or `chat`; bound character
IDs refer to existing cards. Description is the persona text used in prompts.

The global default is **`settings.json.personaId`**, not a persona's
`isDefault` flag. A chat's `personaId` selects its persona independently.
Changing the global default does not rewrite historical speaker text.

## Presets

`presets/<id>.json` stores the portable prompt list and a complete `studio`
editor bag. Copy `_templates/_preset.json` for a new editable preset, then set
`id`, `name`, `studio.id`, and `studio.name`. Respect `studio.readOnly` when
editing an existing preset; create an editable copy of a locked preset. `studio.isDefault` selects the
working default. Keep at most one default and inspect chat `presetId` bindings
when switching it. New presets do not affect an existing chat until selected.

### Prompt text and order

- `prompts[]`: `{identifier, name, role, marker, content, injection_position?,
  injection_depth?}`. Identifiers must be unique and match order entries.
- `prompt_order[]`: `{character_id, order:[{identifier, enabled}]}`. The active
  layout is the nonempty `100001` layout when present, otherwise the first
  nonempty layout, otherwise the prompts list. Keep other layouts intact.
- `studio.sections[]`: `{id, name, enabled, role, marker, content, position,
  depth, order, injectionTriggers, forbidOverrides, groupId, condition}`.
  Match `id` to the prompt identifier; order is the array's zero-based index.
- Add/remove/reorder a section in the active order **and** in studio.sections.
  Edit its text in `prompts[].content` and `studio.sections[].content`.
  A section not in the active order is not injected.
- Portable `marker` is a boolean. Studio `marker` is a marker name or null.
  Custom text uses `marker:false` / `marker:null`. Resident markers include
  `main`, `nsfw`, `charDescription`, `charPersonality`, `scenario`,
  `personaDescription`, `dialogueExamples`, `worldInfoBefore`, `worldInfoAfter`,
  `chatHistory`, `postHistory`, `summary`, and `depthPrompt`.
  Studio names differ for `personality`, `persona`, `exampleDialogue`,
  `wiBefore`, `wiAfter`, and `jailbreak`; copy the template's pair.
- Relative position: studio `position:"relative"`, omit portable injection
  position/depth. In-chat position: studio `position:"in-chat"`, portable
  `injection_position:"absolute"`, with matching depth.
- Studio `injectionTriggers` lists generation types: `normal`, `continue`,
  `impersonate`, `swipe`, `regenerate`, `quiet`. `forbidOverrides` blocks card
  overrides of the section. Keep unknown prompt and order metadata.
- `studio.library` contains inactive saved sections; `groups` organizes
  sections; `variables` holds preset variables; `condition` gates a section.
  Consult `PromptSection`, `SectionGroup`, and `PromptVariable` for exact types.

### Generation settings

| Portable value | Studio sampler |
|---|---|
| `temperature`, `top_p`, `top_k`, `min_p` | Same key, `{value, enabled}` |
| `repetition_penalty`, `frequency_penalty`, `presence_penalty` | `rep_pen`, `freq_pen`, `pres_pen`, `{value, enabled}` |
| `openai_max_tokens`, `openai_max_context` | `maxTokens`, `contextSize` |
| `seed`, `stop` | `seed`, `stopStrings` |

Keep both copies consistent. Disabled samplers omit their portable value;
otherwise a stale portable number re-enables them on load. `0` is a valid
number. `studio.samplers.reasoning` controls effort, thinking budget/tags and `history`
(`preserve`, the default, or `individual` for reply-only thinking);
`cache`, `streaming`, and `assistantPrefill` live in the same bag. Extended
samplers live in `studio.extendedSamplers` and their forwarded portable keys.
Use actual model limits, not guessed values.

`utilityPrompts` (impersonation, continueNudge, newChat, groupNudge, emptySend)
lives at top level and in studio. Preserve both. Other editor behavior lives
in `studio`: `namesBehavior`, `verbosity`, `continuePrefill`,
`squashSystemMessages`, `compactHistory`, `promptPostProcessing`, `promptFormat`,
`folderId`, `picture`, and `createdAt`. Copy their full template shapes and
read `Preset` / `SamplerSettings` for all nested options. Unknown metadata and
inactive prompt layouts survive UI edits.

## Other data

- Lorebooks: template has entry matching, insertion, and scan settings. Entry
  `status` is `normal`, `constant`, or `vectorized`; do not add the obsolete
  `constant` boolean. Bind books by actual IDs on characters, personas, or chats.
- Regex: template includes placement/scope and prompt/display flags. Keep
  scripts scoped as intended; display replacements do not rewrite saved text.
- Groups: use existing character IDs in `memberIds`; `mode` is `natural` or
  `list`. Generation mode is `swap` or `append`. Muted IDs must be group members.
- Settings: edit individual keys of `settings.json.ui`; preserve the model and
  persona selection. `_templates/_settings.json` shows every seeded option.
- Library: edit the chosen collection in `library.json`; preserve all others.
  Templates show the shared shape. Quick-reply definitions and automation
  fields use `QuickReplySet` in `src/lib/types.ts`.
- Data bank: create chunks through `POST /databank` with
  `{name, content, scope}`. Set `scopeTargetId` with `PATCH /databank/<id>`
  after creation. The plugin reports actual size and chunks. Do not invent
  embedding, size, or retrieval statistics.

Source types are authoritative when a future feature adds fields. A template
is a starting record, not validation of arbitrary imported data. Always retain
fields you do not recognize.

## Focused agent skills

The app advertises separate skills for characters, personas, presets, lorebooks,
regex, chats, groups, settings, library collections, and data-bank documents.
Only descriptions are initially shown; load the skill that matches the task.
A cross-entity request may need more than one skill, but reading a lore entry
should not load every other schema.

Each skill provides a bounded inspector and a revision-checked editor. Prefer
these to repeatedly searching JSON files: inspect the requested record/fields,
resolve ambiguous names, then edit using its revision. The engine runs both
modules with read-only data access. An editor returns a write plan; the engine
checks its file paths, JSON, and expected revisions before saving. App helpers
preserve fields and enforce the relevant schema rules. Inspect saved fields to
verify the requested change. Plan mode only inspects.

Supporting source is in `.agents/lib/` and each skill's `*.source.js`. Run
`bun run build:skills` after changing a helper to regenerate the self-contained
`inspect.js` and `edit.js` modules. No helper executes merely because a skill
was discovered or loaded. Older engines can follow SKILL.md and this guide
with their existing file tools; skills do not change stored data formats.

Chat metadata and transcript revisions are separate. Literal message text
patches synchronize the active swipe and preserve inactive swipes and extra
metadata. They bypass edit-time regex and script side effects; structural chat
actions and the complete UI edit pipeline must follow the existing app routes.
Data-bank document content must be supplied as original text, not reassembled
from overlapping chunks. Large records that exceed a helper limit must use
the existing route/file tools; never truncate them to make a write fit.
