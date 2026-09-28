#!/usr/bin/env node
// Decision model (Jev) + Jevgrep.
//   1. lib/jev.ts against a fake Jev and a fake `jg`: protocol, key redaction, routing rules,
//      managed jg credentials, 0600 config.
//   2. A real Pi TUI in a pty: /redpi-decision turns Jev on with a custom endpoint and key,
//      prompts are routed to the strong / fast / tiny models, magic keywords and failures fall
//      back correctly, the agent calls redpi_jevgrep, and "off" routes everything to the planner
//      and hides the tool.
//   3. With REDPI_TEST_REAL_JG=1: installs the real @dzhng/jevgrep into a temp agent dir and runs
//      it through runJevgrep against the fake Jev (network needed for npm).
// Never touches the real ~/.pi/agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_PROVIDERS, decideRoute, findJg, installJg, jevCheck, jevEvaluate, jevRoute, jgConfigHome, jgProviderFor,
  loadJevConfig, normalizeJevBaseUrl, runJevgrep, saveJevConfig,
} from "../lib/jev.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-test-123";
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const cleanup = [];

// ---------------------------------------------------------------------------------------------
// Fake Jev (/…/systemone) and fake OpenAI-compatible chat model on one server.
const jevLog = [];
const chatLog = [];
function jevAnswers(body) {
  const req = String(body.state?.request ?? "");
  const all = JSON.stringify(body.state ?? {});
  const answers = {};
  const route = /\bARCH\b/.test(req) ? ["strong", 0.9, 3.6]
    : /\bRENAME\b/.test(req) ? ["fast", 0.85, 1.0]
    : /\bHELLO\b/.test(req) ? ["tiny", 0.92, 0.1]
    : /\bUNSURE\b/.test(req) ? ["fast", 0.45, 1.0]
    : ["strong", 0.7, 2.0];
  for (const [id, q] of Object.entries(body.questions ?? {})) {
    if (q.type === "noul") answers[id] = { type: "noul", noul: /telemetry|recordEvent/i.test(all) ? 0.93 : 0.04 };
    else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const choice = id === "tier" ? route[0] : keys[0];
      const p = id === "tier" ? route[1] : 0.9;
      answers[id] = { type: "choice", choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / (keys.length - 1)])), confidence: p };
    } else if (q.type === "score") answers[id] = { type: "score", score: id === "effort" ? route[2] : 1, probabilities: {}, confidence: 0.8 };
  }
  return answers;
}
let replyN = 0;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url.endsWith("/systemone")) {
      const body = JSON.parse(raw || "{}");
      jevLog.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: `invalid key ${String(req.headers.authorization).replace("Bearer ", "")}` } });
      if (/\bBOOM\b/.test(String(body.state?.request ?? ""))) return send(500, { message: "upstream exploded" });
      return send(200, { model: body.model, answers: jevAnswers(body), usage: { input_tokens: 10, output_tokens: 0 } });
    }
    if (req.method === "POST" && req.url.includes("/chat/completions")) {
      const body = JSON.parse(raw);
      chatLog.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content || []).map((c) => c.text || "").join("");
      const toolDone = body.messages.at(-1)?.role === "tool";
      if (userText.includes("FINDCODE") && !toolDone) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "redpi_jevgrep", arguments: JSON.stringify({ question: "Where are telemetry events sent?", path: "src" }) } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: `reply-${++replyN}` });
        chunk({}, "stop");
      }
      return res.end("data: [DONE]\n\n");
    }
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const JEV_URL = `${ORIGIN}/jev/v1`;

