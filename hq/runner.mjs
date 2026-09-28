#!/usr/bin/env node
// RedPlan worker runner for Claude Code, Codex, and OpenCode. It lives in the worker's tmux
// session: it polls the worker's HQ inbox, runs one headless turn of the harness per batch of
// messages (always continuing the same harness session), prints what happens, and reports status,
// tool activity, and replies to HQ. The agent itself uses `redpi-hq` (hq/cli.mjs) for the board
// and team chat. Anything typed into this pane is sent to the worker as a message from the human.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HARNESSES, parseLine, turnCommand } from "./harnesses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const PORT = Number(process.env.REDPI_HQ_PORT || 47291);
const ME = process.env.REDPI_HQ_WORKER;
const RUN = process.env.REDPI_HQ_RUN;
const LAUNCH = process.env.REDPI_HQ_LAUNCH || undefined;
const HARNESS = process.env.REDPI_HARNESS;
const AUTONOMY = process.env.REDPI_WORKER_AUTONOMY || "full";
const POLL_MS = Number(process.env.REDPI_RUNNER_POLL_MS || 2000);
const PROVIDER_STUCK = /rate limit|429|quota|insufficient_quota|weekly limit|session limit|credits|tokens exhausted|overloaded|401|api key|not logged in|login|authenticat/i;
if (!ME || !RUN || !HARNESSES[HARNESS] || HARNESS === "pi") { console.error("runner: REDPI_HQ_WORKER, REDPI_HQ_RUN and a non-Pi REDPI_HARNESS are required"); process.exit(2); }
const H = HARNESSES[HARNESS];

// ---------- state that survives a restart (resume) ----------
const STATE_PATH = join(HQ_DIR, "runners", `${ME}.json`);
mkdirSync(dirname(STATE_PATH), { recursive: true });
let state = {};
try { state = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch {}
if (!state.session && process.env.REDPI_HARNESS_SESSION) state = { session: process.env.REDPI_HARNESS_SESSION, started: true };
state.cursor = Math.max(state.cursor || 0, Number(process.env.REDPI_HQ_CURSOR || 0));
// Claude takes a session id we choose; the others report theirs on the first turn.
if (HARNESS === "claude" && !state.session) state.session = randomUUID();
const save = () => { const tmp = `${STATE_PATH}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state, null, 2)); renameSync(tmp, STATE_PATH); };
save();

// `redpi-hq` on the agent's PATH.
const BIN_DIR = join(HQ_DIR, "bin");
mkdirSync(BIN_DIR, { recursive: true });
writeFileSync(join(BIN_DIR, "redpi-hq"), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, "cli.mjs")}" "$@"\n`);
chmodSync(join(BIN_DIR, "redpi-hq"), 0o755);
const childEnv = { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH || ""}` };

// ---------- HQ ----------
const token = () => { try { return readFileSync(join(HQ_DIR, "token"), "utf8").trim(); } catch { return ""; } };
async function hq(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { authorization: `Bearer ${token()}`, "x-redpi-hq": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HQ ${res.status}`);
  return data;
}
let beatState = {}, beatEvents = [], beatTimer;
function beat(patch, event) {
  beatState = { ...beatState, ...patch };
  if (event) beatEvents.push(event);
  if (beatTimer) return;
  beatTimer = setTimeout(async () => {
    beatTimer = undefined;
    const body = { ...beatState, launchId: LAUNCH, events: beatEvents.splice(0) };
    beatState = {};
    const r = await hq("POST", `/api/workers/${ME}/heartbeat`, body).catch(() => null);
    if (r?.stale) { say(dim("A newer launch of this worker took over; exiting.")); shutdown(0); }
  }, 400);
}

