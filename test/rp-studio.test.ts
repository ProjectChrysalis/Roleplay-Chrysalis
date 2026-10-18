/**
 * Roleplay studio tests — the engine + import plugin, driven
 * with a mock host (fs → tmp dir, llm → two-phase simulator). Mirrors the
 * rp-app harness: each route run starts with fresh llm results, paths exclude
 * the query string.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { fileURLToPath } from "node:url";
import type { EngineMessage } from "../src/lib/engine";

const engineUrl = new URL("../plugins/engine/plugin.js", import.meta.url).href;
const stUrl = new URL("../plugins/studio-import/plugin.js", import.meta.url).href;

// gate: the app ships as a standard web app, with nothing left of the retired
// look tier (a leftover file would ship a broken app the UI tests can't see)
describe("app layout", () => {
  const appDir = fileURLToPath(new URL("..", import.meta.url));
  it("is a standard web app: index.html + src/, no bundler config, no look tier", () => {
    expect(fs.existsSync(path.join(appDir, "src", "main.tsx"))).toBe(true);
    // built in the browser: index.html + src/, and no bundler config to run
    expect(fs.existsSync(path.join(appDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, "vite.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(appDir, "look"))).toBe(false);
    const m = JSON.parse(fs.readFileSync(path.join(appDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    // fields the runtime-ESM tier used; nothing reads them any more
    for (const dead of ["packages", "jsxImportSource", "tailwind", "stylesheets", "compat"]) {
      expect(m[dead], `manifest still carries "${dead}"`).toBeUndefined();
    }
  });
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-"));
  for (const d of ["characters", "personas", "presets", "regex", "groups", "lorebooks", "chats"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  // ship the default preset + a character so chats have something to draw on
  fs.writeFileSync(
    path.join(root, "presets", "default.json"),
    JSON.stringify({ id: "default", name: "Default", prompts: [], prompt_order: [], temperature: 0.8, top_p: 0.95, openai_max_tokens: 512, openai_max_context: 8192 }),
  );
  fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "characters", "aria", "card.json"),
    JSON.stringify({
      spec: "chara_card_v2", name: "Aria",
      description: "A barista.", personality: "dry", scenario: "night",
      first_mes: "Welcome in, {{user}}.", mes_example: "",
      alternate_greetings: ["Second greeting.", "Third greeting."],
    }),
  );
  fs.writeFileSync(path.join(root, "personas", "you.json"), JSON.stringify({ id: "you", name: "You", description: "" }));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you" }));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* watcher races */ }
});

function mockHost(
  llmReply?: { text: string } | "error",
  netReply?: (key: string, req: Record<string, unknown>) => Record<string, unknown>,
  embedder?: (texts: string[]) => number[][] | null,
) {
  const results: Record<string, unknown> = {};
  const netResults: Record<string, unknown> = {};
  const embedResults: Record<string, unknown> = {};
  const requests: { key: string; req: Record<string, unknown> }[] = [];
  const netRequests: { key: string; req: Record<string, unknown> }[] = [];
  const embedRequests: { key: string; req: { texts: string[] } }[] = [];
  const resolve = () => {
    for (const { key } of requests) {
      results[key] =
        llmReply === "error"
          ? { text: "", model: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 } }
          : llmReply ?? { text: "MOCK-REPLY", model: "mock/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
    }
    for (const { key, req } of netRequests) {
      netResults[key] = netReply
        ? netReply(key, req)
        : { ok: false, status: 0, error: "no netReply configured" };
    }
    for (const { key, req } of embedRequests) {
      embedResults[key] = embedder ? embedder(req.texts ?? []) : [[0.1, 0.9]];
    }
  };
  const host = {
    fs: {
      root,
      read: (rel: string) => fs.readFileSync(path.resolve(root, rel), "utf8"),
      write: (rel: string, content: string) => {
        const full = path.resolve(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      },
      list: (rel = ".") => fs.readdirSync(path.resolve(root, rel)).sort(),
      remove: (rel: string) => fs.rmSync(path.resolve(root, rel), { recursive: true, force: true }),
    },
    store: { get: (): unknown => null, put: () => {}, delete: () => {}, keys: () => [] },
    llm: {
      request: (key: string, req: Record<string, unknown>) => { requests.push({ key, req }); },
      results,
      embed: (key: string, req: { texts: string[] }) => { embedRequests.push({ key, req }); },
      embedResults,
    },
    net: { request: (key: string, req: Record<string, unknown>) => { netRequests.push({ key, req }); }, results: netResults },
    zip: { entries: () => { throw new Error("no zip"); }, list: () => 0 },
    log: () => {},
  };
  return { host, requests, netRequests, embedRequests, resolve };
}

async function drive(
  pluginUrl: string,
  req: { method: string; path: string; body?: unknown },
  mock: ReturnType<typeof mockHost>,
): Promise<{ status: number; json: Record<string, unknown> } & { __llmPending?: boolean }> {
  const mod = (await import(pluginUrl)) as { handleRoute: Function };
  const results = mock.host.llm.results as Record<string, unknown>;
  for (const k of Object.keys(results)) delete results[k];
  const netResults = (mock.host as { net?: { results: Record<string, unknown> } }).net?.results ?? {};
  for (const k of Object.keys(netResults)) delete netResults[k];
  const qIdx = req.path.indexOf("?");
  const query: Record<string, string> = {};
  let pathOnly = req.path;
  if (qIdx >= 0) {
    pathOnly = req.path.slice(0, qIdx);
    for (const [k, v] of new URLSearchParams(req.path.slice(qIdx + 1))) query[k] = v;
  }
  const call = { method: req.method, path: pathOnly, query, body: req.body };
  let out = mod.handleRoute(call, mock.host) as { status?: number; json?: Record<string, unknown>; __llmPending?: boolean; stash?: Record<string, unknown> };
  for (let pass = 0; out && out.__llmPending && pass < 3; pass++) {
    // the kernel threads each pass's stash into the next pass's ctx
    if (out.stash && typeof out.stash === "object") (call as { stash?: unknown }).stash = out.stash;
    mock.resolve();
    out = mod.handleRoute(call, mock.host) as typeof out;
  }
  return { status: out?.status ?? 200, json: (out?.json ?? {}) as Record<string, unknown>, __llmPending: out?.__llmPending };
}

/**
 * /bootstrap used to inline every chat's full transcript, so the payload grew
 * with every message ever written and was assembled inside a 64MB sandbox
 * heap. It now ships metas plus engine-side totals; these pin the parts the
 * client can no longer work out for itself.
 */
describe("rp studio engine: bootstrap pages instead of shipping every transcript", () => {
  const T_NOON = new Date(2024, 0, 1, 12, 0).getTime();
  // built from local parts, so getHours() reads 3 in any timezone
  const T_NIGHT = new Date(2024, 0, 1, 3, 30).getTime();

  const writeChat = (id: string, lines: Record<string, unknown>[], meta: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, "chats", `${id}.meta.json`),
      JSON.stringify({ id, title: id, characterId: "aria", groupId: null, createdAt: 1, updatedAt: 2, ...meta }),
    );
    fs.writeFileSync(
      path.join(root, "chats", `${id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""),
    );
  };

  const seed = () => {
    // greeting only, never answered
    writeChat("c1", [
      { id: "a1", name: "Aria", charId: "aria", role: "char", text: "Welcome in", at: T_NOON, swipes: ["Welcome in"], swipe: 0 },
    ]);
    // a real conversation: an alternate swipe, a 3:30am user turn, a translation
    writeChat("c2", [
      { id: "b1", name: "Aria", charId: "aria", role: "char", text: "Hi there", at: T_NOON, swipes: ["Hi there", "Hey"], swipe: 0 },
      { id: "b2", name: "You", charId: null, role: "user", text: "one two three", at: T_NIGHT, swipes: ["one two three"], swipe: 0 },
      { id: "b3", name: "Aria", charId: "aria", role: "char", text: "ok", at: T_NOON, translation: "vale", swipes: ["ok"], swipe: 0 },
    ]);
  };

  it("ships chat METAS, never their messages", async () => {
    seed();
    const r = await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost());
    const chats = r.json.chats as Record<string, unknown>[];
    expect(chats.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    for (const c of chats) expect(c.messages).toBeUndefined();
    const c2 = chats.find((c) => c.id === "c2")!;
    expect(c2.messageCount).toBe(3);
    expect(c2.preview).toBe("ok");
    expect(r.json.activeChat).toBeNull();
  });

  it("marks which chats hold a user turn, so the sweep can judge without the transcript", async () => {
    seed();
    const r = await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost());
    const chats = r.json.chats as Record<string, unknown>[];
    expect(chats.find((c) => c.id === "c1")!.hasUser).toBe(false);
    expect(chats.find((c) => c.id === "c2")!.hasUser).toBe(true);
  });

  it("a lone USER message keeps a one-line chat safe from the sweep", async () => {
    // the count alone reads as abandoned here — hasUser is what saves it
    writeChat("solo", [
      { id: "s1", name: "You", charId: null, role: "user", text: "hello", at: T_NOON, swipes: ["hello"], swipe: 0 },
    ]);
    const r = await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost());
    const solo = (r.json.chats as Record<string, unknown>[]).find((c) => c.id === "solo")!;
    expect(solo.messageCount).toBe(1);
    expect(solo.hasUser).toBe(true);
  });

  it("inlines only the chat the client asked for", async () => {
    seed();
    const r = await drive(engineUrl, { method: "GET", path: "/bootstrap?chat=c2" }, mockHost());
    const active = r.json.activeChat as { meta: { id: string }; messages: unknown[] };
    expect(active.meta.id).toBe("c2");
    expect(active.messages).toHaveLength(3);
    for (const c of r.json.chats as Record<string, unknown>[]) expect(c.messages).toBeUndefined();
  });

  it("pages a library too big for one call", async () => {
    seed();
    fs.mkdirSync(path.join(root, "characters"), { recursive: true });
    for (let i = 0; i < 40; i++) {
      fs.mkdirSync(path.join(root, "characters", `card${String(i).padStart(2, "0")}`), { recursive: true });
      fs.writeFileSync(path.join(root, "characters", `card${String(i).padStart(2, "0")}`, "card.json"), JSON.stringify({ name: `Card ${i}`, description: "x".repeat(40_000) }));
    }
    const boot = (await drive(engineUrl, { method: "GET", path: "/bootstrap?paged=1" }, mockHost())).json as { characters: { name: string }[]; more: Record<string, { next: number; total: number }> };
    expect(boot.characters.length).toBeGreaterThan(0);
    expect(boot.characters.length).toBeLessThan(40);
    const names = boot.characters.map((c) => c.name);
    const more = boot.more.characters!;
    // two ranges read side by side, as the client does
    const half = Math.ceil((more.next + more.total) / 2);
    for (const [from, end] of [[more.next, half], [half, more.total]] as const) {
      for (let next: number | null = from; next != null;) {
        const page = (await drive(engineUrl, { method: "GET", path: `/characters?offset=${next}&end=${end}` }, mockHost())).json as { characters: { name: string }[]; next: number | null; total: number };
        expect(page.total).toBe(more.total);
        names.push(...page.characters.map((c) => c.name));
        next = page.next;
      }
    }
    const whole = (await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost())).json as { characters: { name: string }[]; more?: unknown };
    expect(whole.more).toBeUndefined();
    expect(whole.characters.length).toBeGreaterThan(40);
    expect(names.sort()).toEqual(whole.characters.map((c) => c.name).sort());
  });

  it("reads many files in one host call when the engine offers it", async () => {
    seed();
    const plain = (await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost())).json;
    const m = mockHost();
    let calls = 0;
    (m.host.fs as Record<string, unknown>).readMany = (rels: string[]) => { calls++; return rels.map((rel) => { try { return fs.readFileSync(path.resolve(root, rel), "utf8"); } catch { return null; } }); };
    const batched = (await drive(engineUrl, { method: "GET", path: "/bootstrap" }, m)).json;
    expect(calls).toBeGreaterThan(0);
    for (const key of ["characters", "chats", "presets", "regex", "lorebooks", "personas"]) expect(batched[key]).toEqual(plain[key]);
  });

  it("a saved chat lists from its meta without the transcript", async () => {
    seed();
    const sent = await drive(engineUrl, { method: "POST", path: "/chats/c2/messages", body: { role: "user", text: "still here" } }, mockHost());
    expect(sent.status).toBeLessThan(300);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", "c2.meta.json"), "utf8"));
    expect(meta.listing).toMatchObject({ messageCount: 4, preview: "still here", hasUser: true });
    // the list no longer opens a transcript it has a listing for
    fs.writeFileSync(path.join(root, "chats", "c2.jsonl"), "");
    const chats = (await drive(engineUrl, { method: "GET", path: "/chats" }, mockHost())).json.chats as Record<string, unknown>[];
    expect(chats.find((c) => c.id === "c2")).toMatchObject({ messageCount: 4, preview: "still here", hasUser: true });
    expect(chats.find((c) => c.id === "c2")!.listing).toBeUndefined();
    // a listing that says "empty" is checked against the transcript: the sweep relies on it
    writeChat("c3", [{ id: "u1", role: "user", text: "hi" }, { id: "u2", role: "char", text: "yo" }], { listing: { messageCount: 1, preview: "", hasUser: false } });
    const again = (await drive(engineUrl, { method: "GET", path: "/chats" }, mockHost())).json.chats as Record<string, unknown>[];
    expect(again.find((c) => c.id === "c3")).toMatchObject({ messageCount: 2, hasUser: true });
  });

  it("totals the home screen needs are answerable from the metas alone", async () => {
    seed();
    const r = await drive(engineUrl, { method: "GET", path: "/bootstrap" }, mockHost());
    const chats = r.json.chats as { messageCount: number }[];
    // Home sums these instead of reading four transcripts back
    expect(chats.reduce((n, c) => n + c.messageCount, 0)).toBe(4);
    expect(Math.max(...chats.map((c) => c.messageCount))).toBe(3);
  });
});

describe("rp studio engine: chats + swipes", () => {
  it("creates a chat with the greeting seeded as swipes", async () => {
    const m = mockHost();
    const r = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const meta = r.json.meta as Record<string, unknown>;
    const msgs = r.json.messages as { role: string; text: string; swipes: string[]; swipe: number }[];
    expect(meta.title).toBe("Aria");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("char");
    expect(msgs[0]!.text).toBe("Welcome in, You.");
    expect(msgs[0]!.swipes).toHaveLength(3); // first_mes + 2 alternates
  }, 30_000);

  it("starts a new chat on the preset the user made default", async () => {
    const m = mockHost();
    const stock = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    expect((stock.json.meta as Record<string, unknown>).presetId).toBe("default");
    fs.writeFileSync(
      path.join(root, "presets", "mine.json"),
      JSON.stringify({ id: "mine", name: "Mine", prompts: [], prompt_order: [], temperature: 1.1, studio: { isDefault: true } }),
    );
    const r = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    expect((r.json.meta as Record<string, unknown>).presetId).toBe("mine");
    const picked = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "default" } }, m);
    expect((picked.json.meta as Record<string, unknown>).presetId).toBe("default");
  }, 30_000);

  it("swipes the pristine greeting WITHOUT calling the model (wraps)", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const r1 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    expect((r1.json.message as { text: string }).text).toBe("Second greeting.");
    const r2 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: -1 } }, m);
    expect((r2.json.message as { text: string }).text).toBe("Welcome in, You.");
    const r3 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: -1 } }, m);
    expect((r3.json.message as { text: string }).text).toBe("Third greeting."); // wraps
    expect(m.requests).toHaveLength(0); // pure data rotation, no llm
  }, 30_000);

  it("a generation in flight taints the chat so a reload can't sweep it away", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    // PASS A alone — the model hasn't answered, exactly the mid-generation
    // window where a mobile reload used to judge the chat abandoned
    const mod = (await import(engineUrl)) as { handleRoute: Function };
    const call = { method: "POST", path: `/chats/${id}/send`, query: {}, body: { text: "hello" } };
    const passA = mod.handleRoute(call, m.host) as { __llmPending?: boolean; stash?: unknown };
    expect(passA.__llmPending).toBe(true);
    const metaOnDisk = JSON.parse(fs.readFileSync(path.join(root, "chats", `${id}.meta.json`), "utf8")) as { tainted?: boolean };
    expect(metaOnDisk.tainted).toBe(true); // sweep-exempt while generating
    const midLines = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").split("\n").filter(Boolean);
    expect(midLines).toHaveLength(1); // greeting only — no transcript write at pass A
    // PASS B: the model answered — the user turn lands exactly once
    (call as { stash?: unknown }).stash = passA.stash;
    m.resolve();
    const passB = mod.handleRoute(call, m.host) as { status?: number };
    expect(passB.status).toBe(200);
    const done = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { role: string; text: string });
    const users = done.filter((x) => x.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("hello");
  }, 30_000);

  it("keeps the generation preset snapshot through edits, swipes and Continue", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (created.json.meta as { id: string }).id;
    const mod = (await import(engineUrl)) as { handleRoute: Function };
    const call = { method: "POST", path: `/chats/${id}/send`, query: {}, body: { text: "Hello" } };
    const pending = mod.handleRoute(call, m.host);
    expect(pending.stash.presetName).toBe("Default");
    const presetFile = path.join(root, "presets", "default.json");
    const preset = JSON.parse(fs.readFileSync(presetFile, "utf8"));
    fs.writeFileSync(presetFile, JSON.stringify({ ...preset, name: "Renamed" }));
    m.resolve();
    const sent = mod.handleRoute({ ...call, stash: pending.stash }, m.host);
    const reply = sent.json.reply;
    expect(reply.extra.presetName).toBe("Default");
    expect(reply.extra.swipeMeta[0].presetName).toBe("Default");
    const swiped = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    expect((swiped.json.message as EngineMessage).extra?.swipeMeta?.map((entry) => entry?.presetName)).toEqual(["Default", "Renamed"]);
    const previous = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: -1 } }, m);
    expect((previous.json.message as EngineMessage).extra?.presetName).toBe("Default");
    const continued = await drive(engineUrl, { method: "POST", path: `/chats/${id}/continue` }, m);
    expect((continued.json.message as EngineMessage).extra?.presetName).toBe("Renamed");
    expect((continued.json.message as EngineMessage).extra?.swipeMeta?.[0]?.presetName).toBe("Renamed");
  });

  it("send commits user + char messages (two-phase) with macros and sampler", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "One coffee please.", model: "mock/model" } }, m);
    expect(r.json.user as { text: string }).toMatchObject({ text: "One coffee please." });
    expect((r.json.reply as { text: string }).text).toBe("MOCK-REPLY");
    // pass A asked for generation with the assembled prompt + sampler
    const req = m.requests[0]!.req as { systemPrompt?: string; messages: { role: string; content: string }[]; model?: string; presetParams?: Record<string, number> };
    expect(req.model).toBe("mock/model");
    // system parts ride the message array with role "system" (the transport
    // hoists them into the provider system prompt)
    expect(req.messages.some((x) => x.role === "system" && x.content.includes("barista"))).toBe(true);
    expect(req.presetParams).toMatchObject({ temperature: 0.8, max_tokens: 512 });
    expect(req.messages.at(-1)).toMatchObject({ role: "user", content: "One coffee please." });
    // persisted as jsonl
    const lines = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3); // greeting + user + reply
  }, 30_000);

  it("prompt caching: opt-out and pinned placements ride the reply, defaults send nothing", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "default", model: "mock/model" } }, m);
    // caching is the kernel default; nothing is sent unless the preset asks
    expect((m.requests[0]!.req as { cache?: unknown }).cache).toBeUndefined();

    const presetPath = path.join(root, "presets", "default.json");
    const preset = JSON.parse(fs.readFileSync(presetPath, "utf8")) as Record<string, unknown>;
    const writeCache = (cache: unknown) => fs.writeFileSync(presetPath, JSON.stringify({ ...preset, studio: { samplers: { cache } } }));

    writeCache({ enabled: true, pinned: true, depth: 1, ttl: "long" });
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "pinned", model: "mock/model" } }, m2);
    expect((m2.requests[0]!.req as { cache?: unknown }).cache).toEqual({ depth: 1, retention: "long" });

    // the window is its own choice: 1h works without pinning a depth
    writeCache({ enabled: true, pinned: false, depth: 0, ttl: "long" });
    const m3 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "long window", model: "mock/model" } }, m3);
    expect((m3.requests[0]!.req as { cache?: unknown }).cache).toEqual({ retention: "long" });

    // opting out sends the off switch
    writeCache({ enabled: false, pinned: false, depth: 0, ttl: "short" });
    const m4 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "no caching", model: "mock/model" } }, m4);
    expect((m4.requests[0]!.req as { cache?: unknown }).cache).toEqual({ retention: "none" });

    // blocks from builds before the pinned flag: `enabled` was the pin and
    // caching was never off, so the old false sends nothing and the old true
    // still pins
    writeCache({ enabled: true, depth: 2, ttl: "long" });
    const m5 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "legacy pin", model: "mock/model" } }, m5);
    expect((m5.requests[0]!.req as { cache?: unknown }).cache).toEqual({ depth: 2, retention: "long" });
    writeCache({ enabled: false, depth: 0, ttl: "short" });
    const m6 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "legacy off", model: "mock/model" } }, m6);
    expect((m6.requests[0]!.req as { cache?: unknown }).cache).toBeUndefined();
  }, 30_000);

  it("a failed generation keeps the user's message instead of deleting it", async () => {
    const m = mockHost("error");
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "mock/model" } }, m);
    expect(r.status).toBe(503);
    // the user turn commits alone — the client's refresh lands it instead of
    // wiping the staged copy, so a content-filtered turn can be retried
    const done = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { role: string; text: string });
    const users = done.filter((x) => x.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("hello");
    expect(done.some((x) => x.role === "char" && x.text === "MOCK-REPLY")).toBe(false);
  }, 30_000);

  it("a filtered generation reports the provider's reason, not the generic hint", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const failing = mockHost({ text: "", model: "error", error: "model error: Provider finish_reason: content_filter" } as { text: string });
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "mock/model" } }, failing);
    expect(r.status).toBe(503);
    expect(r.json.error as string).toContain("content_filter");
  }, 30_000);

  it("interrupted sends save partial output once, including after a provider error", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (created.json.meta as { id: string }).id;
    const failing = mockHost("error");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", userMessageId: "pending-user" } }, failing);
    const body = { presetName: "Original preset", text: "A partial reply", userText: "hello", userMessageId: "pending-user", replyMessageId: "pending-reply" };
    for (let i = 0; i < 2; i++) {
      const saved = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body }, m);
      expect(saved.status).toBe(200);
    }
    const saved = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const messages = saved.json.messages as { id: string; text: string }[];
    expect(messages.filter((msg) => msg.id === "pending-user")).toHaveLength(1);
    expect(messages.filter((msg) => msg.id === "pending-reply")).toEqual([expect.objectContaining({ text: "A partial reply", extra: expect.objectContaining({ presetName: "Original preset" }) })]);
  });

  it("a completed reply wins a late interrupted save without cloning it", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (created.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", userMessageId: "pending-user", replyMessageId: "pending-reply" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body: { text: "partial", userText: "hello", userMessageId: "pending-user", replyMessageId: "pending-reply" } }, m);
    const saved = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const messages = saved.json.messages as { id: string; text: string }[];
    expect(messages.filter((msg) => msg.id === "pending-reply")).toEqual([expect.objectContaining({ text: "MOCK-REPLY" })]);
    expect(messages.filter((msg) => msg.text === "hello")).toHaveLength(1);
  });

  it("stopping before output keeps only the user turn", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (created.json.meta as { id: string }).id;
    const saved = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body: { text: "", userText: "hello", userMessageId: "pending-user" } }, m);
    expect(saved.status).toBe(200);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    expect((chat.json.messages as unknown[])).toHaveLength(2);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", userMessageId: "pending-user" } }, mockHost("error"));
    const late = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    expect((late.json.messages as unknown[])).toHaveLength(2);

  });

  it("interrupted Continue updates the active swipe and refuses a stale save", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (created.json.meta as { id: string }).id;
    const sent = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello" } }, m);
    const reply = sent.json.reply as { id: string; text: string };
    const body = { operation: "continue", targetMessageId: reply.id, expectedSwipes: 1, expectedText: reply.text, text: reply.text + " unfinished" };
    const saved = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body }, m);
    expect(saved.status).toBe(200);
    const stale = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body }, m);
    expect(stale.status).toBe(409);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const last = (chat.json.messages as { text: string; swipes: string[] }[]).at(-1)!;
    expect(last.text).toBe(body.text);
    expect(last.swipes).toEqual([body.text]);
  });

  it("reply requests are tool-accepting (wantsTools marker); trace persists", async () => {
    const m1 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m1);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m1);
    const req1 = m1.requests[0]!.req as { tools?: unknown; wantsTools?: unknown };
    expect(req1.tools).toBeUndefined(); // the engine plugin itself ships no tools
    expect(req1.wantsTools).toBe(true); // siblings may contribute theirs

    const trace = [{ name: "roll_dice", args: { count: 2, sides: 6 }, resultText: "2d6 → [1, 4] = 5", isError: false }];
    const parts = [
      { type: "thinking", text: "What could happen…" },
      { type: "text", text: "Let me roll." },
      { type: "tool", name: "roll_dice", args: { count: 2, sides: 6 }, resultText: "2d6 → [1, 4] = 5", isError: false },
      { type: "thinking", text: "A five — the guarded path." },
      { type: "text", text: "A five!" },
    ];
    const m2 = mockHost({ text: "The dice say five.", toolTrace: trace, parts } as { text: string });
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "roll for me", model: "mock/model" } }, m2);
    expect((m2.requests[0]!.req as { wantsTools?: unknown }).wantsTools).toBe(true);
    const extra = (r.json.reply as { extra: { tools: typeof trace; parts: typeof parts } }).extra;
    expect(extra.tools).toEqual(trace);
    expect(extra.parts).toEqual(parts);
  }, 30_000);

  it("forks a chat from a message (new chat, messages truncated at that point)", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "One coffee.", model: "mock/model" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "Another coffee.", model: "mock/model" } }, m);
    const before = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const msgs = before.json.messages as { id: string; text: string }[];
    expect(msgs).toHaveLength(5); // greeting + u/a + u/a
    // fork at the FIRST user message: keeps greeting + that message only
    const fork = await drive(engineUrl, { method: "POST", path: `/chats/${id}/fork`, body: { messageId: msgs[1]!.id } }, m);
    expect(fork.status).toBe(201);
    const fmeta = fork.json.meta as { id: string; characterId: string | null; title: string };
    const fmsgs = fork.json.messages as unknown[];
    expect(fmeta.id).not.toBe(id);
    expect(fmeta.characterId).toBe("aria");
    expect(fmeta.title).toContain("fork");
    expect(fmsgs).toHaveLength(2);
    // original untouched
    const after = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    expect((after.json.messages as unknown[])).toHaveLength(5);
  }, 30_000);

  it("a card save without sprite images keeps the images already stored", async () => {
    const m = mockHost();
    const put = (studio: Record<string, unknown>) =>
      drive(engineUrl, { method: "PUT", path: "/characters/spritely", body: { name: "Spritely", studio } }, m);
    await put({ expressions: [{ name: "joy", url: "data:image/png;base64,QUJD" }, { name: "anger", url: "data:image/png;base64,WFla" }] });

    // a client that lists characters without the picture bytes saves the card
    // back with names only; the pack must survive
    await put({ expressions: [{ name: "joy", url: null }, { name: "anger", url: null }] });
    const kept = JSON.parse(fs.readFileSync(path.join(root, "characters", "spritely", "card.json"), "utf8")) as {
      studio: { expressions: { name: string; url: string | null }[] }
    };
    expect(kept.studio.expressions).toEqual([
      { name: "joy", url: "data:image/png;base64,QUJD" },
      { name: "anger", url: "data:image/png;base64,WFla" },
    ]);

    // a real replacement still replaces, and a removed slot stays removed
    await put({ expressions: [{ name: "joy", url: "data:image/png;base64,bmV3" }] });
    const after = JSON.parse(fs.readFileSync(path.join(root, "characters", "spritely", "card.json"), "utf8")) as {
      studio: { expressions: { name: string; url: string | null }[] }
    };
    expect(after.studio.expressions).toEqual([{ name: "joy", url: "data:image/png;base64,bmV3" }]);
  }, 30_000);

  it("numbers forks off the root title instead of stacking suffixes", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { title: "Tavern" } }, m);
    const titles: string[] = [];
    let from = id;
    for (let i = 0; i < 3; i++) {
      const r = await drive(engineUrl, { method: "POST", path: `/chats/${from}/fork`, body: {} }, m);
      const meta = r.json.meta as { id: string; title: string };
      titles.push(meta.title);
      from = meta.id; // fork the fork: the title must not grow
    }
    expect(titles).toEqual(["Tavern fork", "Tavern fork 2", "Tavern fork 3"]);
  }, 30_000);

  it("swiping past the last reply generates a NEW swipe and taints the chat", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    const msg = r.json.message as { swipes: string[]; swipe: number };
    expect(msg.swipes).toHaveLength(2);
    expect(msg.swipes[1]).toBe("MOCK-REPLY");
    expect(msg.swipe).toBe(1);
  }, 30_000);

  it("continue extends the last char message; impersonate drafts without writing", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/continue`, body: {} }, m);
    expect((r.json.message as { text: string }).text).toContain("MOCK-REPLY");
    const before = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8");
    const imp = await drive(engineUrl, { method: "POST", path: `/chats/${id}/impersonate`, body: {} }, m);
    expect(imp.json.text).toBe("MOCK-REPLY");
    expect(fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8")).toBe(before);
  }, 30_000);

  it("message delete: single removes one line, scope=below truncates", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "one" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "two" } }, m);
    const chat = JSON.parse(fs.readFileSync(path.join(root, "chats", `${id}.meta.json`), "utf8")) as { id: string };
    void chat;
    const lines = () => fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n");
    expect(lines()).toHaveLength(5); // greet + (u,a) + (u,a)
    const userMsg = JSON.parse(lines()[1]!) as { id: string };
    // truncate below the greeting → the greeting STAYS, everything after dies
    const greet = JSON.parse(lines()[0]!) as { id: string };
    const r = await drive(engineUrl, { method: "DELETE", path: `/chats/${id}/messages/${greet.id}?scope=below` }, m);
    expect(r.json.remaining).toBe(1);
    expect(JSON.parse(lines()[0]!).id).toBe(greet.id);
    void userMsg;
  }, 30_000);
});

