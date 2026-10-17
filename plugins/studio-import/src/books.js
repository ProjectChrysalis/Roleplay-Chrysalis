import { embeddedBookToWorld, keyList } from "./cards.js";
import { slug } from "./entries.js";

// world_info_position: 0 before-char, 1 after-char, 2 AN-top, 3 AN-bottom,
// 4 at-depth, 5 EM-top, 6 EM-bottom, 7 outlet. The studio engine models
// before/after/at_depth — everything else lands after the char block.
// entry role: 0 system, 1 user, 2 assistant.
export function normalizeBook(raw, fallbackName) {
  if (!raw || !raw.entries || typeof raw.entries !== "object") return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : (fallbackName || "imported-book");
  const LOGIC = ["AND_ANY", "NOT_ALL", "NOT_ANY", "AND_ALL"];
  const ROLE = ["system", "user", "assistant"];
  const entries = [];
  for (const e of Object.values(raw.entries)) {
    if (!e || typeof e !== "object") continue;
    const content = typeof e.content === "string" ? e.content : "";
    if (!content.trim()) continue;
    const stPos = typeof e.position === "number" ? e.position : 0;
    const pos = stPos === 0 ? "before_char" : stPos === 4 ? "at_depth" : "after_char";
    // the comment doubles as the entry title/memo — without it every imported
    // entry renders with a blank name
    const comment = typeof e.comment === "string" ? e.comment.trim() : "";
    const num = (v) => (typeof v === "number" ? v : undefined);
    entries.push({
      uid: typeof e.uid === "number" ? e.uid : undefined,
      title: comment || "Entry " + (entries.length + 1),
      memo: comment,
      keys: keyList(e.key), secondaryKeys: keyList(e.keysecondary),
      ...(typeof e.selectiveLogic === "number" && LOGIC[e.selectiveLogic] ? { selectiveLogic: LOGIC[e.selectiveLogic] } : {}),
      content, enabled: e.disable !== true,
      status: e.vectorized === true ? "vectorized" : e.constant === true ? "constant" : "normal",
      constant: e.constant === true,
      order: typeof e.order === "number" ? e.order : 100,
      position: pos,
      ...(pos === "at_depth" ? { depth: num(e.depth) ?? 4, role: ROLE[e.role] || "system" } : {}),
      // probability applies only when useProbability is on
      ...(e.useProbability !== false && typeof e.probability === "number" && e.probability < 100 ? { probability: e.probability } : {}),
      ...(e.group ? { group: String(e.group) } : {}),
      ...(num(e.groupWeight) != null ? { groupWeight: e.groupWeight } : {}),
      ...(e.groupOverride === true ? { groupOverride: true } : {}),
      ...(e.matchWholeWords === false ? { matchWholeWords: false } : {}),
      ...(e.excludeRecursion === true ? { nonRecursable: true } : {}),
      ...(e.ignoreBudget === true ? { ignoreBudget: true } : {}),
      ...(e.preventRecursion === true ? { preventFurtherRecursion: true } : {}),
      ...(e.delayUntilRecursion ? { delayUntilRecursion: num(e.delayUntilRecursion) ?? true } : {}),
      ...(num(e.sticky) != null ? { sticky: e.sticky } : {}),
      ...(num(e.cooldown) != null ? { cooldown: e.cooldown } : {}),
      ...(num(e.delay) != null ? { delay: e.delay } : {}),
      ...(e.automationId ? { automationId: String(e.automationId) } : {}),
      ...(e.matchCharacterDescription || e.matchCharacterPersonality || e.matchScenario || e.matchPersonaDescription ? {
        matchSources: {
          description: e.matchCharacterDescription === true,
          personality: e.matchCharacterPersonality === true,
          scenario: e.matchScenario === true,
          persona: e.matchPersonaDescription === true,
        },
      } : {}),
    });
  }
  return entries.length ? { name, entries } : null;
}

export function importEmbeddedBook(card, book, writeJson, uid, summary) {
  const world = book ? embeddedBookToWorld(book) : null;
  if (world) {
    const n = normalizeBook(world, (typeof book.name === "string" && book.name) || card.name + " lore");
    if (n) {
      n.isEmbedded = true;
      // card-spec book-level knobs — full settings shape so the client's
      // replace-on-read doesn't lose the other defaults
      const st = { scanDepth: 4, contextPercent: 25, budgetCap: 0, minActivations: 0, maxRecursion: 2, insertionStrategy: "character_first", caseSensitive: false, wholeWords: true, groupScoring: false, recursiveScan: true, includeNames: true, overflowAlert: true };
      if (typeof book.scan_depth === "number" && book.scan_depth >= 0) st.scanDepth = Math.floor(book.scan_depth);
      if (book.recursive_scanning === false) st.recursiveScan = false;
      n.settings = st;
      const id = uid(slug(n.name), "lorebooks");
      writeJson("lorebooks/" + id + ".json", { ...n, id });
      summary.lorebooks.push(id);
      card.studio = { ...card.studio, embeddedLorebookId: id };
    }
  }
}
