---
name: preset-editing
description: Inspect, read, create, or edit Roleplay presets, prompt sections, their text, enabled state, order, and generation settings. Use for questions about any field or section in a preset, including read-only requests.
---

# Presets

Resolve paths from this skill directory. The app root is `../../..`.
Presets are in `../../../data/presets/`.

## Inspect

Use `skill_inspect` with this skill name and these arguments:

```json
{"preset":"ff micro","section":"embellish"}
```

`preset` accepts a name, abbreviation, or exact ID. Optional `section` accepts
a name fragment or exact identifier. This finds the record and section in one
call; filenames do not need to be known. It returns content, enabled state,
placement, and agreement between portable/editor values. Without `section`, it
returns a compact section list; `includeContent:true` requests full text.
`fields` accepts stored JSON pointers, such as `/studio/samplers`, to inspect
any other preset control. The result includes the revision for editing.

When the requested field is returned, answer from it and stop. If multiple
presets match, show that field for each in a read-only request, or ask which one
to edit. Do not scan chats, settings, or unrelated sections to guess which copy
the user meant. Historical bindings cannot identify the user's current target.
If the returned copies disagree, report the disagreement. Inspection never
changes data. Quote requested text without silently correcting it.

If `skill_inspect` is unavailable, read the preset files to match their names
and select only the requested section. With shell access, the read-only fallback
is `node scripts/preset.mjs <preset-file> [section-identifier]`. Do not try shell
commands in plan mode or when no shell tool is offered.

## Stored shape

- Prompt keys are `identifier`, `name`, `role`, `marker`, and `content`, not `id`.
- Enabled state lives in the active `prompt_order[].order[]` entry, not on the
  prompt. Choose nonempty character layout `100001`, otherwise the first
  nonempty layout. Missing order means the prompts-list fallback.
- The matching editor section is `studio.sections[]`, keyed by `id`.
- Content and enabled edits must keep portable and editor representations
  synchronized. Preserve other layouts, opaque metadata, and unrelated fields.
- Array order and section `order` represent placement. A prompt outside the
  active layout is inactive even if it has a saved editor section.

For normal edits, use `skill_edit` with `preset`, optional `section`, the
inspected `revision`, and `patch:{content:"...",enabled:true}`. Section edits
also support name, role, position, depth, injectionTriggers, condition, groupId,
and forbidOverrides, keeping paired portable/editor values synchronized.
For preset-level controls omit section: `patch` changes ordinary portable
metadata (name is paired), `studio` changes editor-only controls, `samplers`
changes sampler controls using the UI shape, `utilityPrompts` changes both
copies, and `extendedSamplers` changes forwarded parameters and their editor
copy. Inspect these fields first. Creation uses `operation:"create",id` and
these same arguments with the preset template. Read back changed fields.
Stale revisions, locked presets, and ambiguous section mappings are refused.

If skill_edit is unavailable, the file helper accepts a final JSON patch argument:
`node scripts/preset.mjs <preset-file> <identifier> '{"content":"...","enabled":true}'`.
Prefer putting large text in a small task script that imports `editSection`
from this helper. The helper refuses locked presets and inconsistent section
mappings, writes atomically, and reads the result back. Avoid simultaneous UI
and file edits of the same preset.

For creating presets, changing order, samplers, markers, triggers, variables,
or bindings, read the Presets section of `../../../data/_EDITING.md` first.
Use `../../../data/_catalog.json` for routes and source types, and
`../../../data/_templates/_preset.json` as the starting shape for creation.
Set both top-level and studio IDs/names and use real creation timestamps.
Read saved values back; preserve existing fields instead of reconstructing the
record from a subset. Changes to data do not require editing app code.