// Fake jg: `--version`, `auth --provider X --stdin` (writes credentials like the real one), search.
function installFakeJg(agentDir, log) {
  const bin = join(agentDir, "yitec", "tools", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const jg = join(bin, "jg");
  writeFileSync(jg, `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os");
const args = process.argv.slice(2);
const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "jevgrep");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, xdg: process.env.XDG_CONFIG_HOME || null, cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") { console.log("0.4.1"); process.exit(0); }
if (args[0] === "auth") {
  const key = fs.readFileSync(0, "utf8").trim();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ provider: args[2], apiKey: key }), { mode: 0o600 });
  console.log("key saved"); process.exit(0);
}
let creds; try { creds = JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")); } catch {}
if (!creds) { console.log("Run jg auth or use jg auth --provider NAME --stdin."); process.exit(1); }
console.log("FAKE-JG-RESULT question=" + args[0] + " root=" + args[args.length - 1] + " provider=" + creds.provider + " key=" + (creds.apiKey ? "set" : "none"));
console.log("End context.");
process.exit(args[0].includes("PARTIAL") ? 2 : 0);
`);
  chmodSync(jg, 0o755);
  return jg;
}

// ---------------------------------------------------------------------------------------------
// 1. Library
{
  assert.equal(normalizeJevBaseUrl("openrouter.ai/api/v1/systemone/"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeJevBaseUrl(" http://127.0.0.1:9/jev/v1/ "), "http://127.0.0.1:9/jev/v1");
  assert.equal(jgProviderFor({ baseUrl: "https://openrouter.ai/api/v1/" }), "openrouter");
  assert.equal(jgProviderFor({ baseUrl: JEV_URL }), undefined);

  const cfg = { enabled: true, baseUrl: JEV_URL, apiKey: KEY, model: "jev-test" };
  assert.match(await jevCheck(cfg), /Jev answered/);
  const sent = jevLog.at(-1);
  assert.equal(sent.auth, `Bearer ${KEY}`);
  assert.equal(sent.body.model, "jev-test");
  assert.equal(sent.body.questions.relevant.type, "noul");

  // A provider error that echoes the key must not leak it.
  await assert.rejects(jevEvaluate({ ...cfg, apiKey: "sk-wrong-999" }, {}, { a: { type: "noul", instructions: "x" } }), (e) => e.status === 401 && !e.message.includes("sk-wrong-999") && e.message.includes("[redacted]"));
  await assert.rejects(jevEvaluate({ ...cfg, baseUrl: "http://127.0.0.1:1/v1" }, {}, {}, { timeoutMs: 2000 }), /network error|timed out/);

  // Routing rules: cheaper routes need confidence; thinking stays inside each tier's band.
  const d = (choice, p, score, extra = {}) => decideRoute({ tier: { choice, probabilities: { [choice]: p } }, effort: { score } }, { ...extra });
  assert.deepEqual([d("fast", 0.85, 1).tier, d("fast", 0.85, 1).thinking], ["fast", "low"]);
  assert.deepEqual([d("fast", 0.45, 1).tier, d("fast", 0.45, 1).jevTier], ["strong", "fast"]);
  assert.equal(d("fast", 0.45, 1, { minConfidence: 0.4 }).tier, "fast");
  assert.equal(d("strong", 0.9, 0.2).thinking, "medium");
  assert.equal(d("strong", 0.9, 3.6).thinking, "xhigh");
  assert.equal(d("fast", 0.9, 4).thinking, "medium");
  assert.equal(d("tiny", 0.9, 2).thinking, "off");
  assert.equal(d("fast", 0.9, 1, { thinking: false }).thinking, undefined);
  assert.equal(decideRoute({}, {}).tier, "strong");

  const r = await jevRoute(cfg, "please RENAME foo", "Earlier I suggested renaming foo.");
  assert.equal(r.tier, "fast");
  assert.equal(jevLog.at(-1).body.state.previousAssistantReply, "Earlier I suggested renaming foo.");
  assert.equal(jevLog.at(-1).body.questions.tier.type, "choice");
  assert.equal(jevLog.at(-1).body.questions.effort.type, "score");

  // Config is owner-only.
  const agentDir = tmp("redpi-jev-lib-");
  cleanup.push(agentDir);
  saveJevConfig(agentDir, { enabled: true, baseUrl: JEV_URL, apiKey: KEY, model: "m" });
  assert.equal(statSync(join(agentDir, "yitec", "decision-model.json")).mode & 0o777, 0o600);
  assert.equal(loadJevConfig(agentDir).apiKey, KEY);

  // jg with a provider it knows: RedPi keeps jg's credentials in its own config home, refreshed on key change.
  const jgLog = join(agentDir, "jg.log");
  writeFileSync(jgLog, "");
  installFakeJg(agentDir, jgLog);
  assert.ok(findJg(agentDir, ""));
  const managed = { enabled: true, baseUrl: JEV_PROVIDERS.openrouter.baseUrl, apiKey: "k-one", model: JEV_PROVIDERS.openrouter.model };
  const project = tmp("redpi-jev-proj-");
  cleanup.push(project);
  let out = await runJevgrep(agentDir, managed, { question: "Where is telemetry sent?", root: join(project, "src"), cwd: project });
  assert.ok(out.ok, out.text);
  assert.match(out.text, /FAKE-JG-RESULT question=Where is telemetry sent\? root=.*\/src provider=openrouter key=set/);
  const calls = () => readFileSync(jgLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls().map((c) => c.args[0]), ["auth", "Where is telemetry sent?"]);
  assert.equal(calls()[0].args.join(" "), "auth --provider openrouter --stdin");
  assert.equal(calls()[1].xdg, jgConfigHome(agentDir));
  assert.deepEqual(calls()[1].args.slice(1), ["--max-source-bytes", "40000", "--", join(project, "src")]);
  await runJevgrep(agentDir, managed, { question: "again", cwd: project });
  assert.equal(calls().filter((c) => c.args[0] === "auth").length, 1, "unchanged key must not re-run jg auth");
  await runJevgrep(agentDir, { ...managed, apiKey: "k-two" }, { question: "again", cwd: project });
  assert.equal(calls().filter((c) => c.args[0] === "auth").length, 2, "a new key must refresh jg's credentials");
  assert.equal(JSON.parse(readFileSync(join(jgConfigHome(agentDir), "jevgrep", "credentials.json"), "utf8")).apiKey, "k-two");
  out = await runJevgrep(agentDir, managed, { question: "PARTIAL please", cwd: project });
  assert.ok(out.ok && /incomplete search/.test(out.text));
  // A custom endpoint: jg cannot use it, so it runs with the user's own config (here: none).
  const ownXdg = tmp("redpi-jev-xdg-");
  cleanup.push(ownXdg);
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = ownXdg;
  out = await runJevgrep(agentDir, { ...cfg }, { question: "q", cwd: project });
  process.env.XDG_CONFIG_HOME = saved;
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  assert.equal(calls().at(-1).xdg, ownXdg);
  assert.match(out.text, /Never ask for API keys in chat/);
  assert.equal((await runJevgrep(tmp("redpi-jev-nojg-"), managed, { question: "q", cwd: project })).ok, false);
  console.log("jev library checks passed");
}

// ---------------------------------------------------------------------------------------------
// 2. Real Pi
{
  const agentDir = tmp("redpi-jev-agent-");
  const project = tmp("redpi-jev-project-");
  const userXdg = tmp("redpi-jev-userxdg-");
  cleanup.push(agentDir, project, userXdg);
  mkdirSync(join(project, "src"));
  mkdirSync(join(agentDir, "yitec"), { recursive: true });
  mkdirSync(join(userXdg, "jevgrep"));
  writeFileSync(join(userXdg, "jevgrep", "credentials.json"), JSON.stringify({ provider: "typesafe", apiKey: "users-own-key" }));
  const jgLog = join(agentDir, "jg.log");
  writeFileSync(jgLog, "");
  installFakeJg(agentDir, jgLog);
  const w = (p, v) => writeFileSync(join(agentDir, p), JSON.stringify(v));
  w("yitec/onboarding.json", { completed: true, provider: "manual" });
  w("yitec/model-tiers.json", { roles: {
    planner: { models: ["fake/strong:high"], thinking: "high" },
    executor: { models: ["fake/fast:low"], thinking: "low" },
    tiny: { models: ["fake/tiny:off"], thinking: "off" },
  } });
  const model = (id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  w("models.json", { providers: { fake: { baseUrl: `${ORIGIN}/v1`, api: "openai-completions", apiKey: "x", models: [model("strong"), model("fast"), model("tiny")] } } });
  w("settings.json", { defaultProvider: "fake", defaultModel: "strong" });

  const DOWN = "\x1b[B";
  // [text to type, screen text to wait for before the next step]
  const steps = [
    ["/redpi-decision\r", "Decision model (Jev): OFF"],
    ["\r", "Decision model provider (Jev)"],
    [DOWN.repeat(4) + "\r", "Endpoint URL"],
    [`${JEV_URL}/systemone\r`, "API key"],
    [`${KEY}\r`, "Model id"],
    ["jev-test\r", "Decision model ON."],
    ["\x1b", null],
    ["HELLO there\r", "reply-1"],
    ["please RENAME foo to bar\r", "reply-2"],
    ["ARCH: design a plugin system\r", "reply-3"],
    ["UNSURE maybe tweak it\r", "reply-4"],
    ["BOOM\r", "reply-5"],
    ["cheap RENAME x to y\r", "reply-6"],
    ["FINDCODE where is telemetry sent\r", "reply-7"],
    ["/redpi-decision off\r", "Decision model OFF"],
    ["HELLO again\r", "reply-8"],
  ];
  const py = `
import os, pty, subprocess, time, select, sys, json, re
root, cwd, steps = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
env = os.environ.copy()
env.update({'TERM': 'xterm-256color', 'COLUMNS': '220', 'LINES': '50'})
master, slave = pty.openpty()
p = subprocess.Popen(['pi', '-ne', '-e', root + '/extensions/yitec-model-router.ts'], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = b''
def clean():
    t = out.decode('utf-8', 'ignore'); t = re.sub(r'\\x1b\\][^\\a]*(?:\\a|\\x1b\\\\)', '', t); return re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]', '', t)
def drain(sec, until=None):
    global out
    start = len(clean()); end = time.time() + sec
    while time.time() < end:
        if until and until in clean()[start:]: return drain(0.4)
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: d = os.read(master, 65536)
            except OSError: return
            if not d: return
            out += d
    if until: sys.stderr.write('TIMEOUT waiting for ' + until + '\\n')
drain(25, 'RedPi high:')
for text, until in steps:
    os.write(master, text.encode())
    drain(25 if until else 1.5, until)
os.write(master, b'\\x04'); drain(1)
try: p.terminate(); p.wait(timeout=3)
except Exception: p.kill()
sys.stdout.write(clean())
`;
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1", REDPI_AUTO_UPDATE: "0", XDG_CONFIG_HOME: userXdg };
  for (const k of ["NINE_ROUTER_API_KEY", "ROUTER9_API_KEY", "NINEROUTER_API_KEY", "NINE_ROUTER_BASE_URL", "ROUTER9_BASE_URL"]) delete env[k];
  const jevBefore = jevLog.length;
  const child = spawn("python3", ["-c", py, ROOT, project, JSON.stringify(steps)], { env, stdio: ["ignore", "pipe", "inherit"] });
  let screen = "";
  child.stdout.on("data", (d) => (screen += d));
  await new Promise((r) => child.on("exit", r));
  const fail = (msg) => { console.log(screen.slice(-6000)); console.log(JSON.stringify(chatLog.map((b) => b.model))); throw new Error(msg); };

  const saved = JSON.parse(readFileSync(join(agentDir, "yitec", "decision-model.json"), "utf8"));
  if (saved.baseUrl !== JEV_URL || saved.apiKey !== KEY || saved.model !== "jev-test" || saved.provider !== "custom") fail(`decision config not saved as entered: ${JSON.stringify({ ...saved, apiKey: saved.apiKey === KEY })}`);
  if ((statSync(join(agentDir, "yitec", "decision-model.json")).mode & 0o777) !== 0o600) fail("decision config is not 0600");
  if (saved.enabled !== false) fail("/redpi-decision off did not turn it off");
  if (screen.includes(KEY)) fail("the API key was echoed on screen");
  if (!jevLog.slice(jevBefore).some((e) => e.body.questions?.relevant && e.body.model === "jev-test")) fail("connection check did not run during setup");

  // One chat request per prompt, except FINDCODE (tool call + follow-up).
  const models = chatLog.map((b) => b.model);
  const expected = ["tiny", "fast", "strong", "strong", "strong", "fast", "strong", "strong", "strong"];
  if (JSON.stringify(models) !== JSON.stringify(expected)) fail(`routed models ${JSON.stringify(models)} != ${JSON.stringify(expected)}`);
  for (const s of ["tiny on fake/tiny:off · jev tiny 92%", "executor on fake/fast:low · jev fast 85%", "planner on fake/strong:xhigh · jev strong 90%", "jev strong (fast only 45%)", "jev unavailable (HTTP 500: upstream exploded) → planner"]) {
    if (!screen.includes(s)) fail(`status line missing: ${s}`);
  }
  const routed = jevLog.slice(jevBefore).filter((e) => e.body.questions?.tier);
  // HELLO, RENAME, ARCH, UNSURE, BOOM, FINDCODE; not the "cheap" prompt, not after "off".
  if (routed.length !== 6) fail(`expected 6 routing calls, got ${routed.length}: ${routed.map((e) => e.body.state.request).join(" | ")}`);
  if (routed[1].body.state.previousAssistantReply !== "reply-1") fail("routing did not include the previous reply");

  const toolsOf = (b) => (b.tools || []).map((t) => t.function?.name);
  if (!toolsOf(chatLog[0]).includes("redpi_jevgrep")) fail("redpi_jevgrep not offered while the decision model is on");
  if (toolsOf(chatLog.at(-1)).includes("redpi_jevgrep")) fail("redpi_jevgrep still offered after turning the decision model off");
  const toolMsg = chatLog[7].messages.find((m) => m.role === "tool");
  const toolText = typeof toolMsg?.content === "string" ? toolMsg.content : (toolMsg?.content || []).map((c) => c.text || "").join("");
  if (!/FAKE-JG-RESULT question=Where are telemetry events sent\? root=.*\/src provider=typesafe/.test(toolText)) fail(`jevgrep tool result wrong: ${toolText}`);
  const search = readFileSync(jgLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.args[0].startsWith("Where"));
  if (search.xdg !== userXdg) fail("a custom endpoint must leave jg on the user's own credentials");
  console.log("jev Pi checks passed");
}

// ---------------------------------------------------------------------------------------------
// 3. The real jg, on demand (needs npm/network)
if (process.env.REDPI_TEST_REAL_JG === "1") {
  const agentDir = tmp("redpi-jev-realjg-");
  const repo = tmp("redpi-jev-repo-");
  cleanup.push(agentDir, repo);
  mkdirSync(join(repo, "src", "telemetry"), { recursive: true });
  writeFileSync(join(repo, "src", "telemetry", "send.ts"), "// Sends recorded telemetry events to the collector.\nexport async function sendTelemetry(events: string[]) {\n  await fetch('https://collector.example/telemetry', { method: 'POST', body: JSON.stringify(events) });\n}\n");
  writeFileSync(join(repo, "src", "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  console.log(await installJg(agentDir));
  const cfg = { enabled: true, baseUrl: JEV_PROVIDERS.openrouter.baseUrl, apiKey: KEY, model: JEV_PROVIDERS.openrouter.model };
  const savedOpts = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${join(ROOT, "scripts", "fixtures", "jev-route-preload.mjs")}`;
  process.env.JEV_TEST_ORIGIN = ORIGIN;
  const before = jevLog.length;
  const out = await runJevgrep(agentDir, cfg, { question: "How are telemetry events sent?", root: repo, cwd: repo, timeoutMs: 120000 });
  process.env.NODE_OPTIONS = savedOpts ?? "";
  delete process.env.JEV_TEST_ORIGIN;
  if (!out.ok || !out.text.includes("src/telemetry/send.ts") || !out.text.includes("End context.")) { console.log(out.text); throw new Error("real jg did not find the telemetry file"); }
  if (jevLog.length === before || jevLog.slice(before).some((e) => e.auth !== `Bearer ${KEY}`)) throw new Error("real jg did not use the decision-model key");
  console.log(`real jg checks passed (${jevLog.length - before} Jev requests; found src/telemetry/send.ts)`);
}

server.close();
for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log("Jev smoke passed: decision model setup, routing (strong/fast/tiny, confidence floor, failures, magic keywords, off), and Jevgrep.");
