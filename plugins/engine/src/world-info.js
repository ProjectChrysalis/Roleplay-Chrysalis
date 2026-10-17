import { esc } from "./util.js";
import { cosine, loadBoundBooks, loadWiVectors } from "./vectors.js";

const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
function keyMatch(scan, key, entry, rawScan) {
  const k = String(key || "").trim();
  if (!k) return false;
  // case-sensitive books/entries match against the RAW text (the shared scan
  // text is pre-lowercased for the case-blind default)
  if (rawScan != null && entry && (entry.caseSensitiveOverride === true || entry.caseSensitive === true)) {
    if (k.length > 2 && k.charCodeAt(0) === 47) return false; // regex keys stay case-blind
    return rawScan.includes(k);
  }
  // regex keys: "/pattern/flags" strings (community books) or a per-entry
  // flag marking every key as a pattern (books authored in the app). The scan
  // text is lowercased, so patterns default to case-blind.
  if (k.length > 2 && k.charCodeAt(0) === 47) {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(k);
    if (m) {
      try { return new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i").test(scan); } catch { /* bad pattern: fall through */ }
    }
  } else if (entry && entry.keysRegex === true) {
    try { return new RegExp(k, "i").test(scan); } catch { /* bad pattern: fall through */ }
  }
  const whole = entry ? (entry.wholeWordsOverride === true ? true : entry.wholeWordsOverride === false ? false : entry.matchWholeWords !== false) : true;
  const lk = k.toLowerCase();
  if (whole && /^[\w\s'-]+$/.test(k)) {
    try {
      return new RegExp("(^|[^\\p{L}\\p{N}])" + esc(lk) + "([^\\p{L}\\p{N}]|$)", "u").test(scan);
    } catch {
      return scan.indexOf(lk) >= 0;
    }
  }
  return scan.indexOf(lk) >= 0;
}
/** Constant-ness: the `status` field is the source of truth; the `constant`
 *  boolean is a legacy mirror kept for old files. When both are present they
 *  must agree — reading status first keeps injection and the UI in lockstep
 *  even for hand-edited files. */
export function isConstantEntry(entry) {
  return entry.status != null ? entry.status === "constant" : entry.constant === true;
}
function wiEntryFires(entry, scanText, rawText) {
  const keys = entry.keys || [];
  const secondary = entry.secondaryKeys || [];
  const logic = WI_LOGIC[entry.selectiveLogic] != null ? WI_LOGIC[entry.selectiveLogic] : 0;
  const caseBlind = !(entry && (entry.caseSensitiveOverride === true || entry.caseSensitive === true));
  const raw = caseBlind ? null : rawText;
  if (!keys.some((k) => keyMatch(scanText, k, entry, raw))) return false;
  if (secondary.length) {
    const hits = secondary.filter((k) => keyMatch(scanText, k, entry, raw)).length;
    if (logic === 0 && hits < 1) return false;
    if (logic === 3 && hits < secondary.length) return false;
    if (logic === 2 && hits > 0) return false;
    if (logic === 1 && hits === secondary.length) return false;
  }
  if (entry.probability != null && entry.probability < 100 && Math.random() * 100 >= entry.probability) return false;
  return true;
}
/** One winner per inclusion group among this pass's newly fired entries:
 *  a sticky-active member outranks everything, then an override flag, then a
 *  weighted roll by groupWeight (default 100). */
function wiFilterInclusionGroups(list, stickyActive) {
  const groups = new Map();
  for (const item of list) {
    const names = typeof item.entry.group === "string" ? item.entry.group.split(/,\s*/).map((x) => x.trim()).filter(Boolean) : [];
    for (const name of names) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(item);
    }
  }
  for (const members of groups.values()) {
    if (members.length <= 1) continue;
    const stickyMember = members.find((m) => stickyActive(m.id));
    let winner;
    if (stickyMember) winner = stickyMember;
    else {
      const prios = members.filter((m) => m.entry.groupOverride === true || m.entry.groupPrioritize === true)
        .sort((a, b) => ((a.entry.order ?? 100) - (b.entry.order ?? 100)));
      if (prios.length) winner = prios[0];
      else {
        const weight = (m) => (typeof m.entry.groupWeight === "number" && m.entry.groupWeight > 0 ? m.entry.groupWeight : 100);
        let roll = Math.random() * members.reduce((acc, m) => acc + weight(m), 0);
        winner = members[members.length - 1];
        for (const m of members) { roll -= weight(m); if (roll <= 0) { winner = m; break; } }
      }
    }
    for (const m of members) if (m !== winner) {
      const idx = list.indexOf(m);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  return list;
}
/** Context window (tokens) the preset asks for — the preset's openai_max_context. */
export function presetMaxCtx(preset) {
  return (preset && typeof preset.openai_max_context === "number" && preset.openai_max_context > 0)
    ? preset.openai_max_context : 16384;
}
/** World info budget: 25% of
 *  the USABLE context (context minus the reserved response length), chars/4
 *  estimate. Entries claim it in order-DESCENDING priority; entries that
 *  don't fit are dropped whole, never truncated. */
export function wiBudgetChars(preset) {
  const ctx = presetMaxCtx(preset);
  const reserve = preset && typeof preset.openai_max_tokens === "number" && preset.openai_max_tokens > 0 ? preset.openai_max_tokens : 0;
  const usable = Math.max(1, ctx - reserve);
  return Math.max(4, Math.round(usable * 0.25) * 4);
}
export function activateWorldInfo(fsx, meta, dialogue, extraBookIds, budgetChars, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const dryRun = options.dryRun === true;
  // vectorized entries: similarity activation against the scan embedding
  const scanVec = Array.isArray(options.scanVec) ? options.scanVec : null;
  const wiVecMap = scanVec ? loadWiVectors(fsx) : null;
  const cfg = options.config && typeof options.config === "object" ? options.config : {};
  let budget = budgetChars && budgetChars > 0 ? budgetChars : 8192;
  // A book scans only when it is in THIS chat's scope — bound
  // to the chat, embedded in / linked to the character, or global (the app
  // resolves all three into meta.lorebookIds before each send). An empty
  // scope means NO world info, never "scan the whole library".
  const bound = new Set([...(meta.lorebookIds || []), ...(meta.chatLorebookIds || []), ...(extraBookIds || [])]);
  const books = loadBoundBooks(fsx, bound);
  // budget knobs live on the books: contextPercent rescales the caller's
  // budget (which is the 25% figure), budgetCap is an absolute ceiling —
  // bound books asking for more win, the cap always clamps
  for (const b of books) {
    const st = b.settings && typeof b.settings === "object" ? b.settings : {};
    if (typeof st.contextPercent === "number" && st.contextPercent > 0 && st.contextPercent <= 100) {
      budget = Math.max(budget, Math.round(budget * (st.contextPercent / 25)));
    }
    if (typeof st.budgetCap === "number" && st.budgetCap > 0) budget = Math.min(budget, st.budgetCap);
  }
  // effective scan settings: bound books merge (a book wanting a deeper window
  // gets it), the preset's worldInfo block wins when it sets a value
  const bookCfg = { scanDepth: 0, recursive: null, maxRecursion: 0 };
  for (const b of books) {
    const st = b.settings && typeof b.settings === "object" ? b.settings : {};
    if (typeof st.scanDepth === "number" && st.scanDepth > bookCfg.scanDepth) bookCfg.scanDepth = Math.floor(st.scanDepth);
    if (st.recursiveScan === true) bookCfg.recursive = true;
    if (st.recursiveScan === false && bookCfg.recursive === null) bookCfg.recursive = false;
    if (typeof st.maxRecursion === "number" && st.maxRecursion > bookCfg.maxRecursion) bookCfg.maxRecursion = Math.floor(st.maxRecursion);
  }
  const scanDepth = typeof cfg.scanDepth === "number" && cfg.scanDepth > 0 ? Math.floor(cfg.scanDepth)
    : bookCfg.scanDepth > 0 ? bookCfg.scanDepth : 4;
  const recursionOn = cfg.recursion != null ? cfg.recursion !== false : bookCfg.recursive !== false;
  const maxPasses = typeof cfg.recursionDepth === "number" && cfg.recursionDepth > 0 ? Math.floor(cfg.recursionDepth)
    : bookCfg.maxRecursion > 0 ? bookCfg.maxRecursion : 3;

  // flattened, order-sorted entries with stable per-book ids
  const items = [];
  for (const book of books) {
    const entries = (book.entries || []).slice().sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)));
    entries.forEach((entry, i) => {
      if (entry.enabled === false) return;
      items.push({ entry, book: book.name || book.id || "", id: (book.id || book.name) + "#" + (entry.uid ?? i) });
    });
  }
  const entryById = new Map(items.map((x) => [x.id, x.entry]));

  // timed effects tick in MESSAGES: sticky keeps a fired entry in for N
  // messages, cooldown locks it out for N after its sticky ends, delay holds
  // an entry back until the chat has N messages. State lives on chat meta;
  // dry runs (peek, the status viewer) read it but never consume it.
  const tick = dialogue.length;
  const timed = meta.wiTimed && typeof meta.wiTimed === "object" ? meta.wiTimed : {};
  let nextTimed = null;
  if (!dryRun) {
    nextTimed = {
      sticky: { ...timed.sticky },
      cooldown: { ...timed.cooldown },
    };
    for (const [id, r] of Object.entries(nextTimed.sticky)) {
      if (tick >= r.end) {
        delete nextTimed.sticky[id];
        const e = entryById.get(id);
        if (e && typeof e.cooldown === "number" && e.cooldown > 0) nextTimed.cooldown[id] = { start: tick, end: tick + e.cooldown };
      }
    }
    for (const [id, r] of Object.entries(nextTimed.cooldown)) {
      if (tick >= r.end) delete nextTimed.cooldown[id];
    }
  }
  // expiry + cascade apply to THIS evaluation: a sticky that just ended is
  // already gone, and the cooldown it armed already suppresses
  const live = nextTimed ?? timed;
  const stickyLive = (id) => {
    const r = (live.sticky || {})[id];
    return r && tick < r.end ? r : null;
  };
  const cooldownLive = (id) => {
    const r = (live.cooldown || {})[id];
    return r && tick < r.end ? r : null;
  };

  // activation passes: recursion re-scans with the content of everything that
  // fired appended to the base window, so entries can trigger entries
  const activated = [];
  const seen = new Set();
  let scanText = dialogue.slice(-scanDepth).map((m) => m.text).join("\n").toLowerCase();
  let scanRaw = dialogue.slice(-scanDepth).map((m) => m.text).join("\n");
  // entries with matchSources key off the card fields too: per-entry flags
  // pick which sources (speaker description / personality / scenario, the
  // persona description) join that entry's own scan
  const srcIn = options.sources && typeof options.sources === "object" ? options.sources : {};
  const mkSrc = (t) => (t && String(t).trim() ? { raw: String(t), low: String(t).toLowerCase() } : null);
  const sourceTexts = {
    description: mkSrc(srcIn.description),
    personality: mkSrc(srcIn.personality),
    scenario: mkSrc(srcIn.scenario),
    persona: mkSrc(srcIn.persona),
  };
  let windowText = scanText;
  let windowRaw = scanRaw;
  for (let pass = 0; ; pass++) {
    let newly = [];
    for (const { entry, book, id } of items) {
      if (seen.has(id)) continue;
      if (typeof entry.delay === "number" && entry.delay > 0 && tick < entry.delay) continue;
      const st = stickyLive(id);
      if (cooldownLive(id) && !st) continue;
      const delayLevel = typeof entry.delayUntilRecursion === "number" ? entry.delayUntilRecursion
        : entry.delayUntilRecursion === true ? 1 : 0;
      if (delayLevel > pass && !st) continue;
      if (pass > 0 && entry.nonRecursable === true && !st) continue;
      // vectorized entries activate on embedding similarity OR their keys
      let vecHit = false;
      if ((entry.vectorized === true || entry.status === "vectorized") && scanVec && wiVecMap) {
        const rec = wiVecMap[id];
        const c = rec && Array.isArray(rec.vector) ? cosine(rec.vector, scanVec) : null;
        vecHit = c != null && c >= (book.vectorized && typeof book.vectorized.scoreThreshold === "number" ? book.vectorized.scoreThreshold : 0.35);
      }
      let fired;
      if (vecHit || st || isConstantEntry(entry)) fired = true;
      else {
        // book-level case sensitivity + whole words + per-entry scan-depth
        // override: a deeper personal window sees messages the book default
        // misses
        const bookSettings = book.settings && typeof book.settings === "object" ? book.settings : {};
        const eff = { ...entry };
        if (bookSettings.caseSensitive === true) eff.caseSensitive = true;
        if (bookSettings.wholeWords === false) eff.matchWholeWords = eff.wholeWordsOverride == null ? false : eff.wholeWordsOverride;
        let text = windowText, raw = windowRaw;
        const own = typeof entry.scanDepthOverride === "number" && entry.scanDepthOverride > 0 ? Math.floor(entry.scanDepthOverride) : null;
        if (own != null && own !== scanDepth && pass === 0) {
          text = dialogue.slice(-own).map((m) => m.text).join("\n").toLowerCase();
          raw = dialogue.slice(-own).map((m) => m.text).join("\n");
        }
        const ms = entry.matchSources && typeof entry.matchSources === "object" ? entry.matchSources : null;
        if (ms) {
          const parts = [], partsRaw = [];
          for (const srcKey of ["description", "personality", "scenario", "persona"]) {
            const st = sourceTexts[srcKey];
            if (ms[srcKey] === true && st) { parts.push(st.low); partsRaw.push(st.raw); }
          }
          if (parts.length) { text = text + "\n" + parts.join("\n"); raw = raw + "\n" + partsRaw.join("\n"); }
        }
        fired = wiEntryFires(eff, text, raw);
      }
      if (!fired) continue;
      seen.add(id);
      newly.push({ entry, book, id, sticky: !!st });
    }
    newly = wiFilterInclusionGroups(newly, stickyLive);
    activated.push(...newly);
    if (!recursionOn || pass + 1 >= maxPasses) break;
    const added = newly
      .filter((x) => x.entry.preventFurtherRecursion !== true)
      .map((x) => String(x.entry.content || ""));
    if (!added.length) break;
    windowText = windowText + "\n" + added.join("\n").toLowerCase();
    windowRaw = windowRaw + "\n" + added.join("\n");
  }
  // sticky arms on every real activation
  if (nextTimed) {
    for (const { entry, id } of activated) {
      if (typeof entry.sticky === "number" && entry.sticky > 0 && !nextTimed.sticky[id]) {
        nextTimed.sticky[id] = { start: tick, end: tick + entry.sticky };
      }
    }
    meta.wiTimed = nextTimed;
  }

  // trace/skipped feed the app's "active entries" viewer — what fired and
  // what the budget cut, with real numbers instead of a mock
  const out = { before: [], after: [], depth: [], trace: [], skipped: [], used: 0, budgetChars: budget };
  // The budget is claimed in order-DESCENDING priority (higher
  // order wins, constants NOT exempt); ignoreBudget entries are always
  // included but their content still consumes budget for later entries
  const byPriority = activated.slice().sort((x, y) => ((y.entry.order ?? 100) - (x.entry.order ?? 100)));
  const admitted = new Set();
  let used = 0;
  for (const { entry } of byPriority) {
    const c = String(entry.content || "").trim();
    if (!c) continue;
    used += c.length;
    if (entry.ignoreBudget === true || used <= budget) admitted.add(entry);
  }
  out.used = Math.min(used, budget);
  // prompt emission stays in ACTIVATION order (ascending order — the final
  // WI block runs order 1 → 999, top to bottom)
  for (const { entry, book, sticky } of activated) {
    const c = String(entry.content || "").trim();
    if (!c) continue;
    const rec = {
      book, uid: entry.uid ?? null,
      title: entry.title || entry.comment || (entry.keys || []).join(", ") || "untitled",
      chars: c.length, constant: isConstantEntry(entry),
      ...(sticky ? { sticky: true } : {}),
    };
    if (!admitted.has(entry)) { out.skipped.push(rec); continue; }
    out.trace.push(rec);
    if (entry.position === "after_char") out.after.push(c);
    else if (entry.position === "at_depth") out.depth.push({ depth: Math.max(0, Math.floor(entry.depth ?? 4)), role: entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : "system", content: c });
    else out.before.push(c);
  }
  out.depth.sort((a, b) => a.depth - b.depth);
  return out;
}
