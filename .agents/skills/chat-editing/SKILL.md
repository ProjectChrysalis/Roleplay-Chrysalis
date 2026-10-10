---
name: chat-editing
description: Inspect or edit chats, conversation metadata, individual messages, message text, bookmarks, hidden flags, swipes, and chat bindings. Use for read-only questions about these records as well as requested changes.
---

# Chats

Use this app's `skill_inspect` and `skill_edit` with name `chat-editing`. Resolve fallback file paths from this skill directory; the app root is `../../..`.

## Inspect first

Call `skill_inspect` with arguments like `{"query":"exact-chat-id","message":"exact-message-id"}`. If the user identifies a record, pass it as query immediately; omit query to list only when the target is unknown. A query matches an exact ID or name words; use the returned exact ID when editing. `fields` selects stored JSON pointers, such as `/settings/scanDepth`; `fields:[""]` reads a whole record only when needed. No field is silently replaced with a default. Missing fields and malformed records are reported. Item collections and messages use `offset` and `limit` (1 to 50). Listings return names, paths, and revisions without dumping all text.

Answer once the requested facts are returned. If names are ambiguous, show relevant matches for a read-only question or ask which exact record to change. Do not search unrelated chats or defaults to guess the current selection. Follow pagination rather than assuming the first page is everything.

## Edit the resolved record

Pass `query` (when applicable), the inspected `revision`, and `patch` to `skill_edit`. Use stored property names in patch, not JSON pointers: `patch:{"text":"exact new text"}`. A key such as `"/disabled"` is invalid in a patch. Object patches merge deeply and preserve unknown fields. Arrays explicitly supplied in a patch replace that array; preserve unrequested elements. Null clears a nullable field; do not substitute false or an empty string. A stale revision fails: inspect again and reconcile the newer values instead of blindly retrying. Read the changed fields back to verify the result. Do not edit code for a data change.

`query` identifies the chat; `chat` is accepted as an alias. When the user gives both chat and message IDs, inspect them together rather than first reading just the title. Metadata lives in chats/{id}.meta.json; messages live in chats/{id}.jsonl, one object per line. Do not confuse a chat with agent conversations. Inspect with messages:true and offset/limit, or message: an exact message ID. Message edits require both revision and transcriptRevision. patch can change text, hidden, bookmarked, bookmarkLabel, translation, or extra. Text edits update the active swipe, mark edited, clear translation, and preserve other swipes, reasoning, usage, timestamps, and metadata. These are literal text edits; they do not execute regex-on-edit, macro expansion, or script side effects. For the UI edit pipeline, chat creation, generation, swipe switching, message insertion/deletion, branch/fork/rewind, or variable recalculation, read the exact existing route in plugins/engine/plugin.js and use that behavior. Never reconstruct a transcript from only its visible text. Chat bindings are explicit metadata, not proof of the user's current open chat.

## Additional fields and fallback

The helper can inspect any stored field and merge unknown extension fields without discarding them. For unfamiliar controls, read only the matching entity section of `../../../data/_EDITING.md`, its entry in `../../../data/_catalog.json`, and the indicated types/adapter or route. Runtime file fields can differ from UI names. Never guess a translation or rebuild a record from a subset.

If these tools are unavailable on an older engine, use those paths and the same preserve-and-verify rules with its existing read/edit tools. This skill is optional app content, not a data migration; existing records need no conversion. Plan mode can inspect but cannot save.
