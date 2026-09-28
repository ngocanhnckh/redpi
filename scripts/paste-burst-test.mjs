#!/usr/bin/env node
// Multi-line pastes from terminals without bracketed paste must stay one prompt, and a real
// Enter must still submit. Unit checks on lib/paste-burst.ts, then a real Pi TUI in a pty.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createPasteBurstGuard } from "../lib/paste-burst.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- unit: drive the guard like Pi does: each raw read goes to onChunk first, then its key
// sequences go to handle() one by one, then deferred work runs.
function harness() {
  let t = 1000;
  const timers = new Map();
  let id = 0;
  const out = [];
  let deferred = [];
  const guard = createPasteBurstGuard({
    inject: (d) => read(d, true),
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (h) => timers.delete(h),
    defer: (fn) => deferred.push(fn),
  });
  function read(chunk, injected = false) {
    guard.onChunk(chunk);
    const seqs = chunk.startsWith("\x1b") ? [chunk] : [...chunk];
    for (const s of seqs) {
      const r = guard.handle(s);
      if (injected) assert.equal(r, undefined, "reinjected data must pass straight through");
      if (!r?.consume) out.push(s);
    }
    if (!injected) { const d = deferred; deferred = []; d.forEach((fn) => fn()); }
  }
  const advance = (ms) => { t += ms; for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn(); } };
  return { read, advance, out };
}
const P = (s) => ["\x1b[200~" + s + "\x1b[201~"];

{ // a paste without markers in one read: one bracketed paste, nothing submitted
  const h = harness();
  h.read("first line\rsecond line\rthird");
  assert.deepEqual(h.out, P("first line\nsecond line\nthird"));
}
{ // CRLF and a trailing newline stay inside the paste
  const h = harness();
  h.read("a\r\nb\r\n");
  assert.deepEqual(h.out, P("a\nb\n"));
}
{ // a large paste split over reads, one read ending exactly on a line break
  const h = harness();
  h.read("one\rtwo\r");
  h.advance(3);
  h.read("three\rfour");
  assert.deepEqual(h.out, [...P("one\ntwo\n"), ...P("three\nfour")]);
}
{ // typed text, then Enter later: submits immediately
  const h = harness();
  for (const c of "hello") { h.read(c); h.advance(80); }
  h.read("\r");
  assert.deepEqual(h.out, [..."hello", "\r"]);
}
{ // a whole line plus Enter in one read (mobile SSH, tests): submits at once, no delay
  const h = harness();
  h.read("/model team/SubAgent\r");
  assert.deepEqual(h.out, [..."/model team/SubAgent", "\r"]);
}
{ // a client that "types" a paste one character per read
  const h = harness();
  for (const c of "ab\rcd") { h.read(c); h.advance(1); }
  h.advance(100);
  assert.deepEqual(h.out, ["a", "b", ...P("\ncd")]);
}
{ // fast typing then a lone Enter with nothing after: replayed as Enter
  const h = harness();
  h.read("x"); h.advance(5); h.read("\r");
  assert.deepEqual(h.out, ["x"]);
  h.advance(100);
  assert.deepEqual(h.out, ["x", "\r"]);
}
{ // held Enter followed by an arrow key: Enter replayed first, then the arrow
  const h = harness();
  h.read("x"); h.advance(5); h.read("\r"); h.advance(5); h.read("\x1b[A");
  assert.deepEqual(h.out, ["x", "\r", "\x1b[A"]);
}
{ // real bracketed pastes are untouched
  const h = harness();
  h.read("\x1b[200~a\nb\x1b[201~");
  assert.deepEqual(h.out, P("a\nb"));
}
console.log("paste-burst unit checks passed");

// --- real Pi: paste three lines without markers in one write; the model must get one prompt with all three.
const bodies = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST") bodies.push(body);
    // Streaming chat completion with a one-word reply.
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
    chunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// Never touch the real ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "redpi-paste-agent-"));
const project = mkdtempSync(join(tmpdir(), "redpi-paste-project-"));
mkdirSync(join(agentDir, "yitec"), { recursive: true });
writeFileSync(join(agentDir, "yitec", "onboarding.json"), JSON.stringify({ completed: true, provider: "manual" }));
writeFileSync(join(agentDir, "yitec", "model-tiers.json"), JSON.stringify({ routing: { mode: "strict" }, roles: { planner: { models: ["fake/echo:off"] }, executor: { models: ["fake/echo:off"] } } }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "echo", name: "echo", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "echo" }));

const py = `
import os, pty, subprocess, time, select, sys
root, cwd = sys.argv[1], sys.argv[2]
env = os.environ.copy()
env.update({'TERM': 'xterm-256color', 'COLUMNS': '120', 'LINES': '40'})
master, slave = pty.openpty()
p = subprocess.Popen(['pi', '-ne', '-e', root + '/extensions/yitec-model-router.ts'], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = b''
def drain(sec, until=None):
    global out
    end = time.time() + sec
    while time.time() < end:
        if until and until.encode() in out: return
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: d = os.read(master, 65536)
            except OSError: return
            if not d: return
            out += d
drain(20, 'RedPi high:')
drain(1)
# One write, no bracketed-paste markers, like a terminal that does not support them.
os.write(master, b'alpha line\\rbeta line\\rgamma line')
drain(1.5)
os.write(master, b'\\r')
drain(8, 'ok')
drain(2)
# A fast "typed" line with Enter in the same write must still submit on its own.
os.write(master, b'second prompt\\r')
drain(8)
os.write(master, b'\\x04'); drain(1)
try: p.terminate(); p.wait(timeout=3)
except Exception: p.kill()
sys.stdout.buffer.write(out[-3000:])
`;
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1", REDPI_AUTO_UPDATE: "0" };
for (const k of ["NINE_ROUTER_API_KEY", "ROUTER9_API_KEY", "NINEROUTER_API_KEY", "NINE_ROUTER_BASE_URL", "ROUTER9_BASE_URL"]) delete env[k];
const child = spawn("python3", ["-c", py, ROOT, project], { env, stdio: ["ignore", "pipe", "inherit"] });
let screen = "";
child.stdout.on("data", (d) => (screen += d));
await new Promise((r) => child.on("exit", r));
server.close();
rmSync(agentDir, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });

const prompts = bodies.map((b) => {
  const msgs = JSON.parse(b).messages || [];
  const last = msgs.filter((m) => m.role === "user").at(-1);
  return typeof last?.content === "string" ? last.content : (last?.content || []).map((c) => c.text || "").join("");
});
if (prompts.length !== 2 || !/alpha line\s*\n\s*beta line\s*\n\s*gamma line/.test(prompts[0]) || !prompts[1].includes("second prompt")) {
  console.log(screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
  console.log(JSON.stringify(prompts, null, 2));
  throw new Error(`expected two prompts (the whole paste, then "second prompt"), got ${prompts.length}`);
}
console.log("Paste smoke passed: a marker-less multi-line paste reached the model as one prompt, and Enter still submits.");
