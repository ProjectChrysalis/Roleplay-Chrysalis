/** The regex worker is a string executed in a Worker, so ordinary imports
 *  cannot typecheck it. This runs it in a vm with a fake `self` and asserts
 *  the substitution semantics the message renderer documents: {{match}},
 *  $n/$<name>, trim strings and {{user}}/{{char}} macros. */
import { describe, it, expect } from "bun:test";
import vm from "node:vm";
import { isBadPattern, runRegexSafe, WORKER_SRC } from "../src/lib/safe-regex.js";

interface Job {
  find: string;
  flags?: string;
  replace?: string;
  trims?: string[];
  macros?: Record<string, string>;
  input: string;
}

function runJob(job: Job) {
  const messages: Array<{ ok: boolean; output?: string; error?: string }> = [];
  const self = {
    postMessage: (m: { ok: boolean; output?: string; error?: string }) => { messages.push(m); },
    onmessage: null as null | ((e: { data: Record<string, unknown> }) => void),
  };
  const ctx = vm.createContext({ self });
  vm.runInContext(WORKER_SRC, ctx);
  self.onmessage?.({ data: { id: 1, flags: "g", replace: "", trims: [], ...job } });
  const first = messages[0];
  if (!first) throw new Error("worker produced no result");
  return first;
}

describe("regex worker semantics", () => {
  it("honors first-match, global, and sticky flags", () => {
    expect(runJob({ find: "a", flags: "", replace: "b", input: "aaa" }).output).toBe("baa");
    expect(runJob({ find: "a", flags: "g", replace: "b", input: "aaa" }).output).toBe("bbb");
    expect(runJob({ find: "a", flags: "y", replace: "b", input: "aaa" }).output).toBe("baa");
    expect(runJob({ find: "a", flags: "gy", replace: "b", input: "aa aa" }).output).toBe("bb aa");
  });
  it("substitutes captures, named groups, {{match}} and trim strings", () => {
    expect(runJob({ find: "a(b)", replace: "[$1]", input: "xaby" }).output).toBe("x[b]y");
    expect(runJob({ find: "(?<word>\\w+)", replace: "<$<word>>", input: "hi there" }).output).toBe("<hi> <there>");
    expect(runJob({ find: "\\d+", replace: "-{{match}}-", input: "a1b22" }).output).toBe("a-1-b-22-");
    // trims erase from the match and from every substituted capture
    expect(runJob({ find: "(\\d+)", replace: "$1", trims: ["0"], input: "a10b" }).output).toBe("a1b");
  });

  it("substitutes user/char macros in the replacement", () => {
    expect(runJob({ find: "X", replace: "{{char}}", macros: { user: "Alice", char: "Bob" }, input: "X" }).output).toBe("Bob");
    // $& is not a studio token: it stays literal, and macros still apply
    expect(runJob({ find: "X", replace: "$&{{user}}", macros: { user: "Alice", char: "Bob" }, input: "X" }).output).toBe("$&Alice");
  });

  it("advances Unicode empty matches past whole code points", () => {
    expect(runJob({ find: "(?:)", flags: "gu", replace: "|", input: "🙂" }).output).toBe("|🙂|");
  });

  it("survives zero-length matches without hanging", () => {
    const r = runJob({ find: "a*", replace: "_", input: "ba" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("_");
  });
});

/** Stands in for the browser Worker: answers each job after `delay(find)` ms
 *  (null never answers) and records the order jobs arrive in. */
const posted: string[] = [];
let delay: (find: string) => number | null = () => 0;
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  private dead = false;
  postMessage(m: { id: number; find: string; input: string }) {
    posted.push(m.find);
    const ms = delay(m.find);
    if (ms === null) return;
    setTimeout(() => { if (!this.dead) this.onmessage?.({ data: { id: m.id, ok: true, output: m.input.toUpperCase() } }); }, ms);
  }
  terminate() { this.dead = true; }
}
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

describe("regex worker queue", () => {
  it("does not time out a job whose answer waited behind a busy page", async () => {
    delay = () => 60;
    const run = runRegexSafe("busy", "g", "", "abc", { timeoutMs: 50 });
    const until = performance.now() + 200;
    while (performance.now() < until) { /* the page is busy rendering */ }
    const r = await run;
    expect(r.timedOut).toBeUndefined();
    expect(r.output).toBe("ABC");
  });

  it("times out a job that never answers and skips it only on text as long", async () => {
    delay = (find) => (find === "hang" ? null : 0);
    const r = await runRegexSafe("hang", "g", "", "x".repeat(100), { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(isBadPattern("hang", "g", 100)).toBe(true);
    expect(isBadPattern("hang", "g", 500)).toBe(true);
    expect(isBadPattern("hang", "g", 99)).toBe(false);
    expect(isBadPattern("other", "g", 100)).toBe(false);
  });

  it("runs lower priority numbers first", async () => {
    delay = () => 5;
    posted.length = 0;
    const jobs = [
      runRegexSafe("first", "", "", "a"),
      runRegexSafe("old", "", "", "a", { priority: 9 }),
      runRegexSafe("new", "", "", "a", { priority: 0 }),
      runRegexSafe("middle", "", "", "a", { priority: 4 }),
      runRegexSafe("new2", "", "", "a", { priority: 0 }),
    ];
    await Promise.all(jobs);
    expect(posted).toEqual(["first", "new", "new2", "middle", "old"]);
  });
});
