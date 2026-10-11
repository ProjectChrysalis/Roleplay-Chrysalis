/**
 * Macro language: document-order evaluation, conditionals, variable
 * shorthand, block forms, shared variables and the value macros. Driven
 * through the engine plugin: a preset section carries the text under test
 * and the prompt preview (or a real send) returns what the model would read.
 */
import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const engineUrl = new URL("../plugins/engine/plugin.js", import.meta.url).href;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rpmacro-"));
  for (const d of ["characters", "personas", "presets", "regex", "groups", "lorebooks", "chats"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.mkdirSync(path.join(root, "characters", "aria"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "characters", "aria", "card.json"),
    JSON.stringify({
      spec: "chara_card_v2", name: "Aria",
      description: "A barista.", personality: "dry", scenario: "",
      first_mes: "Welcome in.", mes_example: "<START>\nAria: Hm.", creator_notes: "notes here", character_version: "2.1",
    }),
  );
  fs.writeFileSync(path.join(root, "personas", "you.json"), JSON.stringify({ id: "you", name: "You", description: "" }));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ model: null, personaId: "you" }));
  preset(["placeholder"]);
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* watcher races */ }
});

/** Write the default preset with one system section per text, in order. */
function preset(sections: string[]) {
  const prompts = sections.map((content, i) => ({ identifier: `s${i}`, name: `S${i}`, role: "system", content, system_prompt: false, marker: false }));
  fs.writeFileSync(
    path.join(root, "presets", "default.json"),
    JSON.stringify({
      id: "default", name: "Default", temperature: 0.8, top_p: 0.95, openai_max_tokens: 512, openai_max_context: 8192,
      prompts: [...prompts, { identifier: "chatHistory", name: "Chat History", marker: true, system_prompt: true }],
      prompt_order: [{ character_id: 100001, order: [...prompts.map((p) => ({ identifier: p.identifier, enabled: true })), { identifier: "chatHistory", enabled: true }] }],
    }),
  );
}

