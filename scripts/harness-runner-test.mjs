#!/usr/bin/env node
// Harness workers test: a private hub and tmux server, fake claude / codex / opencode binaries
// (scripts/fake-harness.mjs), and hq/runner.mjs launched in tmux the way RedPlan launches it.
// Checks, for every harness: the brief runs as a turn, the agent moves its card and messages the
// CEO through `redpi-hq`, later messages continue the same harness session, side questions run on
// a fork without touching the live session (instructions are relayed), an interrupt stops a stuck
// turn, a provider failure raises "needs you", and a killed worker resumes its session.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (spawnSync("tmux", ["-V"]).status !== 0) { console.log("Harness runner test skipped: tmux is not installed."); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "redpi-harness-test-"));
const hqDir = join(dir, "hq"), bin = join(dir, "bin"), log = join(dir, "harness.log"), project = join(dir, "project");
for (const d of [hqDir, bin, project]) mkdirSync(d, { recursive: true });
writeFileSync(log, "");
for (const h of ["claude", "codex", "opencode"]) writeFileSync(join(bin, h), `#!/bin/sh\nexec "${process.execPath}" "${join(root, "scripts", "fake-harness.mjs")}" ${h} "$@"\n`, { mode: 0o755 });
const port = 20000 + Math.floor(Math.random() * 20000);
const sock = `redpi-harness-${process.pid}`;
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REDPI_HQ_DIR: hqDir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1", FAKE_HARNESS_LOG: log, REDPI_RUNNER_POLL_MS: "500" };
const server = spawn(process.execPath, [join(root, "hq", "server.mjs")], { env: { ...env, REDPI_TMUX_SOCKET: sock }, stdio: "ignore" });
const cleanup = () => { server.kill(); spawnSync("tmux", ["-L", sock, "kill-server"]); rmSync(dir, { recursive: true, force: true }); };
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  if (process.env.DEBUG_PANES) for (const s of spawnSync("tmux", ["-L", sock, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) console.error(`---- ${s} ----\n${pane(s)}`);
  cleanup(); process.exit(1);
};
process.on("unhandledRejection", (e) => fail(e?.stack || e));

const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const token = readFileSync(join(hqDir, "token"), "utf8").trim();
const api = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${path}: ${data?.error || res.status}`);
  return data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  fail(`timed out waiting for: ${what}`);
}
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const pane = (s) => spawnSync("tmux", ["-L", sock, "capture-pane", "-p", "-S", "-200", "-t", `=${s}:`], { encoding: "utf8" }).stdout;

// A run whose three tasks go to Claude Code, Codex, and OpenCode.
const run = (await api("POST", "/api/runs", { projectPath: project, title: "Harness test" })).run.id;
const tasks = [["T1", "claude"], ["T2", "codex"], ["T3", "opencode"]];
const plan = { title: "Harness test", summary: "Three harnesses.", techStack: [], architecture: { components: [], links: [] },
  stories: [{ id: "S1", title: "Work", userStory: "As a tester, I want work", acceptance: ["done"], tasks: tasks.map(([id]) => ({ id, title: `Task ${id}`, description: "d", estimateHours: 1 })) }] };
const pl = await api("POST", `/api/runs/${run}/plans`, { plan });
const hs = await api("GET", "/api/harnesses?refresh=1");
for (const h of ["claude", "codex", "opencode"]) if (!hs.find((x) => x.id === h)?.installed) fail(`${h} not detected`);
for (const [task, harness] of tasks) await api("PUT", `/api/runs/${run}/harness`, { task, harness });
await api("POST", `/api/plans/${pl.id}/decision`, { decision: "approve" });

// Launch exactly as extensions/redplan.ts launchRunner does.
function launch(w, launchId, extra = {}) {
  const e = { REDPI_HQ_WORKER: w.id, REDPI_HQ_RUN: run, REDPI_HQ_NAME: w.name, REDPI_HQ_LAUNCH: launchId, REDPI_HQ_PORT: String(port), REDPI_HQ_DIR: hqDir,
    REDPI_HARNESS: w.harness, PATH: env.PATH, FAKE_HARNESS_LOG: log, REDPI_RUNNER_POLL_MS: "500", ...extra };
  const r = spawnSync("tmux", ["-L", sock, "new-session", "-d", "-s", w.tmux, "-x", "200", "-y", "50", "-c", project, ...Object.entries(e).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "env", `PATH=${env.PATH}`, process.execPath, join(root, "hq", "runner.mjs")], { encoding: "utf8" });
  if (r.status !== 0) fail(`tmux: ${r.stderr}`);
}
const workers = {};
for (const [task, harness] of tasks) {
  const name = { claude: "Cora", codex: "Cody", opencode: "Olive" }[harness];
  const launchId = randomUUID();
  const w = await api("POST", `/api/runs/${run}/workers`, { name, role: "developer", cwd: project, tmux: `rh-${name.toLowerCase()}`, taskIds: [task], harness, launchId, brief: `Build ${task}. TASK=${task}` });
  workers[harness] = { ...w, task, launchId };
  launch(w, launchId);
}

for (const [harness, w] of Object.entries(workers)) {
  await wait(`${harness}: ${w.task} moved to review via redpi-hq`, async () => (await api("GET", `/api/runs/${run}`)).tasks.find((t) => t.id === w.task)?.status === "review");
  await wait(`${harness}: CEO got the worker's message`, async () => (await api("GET", `/api/runs/${run}/inbox?for=ceo&after=0`)).some((m) => m.body === `${harness} worker: started ${w.task}` && m.sender === w.id));
  const d = await wait(`${harness}: idle with session id and reply`, async () => { const d = await api("GET", `/api/workers/${w.id}`); return d.worker.status === "idle" && d.worker.session_file && d.worker.last_message?.includes(`Done with ${w.task}`) ? d : null; });
  if (!d.events.some((e) => e.kind === "tool" && e.text.includes("redpi-hq task"))) fail(`${harness}: tool activity not reported`);
  if (!d.worker.open?.includes(d.worker.session_file)) fail(`${harness}: no interactive command for the session`);
  const first = calls().find((c) => c.worker === w.id);
  if (first.resumed) fail(`${harness}: the first turn should start a new session`);
  const instructions = harness === "claude" ? first.sys : first.prompt;
  if (!instructions.includes("redpi-hq task") || !instructions.includes(`You are ${w.name}, developer`)) fail(`${harness}: worker instructions missing`);
  if (!pane(w.tmux).includes("redpi-hq task")) fail(`${harness}: the pane does not show the agent's work`);
  w.session = d.worker.session_file;
}