describe("rp studio engine: groups", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, "characters", "bo"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "bo", "card.json"), JSON.stringify({ spec: "chara_card_v2", name: "Bo", description: "chill", first_mes: "" }));
    fs.mkdirSync(path.join(root, "characters", "cy"), { recursive: true });
    fs.writeFileSync(path.join(root, "groups", "duo.json"), JSON.stringify({ id: "duo", name: "Duo", memberIds: ["aria", "bo"], mode: "list", mutedIds: [] }));
  });

  it("list mode: every member answers each turn, in order; history carries name prefixes", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { groupId: "duo" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r1 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello both" } }, m);
    expect((r1.json.reply as { name: string }).name).toBe("Aria"); // first in list
    expect(r1.json.queue).toEqual(["bo"]); // the client runs Bo next
    const r2 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/next`, body: { charId: "bo" } }, m);
    expect((r2.json.reply as { name: string }).name).toBe("Bo");
    const r3 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "again" } }, m);
    expect((r3.json.reply as { name: string }).name).toBe("Aria"); // a new turn starts the list over
    const req = m.requests.at(-1)!.req as { systemPrompt?: string; messages: { role: string; content: string }[] };
    expect(req.messages.some((x) => x.content.startsWith("Bo:"))).toBe(true); // group name prefixes
    expect(req.messages.some((x) => x.role === "system" && x.content.includes("group scene"))).toBe(true);
  }, 30_000);

  it("natural mode: the members the user names answer, in the order named", async () => {
    fs.writeFileSync(path.join(root, "groups", "duo.json"), JSON.stringify({ id: "duo", name: "Duo", memberIds: ["aria", "bo"], mode: "natural", mutedIds: [] }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { groupId: "duo" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "bo, what do you think? and you, aria?" } }, m);
    expect((r.json.reply as { name: string }).name).toBe("Bo");
    expect(r.json.queue).toEqual(["aria"]);
    // a name inside another word is not a mention ("bold" is not Bo; names need 3+ letters)
    const r2 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "ariadne walks in" } }, m);
    expect(r2.json.queue).toBeUndefined();
  }, 30_000);

  it("natural mode: unnamed turns never hand the floor back to who just spoke, and talkativeness 0 stays quiet", async () => {
    fs.writeFileSync(path.join(root, "characters", "cy", "card.json"), JSON.stringify({ spec: "chara_card_v2", name: "Cy", description: "shy", first_mes: "", extensions: { talkativeness: "0" } }));
    fs.writeFileSync(path.join(root, "groups", "duo.json"), JSON.stringify({ id: "duo", name: "Trio", memberIds: ["aria", "bo", "cy"], mode: "natural", mutedIds: [] }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { groupId: "duo" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    let last = "";
    for (let i = 0; i < 12; i++) {
      const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "go on" } }, m);
      const name = (r.json.reply as { name: string }).name;
      expect(name).not.toBe("Cy");
      expect(name).not.toBe(last);
      last = name;
    }
  }, 30_000);

  it("group-only greetings: members carrying them open the group chat with one", async () => {
    fs.writeFileSync(path.join(root, "characters", "bo", "card.json"), JSON.stringify({
      spec: "chara_card_v2", name: "Bo", description: "chill", first_mes: "",
      group_only_greetings: ["Bo eyes the newcomer warily.", "Bo raises a mug to {{user}}."],
    }));
    fs.writeFileSync(path.join(root, "characters", "aria", "card.json"), JSON.stringify({
      spec: "chara_card_v2", name: "Aria", description: "barista", first_mes: "Welcome in.",
      extensions: { group_greetings: ["Aria slides two cups onto the counter."] },
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { groupId: "duo", openingMessage: "The bell rings." } }, m);
    const msgs = chat.json.messages as { name: string; charId: string | null; role: string; text: string; swipes: string[]; greeting?: boolean }[];
    const opening = msgs.find((x) => x.role === "system");
    expect(opening?.text).toBe("The bell rings.");
    // both members greeted; each with one of THEIR group greetings (random pick,
    // all variants swipable); the plain first_mes never shows in a group open
    const bo = msgs.find((x) => x.charId === "bo")!;
    const aria = msgs.find((x) => x.charId === "aria")!;
    expect(["Bo eyes the newcomer warily.", "Bo raises a mug to You."]).toContain(bo.text);
    expect(bo.swipes).toHaveLength(2);
    expect(bo.greeting).toBe(true);
    expect(aria.text).toBe("Aria slides two cups onto the counter."); // legacy extension spelling
    expect(msgs.some((x) => x.text.includes("Welcome in."))).toBe(false);
  }, 30_000);

  it("imported preset shape assembles: canonical markers resolve, order holds", async () => {
    // the shape presetImport writes after the scramble fix: canonical marker
    // identifiers, list-index order, injection_order noise ignored
    fs.writeFileSync(path.join(root, "presets", "imported.json"), JSON.stringify({
      id: "imported", name: "Imported",
      prompts: [
        { identifier: "main", name: "Main Prompt", role: "system", marker: true, content: "MAIN-TEXT", injection_order: 100 },
        { identifier: "note", name: "Author Note", role: "system", content: "NOTE-TEXT", injection_order: 100 },
        { identifier: "charPersonality", name: "Char Personality", role: "system", marker: true },
        { identifier: "chatHistory", name: "Chat History", role: "system", marker: true },
        { identifier: "tail", name: "Tail", role: "system", content: "TAIL-TEXT" },
      ],
      prompt_order: [{ character_id: 100000, order: [
        { identifier: "main", enabled: true }, { identifier: "note", enabled: true },
        { identifier: "charPersonality", enabled: true }, { identifier: "chatHistory", enabled: true },
        { identifier: "tail", enabled: true },
      ] }],
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "imported" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    const sys = req.messages.map((x) => x.content).join("\n");
    // main marker content, marker-resolved card text, custom sections, all in the author's order
    expect(sys).toContain("MAIN-TEXT");
    expect(sys).toContain("NOTE-TEXT");
    expect(sys).toContain("TAIL-TEXT");
    expect(sys).toContain("dry"); // charPersonality marker pulled the card text
    expect(sys.indexOf("MAIN-TEXT")).toBeLessThan(sys.indexOf("NOTE-TEXT"));
    expect(sys.indexOf("NOTE-TEXT")).toBeLessThan(sys.indexOf("TAIL-TEXT"));
    // chat history marker consumed the history turn slot (no empty marker row)
    expect(sys.match(/Chat History/g)).toBeNull();
    expect(req.messages.filter((x) => x.role === "user").at(-1)).toMatchObject({ role: "user", content: "hi" });
  }, 30_000);

  it("a chat pinned to a deleted preset assembles with the user's default", async () => {
    fs.writeFileSync(path.join(root, "presets", "golden.json"), JSON.stringify({
      id: "golden", name: "Golden",
      prompts: [{ identifier: "main", name: "Main", role: "system", marker: true, content: "GOLDEN-MAIN-TEXT" }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
      studio: { isDefault: true, sections: [{ id: "main", marker: "main" }] },
    }));
    const m = mockHost();
    // presetId points at a file that does not exist
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "ghost-preset" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);
    const sys = (m.requests[0]!.req as { messages: { content: string }[] }).messages.map((x) => x.content).join("\n");
    expect(sys).toContain("GOLDEN-MAIN-TEXT"); // the default's layout, not the bare fallback
  }, 30_000);

  it("manual mode: send writes the user message only; next forces a member", async () => {
    fs.writeFileSync(path.join(root, "groups", "duo.json"), JSON.stringify({ id: "duo", name: "Duo", memberIds: ["aria", "bo"], mode: "manual", mutedIds: [] }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { groupId: "duo" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    expect(r.json.reply).toBeNull();
    expect(m.requests).toHaveLength(0);
    const forced = await drive(engineUrl, { method: "POST", path: `/chats/${id}/next`, body: { charId: "bo" } }, m);
    expect((forced.json.reply as { name: string }).name).toBe("Bo");
  }, 30_000);
});

describe("rp studio engine: export + regex + prompt preview", () => {
  it("builds a real (store-mode) zip with entries for everything", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const r = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
    const b64 = r.json.base64 as string;
    const bytes = Buffer.from(b64, "base64");
    // local header magic + EOCD magic present, names in the buffer
    expect(bytes[0]).toBe(0x50); // P
    const asText = bytes.toString("latin1");
    expect(asText).toContain("characters/aria.json");
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    const count = bytes.readUInt16LE(eocd + 10);
    expect(count).toBeGreaterThanOrEqual(3);
    // entity loops read FILE names (they already end in .json) — personas and
    // presets from the seed data must round-trip, not vanish
    expect(asText).toContain("User Settings/personas.json");
    expect(asText).toContain('"You"');
    expect(asText).toContain("User Settings/openai_settings.json");
    expect(asText).toContain("Default");
  }, 30_000);

  it("regex applies to user_input on the way in and ai_output on the way out", async () => {
    fs.writeFileSync(path.join(root, "regex", "shout.json"), JSON.stringify({ id: "shout", scriptName: "Shout", findRegex: "coffee", replaceString: "COFFEE", placement: ["user_input", "ai_output"], disabled: false }));
    const m = mockHost({ text: "your coffee is ready" });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "coffee please" } }, m);
    // ai_output regex applies to the reply as it enters the prompt AND is stored as generated? we store raw model text
    const reply = r.json.reply as { text: string };
    expect(reply.text).toBe("your coffee is ready"); // stored raw (display regex is client-side)
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    const userMsg = req.messages.at(-1)!;
    expect(userMsg.content).toBe("COFFEE please"); // user_input placement rewrote it for the model
  }, 30_000);

  it("prompt preview returns the assembled system + messages", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "espresso" } }, m);
    expect((r.json.messages as { role: string; content: string }[]).some((x) => x.role === "system" && x.content.includes("barista"))).toBe(true);
    expect((r.json.messages as { content: string }[]).at(-1)!.content).toBe("espresso");
  }, 30_000);

  it("the card's variant selection decides what generation and peek send", async () => {
    fs.writeFileSync(
      path.join(root, "characters", "aria", "card.json"),
      JSON.stringify({
        spec: "chara_card_v2", name: "Aria",
        description: "A quiet barista.", personality: "clipped tone", scenario: "night",
        first_mes: "Welcome in, {{user}}.", mes_example: "",
        alternate_greetings: ["Second greeting."],
        studio: {
          descVariants: [{ id: "var_night", label: "Night shift", content: "A night-shift barista who hums." }],
          personalityVariants: [{ id: "var_warm", label: "Warm", content: "warm and chatty" }],
          scenarioVariants: [],
        },
      }),
    );
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const joined = (r: { json: Record<string, unknown> }) =>
      (r.json.messages as { content: string }[]).map((x) => x.content).join("\n");

    // no selection: the card's base text rides
    const before = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(joined(before)).toContain("A quiet barista.");
    expect(joined(before)).toContain("clipped tone");

    // the editor's chip row stores the choice on the card; every chat reads it
    const cardPath = path.join(root, "characters", "aria", "card.json");
    const card = JSON.parse(fs.readFileSync(cardPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(cardPath, JSON.stringify({
      ...card,
      studio: {
        ...(card.studio as Record<string, unknown>),
        variantSelection: { desc: "var_night", personality: "var_warm" },
      },
    }));
    const after = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(joined(after)).toContain("A night-shift barista who hums.");
    expect(joined(after)).toContain("warm and chatty");
    expect(joined(after)).not.toContain("A quiet barista.");
    expect(joined(after)).not.toContain("clipped tone");

    // generation resolves the card the same way peek does
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "coffee", model: "mock/model" } }, m);
    const sent = m.requests.at(-1)!.req as { messages: { content: string }[] };
    expect(sent.messages.map((x) => x.content).join("\n")).toContain("A night-shift barista who hums.");
  }, 30_000);

  it("peek at a message assembles the prompt AS OF that message, not the chat tail", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "first question" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "second question" } }, m);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const msgs = chat.json.messages as { id: string; role: string }[];
    // the FIRST user message: greeting + its own text, nothing from later turns
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, messageId: msgs[1]!.id } }, m);
    const contents = (peek.json.messages as { content: string }[]).map((x) => x.content);
    expect(contents.some((c) => c.includes("first question"))).toBe(true);
    expect(contents.some((c) => c.includes("second question"))).toBe(false);
    expect(contents.some((c) => c.includes("MOCK-REPLY"))).toBe(false);
    // the greeting is a char message: its prompt ended before it existed
    const peekGreeting = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, messageId: msgs[0]!.id } }, m);
    const g = (peekGreeting.json.messages as { content: string }[]).map((x) => x.content);
    expect(g.some((c) => c.includes("first question"))).toBe(false);
    expect(g.some((c) => c.includes("Welcome in"))).toBe(false); // not even itself
    const missing = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, messageId: "nope" } }, m);
    expect(missing.status).toBe(404);
  }, 30_000);

  it("bootstrap answers the whole app state in one call, transcripts excluded", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello there" } }, m);

    const boot = (await drive(engineUrl, { method: "GET", path: "/bootstrap" }, m)).json as {
      characters: { id: string }[]; personas: unknown[]; presets: { id: string }[];
      lorebooks: unknown[]; regex: unknown[]; groups: unknown[];
      settings: { personaId: string }; library: unknown; databank: { files: unknown[] };
      chats: { id: string; messageCount: number; hasUser: boolean; messages?: unknown }[];
      activeChat: unknown;
    };
    expect(boot.characters.map((c) => c.id)).toContain("aria");
    expect(boot.presets.map((p) => p.id)).toContain("default");
    expect(boot.settings.personaId).toBe("you");
    expect(boot.databank.files).toEqual([]);
    // chats travel as METAS now: a transcript arrives when one is opened
    const row = boot.chats.find((c) => c.id === id);
    expect(row).toBeDefined();
    expect(row?.messages).toBeUndefined();
    expect(row?.messageCount).toBeGreaterThan(0);
    expect(row?.hasUser).toBe(true);
    expect(boot.activeChat).toBeNull();

    // asking for one inlines it, and its shape is the individual route's own,
    // not a second definition
    const withChat = (await drive(engineUrl, { method: "GET", path: `/bootstrap?chat=${id}` }, m)).json as {
      activeChat: { meta: { id: string }; messages: unknown[] };
    };
    const solo = (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json;
    expect(withChat.activeChat.meta.id).toBe(id);
    expect(withChat.activeChat.messages).toEqual((solo as { messages: unknown[] }).messages);
  }, 30_000);

  it("depth injections land inside the history, counted from the newest turn", async () => {
    // preset with a real post-history block after the chat: an author's note
    // at depth 0 must sit at the END of the transcript but still BEFORE it
    fs.writeFileSync(
      path.join(root, "presets", "default.json"),
      JSON.stringify({
        id: "default", name: "Default", openai_max_context: 8192,
        prompts: [
          { identifier: "main", marker: true, role: "system", content: "MAIN" },
          { identifier: "chatHistory", marker: true, role: "system" },
          { identifier: "postHistory", role: "system", content: "LAST-WORD" },
        ],
        prompt_order: [
          { identifier: "main", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "postHistory", enabled: true },
        ],
      }),
    );
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "turn one" } }, m);
    await drive(engineUrl, {
      method: "PATCH", path: `/chats/${id}`,
      body: { authorNoteObject: { text: "NOTE", position: "in-chat", depth: 0, role: "system", frequency: 1 } },
    }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "turn two" } }, m);
    const contents = (peek.json.messages as { content: string }[]).map((x) => x.content);
    const note = contents.findIndex((c) => c.includes("NOTE"));
    const lastTurn = contents.findIndex((c) => c.includes("turn two"));
    const postHistory = contents.findIndex((c) => c.includes("LAST-WORD"));
    expect(note).toBeGreaterThan(lastTurn); // depth 0 = after the newest turn
    expect(postHistory).toBeGreaterThan(note); // and the post-history block still ends the prompt

    // depth 1 sits one turn further back
    await drive(engineUrl, {
      method: "PATCH", path: `/chats/${id}`,
      body: { authorNoteObject: { text: "NOTE", position: "in-chat", depth: 1, role: "system", frequency: 1 } },
    }, m);
    const deeper = (await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "turn two" } }, m)).json;
    const c2 = (deeper.messages as { content: string }[]).map((x) => x.content);
    expect(c2.findIndex((c) => c.includes("NOTE"))).toBeLessThan(c2.findIndex((c) => c.includes("turn two")));
  }, 30_000);

  it("peek carries the tool definitions a wantsTools send would (host.siblingTools)", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    // absent on engine builds without the ?siblingtools contract: no tools key
    const bare = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(bare.json.tools).toBeUndefined();
    // with the sibling set exposed, the peek shows exactly what a send carries
    (m.host as Record<string, unknown>).siblingTools = [
      { name: "roll_dice", description: "Roll dice.", parameters: { type: "object", properties: { sides: { type: "number" } } } },
    ];
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    const tools = peek.json.tools as { name: string; description: string }[];
    expect(tools?.[0]?.name).toBe("roll_dice");
    expect(tools?.[0]?.description).toBe("Roll dice.");
  }, 30_000);

  it("long translations are chunked at the provider cap and stitched back exactly", async () => {
    const seen: { key: string; q: string }[] = [];
    const m = mockHost(undefined, (key, req) => {
      const url = String((req as { url?: string }).url);
      seen.push({ key, q: decodeURIComponent(url.split("q=")[1] ?? "") });
      return { ok: true, status: 200, statusText: "OK", json: [[[`<${key}>`, "orig"]]] };
    });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const text = `para. ${"x".repeat(60)}\n\n`.repeat(120); // ~8k chars > the 4000 cap
    const r = await drive(engineUrl, { method: "POST", path: "/translate", body: { text, target: "Spanish", provider: "google" } }, m);
    expect(seen.length).toBeGreaterThanOrEqual(2); // actually chunked
    for (const s of seen) expect(s.q.length).toBeLessThanOrEqual(4000); // every piece within cap
    expect(seen.map((s) => s.q).join("")).toBe(text); // exact partition, nothing dropped
    expect(r.json.text).toBe(seen.map((s) => `<${s.key}>`).join("")); // stitched in order
  }, 30_000);

  it("http providers reject unmapped languages instead of silently translating to english", async () => {
    const m = mockHost(undefined, () => ({ ok: true, status: 200, statusText: "OK", json: [] }));
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const r = await drive(engineUrl, { method: "POST", path: "/translate", body: { text: "hello", target: "Klingon", provider: "google" } }, m);
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("Klingon");
  }, 30_000);

  it("a message's translation dies with its text (edit, swipe switch)", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const reply = [...(chat.json.messages as { id: string; role: string }[])].reverse().find((x) => x.role === "char")!;
    const set = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { translation: "hola" } }, m);
    expect((set.json.message as { translation?: string }).translation).toBe("hola");
    const edited = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { text: "edited reply" } }, m);
    expect((edited.json.message as { translation?: string }).translation).toBeUndefined();
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { translation: "hola de nuevo" } }, m);
    const swiped = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    expect((swiped.json.message as { translation?: string }).translation).toBeUndefined();
  }, 30_000);

  it("every swipe keeps its own generation facts (swipeMeta stays index-aligned)", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    // regen twice: three swipes, three metas
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const reply = [...(chat.json.messages as { id: string; role: string; extra?: { swipeMeta?: unknown[] } }[])].reverse().find((x) => x.role === "char")!;
    expect(reply.extra?.swipeMeta).toHaveLength(3);
    // a cancelled commit appends its own entry: the client-measured elapsed
    // time rides along, no usage (the engine's completion was discarded)
    const target = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body: { text: "frozen bytes", targetMessageId: reply.id, expectedSwipes: 3, genMs: 4200, model: "test/mini" } }, m);
    expect(target.status).toBe(200);
    const chat2 = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const reply2 = [...(chat2.json.messages as { id: string; role: string; extra?: { swipeMeta?: unknown[]; genMs?: number; model?: string; usage?: unknown } }[])].reverse().find((x) => x.role === "char")!;
    expect(reply2.extra?.swipeMeta).toHaveLength(4);
    expect(reply2.extra?.swipeMeta?.[3]).toEqual({ genMs: 4200, model: "test/mini" });
    // the message-level facts describe the ACTIVE swipe — the cancelled
    // partial, not the generation it replaced
    expect(reply2.extra?.genMs).toBe(4200);
    expect(reply2.extra?.model).toBe("test/mini");
    expect(reply2.extra?.usage).toBeUndefined();
    // deleting a swipe splices the meta array with it
    const del = await drive(engineUrl, { method: "DELETE", path: `/chats/${id}/messages/${reply2.id}/swipes/3` }, m);
    expect(del.status).toBe(200);
    const chat3 = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const reply3 = [...(chat3.json.messages as { id: string; role: string; extra?: { swipeMeta?: unknown[] } }[])].reverse().find((x) => x.role === "char")!;
    expect(reply3.extra?.swipeMeta).toHaveLength(3);
  }, 30_000);

  it("removes saved thinking while preserving the reply and tool results", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = String((created.json.meta as { id: string }).id);
    const file = path.join(root, "chats", `${id}.jsonl`);
    const messages = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const reply = messages[0];
    const kept = [{ type: "text", text: reply.text }, { type: "tool", name: "dice", args: {}, resultText: "5" }];
    reply.extra = { reasoning: "PRIVATE-THOUGHT", reasoningMs: 321, parts: [
      { type: "thinking", text: "PRIVATE-THOUGHT", ms: 321 }, ...kept,
      { type: "thinking", text: "ANOTHER-THOUGHT" },
    ], model: "mock/model", swipeMeta: [{ genMs: 500 }], opaque: { keep: true } };
    fs.writeFileSync(file, messages.map((item) => JSON.stringify(item)).join("\n") + "\n");
    const preview = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(JSON.stringify(preview.json)).toContain("PRIVATE-THOUGHT");
    expect(JSON.stringify(preview.json)).toContain("ANOTHER-THOUGHT");
    const removed = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { removeThinking: true } }, m);
    expect(removed.status).toBe(200);
    const read = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const saved = (read.json.messages as typeof messages)[0];
    expect(saved.text).toBe(reply.text);
    expect(saved.swipes).toEqual(reply.swipes);
    expect(saved.extra).toEqual({ parts: kept, model: "mock/model", swipeMeta: reply.swipes.map((_: string, i: number) => i === 0 ? { genMs: 500, model: "mock/model", parts: kept } : null), opaque: { keep: true } });
    const again = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { removeThinking: true } }, m);
    expect(again.json.message).toEqual(saved);
  });

  it("preserves native thinking per swipe, opts out per preset, and invalidates edited signatures", async () => {
    const native = { role: "assistant", api: "anthropic-messages", provider: "mock", model: "model", content: [
      { type: "thinking", thinking: "Original plan", thinkingSignature: "original-signature" },
      { type: "text", text: "Signed answer", textSignature: "text-signature" },
    ] };
    const response = { text: "Signed answer", reasoning: "Original plan", model: "mock/model",
      replay: { text: "Signed answer", messages: [native] } };
    const m = mockHost(response);
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = String((created.json.meta as { id: string }).id);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "Hi" } }, m);
    const read = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const msg = (read.json.messages as { id: string }[]).at(-1)!;
    const mid = msg.id;
    const preview = () => drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(JSON.stringify((await preview()).json)).toContain("original-signature");
    const presetFile = path.join(root, "presets", "default.json");
    const preset = JSON.parse(fs.readFileSync(presetFile, "utf8"));
    preset.studio = { samplers: { reasoning: { history: "individual" } } };
    fs.writeFileSync(presetFile, JSON.stringify(preset));
    const individual = JSON.stringify((await preview()).json);
    expect(individual).not.toContain("original-signature");
    expect(individual).not.toContain("Original plan");
    preset.studio.samplers.reasoning.history = "preserve";
    fs.writeFileSync(presetFile, JSON.stringify(preset));
    const patch = (body: unknown) => drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${mid}`, body }, m);
    await patch({ reasoning: "Changed plan" });
    const changed = JSON.stringify((await preview()).json);
    expect(changed).toContain("Changed plan");
    expect(changed).not.toContain("original-signature");
    expect(changed).not.toContain("text-signature");
    response.replay.messages[0]!.content[0] = { type: "thinking", thinking: "Swipe plan", thinkingSignature: "swipe-signature" };
    response.reasoning = "Swipe plan";
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { messageId: mid } }, m);
    expect(JSON.stringify((await preview()).json)).toContain("swipe-signature");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/messages/${mid}/swipe`, body: { index: 0 } }, m);
    const oldSwipe = JSON.stringify((await preview()).json);
    expect(oldSwipe).toContain("Changed plan");
    expect(oldSwipe).not.toContain("swipe-signature");
    await patch({ removeThinking: true });
    const removed = JSON.stringify((await preview()).json);
    expect(removed).not.toContain("Changed plan");
    expect(removed).toContain("Signed answer");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/messages/${mid}/swipe`, body: { index: 1 } }, m);
    expect(JSON.stringify((await preview()).json)).toContain("swipe-signature");
  });

  it("stopped swipes retain their own thinking through switching and regeneration", async () => {
    const m = mockHost({ text: "Completed reply", reasoning: "Completed plan", model: "mock/model" } as never);
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = String((created.json.meta as { id: string }).id);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const transcript = path.join(root, "chats", `${id}.jsonl`);
    const records = fs.readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const original = records[records.length - 1];
    const mid = original.id;
    delete original.extra.swipeMeta;
    fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const parts = [{ type: "thinking", text: "Stopped plan", ms: 1200 }, { type: "text", text: "Partial reply" }];
    const stopped = await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body: {
      targetMessageId: mid, text: "Partial reply", parts, expectedSwipes: 1, model: "mock/model", genMs: 1500,
    } }, m);
    expect(stopped.status).toBe(200);
    const move = (index: number) => drive(engineUrl, { method: "POST", path: `/chats/${id}/messages/${mid}/swipe`, body: { index } }, m);
    const first = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: -1 } }, m);
    expect((first.json.message as { extra: { reasoning?: string } }).extra.reasoning).toBe("Completed plan");
    expect((first.json.message as { extra: { parts?: unknown[] } }).extra.parts).toBeUndefined();
    expect((await move(1)).json.message).toMatchObject({ extra: { parts } });
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    expect((await move(1)).json.message).toMatchObject({ extra: { parts } });
    expect((await move(0)).json.message).toMatchObject({ extra: { reasoning: "Completed plan" } });
    await move(1);
    const continuedParts = [{ type: "thinking", text: "Continued plan" }, { type: "text", text: "Partial reply continued" }];
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/cancelled`, body: {
      targetMessageId: mid, operation: "continue", text: "Partial reply continued", parts: continuedParts, expectedSwipes: 3,
    } }, m);
    await move(0);
    expect((await move(1)).json.message).toMatchObject({ extra: { parts: continuedParts } });
  });

  it("switching swipes preserves saved thoughts when message metadata is stale", async () => {
    const m = mockHost();
    const created = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = String((created.json.meta as { id: string }).id);
    const file = path.join(root, "chats", `${id}.jsonl`);
    const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const reply = records[0];
    reply.swipes = ["First", "Second"];
    reply.swipe = 1;
    reply.text = "Second";
    reply.extra = { reasoning: "First plan", reasoningMs: 11000, swipeMeta: [
      { reasoning: "First plan", reasoningMs: 11000 }, { reasoning: "Second plan", reasoningMs: 22000 },
    ] };
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    for (const index of [0, 1, 0, 1]) {
      const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/messages/${reply.id}/swipe`, body: { index } }, m);
      expect(r.json.message).toMatchObject({ extra: { reasoning: index === 0 ? "First plan" : "Second plan", reasoningMs: index === 0 ? 11000 : 22000 } });
    }
  });

  it("thinking is editable on its own, separate from the reply text", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const reply = [...(chat.json.messages as { id: string; role: string; text: string; edited?: boolean; extra?: { reasoning?: string } }[])].reverse().find((x) => x.role === "char")!;
    // edit the reasoning only
    const r = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { reasoning: "revised thinking" } }, m);
    expect(r.status).toBe(200);
    const edited = r.json.message as typeof reply;
    expect(edited.extra?.reasoning).toBe("revised thinking");
    // the reply text is untouched
    expect(edited.text).toBe(reply.text);
    expect(edited.edited).toBeUndefined();
    // clearing sends empty string, stored as absent
    const r2 = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { reasoning: "  " } }, m);
    expect((r2.json.message as typeof reply).extra?.reasoning).toBeUndefined();
    // think-segment edits only touch parts messages; a parts-less message is a no-op
    const r3 = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/${reply.id}`, body: { think: { index: 0, text: "x" } } }, m);
    expect(r3.status).toBe(200);
  }, 30_000);
});

describe("rp studio engine: data bank retrieval", () => {
  it("measures Unicode documents and enforces the UTF-8 byte limit", async () => {
    const content = "日本語 🐉 café\n".repeat(100);
    const m = mockHost();
    const uploaded = await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "unicode.txt", content } }, m);
    expect(uploaded.status).toBe(200);
    expect((uploaded.json.file as { size: number }).size).toBe(Buffer.byteLength(content));
    const oversized = await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "large.txt", content: "日".repeat(700000) } }, m);
    expect(oversized.status).toBe(413);
  });
  it("dense short chunks outrank long filler; stopword-only queries match nothing", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    // ~750 chars of stopword filler with ONE glancing content-word hit —
    // exactly the chunk that used to ride into every prompt
    const filler = ("the and she was with that this from they ").repeat(16) + "lantern " + ("the and she was with ").repeat(5);
    await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "filler.txt", content: filler } }, m);
    await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "focused.txt", content: "The lantern shop kept wicks, lantern oil, and spare lantern glass behind the counter." } }, m);
    const empty = await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "x.txt", content: "   " } }, m);
    expect(empty.status).toBe(400);
    const r = await drive(engineUrl, { method: "GET", path: "/databank/search?q=the%20and%20lantern%20wicks" }, m);
    const results = r.json.results as { fileName: string; score: number }[];
    expect(results[0]!.fileName).toBe("focused.txt");
    expect(results[0]!.score).toBeGreaterThan(2);
    expect(results.some((x) => x.fileName === "filler.txt")).toBe(false); // glancing hit stays under the floor
    const none = await drive(engineUrl, { method: "GET", path: "/databank/search?q=the%20and%20was%20with" }, m);
    expect(none.json.results as unknown[]).toHaveLength(0);
  }, 30_000);

  it("enabled files inject into the assembled prompt, disabled ones don't", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    const up = await drive(engineUrl, { method: "POST", path: "/databank", body: { name: "lore.txt", content: "The kerosene ritual demands three matches and a steady hand." } }, m);
    const fid = (up.json.file as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "tell me about the kerosene ritual and matches" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    expect(req.messages.some((x) => x.content.includes("[Data bank"))).toBe(true);
    expect(req.messages.some((x) => x.content.includes("kerosene ritual"))).toBe(true);
    await drive(engineUrl, { method: "PATCH", path: `/databank/${fid}`, body: { enabled: false } }, m);
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "kerosene ritual matches again" } }, m2);
    const req2 = m2.requests[0]!.req as { messages: { content: string }[] };
    expect(req2.messages.some((x) => x.content.includes("[Data bank"))).toBe(false);
  }, 30_000);
});

describe("rp studio engine: names behavior + prompt post-processing", () => {
  const presetWith = (studio: Record<string, unknown>) => {
    fs.writeFileSync(path.join(root, "presets", "t1.json"), JSON.stringify({
      id: "t1", name: "T1", prompts: [], prompt_order: [], temperature: 0.8, top_p: 0.95,
      openai_max_tokens: 512, openai_max_context: 8192, studio,
    }));
  };
  const newChatWithPreset = async (m: ReturnType<typeof mockHost>) => {
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "t1" } }, m);
    return (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
  };

  it("namesBehavior content prefixes every turn with the speaker name; none never does", async () => {
    presetWith({ sections: [], namesBehavior: "content" });
    const m = mockHost();
    const id = await newChatWithPreset(m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello there" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    const contents = req.messages.map((x) => x.content);
    expect(contents.some((c) => c.startsWith("You: hello there"))).toBe(true);
    expect(contents.some((c) => c.startsWith("Aria: ") && c.includes("Welcome in"))).toBe(true);

    presetWith({ sections: [], namesBehavior: "none" });
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "t1" } }, m2);
    const id2 = (fs.readdirSync(path.join(root, "chats")).filter((f) => f.endsWith(".meta.json")) as string[]).map((f: string) => f.replace(/\.meta\.json$/, "")).find((x: string) => x !== id)!;
    await drive(engineUrl, { method: "POST", path: `/chats/${id2}/send`, body: { text: "hello again" } }, m2);
    const req2 = m2.requests[0]!.req as { messages: { content: string }[] };
    expect(req2.messages.some((c) => /^You: |^Aria: /.test(c.content))).toBe(false);
  }, 30_000);

  it("post-processing merge collapses consecutive same-role entries; single folds everything", async () => {
    presetWith({ sections: [], promptPostProcessing: { enabled: true, mode: "merge" } });
    const m = mockHost();
    const id = await newChatWithPreset(m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "one" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string }[] };
    const roles = req.messages.map((x) => x.role);
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);

    presetWith({ sections: [], promptPostProcessing: { enabled: true, mode: "single" } });
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "t1" } }, m2);
    const id2 = (fs.readdirSync(path.join(root, "chats")).filter((f) => f.endsWith(".meta.json")) as string[]).map((f: string) => f.replace(/\.meta\.json$/, "")).find((x: string) => x !== id)!;
    await drive(engineUrl, { method: "POST", path: `/chats/${id2}/send`, body: { text: "two" } }, m2);
    const req2 = m2.requests[0]!.req as { messages: { role: string }[] };
    expect(req2.messages).toHaveLength(1);
    expect(req2.messages[0]!.role).toBe("user");
  }, 30_000);

  it("squash merges only consecutive system entries, never turns", async () => {
    // custom sections ride the classic prompts/prompt_order wire shape; the
    // studio bag carries the shaping switches (exactly what the client saves)
    fs.writeFileSync(path.join(root, "presets", "t1.json"), JSON.stringify({
      id: "t1", name: "T1",
      prompts: [
        { identifier: "s1", name: "S1", role: "system", content: "first system note" },
        { identifier: "s2", name: "S2", role: "system", content: "second system note" },
      ],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "s1", enabled: true }, { identifier: "s2", enabled: true }] }],
      temperature: 0.8, top_p: 0.95, openai_max_tokens: 512, openai_max_context: 8192,
      studio: { squashSystemMessages: true },
    }));
    const m = mockHost();
    const id = await newChatWithPreset(m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    const systems = req.messages.filter((x) => x.role === "system");
    // the two notes collapse into one system entry; user/assistant turns stay separate
    expect(systems.some((x) => x.content.includes("first system note") && x.content.includes("second system note"))).toBe(true);
    expect(req.messages.some((x) => x.role === "user" && x.content.includes("hi"))).toBe(true);
    const roles = req.messages.map((x) => x.role);
    expect(roles.indexOf("user")).toBeGreaterThan(-1);
    expect(roles.filter((r) => r === "user").length).toBe(1); // the turn itself never merges into a neighbor
  }, 30_000);

  it("compact history collapses the whole chat into one labeled message and adds its stop string", async () => {
    presetWith({
      compactHistory: {
        enabled: true, role: "assistant", separator: "double",
        userPrefix: "**{{user}}:** ", userSuffix: "", charPrefix: "", charSuffix: "",
        stopString: "**{{user}}:**",
      },
    });
    const m = mockHost();
    const id = await newChatWithPreset(m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "compress me" } }, m);
    const req = m.requests[0]!.req as {
      messages: { role: string; content: string }[];
      presetParams?: { params?: { stop?: string[] } };
    };
    // the entire visible chat is ONE message — no user/assistant alternation left
    const blob = req.messages.filter((x) => x.content.includes("compress me"));
    expect(blob).toHaveLength(1);
    expect(blob[0]!.role).toBe("assistant");
    // turns keep their speaker labels, greeting before the fresh user turn
    expect(blob[0]!.content).toContain("**You:** compress me");
    expect(blob[0]!.content.indexOf("Welcome in")).toBeLessThan(blob[0]!.content.indexOf("**You:** compress me"));
    expect(req.messages.filter((x) => x.role === "user")).toHaveLength(0);
    // the compact stop string rides the sampler stops, macro-expanded
    expect(req.presetParams?.params?.stop).toContain("**You:**");
  }, 30_000);
});

describe("rp studio engine: utility prompts", () => {
  const chatIdOf = () => (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
  const presetWithUtils = (utils: Record<string, string>) => {
    const base = JSON.parse(fs.readFileSync(path.join(root, "presets", "default.json"), "utf8")) as Record<string, unknown>;
    base.utilityPrompts = {
      impersonation: "", continueNudge: "", newChat: "", groupNudge: "", emptySend: "", ...utils,
    };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
  };

  it("newChat rides a freshly started chat; continue honors the prefill toggle", async () => {
    presetWithUtils({ newChat: "[BEGIN: {{char}}]", continueNudge: "KEEP GOING NOW" });
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    // second generation: history > 1 message → newChat must NOT ride
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "more" } }, m);
    const first = m.requests[0]!.req as { messages: { content: string }[] };
    expect(first.messages.some((x) => x.content.includes("[BEGIN: Aria]"))).toBe(true);
    const second = m.requests[1]!.req as { messages: { content: string }[] };
    expect(second.messages.some((x) => x.content.includes("[BEGIN:"))).toBe(false);
    // continue with prefill ON (the default): no nudge, the partial reply
    // stays the trailing assistant turn
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/continue`, body: {} }, m);
    const cont = m.requests[2]!.req as { messages: { role: string; content: string }[] };
    expect(cont.messages.some((x) => x.content.includes("KEEP GOING NOW"))).toBe(false);
    expect(cont.messages.at(-1)!.role).toBe("assistant");
    // prefill OFF: the nudge arrives as a trailing user turn
    const base = JSON.parse(fs.readFileSync(path.join(root, "presets", "default.json"), "utf8")) as { studio?: Record<string, unknown> };
    base.studio = { ...base.studio, continuePrefill: false };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/continue`, body: {} }, m);
    const cont2 = m.requests[3]!.req as { messages: { role: string; content: string }[] };
    expect(cont2.messages.some((x) => x.role === "user" && x.content.includes("KEEP GOING NOW"))).toBe(true);
  }, 30_000);

  it("verbosity rides the request body when set, nothing on auto", async () => {
    const base = JSON.parse(fs.readFileSync(path.join(root, "presets", "default.json"), "utf8")) as { studio?: Record<string, unknown> };
    base.studio = { ...base.studio, verbosity: "low" };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(((peek.json.presetParams as { params?: Record<string, unknown> }).params ?? {}).verbosity).toBe("low");
    base.studio = { ...base.studio, verbosity: "auto" };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
    const peek2 = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(((peek2.json.presetParams as { params?: Record<string, unknown> }).params ?? {}).verbosity).toBeUndefined();
  }, 30_000);

  it("impersonation drafts the USER's message from history + the utility prompt", async () => {
    presetWithUtils({ impersonation: "DRAFT AS {{user}} PLEASE" });
    const m = mockHost({ text: "I nod slowly." });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/impersonate`, body: {} }, m);
    const imp = m.requests[1]!.req as { messages: { role: string; content: string }[] };
    expect(imp.messages.some((x) => x.content.includes("DRAFT AS You PLEASE"))).toBe(true);
    // and the draft never lands in the chat
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const last = (chat.json.messages as { role: string }[]).at(-1)!;
    expect(last.role).toBe("char");
  }, 30_000);
});

