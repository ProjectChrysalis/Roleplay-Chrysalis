import { loadChat } from "../chat-files.js";
import { portableMedia } from "../media.js";
import { loadMemories } from "../memories.js";
import { regexAxes } from "../regex.js";
import { slug } from "../util.js";
import { isConstantEntry } from "../world-info.js";
import { buildZip } from "../zip.js";

export function backupRoute(c) {
  const { req, fsx, head, id, ok, readJson } = c;
  if (head === "export" && id === "backup" && req.method === "GET") {
    const files = [];
    const usedNames = new Set();
    // Names are deduped WITHIN a folder: a character and a book that share a
    // name are two different files in two different places, and renaming one
    // of them to "-2" only makes the zip harder to read.
    const unameIn = (dir, base, ext) => {
      let n = base + ext, i = 2;
      while (usedNames.has(dir + "/" + n)) n = base + "-" + i++ + ext;
      usedNames.add(dir + "/" + n);
      return n;
    };
    const uname = (base, ext) => unameIn("characters", base, ext);
    const chars = [];
    // anything that points at a book travels by its name: ids are minted
    // again on the machine that restores
    const bookNames = new Map();
    try {
      for (const f of fsx.list("lorebooks").filter((x) => x.endsWith(".json"))) {
        const b = readJson("lorebooks/" + f, null);
        if (b) bookNames.set(b.id || f.replace(/\.json$/, ""), b.name || f.replace(/\.json$/, ""));
      }
    } catch {}
    try {
      for (const cid of fsx.list("characters")) {
        const card = readJson("characters/" + cid + "/card.json", null);
        if (!card) continue;
        const file = uname(slug(card.name || cid), ".json");
        const backupCard = portableMedia(card, fsx);
        backupCard._lorebookNames = {
          embedded: (card.studio?.embeddedLorebookId && bookNames.get(card.studio.embeddedLorebookId)) || null,
          linked: (card.studio?.linkedLorebookIds || []).map((id) => bookNames.get(id)).filter(Boolean),
        };
        if (backupCard.extensions?.regex_scripts) {
          backupCard.extensions = { ...backupCard.extensions };
          delete backupCard.extensions.regex_scripts;
        }
        files.push({ name: "characters/" + file, text: JSON.stringify(backupCard, null, 2) });
        chars.push({ id: cid, slug: file.replace(/\.json$/, ""), name: card.name });
      }
    } catch {}
    const groups = [];
    const idToName = new Map(chars.map((c) => [c.id, c.name]));
    try {
      for (const gid of fsx.list("groups")) {
        // fsx.list returns full filenames ("grp_x.json") — don't append again
        const g = readJson("groups/" + (gid.endsWith(".json") ? gid : gid + ".json"), null);
        if (!g) continue;
        const file = uname(slug(g.name || gid), ".json");
        // _memberNames ride along so a restore can remap member ids after
        // characters are re-created under fresh (name-derived) ids
        const memberNames = (g.memberIds || []).map((mid) => idToName.get(mid) ?? null);
        // two cards can share a name; their files never do
        const memberFiles = (g.memberIds || []).map((mid) => chars.find((c) => c.id === mid)?.slug ?? null);
        files.push({ name: "groups/" + file, text: JSON.stringify({ ...g, _file: file.replace(/\.json$/, ""), _memberNames: memberNames, _memberFiles: memberFiles }, null, 2) });
        groups.push({ id: gid.replace(/\.json$/, ""), slug: file.replace(/\.json$/, ""), name: g.name });
      }
    } catch {}
    const presets = {};
    try {
      for (const f of fsx.list("presets").filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
        const preset = readJson("presets/" + f, null);
        if (preset) {
          const copy = { ...preset, extensions: { ...preset.extensions } };
          delete copy.extensions.regex_scripts;
          // the map is keyed by name; a second preset of the same name gets
          // its own key instead of replacing the first
          const base = preset.name || f.replace(/\.json$/, "");
          let key = base;
          for (let n = 2; Object.hasOwn(presets, key); n++) key = base + " (" + n + ")";
          presets[key] = copy;
        }
      }
    } catch {}
    if (Object.keys(presets).length) files.push({ name: "User Settings/openai_settings.json", text: JSON.stringify(presets, null, 2) });
    try {
      for (const f of fsx.list("regex").filter((x) => x.endsWith(".json"))) {
        const s = readJson("regex/" + f, null);
        if (!s) continue;
        const ax = regexAxes(s);
        const NUM = { user_input: 1, ai_output: 2, slash: 3, wi: 5, reasoning: 6 };
        const rid2 = unameIn("User Settings/regex", slug(s.scriptName || f), ".json").replace(/\.json$/, "");
        const scope = s.scope || "global";
        const target = scope === "character" ? readJson("characters/" + s.scopeTargetId + "/card.json", null)
          : scope === "preset" ? readJson("presets/" + s.scopeTargetId + ".json", null) : null;
        files.push({
          name: "User Settings/regex/" + rid2 + ".json",
          text: JSON.stringify({
            id: rid2, scriptName: s.scriptName || rid2,
            _studioScope: { scope, targetName: target?.name || null, chatId: scope === "chat" ? s.scopeTargetId : null, order: s.order ?? 0 },
            findRegex: "/" + String(s.findRegex || "").replace(/(?<!\\)\//g, "\\/") + "/" + (s.flags ?? "g"),
            replaceString: s.replaceString || "",
            trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings : [],
            placement: ax.where.map((p) => NUM[p]).filter(Boolean),
            disabled: s.disabled === true,
            markdownOnly: ax.markdownOnly, promptOnly: ax.promptOnly, runOnEdit: s.runOnEdit === true,
            substituteRegex: s.macroMode === "raw" ? 1 : s.macroMode === "escaped" ? 2 : 0,
            minDepth: s.minDepth ?? null, maxDepth: s.maxDepth ?? null,
          }, null, 2),
        });
      }
    } catch {}
    const presetNames = new Map();
    try {
      for (const f of fsx.list("presets").filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
        const p = readJson("presets/" + f, null);
        if (p) presetNames.set(p.id || f.replace(/\.json$/, ""), p.name || f.replace(/\.json$/, ""));
      }
    } catch {}
    const namesOf = (ids, map) => (Array.isArray(ids) ? ids.map((x) => map.get(x)).filter(Boolean) : []);
    // Personas travelled as a flat {name: description} map, so a restore
    // rebuilt them with the default avatar, no title, no pronouns, no bound
    // characters, no linked books and nothing marked default — which is what
    // made personas behave as if they had been reset on the second device.
    // The full record rides its own file; the flat map stays for other tools.
    let personas = {};
    try {
      for (const f of fsx.list("personas").filter((x) => x.endsWith(".json"))) {
        const p = readJson("personas/" + f, null);
        if (!p) continue;
        const name = p.name || f.replace(/\.json$/, "");
        personas[name] = p.description || "";
        files.push({
          name: "personas/" + unameIn("personas", slug(name), ".json"),
          text: JSON.stringify({
            ...p,
            name,
            _lorebookNames: namesOf(p.lorebookIds, bookNames),
            _boundNames: namesOf(p.boundCharacterIds, idToName),
          }, null, 2),
        });
      }
    } catch {}
    files.push({ name: "User Settings/personas.json", text: JSON.stringify(personas, null, 2) });
    try {
      for (const f of fsx.list("lorebooks").filter((x) => x.endsWith(".json"))) {
        const book = readJson("lorebooks/" + f, null);
        if (!book) continue;
        // to the public world-info shape: entries keyed by uid. EVERY field
        // the importer reads is written back, or a book that leaves in a
        // backup comes home without its timed effects, groups, recursion
        // flags or extra match sources.
        const entries = {};
        (book.entries || []).forEach((entry, i) => {
          const ms = entry.matchSources || {};
          entries[entry.uid != null ? entry.uid : i] = {
            uid: entry.uid != null ? entry.uid : i,
            key: entry.keys || [], keysecondary: entry.secondaryKeys || [],
            comment: entry.memo || entry.title || "",
            content: entry.content || "", constant: isConstantEntry(entry), selective: false,
            vectorized: entry.status === "vectorized",
            selectiveLogic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }[entry.selectiveLogic] ?? 0,
            order: entry.order ?? 100, position: { before_char: 0, after_char: 1, at_depth: 4 }[entry.position] ?? 1,
            depth: entry.depth ?? 4, role: { system: 0, user: 1, assistant: 2 }[entry.role] ?? 0,
            disable: entry.enabled === false,
            probability: entry.probability != null ? entry.probability : 100,
            useProbability: entry.probability != null && entry.probability < 100,
            excludeRecursion: entry.nonRecursable === true,
            preventRecursion: entry.preventFurtherRecursion === true,
            delayUntilRecursion: entry.delayUntilRecursion ?? false,
            ignoreBudget: entry.ignoreBudget === true,
            matchWholeWords: entry.matchWholeWords !== false,
            group: entry.group || "", groupOverride: entry.groupOverride === true,
            groupWeight: entry.groupWeight ?? 100,
            sticky: entry.sticky ?? 0, cooldown: entry.cooldown ?? 0, delay: entry.delay ?? 0,
            automationId: entry.automationId || "",
            matchCharacterDescription: ms.description === true,
            matchCharacterPersonality: ms.personality === true,
            matchScenario: ms.scenario === true,
            matchPersonaDescription: ms.persona === true,
          };
        });
        const bookName = book.name || f.replace(/\.json$/, "");
        files.push({
          name: "worlds/" + unameIn("worlds", slug(bookName), ".json"),
          text: JSON.stringify({
            name: bookName,
            entries,
            // book-level knobs the public world-info shape has nowhere to put:
            // scan depth, budget, recursion, and whether the book is global or
            // linked to particular cards. Without these a restored book came
            // back switched off and scanning with stock settings.
            _studio: {
              settings: book.settings ?? null,
              globalActive: book.globalActive === true,
              folderId: book.folderId ?? null,
              vectorized: book.vectorized === true,
              _linkedNames: namesOf(book.linkedCharacterIds, idToName),
            },
          }, null, 2),
        });
      }
    } catch {}
    // chats → per character/group folders, public jsonl chat shape
    try {
      for (const cid of fsx.list("chats").filter((f) => f.endsWith(".meta.json") && !f.startsWith("_"))) {
        const chat = loadChat(fsx, cid.replace(/\.meta\.json$/, ""));
        if (!chat || !chat.msgs.length) continue;
        const m = chat.meta;
        const ownerSlug = m.groupId
          ? (groups.find((g) => g.id === m.groupId) || { slug: slug(m.groupId) }).slug
          : (chars.find((c) => c.id === m.characterId) || { slug: slug(m.characterId || "chat") }).slug;
        const lines = chat.msgs.map((msg) => JSON.stringify({
          name: msg.name, is_user: msg.role === "user", is_system: msg.role === "system",
          send_date: new Date(msg.at || 0).toISOString(),
          mes: msg.text,
          swipes: msg.swipes && msg.swipes.length ? msg.swipes : [msg.text],
          swipe_id: msg.swipe || 0,
          // the public line shape has no room for a hidden turn, a bookmark, a
          // generated picture, a translation or the model/usage stamp — all of
          // it used to be dropped on export and could never come back
          extra: {
            chry_char_id: msg.charId || undefined,
            chry: {
              id: msg.id,
              ...(msg.hidden === true ? { hidden: true } : {}),
              ...(msg.bookmarked === true ? { bookmarked: true } : {}),
              ...(typeof msg.bookmarkLabel === "string" && msg.bookmarkLabel ? { bookmarkLabel: msg.bookmarkLabel } : {}),
              ...(msg.edited === true ? { edited: true } : {}),
              ...(msg.greeting === true ? { greeting: true } : {}),
              ...(msg.picture ? { picture: msg.picture } : {}),
              ...(msg.translation ? { translation: msg.translation } : {}),
              ...(msg.extra && typeof msg.extra === "object" ? { extra: msg.extra } : {}),
            },
          },
        }));
        const base = "chats/" + ownerSlug + "/" + unameIn("chats/" + ownerSlug, slug(m.title || m.id) + "-" + m.id, "");
        files.push({ name: base + ".jsonl", text: lines.join("\n") + "\n" });
        // The transcript alone loses everything ABOUT the conversation: which
        // preset and persona it rides, its model, its author's note, its
        // summary and memory cutoff, its folder and tags, which card variant
        // it sends, and where it branched from. A restore re-pinned every
        // chat to the default preset and no persona. The sidecar carries it,
        // with ids that don't survive the trip written out as names too.
        files.push({
          name: base + ".meta.json",
          text: JSON.stringify({
            ...m,
            title: m.title || "",
            // only a lock travels: an unlocked chat follows whatever is
            // current on the machine that restores it
            _presetName: m.presetLocked === true ? presetNames.get(m.presetId) ?? null : null,
            _personaName: (() => {
              const p = m.personaLocked === true && m.personaId ? readJson("personas/" + m.personaId + ".json", null) : null;
              return p ? p.name || null : null;
            })(),
            _lorebookNames: namesOf(m.lorebookIds, bookNames),
            _chatLorebookNames: namesOf(m.chatLorebookIds, bookNames),
          }, null, 2),
        });
        const memories = loadMemories(fsx, m.id);
        if (memories.length) files.push({ name: base + ".memories.json", text: JSON.stringify(memories, null, 2) });
      }
    } catch {}
    // the data bank rides along: its chunks are the retrieval index, and
    // rebuilding them means re-uploading every source document by hand
    try {
      for (const f of fsx.list("databank").filter((x) => x.endsWith(".json"))) {
        const d = readJson("databank/" + f, null);
        if (d) files.push({ name: "databank/" + unameIn("databank", slug(d.name || f.replace(/\.json$/, "")), ".json"), text: JSON.stringify(d, null, 2) });
      }
    } catch {}
    // settings.json used to be a three-field stamp, so a restore came up with
    // stock theme, fonts, hotkeys, TTS, translation and chat behaviour, and
    // library.json (quick replies, themes, backgrounds, tags, folders,
    // connection profiles) wasn't in the zip at all.
    files.push({
      name: "settings.json",
      text: JSON.stringify({
        app: "studio", exportedAt: new Date().toISOString(), version: 2,
        settings: readJson("settings.json", {}),
      }, null, 2),
    });
    files.push({ name: "library.json", text: JSON.stringify(readJson("library.json", {}), null, 2) });
    // shared variables are state a preset can depend on; an empty set is not worth a file
    const shared = readJson("variables.json", {});
    if (shared && typeof shared === "object" && Object.keys(shared).length) files.push({ name: "variables.json", text: JSON.stringify(shared, null, 2) });
    return ok({ filename: "studio-backup-" + new Date().toISOString().slice(0, 10) + ".zip", base64: buildZip(files.map((file) => { if (!/\.json$/.test(file.name)) return file; try { return { ...file, text: JSON.stringify(portableMedia(JSON.parse(file.text), fsx)) }; } catch { return file; } })) });
  }
}