function mockHost() {
  const results: Record<string, unknown> = {};
  const requests: { key: string; req: Record<string, unknown> }[] = [];
  const resolve = () => {
    for (const { key } of requests) {
      results[key] = { text: "MOCK-REPLY", model: "mock/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 } };
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
    store: { get: () => null, put: () => {}, delete: () => {}, keys: () => [] },
    llm: {
      request: (key: string, req: Record<string, unknown>) => { requests.push({ key, req }); },
      results,
      embed: () => {},
      embedResults: {},
    },
    net: { request: () => {}, results: {} },
    zip: { entries: () => { throw new Error("no zip"); }, list: () => 0 },
    log: () => {},
  };
  return { host, requests, resolve };
}

async function drive(req: { method: string; path: string; body?: unknown }, mock: ReturnType<typeof mockHost>) {
  const mod = (await import(engineUrl)) as { handleRoute: Function };
  const results = mock.host.llm.results as Record<string, unknown>;
  for (const k of Object.keys(results)) delete results[k];
  const call = { method: req.method, path: req.path, query: {}, body: req.body };
  let out = mod.handleRoute(call, mock.host) as { status?: number; json?: Record<string, unknown>; __llmPending?: boolean; stash?: Record<string, unknown> };
  for (let pass = 0; out && out.__llmPending && pass < 3; pass++) {
    if (out.stash && typeof out.stash === "object") (call as { stash?: unknown }).stash = out.stash;
    mock.resolve();
    out = mod.handleRoute(call, mock.host) as typeof out;
  }
  return { status: out?.status ?? 200, json: (out?.json ?? {}) as Record<string, unknown> };
}

let chatId = "";
async function newChat(m = mockHost()) {
  const chat = await drive({ method: "POST", path: "/chats", body: { characterId: "aria" } }, m);
  chatId = (chat.json.meta as { id: string }).id;
  return chatId;
}
/** What the model would read for these preset sections, one string per section that produced text. */
async function peek(sections: string[]): Promise<string[]> {
  preset(sections);
  const m = mockHost();
  if (!chatId || !fs.existsSync(path.join(root, "chats", `${chatId}.meta.json`))) await newChat(m);
  const r = await drive({ method: "POST", path: "/prompt/preview", body: { chatId } }, m);
  return (r.json.messages as { role: string; content: string }[]).filter((x) => x.role === "system").map((x) => x.content);
}
const one = async (text: string) => (await peek([text])).join("\n");

describe("macros: document order and conditionals", () => {
  it("evaluates in order: a variable set earlier is visible later, not before", async () => {
    expect(await one("[{{getvar::a}}]{{setvar::a::1}}[{{getvar::a}}]")).toBe("[][1]");
  });

  it("if / else pick one branch and only that branch runs", async () => {
    expect(await one("{{setvar::on::yes}}{{if {{getvar::on}}}}A{{setvar::ran::then}}{{else}}B{{setvar::ran::else}}{{/if}}|{{getvar::ran}}")).toBe("A|then");
    expect(await one("{{if {{getvar::missing}}}}A{{setvar::ran2::then}}{{else}}B{{/if}}|{{getvar::ran2}}")).toBe("B|");
  });

  it("empty, 0, false and off are false; ! negates", async () => {
    for (const v of ["", "0", "false", "OFF"]) {
      expect(await one(`{{setvar::v::${v}}}{{if .v}}yes{{else}}no{{/if}}`)).toBe("no");
    }
    expect(await one("{{setvar::v::on}}{{if .v}}yes{{else}}no{{/if}}")).toBe("yes");
    expect(await one("{{if !.nothing}}unset{{/if}}")).toBe("unset");
    expect(await one("{{setvar::v::on}}x{{if !{{getvar::v}}}}hidden{{/if}}y")).toBe("xy");
  });

  it("nested blocks find their own else", async () => {
    const t = "{{.a = 1}}{{.b = 0}}{{if .a}}outer{{if .b}} inner{{else}} other{{/if}}{{else}}never{{/if}}";
    expect(await one(t)).toBe("outerother");
    expect(await one("{{#if .a2}}x{{else}}{{#if .b2}}y{{else}} z {{/if}}{{/if}}")).toBe(" z ");
  });

  it("a block is trimmed and dedented unless # keeps its whitespace", async () => {
    expect(await one("{{.a = 1}}start\n{{if .a}}\n    # Title\n      body\n{{/if}}\nend")).toBe("start\n# Title\n  body\nend");
    expect(await one("{{.a = 1}}[{{#if .a}} kept {{/if}}]")).toBe("[ kept ]");
  });

  it("a bare macro name is a condition; the one-line form works", async () => {
    expect(await one("{{if description}}has{{else}}none{{/if}} {{if scenario}}has{{else}}none{{/if}}")).toBe("has none");
    expect(await one("{{if::{{user}}::hello {{user}}}}")).toBe("hello You");
  });

  it("leaves no conditional tags behind, and broken ones stay visible", async () => {
    const out = await one("{{.pov = first}}{{#if {{.pov == first}}}}I{{else}}They{{/if}} walk. {{if {{.pov != first}}}}x{{/if}}");
    expect(out).toBe("I walk. ");
    // no closer: nothing to pair, so the text is left as written
    expect(await one("a {{if .x}} b")).toBe("a {{if .x}} b");
    expect(await one("a {{/if}} b")).toBe("a {{/if}} b");
  });
});

describe("macros: variable shorthand", () => {
  it("reads, assigns and compares", async () => {
    expect(await one("{{.mood = tense}}{{.mood}}|{{.mood == tense}}|{{.mood == calm}}|{{.mood != calm}}")).toBe("tense|true|false|true");
    // quotes are part of the value on both sides
    expect(await one('{{setvar::scope::"1"}}{{.scope == "1"}}|{{.scope == 1}}')).toBe("true|false");
  });

  it("counts and compares numbers", async () => {
    expect(await one("{{.n = 2}}{{.n++}},{{.n += 5}}{{.n}},{{.n -= 3}}{{.n}},{{.n--}}")).toBe("3,8,5,4");
    expect(await one("{{.n = 4}}{{.n > 3}}{{.n >= 4}}{{.n < 4}}{{.n <= {{.n}}}}{{.n > abc}}")).toBe("truetruefalsetruefalse");
  });

  it("defaults: || on falsy, ?? on missing, and the assigning forms", async () => {
    expect(await one("{{.a = 0}}{{.a || fallback}}|{{.a ?? fallback}}|{{.none ?? fallback}}")).toBe("fallback|0|fallback");
    expect(await one("{{.b ??= first}}{{.b ??= second}}|{{.b}}|{{.c = off}}{{.c ||= on}}|{{.c}}")).toBe("firstfirst|first|on|on");
  });

  it("works as a condition, with or without a comparison", async () => {
    expect(await one("{{.pov = first}}{{if .pov == first}}I{{else}}They{{/if}}{{if .pov == third}}!{{/if}}")).toBe("I");
  });

  it("text append and the long spellings agree", async () => {
    expect(await one("{{addvar::log::- a}}{{addvar::log::, b}}{{getvar::log}}|{{incvar count}}{{incvar::count}}|{{decvar::count}}")).toBe("- a, b|12|1");
    expect(await one("{{setvar::x::1}}{{hasvar::x}}{{deletevar::x}}{{hasvar::x}}[{{getvar::x}}]")).toBe("truefalse[]");
  });

  it("a block sets a long value", async () => {
    expect(await one("{{setvar::rules}}\n  Be brief.\n  {{user}} leads.\n{{/setvar}}[{{.rules}}]")).toBe("[Be brief.\nYou leads.]");
  });
});

describe("macros: values", () => {
  it("names, card fields and the group fallback", async () => {
    expect(await one("{{user}}/{{char}}/{{group}}/{{charIfNotGroup}}/<USER>/<BOT>")).toBe("You/Aria/Aria/Aria/You/Aria");
    expect(await one("{{description}}|{{charVersion}}|{{creatorNotes}}|{{mesExamplesRaw}}")).toBe("A barista.|2.1|notes here|<START>\nAria: Hm.");
    expect(await one("{{lastMessageId}}|{{lastGenerationType}}")).toBe("0|normal");
  });

  it("lists, dice and dates", async () => {
    expect(["a", "b"]).toContain(await one("{{random::a::b}}"));
    expect(["a", "b,c"]).toContain(await one("{{random:a,b\\,c}}"));
    const first = await one("{{pick::x::y::z}}");
    expect(await one("{{pick::x::y::z}}")).toBe(first);
    expect(Number(await one("{{roll:1d6}}"))).toBeGreaterThan(0);
    expect(Number(await one("{{roll 2d4+1}}"))).toBeGreaterThan(2);
    expect(await one("{{datetimeformat DD.MM.YYYY HH:mm}}")).toMatch(/^\d\d\.\d\d\.\d{4} \d\d:\d\d$/);
    expect(await one("{{datetimeformat [at] YYYY}}")).toMatch(/^at \d{4}$/);
    expect(await one("{{time_UTC+2}}")).toMatch(/^\d{1,2}:\d\d [AP]M$/);
  });

  it("comments vanish, trim eats its newlines, escapes give literal braces", async () => {
    expect(await one("a{{// note with {{user}} inside}}b")).toBe("ab");
    expect(await one("a{{//}}\nhidden {{setvar::leak::1}}\n{{///}}b[{{.leak}}]")).toBe("ab[]");
    expect(await one("a\n\n{{trim}}\n\nb")).toBe("ab");
    expect(await one("{{trim}}\n  padded  \n{{/trim}}!")).toBe("padded!");
    expect(await one("\\{\\{user\\}\\} is {{user}}")).toBe("{{user}} is You");
  });

  it("a variable call missing its name or value is left as written", async () => {
    expect(await one("{{setvar::typo:value}} {{getvar}} {{setvar::ok::}}[{{getvar::ok}}]")).toBe("{{setvar::typo:value}} {{getvar}} []");
  });

  it("the preset's token limits are readable", async () => {
    expect(await one("{{maxContext}}/{{maxResponseTokens}}")).toBe("8192/512");
  });

  it("an unknown macro stays as written but its arguments expand", async () => {
    expect(await one("{{outlet::{{char}}}} {{mystery}} {{ #each }} {{user's}}")).toBe("{{outlet::Aria}} {{mystery}} {{ #each }} {{user's}}");
    expect(await one("unclosed {{user and {{char}}")).toBe("unclosed {{user and Aria");
  });
});

describe("macros: across sections and turns", () => {
  it("a toggle section drives a later section", async () => {
    const out = await peek(["{{.pick_pov = second_person}}{{trim}}", "{{if {{.pick_pov == second_person}}}}Write as you.{{else}}Write as they.{{/if}}"]);
    expect(out.join("|")).toBe("Write as you.");
  });

  it("chat variables persist when the turn commits; a peek changes nothing", async () => {
    const m = mockHost();
    await newChat(m);
    preset(["{{incvar::turns}}{{$seen ||= once}}{{$total++}}turn {{.turns}}"]);
    await drive({ method: "POST", path: "/prompt/preview", body: { chatId } }, m);
    expect(fs.existsSync(path.join(root, "variables.json"))).toBe(false);
    await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text: "hi", model: "mock/model" } }, m);
    await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text: "again", model: "mock/model" } }, m);
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8")) as { chatVars: Record<string, string> };
    expect(meta.chatVars.turns).toBe("2");
    expect(JSON.parse(fs.readFileSync(path.join(root, "variables.json"), "utf8"))).toEqual({ seen: "once", total: "2" });
  });

  it("shared variables reach another chat; deleting one sticks", async () => {
    fs.writeFileSync(path.join(root, "variables.json"), JSON.stringify({ world: "Eldoria", old: "x" }));
    expect(await one("{{getglobalvar::world}}/{{$world}}/{{hasglobalvar::old}}")).toBe("Eldoria/Eldoria/true");
    const m = mockHost();
    preset(["{{deleteglobalvar::old}}{{setvar::tmp::1}}{{deletevar::tmp}}{{setvar::kept::1}}ok"]);
    await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text: "hi", model: "mock/model" } }, m);
    expect(JSON.parse(fs.readFileSync(path.join(root, "variables.json"), "utf8"))).toEqual({ world: "Eldoria" });
    const meta = JSON.parse(fs.readFileSync(path.join(root, "chats", `${chatId}.meta.json`), "utf8")) as { chatVars: Record<string, string> };
    expect(meta.chatVars).toEqual({ kept: "1" });
  });

  it("a backup carries the shared variables", async () => {
    const m = mockHost();
    expect(((await drive({ method: "GET", path: "/export/backup" }, m)).json.base64 as string).length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(root, "variables.json"), JSON.stringify({ world: "Eldoria" }));
    const zip = Buffer.from((await drive({ method: "GET", path: "/export/backup" }, m)).json.base64 as string, "base64").toString("latin1");
    expect(zip).toContain("variables.json");
  });

  it("the model macro names the model that answers", async () => {
    const m = mockHost();
    await newChat(m);
    preset(["model={{model}}"]);
    await drive({ method: "POST", path: `/chats/${chatId}/send`, body: { text: "hi", model: "mock/model" } }, m);
    const req = m.requests[0]!.req as { messages: { role: string; content: string }[] };
    expect(req.messages.some((x) => x.content === "model=mock/model")).toBe(true);
  });
});