describe("rp studio engine: example separator + echoed name strip", () => {
  const chatIdOf = () => (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");

  it("<START> in example dialogue becomes the [Example Chat] marker line", async () => {
    fs.writeFileSync(path.join(root, "characters", "aria", "card.json"), JSON.stringify({
      spec: "chara_card_v2", name: "Aria", description: "A barista.", personality: "dry", scenario: "night",
      first_mes: "Welcome in.", mes_example: "You: hi<START>Aria: hello there",
    }));
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hey" } }, m);
    const req = m.requests[0]!.req as { messages: { content: string }[] };
    const exampleMsg = req.messages.find((x) => x.content.includes("hello there"))!;
    expect(exampleMsg.content).toContain("[Example Chat]");
    expect(exampleMsg.content).not.toContain("<START>");
  }, 30_000);

  it("a leading 'Name:' the model echoes is stripped when names ride the prompt", async () => {
    const base = JSON.parse(fs.readFileSync(path.join(root, "presets", "default.json"), "utf8")) as { studio?: Record<string, unknown> };
    base.studio = { ...base.studio, namesBehavior: "content" };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
    const m = mockHost({ text: "Aria: Sure thing, coming up." });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "one coffee" } }, m);
    expect((r.json.reply as { text: string }).text).toBe("Sure thing, coming up.");
    // and with names OFF the echo is kept verbatim (nothing rides, nothing strips)
    base.studio = { ...base.studio, namesBehavior: "none" };
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify(base));
    const m2 = mockHost({ text: "Aria: Kept verbatim." });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m2);
    const id2 = chatIdOf();
    const r2 = await drive(engineUrl, { method: "POST", path: `/chats/${id2}/send`, body: { text: "another" } }, m2);
    expect((r2.json.reply as { text: string }).text).toBe("Aria: Kept verbatim.");
  }, 30_000);
});

describe("rp studio engine: memory cutoff + summary", () => {
  const chatIdOf = () => (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");

  it("the cutoff drops everything above it from the prompt; the cutoff message stays", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "the early secret phrase" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "the recent topic" } }, m);
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const msgs = chat.json.messages as { id: string; role: string; text: string }[];
    // cut at the SECOND char reply: the greeting + first exchange leave, the
    // second exchange onward stays
    const cutTarget = msgs.filter((x) => x.role === "char")[1]!.id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { memoryCutoffMessageId: cutTarget } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "after cutoff" } }, m);
    const req = m.requests.at(-1)!.req as { messages: { content: string }[] };
    expect(req.messages.some((x) => x.content.includes("the early secret phrase"))).toBe(false);
    expect(req.messages.some((x) => x.content.includes("the recent topic"))).toBe(true);
    expect(req.messages.some((x) => x.content.includes("after cutoff"))).toBe(true);
  }, 30_000);

  it("compact folds older turns into the summary, keeps the newest verbatim, and the summary rides the prompt", async () => {
    const m = mockHost({ text: "SUMMARY: the traveler met the barista." });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "more talk" } }, m);
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2 } }, m);
    expect(r.json.summary).toContain("the traveler met the barista");
    expect(r.json.covered).toBe(3); // greeting, "hello", its reply
    const summaryReq = m.requests.at(-1)!.req as { messages: { role: string; content: string }[] };
    expect(summaryReq.messages[1]!.content).toContain("hello");
    expect(summaryReq.messages[1]!.content).not.toContain("more talk");
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    const meta = chat.json.meta as { summary?: string; memoryCutoffMessageId?: string };
    const msgs = chat.json.messages as { id: string; text: string }[];
    expect(meta.summary).toContain("the traveler met the barista");
    expect(meta.memoryCutoffMessageId).toBe(msgs.find((x) => x.text === "more talk")!.id);
    // the next generation carries the summary INSTEAD of the covered turns
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "fresh turn" } }, m);
    const req = m.requests.at(-1)!.req as { messages: { content: string }[] };
    expect(req.messages.some((x) => x.content.includes("the traveler met the barista"))).toBe(true);
    expect(req.messages.some((x) => x.content.includes("hello"))).toBe(false);
    expect(req.messages.some((x) => x.content.includes("more talk"))).toBe(true);
  }, 30_000);

  it("undo restores the summary and cutoff from before; redo rewrites from the same start", async () => {
    const m = mockHost({ text: "FIRST SUMMARY" });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    for (const t of ["one", "two", "three"]) await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: t } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 4 } }, m);
    const m2 = mockHost({ text: "SECOND SUMMARY" });
    const second = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2 } }, m2);
    expect(second.json.compactions).toBe(2);
    // the second pass starts from the first summary
    expect((m2.requests.at(-1)!.req as { messages: { content: string }[] }).messages[1]!.content).toContain("FIRST SUMMARY");
    const m3 = mockHost({ text: "REWRITTEN SECOND" });
    const redo = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { redo: true } }, m3);
    expect(redo.json.summary).toBe("REWRITTEN SECOND");
    expect(redo.json.compactions).toBe(2); // a rewrite, not another step
    const redoReq = (m3.requests.at(-1)!.req as { messages: { content: string }[] }).messages[1]!.content;
    expect(redoReq).toContain("FIRST SUMMARY");
    expect(redoReq).not.toContain("SECOND SUMMARY");
    const undo = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact/undo` }, m3);
    expect(undo.json.summary).toBe("FIRST SUMMARY");
    expect(undo.json.compactions).toBe(1);
    const undo2 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact/undo` }, m3);
    expect(undo2.json.summary).toBe("");
    expect(undo2.json.cutoffMessageId).toBeNull();
    const none = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact/undo` }, m3);
    expect(none.status).toBe(400);
  }, 30_000);

  it("each compaction adds a summary of its own stretch and leaves the earlier ones as written", async () => {
    const m = mockHost({ text: "PART ONE: they met." });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    for (const t of ["one", "two", "three"]) await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: t } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 4 } }, m);
    const m2 = mockHost({ text: "PART TWO: they argued." });
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2 } }, m2);
    // the second request summarizes only its own messages; the first summary is context
    const asked = (m2.requests.at(-1)!.req as { messages: { content: string }[] }).messages[1]!.content;
    expect(asked).toContain("already summarized");
    expect(asked.split("Messages to summarize:")[1]).toContain("two");
    expect(asked.split("Messages to summarize:")[1]).not.toContain("one");
    const chat = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m2);
    const meta = chat.json.meta as { summary: string; summaryParts: { id: string; text: string; from: string | null; to: string }[]; memoryCutoffMessageId: string };
    expect(meta.summaryParts.map((p) => p.text)).toEqual(["PART ONE: they met.", "PART TWO: they argued."]);
    expect(meta.summary).toBe("PART ONE: they met.\n\nPART TWO: they argued.");
    // each part knows its stretch: the second starts where the first ended
    expect(meta.summaryParts[0]!.from).toBeNull();
    expect(meta.summaryParts[1]!.from).toBe(meta.summaryParts[0]!.to);
    expect(meta.summaryParts[1]!.to).toBe(meta.memoryCutoffMessageId);
    // both ride the prompt, oldest first
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "fresh" } }, m2);
    const sys = (m2.requests.at(-1)!.req as { messages: { content: string }[] }).messages.map((x) => x.content).join("\n");
    expect(sys.indexOf("PART ONE")).toBeGreaterThan(-1);
    expect(sys.indexOf("PART TWO")).toBeGreaterThan(sys.indexOf("PART ONE"));
  }, 30_000);

  it("summaries are edited one at a time; an emptied one is gone; a flat summary becomes one part", async () => {
    const m = mockHost({ text: "FIRST" });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    for (const t of ["one", "two", "three"]) await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: t } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 4 } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2 } }, mockHost({ text: "SECOND" }));
    type Meta = { summary: string; summaryParts?: { id: string; text: string; to?: string }[] };
    const read = async () => (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.meta as Meta;
    const [a, b] = (await read()).summaryParts!;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { summaryParts: [{ id: a!.id, text: "FIRST, fixed by hand" }, { id: b!.id, text: "SECOND" }] } }, m);
    let meta = await read();
    expect(meta.summary).toBe("FIRST, fixed by hand\n\nSECOND");
    expect(meta.summaryParts![0]!.to).toBe(a!.to!); // still knows what it covers
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { summaryParts: [{ id: a!.id, text: "" }, { id: b!.id, text: "SECOND" }] } }, m);
    meta = await read();
    expect(meta.summaryParts!.map((p) => p.text)).toEqual(["SECOND"]);
    // writing the flat summary (an older client, or an edit on disk) replaces the list with one part
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { summary: "All of it, written by hand." } }, m);
    meta = await read();
    expect(meta.summaryParts!.map((p) => p.text)).toEqual(["All of it, written by hand."]);
    // a chat from before parts existed: its summary reads as one part and is kept by the next compaction
    const file = path.join(root, "chats", `${id}.meta.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.summaryParts;
    raw.summary = "OLD RUNNING SUMMARY";
    fs.writeFileSync(file, JSON.stringify(raw));
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "four" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "five" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2 } }, mockHost({ text: "NEWEST" }));
    expect((await read()).summaryParts!.map((p) => p.text)).toEqual(["OLD RUNNING SUMMARY", "NEWEST"]);
  }, 30_000);

  it("past the word budget the oldest summaries merge into one, and undo brings them back", async () => {
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you", ui: { summary: { targetLength: 25, maxWords: 60 } } }));
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    type Meta = { summaryParts: { text: string; from: string | null; to: string; merged?: number }[]; memoryCutoffMessageId: string };
    const read = async () => (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.meta as Meta;
    const twenty = (tag: string) => Array.from({ length: 20 }, (_, i) => `${tag}${i}`).join(" ");
    // three compactions, 20 words each: 60 words, right at the budget
    for (const tag of ["a", "b", "c"]) {
      await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: `turn ${tag}` } }, m);
      const h = mockHost({ text: twenty(tag) });
      await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 1 } }, h);
      expect(h.requests.filter((x) => x.key === "merge")).toHaveLength(0);
    }
    const before = await read();
    expect(before.summaryParts).toHaveLength(3);
    // the fourth would pass it: the oldest two are merged in the same pass
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "turn d" } }, m);
    const h = mockHost({ text: "ONE REPLY FOR BOTH REQUESTS" });
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 1 } }, h);
    const mergeReq = h.requests.find((x) => x.key === "merge")!.req as { messages: { content: string }[] };
    expect(mergeReq.messages[1]!.content).toContain("a0");
    expect(mergeReq.messages[1]!.content).toContain("b0");
    expect(mergeReq.messages[1]!.content).not.toContain("c0"); // the newer ones stay as written
    const after = await read();
    expect(after.summaryParts).toHaveLength(3); // merged, c, the new one
    expect(after.summaryParts[0]!.merged).toBe(2);
    expect(after.summaryParts[0]!.from).toBeNull();
    expect(after.summaryParts[0]!.to).toBe(before.summaryParts[1]!.to);
    expect(after.summaryParts[1]!.text).toBe(twenty("c"));
    const undo = await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact/undo` }, m);
    expect(undo.status).toBe(200);
    const back = await read();
    expect(back.summaryParts.map((p) => p.text)).toEqual(before.summaryParts.map((p) => p.text));
    expect(back.memoryCutoffMessageId).toBe(before.memoryCutoffMessageId);
  }, 30_000);

  it("a scene is drafted as a lorebook entry from the chosen messages and nothing is saved", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "I hand over the brass compass" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "an unrelated later turn" } }, m);
    const msgs = (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.messages as { id: string; text: string }[];
    const from = msgs[0]!.id;
    const to = msgs.find((x) => x.text === "I hand over the brass compass")!.id;
    const h = mockHost({ text: 'Sure:\n{"title": "The compass", "keys": ["compass", "brass", "compass"], "content": "The traveler gave Aria a brass compass."}' });
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/scene`, body: { from, to } }, h);
    expect(r.json.draft).toEqual({ title: "The compass", keys: ["compass", "brass"], content: "The traveler gave Aria a brass compass." });
    expect(r.json.covered).toBe(2);
    const asked = (h.requests.at(-1)!.req as { messages: { content: string }[] }).messages;
    expect(asked[1]!.content).toContain("brass compass");
    expect(asked[1]!.content).not.toContain("unrelated later turn");
    expect(asked[0]!.content).toContain("Aria alone is not a key");
    expect(fs.readdirSync(path.join(root, "lorebooks")).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    // a reply that is not JSON still gives an entry to edit
    const plain = await drive(engineUrl, { method: "POST", path: `/chats/${id}/scene`, body: { from, to } }, mockHost({ text: "The traveler gave Aria a compass." }));
    expect(plain.json.draft).toEqual({ title: "", keys: [], content: "The traveler gave Aria a compass." });
    const bad = await drive(engineUrl, { method: "POST", path: `/chats/${id}/scene`, body: { from: "nope", to } }, m);
    expect(bad.status).toBe(404);
  }, 30_000);

  it("a send reports history the context could not hold", async () => {
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify({ id: "default", name: "Default", prompts: [], prompt_order: [], openai_max_context: 60 }));
    const m = mockHost({ text: "x".repeat(400) });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "first" } }, m);
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "second" } }, m);
    expect(r.json.trimmed).toBeGreaterThan(0);
  }, 30_000);
});

