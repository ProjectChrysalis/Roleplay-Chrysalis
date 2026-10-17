/**
 * Studio Engine — the three-pane chat studio backend.
 *
 * Data layout (under the app's data/ dir, git-tracked, agent-editable):
 *   characters/<id>/card.json        personas/<id>.json
 *   presets/<id>.json                regex/<id>.json
 *   groups/<id>.json                 lorebooks/<id>.json
 *   chats/<id>.jsonl + <id>.meta.json
 *   settings.json {model, personaId}
 *
 * Messages are a FLAT list with per-message swipes (classic studio shape):
 *   {id, name, charId, role: "user"|"char", text, at, swipes:[], swipe,
 *    extra?: {model, usage}}
 * Chat meta: {id, title, characterId, groupId, presetId, presetLocked,
 *   personaId, personaLocked, model, authorNote, lorebookIds, createdAt,
 *   updatedAt, tainted}. presetId/personaId only count while locked.
 *
 * Presets keep the import/export shape users already have: prompts[] +
 * prompt_order[] with markers (main, charDescription, chatHistory, ...) and
 * flat sampler fields (temperature, top_p, openai_max_tokens, ...).
 *
 * Routes (/v1/apps/studio/...): characters/personas/presets/regex/groups/
 * lorebooks CRUD · settings · chats (list/create/get/patch/delete) ·
 * chats/:id/{send,swipe,continue,impersonate,next} · messages patch/delete ·
 * prompt/preview · export/backup (zip, stored entries).
 *
 * Two-phase contract: generation routes return {__llmPending:true} WITHOUT
 * writing; the kernel executes host.llm requests and re-invokes with
 * host.llm.results populated; only then are messages committed. Passes are
 * stateless re-reads of the chat files.
 *
 * Code layout (plugin.js only re-exports):
 *   src/routes/index.js   handleRoute: request context, then each route group
 *   src/routes/*.js       one group per file; chats.js loads the chat and hands
 *                         per-chat routes (chat-messages, generate, memory)
 *                         the chat context
 *   src/prompt.js         prompt assembly; world-info, macros, regex,
 *                         variables, memories, vectors feed it
 *   src/state.js          values shared for one call (reset per request)
 *   src/upgrades.js       onAppUpdate data upgrades
 */

export { handleRoute } from "./src/routes/index.js";
export { onAppUpdate } from "./src/upgrades.js";

export const TOOLS = [];
