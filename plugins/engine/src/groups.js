import { esc } from "./util.js";

/** How readily a member speaks up unprompted, 0..1 (the card's
 *  talkativeness; 0.5 when the card doesn't say). */
function talkativeness(card) {
  const raw = card && ((card.extensions && card.extensions.talkativeness) ?? card.talkativeness);
  const n = Number(raw);
  return raw == null || raw === "" || !Number.isFinite(n) ? 0.5 : Math.min(1, Math.max(0, n));
}
/** Does the text address this member? The whole name, or any word of it
 *  with 3+ letters, matched as a whole word. Returns the first position, or -1. */
function mentionAt(text, name) {
  let at = -1;
  const full = String(name || "").toLowerCase().trim();
  const words = [full, ...full.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3)];
  for (const w of words) {
    if (!w) continue;
    const m = new RegExp("(^|[^\\p{L}\\p{N}])" + esc(w) + "(?=$|[^\\p{L}\\p{N}])", "u").exec(text);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}
/** Who answers this turn in a group, in order. list: every unmuted member;
 *  natural: the members the user named, else one pick weighted by
 *  talkativeness (never the member who just spoke unless the group allows
 *  self responses); manual: nobody. `random` is injectable for peeks and
 *  tests; peeks pass null and get the most likely pick instead of a roll. */
export function groupTurnPlan(group, members, lastSpeakerId, userText, random) {
  const muted = new Set(group.mutedIds || []);
  const order = (group.memberIds || []).map((id) => members.find((m) => m.id === id)).filter((m) => m && !muted.has(m.id));
  if (!order.length || group.mode === "manual") return [];
  if (group.mode === "list") return order;
  const fresh = group.allowSelfResponses ? order : order.filter((m) => m.id !== lastSpeakerId);
  const pool = fresh.length ? fresh : order;
  const text = String(userText || "").toLowerCase();
  const named = pool.map((m) => ({ m, at: mentionAt(text, m.name) })).filter((x) => x.at >= 0).sort((x, y) => x.at - y.at);
  if (named.length) return named.map((x) => x.m);
  const weights = pool.map((m) => talkativeness(m.card));
  const total = weights.reduce((a, w) => a + w, 0);
  if (random === null) return [pool[weights.indexOf(Math.max(...weights))]];
  if (total <= 0) return [pool[Math.floor((random || Math.random)() * pool.length)]];
  let roll = (random || Math.random)() * total;
  for (let i = 0; i < pool.length; i++) { roll -= weights[i]; if (roll < 0) return [pool[i]]; }
  return [pool[pool.length - 1]];
}