describe("rp studio engine: world info scope", () => {
  // a library book that is NOT global and NOT linked to any character —
  // the exact shape that used to fire in every chat via the "empty scope
  // scans everything" fallback
  const shipTownBook = () => {
    fs.writeFileSync(path.join(root, "lorebooks", "town.json"), JSON.stringify({
      id: "town", name: "Town", globalActive: false, linkedCharacterIds: [],
      settings: {}, vectorized: null, isEmbedded: false, formatTemplate: "", folderId: null,
      entries: [{ uid: 0, title: "Tavern", keys: ["tavern"], content: "A cozy tavern.", constant: true, enabled: true, order: 100, position: "before_char" }],
    }));
  };
  const chatIdOf = (r: { json: Record<string, unknown> }) => (r.json.meta as { id: string }).id;
  const shipBook = (id: string, entries: Record<string, unknown>[]) => {
    fs.writeFileSync(path.join(root, "lorebooks", id + ".json"), JSON.stringify({
      id, name: id, globalActive: false, linkedCharacterIds: [], entries,
    }));
  };

  it("a chat with no bound books scans NOTHING — unbound constants never fire", async () => {
    shipTownBook();
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    const status = await drive(engineUrl, { method: "POST", path: "/wi-status", body: { chatId: id } }, m);
    expect(status.json.fired as unknown[]).toHaveLength(0);
    const sent = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "mock/model" } }, m);
    expect(sent.status).toBe(200);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    expect(req.messages.some((x) => x.role === "system" && x.content.includes("A cozy tavern."))).toBe(false);
  }, 30_000);

  it("chat lore stays isolated, survives inherited scope refresh and can be removed", async () => {
    shipTownBook();
    const m = mockHost();
    const create = async () => chatIdOf(await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m));
    const first = await create();
    const second = await create();
    await drive(engineUrl, { method: "PATCH", path: `/chats/${first}`, body: { chatLorebookIds: ["town"] } }, m);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${first}`, body: { lorebookIds: [] } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: first } }, m);
    expect(JSON.stringify(peek.json.messages)).toContain("A cozy tavern.");
    const isolated = await drive(engineUrl, { method: "POST", path: "/wi-status", body: { chatId: second } }, m);
    expect(isolated.json.fired as unknown[]).toHaveLength(0);
    await drive(engineUrl, { method: "POST", path: `/chats/${first}/send`, body: { text: "hello", model: "mock/model" } }, m);
    expect(JSON.stringify(m.requests[0]!.req)).toContain("A cozy tavern.");
    await drive(engineUrl, { method: "PATCH", path: `/chats/${first}`, body: { lorebookIds: ["town"] } }, m);
    const deduped = await drive(engineUrl, { method: "POST", path: "/wi-status", body: { chatId: first } }, m);
    expect(deduped.json.fired as unknown[]).toHaveLength(1);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${first}`, body: { lorebookIds: [], chatLorebookIds: [] } }, m);
    const removed = await drive(engineUrl, { method: "POST", path: "/wi-status", body: { chatId: first } }, m);
    expect(removed.json.fired as unknown[]).toHaveLength(0);
  });

  it("a send reads only the books in the chat's scope", async () => {
    shipTownBook();
    for (let i = 0; i < 5; i++) shipBook(`other${i}`, [{ uid: 0, title: "Other", keys: [], content: "Not this one.", constant: true, enabled: true, order: 100, position: "before_char" }]);
    const m = mockHost();
    const reads: string[] = [];
    const read = m.host.fs.read;
    m.host.fs.read = (rel: string) => { reads.push(rel); return read(rel); };
    const id = chatIdOf(await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m));
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { chatLorebookIds: ["town"] } }, m);
    reads.length = 0;
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(JSON.stringify(peek.json.messages)).toContain("A cozy tavern.");
    expect(JSON.stringify(peek.json.messages)).not.toContain("Not this one.");
    expect(reads.filter((r) => r.startsWith("lorebooks/other"))).toEqual([]);
  });

  it("entry status is the constant source of truth; the legacy boolean only counts when status is absent", async () => {
    shipBook("statusbook", [
      { uid: 0, title: "Status const", keys: [], content: "Status constant, no boolean.", status: "constant", enabled: true, order: 100, position: "before_char" },
      { uid: 1, title: "Contradictory", keys: [], content: "Boolean says constant, status says normal.", status: "normal", constant: true, enabled: true, order: 100, position: "before_char" },
      { uid: 2, title: "Legacy", keys: [], content: "Legacy boolean constant.", constant: true, enabled: true, order: 100, position: "before_char" },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["statusbook"] } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "hello" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("Status constant, no boolean."); // status-only constant fires
    expect(sys).toContain("Legacy boolean constant."); // legacy boolean (no status) still fires
    expect(sys).not.toContain("Boolean says constant"); // contradictory pair: status wins, no keys → stays out
  }, 30_000);

  it("recursion: an entry's content can trigger another entry", async () => {
    shipBook("chain", [
      { uid: 0, title: "Mentions ember", keys: ["lantern"], content: "The lantern holds a captured EMBERFLARE.", enabled: true, order: 100, position: "before_char" },
      { uid: 1, title: "Emberflare lore", keys: ["emberflare"], content: "An emberflare is a fire spirit.", enabled: true, order: 100, position: "before_char" },
      { uid: 2, title: "Not reachable", keys: ["never-said"], content: "Should stay out.", enabled: true, order: 100, position: "before_char" },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["chain"] } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "show me the lantern" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("captured EMBERFLARE"); // keyed by the user text
    expect(sys).toContain("An emberflare is a fire spirit."); // keyed by the FIRST entry's content
    expect(sys).not.toContain("Should stay out.");
  }, 30_000);

  it("preventFurtherRecursion stops the chain; nonRecursable only fires on the base scan", async () => {
    shipBook("chain2", [
      { uid: 0, title: "A", keys: ["alpha"], content: "Alpha reveals BETA-marker.", enabled: true, order: 100, position: "before_char", preventFurtherRecursion: true },
      { uid: 1, title: "B", keys: ["beta-marker"], content: "Beta lore.", enabled: true, order: 100, position: "before_char" },
      { uid: 2, title: "C", keys: ["gamma"], content: "Gamma direct.", enabled: true, order: 100, position: "before_char", nonRecursable: true },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["chain2"] } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "alpha and gamma" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("Alpha reveals"); // fired by user text
    expect(sys).not.toContain("Beta lore."); // A's content must not join the scan
    expect(sys).toContain("Gamma direct."); // nonRecursable fires on the base scan
  }, 30_000);

  it("sticky keeps a fired entry in after its key leaves the window; cooldown then locks it out", async () => {
    shipBook("sticky", [
      // a turn is 2 messages (user + reply): sticky 3 spans the fire turn plus
      // one more, cooldown 3 locks it out for the turn after that
      { uid: 0, title: "Guard", keys: ["guard"], content: "The guard is alert.", enabled: true, order: 100, position: "before_char", sticky: 3, cooldown: 3 },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["sticky"] } }, m);
    const sysOf = (i: number) => (m.requests[i]!.req as { messages: { content: string }[] }).messages.map((x) => x.content).join("\n");
    // fire it: "guard" in the sent text (scan counts greeting, the user
    // message and its staged copy = tick 3)
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "the guard looks at me", model: "mock/model" } }, m);
    expect(sysOf(0)).toContain("The guard is alert.");
    const meta1 = JSON.parse(fs.readFileSync(path.join(root, "chats", id + ".meta.json"), "utf8"));
    expect(meta1.wiTimed.sticky["sticky#0"]).toMatchObject({ start: 3, end: 6 });
    // next turn WITHOUT the key (tick 5, sticky end 6): still in the prompt
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "small talk", model: "mock/model" } }, m);
    expect(sysOf(1)).toContain("The guard is alert.");
    // the turn after (tick 7 >= end 6): sticky expired, cooldown armed — even
    // a fresh key hit is suppressed
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "the guard again", model: "mock/model" } }, m);
    expect(sysOf(2)).not.toContain("The guard is alert.");
    const meta2 = JSON.parse(fs.readFileSync(path.join(root, "chats", id + ".meta.json"), "utf8"));
    expect(meta2.wiTimed.cooldown["sticky#0"]).toMatchObject({ start: 7, end: 10 });
  }, 30_000);

  it("delay holds an entry back until the chat grows", async () => {
    shipBook("delayed", [
      { uid: 0, title: "Late", keys: ["road"], content: "The road winds north.", enabled: true, order: 100, position: "before_char", delay: 4 },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["delayed"] } }, m);
    // chat has 1 message (greeting); a peek staged user text leaves tick at 1 < 4
    const early = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "the road" } }, m);
    expect((early.json.messages as { content: string }[]).map((x) => x.content).join("\n")).not.toContain("The road winds north.");
  }, 30_000);

  it("inclusion groups pick ONE winner (override beats the roll)", async () => {
    shipBook("grouped", [
      { uid: 0, title: "G-red", keys: ["color"], content: "The banner is red.", enabled: true, order: 100, position: "before_char", group: "banner" },
      { uid: 1, title: "G-blue", keys: ["color"], content: "The banner is blue.", enabled: true, order: 100, position: "before_char", group: "banner", groupOverride: true },
      { uid: 2, title: "Free", keys: ["color"], content: "The banner flaps.", enabled: true, order: 100, position: "before_char" },
    ]);
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["grouped"] } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "what color" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("The banner is blue."); // override wins
    expect(sys).not.toContain("The banner is red."); // group loser
    expect(sys).toContain("The banner flaps."); // ungrouped entry unaffected
  }, 30_000);

  it("regex keys match as patterns; scan depth is preset-controlled", async () => {
    shipBook("regexed", [
      { uid: 0, title: "Shout", keys: ["/hel+o!/"], content: "Someone shouted.", enabled: true, order: 100, position: "before_char" },
      { uid: 1, title: "Old", keys: ["ancientword"], content: "Ancient lore.", enabled: true, order: 100, position: "before_char" },
    ]);
    // preset: scan only the LAST message (default 4 would still see it — set
    // scanDepth 1 and push the trigger deeper than the window)
    fs.writeFileSync(path.join(root, "presets", "shallows.json"), JSON.stringify({
      id: "shallows", name: "Shallow", prompts: [], prompt_order: [],
      studio: { worldInfo: { scanDepth: 1 } },
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "shallows" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["regexed"] } }, m);
    // an earlier message carries the plain key; the staged text carries the
    // regex key — scanDepth 1 keeps only the staged text in the window
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "an ancientword passes by", model: "mock/model" } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "hellllo!" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("Someone shouted."); // regex key matched
    expect(sys).not.toContain("Ancient lore."); // outside the 1-message window
  }, 30_000);

  it("binding the book to the chat brings it into scope (positive control)", async () => {
    shipTownBook();
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf(chat);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["town"] } }, m);
    const status = await drive(engineUrl, { method: "POST", path: "/wi-status", body: { chatId: id } }, m);
    expect((status.json.fired as { book: string }[]).some((f) => f.book === "Town")).toBe(true);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "mock/model" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    expect(req.messages.some((x) => x.role === "system" && x.content.includes("A cozy tavern."))).toBe(true);
  }, 30_000);
});