// Follow-up messages continue the same session.
for (const [harness, w] of Object.entries(workers)) await api("POST", `/api/runs/${run}/messages`, { from: "human", to: w.id, kind: "command", body: "second message" });
for (const [harness, w] of Object.entries(workers)) {
  const c = await wait(`${harness}: second turn`, () => calls().find((c) => c.worker === w.id && !c.fork && c.prompt.includes("second message")));
  if (!c.resumed || c.session !== w.session) fail(`${harness}: second turn did not continue session ${w.session}: ${JSON.stringify(c.args)}`);
  await wait(`${harness}: second reply`, async () => (await api("GET", `/api/workers/${w.id}`)).worker.last_message?.includes("same session"));
  // The human wrote from HQ, so the answer is posted back to them there.
  await wait(`${harness}: reply posted to the human in HQ`, async () => (await api("GET", `/api/runs/${run}`)).messages.find((m) => m.kind === "reply" && m.sender === w.id && m.recipient === "human" && m.body.includes("same session")));
}

// Every message from the human also gets an instant answer, from a fork of the session.
for (const [harness, w] of Object.entries(workers)) {
  const q = await wait(`${harness}: instant answer`, async () => (await api("GET", `/api/runs/${run}`)).messages.find((m) => m.kind === "quick" && m.sender === w.id));
  const f = calls().find((c) => c.worker === w.id && c.fork && c.prompt.includes("Instant answer") && c.prompt.includes("second message"));
  if (q.recipient !== "human" || !q.body.trim() || !f) fail(`${harness}: no instant answer from a fork`, { q, f: !!f });
}