// ---------- pane output ----------
const color = (c) => (s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const dim = color("2"), green = color("32"), cyan = color("36"), red = color("31"), bold = color("1");
const say = (s = "") => process.stdout.write(`${s}\n`);

// ---------- what the agent is told ----------
async function instructions() {
  const d = await hq("GET", `/api/workers/${ME}`);
  const w = d.worker;
  const independent = d.review !== "self";
  const reviewer = /review|qa|audit/i.test(w.role);
  const finish = reviewer
    ? "done only after you checked the exact diff against the task's acceptance criteria and ran its tests; otherwise move it back to in_progress and send the author concrete findings"
    : independent ? "review (not done) once it is implemented and you verified it yourself; an independent reviewer marks it done"
      : "done once it is implemented and verified (tests/build pass), with a note on how you verified it";
  return `RedPlan worker. You are ${w.name}, ${w.role}, running in ${H.name} as part of a team led by a CEO session. Run: "${d.run.title}". Workspace: ${w.cwd}${w.branch ? ` on branch ${w.branch}` : " (shared with teammates)"}.
Your tasks:
${d.tasks.map((t) => `- ${t.id} ${t.title} [${t.status}]`).join("\n") || (reviewer ? "- (you review teammates' tasks as they reach review)" : "- (none yet; ask the CEO)")}
Teammates:
${d.teammates.map((t) => `- ${t.name} (${t.role})`).join("\n") || "- (just you)"}
Use the \`redpi-hq\` command in your shell to work with the team (run \`redpi-hq help\`):
- \`redpi-hq task <id> in_progress\` when you start a task; \`redpi-hq task <id> ${reviewer ? "done" : independent ? "review" : "done"} "<how you verified it>"\` — ${finish}.
- \`redpi-hq task <id> blocked --on <teammate|ceo|external|human> "<reason and what would unblock it>"\` (the blocker goes to whoever must act; use human only for a decision or access only the human can give); \`redpi-hq task <id> --handoff <name> "<what is done, what is next>"\`.
- \`redpi-hq send <name> "<message>"\` to talk to a teammate, \`redpi-hq send ceo "<message>"\` for decisions outside your tasks or when blocked. \`redpi-hq team\` / \`redpi-hq status\` show the team and board.
Messages from the CEO, teammates, and the human arrive as your next prompt, starting with [RedPlan …]. Instructions from the human override everything else.
Stay in scope: change only what your tasks need. In a shared workspace never edit files a teammate owns. In a worktree, commit to your branch with clear messages and do not merge. Use the exact technologies and APIs in your brief. When all your tasks are done, send the CEO a short report (what changed, how you verified it, anything left) and stop.
Keep the human informed: before each meaningful step, write one short plain-language sentence saying what you are about to do and why, and after it what you found or changed. The human follows these lines live in RedPi HQ.
Team norms: review the exact change, not a description of it. Never mark someone else's task unless you are its reviewer. A task closes with evidence (a test, a build, a review), not a claim. Record decisions and their reasons in task notes or messages.`;
}

function format(m) {
  const from = m.senderName || m.sender;
  if (m.kind === "brief") return `[RedPlan brief from the CEO]\n\n${m.body}`;
  if (m.kind === "decision") return `[RedPlan · decision from the human]\n${m.body}`;
  if (m.kind === "system") return `[RedPlan · HQ]\n${m.body}`;
  if (m.sender === "human") return `[RedPlan · message from the human via HQ]\n${m.body}\n(The human wrote this in RedPi HQ and reads your answer there: reply to them directly in your response. When this turn ends, your final reply is posted back to them in HQ.)`;
  return `[RedPlan · message from ${from}]\n${m.body}\n(Reply with: redpi-hq send ${from === "CEO" ? "ceo" : from} "<message>")`;
}

const ASIDE = (name) => `[Side question from the human, answered on a copy of your session: your live work does not see this exchange.]
Answer from what you have done so far in this session: what you are doing, why, what you found, what is left. Be concise, first person, as ${name}. Do not run tools or change files for this. If the human's message is an instruction for your live work (e.g. "also add X", "use Z instead"), begin your reply with one line "FORWARD: <the instruction, rewritten clearly>", then confirm briefly that you passed it on. Questions are never forwarded.

THE HUMAN ASKS (by the way):
`;

// ---------- one harness process ----------
function runHarness({ prompt, fresh, instructionsText, fork, onEvent }) {
  const { bin, args, stdin } = turnCommand(HARNESS, { prompt, session: state.session, fresh, instructions: instructionsText, autonomy: AUTONOMY, cwd: process.cwd(), fork });
  const child = spawn(bin, args, { cwd: process.cwd(), env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", result = { ok: false, error: "", final: "", text: "" };
  const done = new Promise((resolve) => {
    child.on("error", (e) => { result.error = e.code === "ENOENT" ? `${bin} is not installed or not on PATH` : e.message; });
    child.on("close", (code, signal) => {
      if (!result.error && !result.ok && code === 0 && !signal) result.ok = true;
      if (!result.ok && !result.error) result.error = signal ? `stopped (${signal})` : stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit code ${code}`;
      resolve(result);
    });
  });
  child.stdin.on("error", () => {});
  if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    for (const ev of parseLine(HARNESS, line)) {
      if (ev.text) result.text = ev.text;
      if (ev.done) { result.ok = ev.ok; result.error = ev.ok ? "" : ev.error; if (ev.final) result.final = ev.final; }
      onEvent(ev);
    }
  });
  return { child, done };
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000).unref();
}

// ---------- the main session ----------
let current = null, interrupted = false;
const queue = [];

async function startTurn(msgs) {
  const fresh = !state.started;
  let instructionsText = "";
  try { instructionsText = await instructions(); } catch {}
  const prompt = msgs.map(format).join("\n\n---\n\n");
  // The human wrote to this worker from HQ: its answer goes back to them there when the turn ends.
  const fromHuman = msgs.some((m) => m.sender === "human" && !["system", "decision"].includes(m.kind));
  say();
  say(bold(cyan(`── ${new Date().toLocaleTimeString()} · ${msgs.map((m) => m.senderName || m.sender).join(", ")} → ${process.env.REDPI_HQ_NAME || "worker"} (${H.name}) ──`)));
  say(dim(prompt.length > 900 ? `${prompt.slice(0, 900)}…` : prompt));
  interrupted = false;
  const started = Date.now();
  beat({ status: "working", activity: { text: `${H.short}: thinking`, tool: "thinking", at: Date.now() }, needsInput: null },
    { kind: "inbox", text: msgs.map((m) => `${m.senderName || m.sender}: ${String(m.body).slice(0, 120)}`).join(" | ") });
  const run = runHarness({
    prompt, fresh, instructionsText: HARNESS === "claude" || fresh ? instructionsText : "",
    onEvent(ev) {
      if (ev.session && ev.session !== state.session) { state.session = ev.session; save(); beat({ sessionFile: ev.session }); }
      if (ev.session && !state.started) { state.started = true; save(); beat({ sessionFile: state.session }); }
      if (ev.tool) {
        const line = `${ev.tool}${ev.detail ? `: ${ev.detail.slice(0, 160)}` : ""}`;
        say(`  ${green("▸")} ${line}`);
        beat({ activity: { text: line, tool: ev.tool, at: Date.now() } }, { kind: "tool", text: line });
      }
      if (ev.text) { say(ev.text); beat({}, { kind: "say", text: ev.text.trim().slice(0, 1500) }); }
    },
  });
  current = run;
  const r = await run.done;
  current = null;
  if (state.session && !state.started && HARNESS === "claude" && r.ok) { state.started = true; save(); }
  const final = (r.final || r.text || "").trim();
  const ms = Date.now() - started;
  if (interrupted) say(red("■ interrupted"));
  else if (r.ok) say(dim(`✓ turn finished in ${(ms / 1000).toFixed(1)}s`));
  else say(red(`✗ ${r.error}`));
  const stuck = !r.ok && !interrupted && PROVIDER_STUCK.test(r.error) ? { count: 1, reason: `${H.name}: ${r.error.slice(0, 200)}` } : null;
  beat({ status: "idle", ...(final ? { lastMessage: final } : {}), needsInput: stuck, activity: { text: interrupted ? "interrupted" : r.ok ? "idle" : `error: ${r.error.slice(0, 120)}`, at: Date.now() } },
    interrupted ? { kind: "interrupt", text: "Turn interrupted by the human" }
      : r.ok ? (final ? { kind: "reply", text: final.slice(0, 300), ms, ok: true } : { kind: "turn", text: "Turn finished", ms, ok: true })
        : { kind: "error", text: `${H.name}: ${r.error.slice(0, 300)}`, ms, ok: false });
  if (fromHuman && !interrupted) {
    const body = final || (r.ok ? "(I finished that turn without a written reply.)" : `I couldn't finish that: ${r.error.slice(0, 300)}`);
    await hq("POST", `/api/runs/${RUN}/messages`, { from: ME, to: "human", kind: "reply", body: body.slice(0, 8000) }).catch(() => {});
  }
  if (queue.length) startTurn(queue.splice(0));
}

// ---------- side questions ("btw") ----------
let asideBusy = false;
const asides = [];
async function answerAside(m) {
  asideBusy = true;
  const started = Date.now();
  beat({}, { kind: "btw", text: `Side question from you: ${String(m.body).slice(0, 160)}` });
  let reply = "", forward = "";
  if (!state.started || !state.session) reply = "I'm just getting started and have no session history yet. Ask again in a moment, or use \"Send to session\".";
  else {
    const r = await runHarness({ prompt: ASIDE(process.env.REDPI_HQ_NAME || "the worker") + m.body, fresh: false, fork: true, onEvent() {} }).done;
    const text = (r.final || r.text || "").trim();
    if (!r.ok || !text) reply = `(I couldn't answer that on the side: ${r.error || "no answer"}. Use "Send to session" to ask my live session directly.)`;
    else {
      const fw = /^\s*FORWARD:\s*(.+)$/.exec(text.split("\n")[0] || "");
      if (fw) { forward = fw[1].trim(); reply = text.split("\n").slice(1).join("\n").trim() || `Passed on to my live session: ${forward}`; }
      else reply = text;
    }
  }
  if (forward) await hq("POST", `/api/runs/${RUN}/messages`, { from: "human", to: ME, kind: "command", body: `(relayed from a side question) ${forward}` }).catch(() => {});
  await hq("POST", `/api/runs/${RUN}/messages`, { from: ME, to: "human", kind: "aside", body: forward ? `${reply}\n\n↳ Forwarded to my live session: ${forward}` : reply }).catch(() => {});
  beat({}, { kind: "btw", text: `Answered on the side in ${((Date.now() - started) / 1000).toFixed(1)}s${forward ? " and forwarded an instruction" : ""}`, ms: Date.now() - started, ok: true });
  asideBusy = false;
  if (asides.length) answerAside(asides.shift());
}

// ---------- inbox ----------
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const msgs = await hq("GET", `/api/runs/${RUN}/inbox?for=${encodeURIComponent(ME)}&after=${state.cursor}`);
    if (!msgs.length) return;
    state.cursor = msgs[msgs.length - 1].id;
    save();
    for (const m of msgs) {
      if (m.kind === "aside") { if (asideBusy) asides.push(m); else answerAside(m); continue; }
      if (m.kind === "interrupt" && current) { interrupted = true; kill(current.child); }
      queue.push(m);
    }
    if (!current && queue.length) startTurn(queue.splice(0));
  } catch (e) {
    if (!/fetch failed|aborted|timeout|ECONNREFUSED/i.test(String(e?.message))) beat({}, { kind: "error", text: `inbox: ${String(e?.message || e).slice(0, 300)}` });
  } finally { polling = false; }
}

// Typing in the pane talks to the worker, like the dashboard's "Send to session".
if (process.stdin.isTTY) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const body = line.trim();
    if (!body) return;
    hq("POST", `/api/runs/${RUN}/messages`, { from: "human", to: ME, kind: "command", body }).then(() => say(dim("(sent to the worker; it runs after the current turn)"))).catch((e) => say(red(`could not send: ${e.message}`)));
  });
}

function shutdown(code) {
  kill(current?.child);
  hq("POST", `/api/workers/${ME}/heartbeat`, { launchId: LAUNCH, status: "stopped", events: [{ kind: "session", text: "Worker runner stopped" }] }).catch(() => {}).finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

say(bold(`RedPlan worker ${process.env.REDPI_HQ_NAME || ""} · ${H.name}${state.started ? ` · resuming session ${state.session}` : ""}`));
say(dim(`Messages from HQ run here as ${H.name} turns. Type a line and press Enter to message this worker. Detach with Ctrl-b d.`));
beat({ status: "idle", ...(state.session && state.started ? { sessionFile: state.session } : {}) }, { kind: "session", text: state.started ? `${H.name} worker resumed (session ${state.session})` : `${H.name} worker started` });
setInterval(poll, POLL_MS);
poll();