describe("rp studio import", () => {
  it("batch: a chat goes to the character id it names, whatever the name says", async () => {
    const m = mockHost();
    const lines = [{ user_name: "You", character_name: "Someone Else" }, { name: "Someone Else", is_user: false, mes: "hello", send_date: "2024-01-01" }];
    const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { chats: [{ character: "Someone Else", characterId: "aria", file: "x", lines }] } }, m);
    const id = (r.json.chats as string[])[0]!;
    expect(JSON.parse(fs.readFileSync(path.join(root, "chats", `${id}.meta.json`), "utf8")).characterId).toBe("aria");
    const missing = await drive(stUrl, { method: "POST", path: "/import/batch", body: { chats: [{ character: "Aria", characterId: "gone", file: "y", lines }] } }, m);
    const other = (missing.json.chats as string[])[0]!;
    expect(JSON.parse(fs.readFileSync(path.join(root, "chats", `${other}.meta.json`), "utf8")).characterId).toBe("aria");
  });
  it("batch: cards + worlds + presets + regex land in the app data", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        cards: [{ name: "Imported Bot", description: "test", first_mes: "hi" }],
        worldInfo: [{ name: "Town", entries: { 0: { key: ["tavern"], content: "A cozy tavern.", constant: false } } }],
        presets: [{ name: "Imported Preset", temperature: 1.2, prompts: [{ identifier: "main", name: "Main", role: "system", content: "be nice" }] }],
        regex: [{ scriptName: "Trim", findRegex: "/foo/g", replaceString: "", placement: [1] }],
        personas: [{ name: "Hero", description: "brave" }],
      },
    }, m);
    expect(r.json.characters).toHaveLength(1);
    expect(r.json.lorebooks).toHaveLength(1);
    expect(r.json.presets).toHaveLength(1);
    expect(r.json.regex).toHaveLength(1);
    expect(r.json.personas).toHaveLength(1);
    // preset kept the prompts[] shape with prompt_order normalized
    const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", `${(r.json.presets as string[])[0]}.json`), "utf8"));
    expect(preset.prompts[0].content).toBe("be nice");
    expect(preset.prompt_order[0].order[0].identifier).toBe("main");
    // regex placement numbers: 1 user input, 2 AI output; /re/flags parsed
    const rx = JSON.parse(fs.readFileSync(path.join(root, "regex", `${(r.json.regex as string[])[0]}.json`), "utf8"));
    expect(rx.placement).toEqual(["user_input"]);
    expect(rx.findRegex).toBe("foo");
    expect(rx.flags).toBe("g");
  }, 30_000);

  it("preset section groups wrap consecutive members; conditions gate sections", async () => {
    fs.writeFileSync(path.join(root, "presets", "grouped.json"), JSON.stringify({
      id: "grouped", name: "Grouped",
      prompts: [
        { identifier: "a", name: "A", role: "system", content: "Alpha text." },
        { identifier: "b", name: "B", role: "system", content: "Beta text." },
        { identifier: "c", name: "C", role: "system", content: "Gamma text." },
        { identifier: "cond", name: "Cond", role: "system", content: "Night mode text." },
      ],
      prompt_order: [{ character_id: 100000, order: [
        { identifier: "a", enabled: true }, { identifier: "b", enabled: true },
        { identifier: "c", enabled: true }, { identifier: "cond", enabled: true },
      ] }],
      studio: {
        groups: [{ id: "g1", name: "Style Notes", wrapFormat: "xml" }],
        sections: [
          { id: "a", groupId: "g1" }, { id: "b", groupId: "g1" },
          { id: "c", groupId: null }, { id: "cond", groupId: null, condition: "mood==tense" },
        ],
      },
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "grouped" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const sysOf = async () => {
      const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
      return (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    };
    // group members merge into one xml-wrapped block; the condition fails (no var)
    let sys = await sysOf();
    expect(sys).toContain("<style-notes>\nAlpha text.\nBeta text.\n</style-notes>");
    expect(sys).toContain("Gamma text.");
    expect(sys).not.toContain("Night mode text.");
    // set the chat var the condition waits on: the section appears
    const metaPath = path.join(root, "chats", id + ".meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.chatVars = { mood: "tense" };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    sys = await sysOf();
    expect(sys).toContain("Night mode text.");
  }, 30_000);

  it("author's note object: position, depth and role all honored", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const peekMsgs = async () => {
      const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "hello" } }, m);
      return peek.json.messages as { role: string; content: string }[];
    };
    // in-chat @ depth 1, system role: the note sits right before the staged user turn
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "keep it tense", position: "in-chat", depth: 1, role: "system" } } }, m);
    let msgs = await peekMsgs();
    expect(msgs[msgs.length - 2]!.content).toContain("[Author's note]");
    expect(msgs[msgs.length - 2]!.role).toBe("system");
    // in-chat @ depth 2: one earlier (between greeting and user turn)
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "keep it tense", position: "in-chat", depth: 2, role: "user" } } }, m);
    msgs = await peekMsgs();
    expect(msgs[msgs.length - 3]!.content).toContain("[Author's note]");
    expect(msgs[msgs.length - 3]!.role).toBe("user");
    // before-system: the note leads the whole prompt
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "keep it tense", position: "before-system", role: "system" } } }, m);
    msgs = await peekMsgs();
    expect(msgs[0]!.content).toContain("[Author's note]");
    // after-system: after the system block, still above the chat history
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "keep it tense", position: "after-system", role: "system" } } }, m);
    msgs = await peekMsgs();
    const noteIdx = msgs.findIndex((x) => x.content.includes("[Author's note]"));
    const greetIdx = msgs.findIndex((x) => x.content.includes("Welcome in"));
    expect(noteIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeLessThan(greetIdx);
  }, 30_000);

  it("author's note with includeInWIScan feeds world-info keys", async () => {
    fs.writeFileSync(path.join(root, "lorebooks", "notekey.json"), JSON.stringify({
      id: "notekey", name: "notekey", globalActive: false, linkedCharacterIds: [],
      entries: [{ uid: 0, title: "Codeword", keys: ["secretrailway"], content: "The secret railway opens at dusk.", enabled: true, order: 100, position: "before_char" }],
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["notekey"] } }, m);
    // without the scan flag the note's keyword does not fire the entry
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "the secretrailway hums", position: "after-system", role: "system" } } }, m);
    let peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    let sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).not.toContain("The secret railway opens at dusk.");
    // with it, the entry activates off the note text
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "the secretrailway hums", position: "after-system", role: "system", includeInWIScan: true } } }, m);
    peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("The secret railway opens at dusk.");
  }, 30_000);

  it("audit fixes: regex depth bounds, case-sensitive WI, matchSources, budget knobs, note frequency", async () => {
    const m = mockHost();
    // regex depth: a script bounded to depth 0-1 must not touch older messages
    fs.writeFileSync(path.join(root, "regex", "near.json"), JSON.stringify({ scriptName: "NearOnly", findRegex: "old", replaceString: "NEW", placement: ["user_input", "ai_output"], minDepth: 0, maxDepth: 1 }));
    let chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    let id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "old things", model: "mock/model" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "fresh", model: "mock/model" } }, m);
    let peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    let sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("old things"); // depth 3: outside the 0-1 window, untouched
    expect(sys).not.toContain("NEW"); // so the bounded script never rewrote it

    // case-sensitive book: key "Lantern" fires on the raw card text, and a
    // lowercase "lantern" in chat does NOT fire it
    fs.writeFileSync(path.join(root, "lorebooks", "cased.json"), JSON.stringify({
      id: "cased", name: "cased", entries: [{ uid: 0, title: "C", keys: ["Lantern"], content: "Case-fired lore.", enabled: true, order: 100, position: "before_char", caseSensitive: true }],
      settings: { caseSensitive: true },
    }));
    chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["cased"] } }, m);
    peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "the lantern glows" } }, m);
    sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).not.toContain("Case-fired lore."); // lowercase chat text misses

    // matchSources: an entry keyed on a word only present in the card's
    // DESCRIPTION fires when its matchSources.description flag is on
    fs.writeFileSync(path.join(root, "lorebooks", "srcd.json"), JSON.stringify({
      id: "srcd", name: "srcd", entries: [{ uid: 0, title: "S", keys: ["barista"], content: "Source-fired lore.", enabled: true, order: 100, position: "before_char", matchSources: { description: true, personality: false, scenario: false, persona: false } }],
    }));
    chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["srcd"] } }, m);
    peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("Source-fired lore."); // "A barista." is in the card description

    // author's note frequency 2: with an even message count it rides, odd it does not
    chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { authorNoteObject: { text: "every other", position: "in-chat", depth: 1, role: "system", frequency: 2 } } }, m);
    peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect((peek.json.messages as { content: string }[]).map((x) => x.content).join("\n")).not.toContain("every other"); // 1 message: odd
    peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "hi" } }, m);
    expect((peek.json.messages as { content: string }[]).map((x) => x.content).join("\n")).toContain("every other"); // 2: even
  }, 30_000);

  it("memory vault CRUD: add, pin, update, delete", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const add = await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories`, body: { text: "Ember keeps a lantern that never goes out.", importance: 5 } }, m);
    expect((add.json.memory as { pinned: boolean }).pinned).toBe(false);
    const mid = (add.json.memory as { id: string }).id;
    const patch = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/memories/${mid}`, body: { pinned: true } }, m);
    expect((patch.json.memory as { pinned: boolean }).pinned).toBe(true);
    const list = await drive(engineUrl, { method: "GET", path: `/chats/${id}/memories` }, m);
    expect(list.json.memories).toHaveLength(1);
    const del = await drive(engineUrl, { method: "DELETE", path: `/chats/${id}/memories/${mid}` }, m);
    expect(del.status).toBe(200);
    const list2 = await drive(engineUrl, { method: "GET", path: `/chats/${id}/memories` }, m);
    expect(list2.json.memories).toHaveLength(0);
  }, 30_000);

  it("extract stores model facts, dedupes repeats, and refuses empty results honestly", async () => {
    const m = mockHost({ text: '[{"text": "The traveler carries a brass compass.", "importance": 3}, {"text": "Ember promised to trade a story.", "importance": 4}]' });
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories/extract` }, m);
    expect(r.status).toBe(200);
    expect((r.json.added as unknown[])).toHaveLength(2);
    // the same reply again: near-duplicates drop out
    const r2 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories/extract` }, m);
    expect((r2.json.added as unknown[])).toHaveLength(0);
    expect(r2.json.total).toBe(2);
    // a model reply with no facts is an honest 422, not a silent store
    const m2 = mockHost({ text: "I see nothing worth keeping." });
    const r3 = await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories/extract` }, m2);
    expect(r3.status).toBe(422);
  }, 30_000);

  it("memories ride the prompt: pinned always, others by relevance", async () => {
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories`, body: { text: "The traveler carries a brass compass.", importance: 3 } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories`, body: { text: "Ember hates getting wet.", importance: 3, pinned: true } }, m);
    // irrelevant keyword: only the pinned entry rides
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "tell me about the weather" } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("[Long-term memories");
    expect(sys).toContain("Ember hates getting wet.");
    expect(sys).not.toContain("brass compass");
    // relevant keyword: both ride
    const peek2 = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "which way does the compass point" } }, m);
    const sys2 = (peek2.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys2).toContain("brass compass");
  }, 30_000);

  it("facts are matched by words: finding and recalling them never asks for embeddings", async () => {
    const m = mockHost(
      { text: '[{"text": "Ember guards a lantern that never goes out.", "importance": 4}]' },
      undefined,
      (texts) => texts.map(() => [1, 0]),
    );
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories/extract` }, m);
    expect((r.json.added as unknown[])).toHaveLength(1);
    const mems = await drive(engineUrl, { method: "GET", path: `/chats/${id}/memories` }, m);
    expect((mems.json.memories as { vector?: number[] }[])[0]!.vector).toBeUndefined();
    // a shared word brings the fact back; a turn that shares none leaves it out
    const hit = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "is the lantern still lit" } }, m);
    expect((hit.json.messages as { content: string }[]).map((x) => x.content).join("\n")).toContain("guards a lantern");
    const miss = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "the flame and its light" } }, m);
    expect((miss.json.messages as { content: string }[]).map((x) => x.content).join("\n")).not.toContain("guards a lantern");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "tell me about the lantern" } }, m);
    expect(m.embedRequests).toHaveLength(0);
  }, 30_000);

  it("vectorized lorebook entries activate on similarity, with a cached sidecar", async () => {
    fs.writeFileSync(path.join(root, "lorebooks", "vecbook.json"), JSON.stringify({
      id: "vecbook", name: "vecbook", entries: [
        { uid: 0, title: "V", keys: [], content: "The harbor district floods every spring.", enabled: true, order: 100, position: "before_char", status: "vectorized" },
      ],
      vectorized: { scoreThreshold: 0.35 },
    }));
    // harbor-ish text -> [1,0]; everything else [0,1]
    const m = mockHost(undefined, undefined, (texts) => texts.map((t) => (t.includes("harbor") ? [1, 0] : [0, 1])));
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { lorebookIds: ["vecbook"] } }, m);
    // user text about rain and docks embeds [0,1]... give it the harbor word to embed [1,0]
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "harbor at night" } }, m);
    let sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("harbor district floods"); // fired by cosine, not keys
    // the sidecar cached the entry vector
    const sidecar = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", ".vectors.json"), "utf8")) as Record<string, { vector: number[] }>;
    expect(sidecar["vecbook#0"]!.vector).toEqual([1, 0]);
    // second peek: entry now cached, only the scan embeds
    const peek2 = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id, userText: "harbor again" } }, m);
    sys = (peek2.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("harbor district floods");
  }, 30_000);

  it("auto-extract rides a send every N messages, and skips turns in between", async () => {
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you", ui: { memory: { enabled: true, auto: true, interval: 2 } } }));
    const m = mockHost({ text: '[{"text": "The traveler carries a brass compass.", "importance": 3}]' });
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    // first send: staged length 2 >= interval 2 → memory extraction armed
    const sent = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello" } }, m);
    expect(sent.json.memoriesAdded).toBe(1);
    const mems = await drive(engineUrl, { method: "GET", path: `/chats/${id}/memories` }, m);
    expect((mems.json.memories as { text: string }[])[0]!.text).toContain("compass");
    // second send: below the interval again → no memory request armed
    const keysBefore = m.requests.map((r) => r.key);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "again" } }, m);
    const newKeys = m.requests.slice(keysBefore.length).map((r) => r.key);
    expect(newKeys).not.toContain("memory");
  }, 30_000);

  it("summaries and facts use the memory model when one is set, the chat's model otherwise", async () => {
    const settingsWith = (memory: Record<string, unknown>) =>
      fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you", ui: { memory } }));
    settingsWith({ enabled: true, auto: true, interval: 2, model: "cheap/summarizer" });
    const m = mockHost({ text: '[{"text": "The traveler carries a brass compass.", "importance": 3}]' });
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "big/storyteller" } }, m);
    const byKey = (key: string) => m.requests.filter((r) => r.key === key).at(-1)!.req as { model?: string };
    expect(byKey("reply").model).toBe("big/storyteller");
    expect(byKey("memory").model).toBe("cheap/summarizer");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "more", model: "big/storyteller" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/compact`, body: { keepRecent: 2, model: "big/storyteller" } }, m);
    expect(byKey("summary").model).toBe("cheap/summarizer");

    settingsWith({ enabled: true, auto: false, interval: 20, model: "" });
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/memories/extract`, body: { model: "big/storyteller" } }, m);
    expect(byKey("memory").model).toBe("big/storyteller");
  }, 30_000);

  it("normalizes legacy world positions and skips empty entries", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: { worldInfo: [{ name: "W", entries: { a: { key: ["x"], content: "kept", position: 1 }, b: { key: ["y"], content: "  " } } }] },
    }, m);
    expect(r.json.lorebooks).toHaveLength(1);
    const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${(r.json.lorebooks as string[])[0]}.json`), "utf8"));
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0].position).toBe("after_char");
  }, 30_000);

  it("preset import carries the full sampler set, utility prompts and behavior flags", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        presets: [{
          name: "Full Sweep",
          temperature: 0.9, openai_max_tokens: 350, truncation_length: 16384,
          top_k: 40, min_p: 0.05, dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2, dry_last_n: 0,
          xtc_probability: 0.5, xtc_threshold: 0.1, typical_p: 0.9, smoothing_factor: 2.5, temperature_last: true,
          negative_prompt: "avoid this", guidance_scale: 1.2, mirostat_mode: 2, seed: 1234,
          names_behavior: 2, squash_system_messages: true, continue_prefill: false,
          assistant_prefill: "Sure, ",
          stop: ["\\nUser:", "\\n{{user}}:"], custom_stop_strings: "\\nYou:",
          impersonation_prompt: "write the user's next message", continue_nudge_prompt: "[Continue]",
          new_chat_prompt: "[Start a new chat]", group_nudge_prompt: "[Group]",
          reasoning_effort: "low",
          prompts: [{ identifier: "main", name: "Main", role: "system", content: "be nice" }],
        }],
      },
    }, m);
    expect(r.json.presets).toHaveLength(1);
    const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", `${(r.json.presets as string[])[0]}.json`), "utf8"));
    expect(preset.openai_max_context).toBe(16384); // truncation_length alias
    expect(preset.dry_multiplier).toBe(0.8);
    expect(preset.xtc_probability).toBe(0.5);
    expect(preset.typical_p).toBe(0.9);
    expect(preset.smoothing_factor).toBe(2.5);
    expect(preset.temperature_last).toBe(true);
    expect(preset.negative_prompt).toBe("avoid this");
    expect(preset.reasoning).toBe("low");
    expect(preset.studio.namesBehavior).toBe("content"); // names_behavior 2 = always prefix
    expect(preset.studio.squashSystemMessages).toBe(true);
    expect(preset.studio.continuePrefill).toBe(false);
    expect(preset.studio.samplers.assistantPrefill).toBe("Sure, ");
    expect(preset.studio.samplers.stopStrings).toEqual(["\\nUser:", "\\n{{user}}:", "\\nYou:"]);
    expect(preset.utilityPrompts.impersonation).toBe("write the user's next message");
    expect(preset.utilityPrompts.continueNudge).toBe("[Continue]");
    expect(preset.utilityPrompts.newChat).toBe("[Start a new chat]");
    expect(preset.utilityPrompts.groupNudge).toBe("[Group]");

    // the engine forwards the whole set: peek a chat pinned to this preset
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: preset.id } }, m);
    const id = fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json"))!.replace(/\.meta\.json$/, "");
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    const params = ((peek.json.presetParams as { params?: Record<string, unknown> }).params ?? {});
    expect(params.dry_multiplier).toBe(0.8);
    expect(params.xtc_threshold).toBe(0.1);
    expect(params.typical_p).toBe(0.9);
    expect(params.negative_prompt).toBe("avoid this");
    expect(params.seed).toBe(1234);
    expect(params.temperature_last).toBe(true);
    expect(params.stop).toContain("\\nUser:");
    expect(peek.json.assistantPrefill).toBe("Sure, ");
  }, 30_000);

  it("regex import honors markdownOnly/promptOnly and depth bounds", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        regex: [
          { scriptName: "DisplayOnly", findRegex: "foo", replaceString: "bar", placement: [1, 2], markdownOnly: true },
          { scriptName: "PromptOnly", findRegex: "baz", replaceString: "qux", placement: [1], promptOnly: true },
          { scriptName: "Deep", findRegex: "a", replaceString: "b", placement: [1], minDepth: 2, maxDepth: 8 },
        ],
      },
    }, m);
    expect(r.json.regex).toHaveLength(3);
    const all = fs.readdirSync(path.join(root, "regex")).map((f) => JSON.parse(fs.readFileSync(path.join(root, "regex", f), "utf8")) as { scriptName: string; placement: string[]; markdownOnly: boolean; promptOnly: boolean; minDepth: number | null; maxDepth: number | null });
    const display = all.find((x) => x.scriptName === "DisplayOnly")!;
    expect(display.placement).toEqual(["user_input", "ai_output"]);
    expect([display.markdownOnly, display.promptOnly]).toEqual([true, false]);
    const prompt = all.find((x) => x.scriptName === "PromptOnly")!;
    expect(prompt.placement).toEqual(["user_input"]);
    expect([prompt.markdownOnly, prompt.promptOnly]).toEqual([false, true]);
    expect(all.find((x) => x.scriptName === "Deep")?.minDepth).toBe(2);
    expect(all.find((x) => x.scriptName === "Deep")?.maxDepth).toBe(8);
  }, 30_000);
});

describe("rp studio marketplace (chub search)", () => {
  it("searches gateway.chub.ai with a browser UA and normalizes the catalog", async () => {
    const m = mockHost(undefined, (key, req) => {
      expect(key).toBe("search");
      const url = String(req.url);
      expect(url).toContain("https://gateway.chub.ai/search?");
      expect(url).toContain("namespace=characters");
      expect(url).toContain("search=sera");
      expect(String((req.headers as Record<string, string>)["user-agent"])).toContain("Mozilla/5.0");
      return {
        ok: true, status: 200,
        json: { data: { count: 42, page: 1, nodes: [
          {
            name: "Sera", fullPath: "someuser/sera-abc", tagline: "an angel",
            description: "An angel of great renown.", topics: ["RPG", "Female"],
            starCount: 1234, n_favorites: 7, nTokens: 795, rating: 4.5, ratingCount: 7, nChats: 9, nMessages: 90,
            nsfw_image: true, avatar_url: "https://avatars.charhub.io/avatars/someuser/sera-abc/avatar.webp",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ] } },
      };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "chub", search: "sera" } }, m);
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(42);
    const item = (r.json.results as Record<string, unknown>[])[0]!;
    expect(item).toMatchObject({
      id: "someuser/sera-abc", creator: "someuser", name: "Sera", nsfw: true,
      // chub's starCount is the DOWNLOAD count; n_favorites is real favorites
      downloads: 1234, favorites: 7, tokens: 795,
      avatar: "https://avatars.charhub.io/avatars/someuser/sera-abc/avatar.webp",
    });
  }, 30_000);

  it("unknown source is refused, rogue sort falls back to downloads, fetch failure maps to 502", async () => {
    const bad = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "evilcorp" } }, mockHost());
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toContain("unknown marketplace source");

    // an unknown sort key is a 400 at the catalog, never a silent fallback
    // there — so it must never leave here
    const m = mockHost(undefined, (_key, req) => {
      expect(String(req.url)).toContain("sort=download_count");
      return { ok: false, status: 403, error: "forbidden" };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { sort: "DROP TABLE" } }, m);
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toContain("403");
  }, 30_000);

  it("adult listings are asked for by default; trending replaces the ordering", async () => {
    // the catalog hides adult cards unless all three flags are stated, which
    // silently cuts the pool by ~95%
    const m = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      expect(url).toContain("nsfw=true");
      expect(url).toContain("nsfl=false");
      expect(url).toContain("nsfw_only=false");
      expect(url).toContain("include_forks=true");
      return { ok: true, status: 200, json: { data: { count: 1, page: 1, nodes: [] } } };
    });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/search", body: {} }, m)).status).toBe(200);

    const safe = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      expect(url).toContain("nsfw=false");
      expect(url).toContain("nsfw_only=false");
      return { ok: true, status: 200, json: { data: { count: 1, page: 1, nodes: [] } } };
    });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { nsfw: false } }, safe)).status).toBe(200);

    // trending is a different POOL, not an ordering: it takes over the sort
    const hot = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      expect(url).toContain("sort=trending");
      expect(url).not.toContain("sort=rating");
      return { ok: true, status: 200, json: { data: { count: 1, page: 1, nodes: [] } } };
    });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { trending: true, sort: "rating" } }, hot)).status).toBe(200);
  }, 30_000);

  it("fine-grained filters ride through; blanks and bad numbers are dropped", async () => {
    const m = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      expect(url).toContain("min_tokens=500");
      expect(url).toContain("max_days_ago=30");
      expect(url).toContain("min_ai_rating=4");
      expect(url).toContain("require_lore=true");
      expect(url).toContain("require_example_dialogues=true");
      expect(url).toContain("excludetopics=gore");
      // false requirements narrow nothing, so they are never sent
      expect(url).not.toContain("require_images");
      // out-of-range numbers are dropped rather than clamped into a lie
      expect(url).not.toContain("min_tags");
      return { ok: true, status: 200, json: { data: { count: 1, page: 1, nodes: [] } } };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: {
      minTokens: 500, maxDaysAgo: 30, minAiRating: 4, minTags: 0,
      requireLore: true, requireExamples: true, requireImages: false,
      excludeTags: ["gore"],
    } }, m);
    expect(r.status).toBe(200);
  }, 30_000);

  it("tag filters ride through (AND default, ANY opt-in) with sanitizing", async () => {
    const m = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      // embedded commas/spaces are neutralized so a tag can't smuggle extra
      // filter params; empty entries dropped; AND is the default
      expect(url).toContain("topics=Female%2CMale%2CFem+ale");
      expect(url).not.toContain("inclusive_or");
      return { ok: true, status: 200, json: { data: { count: 2, page: 1, nodes: [] } } };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { tags: ["Female", "Male", "Fem,ale", ""] } }, m);
    expect(r.status).toBe(200);
    // OR is inclusive_or — tags_mode is not a parameter the catalog reads, so
    // sending it left every "any" search silently ANDed
    const m2 = mockHost(undefined, (_key, req) => {
      expect(String(req.url)).toContain("inclusive_or=true");
      return { ok: true, status: 200, json: { data: { count: 368, page: 1, nodes: [] } } };
    });
    const r2 = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { tags: ["Female", "Male"], tagsMode: "any" } }, m2);
    expect(r2.status).toBe(200);
    // creator rides as chub's username param
    const m3 = mockHost(undefined, (_key, req) => {
      const url = String(req.url);
      expect(url).toContain("username=Jay_D");
      expect(url).toContain("search=abby");
      return { ok: true, status: 200, json: { data: { count: 1, page: 1, nodes: [] } } };
    });
    const r3 = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { search: "abby", creator: "Jay_D" } }, m3);
    expect(r3.status).toBe(200);
  }, 30_000);

  it("detail returns the full card definition (greeting, alternates, lorebook count)", async () => {
    const m = mockHost(undefined, (key, req) => {
      expect(key).toBe("detail");
      expect(String(req.url)).toBe("https://api.chub.ai/api/characters/someuser/sera-abc?full=true");
      return {
        ok: true, status: 200,
        json: { node: { definition: {
          first_message: "Hello there.",
          alternate_greetings: ["Alt one.", "Alt two."],
          personality: "A wary ranger.",
          scenario: "A cold forest.",
          example_dialogs: "<START>...",
          description: "Made for a contest.",
          system_prompt: "",
          post_history_instructions: "",
          embedded_lorebook: { entries: { a: { content: "x" }, b: { content: "y" } } },
        } } },
      };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { source: "chub", id: "someuser/sera-abc" } }, m);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      id: "someuser/sera-abc", greeting: "Hello there.",
      alternateGreetings: ["Alt one.", "Alt two."],
      personality: "A wary ranger.", scenario: "A cold forest.",
      creatorNotes: "Made for a contest.", lorebookEntries: 2,
    });
    const bad = await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { id: "../etc/passwd" } }, mockHost());
    expect(bad.status).toBe(400);
  }, 30_000);
});

describe("rp studio: scoped regex + extended samplers + v3 cards", () => {
  it("preset-scoped regex applies only when the chat uses that preset", async () => {
    fs.writeFileSync(path.join(root, "regex", "scoped.json"), JSON.stringify({
      id: "scoped", scriptName: "Scoped", scope: "preset", scopeTargetId: "scoped-preset",
      findRegex: "PLAIN", replaceString: "SCRUBBED", placement: ["ai_output", "user_input", "prompt"], disabled: false,
    }));
    fs.writeFileSync(path.join(root, "regex", "global.json"), JSON.stringify({
      id: "global", scriptName: "Global", scope: "global",
      findRegex: "MARKER", replaceString: "GONE", placement: ["prompt"], disabled: false,
    }));
    fs.writeFileSync(path.join(root, "presets", "scoped-preset.json"), JSON.stringify({
      id: "scoped-preset", name: "Scoped", prompts: [{ identifier: "main", name: "Main", role: "system", marker: true, content: "Say PLAIN things." }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
    }));
    const m1 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "scoped-preset" } }, m1);
    const id1 = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id1}/send`, body: { text: "keep PLAIN here", model: "mock/model" } }, m1);
    const sys1 = (m1.requests[0]!.req as { messages: { role: string; content: string }[] }).messages.map((x) => x.content).join("\n");
    expect(sys1).toContain("Say PLAIN things."); // preset text is never regexed
    expect(sys1).toContain("keep SCRUBBED here"); // the scoped script fired on the turn
    // a chat on a DIFFERENT preset: the scoped script must NOT fire
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "default" } }, m2);
    const id2 = (fs.readdirSync(path.join(root, "chats")).filter((f) => f.endsWith(".meta.json")).map((f) => f.replace(/\.meta\.json$/, "")) as string[]).find((x) => x !== id1)!;
    await drive(engineUrl, { method: "POST", path: `/chats/${id2}/send`, body: { text: "keep PLAIN here", model: "mock/model" } }, m2);
    const sys2 = (m2.requests[0]!.req as { messages: { role: string; content: string }[] }).messages.map((x) => x.content).join("\n");
    expect(sys2).toContain("PLAIN"); // untouched — wrong preset
    expect(sys2).not.toContain("SCRUBBED");
    // global script applies to both chats
    expect(sys1).not.toContain("MARKER");
    expect(sys2).not.toContain("MARKER");
  }, 30_000);

  it("character-scoped regex skips other characters' chats", async () => {
    fs.writeFileSync(path.join(root, "regex", "charonly.json"), JSON.stringify({
      id: "charonly", scriptName: "Aria only", scope: "character", scopeTargetId: "aria",
      findRegex: "scone", replaceString: "muffin", placement: ["user_input"], disabled: false,
    }));
    fs.mkdirSync(path.join(root, "characters", "zeta"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "zeta", "card.json"), JSON.stringify({ spec: "chara_card_v2", name: "Zeta", description: "other", first_mes: "hi" }));
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const idA = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${idA}/send`, body: { text: "a scone please", model: "mock/model" } }, m);
    const msgA = (m.requests[0]!.req as { messages: { content: string }[] }).messages;
    expect(msgA.some((x) => x.content.includes("muffin"))).toBe(true);
    const m2 = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "zeta" } }, m2);
    const idZ = (fs.readdirSync(path.join(root, "chats")).filter((f) => f.endsWith(".meta.json")).map((f) => f.replace(/\.meta\.json$/, "")) as string[]).find((x) => x !== idA)!;
    await drive(engineUrl, { method: "POST", path: `/chats/${idZ}/send`, body: { text: "a scone please", model: "mock/model" } }, m2);
    const msgZ = (m2.requests[0]!.req as { messages: { content: string }[] }).messages;
    expect(msgZ.some((x) => x.content.includes("scone"))).toBe(true);
    expect(msgZ.some((x) => x.content.includes("muffin"))).toBe(false);
  }, 30_000);

  it("extended samplers ride the engine preset into the generation params", async () => {
    fs.writeFileSync(path.join(root, "presets", "sweep.json"), JSON.stringify({
      id: "sweep", name: "Sweep", temperature: 0.7,
      dry_multiplier: 0.8, xtc_probability: 0.5, xtc_threshold: 0.1, typical_p: 0.9,
      temperature_last: true, negative_prompt: "avoid this",
      prompts: [{ identifier: "main", name: "Main", role: "system", marker: true, content: "x" }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
    }));
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "sweep" } }, m);
    const id = (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);
    const params = (m.requests[0]!.req as { presetParams?: { params?: Record<string, unknown> } }).presetParams?.params ?? {};
    expect(params.dry_multiplier).toBe(0.8);
    expect(params.xtc_probability).toBe(0.5);
    expect(params.typical_p).toBe(0.9);
    expect(params.temperature_last).toBe(true);
    expect(params.negative_prompt).toBe("avoid this");
  }, 30_000);

  it("v3 cards: fields survive import; charx assets resolve avatar + emotions", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        cards: [{
          spec: "chara_card_v3",
          data: {
            name: "Vee Three",
            description: "spec three bot",
            nickname: "Vee",
            group_only_greetings: ["(group) Vee waves."],
            assets: [
              { type: "icon", name: "main", uri: "data:image/png;base64,aVQ=" },
              { type: "emotion", name: "smug", uri: "data:image/png;base64,aVQ=" },
            ],
            source: ["https://example.com/card"],
          },
        }],
      },
    }, m);
    expect(r.json.characters).toHaveLength(1);
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", `${(r.json.characters as string[])[0]}`, "card.json"), "utf8"));
    expect(card.spec).toBe("chara_card_v3");
    expect(card.nickname).toBe("Vee");
    expect(card.group_only_greetings).toEqual(["(group) Vee waves."]);
    expect(card.source).toEqual(["https://example.com/card"]);
    // inline data: assets resolve — icon/main becomes the avatar, emotion becomes a sprite
    expect(card.avatar).toBe("data:image/png;base64,aVQ=");
    expect(card.studio.expressions).toEqual([{ name: "smug", url: "data:image/png;base64,aVQ=" }]);
  }, 30_000);

  it("charx package: card.json + __asset: bytes resolve the avatar and sprites", async () => {
    const entries: Record<string, unknown> = {
      "card.json": JSON.stringify({
        spec: "chara_card_v3",
        data: {
          name: "Packaged",
          description: "from a package",
          assets: [
            { type: "icon", name: "main", uri: "__asset:assets/avatar.png", ext: "png" },
            { type: "emotion", name: "joy", uri: "__asset:assets/joy.png", ext: "png" },
          ],
        },
      }),
      "assets/avatar.png": { __b64: true, base64: "QUFB" },
      "assets/joy.png": { __b64: true, base64: "QkND" },
    };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 3 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.characters).toHaveLength(1);
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", `${(r.json.characters as string[])[0]}`, "card.json"), "utf8"));
    expect(card.name).toBe("Packaged");
    expect(card.avatar).toBe("data:image/png;base64,QUFB");
    expect(card.studio.expressions).toEqual([{ name: "joy", url: "data:image/png;base64,QkND" }]);
    // the assets list rides the card verbatim (spec: never destroy)
    expect(Array.isArray(card.assets)).toBe(true);
  }, 30_000);
});

describe("rp studio: backup import stays inside its collections", () => {
  it("an entry id cannot move the write outside the collection its entry names", async () => {
    fs.mkdirSync(path.join(root, "tools"), { recursive: true });
    // zip-slip is caught on entry names by the engine; this rides an entry
    // the importer accepts and hides the traversal in the id it writes into
    // the path
    const entries = { "groups/innocent.json": JSON.stringify({ id: "../tools/pwned", name: "normal group", memberIds: [] }) };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 1 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(fs.existsSync(path.join(root, "tools", "pwned.json")), `wrote outside groups/: ${JSON.stringify(r.json)}`).toBe(false);
    expect(fs.existsSync(path.join(root, "groups", "normal-group.json"))).toBe(true);
  }, 30_000);
});

describe("rp studio: export → import zip round-trip", () => {

  it("the exported backup re-imports through /import/zip (text entries)", async () => {
    const m = mockHost();
    // fresh root with one char + chat
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const exp = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
    const files = unzipSync(Buffer.from(exp.json.base64 as string, "base64")) as Record<string, Uint8Array>;
    const entries: Record<string, string> = {};
    for (const [name, data] of Object.entries(files)) {
      if (!name.endsWith(".png")) entries[name] = new TextDecoder().decode(data); // kernel zip service: text only
    }
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    expect(r.json.characters).toHaveLength(1);
    // the same persona is already here, so it stays one persona
    expect(r.json.personas).toHaveLength(0);
    expect(fs.readdirSync(path.join(root, "personas")).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(r.json.chats).toHaveLength(1);
    expect(r.json.errors).toHaveLength(0);
  }, 30_000);
});

describe("rp studio: outside preset/book formats", () => {
  it("assembly follows the order list under character id 100001, not the first list", async () => {
    // two order lists in one file: 100000 is the stock layout, 100001 is the
    // author's arrangement (the reserved chat-completion id)
    fs.writeFileSync(path.join(root, "presets", "dual.json"), JSON.stringify({
      id: "dual", name: "Dual Order",
      prompts: [
        { identifier: "main", name: "Main", role: "system", marker: true, content: "Main text." },
        { identifier: "worldInfoBefore", name: "WI Before", role: "system", marker: true },
        { identifier: "charDescription", name: "Char", role: "system", marker: true },
        { identifier: "chatHistory", name: "History", role: "system", marker: true },
        { identifier: "author-note", name: "Author Only", role: "system", content: "AUTHOR-ARRANGEMENT-MARK" },
      ],
      prompt_order: [
        { character_id: 100000, order: [
          { identifier: "main", enabled: true }, { identifier: "worldInfoBefore", enabled: true },
          { identifier: "charDescription", enabled: true }, { identifier: "chatHistory", enabled: true },
        ] },
        { character_id: 100001, order: [
          { identifier: "main", enabled: true }, { identifier: "author-note", enabled: true },
          { identifier: "charDescription", enabled: true }, { identifier: "chatHistory", enabled: true },
        ] },
      ],
    }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", presetId: "dual" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    const sys = (peek.json.messages as { content: string }[]).map((x) => x.content).join("\n");
    expect(sys).toContain("AUTHOR-ARRANGEMENT-MARK");
  }, 30_000);

  it("keeps embedded lore inactive until chosen, preserves Later, and imports once", async () => {
    const m = mockHost();
    const rawBook = { name: "Deferred lore", scan_depth: 6, entries: [{ keys: ["vault"], content: "Hidden vault", enabled: true }] };
    const result = await drive(stUrl, { method: "POST", path: "/import/batch", body: {
      deferEmbeddedLore: true, cards: [{ spec: "chara_card_v2", data: { name: "Deferred Keeper", character_book: rawBook } }],
    } }, m);
    expect(result.json.lorebooks).toEqual([]);
    const id = (result.json.characters as string[])[0]!;
    const file = path.join(root, "characters", id, "card.json");
    let card = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(card.character_book).toEqual(rawBook);
    expect(card.studio.embeddedLorebookPending).toBe(true);
    expect(card.studio.embeddedLorebookId).toBeNull();
    await drive(stUrl, { method: "POST", path: "/import/embedded-lorebook", body: { characterId: id, import: false } }, m);
    card = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(card.character_book).toEqual(rawBook);
    expect(card.studio.embeddedLorebookPending).toBe(false);
    expect(fs.readdirSync(path.join(root, "lorebooks"))).toEqual([]);
    const imported = await drive(stUrl, { method: "POST", path: "/import/embedded-lorebook", body: { characterId: id, import: true } }, m);
    const again = await drive(stUrl, { method: "POST", path: "/import/embedded-lorebook", body: { characterId: id, import: true } }, m);
    expect(again.json.lorebookId).toBe(imported.json.lorebookId);
    expect(fs.readdirSync(path.join(root, "lorebooks"))).toHaveLength(1);
    const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${imported.json.lorebookId}.json`), "utf8"));
    expect(book.isEmbedded).toBe(true);
    expect(book.globalActive).not.toBe(true);
    expect(book.settings.scanDepth).toBe(6);
    card = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(card.studio.embeddedLorebookId).toBe(imported.json.lorebookId);
    expect(card.character_book).toEqual(rawBook);
  });

  it("a card's embedded lorebook imports as a linked, scoped book", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        cards: [{
          spec: "chara_card_v2",
          name: "Bookkeeper",
          description: "keeps books",
          character_book: {
            name: "Bookkeeper Lore",
            scan_depth: 6,
            entries: [
              { keys: ["vault"], content: "The vault under the shop.", enabled: true, insertion_order: 5, position: "before_char", selective: true, secondary_keys: ["bank"] },
              { keys: ["ledger"], content: "The ledger lists debts.", enabled: true, insertion_order: 3, constant: true, extensions: { position: 4, depth: 2, role: 1, probability: 60, useProbability: true, sticky: 3 } },
            ],
          },
        }],
      },
    }, m);
    expect(r.json.characters).toHaveLength(1);
    expect(r.json.lorebooks).toHaveLength(1);
    const bookId = (r.json.lorebooks as string[])[0]!;
    const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${bookId}.json`), "utf8"));
    expect(book.name).toBe("Bookkeeper Lore");
    expect(book.isEmbedded).toBe(true);
    expect(book.settings.scanDepth).toBe(6);
    expect(book.entries).toHaveLength(2);
    const first = book.entries[0];
    expect(first.keys).toEqual(["vault"]);
    expect(first.secondaryKeys).toEqual(["bank"]);
    expect(first.order).toBe(5);
    expect(first.position).toBe("before_char");
    const second = book.entries[1];
    expect(second.constant).toBe(true);
    expect(second.position).toBe("at_depth");
    expect(second.depth).toBe(2);
    expect(second.role).toBe("user");
    expect(second.probability).toBe(60);
    expect(second.sticky).toBe(3);
    // the card links the book: it enters scope for that character's chats
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", `${(r.json.characters as string[])[0]}`, "card.json"), "utf8"));
    expect(card.studio.embeddedLorebookId).toBe(bookId);
  }, 30_000);

  it("backup-zip presets keep their map-key names", async () => {
    const entries: Record<string, string> = {
      "User Settings/openai_settings.json": JSON.stringify({
        "My Custom Mix": { temperature: 1.1, prompts: [{ identifier: "main", name: "Main", role: "system", content: "x" }] },
      }),
    };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 1 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.presets).toHaveLength(1);
    const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", `${(r.json.presets as string[])[0]}.json`), "utf8"));
    expect(preset.name).toBe("My Custom Mix");
    expect(preset.temperature).toBe(1.1);
  }, 30_000);

  it("a preset keeps its sections' generation types through backup and restore", async () => {
    const m = mockHost();
    const all = ["normal", "continue", "impersonate", "swipe", "regenerate", "quiet"];
    fs.writeFileSync(path.join(root, "presets", "mine.json"), JSON.stringify({
      id: "mine", name: "Mine", temperature: 0.95,
      prompts: [{ identifier: "cyoa", name: "Cyoa", role: "user", content: "End with choices." }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: "cyoa", enabled: true }] }],
      studio: { isDefault: true, sections: [{ id: "cyoa", name: "Cyoa", injectionTriggers: all, groupId: "g1" }], samplers: { bannedTokens: ["x"] } },
    }));
    const zip = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
    const files = unzipSync(Buffer.from(zip.json.base64 as string, "base64")) as Record<string, Uint8Array>;
    const entries = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextDecoder().decode(v)]));
    fs.rmSync(path.join(root, "presets", "mine.json"));
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 1 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    const id = (r.json.presets as string[]).find((x) => x.startsWith("mine"))!;
    const back = JSON.parse(fs.readFileSync(path.join(root, "presets", `${id}.json`), "utf8"));
    expect(back.name).toBe("Mine");
    expect(back.studio.sections[0].injectionTriggers).toEqual(all);
    expect(back.studio.sections[0].groupId).toBe("g1");
    expect(back.studio.samplers.bannedTokens).toEqual(["x"]);
    expect(back.studio.isDefault).toBeUndefined();
  }, 30_000);

  it("an update gives every generation type back to presets limited to normal everywhere", async () => {
    const m = mockHost();
    const sec = (id: string, injectionTriggers: string[]) => ({ id, name: id, injectionTriggers });
    fs.writeFileSync(path.join(root, "presets", "damaged.json"), JSON.stringify({
      id: "damaged", name: "Damaged", studio: { sections: [sec("main", ["normal"]), sec("cyoa", ["normal"]), sec("chatHistory", ["normal"])] },
    }));
    fs.writeFileSync(path.join(root, "presets", "chosen.json"), JSON.stringify({
      id: "chosen", name: "Chosen", studio: { sections: [sec("main", ["normal", "swipe"]), sec("note", ["normal"])] },
    }));
    const mod = await import(engineUrl);
    const out = mod.onAppUpdate({ from: "4.18.1", to: "4.18.2" }, m.host);
    expect(out.upgraded).toEqual(["presets/damaged.json generation types"]);
    const damaged = JSON.parse(fs.readFileSync(path.join(root, "presets", "damaged.json"), "utf8"));
    for (const s of damaged.studio.sections) expect(s.injectionTriggers).toContain("swipe");
    const chosen = JSON.parse(fs.readFileSync(path.join(root, "presets", "chosen.json"), "utf8"));
    expect(chosen.studio.sections[1].injectionTriggers).toEqual(["normal"]);
    expect(mod.onAppUpdate({ from: "4.18.2", to: "4.18.3" }, m.host).upgraded).toEqual([]);
  }, 30_000);

  it("a world file survives the export/import round trip intact", async () => {
    const m = mockHost();
    const source = {
      name: "Round Trip",
      entries: {
        0: {
          uid: 0, key: ["temple", "shrine"], keysecondary: ["priest"], comment: "Temple",
          content: "Incense-heavy halls.", selectiveLogic: 2, order: 20,
          sticky: 4, cooldown: 2, delay: 1, position: 4, depth: 3, role: 2,
          group: "places", groupWeight: 40, probability: 60, useProbability: true,
          excludeRecursion: true, preventRecursion: true, ignoreBudget: true,
          automationId: "temple-visit", matchCharacterDescription: true, matchScenario: true,
        },
        1: { uid: 1, key: ["ruin"], content: "Collapsed ages ago.", constant: true, vectorized: true },
      },
    };
    const imported = await drive(stUrl, { method: "POST", path: "/import/batch", body: { worldInfo: [source] } }, m);
    const bookId = (imported.json.lorebooks as string[])[0]!;

    // export the whole workspace, pull the world file back out of the zip
    const zip = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
    const files = unzipSync(Buffer.from(zip.json.base64 as string, "base64")) as Record<string, Uint8Array>;
    const worldName = Object.keys(files).find((n) => n.startsWith("worlds/"));
    expect(worldName).toBeTruthy();
    const world = JSON.parse(new TextDecoder().decode(files[worldName!]!)) as Record<string, unknown>;

    // wipe the book, re-import what the export wrote
    fs.rmSync(path.join(root, "lorebooks", `${bookId}.json`));
    const back = await drive(stUrl, { method: "POST", path: "/import/batch", body: { worldInfo: [world] } }, m);
    const again = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${(back.json.lorebooks as string[])[0]!}.json`), "utf8"));

    const temple = again.entries.find((e: { title: string }) => e.title === "Temple");
    expect(temple).toMatchObject({
      keys: ["temple", "shrine"], secondaryKeys: ["priest"], selectiveLogic: "NOT_ANY",
      order: 20, sticky: 4, cooldown: 2, delay: 1, position: "at_depth", depth: 3, role: "assistant",
      group: "places", groupWeight: 40, probability: 60,
      nonRecursable: true, preventFurtherRecursion: true, ignoreBudget: true,
      automationId: "temple-visit",
    });
    expect(temple.matchSources).toMatchObject({ description: true, scenario: true, personality: false, persona: false });
    const ruin = again.entries.find((e: { content: string }) => e.content === "Collapsed ages ago.");
    expect(ruin.status).toBe("vectorized");
  }, 30_000);

  it("world files keep sticky/cooldown/vectorized and at-depth entries", async () => {
    const m = mockHost();
    const r = await drive(stUrl, {
      method: "POST", path: "/import/batch",
      body: {
        worldInfo: [{
          name: "Outside World",
          entries: {
            0: { uid: 0, key: ["temple"], keysecondary: ["priest"], comment: "Temple", content: " incense-heavy halls", selectiveLogic: 2, order: 20, sticky: 4, cooldown: 2 },
            1: { uid: 1, key: ["echo"], content: "The echoes answer.", position: 4, depth: 1, role: 2, vectorized: true },
            2: { uid: 2, key: ["ruin"], content: "Collapsed ages ago.", constant: true, ignoreBudget: true, delayUntilRecursion: true },
          },
        }],
      },
    }, m);
    const bookId = (r.json.lorebooks as string[])[0]!;
    const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${bookId}.json`), "utf8"));
    expect(book.entries).toHaveLength(3);
    const [temple, echo, ruin] = book.entries;
    expect(temple.title).toBe("Temple");
    expect(temple.secondaryKeys).toEqual(["priest"]);
    expect(temple.selectiveLogic).toBe("NOT_ANY");
    expect(temple.sticky).toBe(4);
    expect(temple.cooldown).toBe(2);
    expect(echo.position).toBe("at_depth");
    expect(echo.role).toBe("assistant");
    expect(echo.status).toBe("vectorized");
    expect(ruin.constant).toBe(true);
    expect(ruin.ignoreBudget).toBe(true);
    expect(ruin.delayUntilRecursion).toBe(true);
  }, 30_000);
});

describe("rp studio engine: pictures, personas, card regex", () => {
  const chatIdOf = () => (fs.readdirSync(path.join(root, "chats")).find((f) => f.endsWith(".meta.json")) as string).replace(/\.meta\.json$/, "");

  it("image-prompt asks the chat model to describe the scene and writes nothing", async () => {
    const m = mockHost({ text: "Prompt: \"A barista behind a counter at night.\"" });
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    const before = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8");
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/image-prompt`, body: { mode: "character" } }, m);
    expect(r.json.prompt).toBe("A barista behind a counter at night.");
    const asked = (m.requests.at(-1)!.req as { messages: { content: string }[] }).messages[0]!.content;
    expect(asked).toContain("Describe Aria as they look right now");
    expect(asked).toContain("A barista."); // the card rides along
    expect(fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8")).toBe(before);
  }, 30_000);

  it("a posted picture stays out of the prompt, and swipes skip past it", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello" } }, m);
    const pic = await drive(engineUrl, { method: "POST", path: `/chats/${id}/messages`, body: { text: "", hidden: true, picture: true, attachments: [{ id: "a", name: "SECRET-PROMPT", type: "image/png", url: "/v1/assets/x" }] } }, m);
    expect(pic.status).toBe(201);
    const sw = await drive(engineUrl, { method: "POST", path: `/chats/${id}/swipe`, body: { dir: 1 } }, m);
    expect((sw.json.message as { picture?: boolean }).picture).toBeUndefined(); // the reply got the swipe
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "again" } }, m);
    const sent = JSON.stringify(m.requests.at(-1)!.req);
    expect(sent).not.toContain("SECRET-PROMPT");
  }, 30_000);

  it("editing a persona mid-chat changes {{user}} from then on; past turns keep who sent them", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "first" } }, m);
    fs.writeFileSync(path.join(root, "personas", "you.json"), JSON.stringify({ id: "you", name: "Renamed", description: "now tall" }));
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "second {{user}}" } }, m);
    const msgs = (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.messages as { role: string; name: string; personaId?: string }[];
    const users = msgs.filter((x) => x.role === "user");
    expect(users.map((u) => u.name)).toEqual(["You", "Renamed"]);
    expect(users.every((u) => u.personaId === "you")).toBe(true);
    const req = JSON.stringify(m.requests.at(-1)!.req);
    expect(req).toContain("second Renamed");
    expect(req).toContain("now tall");
  }, 30_000);

  it("a persona locked to the character beats the one in use, a chat lock beats both", async () => {
    const m = mockHost();
    fs.writeFileSync(path.join(root, "personas", "bound.json"), JSON.stringify({ id: "bound", name: "Bound", boundCharacterIds: ["aria"] }));
    fs.writeFileSync(path.join(root, "personas", "other.json"), JSON.stringify({ id: "other", name: "Other" }));
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    const meta = async () => (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.meta;
    expect(await meta()).toMatchObject({ personaId: "bound" });
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { personaId: "other", personaLocked: true } }, m);
    expect(await meta()).toMatchObject({ personaId: "other", personaLocked: true });
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { personaId: null, personaLocked: false } }, m);
    expect(await meta()).toMatchObject({ personaId: "bound" });
    fs.rmSync(path.join(root, "personas", "bound.json"));
    expect(await meta()).toMatchObject({ personaId: "you" });
  }, 30_000);

  it("a chat follows the preset in use until it is locked to one", async () => {
    const m = mockHost();
    fs.writeFileSync(path.join(root, "presets", "mine.json"), JSON.stringify({ id: "mine", name: "Mine", prompts: [], prompt_order: [] }));
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    const meta = async () => (await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.meta;
    const before = (await meta()).presetId;
    expect(before).not.toBe("mine");
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { presetId: "mine", presetLocked: true } }, m);
    expect(await meta()).toMatchObject({ presetId: "mine", presetLocked: true });
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { presetId: null, presetLocked: false } }, m);
    expect((await meta()).presetId).toBe(before);
  }, 30_000);

  it("a chat follows the persona in use until it is locked to one", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = chatIdOf();
    expect((await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m)).json.meta).toMatchObject({ personaId: "you" });
    fs.writeFileSync(path.join(root, "personas", "other.json"), JSON.stringify({ id: "other", name: "Other" }));
    await drive(engineUrl, { method: "PUT", path: "/settings", body: { personaId: "other" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi {{user}}" } }, m);
    expect(JSON.stringify(m.requests.at(-1)!.req)).toContain("hi Other");
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { personaId: "other", personaLocked: true } }, m);
    await drive(engineUrl, { method: "PUT", path: "/settings", body: { personaId: "you" } }, m);
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "again {{user}}" } }, m);
    expect(JSON.stringify(m.requests.at(-1)!.req)).toContain("again Other");
  }, 30_000);

  it("regex scripts inside an imported card become that character's scripts", async () => {
    const m = mockHost();
    const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [{
      spec: "chara_card_v2", data: { name: "Rex", description: "d", first_mes: "hi", extensions: { regex_scripts: [
        { scriptName: "Hide HTML", findRegex: "/<div>.*?<\\/div>/gs", replaceString: "", placement: [2], markdownOnly: true },
      ] } },
    }] } }, m);
    expect(r.json.regex).toHaveLength(1);
    const charId = (r.json.characters as string[])[0];
    const script = JSON.parse(fs.readFileSync(path.join(root, "regex", `${(r.json.regex as string[])[0]}.json`), "utf8")) as Record<string, unknown>;
    expect(script).toMatchObject({ scope: "character", scopeTargetId: charId, placement: ["ai_output"], markdownOnly: true, promptOnly: false, flags: "gs" });
  }, 30_000);
});


