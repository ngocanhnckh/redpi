// HQ stall watchdogs: a private hub (temp dir, random port) with shortened timings checks the two failures
// that have frozen whole runs for hours — a worker whose session hangs mid-turn (still "working" but silent),
// and a CEO whose turn is wedged (connected but doing nothing while work waits). A frozen worker wakes the CEO
// (never the human); a frozen CEO is auto-interrupted (the programmatic /reload), and only if that does not
// take, or its terminal is gone, is the human told. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "redpi-stall-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { stdio: ["ignore", "ignore", "inherit"], env: {
  ...process.env, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1",
  REDPI_HQ_WATCH_MS: "150", REDPI_HQ_FREEZE_MS: "500", REDPI_HQ_CEO_PRESENT_MS: "1500", REDPI_HQ_HUMAN_REMIND_MS: "600",
  // Keep the other sweeps out of the way so this test only sees the freeze/stall findings.
  REDPI_HQ_STALL_MS: "600000", REDPI_HQ_PARK_MS: "600000", REDPI_HQ_STAFF_GRACE_MS: "600000",
  REDPI_HQ_CHECKIN_MS: "600000", REDPI_HQ_ALERT_ESCALATE_MS: "600000", REDPI_HQ_ORPHAN_MS: "600000",
} });
process.on("exit", () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await sleep(100); }
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };

