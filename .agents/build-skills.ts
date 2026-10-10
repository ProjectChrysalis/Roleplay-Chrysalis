import path from "node:path";
const root = import.meta.dir;
for (const entry of new Bun.Glob("skills/*/*.source.js").scanSync({ cwd: root })) {
  const result = await Bun.build({ entrypoints: [path.join(root, entry)], target: "browser", format: "esm", minify: false });
  if (!result.success) throw new AggregateError(result.logs, `Cannot build ${entry}`);
  const output = result.outputs[0];
  if (!output || output.size > 32768) throw new Error(`Skill module exceeds 32 KB: ${entry}`);
  await Bun.write(path.join(root, entry.replace(".source.js", ".js")), output);
}