// ── the bugs that made a move to a second device lossy ──────────────────────

describe("rp studio: a chat with no persona to resolve", () => {
  // chatPersona used to fall back through chatUserName, which is chatPersona's
  // own accessor: every chat that could not resolve a persona recursed until
  // the sandbox stack gave out. A restored backup is exactly that state —
  // fresh persona ids, nothing marked default in settings.json.
  const strand = () => {
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null }));
    fs.rmSync(path.join(root, "personas", "you.json"));
  };

  it("generates instead of blowing the stack", async () => {
    strand();
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (c.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hello", model: "mock/model" } }, m);
    expect(r.status).toBe(200);
    expect((r.json.reply as { text: string }).text).toBe("MOCK-REPLY");
  }, 30_000);

  it("peeks the prompt instead of blowing the stack", async () => {
    strand();
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (c.json.meta as { id: string }).id;
    const r = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(r.status).toBe(200);
    expect(r.json.presetName).toBe("Default");
  }, 30_000);

  it("falls back to the name the chat stored, then to User", async () => {
    strand();
    // a prompt that says {{user}}, so the assembled text shows who we are
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify({
      id: "default", name: "Default",
      prompts: [{ identifier: "main", name: "Main", role: "system", content: "Speaking with {{user}}." }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
    }));
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (c.json.meta as { id: string }).id;
    const bare = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(JSON.stringify(bare.json.messages) + String(bare.json.systemPrompt)).toContain("Speaking with User.");

    const metaPath = path.join(root, "chats", `${id}.meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, "utf8")), userName: "Robin" }));
    const r = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(JSON.stringify(r.json.messages) + String(r.json.systemPrompt)).toContain("Speaking with Robin.");
  }, 30_000);
});

describe("rp studio: backup zips survive the trip", () => {
  const exportEntries = async (m: ReturnType<typeof mockHost>) => {
    const exp = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
    const files = unzipSync(Buffer.from(exp.json.base64 as string, "base64")) as Record<string, Uint8Array>;
    const entries: Record<string, string> = {};
    for (const [name, data] of Object.entries(files)) entries[name] = new TextDecoder().decode(data);
    return entries;
  };

  it("brings back the lorebooks a card links and embeds", async () => {
    const m = mockHost();
    const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    fs.writeFileSync(path.join(root, "lorebooks", "world.json"), JSON.stringify({ id: "world", name: "World", entries: [{ keys: ["sea"], content: "The sea" }] }));
    fs.writeFileSync(path.join(root, "lorebooks", "own.json"), JSON.stringify({ id: "own", name: "Own", entries: [{ keys: ["home"], content: "Home" }] }));
    fs.mkdirSync(path.join(root, "characters", "linked"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "linked", "card.json"), JSON.stringify({ name: "Linked", studio: { linkedLorebookIds: ["world"], embeddedLorebookId: "own" } }));
    const entries = await exportEntries(m);
    for (const dir of ["characters", "lorebooks"]) { fs.rmSync(path.join(root, dir), { recursive: true, force: true }); fs.mkdirSync(path.join(root, dir)); }
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    expect(r.json.errors).toEqual([]);
    const books = Object.fromEntries((r.json.lorebooks as string[]).map((id) => [read(`lorebooks/${id}.json`).name, id]));
    const card = (r.json.characters as string[]).map((id) => read(`characters/${id}/card.json`)).find((c) => c.name === "Linked");
    expect(Object.keys(books).sort()).toEqual(["Own", "World"]);
    expect(card.studio.linkedLorebookIds).toEqual([books.World]);
    expect(card.studio.embeddedLorebookId).toBe(books.Own);
    expect(card._lorebookNames).toBeUndefined();
  }, 30_000);

  it("brings back portraits, same-name cards and same-name presets", async () => {
    const m = mockHost();
    const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    for (const [id, note] of [["twin-a", "first"], ["twin-b", "second"]]) {
      fs.mkdirSync(path.join(root, "characters", id), { recursive: true });
      fs.writeFileSync(path.join(root, "characters", id, "card.json"), JSON.stringify({ name: "Twin", description: note, avatar: "data:image/png;base64,QUFB" }));
    }
    fs.writeFileSync(path.join(root, "presets", "p1.json"), JSON.stringify({ id: "p1", name: "Same", temperature: 0.5 }));
    fs.writeFileSync(path.join(root, "presets", "p2.json"), JSON.stringify({ id: "p2", name: "Same", temperature: 0.9 }));
    for (const [cid, text] of [["twin-a", "to the first"], ["twin-b", "to the second"]]) {
      const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: cid } }, m);
      const id = (c.json.meta as { id: string }).id;
      fs.writeFileSync(path.join(root, "chats", `${id}.jsonl`), JSON.stringify({ id: "e1", name: "You", role: "user", text, at: 1, charId: null }) + "\n");
    }
    fs.writeFileSync(path.join(root, "groups", "duo.json"), JSON.stringify({ id: "duo", name: "Duo", memberIds: ["twin-b"] }));
    const entries = await exportEntries(m);
    for (const dir of ["characters", "chats", "presets", "groups"]) { fs.rmSync(path.join(root, dir), { recursive: true, force: true }); fs.mkdirSync(path.join(root, dir)); }
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    const cards = Object.fromEntries((r.json.characters as string[]).map((id) => [id, read(`characters/${id}/card.json`)]));
    expect(Object.values(cards).filter((c) => c.name === "Twin").map((c) => c.avatar)).toEqual(["data:image/png;base64,QUFB", "data:image/png;base64,QUFB"]);
    for (const id of r.json.chats as string[]) {
      const meta = read(`chats/${id}.meta.json`);
      const said = JSON.parse(fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n")[0]!).text;
      expect(`to the ${cards[meta.characterId].description}`).toBe(said);
    }
    const group = read(`groups/${(r.json.groups as string[])[0]}.json`);
    expect(cards[group.memberIds[0]].description).toBe("second");
    expect(Object.keys(group).some((k) => k.startsWith("_"))).toBe(false);
    const temps = (r.json.presets as string[]).map((id) => read(`presets/${id}.json`)).filter((p) => p.name === "Same").map((p) => p.temperature).sort();
    expect(temps).toEqual([0.5, 0.9]);
  }, 30_000);

  it("restores chat lore bindings with new IDs and keeps them on branches", async () => {
    fs.writeFileSync(path.join(root, "lorebooks", "local.json"), JSON.stringify({ id: "local", name: "Local lore", entries: [{ uid: 0, content: "A local secret.", keys: ["secret"], enabled: true }] }));
    const m = mockHost();
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (chat.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { chatLorebookIds: ["local"] } }, m);
    const branch = await drive(engineUrl, { method: "POST", path: `/chats/${id}/fork`, body: {} }, m);
    expect((branch.json.meta as { chatLorebookIds: string[] }).chatLorebookIds).toEqual(["local"]);
    const entries = await exportEntries(m);
    fs.rmSync(path.join(root, "lorebooks", "local.json"));
    const restored = mockHost();
    (restored.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const result = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, restored);
    expect(result.status).toBe(200);
    for (const chatId of result.json.chats as string[]) {
      const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8"));
      expect(meta.chatLorebookIds).toHaveLength(1);
      expect(meta.chatLorebookIds[0]).not.toBe("local");
      const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${meta.chatLorebookIds[0]}.json`), "utf8"));
      expect(book.name).toBe("Local lore");
    }
  });

  it("restores chat backups when no regex directory has been created", async () => {
    const chat = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, mockHost());
    const entries = await exportEntries(mockHost());
    fs.rmSync(path.join(root, "regex"), { recursive: true });
    const restored = mockHost();
    (restored.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const result = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, restored);
    expect(result.json.errors).toEqual([]);
    expect(result.json.chats).toHaveLength(1);
    const id = (result.json.chats as string[])[0];
    const transcript = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(transcript.map((message) => message.text)).toEqual((chat.json.messages as { text: string }[]).map((message) => message.text));
  });

  it("writes UTF-8, not latin1 with every other character punched out", async () => {
    // curly quotes, an em dash, an accent and an emoji — ordinary prose
    const prose = "“Café” — naïve 🦋 日本語";
    fs.writeFileSync(
      path.join(root, "characters", "aria", "card.json"),
      JSON.stringify({ spec: "chara_card_v2", name: "Aria", description: prose, personality: "", scenario: "", first_mes: "hi", mes_example: "" }),
    );
    const entries = await exportEntries(mockHost());
    const card = JSON.parse(entries["characters/aria.json"]!) as { description: string };
    expect(card.description).toBe(prose);
    expect(card.description).not.toContain("?");
  }, 30_000);

  it("restores an unlocked chat unlocked, under the name it was written with", async () => {
    const m = mockHost();
    fs.writeFileSync(path.join(root, "personas", "robin.json"), JSON.stringify({ id: "robin", name: "Robin", isDefault: true }));
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", userName: "Sam" } }, m);
    const id = (c.json.meta as { id: string }).id;
    fs.writeFileSync(path.join(root, "chats", `${id}.jsonl`), JSON.stringify({ id: "e1", name: "Sam", role: "user", text: "hi", at: 1, charId: null }) + "\n");
    const entries = await exportEntries(m);
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    const meta = (r.json.chats as string[]).map((cid) => JSON.parse(fs.readFileSync(path.join(root, "chats", `${cid}.meta.json`), "utf8"))).find((x) => x.userName === "Sam");
    expect(meta).toBeDefined();
    expect(meta.personaLocked).toBeFalsy();
    expect(meta.presetLocked).toBeFalsy();
    expect(meta.personaId ?? null).toBeNull();
  }, 30_000);

  it("carries the chat's preset, persona, model and notes, not just its lines", async () => {
    const m = mockHost();
    fs.writeFileSync(path.join(root, "presets", "mine.json"), JSON.stringify({ id: "mine", name: "My Preset", prompts: [], prompt_order: [], temperature: 0.4 }));
    fs.writeFileSync(path.join(root, "personas", "robin.json"), JSON.stringify({ id: "robin", name: "Robin", description: "a detective", title: "PI", pronouns: "they/them", avatar: "data:image/png;base64,AAA", isDefault: true }));
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (c.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);
    await drive(engineUrl, {
      method: "PATCH", path: `/chats/${id}`,
      body: { presetId: "mine", presetLocked: true, personaId: "robin", personaLocked: true, title: "Crossroads at Dusk", summary: "they met", chatTags: ["noir"] },
    }, m);

    const entries = await exportEntries(m);
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    expect(r.json.errors).toEqual([]);

    const chatId = (r.json.chats as string[])[0]!;
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8")) as Record<string, unknown>;
    // the title is the real one, not the filename slug title-cased back
    expect(meta.title).toBe("Crossroads at Dusk");
    expect(meta.summary).toBe("they met");
    expect(meta.chatTags).toEqual(["noir"]);
    // and it still rides the preset and persona it was pinned to
    const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", `${meta.presetId}.json`), "utf8")) as { name: string };
    expect(preset.name).toBe("My Preset");
    const persona = JSON.parse(fs.readFileSync(path.join(root, "personas", `${meta.personaId}.json`), "utf8")) as Record<string, unknown>;
    expect(persona.name).toBe("Robin");
    // …with the persona whole, not just its name and description
    expect(persona.title).toBe("PI");
    expect(persona.pronouns).toBe("they/them");
    expect(persona.avatar).toBe("data:image/png;base64,AAA");
    expect(persona.isDefault).toBe(true);
  }, 30_000);

  it("keeps hidden turns, bookmarks and the model stamp on each message", async () => {
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
    const id = (c.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);
    const lines = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    lines[0]!.hidden = true;
    lines[0]!.bookmarked = true;
    lines[0]!.bookmarkLabel = "opening";
    const mediaName = "a".repeat(64) + ".png";
    fs.mkdirSync(path.join(root, "__media"), { recursive: true });
    fs.writeFileSync(path.join(root, "__media", mediaName), Buffer.from("a picture"));
    Object.assign(m.host.fs, { readBase64: (rel: string) => fs.readFileSync(path.join(root, rel)).toString("base64") });
    lines[0]!.attachments = [{ id: "attachment", name: "A view", type: "image/png", url: "/v1/apps/roleplay/__media/" + mediaName }];
    fs.writeFileSync(path.join(root, "chats", `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const entries = await exportEntries(m);
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    const chatId = (r.json.chats as string[])[0]!;
    const back = fs.readFileSync(path.join(root, "chats", `${chatId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(back[0]!.hidden).toBe(true);
    expect(back[0]!.bookmarked).toBe(true);
    expect(back[0]!.bookmarkLabel).toBe("opening");
    expect(back[0]!.attachments).toEqual([{ id: "attachment", name: "A view", type: "image/png", url: "data:image/png;base64," + Buffer.from("a picture").toString("base64") }]);
    // the reply keeps which model wrote it
    const reply = back.find((x) => x.role === "char" && (x.extra as { model?: string } | undefined)?.model);
    expect((reply!.extra as { model: string }).model).toBe("mock/model");
  }, 30_000);

  it("brings app settings and the local collections back", async () => {
    const m = mockHost();
    await drive(engineUrl, { method: "PUT", path: "/settings", body: { ui: { theme: "midnight", proseFont: "noto" } } }, m);
    await drive(engineUrl, { method: "PUT", path: "/library", body: { themes: [{ id: "t1", name: "Midnight" }], tags: ["noir"] } }, m);
    fs.writeFileSync(path.join(root, "variables.json"), JSON.stringify({ tone: "grim" }));
    const entries = await exportEntries(m);
    // wipe what we are about to restore, so the assertions can only pass if
    // the zip actually carried it
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you" }));
    fs.rmSync(path.join(root, "library.json"), { force: true });
    fs.rmSync(path.join(root, "variables.json"), { force: true });
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { ui: { theme: string } };
    expect(settings.ui.theme).toBe("midnight");
    const lib = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf8")) as { tags: string[] };
    expect(lib.tags).toEqual(["noir"]);
    // the variables every chat shares come back too
    expect(JSON.parse(fs.readFileSync(path.join(root, "variables.json"), "utf8"))).toEqual({ tone: "grim" });
  }, 30_000);

  it("keeps a lorebook's own settings and its link to a card", async () => {
    const m = mockHost();
    fs.writeFileSync(path.join(root, "lorebooks", "b1.json"), JSON.stringify({
      id: "b1", name: "City Lore", globalActive: true, linkedCharacterIds: ["aria"],
      settings: { scanDepth: 9, contextPercent: 40, recursiveScan: false },
      entries: [{ uid: 0, title: "Docks", memo: "Docks", keys: ["docks"], content: "Cold water.", enabled: true, order: 100, position: "after_char" }],
    }));
    const entries = await exportEntries(m);
    const m2 = mockHost();
    (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
    const bookId = (r.json.lorebooks as string[])[0]!;
    const book = JSON.parse(fs.readFileSync(path.join(root, "lorebooks", `${bookId}.json`), "utf8")) as Record<string, unknown>;
    expect(book.globalActive).toBe(true);
    expect((book.settings as { scanDepth: number }).scanDepth).toBe(9);
    // linked by NAME across the trip: it lands on whichever id this workspace
    // minted for Aria, not the id the other machine used
    const linked = (book.linkedCharacterIds as string[])[0]!;
    expect(JSON.parse(fs.readFileSync(path.join(root, "characters", linked, "card.json"), "utf8")).name).toBe("Aria");
  }, 30_000);
});

describe("rp studio: foreign backup layouts", () => {
  const card = {
    spec: "chara_card_v2",
    data: { name: "Nadia", description: "A locksmith.", personality: "wry", scenario: "", first_mes: "Hey.", mes_example: "" },
  };

  // The three ways people actually hand us one of these zips. Only the first
  // was ever recognised, and only at one exact nesting depth.
  for (const [label, prefix] of [
    ["the tool's own backup", "default-user/"],
    ["the data folder", "data/default-user/"],
    ["the whole install directory", "MyTool-1.13.4/data/default-user/"],
    ["just the folders they wanted", ""],
  ] as const) {
    it(`imports ${label}`, async () => {
      const entries: Record<string, unknown> = {
        [`${prefix}characters/nadia.json`]: JSON.stringify(card),
        [`${prefix}worlds/City.json`]: JSON.stringify({ name: "City", entries: { 0: { uid: 0, key: ["docks"], content: "Cold water.", comment: "Docks" } } }),
        [`${prefix}OpenAI Settings/Night Shift.json`]: JSON.stringify({ temperature: 0.7, openai_max_tokens: 900, prompts: [], prompt_order: [] }),
        [`${prefix}settings.json`]: JSON.stringify({
          personas: { "robin.png": "Robin" },
          persona_descriptions: { "robin.png": { description: "a detective" } },
        }),
      };
      const m = mockHost();
      (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
      const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
      expect(r.json.characters).toHaveLength(1);
      expect(r.json.lorebooks).toHaveLength(1);
      expect(r.json.presets).toHaveLength(1);
      expect(r.json.personas).toHaveLength(1);
      const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", `${(r.json.presets as string[])[0]}.json`), "utf8")) as { name: string };
      expect(preset.name).toBe("Night Shift");
      const persona = JSON.parse(fs.readFileSync(path.join(root, "personas", `${(r.json.personas as string[])[0]}.json`), "utf8")) as { name: string; description: string };
      expect(persona.name).toBe("Robin");
      expect(persona.description).toBe("a detective");
    }, 30_000);
  }

  it("imports PNG cards out of a backup zip", async () => {
    // a minimal PNG with a tEXt "chara" chunk — the shape a card file has
    const payload = Buffer.from(JSON.stringify(card)).toString("base64");
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const crc = Buffer.alloc(4); // the reader never checks it
      return Buffer.concat([len, Buffer.from(type, "latin1"), body, crc]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("tEXt", Buffer.concat([Buffer.from("chara", "latin1"), Buffer.from([0]), Buffer.from(payload, "latin1")])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    // the kernel's zip service tags a binary entry __b64__; the importer read
    // __b64, so every PNG card in every backup was reported as unreadable
    const entries: Record<string, unknown> = {
      "data/default-user/characters/Nadia.png": { __b64__: true, base64: png.toString("base64"), size: png.length },
    };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 1 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.errors).toEqual([]);
    expect(r.json.characters).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, "characters", (r.json.characters as string[])[0]!, "card.json"), "utf8")) as { name: string };
    expect(written.name).toBe("Nadia");
  }, 30_000);
});

describe("rp studio: personas stay where you put them", () => {
  const seedPersonas = () => {
    fs.writeFileSync(path.join(root, "personas", "robin.json"), JSON.stringify({ id: "robin", name: "Robin", description: "a detective" }));
    fs.writeFileSync(path.join(root, "personas", "sam.json"), JSON.stringify({ id: "sam", name: "Sam", description: "a courier" }));
    fs.writeFileSync(path.join(root, "presets", "default.json"), JSON.stringify({
      id: "default", name: "Default",
      prompts: [{ identifier: "main", name: "Main", role: "system", content: "Speaking with {{user}}." }],
      prompt_order: [{ character_id: 100000, order: [{ identifier: "main", enabled: true }] }],
    }));
  };
  const spoken = (r: { json: Record<string, unknown> }) =>
    JSON.stringify(r.json.messages) + String(r.json.systemPrompt);

  it("switches mid-chat without rewriting the turns already sent", async () => {
    seedPersonas();
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", personaId: "robin" } }, m);
    const id = (c.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "hi", model: "mock/model" } }, m);

    const patched = await drive(engineUrl, { method: "PATCH", path: `/chats/${id}`, body: { personaId: "sam" } }, m);
    expect((patched.json as { personaId: string }).personaId).toBe("sam");
    // new turns speak as Sam…
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(spoken(peek)).toContain("Speaking with Sam.");
    // …and the turn already sent keeps the name it was sent under
    const lines = fs.readFileSync(path.join(root, "chats", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { role: string; name: string });
    expect(lines.find((l) => l.role === "user")!.name).toBe("Robin");
  }, 30_000);

  it("leaves the other chats alone", async () => {
    seedPersonas();
    const m = mockHost();
    const a = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", personaId: "robin" } }, m);
    const b = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", personaId: "robin" } }, m);
    const aId = (a.json.meta as { id: string }).id;
    const bId = (b.json.meta as { id: string }).id;
    await drive(engineUrl, { method: "PATCH", path: `/chats/${aId}`, body: { personaId: "sam" } }, m);
    const other = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: bId } }, m);
    expect(spoken(other)).toContain("Speaking with Robin.");
  }, 30_000);

  it("a chat that pinned a persona ignores a change of the default", async () => {
    seedPersonas();
    const m = mockHost();
    const c = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria", personaId: "robin" } }, m);
    const id = (c.json.meta as { id: string }).id;
    // the app-wide default moves; the pinned chat must not follow
    await drive(engineUrl, { method: "PUT", path: "/settings", body: { personaId: "sam" } }, m);
    const peek = await drive(engineUrl, { method: "POST", path: "/prompt/preview", body: { chatId: id } }, m);
    expect(spoken(peek)).toContain("Speaking with Robin.");
  }, 30_000);
});

describe("rp studio: backups from older versions still import", () => {
  // The shape a pre-4.17.1 export produced: no chat meta sidecar, no memories,
  // no full persona records, a three-field settings stamp and no library.
  // Everything the newer importer reads is optional, so an old backup must
  // still land — nobody should have to re-export before restoring.
  it("imports a v1 backup with no sidecars", async () => {
    const entries: Record<string, string> = {
      "characters/nadia.json": JSON.stringify({ spec: "chara_card_v2", name: "Nadia", description: "A locksmith.", personality: "", scenario: "", first_mes: "Hey.", mes_example: "" }),
      "User Settings/personas.json": JSON.stringify({ Robin: "a detective" }),
      "User Settings/openai_settings.json": JSON.stringify({ "Night Shift": { temperature: 0.7, prompts: [], prompt_order: [] } }),
      "worlds/city.json": JSON.stringify({ name: "City", entries: { 0: { uid: 0, key: ["docks"], content: "Cold water.", comment: "Docks" } } }),
      "chats/nadia/a-quiet-word-cabc123.jsonl": [
        JSON.stringify({ name: "Nadia", is_user: false, is_system: false, send_date: new Date(0).toISOString(), mes: "Hey.", swipes: ["Hey."], swipe_id: 0, extra: {} }),
        JSON.stringify({ name: "Robin", is_user: true, is_system: false, send_date: new Date(0).toISOString(), mes: "Evening.", swipes: ["Evening."], swipe_id: 0, extra: {} }),
      ].join("\n") + "\n",
      "settings.json": JSON.stringify({ app: "studio", exportedAt: "2026-01-01T00:00:00.000Z", version: 1 }),
    };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.errors).toEqual([]);
    expect(r.json.characters).toHaveLength(1);
    expect(r.json.personas).toHaveLength(1);
    expect(r.json.presets).toHaveLength(1);
    expect(r.json.lorebooks).toHaveLength(1);
    expect(r.json.chats).toHaveLength(1);
    // no sidecar: the chat follows the current preset, with its title
    // recovered from the filename, rather than failing
    const chatId = (r.json.chats as string[])[0]!;
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8")) as Record<string, unknown>;
    expect(meta.presetLocked).toBeFalsy();
    expect(String(meta.title)).toContain("A Quiet Word");
    // a v1 settings stamp carries no `settings` key — it must not wipe ours
    const settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")) as { personaId: string };
    expect(settings.personaId).toBe("you");
  }, 30_000);

  it("leaves an existing library alone when the backup has none", async () => {
    fs.writeFileSync(path.join(root, "library.json"), JSON.stringify({ tags: ["keep-me"] }));
    const entries: Record<string, string> = {
      "characters/nadia.json": JSON.stringify({ spec: "chara_card_v2", name: "Nadia", description: "x", personality: "", scenario: "", first_mes: "hi", mes_example: "" }),
      "settings.json": JSON.stringify({ app: "studio", version: 1 }),
    };
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
    await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    const lib = JSON.parse(fs.readFileSync(path.join(root, "library.json"), "utf8")) as { tags: string[] };
    expect(lib.tags).toEqual(["keep-me"]);
  }, 30_000);
});

