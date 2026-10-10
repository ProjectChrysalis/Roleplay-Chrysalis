import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function inspectPreset(preset) {
  const prompts = preset.prompts ?? [];
  const layouts = preset.prompt_order ?? [];
  const active = layouts.find((layout) => String(layout.character_id) === "100001" && layout.order?.length) ?? layouts.find((layout) => layout.order?.length);
  return prompts.map((prompt) => {
    const entry = active?.order.find((item) => item.identifier === prompt.identifier);
    const section = preset.studio?.sections?.find((item) => item.id === prompt.identifier);
    return { identifier: prompt.identifier, name: prompt.name, role: prompt.role,
      content: prompt.content, editorContent: section?.content,
      enabled: active ? Boolean(entry?.enabled) : true, editorEnabled: section?.enabled,
      position: active ? active.order.findIndex((item) => item.identifier === prompt.identifier) : prompts.indexOf(prompt),
      layout: active?.character_id ?? null };
  });
}

export function editSection(file, identifier, patch) {
  const before = fs.readFileSync(file, "utf8");
  const preset = JSON.parse(before);
  if (preset.studio?.readOnly) throw new Error("Preset is locked. Create an editable copy.");
  if (!patch || Array.isArray(patch) || typeof patch !== "object" || !Object.keys(patch).length || Object.keys(patch).some((key) => !["content", "enabled"].includes(key))) throw new Error("Patch accepts content and enabled only");
  if (patch.content !== undefined && typeof patch.content !== "string") throw new Error("Content must be text");
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("Enabled must be boolean");
  const prompts = preset.prompts?.filter((item) => item.identifier === identifier) ?? [];
  const sections = preset.studio?.sections?.filter((item) => item.id === identifier) ?? [];
  if (prompts.length !== 1 || sections.length !== 1) throw new Error("Expected one portable prompt and one editor section");
  const layouts = preset.prompt_order ?? [];
  const active = layouts.find((layout) => String(layout.character_id) === "100001" && layout.order?.length) ?? layouts.find((layout) => layout.order?.length);
  const entries = active?.order.filter((item) => item.identifier === identifier) ?? [];
  if (patch.enabled !== undefined && entries.length !== 1) throw new Error("Enabled edits need one active order entry");
  if (patch.content !== undefined) prompts[0].content = sections[0].content = patch.content;
  if (patch.enabled !== undefined) entries[0].enabled = sections[0].enabled = patch.enabled;
  if (fs.readFileSync(file, "utf8") !== before) throw new Error("Preset changed during editing. Read it again.");
  const temp = path.join(path.dirname(file), `_${path.basename(file)}.${process.pid}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(preset, null, 2) + "\n", { flag: "wx" }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
  return inspectPreset(JSON.parse(fs.readFileSync(file, "utf8"))).find((section) => section.identifier === identifier);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [file, identifier, patch] = process.argv.slice(2);
  if (!file) throw new Error("Usage: preset.mjs <preset-file> [identifier] [JSON patch]");
  const sections = patch ? editSection(file, identifier, JSON.parse(patch)) : inspectPreset(JSON.parse(fs.readFileSync(file, "utf8")));
  const result = Array.isArray(sections) && identifier ? sections.find((section) => section.identifier === identifier) : sections;
  if (!result) throw new Error("Section identifier not found");
  console.log(JSON.stringify(result, null, 2));
}