// Side questions run on a fork while the live turn keeps going; an interrupt stops the stuck turn.
const cora = workers.claude;
await api("POST", `/api/runs/${run}/messages`, { from: "human", to: cora.id, kind: "command", body: "SLOWTASK: write docs" });
await wait("Cora busy", async () => (await api("GET", `/api/workers/${cora.id}`)).worker.status === "working");
await api("POST", `/api/runs/${run}/messages`, { from: "human", to: cora.id, kind: "aside", body: "btw, how far along are you?" });
const side = await wait("side answer", async () => (await api("GET", `/api/runs/${run}`)).messages.find((m) => m.kind === "aside" && m.sender === cora.id));
if (!side.body.includes("halfway through") || side.recipient !== "human") fail(`bad side answer: ${side.body}`);
const forkCall = calls().find((c) => c.worker === cora.id && c.fork && c.prompt.includes("Side question"));
if (!forkCall.args.includes("--fork-session") || !forkCall.args.includes(cora.session)) fail(`side question did not fork the session: ${forkCall.args}`);
if ((await api("GET", `/api/workers/${cora.id}`)).worker.status !== "working") fail("the side question disturbed the live turn");
// The CEO asks on the side too (redplan_ask): the answer goes back to the CEO, and the live turn keeps going.
await api("POST", `/api/runs/${run}/messages`, { from: "ceo", to: cora.id, kind: "aside", body: "How far along are you with the docs?" });
const ceoSide = await wait("side answer to the CEO", async () => (await api("GET", `/api/runs/${run}`)).messages.find((m) => m.kind === "aside" && m.sender === cora.id && m.recipient === "ceo"));
if (!ceoSide.body.includes("halfway through")) fail(`bad side answer to the CEO: ${ceoSide.body}`);
if (!calls().some((c) => c.worker === cora.id && c.fork && c.prompt.includes("Side question from the CEO"))) fail("the CEO's side question should be answered on a fork, as the CEO's");
if ((await api("GET", `/api/workers/${cora.id}`)).worker.status !== "working") fail("the CEO's side question disturbed the live turn");
const t0 = Date.now();
await api("POST", `/api/runs/${run}/messages`, { from: "human", to: cora.id, kind: "interrupt", body: "INTERRUPTED-NOW: stop and fix the test" });
await wait("interrupt delivered", () => calls().find((c) => c.worker === cora.id && !c.fork && c.prompt.includes("INTERRUPTED-NOW")), 15000);
if (Date.now() - t0 > 12000) fail("interrupt did not stop the running turn");
await wait("interrupt reported", async () => (await api("GET", `/api/workers/${cora.id}`)).events.some((e) => e.kind === "interrupt"));

// A side question that is an instruction is relayed to the live session.
for (const harness of ["codex", "opencode"]) {
  const w = workers[harness];
  await api("POST", `/api/runs/${run}/messages`, { from: "human", to: w.id, kind: "aside", body: "Please also add a /health endpoint." });
  await wait(`${harness}: forwarded answer`, async () => (await api("GET", `/api/runs/${run}`)).messages.find((m) => m.kind === "aside" && m.sender === w.id && m.body.includes("Forwarded to my live session")));
  const relayed = await wait(`${harness}: instruction relayed into the session`, () => calls().find((c) => c.worker === w.id && !c.fork && c.prompt.includes("relayed from a side question")));
  if (!relayed.resumed || relayed.session !== w.session) fail(`${harness}: relayed instruction did not continue the session`);
}

// Provider trouble shows up as "needs you".
const cody = workers.codex;
await api("POST", `/api/runs/${run}/messages`, { from: "human", to: cody.id, kind: "command", body: "PROVIDER-DOWN please" });
const stuck = await wait("needs input", async () => (await api("GET", `/api/workers/${cody.id}`)).worker.needs_input);
if (!/rate limit/.test(stuck.reason)) fail(`needs-input reason: ${stuck.reason}`);

// Crash + resume: kill Olive's tmux session; a relaunch continues her session and inbox.
const olive = workers.opencode;
spawnSync("tmux", ["-L", sock, "kill-session", "-t", `=${olive.tmux}`]);
await wait("Olive offline", async () => !(await api("GET", `/api/workers/${olive.id}`)).worker.alive, 20000);
const relaunch = randomUUID();
await api("PATCH", `/api/workers/${olive.id}`, { launchId: relaunch, status: "starting", tmux: olive.tmux });
launch(olive, relaunch);
await api("POST", `/api/runs/${run}/messages`, { from: "human", to: olive.id, kind: "command", body: "after the crash" });
const back = await wait("resumed turn", () => calls().find((c) => c.worker === olive.id && !c.fork && c.prompt.includes("after the crash")));
if (!back.resumed || back.session !== olive.session) fail("resumed worker did not continue its session");
if (calls().filter((c) => c.worker === olive.id && c.prompt.includes("[RedPlan brief")).length !== 1) fail("the brief was delivered again after resume");
if (!pane(olive.tmux).includes("resuming session")) fail("pane does not say it resumed");

// The CLI refuses what the rules refuse.
const cli = spawnSync(process.execPath, [join(root, "hq", "cli.mjs"), "task", "T1", "blocked"], { env: { ...env, REDPI_HQ_WORKER: cora.id, REDPI_HQ_RUN: run }, encoding: "utf8" });
if (cli.status === 0 || !/reason|note/i.test(cli.stderr)) fail(`redpi-hq accepted blocked without a reason: ${cli.stderr}`);

console.log("Harness runner test passed: Claude Code, Codex, and OpenCode workers take the brief, move cards and message the CEO via redpi-hq, continue their session every turn, answer every message (and the CEO side questions) instantly from a fork, answer side questions on a fork (and relay instructions), stop on interrupt, flag provider trouble, and resume after a crash.");
cleanup();
process.exit(0);