describe("marketplace Datacat discovery", () => {
  const id = "3ecff261-ec04-469d-9476-d0275c613962";
  it("authenticates before searching and applies rating/tags before pagination", async () => {
    const m = mockHost(undefined, (key, req) => {
      if (key === "identify") {
        expect(req.method).toBe("POST");
        expect(String(req.url)).toBe("https://datacat.run/api/liberator/identify");
        return { ok: true, json: { success: true, sessionToken: "private-token" } };
      }
      const url = new URL(String(req.url));
      expect((req.headers as Record<string, string>)["X-Session-Token"]).toBe("private-token");
      expect(url.searchParams.get("offset")).toBe("24");
      expect(url.searchParams.get("search")).toBe("wizard");
      expect(url.searchParams.get("tagIds")).toBe("6,1");
      expect(url.searchParams.get("sortBy")).toBe("score");
      return { ok: true, json: { success: true, totalCount: 45, characters: [{ characterId: id, name: "Wizard", creatorName: "Author", avatar: "portrait.webp", stats: { chat: 12, message: 90, favoritesCount: { favoritesCount: 7 } }, token_counts: { total_tokens: 1200 } }] } };
    });
    const r = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "datacat", search: "wizard", page: 2, first: 24, nsfw: false, tagIds: [6, -1, "2"], sort: "score" } }, m);
    expect(r.status).toBe(200);
    expect(r.__llmPending).toBeUndefined();
    expect(r.json).toMatchObject({ count: 45, page: 2 });
    expect((r.json.results as object[])[0]).toMatchObject({ id, chats: 12, favorites: 7, downloads: null, tokens: 1200, avatar: "https://ella.janitorai.com/bot-avatars/portrait.webp" });
    expect(JSON.stringify(r.json)).not.toContain("private-token");
  });
  it("returns tags and full preview fields without requesting a gated download", async () => {
    const m = mockHost(undefined, (key, req) => {
      if (key === "identify") return { ok: true, json: { sessionToken: "token" } };
      expect(String(req.url)).not.toContain("/download");
      if (String(req.url).includes("/tags/")) return { ok: true, json: { success: true, tags: [{ id: 6, name: "Fantasy", count: 43 }] } };
      return { ok: true, json: { success: true, character: { chara_card_v2_json: { data: { first_mes: "Hello", description: "Mage", alternate_greetings: ["Hi"], character_book: { entries: [{ content: "Lore" }] } } } } } };
    });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/tags", body: { source: "datacat" } }, m)).json.tags).toEqual([{ id: 6, tag: "Fantasy", n: 43 }]);
    const previewMock = mockHost(undefined, (key) => key === "identify" ? { ok: true, json: { sessionToken: "token" } } : { ok: true, json: { success: true, character: { chara_card_v2_json: { data: { first_mes: "Hello", description: "Mage", alternate_greetings: ["Hi"], character_book: { entries: [{ content: "Lore" }] } } } } } });
    const preview = await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { source: "datacat", id } }, previewMock);
    expect(preview.json).toMatchObject({ greeting: "Hello", personality: "Mage", alternateGreetings: ["Hi"], lorebookEntries: 1 });
  });
  it("rejects invalid ids before networking and surfaces failed or malformed responses", async () => {
    const m = mockHost();
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { source: "datacat", id: "../../secret" } }, m)).status).toBe(400);
    expect(m.netRequests).toHaveLength(0);
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "datacat" } }, m)).status).toBe(502);
    const broken = mockHost(undefined, (key) => key === "identify" ? { ok: true, json: { sessionToken: "token" } } : { ok: true, json: { success: true, characters: [] } });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "datacat" } }, broken)).status).toBe(502);
  });
  it("imports complete public cards, artwork, embedded lore, and provenance inside the app", async () => {
    const definition = "A complete definition. ".repeat(2000);
    const m = mockHost(undefined, (key, req) => {
      expect(String(req.url)).not.toContain("/download");
      if (key === "identify") return { ok: true, json: { sessionToken: "private-token" } };
      if (key === "avatar") { delete m.host.net.results.datacat; return { ok: true, contentType: "image/png", base64: "aW1hZ2U=" }; }
      return { ok: true, json: { success: true, character: { character_id: id, name: "Public Mage", creator_name: "Author", is_public: true, avatar: "https://media.datacat.run/avatar.png", chara_card_v2_json: { spec: "chara_card_v2", data: { name: "Public Mage", avatar: "none", description: definition, first_mes: "Hello", alternate_greetings: ["Hi"], system_prompt: "Stay in character", depth_prompt: { depth: 4, prompt: "Keep detail" }, extensions: { custom: true }, character_book: { name: "Mage lore", entries: [{ id: 0, keys: ["magic"], content: "Magic lore", enabled: true }] } } } } } };
    });
    m.host.store.get = () => ({ token: "private-token", expiresAt: Date.now() + 60000 });
    const preview = await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { source: "datacat", id } }, m);
    expect(preview.json.importable).toBe(true);
    expect(String(preview.json.personality).length).toBe(24000);
    const result = await drive(stUrl, { method: "POST", path: "/marketplace/import", body: { source: "datacat", id } }, m);
    expect(result.status).toBe(200);
    expect(result.__llmPending).toBeUndefined();
    const cid = (result.json.characters as string[])[0]!;
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", cid, "card.json"), "utf8"));
    expect(card.description).toBe(definition);
    expect(card.avatar).toBe("data:image/png;base64,aW1hZ2U=");
    expect(card.system_prompt).toBe("Stay in character");
    expect(card.alternate_greetings).toEqual(["Hi"]);
    expect(card.depth_prompt).toEqual({ depth: 4, prompt: "Keep detail" });
    expect(card.extensions.custom).toBe(true);
    expect(card.extensions.datacat.id).toBe(id);
    expect(card.creator).toBe("Author");
    expect(card.studio.embeddedLorebookId).toBe((result.json.lorebooks as string[])[0]);
    expect(JSON.stringify(result.json)).not.toContain("private-token");
  });
  it("blocks restricted or missing definitions without writing cards", async () => {
    for (const restriction of [{ downloads_disabled: true }, { creator_chat_download_policy: "deny" }, { creator_lifecycle_status: "dormant" }, { is_public: false }, { is_recovery_placeholder: true }]) {
      const m = mockHost(undefined, key => key === "identify" ? { ok: true, json: { sessionToken: "token" } } : { ok: true, json: { success: true, character: { ...restriction, name: "Restricted", personality: "Definition" } } });
      const preview = await drive(stUrl, { method: "POST", path: "/marketplace/detail", body: { source: "datacat", id } }, m);
      expect(preview.json.importable).toBe(false);
      expect((await drive(stUrl, { method: "POST", path: "/marketplace/import", body: { source: "datacat", id } }, m)).status).toBe(403);
    }
    const missing = mockHost(undefined, key => key === "identify" ? { ok: true, json: { sessionToken: "token" } } : { ok: true, json: { success: true, character: { name: "Only a blurb", description: "Website notes" } } });
    expect((await drive(stUrl, { method: "POST", path: "/marketplace/import", body: { source: "datacat", id } }, missing)).status).toBe(403);
    expect(fs.readdirSync(path.join(root, "characters"))).toEqual(["aria"]);
  });
  it("reuses backend sessions, browses creator catalogs, and searches less common tags", async () => {
    const creator = "a5cc3d86-23ac-47ef-916f-9d50c8e3ef41";
    const m = mockHost(undefined, (key, req) => {
      expect(key).toBe("datacat");
      expect((req.headers as Record<string, string>)["X-Session-Token"]).toBe("saved-token");
      if (String(req.url).includes("/tags/")) return { ok: true, json: { success: true, tags: [...Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, name: "Popular " + i, count: 100 })), { id: 2001, name: "Rare fantasy", count: 1 }] } };
      expect(String(req.url)).toContain(`/api/creators/${creator}/characters?limit=24&offset=24&sortBy=chat_count`);
      return { ok: true, json: { success: true, total: 25, list: [{ characterId: id, creatorId: creator, name: "Mage", creatorName: "Author", chatCount: 42, tokenCounts: { totalTokens: 1200 } }] } };
    });
    m.host.store.get = () => ({ token: "saved-token", expiresAt: Date.now() + 60000 });
    const result = await drive(stUrl, { method: "POST", path: "/marketplace/search", body: { source: "datacat", creator, page: 2 } }, m);
    expect(result.json.count).toBe(25);
    expect((result.json.results as object[])[0]).toMatchObject({ creatorId: creator, chats: 42, tokens: 1200 });
    const tags = await drive(stUrl, { method: "POST", path: "/marketplace/tags", body: { source: "datacat", search: "rare" } }, m);
    expect(tags.json.tags).toEqual([{ id: 2001, tag: "Rare fantasy", n: 1 }]);
    const restored = await drive(stUrl, { method: "POST", path: "/marketplace/tags", body: { source: "datacat", selected: ["Rare fantasy"] } }, m);
    expect((restored.json.tags as object[])[0]).toEqual({ id: 2001, tag: "Rare fantasy", n: 1 });
    expect(JSON.stringify(tags.json)).not.toContain("saved-token");
  });
  it("records actual import time and preserves other studio fields", async () => {
    const start = Date.now();
    const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [{ name: "Imported", studio: { createdAt: 100, favorite: true } }] } }, mockHost());
    const id = (r.json.characters as string[])[0]!;
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", id, "card.json"), "utf8"));
    expect(card.studio.importedAt).toBeGreaterThanOrEqual(start);
    expect(card.studio.importedAt).toBeLessThanOrEqual(Date.now());
    expect(card.studio).toMatchObject({ createdAt: 100, favorite: true });
  });
});

it("PNG imports decode UTF-8 quotation marks, names and emoji on the backend", async () => {
  const card = { name: "Élodie 綾", first_mes: "She didn’t say ‘no’. 🙂", description: "Café — 夜" };
  const text = Buffer.from("chara\0" + Buffer.from(JSON.stringify(card), "utf8").toString("base64"), "ascii");
  const png = Buffer.alloc(8 + 12 + text.length);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(text.length, 8);
  png.write("tEXt", 12);
  text.copy(png, 16);
  const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [{ pngBase64: png.toString("base64") }] } }, mockHost());
  expect(r.status).toBe(200);
  const id = (r.json.characters as string[])[0]!;
  expect(JSON.parse(fs.readFileSync(path.join(root, "characters", id, "card.json"), "utf8"))).toMatchObject(card);
});

it("PNG imports preserve uncompressed international text chunks", async () => {
  for (const keyword of ["chara", "ccv3"]) {
    const card = { name: "Élodie", first_mes: "Hello 🙂" };
    const json = JSON.stringify(card);
    const payload = keyword === "chara" ? Buffer.from(json).toString("base64") : json;
    const text = Buffer.from(keyword + "\0\0\0\0\0" + payload, "utf8");
    const png = Buffer.alloc(8 + 12 + text.length);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(text.length, 8);
    png.write("iTXt", 12);
    text.copy(png, 16);
    const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [{ pngBase64: png.toString("base64") }] } }, mockHost());
    expect(r.status).toBe(200);
    const id = (r.json.characters as string[])[0]!;
    expect(JSON.parse(fs.readFileSync(path.join(root, "characters", id, "card.json"), "utf8"))).toMatchObject(card);
  }
});

it("upgrades card media without changing metadata and can safely retry or defer a card", async () => {
  const mod = await import(engineUrl);
  const m = mockHost();
  const avatar = "data:image/png;base64,aW1hZ2U=";
  const card = { name: "Aria", description: "Keep me", avatar, studio: { avatar, favorite: true, importedAt: 123, gallery: [{ url: avatar }], unknownField: { saved: true } }, extensions: { custom: "Keep this too" } };
  const rel = "characters/aria/card.json";
  m.host.fs.write(rel, JSON.stringify(card));
  const url = "/v1/apps/roleplay/__media/" + "a".repeat(64) + ".png";
  Object.assign(m.host.fs, { media: () => url });
  expect(mod.onAppUpdate({ from: "4.19.0", to: "4.20.0" }, m.host).upgraded).toContain("character media: 1");
  const stored = JSON.parse(m.host.fs.read(rel));
  expect(stored.avatar).toBe(url);
  expect(stored.studio.avatar).toBeUndefined();
  expect(stored.studio.gallery[0].url).toBe(url);
  expect(stored.description).toBe("Keep me");
  expect(stored.studio.importedAt).toBe(123);
  expect(stored.studio.favorite).toBe(true);
  expect(stored.studio.unknownField).toEqual({ saved: true });
  expect(stored.extensions).toEqual(card.extensions);
  expect(mod.onAppUpdate({ from: "4.19.0", to: "4.20.0" }, m.host).upgraded).toEqual([]);
  m.host.fs.write(rel, JSON.stringify(card));
  Object.assign(m.host.fs, { media: () => { throw new Error("disk full"); } });
  expect(mod.onAppUpdate({ from: "4.19.0", to: "4.20.0" }, m.host).upgraded).toEqual([]);
  expect(JSON.parse(m.host.fs.read(rel))).toEqual(card);
  expect(mod.handleRoute({ method: "GET", path: "/characters", body: null }, m.host).json.characters[0].avatar).toBe(avatar);
});


describe("card import choices and sources", () => {
  const script = { scriptName: "First", findRegex: "/a/", replaceString: "b", placement: [2] };
  const card = { spec: "chara_card_v2", data: { name: "Import Test", first_mes: "aaa", extensions: { regex_scripts: [script, { ...script, scriptName: "Off", disabled: true }] }, character_book: { name: "Import Lore", entries: [{ keys: ["a"], content: "Lore", enabled: true }] } } };
  const readScript = (id: string) => JSON.parse(fs.readFileSync(path.join(root, "regex", id + ".json"), "utf8"));
  it("imports and links lore while embedded regex waits for an explicit choice", async () => {
    for (const enabled of [false, true]) {
      const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [card], enableEmbeddedRegex: enabled } }, mockHost());
      expect(r.json.lorebooks).toHaveLength(1);
      const scripts = (r.json.regex as string[]).map(readScript);
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toMatchObject({ flags: "", disabled: !enabled, scope: "character", scopeTargetId: (r.json.characters as string[])[0] });
      expect(scripts[1].disabled).toBe(true);
    }
  });
  it("extracts ordered preset regex in both batch and archive imports", async () => {
    for (const [name, body] of [["With regex", { enableEmbeddedRegex: true }], ["With regex zip", null]] as const) {
      const preset = { name, prompts: [{ identifier: "main", name: "Main", content: "hello" }], extensions: { regex_scripts: [script, { ...script, scriptName: "Second" }] } };
      const m = mockHost();
      if (!body) (m.host as { zip: unknown }).zip = { entries: () => ({ "presets/shared.json": JSON.stringify(preset) }), list: () => 1 };
      const r = await drive(stUrl, { method: "POST", path: body ? "/import/batch" : "/import/zip", body: body ? { presets: [preset], ...body } : {} }, m);
      expect(r.json.regex).toHaveLength(2);
      const scripts = (r.json.regex as string[]).map(readScript);
      expect(scripts.map((s) => s.order)).toEqual([0, 1]);
      expect(scripts[0]).toMatchObject({ scope: "preset", scopeTargetId: (r.json.presets as string[])[0], disabled: !body, flags: "" });
    }
  });
  it("a preset imported again replaces itself and brings no second copy of its scripts", async () => {
    const preset = { name: "Again", temperature: 0.4, prompts: [{ identifier: "main", name: "Main", content: "v1" }], extensions: { regex_scripts: [{ ...script, scriptName: "Again one" }] } };
    const first = await drive(stUrl, { method: "POST", path: "/import/batch", body: { presets: [preset] } }, mockHost());
    expect(first.json.regex).toHaveLength(1);
    const again = await drive(stUrl, { method: "POST", path: "/import/batch", body: { presets: [{ ...preset, temperature: 0.8 }] } }, mockHost());
    expect(again.json.presets).toEqual(first.json.presets);
    expect(again.json.regex).toHaveLength(0);
    const id = (first.json.presets as string[])[0];
    expect(JSON.parse(fs.readFileSync(path.join(root, "presets", id + ".json"), "utf8")).temperature).toBe(0.8);
  });
  it("skips a script the library already runs everywhere", async () => {
    const shared = { ...script, scriptName: "Everywhere" };
    const global = await drive(stUrl, { method: "POST", path: "/import/batch", body: { regex: [shared] } }, mockHost());
    expect(global.json.regex).toHaveLength(1);
    const repeat = await drive(stUrl, { method: "POST", path: "/import/batch", body: { regex: [shared, { ...shared, replaceString: "c" }] } }, mockHost());
    expect(repeat.json.regex).toHaveLength(1);
    const withCard = { ...card, data: { ...card.data, name: "Carries shared", extensions: { regex_scripts: [shared] } } };
    const r = await drive(stUrl, { method: "POST", path: "/import/batch", body: { cards: [withCard], presets: [{ name: "Carries shared", prompts: [{ identifier: "main", name: "Main", content: "x" }], extensions: { regex_scripts: [shared] } }] } }, mockHost());
    expect(r.json.characters).toHaveLength(1);
    expect(r.json.regex).toHaveLength(0);
  });
  it("imports catalog JSON cards with their embedded content", async () => {
    const m = mockHost(undefined, (key, req) => {
      expect(key).toBe("card");
      expect(req.url).toBe("https://server.pygmalion.chat/api/export/character/12345678-1234-1234-1234-123456789abc/v2");
      return { ok: true, json: { character: card } };
    });
    const r = await drive(stUrl, { method: "POST", path: "/import/url", body: { url: "https://pygmalion.chat/character/12345678-1234-1234-1234-123456789abc", enableEmbeddedRegex: true } }, m);
    expect(r.json.characters).toHaveLength(1);
    expect(r.json.lorebooks).toHaveLength(1);
    expect(readScript((r.json.regex as string[])[0]!).disabled).toBe(false);
  });
  it("imports PNG sources and keeps artwork, lore and regex", async () => {
    const chunk = (type: string, body: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]); };
    const payload = Buffer.from(JSON.stringify(card)).toString("base64");
    const base64 = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("tEXt", Buffer.from("chara\0" + payload)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
    for (const [url, endpoint] of [
      ["https://realm.risuai.net/character/abcdef12", "https://realm.risuai.net/api/v1/download/png-v3/abcdef12?non_commercial=true"],
      ["https://aicharactercards.com/characters/author/card/", "https://aicharactercards.com/wp-json/pngapi/v1/image/author/card"],
    ]) {
      const m = mockHost(undefined, (_key, req) => { expect(req.url).toBe(endpoint); return { ok: true, base64 }; });
      const r = await drive(stUrl, { method: "POST", path: "/import/url", body: { url } }, m);
      expect(r.json.characters).toHaveLength(1);
      expect(r.json.lorebooks).toHaveLength(1);
      expect(r.json.regex).toHaveLength(2);
      const saved = JSON.parse(fs.readFileSync(path.join(root, "characters", (r.json.characters as string[])[0]!, "card.json"), "utf8"));
      expect(saved.avatar).toBe("data:image/png;base64," + base64);
    }
  });
  it("rejects unsupported hosts and reports failed downloads without writing a card", async () => {
    const m = mockHost(undefined, () => ({ ok: false, status: 403 }));
    for (const url of ["https://pygmalion.chat.evil.example/character/12345678-1234-1234-1234-123456789abc", "https://realm.risuai.net.evil.example/character/abc", "https://chub.ai/characters/a/b/extra", "https://example.com/card.png"]) {
      const r = await drive(stUrl, { method: "POST", path: "/import/url", body: { url } }, m);
      expect(r.status).toBe(400);
    }
    expect(m.netRequests).toHaveLength(0);
    const r = await drive(stUrl, { method: "POST", path: "/import/url", body: { url: "https://realm.risuai.net/character/abc" } }, m);
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toContain("403");
    expect(fs.readdirSync(path.join(root, "characters"))).toEqual(["aria"]);
  });
});

it("backup regex keeps character, preset and chat owners without duplicates", async () => {
  const m = mockHost();
  const made = await drive(engineUrl, { method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
  const chatId = (made.json.meta as { id: string }).id;
  const cardPath = path.join(root, "characters/aria/card.json");
  const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
  card.extensions = { custom: true, regex_scripts: [{ scriptName: "Old embedded", findRegex: "/x/g" }] };
  fs.writeFileSync(cardPath, JSON.stringify(card));
  const presetPath = path.join(root, "presets/default.json");
  const preset = JSON.parse(fs.readFileSync(presetPath, "utf8"));
  preset.extensions = { custom: true, regex_scripts: [{ scriptName: "Old preset", findRegex: "/x/g" }] };
  fs.writeFileSync(presetPath, JSON.stringify(preset));
  for (const [scope, scopeTargetId, order] of [["character", "aria", 3], ["preset", "default", 2], ["chat", chatId, 1]] as const) {
    fs.writeFileSync(path.join(root, "regex", scope + ".json"), JSON.stringify({ scriptName: "Same name", findRegex: "a", flags: "", replaceString: scope, placement: ["ai_output"], scope, scopeTargetId, order, disabled: scope === "preset" }));
  }
  const exp = await drive(engineUrl, { method: "GET", path: "/export/backup" }, m);
  const files = unzipSync(Buffer.from(exp.json.base64 as string, "base64")) as Record<string, Uint8Array>;
  const entries: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) entries[name] = new TextDecoder().decode(data);
  expect(Object.keys(entries).filter((n) => n.startsWith("User Settings/regex/"))).toHaveLength(3);
  const m2 = mockHost();
  (m2.host as { zip: unknown }).zip = { entries: () => entries, list: () => Object.keys(entries).length };
  const restored = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m2);
  expect(restored.json.errors).toEqual([]);
  expect(restored.json.regex).toHaveLength(3);
  const scripts = (restored.json.regex as string[]).map((id) => JSON.parse(fs.readFileSync(path.join(root, "regex", id + ".json"), "utf8")));
  expect(scripts.find((s) => s.scope === "character")).toMatchObject({ scopeTargetId: (restored.json.characters as string[])[0], order: 3, flags: "", disabled: false });
  expect(scripts.find((s) => s.scope === "preset")).toMatchObject({ scopeTargetId: (restored.json.presets as string[])[0], order: 2, disabled: true });
  expect(scripts.find((s) => s.scope === "chat")).toMatchObject({ scopeTargetId: (restored.json.chats as string[])[0], order: 1 });
});

describe('marketplace Wyvern discovery', () => {
  const character = {
    id: '_public-character', name: 'Listing title', chat_name: 'Ada', visibility: 'public',
    first_mes: 'Hello', description: 'An explorer', creator: { displayName: 'Writer' },
    tags: ['Adventure'], rating: 'none', token_count: 321,
    statistics_record: { messages: 50, chats: 12, likes: 4 },
    enable_advanced_greetings: true, greetings: [{ id: 'default', content: 'Hello' }, { id: 'second', content: 'Welcome' }],
    lorebooks: [{ name: 'Places', entries: [{ keys: ['home'], content: 'A harbor', enabled: true }] }],
    regex_scripts: [{ scriptName: 'Cleanup', findRegex: '/hello/g', replaceString: 'hi', placement: [2] }],
  }

  it('searches the full catalog without a popularity pool and keeps real metrics', async () => {
    const m = mockHost(undefined, () => ({ ok: true, json: { characters: [character], total: 1234 } }))
    const r = await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'wyvern', search: 'explorer', page: 2, first: 24, tags: ['Adventure'], nsfw: false } }, m)
    expect(r.status).toBe(200)
    const url = new URL(String(m.netRequests[0]?.req.url))
    expect(url.pathname).toBe('/api/characters/public')
    expect(url.searchParams.get('query')).toBe('explorer')
    expect(url.searchParams.get('sort')).toBe('total_views')
    expect(url.searchParams.has('show_nsfw')).toBe(false)
    expect(url.searchParams.get('rating')).toBe('none')
    expect(url.searchParams.get('page')).toBe('2')
    expect(r.json.count).toBe(1234)
    const item = (r.json.results as Record<string, unknown>[])[0]
    expect(item?.messages).toBe(50)
    expect(item?.chats).toBe(12)
    expect(item?.downloads).toBeNull()
  })

  it('previews and imports the public card with lore and disabled regex', async () => {
    const m = mockHost(undefined, () => ({ ok: true, json: character }))
    const preview = await drive(stUrl, { method: 'POST', path: '/marketplace/detail', body: { source: 'wyvern', id: character.id } }, m)
    expect(preview.json.importable).toBe(true)
    expect(preview.json.alternateGreetings).toEqual(['Welcome'])
    expect(preview.json.lorebookEntries).toBe(1)
    expect(preview.json.lorebook).toMatchObject({ name: 'Places', entries: [{ keys: ['home'], content: 'A harbor', enabled: true }] })
    const r = await drive(stUrl, { method: 'POST', path: '/marketplace/import', body: { source: 'wyvern', id: character.id } }, m)
    expect(r.status).toBe(200)
    expect((r.json.characters as unknown[]).length).toBe(1)
    expect((r.json.lorebooks as unknown[]).length).toBe(1)
    expect((r.json.regex as unknown[]).length).toBe(1)
    expect(r.json.name).toBe('Ada')
    const regex = JSON.parse(fs.readFileSync(path.join(root, 'regex', fs.readdirSync(path.join(root, 'regex'))[0]!), 'utf8'))
    expect(regex.disabled).toBe(true)
  })

  it('rejects private definitions and malformed ids', async () => {
    const m = mockHost(undefined, () => ({ ok: true, json: { ...character, secretFields: ['description'] } }))
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/import', body: { source: 'wyvern', id: character.id } }, m)).status).toBe(403)
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/detail', body: { source: 'wyvern', id: '../bad' } }, m)).status).toBe(400)
  })

  it('reports source errors and invalid totals', async () => {
    const failed = mockHost(undefined, () => ({ ok: false, status: 503 }))
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'wyvern' } }, failed)).status).toBe(502)
    const invalid = mockHost(undefined, () => ({ ok: true, json: { results: [], total: 'many' } }))
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'wyvern' } }, invalid)).status).toBe(502)
  })
})

describe('marketplace current catalogs', () => {
  const pageData = (value: unknown) => {
    const values: unknown[] = []
    const add = (value: unknown): number => {
      const index = values.length
      values.push(null)
      values[index] = Array.isArray(value) ? value.map(add) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, add(item)])) : value
      return index
    }
    add(value)
    return JSON.stringify({ type: 'data', nodes: [{ type: 'skip' }, { type: 'skip' }, { type: 'data', data: values }] })
  }
  const character = { name: 'Traveler', visibility: 'public', definition_character_description: '**A traveler**', definition_first_message: 'Welcome' }
  it('requests adult content through the public catalog endpoint', async () => {
    for (const only of [false, true]) {
      const m = mockHost(undefined, () => ({ ok: true, json: { characters: [{ id: 'adult-card', name: 'Card', rating: 'mature' }], total: 45 } }))
      const r = await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'wyvern', nsfw: true, nsfwOnly: only, sort: 'newest' } }, m)
      const url = new URL(String(m.netRequests[0]?.req.url))
      expect(url.origin).toBe('https://app.wyvern.chat')
      expect(url.pathname).toBe('/api/characters/public')
      expect(url.searchParams.get('show_nsfw')).toBe('true')
      expect(url.searchParams.get('rating')).toBe(only ? 'explicit' : null)
      expect(url.searchParams.get('sort')).toBe('dateCreated')
      expect((r.json.results as { nsfw: boolean }[])[0]?.nsfw).toBe(true)
    }
  })
  it('reads catalog page data and uses the reported page size', async () => {
    const m = mockHost(undefined, () => ({ ok: true, text: pageData({ searchResults: { hits: [{ path: 'author/card', name: 'Card', author: 'Author', permanentTokens: 789 }], totalHits: 234, hitsPerPage: 30 } }) }))
    const r = await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'tavern', search: 'Card', sort: 'updated' } }, m)
    expect(r.status).toBe(200)
    expect(r.json.first).toBe(30)
    expect(r.json.count).toBe(234)
    expect((r.json.results as { id: string; downloads: null }[])[0]).toMatchObject({ id: 'author/card', downloads: null })
    const url = new URL(String(m.netRequests[0]?.req.url))
    expect(url.pathname).toBe('/search/cards/__data.json')
    expect(url.searchParams.get('sort')).toBe('recently_updated')
  })
  it('resolves deferred greetings without evaluating page scripts', async () => {
    const payload = JSON.parse(pageData({ character }))
    const values = payload.nodes[2].data as unknown[]
    const rootData = values[0] as Record<string, number>
    rootData.alternativeGreetings = values.length
    values.push(['Promise', values.length + 1], 7)
    const text = JSON.stringify(payload) + '\n' + JSON.stringify({ type: 'chunk', id: 7, data: [[1], 'Another greeting'] })
    const m = mockHost(undefined, () => ({ ok: true, text }))
    const r = await drive(stUrl, { method: 'POST', path: '/marketplace/detail', body: { source: 'tavern', id: 'author/card' } }, m)
    expect(r.status).toBe(200)
    expect(r.json.alternateGreetings).toEqual(['Another greeting'])
  })
  it('imports the embedded PNG definition, lore and disabled regex', async () => {
    const card = { spec: 'chara_card_v2', data: { name: 'Traveler', description: 'Definition', first_mes: 'Hello', alternate_greetings: ['Welcome'], character_book: { name: 'Travel', entries: [{ keys: ['road'], content: 'A road', enabled: true }] }, extensions: { regex_scripts: [{ scriptName: 'Cleanup', findRegex: '/x/g', replaceString: 'y', placement: [2] }] } } }
    const chunk = (type: string, body: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]) }
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('tEXt', Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
    const m = mockHost(undefined, key => key === 'png' ? { ok: true, base64: png } : { ok: true, text: pageData({ character }) })
    Object.assign(m.host.fs, { image: () => ({ url: 'data:image/png;base64,' + png, metadata: { chara: Buffer.from(JSON.stringify(card)).toString('base64') } }) })
    const preview = await drive(stUrl, { method: 'POST', path: '/marketplace/detail', body: { source: 'tavern', id: 'author/card' } }, m)
    expect(preview.json.personality).toBe('**A traveler**')
    const r = await drive(stUrl, { method: 'POST', path: '/marketplace/import', body: { source: 'tavern', id: 'author/card' } }, m)
    expect(r.status).toBe(200)
    expect(r.json.characters).toHaveLength(1)
    expect(r.json.lorebooks).toHaveLength(1)
    expect(r.json.regex).toHaveLength(1)
  })
  it('rejects invalid paths, missing data and private definitions', async () => {
    const m = mockHost(undefined, () => ({ ok: true, text: pageData({ character: { ...character, visibility: 'private' } }) }))
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/import', body: { source: 'tavern', id: 'author/card' } }, m)).status).toBe(403)
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/detail', body: { source: 'tavern', id: '../card' } }, m)).status).toBe(400)
    const invalid = mockHost(undefined, () => ({ ok: true, text: '{"nodes":[]}' }))
    expect((await drive(stUrl, { method: 'POST', path: '/marketplace/search', body: { source: 'tavern' } }, invalid)).status).toBe(502)
  })
})

