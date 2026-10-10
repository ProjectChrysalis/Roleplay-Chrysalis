---
name: lorebook-editing
description: Inspect, create, or edit lorebooks, world information, lore entries, activation keys, entry content, insertion controls, and lore budgets. Use for read-only questions about these records as well as requested changes.
---

# Lorebooks

Use this app's `skill_inspect` and `skill_edit` with name `lorebook-editing`. Resolve fallback file paths from this skill directory; the app root is `../../..`.

## Inspect first

Call `skill_inspect` with arguments like `{"query":"book-name-or-id","item":"entry-title-or-id"}`. If the user identifies a record, pass it as query immediately; omit query to list only when the target is unknown. A query matches an exact ID or name words; use the returned exact ID when editing. `fields` selects stored JSON pointers, such as `/settings/scanDepth`; `fields:[""]` reads a whole record only when needed. No field is silently replaced with a default. Missing fields and malformed records are reported. Item collections and messages use `offset` and `limit` (1 to 50). Listings return names, paths, and revisions without dumping all text.

Answer once the requested facts are returned. If names are ambiguous, show relevant matches for a read-only question or ask which exact record to change. Do not search unrelated chats or defaults to guess the current selection. Follow pagination rather than assuming the first page is everything.

## Edit the resolved record

Pass `query` (when applicable), the inspected `revision`, and `patch` to `skill_edit`. Use stored property names in patch, not JSON pointers: `patch:{"content":"new entry text"}`. A key such as `"/disabled"` is invalid in a patch. Object patches merge deeply and preserve unknown fields. Arrays explicitly supplied in a patch replace that array; preserve unrequested elements. Null clears a nullable field; do not substitute false or an empty string. A stale revision fails: inspect again and reconcile the newer values instead of blindly retrying. Read the changed fields back to verify the result. Do not edit code for a data change.

When the user names both book and entry, pass query and item together in the first inspection rather than dumping /entries. With item selected, `results[].items[]` contains the full stored entries, including content and enabled. Answer directly from these values and stop. The `fields` argument selects paths in the stored book, not paths in the inspection result envelope; never use `/items/...` as a field path. Entry identity is uid or id. status chooses normal, constant, or vectorized; do not replace it with a legacy constant boolean. Runtime stored names include keys, secondaryKeys, selectiveLogic, position, order, probability, enabled, and settings. UI types translate some names; inspect stored values before editing. item selects one entry by ID or unique title/memo. add-item uses the entry template with a new unique uid; remove-item deletes only the selected entry. Editing embedded character_book lore in a card needs character-editing and that existing extension shape.

Creation uses `operation:"create",id:"new-unique-id",patch:{...}`. Start from the entity template, set the requested real values, and preserve its schema. IDs must be path-safe and existing files are never overwritten.

For a nested item, supply `item` and patch only the requested fields. `operation:"add-item"` creates an item; `operation:"remove-item"` removes it. Inspect the existing collection and relevant schema before changing structure.

Whole-record deletion and operations with side effects must follow the existing entity route and its binding cleanup; do not just unlink a data file.

## Additional fields and fallback

The helper can inspect any stored field and merge unknown extension fields without discarding them. For unfamiliar controls, read only the matching entity section of `../../../data/_EDITING.md`, its entry in `../../../data/_catalog.json`, and the indicated types/adapter or route. Runtime file fields can differ from UI names. Never guess a translation or rebuild a record from a subset.

If these tools are unavailable on an older engine, use those paths and the same preserve-and-verify rules with its existing read/edit tools. This skill is optional app content, not a data migration; existing records need no conversion. Plan mode can inspect but cannot save.
