import { afterEach, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error The app ships this helper as a directly executable module.
import { inspectPreset, editSection } from "../.agents/skills/preset-editing/scripts/preset.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const preset = { id: "one", unknown: { preserved: true }, prompts: [{ identifier: "section", name: "Embellishment", role: "system", content: "before", metadata: "keep" }],
    prompt_order: [{ character_id: 12, order: [{ identifier: "section", enabled: false, imported: true }] }, { character_id: 100001, order: [{ identifier: "section", enabled: true, priority: 9 }] }],
    studio: { readOnly: false, sections: [{ id: "section", content: "before", enabled: true, extra: "keep" }] } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-skill-")); dirs.push(dir);
  const file = path.join(dir, "one.json"); fs.writeFileSync(file, JSON.stringify(preset));
  return { file, preset };
}
it("inspects the active nested order without modifying the preset", () => {
  const { file, preset } = fixture();
  const before = fs.readFileSync(file, "utf8");
  expect(inspectPreset(preset)[0]).toMatchObject({ identifier: "section", content: "before", editorContent: "before", enabled: true, editorEnabled: true, position: 0, layout: 100001 });
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
it("updates both copies while preserving inactive layouts and opaque fields", () => {
  const { file, preset } = fixture();
  expect(editSection(file, "section", { content: "", enabled: false })).toMatchObject({ content: "", editorContent: "", enabled: false, editorEnabled: false });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved.unknown).toEqual(preset.unknown);
  expect(saved.prompt_order[0]).toEqual(preset.prompt_order[0]);
  expect(saved.prompt_order[1].order[0].priority).toBe(9);
  expect(saved.prompts[0].metadata).toBe("keep");
  expect(saved.studio.sections[0].extra).toBe("keep");
});
it("refuses locked, duplicate, or missing section mappings without writing", () => {
  for (const kind of ["locked", "duplicate", "missing"]) {
    const { file, preset } = fixture();
    if (kind === "locked") preset.studio.readOnly = true;
    if (kind === "duplicate") preset.prompts.push(preset.prompts[0]!);
    if (kind === "missing") preset.studio.sections = [];
    fs.writeFileSync(file, JSON.stringify(preset)); const before = fs.readFileSync(file, "utf8");
    expect(() => editSection(file, "section", { content: "after" })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
});

// @ts-expect-error The inspector is a portable sandbox module shipped with the skill.
import { inspect } from "../.agents/skills/preset-editing/inspect.js";

it("finds abbreviated names and section names in one read-only inspection, preserving ambiguity", () => {
  const { preset } = fixture();
  preset.prompts[0]!.name = "Embellish Mode";
  const first = { ...preset, name: "Freaky Frankenstein Micro FF5" };
  const second = structuredClone(first); second.id = "two"; second.name += " (copy)";
  second.prompts[0]!.content = "different copy";
  second.studio.sections[0]!.content = "different copy";
  const records: Record<string, string> = { "one.json": JSON.stringify(first), "two.json": JSON.stringify(second), "bad.json": "broken" };
  const before = JSON.stringify(records), reads: string[] = [];
  const host = { fs: { list: (dir: string) => { expect(dir).toBe("presets"); return Object.keys(records); }, read: (file: string) => { reads.push(file); return records[file.slice(8)]!; } } };
  const result = inspect({ preset: "ff micro", section: "embellish" }, host);
  expect(result.ambiguous).toBe(true);
  expect(result.matches.map((item: any) => item.sections[0].content)).toEqual(["before", "different copy"]);
  expect(result.matches[0].sections[0]).toMatchObject({ enabled: true, editorEnabled: true, position: 1, layout: 100001, consistent: { content: true, enabled: true } });
  expect(result.errors).toHaveLength(1);
  expect(reads).toEqual(["presets/one.json", "presets/two.json", "presets/bad.json"]);
  expect(JSON.stringify(records)).toBe(before);
});

it("reports disagreements and provides section names when a requested section is absent", () => {
  const { preset } = fixture();
  const record = { ...preset, name: "Freaky Frankenstein Micro FF5" };
  record.studio.sections[0]!.content = "editor differs";
  record.studio.sections[0]!.enabled = false;
  const host = { fs: { list: () => ["one.json"], read: () => JSON.stringify(record) } };
  expect(inspect({ preset: "one", section: "section" }, host).matches[0].sections[0]).toMatchObject({ content: "before", editorContent: "editor differs", consistent: { content: false, enabled: false } });
  expect(inspect({ preset: "one", section: "absent" }, host).matches[0].availableSections).toEqual([{ identifier: "section", name: "Embellishment" }]);
  expect(inspect({ preset: "missing" }, host).matches).toEqual([]);
  expect(() => inspect({ preset: "" }, host)).toThrow();
});

// @ts-expect-error The app editor is a portable sandbox module shipped with the skill.
import { edit } from "../.agents/skills/preset-editing/edit.js";
import { createHash } from "node:crypto";
function editorHost(record: unknown) {
  const text = JSON.stringify(record), revision = createHash("sha256").update(text).digest("hex");
  return { revision, host: { fs: { list: () => ["one.json"], readVersioned: () => ({ text, revision }), read: () => text } } };
}
it("sandbox editor synchronizes section and sampler copies without dropping metadata", () => {
  const { preset } = fixture(), record = { ...preset, name: "Example", studio: { ...preset.studio, samplers: { temperature: { value: 1, enabled: true }, cache: { enabled: true } }, utilityPrompts: { newChat: "keep" } }, utilityPrompts: { newChat: "keep" } };
  const { revision, host } = editorHost(record);
  const plan = edit({ preset: "one", section: "section", revision, patch: { content: "after", enabled: false }, samplers: { temperature: { value: 0.7, enabled: true } }, utilityPrompts: { continueNudge: "more" } }, host);
  expect(plan.writes[0].expectedRevision).toBe(revision);
  const saved = JSON.parse(plan.writes[0].content);
  expect(saved.prompts[0].content).toBe("after"); expect(saved.studio.sections[0].content).toBe("after"); expect(saved.prompt_order[1].order[0].enabled).toBe(false);
  expect(saved.prompt_order[0]).toEqual(record.prompt_order[0]); expect(saved.unknown).toEqual(record.unknown);
  expect(saved.temperature).toBe(0.7); expect(saved.studio.samplers.temperature.value).toBe(0.7); expect(saved.studio.samplers.cache.enabled).toBe(true);
  expect(saved.utilityPrompts).toEqual(saved.studio.utilityPrompts);
});
it("sandbox editor rejects stale, locked and mismatched mappings and removes disabled sampler values", () => {
  const { preset } = fixture(); let fixtureHost = editorHost(preset);
  expect(() => edit({ preset: "one", section: "section", revision: "stale", patch: { content: "after" } }, fixtureHost.host)).toThrow("revision");
  fixtureHost = editorHost({ ...preset, temperature: 1, studio: { ...preset.studio, samplers: { temperature: { value: 1, enabled: true } } } });
  const plan = edit({ preset: "one", revision: fixtureHost.revision, samplers: { temperature: { enabled: false } } }, fixtureHost.host); const saved = JSON.parse(plan.writes[0].content); expect(saved.temperature).toBeUndefined(); expect(saved.studio.samplers.temperature).toEqual({ value: 1, enabled: false });
  preset.studio.readOnly = true; fixtureHost = editorHost(preset); expect(() => edit({ preset: "one", section: "section", revision: fixtureHost.revision, patch: { content: "after" } }, fixtureHost.host)).toThrow("locked");
});
