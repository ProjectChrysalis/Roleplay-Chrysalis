/**
 * Native RegExp cannot be interrupted: a catastrophic-backtracking pattern
 * (`(a+)+b` against 40 a's) freezes the tab's main thread until the renderer
 * dies — the blank-screen class. User-authored regex therefore runs in a
 * Worker with a hard timeout; a pattern that times out is skipped afterwards
 * on text at least that long, and the wedged worker is thrown away and
 * recreated.
 *
 * Nothing runs a user pattern on the render path. The worker is a single
 * serialized job queue: one pattern at a time, so a timeout blames exactly
 * the pattern that wedged it. Jobs with a lower priority number run first.
 */

export interface SafeRegexResult {
  ok: boolean
  output?: string
  matches?: { start: number; end: number }[]
  error?: string
  timedOut?: boolean
}

// Application (same semantics as the message renderer): global exec loop,
// trim strings, {{match}} and $n/$<name> substitution, macro names, and a
// zero-length guard. Trim strings erase from every substituted value.
// Exported for the worker-semantics test; the engine itself only runs it
// inside the Worker created below.
export const WORKER_SRC = `
self.onmessage = (e) => {
  const { id, find, flags, replace, trims, macros, input } = e.data;
  try {
    const re = new RegExp(find, flags ?? "");
    const trim = (v) => {
      let t = v;
      for (const s of (trims || [])) if (s) t = t.split(s).join("");
      return t;
    };
    const subMacros = (t) => (macros
      ? t.replace(/\\{\\{(user|char)\\}\\}/gi, (_, k) => macros[k.toLowerCase()] || "")
      : t);
    const matches = [];
    let output = "";
    let last = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(input)) !== null && guard++ < 5000) {
      if (m[0].length === 0 && re.global) {
        const pos = re.lastIndex;
        const code = input.codePointAt(pos);
        re.lastIndex += (re.unicode || re.unicodeSets) && code > 0xffff ? 2 : 1;
      }
      matches.push({ start: m.index, end: m.index + m[0].length });
      let repl = String(replace ?? "").replace(/\\{\\{match\\}\\}/gi, "\\u0000");
      repl = repl.replace(/\\$(\\d+)|\\$<([^>]+)>/g, (_, num, name) => {
        const v = num != null ? m[Number(num)] : (m.groups ? m.groups[name] : undefined);
        return v != null && v !== "" ? trim(v) : "";
      });
      repl = subMacros(repl.split("\\u0000").join(trim(m[0])));
      output += input.slice(last, m.index) + repl;
      last = m.index + m[0].length;
      if (!re.global) break;
    }
    output += input.slice(last);
    self.postMessage({ id, ok: true, output, matches });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
`

/** pattern key -> shortest input it timed out on */
const badPatterns = new Map<string, number>()
let workerUrl: string | null = null
let sharedWorker: RegexWorker | null = null
let seq = 0

/** Structural shape of the browser Worker used here. Declared locally because
 *  the engine's TypeScript program compiles this app module too, without the
 *  DOM lib. */
interface RegexWorker {
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  terminate: () => void
  postMessage: (message: unknown) => void
}

function createWorker(): RegexWorker | null {
  try {
    const ctor = (globalThis as { Worker?: new (url: string) => RegexWorker }).Worker
    if (!ctor) return null
    return new ctor(getWorkerUrl())
  } catch {
    return null
  }
}

const key = (find: string, flags: string) => `${find}::${flags}::`

interface PendingJob {
  id: number
  message: Record<string, unknown>
  timeoutMs: number
  priority: number
  resolve: (r: SafeRegexResult) => void
  timer?: ReturnType<typeof setTimeout>
}

const queue: PendingJob[] = []
let active: PendingJob | null = null

function getWorkerUrl(): string {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }))
  return workerUrl
}

function finishActive(result: SafeRegexResult): void {
  const job = active
  if (!job) return
  active = null
  if (job.timer !== undefined) clearTimeout(job.timer)
  job.resolve(result)
  pump()
}

function ensureWorker(): RegexWorker | null {
  if (sharedWorker) return sharedWorker
  const w = createWorker()
  if (!w) return null
  w.onmessage = (ev) => {
    const d = ev.data as ({ id?: number } & SafeRegexResult) | null
    if (!active || d?.id !== active.id) return
    finishActive(d)
  }
  w.onerror = () => {
    // a worker-level failure kills whatever it was running
    try { sharedWorker?.terminate() } catch { /* already gone */ }
    sharedWorker = null
    finishActive({ ok: false, error: "regex worker error" })
  }
  sharedWorker = w
  return w
}

/** A timer that fires well after its deadline means the page itself was
 *  busy (rendering, layout), and the worker's answer may be waiting behind
 *  it. Only a timer that fires on time while the job still runs is a real
 *  timeout. */
const LATE_MS = 50

function arm(job: PendingJob, ms: number): void {
  const due = performance.now() + ms
  job.timer = setTimeout(() => {
    if (active !== job) return
    if (performance.now() - due > LATE_MS) { arm(job, job.timeoutMs); return }
    // only the one in-flight pattern can have wedged the worker
    try { sharedWorker?.terminate() } catch { /* already gone */ }
    sharedWorker = null
    finishActive({ ok: false, timedOut: true, error: `timed out (${job.timeoutMs}ms), likely catastrophic backtracking` })
  }, ms)
}

function pump(): void {
  if (active || queue.length === 0) return
  const job = queue.shift()
  if (!job) return
  const w = ensureWorker()
  if (!w) {
    job.resolve({ ok: false, error: "regex worker unavailable" })
    pump()
    return
  }
  active = job
  arm(job, job.timeoutMs)
  try {
    w.postMessage(job.message)
  } catch {
    try { sharedWorker?.terminate() } catch { /* already gone */ }
    sharedWorker = null
    finishActive({ ok: false, error: "regex worker unavailable" })
  }
}

export function runRegexSafe(
  find: string,
  flags: string,
  replace: string,
  input: string,
  opts: { trims?: string[]; timeoutMs?: number; macros?: Record<string, string>; priority?: number } = {},
): Promise<SafeRegexResult> {
  return new Promise((resolve) => {
    if (!find) { resolve({ ok: true, output: input, matches: [] }); return }
    const id = ++seq
    const priority = opts.priority ?? 0
    const job: PendingJob = {
      id,
      priority,
      timeoutMs: opts.timeoutMs ?? 400,
      message: { id, find, flags: flags || "", replace, trims: opts.trims ?? [], macros: opts.macros, input },
      resolve: (r) => {
        if (r.timedOut) {
          const k = key(find, flags)
          badPatterns.set(k, Math.min(badPatterns.get(k) ?? Infinity, input.length))
        }
        resolve(r)
      },
    }
    const at = queue.findIndex((q) => q.priority > priority)
    if (at < 0) queue.push(job)
    else queue.splice(at, 0, job)
    pump()
  })
}

/** Sync check for render-path decisions: skip a pattern on text at least as
 *  long as text it already timed out on. Slow patterns usually slow down
 *  with length, so shorter text still gets its chance. */
export function isBadPattern(find: string, flags: string, inputLength: number): boolean {
  const shortest = badPatterns.get(key(find, flags))
  return shortest !== undefined && inputLength >= shortest
}