describe("rp studio: a foreign user folder imports linked up", () => {
  const chunk = (type: string, body: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, Buffer.from(type), body, Buffer.alloc(4)]); };
  const cardPng = (card: object) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("tEXt", Buffer.from("chara\0" + Buffer.from(JSON.stringify(card)).toString("base64"))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
  const settings = JSON.stringify({
    power_user: { personas: { "user-default.png": "Alex" }, persona_descriptions: { "user-default.png": { description: "Me", title: "Traveler" } }, default_persona: "user-default.png" },
    extension_settings: {
      regex: [{ scriptName: "Strip stars", findRegex: "/\\*/g", replaceString: "", placement: [2] }],
      quickReplyV2: { config: { setList: [{ set: "Main", isVisible: true }] } },
    },
  });
  const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const entries = (): Record<string, unknown> => ({
    "default-user/settings.json": settings,
    "default-user/characters/sera_v2.png": { __b64__: true, base64: cardPng({ spec: "chara_card_v2", data: { name: "Seraphina", description: "Guardian", extensions: { world: "Eldoria" } } }) },
    "default-user/characters/Seraphina/joy.png": { __b64__: true, base64: "QUFB" },
    "default-user/worlds/Eldoria.json": JSON.stringify({ entries: { 0: { uid: 0, key: ["forest"], content: "A forest" } } }),
    "default-user/chats/sera_v2/2024-01-01.jsonl": jsonl({ user_name: "Alex", character_name: "Seraphina", chat_metadata: { persona: "user-default.png" } }, { name: "Seraphina", is_user: false, mes: "Hello" }),
    "default-user/groups/1700.json": JSON.stringify({ id: "1700", name: "Party", members: ["sera_v2.png"], disabled_members: ["sera_v2.png"], chats: ["Party - old", "Party - new"], chat_id: "Party - new", activation_strategy: 1, generation_mode: 1, past_metadata: { big: "x" } }),
    "default-user/group chats/Party - old.jsonl": jsonl({ chat_metadata: {} }, { name: "Sera", is_user: false, mes: "Hi all", original_avatar: "sera_v2.png" }),
    "default-user/User Avatars/user-default.png": { __b64__: true, base64: "QkJC" },
    "default-user/QuickReplies/Main.json": JSON.stringify({ name: "Main", disableSend: true, qrList: [{ label: "Wave", message: "*waves*", executeOnAi: true }, { label: "helper", message: "/echo", isHidden: true }] }),
    "default-user/QuickReplies/Other.json": JSON.stringify({ name: "Other", qrList: [{ label: "Nod", message: "*nods*" }] }),
    "default-user/themes/Dark Lilac.json": JSON.stringify({ name: "Dark Lilac", main_text_color: "rgba(220, 220, 210, 1)", chat_tint_color: "rgba(23, 23, 23, 1)", quote_text_color: "#c8f" }),
    "default-user/instruct/ChatML.json": JSON.stringify({ name: "ChatML", input_sequence: "<|im_start|>user", output_sequence: "<|im_start|>assistant", wrap: true }),
  });
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

  it("links chats, groups, sprites, books and personas by the files the folder names", async () => {
    fs.writeFileSync(path.join(root, "library.json"), JSON.stringify({ themes: [], qrSets: [] }));
    const m = mockHost();
    const all = entries();
    (m.host as { zip: unknown }).zip = { entries: () => all, list: () => Object.keys(all).length };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.errors).toEqual([]);
    const seraId = (r.json.characters as string[])[0]!;
    const sera = read(`characters/${seraId}/card.json`);
    expect(sera.avatar).toStartWith("data:image/png;base64,");
    expect(sera.studio.expressions).toEqual([{ name: "joy", url: "data:image/png;base64,QUFB" }]);
    expect(read(`lorebooks/${(r.json.lorebooks as string[])[0]}.json`).linkedCharacterIds).toEqual([seraId]);
    // chats scope books from the card, so the card carries the link too
    expect(sera.studio.linkedLorebookIds).toEqual([(r.json.lorebooks as string[])[0]]);

    const metas = (r.json.chats as string[]).map((id) => read(`chats/${id}.meta.json`));
    const group = read(`groups/${(r.json.groups as string[])[0]}.json`);
    expect(group).toMatchObject({ name: "Party", memberIds: [seraId], mutedIds: [seraId], mode: "list", generationMode: "append" });
    expect(group.past_metadata).toBeUndefined();
    expect(metas.find((c) => c.characterId === seraId)).toBeDefined();
    const groupChat = metas.find((c) => c.groupId === group.id)!;
    expect(groupChat).toBeDefined();
    const said = fs.readFileSync(path.join(root, "chats", `${groupChat.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(said[0].charId).toBe(seraId);

    const persona = read(`personas/${(r.json.personas as string[])[0]}.json`);
    expect(persona).toMatchObject({ name: "Alex", description: "Me", title: "Traveler", isDefault: true, avatar: "data:image/png;base64,QkJC" });
    // the chat the folder locked to that persona stays locked to it
    expect(metas.find((c) => c.characterId === seraId)).toMatchObject({ personaId: persona.id, personaLocked: true });
    expect(groupChat.personaLocked).toBeFalsy();
    expect(r.json.regex).toHaveLength(1);

    const lib = read("library.json");
    expect(lib.qrSets.map((s: { name: string; enabled: boolean }) => [s.name, s.enabled])).toEqual([["Main", true], ["Other", false]]);
    expect(lib.qrSets[0].replies).toEqual([expect.objectContaining({ label: "Wave", message: "*waves*", mode: "insert", autoExecute: { onStartup: false, onUser: false, onAi: false, onChatChange: false } })]);
    expect(lib.themes[0]).toMatchObject({ name: "Dark Lilac", colors: { mainText: "#dcdcd2", chatBg: "#171717", quotes: "#cc88ff" } });
    const chatml = (r.json.presets as string[]).map((id) => read(`presets/${id}.json`)).find((p) => p.name === "ChatML");
    expect(chatml.studio.promptFormat.custom.userPrefix).toBe("<|im_start|>user\n");

    // a second run adds no duplicate sets or themes
    const again = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(again.json.quickReplies).toEqual([]);
    expect(read("library.json").themes).toHaveLength(1);
  }, 30_000);

  it("reads a foreign transcript the way its app wrote it", async () => {
    const m = mockHost();
    const lines = jsonl(
      { user_name: "Alex", character_name: "Seraphina", create_date: "2023-6-19 @14h 20m 00s 000ms", chat_metadata: { note_prompt: "Stay tense.", note_depth: 2, note_position: 2, note_role: 1 } },
      { name: "Seraphina", is_user: false, send_date: "June 19, 2023 2:20pm", mes: "Old hello." },
      { name: "Alex", is_user: true, send_date: "2023-06-19@14h21m05s", mes: "Hidden aside.", is_system: true },
      { name: "System", is_user: false, send_date: 1687184500000, mes: "The sun sets.", extra: { type: "narrator" } },
      { name: "Seraphina", is_user: false, send_date: "2023-06-19T14:22:00.000Z", mes: "Two", swipe_id: 1, swipes: ["One", "Two"], swipe_info: [{ extra: { reasoning: "first" } }, { extra: { reasoning: "second" } }], extra: { reasoning: "second" } },
    );
    const all: Record<string, unknown> = {
      "default-user/settings.json": settings,
      "default-user/characters/sera_v2.png": { __b64__: true, base64: cardPng({ spec: "chara_card_v2", data: { name: "Seraphina", extensions: { world: "Eldoria" }, character_book: { entries: [{ keys: ["forest"], content: "A forest", enabled: true }] } } }) },
      "default-user/worlds/Eldoria.json": JSON.stringify({ entries: { 0: { uid: 0, key: ["forest"], content: "A forest" } } }),
      "default-user/chats/sera_v2/Seraphina - 2023-6-19 @14h 20m 00s 000ms.jsonl": lines,
    };
    (m.host as { zip: unknown }).zip = { entries: () => all, list: () => 4 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.errors).toEqual([]);
    // the card's copy of its linked world stays in the card: one book, not two
    expect(r.json.lorebooks).toHaveLength(1);
    const card = read(`characters/${(r.json.characters as string[])[0]}/card.json`);
    expect(card.character_book).toBeDefined();
    expect(card.studio.embeddedLorebookPending).toBe(false);
    const meta = read(`chats/${(r.json.chats as string[])[0]}.meta.json`);
    expect(meta.title).toBe("Seraphina - 2023-6-19 @14h 20m 00s 000ms");
    expect(meta.userName).toBe("Alex");
    expect(meta.authorNoteObject).toMatchObject({ text: "Stay tense.", depth: 2, position: "before-system", role: "user" });
    expect(meta.createdAt).toBe(Date.UTC(2023, 5, 19, 14, 20));
    const msgs = fs.readFileSync(path.join(root, "chats", `${meta.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(msgs[0].at).toBe(new Date(2023, 5, 19, 14, 20).getTime());
    expect(msgs[1]).toMatchObject({ role: "user", hidden: true, at: Date.UTC(2023, 5, 19, 14, 21, 5) });
    expect(msgs[2]).toMatchObject({ role: "system", at: 1687184500000 });
    expect(msgs[3].extra).toEqual({ reasoning: "second", swipeMeta: [{ reasoning: "first" }, { reasoning: "second" }] });
  }, 30_000);

  it("turns on a card's own regex only where the settings file allowed it", async () => {
    const m = mockHost();
    const script = { scriptName: "Card script", findRegex: "/a/g", replaceString: "b", placement: [2] };
    const withAllow = JSON.stringify({ extension_settings: { character_allowed_regex: ["kept.png"] } });
    const all: Record<string, unknown> = {
      "default-user/settings.json": withAllow,
      "default-user/characters/kept.png": { __b64__: true, base64: cardPng({ spec: "chara_card_v2", data: { name: "Kept", extensions: { regex_scripts: [script] } } }) },
      "default-user/characters/other.png": { __b64__: true, base64: cardPng({ spec: "chara_card_v2", data: { name: "Other", extensions: { regex_scripts: [script] } } }) },
    };
    (m.host as { zip: unknown }).zip = { entries: () => all, list: () => 3 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    const scripts = (r.json.regex as string[]).map((id) => read(`regex/${id}.json`));
    const byCard = Object.fromEntries(scripts.map((s) => [read(`characters/${s.scopeTargetId}/card.json`).name, s.disabled]));
    expect(byCard).toEqual({ Kept: false, Other: true });
  }, 30_000);

  it("leaves settings-file personas and regex out when those collections were not chosen", async () => {
    const m = mockHost();
    (m.host as { zip: unknown }).zip = { entries: () => ({ "default-user/settings.json": settings }), list: () => 1 };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { include: ["characters/", "settings.json"] } }, m);
    expect(r.json.personas).toEqual([]);
    expect(r.json.regex).toEqual([]);
  }, 30_000);
});

describe("rp studio: an archive's chats find cards imported before it", () => {
  it("links a chat to a card already in the library when its import did not bring the card", async () => {
    fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "aria", "card.json"), JSON.stringify({ name: "Aria Vale" }));
    const entries = {
      "chats/Aria Vale/Aria Vale - 2024-07-12@01h31m37s123ms.jsonl": [
        JSON.stringify({ user_name: "You", character_name: "Aria Vale", create_date: "2024-07-12@01h31m37s123ms" }),
        JSON.stringify({ name: "Aria Vale", is_user: false, mes: "hello", send_date: "July 12, 2024 1:31am" }),
      ].join("\n"),
    };
    const m = mockHost();
    const tables = new Map<string, unknown>();
    (m.host.fs as { lookup?: unknown }).lookup = (collection: string, key: string, value?: unknown) => {
      const k = collection + "|" + String(key).toLowerCase();
      if (value === undefined) return tables.get(k) ?? null;
      tables.set(k, value);
      return value;
    };
    (m.host as { zip: unknown }).zip = { entries: () => entries, list: () => 1 };
    const importId = "0b6a3c1e-7d2f-4a51-9c8e-2f1d3b4a5c6d";
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x", importId } }, m);
    const chatId = (r.json.chats as string[])[0];
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8"));
    expect(meta.characterId).toBe("aria");
  }, 30_000);
});

describe("rp studio: a transcript too big to hand over whole", () => {
  it("reads it a slice at a time and writes it as it goes", async () => {
    fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "aria", "card.json"), JSON.stringify({ name: "Aria Vale" }));
    const name = "chats/Aria Vale/Aria Vale - 2024-07-12@01h31m37s123ms.jsonl";
    const lines = [JSON.stringify({ user_name: "You", character_name: "Aria Vale", create_date: "2024-07-12@01h31m37s123ms" })];
    for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ name: i % 2 ? "You" : "Aria Vale", is_user: i % 2 === 1, mes: "line " + i, send_date: "July 12, 2024 1:31am" }));
    const text = lines.join("\n") + "\n";
    const m = mockHost();
    const fsx = m.host.fs as Record<string, unknown>;
    fsx.append = (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.resolve(root, rel)), { recursive: true }); fs.appendFileSync(path.resolve(root, rel), content); };
    let reads = 0;
    (m.host as { zip: unknown }).zip = {
      entries: () => ({ [name]: { __large__: true, size: text.length } }),
      list: () => 1,
      // slices of about 2 KB, cut after a newline
      read: (entry: string, offset = 0) => {
        expect(entry).toBe(name);
        reads++;
        const end = offset + 2048 >= text.length ? text.length : text.lastIndexOf("\n", offset + 2048) + 1;
        return { text: text.slice(offset, end), next: end >= text.length ? null : end };
      },
    };
    const r = await drive(stUrl, { method: "POST", path: "/import/zip", body: { zipBase64: "x" } }, m);
    expect(r.json.errors).toEqual([]);
    const chatId = (r.json.chats as string[])[0];
    const saved = fs.readFileSync(path.join(root, "chats", `${chatId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(saved.map((msg) => msg.text)).toEqual(Array.from({ length: 500 }, (_, i) => "line " + i));
    expect(reads).toBeGreaterThan(5);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8"));
    expect(meta.characterId).toBe("aria");
    expect(meta.listing).toEqual({ messageCount: 500, preview: "line 499", hasUser: true });
  }, 30_000);
});

describe("rp studio: a transcript that cannot be read", () => {
  it("fails the request instead of treating the chat as empty", async () => {
    const { loadChat } = await import("../plugins/engine/src/chat-files.js");
    const files: Record<string, string> = { "chats/c.meta.json": JSON.stringify({ id: "c", title: "C" }) };
    let failing = true;
    const fsx = {
      read: (rel: string) => {
        if (rel === "chats/c.jsonl" && failing) throw new Error("out of memory");
        if (rel in files) return files[rel];
        throw new Error("ENOENT: no such file or directory (" + rel + ")");
      },
      list: () => [],
    };
    expect(() => loadChat(fsx, "c")).toThrow("out of memory");
    failing = false;
    files["chats/c.jsonl"] = '{"id":"a","text":"kept"}\n{"id":"b","te\n{"id":"c","text":"also kept"}\n';
    expect(loadChat(fsx, "c")?.msgs.map((msg: { id: string }) => msg.id)).toEqual(["a", "c"]);
    delete files["chats/c.jsonl"];
    expect(loadChat(fsx, "c")?.msgs).toEqual([]);
  });
});

/** fs.query as the engine answers it, for the cards under characters/. */
function cardQuery(spec: { files: string; fields: Record<string, string> }) {
  const pick = (value: unknown, dotted: string) => {
    const exists = dotted.endsWith("?");
    let at: unknown = value;
    for (const key of (exists ? dotted.slice(0, -1) : dotted).split(".")) {
      if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return exists ? false : null;
      at = (at as Record<string, unknown>)[key];
    }
    return exists ? at != null : at ?? null;
  };
  expect(spec.files).toBe("characters/*/card.json");
  const rows = fs.readdirSync(path.join(root, "characters")).filter((id) => fs.existsSync(path.join(root, "characters", id, "card.json"))).map((id) => {
    const card = JSON.parse(fs.readFileSync(path.join(root, "characters", id, "card.json"), "utf8"));
    return { path: `characters/${id}/card.json`, keys: [id], data: Object.fromEntries(Object.entries(spec.fields).map(([k, d]) => [k, pick(card, d)])) };
  });
  return { rows, total: rows.length };
}

describe("rp studio: the library leaves embedded lorebooks on disk", () => {
  it("lists the shown fields only, and a save or a copy keeps the rest of the card", async () => {
    const book = { name: "Lore", entries: Array.from({ length: 50 }, (_, i) => ({ keys: ["k" + i], content: "x".repeat(2000) })) };
    fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
    fs.mkdirSync(path.join(root, "characters", "kael"), { recursive: true });
    fs.writeFileSync(path.join(root, "characters", "aria", "card.json"), JSON.stringify({ spec: "chara_card_v3", name: "Aria", description: "d", nickname: "Ari", character_book: book, studio: { favorite: true } }));
    fs.writeFileSync(path.join(root, "characters", "kael", "card.json"), JSON.stringify({ name: "Kael", description: "k" }));
    const m = mockHost();
    (m.host.fs as { query?: unknown }).query = cardQuery;
    const list = await drive(engineUrl, { method: "GET", path: "/characters" }, m);
    const [aria, kael] = list.json.characters as Record<string, unknown>[];
    expect(aria).toMatchObject({ id: "aria", name: "Aria", description: "d", version: "chara_card_v3", studio: { favorite: true }, character_book: { __omitted: true }, __stored: "aria" });
    expect(aria!.nickname).toBeUndefined();
    expect(kael!.character_book).toBeUndefined();
    expect(JSON.stringify(list.json).length).toBeLessThan(2000);

    // the client saves the whole card it holds, stand-in included
    expect((await drive(engineUrl, { method: "PUT", path: "/characters/aria", body: { ...aria, description: "edited" } }, m)).status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "characters", "aria", "card.json"), "utf8"));
    expect(saved).toMatchObject({ description: "edited", nickname: "Ari", character_book: book });
    expect(saved.__stored).toBeUndefined();
    // a copy under a new id starts from the card it came from
    await drive(engineUrl, { method: "PUT", path: "/characters/aria-copy", body: { ...aria, name: "Aria (copy)" } }, m);
    expect(JSON.parse(fs.readFileSync(path.join(root, "characters", "aria-copy", "card.json"), "utf8"))).toMatchObject({ name: "Aria (copy)", nickname: "Ari", character_book: book });
    // an engine without the index still lists whole cards
    delete (m.host.fs as { query?: unknown }).query;
    const whole = await drive(engineUrl, { method: "GET", path: "/characters" }, m);
    expect((whole.json.characters as Record<string, unknown>[])[0]!.character_book).toEqual(book);
  }, 30_000);
});

/** fs.lines / fs.spliceLines as the engine answers them, counting how many
 *  records the plugin read. */
function withRecords(m: ReturnType<typeof mockHost>) {
  const seen = { records: 0 };
  const file = (rel: string) => path.join(root, rel);
  const records = (rel: string) => {
    try { return fs.readFileSync(file(rel), "utf8").split("\n").filter((l) => l.trim()).map((l) => l.replace(/\r$/, "")); } catch { return null; }
  };
  const version = (rel: string) => { try { return String(Bun.hash(fs.readFileSync(file(rel)))); } catch { return null; } };
  Object.assign(m.host.fs as object, {
    lines: (rel: string, from = 0, to?: number) => {
      const all = records(rel);
      if (!all) return { lines: [], from: 0, total: 0, version: null };
      const clamp = (n: number) => Math.max(0, Math.min(all.length, n < 0 ? all.length + n : n));
      const a = clamp(from), b = Math.max(a, to == null ? all.length : clamp(to));
      seen.records += b - a;
      return { lines: all.slice(a, b), from: a, total: all.length, version: version(rel) };
    },
    spliceLines: (rel: string, from: number, lines: string[]) => {
      const all = records(rel) ?? [];
      if (from < 0 || from > all.length) throw new Error("from out of range");
      fs.writeFileSync(file(rel), all.slice(0, from).concat(lines).map((l) => l + "\n").join(""));
      return { total: from + lines.length, version: version(rel) };
    },
  });
  return seen;
}

describe("rp studio: long transcripts are read and written from the end", () => {
  const seed = (count: number) => {
    const id = "long";
    const msgs = Array.from({ length: count }, (_, i) => ({ id: "m" + i, name: i % 2 ? "Aria" : "You", charId: i % 2 ? "aria" : null, role: i % 2 ? "char" : "user", text: "line " + i, at: i, swipes: ["line " + i], swipe: 0 }));
    fs.writeFileSync(path.join(root, "chats", id + ".meta.json"), JSON.stringify({ id, characterId: "aria", title: "Long", userName: "You", createdAt: 1, tainted: true }));
    fs.writeFileSync(path.join(root, "chats", id + ".jsonl"), msgs.map((x) => JSON.stringify(x)).join("\n") + "\n");
    return id;
  };
  const transcript = (id: string) => fs.readFileSync(path.join(root, "chats", id + ".jsonl"), "utf8");

  it("edits near the end without reading the rest, and a client catches up from its version", async () => {
    const id = seed(3000);
    const m = mockHost();
    const seen = withRecords(m);
    const opened = await drive(engineUrl, { method: "GET", path: `/chats/${id}` }, m);
    expect((opened.json.messages as EngineMessage[]).length).toBe(3000);
    const v0 = opened.json.version as string;
    expect(v0).toBeTruthy();

    const before = transcript(id);
    seen.records = 0;
    expect((await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/m2998`, body: { text: "edited" } }, m)).status).toBe(200);
    expect(seen.records).toBeLessThan(1000);
    const after = transcript(id);
    const cut = before.indexOf('{"id":"m2998"');
    expect(after.slice(0, cut)).toBe(before.slice(0, cut));
    expect(JSON.parse(after.trim().split("\n")[2998]!).text).toBe("edited");

    seen.records = 0;
    const caught = await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=${encodeURIComponent(v0)}` }, m);
    expect(seen.records).toBeLessThan(1000);
    expect(caught.json).toMatchObject({ from: 2998, total: 3000, beforeId: "m2997" });
    expect((caught.json.messages as EngineMessage[]).map((x) => x.text)).toEqual(["edited", "line 2999"]);
    const v1 = caught.json.version as string;
    expect((await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=${encodeURIComponent(v1)}` }, m)).json).toMatchObject({ from: 3000, messages: [] });
    // a version the log never saw: the whole chat
    expect((await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=nope` }, m)).json.from).toBeUndefined();

    // the agent rewrites an early message in the file: every older version reads everything
    fs.writeFileSync(path.join(root, "chats", id + ".jsonl"), after.replace('"text":"line 5"', '"text":"agent edit"'));
    const external = await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=${encodeURIComponent(v1)}` }, m);
    expect(external.json.from).toBeUndefined();
    expect((external.json.messages as EngineMessage[])[5]!.text).toBe("agent edit");
    // a save after it says so too: a client still on v1 must not merge past the agent's change
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/m2999`, body: { text: "after the agent" } }, m);
    const merged = await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=${encodeURIComponent(v1)}` }, m);
    expect(merged.json.from).toBe(0);
    expect((merged.json.messages as EngineMessage[])[5]!.text).toBe("agent edit");
  }, 30_000);

  it("send appends without rewriting history, and older engines keep the plain path", async () => {
    const id = seed(1200);
    const m = mockHost();
    withRecords(m);
    const before = transcript(id);
    const r = await drive(engineUrl, { method: "POST", path: `/chats/${id}/send`, body: { text: "Hello again.", model: "mock/model" } }, m);
    expect((r.json.reply as { text: string }).text).toBe("MOCK-REPLY");
    const after = transcript(id);
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(1202);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", id + ".meta.json"), "utf8"));
    expect(meta.listing).toMatchObject({ messageCount: 1202, preview: "MOCK-REPLY" });
    expect(meta.transcriptLog.at(-1)[1]).toBe(1200);

    const plain = mockHost();
    const old = await drive(engineUrl, { method: "GET", path: `/chats/${id}?since=x` }, plain);
    expect(old.json.from).toBeUndefined();
    expect((old.json.messages as EngineMessage[]).length).toBe(1202);
    await drive(engineUrl, { method: "PATCH", path: `/chats/${id}/messages/m0`, body: { text: "first, edited" } }, plain);
    expect(JSON.parse(transcript(id).split("\n")[0]!).text).toBe("first, edited");
  }, 30_000);

  it("a torn line far back costs that line, and the next save repairs the file", async () => {
    const id = seed(1000);
    const lines = transcript(id).split("\n");
    lines[10] = '{"id":"m10","text":"torn';
    fs.writeFileSync(path.join(root, "chats", id + ".jsonl"), lines.join("\n"));
    const m = mockHost();
    withRecords(m);
    // deleting an early message reaches the torn line
    expect((await drive(engineUrl, { method: "DELETE", path: `/chats/${id}/messages/m3` }, m)).status).toBe(200);
    const kept = transcript(id).trim().split("\n").map((l) => JSON.parse(l).id);
    expect(kept).toHaveLength(998);
    expect(kept.includes("m3") || kept.includes("m10")).toBe(false);
    expect(kept.at(-1)).toBe("m999");
  }, 30_000);
});

describe("rp studio: archive organization and chat images", () => {
  const importId = "ae754fe4-7c3d-4a10-a973-f27a30b15a26";
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const setup = () => {
    const m = mockHost();
    const values = new Map<string, unknown>();
    Object.assign(m.host.fs, { lookup: (collection: string, key: string, value?: unknown) => {
      const k = collection + ":" + key;
      if (value !== undefined) values.set(k, value);
      return values.get(k) ?? null;
    } });
    const batch = (entries: Record<string, unknown>, include?: string[]) => {
      (m.host as { zip: unknown }).zip = {
        entries: () => entries, list: () => Object.keys(entries).length,
        image: () => ({ url: "/v1/apps/roleplay/__media/photo.png" }),
      };
      return drive(stUrl, { method: "POST", path: "/import/zip", body: { importId, ...(include ? { include } : {}) } }, m);
    };
    return { m, batch };
  };
  const settings = {
    tags: [{ id: "folder", name: "Adventures", color: "#123456", color2: "#ffffff", folder_type: "CLOSED" }, { id: 2, name: "Personal" }],
    tag_map: { "different-file.json": ["folder", 2, "missing"] },
    world_info: { globalSelect: ["Shared"], charLore: [{ name: "different-file", extraBooks: ["Extra", "Missing", "Extra"] }] },
  };
  it("keeps personal tag folders and both directions of lore links across batches", async () => {
    fs.writeFileSync(path.join(root, "library.json"), JSON.stringify({ tags: [{ id: "existing", name: "Personal", color: "red", asFolder: false }], themes: [{ name: "Keep" }] }));
    const { batch } = setup();
    const cards = await batch({ "wrapper/default-user/characters/different-file.json": JSON.stringify({ name: "Traveler", tags: ["Card tag"], extensions: { world: "Shared" } }) });
    const cid = (cards.json.characters as string[])[0]!;
    const books = await batch({ "worlds/Shared.json": JSON.stringify({ entries: { 0: { key: ["shared"], content: "Shared lore" } } }), "worlds/Extra.json": JSON.stringify({ entries: { 0: { key: ["extra"], content: "Extra lore" } } }) });
    const result = await batch({ "settings.json": JSON.stringify(settings) });
    expect(result.json.errors).toEqual([]);
    const card = read(`characters/${cid}/card.json`);
    expect(card.tags).toEqual(["Card tag", "Adventures", "Personal"]);
    expect(card.studio.linkedLorebookIds).toHaveLength(2);
    const all = (books.json.lorebooks as string[]).map((id) => read(`lorebooks/${id}.json`));
    expect(all.find((b) => b.name === "Shared").globalActive).toBe(true);
    expect(all.find((b) => b.name === "Extra").linkedCharacterIds).toEqual([cid]);
    await batch({ "settings.json": JSON.stringify(settings) });
    const lib = read("library.json");
    expect(lib.tags).toHaveLength(2);
    expect(lib.tags.find((t: { name: string }) => t.name === "Adventures")).toMatchObject({ asFolder: true, color: "#123456", textColor: "#ffffff" });
    expect(lib.tags.find((t: { name: string }) => t.name === "Personal").id).toBe("existing");
    expect(lib.themes).toEqual([{ name: "Keep" }]);
    expect(read(`characters/${cid}/card.json`).studio.linkedLorebookIds).toHaveLength(2);
  });
  for (const value of ["Shared", ["Shared"]]) it("accepts older global book selections: " + JSON.stringify(value), async () => {
    const { batch } = setup();
    const books = await batch({ "worlds/Shared.json": JSON.stringify({ entries: { 0: { key: ["shared"], content: "Lore" } } }) });
    await batch({ "settings.json": JSON.stringify({ world_info: value }) });
    expect(read(`lorebooks/${(books.json.lorebooks as string[])[0]}.json`).globalActive).toBe(true);
  });
  it("does not change character organization or lore when those collections are excluded", async () => {
    const { batch } = setup();
    const result = await batch({ "settings.json": JSON.stringify(settings) }, ["settings.json", "chats/"]);
    expect(result.json.errors).toEqual([]);
    expect(fs.existsSync(path.join(root, "library.json"))).toBe(false);
    expect(read("characters/aria/card.json").tags).toBeUndefined();
  });
  it("resolves old and current chat image records from an earlier image batch", async () => {
    const { batch } = setup();
    expect((await batch({ "install/data/default-user/user/images/Traveler/photo.png": { __image__: true } })).json.errors).toEqual([]);
    const lines = [
      { character_name: "Aria" },
      { name: "Aria", mes: "Old picture", extra: { image: "/user/images/Traveler/photo.png", title: "A view" } },
      { name: "You", is_user: true, mes: "New pictures", extra: { media: [{ type: "image", url: "/user/images/Traveler/photo.png?x=1", title: "Photo" }, { type: "image", url: "https://example.com/photo.png" }, { type: "video", url: "/user/images/Traveler/photo.png" }] } },
    ];
    const result = await batch({ "chats/Aria/test.jsonl": lines.map((l) => JSON.stringify(l)).join("\n") });
    expect(result.json.errors).toEqual([]);
    const id = (result.json.chats as string[])[0]!;
    const messages = fs.readFileSync(path.join(root, `chats/${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(messages[0].attachments).toEqual([expect.objectContaining({ name: "A view", type: "image/png", url: "/v1/apps/roleplay/__media/photo.png" })]);
    expect(messages[1].attachments).toHaveLength(1);
    expect(messages[1].attachments[0].name).toBe("Photo");
  });
});