const plan = {
  title: "Stall", summary: "Stall test.",
  techStack: [{ name: "Node", package: "node", ecosystem: "npm", uses: "http", source: "https://nodejs.org", verified: true, verifiedFact: "exists" }],
  architecture: { components: [{ id: "api", name: "API", kind: "service" }], links: [] },
  stories: [{ id: "S1", title: "API", userStory: "As a user, I want an API", acceptance: ["works"], tasks: [
    { id: "T1", title: "Endpoints", description: "REST", estimateHours: 2 },
  ] }],
};
async function newRun(title) {
  const runId = (await api("POST", "/api/runs", { projectPath: "/tmp/stall-demo", title })).run.id;
  const pv = await api("POST", `/api/runs/${runId}/plans`, { plan });
  await api("POST", `/api/plans/${pv.id}/decision`, { decision: "approve" });
  await api("PATCH", `/api/runs/${runId}`, { status: "executing" });
  return runId;
}
const hire = (runId, name, role, taskIds = []) => api("POST", `/api/runs/${runId}/workers`, { name, role, cwd: "/tmp/stall-demo", taskIds });
const beat = (w, b) => api("POST", `/api/workers/${w.id}/heartbeat`, b);
const stateOf = (runId) => api("GET", `/api/runs/${runId}`);
const ceoInbox = (runId) => api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`);
const until = async (what, fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) { const v = await fn(); if (v) return v; } fail(`timed out: ${what}`); };

// ---------------------------------------------------------------------------
// 1. A worker frozen mid-turn: still "working" but silent. The CEO is told; the human is not.
// ---------------------------------------------------------------------------
const run1 = await newRun("Frozen worker");
const ana = await hire(run1, "Ana", "backend developer", ["T1"]);
await beat(ana, { status: "working" });
await api("POST", `/api/runs/${run1}/tasks/T1`, { status: "in_progress", actor: ana.id, workerId: ana.id });
await beat(ana, { status: "working" });   // last sign of life; after this, nothing
const frozen = await until("the CEO hears the worker is frozen", async () =>
  (await ceoInbox(run1)).find((m) => m.kind === "system" && /^HQ watch: /.test(m.body) && /Ana has reported "working" but sent nothing to HQ/.test(m.body)));
if (!/looks hung/.test(frozen.body) || !/redplan_resume_worker Ana/.test(frozen.body)) fail("the frozen-worker alert should explain and say how to recover", frozen.body);
{ const s = await stateOf(run1);
  if (s.inbox.some((i) => i.kind === "alert") || s.messages.some((m) => m.recipient === "human")) fail("a frozen worker is the CEO's to fix; the human should not be paged", s.inbox.map((i) => i.title));
  if (!s.alerts.some((a) => a.kind === "frozen" && !a.resolved)) fail("there should be an open frozen alert"); }
// A fresh heartbeat clears it.
await beat(ana, { status: "working" });
await until("the frozen alert clears once the worker beats again", async () => {
  const s = await stateOf(run1); return !s.alerts.some((a) => a.kind === "frozen" && !a.resolved);
});

// ---------------------------------------------------------------------------
// 2. A CEO frozen mid-turn: connected, but silent while a worker's question waits. HQ auto-interrupts it
//    (the programmatic /reload); if it still does nothing, the human is told.
// ---------------------------------------------------------------------------
const run2 = await newRun("Frozen CEO");
const bo = await hire(run2, "Bo", "frontend developer", ["T1"]);
await beat(bo, { status: "idle" });   // idle, so Bo is never mistaken for frozen
const present = async () => api("POST", `/api/runs/${run2}/ceo-events`, { caps: ["aside", "reply", "ticket", "presence"] });
await present();
// Bo asks the CEO something and then the CEO goes silent (never acts on it).
await api("POST", `/api/runs/${run2}/messages`, { from: bo.id, to: "ceo", body: "Which auth library should I use?", needsReply: true });
const keepPresent = setInterval(present, 400);   // the terminal stays connected the whole time
try {
  const wake = await until("HQ auto-interrupts the frozen CEO", async () =>
    (await ceoInbox(run2)).find((m) => m.kind === "interrupt" && m.sender === "hq" && /HQ is waking your session/.test(m.body)));
  if (!/catch up now/.test(wake.body)) fail("the wake should tell the CEO to catch up", wake.body);
  // Still nothing from the CEO: the human gets one ticket.
  const ticket = await until("the human is told the CEO is stuck", async () =>
    (await stateOf(run2)).inbox.find((i) => i.kind === "alert" && /CEO session looks stuck/.test(i.title)));
  if (!/\/reload/.test(ticket.body)) fail("the ticket should tell the human to /reload the CEO", ticket.body);
} finally { clearInterval(keepPresent); }
// The CEO comes back to life (any activity): the stall clears and the ticket resolves.
await api("POST", `/api/runs/${run2}/ceo-events`, { events: [{ kind: "say", text: "Back online, catching up." }] });
await present();
await until("the CEO-stuck ticket resolves once it responds", async () => {
  const s = await stateOf(run2); const it = s.inbox.find((i) => /CEO session looks stuck/.test(i.title));
  return !it || ["resolved", "approved", "declined"].includes(it.status);
});

// ---------------------------------------------------------------------------
// 3. The CEO's terminal went away entirely (presence stale) while work waits: straight to the human.
// ---------------------------------------------------------------------------
// An executing run with no pending work yet, so the terminal can go stale before anything waits on the CEO.
const run3 = (await api("POST", "/api/runs", { projectPath: "/tmp/stall-demo", title: "CEO gone" })).run.id;
await api("PATCH", `/api/runs/${run3}`, { status: "executing" });
await api("POST", `/api/runs/${run3}/ceo-events`, { caps: ["presence"] });   // connected once...
await sleep(1700);   // ...then the terminal stops checking in (longer than CEO_PRESENT_MS) before any work waits
const cy = await hire(run3, "Cy", "backend developer");
await beat(cy, { status: "idle" });   // idle, so Cy is never mistaken for frozen
await api("POST", `/api/runs/${run3}/messages`, { from: cy.id, to: "ceo", body: "Blocked on the schema, can you decide?", needsReply: true });
// With the terminal already gone, work waiting goes straight to the human to reopen/reload it (no interrupt:
// a wake message cannot reach a terminal that is not there).
const goneTicket = await until("the human is told the CEO's terminal is gone", async () =>
  (await stateOf(run3)).inbox.find((i) => i.kind === "alert" && /CEO session looks stuck/.test(i.title) && /terminal has not checked in/.test(i.body)));
if (!/reload/i.test(goneTicket.body)) fail("the gone-terminal ticket should tell the human to reopen or reload it", goneTicket.body);

// ---------------------------------------------------------------------------
// 4. A ticket left unanswered by the human does not silently freeze a run: HQ nudges the CEO to keep moving.
// ---------------------------------------------------------------------------
const run4 = await newRun("Human silent");
const di = await hire(run4, "Di", "backend developer", ["T1"]);
await beat(di, { status: "working" });
await api("POST", `/api/runs/${run4}/tasks/T1`, { status: "in_progress", actor: di.id, workerId: di.id });
await beat(di, { status: "working" });
await api("POST", `/api/runs/${run4}/tasks/T1`, { status: "blocked", waitingOn: "human", actor: "ceo", note: "Need the production API key to finish." });
const nudge = await until("HQ nudges the CEO that the human is still silent", async () =>
  (await ceoInbox(run4)).find((m) => m.kind === "system" && /still has not answered inbox #\d+/.test(m.body) && /keep the run moving/i.test(m.body)));
if (!nudge) fail("the CEO should be told to keep moving while the human is silent");

// ---------------------------------------------------------------------------
// 5. A CEO session that never connects at all on an active run is surfaced to the human (nobody to interrupt).
// ---------------------------------------------------------------------------
const run5 = (await api("POST", "/api/runs", { projectPath: "/tmp/stall-demo", title: "CEO never started" })).run.id;
// Left in planning with no CEO ever checking in: after a grace, the human is told to start it.
const never = await until("the human is told the CEO never started", async () =>
  (await stateOf(run5)).inbox.find((i) => i.kind === "alert" && /CEO session looks stuck/.test(i.title) && /No CEO session has checked in/i.test(i.body)), 8000);
if (!/\/redplan|\/reload/.test(never.body)) fail("the never-started ticket should say how to start the CEO", never.body);

console.log("HQ stall watchdog test passed: a worker frozen mid-turn wakes the CEO (not the human) and clears on the next heartbeat; a CEO frozen while work waits is auto-interrupted and, if it still does nothing, the human is told once and the ticket resolves when it recovers; a CEO whose terminal has gone sends the human straight to /reload; an unanswered human ticket nudges the CEO to keep moving; and a CEO that never connects is surfaced to the human.");
process.exit(0);
