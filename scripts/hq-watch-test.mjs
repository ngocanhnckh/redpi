// HQ watch: a private hub (temp dir, random port) with shortened timings replays the patterns that have
// cost real runs hours, and checks that each one wakes the CEO with a diagnosis within seconds, is
// pressed on the CEO again (never the human) when it keeps happening, clears itself when it stops, and that the CEO gets a
// regular check-in with the numbers. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "redpi-watch-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const HOUR = 6000;   // the watch's "hour" in this test
const proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { stdio: ["ignore", "ignore", "inherit"], env: {
  ...process.env, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1",
  REDPI_HQ_WATCH_MS: "150", REDPI_HQ_WATCH_HOUR_MS: String(HOUR), REDPI_HQ_CHATTER_2H: "12", REDPI_HQ_BURN_TOKENS: "100000",
  REDPI_HQ_REPEAT: "5", REDPI_HQ_ALERT_ESCALATE_MS: "1500", REDPI_HQ_CHECKIN_MS: "2500", REDPI_HQ_STALL_MS: "600000",
  REDPI_HQ_STAFF_GRACE_MS: "600000", REDPI_HQ_PARK_MS: "600000", REDPI_HQ_TASK_TOKEN_STEP: "100000", REDPI_HQ_ORPHAN_MS: "400",
} });
process.on("exit", () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await sleep(100); }
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
const until = async (what, fn, ms = 4000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } fail(`timed out: ${what}`, (await (await fetch(`${base}/api/runs/${runId}/inbox?for=ceo&after=0`, { headers: { authorization: `Bearer ${token}` } })).json()).map((m) => m.body.slice(0, 120))); };

const plan = {
  title: "Watch", summary: "Watch test.",
  techStack: [{ name: "Node", package: "node", ecosystem: "npm", uses: "http", source: "https://nodejs.org", verified: true, verifiedFact: "exists" }],
  architecture: { components: [{ id: "api", name: "API", kind: "service" }], links: [] },
  stories: [{ id: "S1", title: "API", userStory: "As a user, I want an API", acceptance: ["works"], tasks: [
    { id: "T1", title: "Endpoints", description: "REST", estimateHours: 2 },
    { id: "T2", title: "Client", description: "CLI", estimateHours: 2 },
  ] }],
};
const runId = (await api("POST", "/api/runs", { projectPath: "/tmp/watch-demo", title: "Watch" })).body.run.id;
const pv = await api("POST", `/api/runs/${runId}/plans`, { plan });
await api("POST", `/api/plans/${pv.body.id}/decision`, { decision: "approve" });
const hire = async (name, role, taskIds = []) => (await api("POST", `/api/runs/${runId}/workers`, { name, role, cwd: "/tmp/watch-demo", taskIds })).body;
const [rin, noor, mia, ria, kai] = [await hire("Rin", "backend developer", ["T1"]), await hire("Noor", "frontend developer", ["T2"]), await hire("Mia", "backend developer"), await hire("Ria", "independent reviewer"), await hire("Kai", "data engineer")];
const beat = (w, b) => api("POST", `/api/workers/${w.id}/heartbeat`, { status: "working", ...b });
const ceoInbox = async () => (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
const watchMsg = async (re) => (await ceoInbox()).find((m) => m.kind === "system" && /^HQ watch: /.test(m.body) && re.test(m.body));
const state = async () => (await api("GET", `/api/runs/${runId}`)).body;
const send = (from, to, body, extra = {}) => api("POST", `/api/runs/${runId}/messages`, { from: from.id, to: to.id, body, ...extra });

// 1. Talking in circles (like two workers who exchanged 651 messages over 19 hours): caught within seconds.
for (let i = 0; i < 7; i++) { await send(rin, noor, `About the API field names, round ${i}.`); await send(noor, rin, `I still think it should be camelCase, round ${i}.`); }
const chatter = await until("chatter alert to the CEO", () => watchMsg(/(Rin and Noor|Noor and Rin) are talking in circles: 1[2-4] messages to each other/));
if (!/decide the open question yourself/.test(chatter.body)) fail("the alert should say what to do", chatter.body);
// Still happening after the escalation time: the CEO is pressed again; the human is not paged.
await until("pressed on the CEO again", async () => (await ceoInbox()).find((m) => /^HQ watch, STILL HAPPENING after \d+ min\. This is yours to fix now, without the human: .*talking in circles/s.test(m.body)));
const esc = (await state()).alerts.find((a) => a.kind === "chatter");
if (!esc?.escalated || esc.resolved) fail("the chatter alert should be open and escalated", esc);
{ const sx = await state(); if (sx.inbox.some((i) => i.kind === "alert") || sx.messages.some((m) => m.recipient === "human")) fail("watch alerts are the CEO's: nothing should reach the human", [sx.inbox.map((i) => i.kind + ":" + i.title), sx.messages.filter((m) => m.recipient === "human").map((m) => m.sender + ":" + m.kind + ":" + m.body.slice(0, 60))]); }
const pressed = (await ceoInbox()).filter((m) => /talking in circles/.test(m.body)).length;
if (pressed < 2 || pressed > 3) fail("the CEO should hear once, then again at escalation, less often each time (not every minute)", pressed);

// 2. Burning tokens without moving a card.
await beat(mia, { usage: [{ input: 150000, output: 2000, at: Date.now() }] });
await until("burn alert", () => watchMsg(/Mia used 152k tokens in the last \d+ min without moving a card/));
// 3. The same step over and over.
await beat(kai, { events: Array.from({ length: 6 }, () => ({ kind: "tool", text: "bash: npm test -- auth.spec.ts" })) });
await until("repeat alert", () => watchMsg(/Kai repeated the same step 6 times .*"bash: npm test -- auth\.spec\.ts"/));
// 4. Bouncing through review.
const move = (task, status, who, note) => api("POST", `/api/runs/${runId}/tasks/${task}`, { status, note, actor: who.id, workerId: who.id });
await move("T1", "in_progress", rin);
for (let i = 0; i < 3; i++) { await move("T1", "review", rin, `fixed round ${i}`); if (i < 2) await move("T1", "in_progress", ria, `still failing: round ${i}`); }
await until("review loop alert", () => watchMsg(/T1 Endpoints has gone to review 3 times \(author Rin, reviewer Ria\)/));
// 5. Messages to a worker whose session is gone.
await beat(kai, { status: "stopped" });
await send(rin, kai, "Can you check the data export?"); await send(noor, kai, "Kai, the schema changed.");
await until("dead-end alert", () => watchMsg(/2 messages went to Kai, whose session is gone \(from Rin, Noor\)/));
// 6. A question nobody answers (after half the watch hour).
await send(mia, noor, "Which port does the client call?", { needsReply: true });
await until("unanswered alert", () => watchMsg(/Noor has not answered 1 question .*from Mia: "Which port does the client call\?"/), HOUR);

// 7. Token milestones per agent per task: every step (100k here, 5M by default) the CEO checks for leaks
// and loops, once per step, with the facts; a reviewer's tokens count against the task it reviews.
const tokenChecks = async (who) => (await ceoInbox()).filter((m) => m.body.startsWith(`Token check: ${who} `));
await move("T2", "in_progress", noor);
await beat(noor, { usage: [{ input: 60000, output: 1000 }] });
await sleep(300);
if ((await tokenChecks("Noor")).length) fail("no token check below the first step");
await beat(noor, { usage: [{ input: 50000, cacheRead: 10000 }], context: { percent: 71 } });
const tc = await until("first token check", async () => (await tokenChecks("Noor"))[0]);
for (const want of [/has now used 100k\+ tokens on T2 Client/, /started \d+ min ago/, /estimate 2h/, /context 71% full/, /Check that nothing is leaking or looping/, /HQ checks again at 200k/]) if (!want.test(tc.body)) fail(`token check should include ${want}`, tc.body);
await beat(noor, { usage: [{ input: 20000 }] });
await beat(noor, { usage: [{ input: 90000 }] });
await until("second token check", async () => (await tokenChecks("Noor")).some((m) => /used 200k\+ tokens on T2/.test(m.body)));
if ((await tokenChecks("Noor")).length !== 2) fail("each step should be checked exactly once", (await tokenChecks("Noor")).map((m) => m.body.slice(0, 60)));
await beat(ria, { usage: [{ input: 120000 }] });
await until("reviewer token check", async () => (await tokenChecks("Ria")).some((m) => /used 100k\+ tokens on T1 Endpoints .*3 trips through review/.test(m.body)));
const cardTokens = (await state()).taskTokens;
if (!(cardTokens.T2 >= 230000 && cardTokens.T1 >= 120000)) fail("the board should show tokens per task", cardTokens);

// It clears itself when the pattern stops: the chatter falls out of the two-hour window.
await until("chatter alert resolved", async () => (await state()).alerts.find((a) => a.kind === "chatter")?.resolved, 3 * HOUR);
// 7. Check-in: the numbers and what to look for, on the schedule.
const checkin = await until("check-in", async () => (await ceoInbox()).reverse().find((m) => /^Check-in \(every/.test(m.body) && /Tokens per task so far/.test(m.body)), 8000);
for (const want of [/card moves? since the last one/, /Board: todo \d+; in progress \d+/, /in review 1: T1 waiting on Ria/, /Open alerts: /, /Tokens per task so far: T2 2\d\dk, T1 1\d\dk/, /post the human a 2-3 line status/, /do nothing and do not reply/]) if (!want.test(checkin.body)) fail(`check-in should include ${want}`, checkin.body);

// 8. Work with nobody on it: Noor's session ends while T2 is in progress. HQ marks the departure as "lost" (not a quiet
// "finished"), tells the CEO within seconds who to bring back or hand it to, and clears it once someone is on it.
if ((await state()).workers.find((w) => w.id === kai.id)?.left_reason !== "finished") fail("Kai left holding nothing: a quiet 'finished'");
await beat(noor, { status: "stopped" });
const nw = (await state()).workers.find((w) => w.id === noor.id);
if (nw.alive || nw.left_reason !== "lost") fail("Noor left holding T2: should be 'lost'", nw);
const orphan = await until("orphan alert", () => watchMsg(/Nobody is working on T2 \(in progress\): Noor's session ended .* ago\. Bring Noor back with redplan_resume_worker/));
if (!/hand it to someone else now/.test(orphan.body)) fail("the orphan alert should say how to hand the work on", orphan.body);
// Dismissing Noor and handing T2 to Mia (alive): the task moves, Mia gets a brief, the alert clears.
const dis = await api("POST", `/api/workers/${noor.id}/dismiss`, { reason: "Session lost; Mia takes over.", handoffTo: "mia", actor: "ceo" });
if (dis.status !== 200 || dis.body.handedOver.join() !== "T2" || dis.body.wasRunning) fail("dismiss with handoff", dis);
const after = await state();
if (after.tasks.find((t) => t.id === "T2").worker_id !== mia.id) fail("T2 should belong to Mia now");
if (!after.messages.some((m) => m.recipient === mia.id && m.kind === "brief" && /Noor was dismissed and you now own:\n- T2 Client \[in_progress\]/.test(m.body))) fail("Mia should get a brief for T2");
await until("orphan alert resolved", async () => (await state()).alerts.find((a) => a.kind === "orphan")?.resolved);

console.log("RedPi HQ watch test passed: agents talking in circles, token burn without progress, repeated steps, review loops, messages to a gone worker, work left with nobody on it and unanswered questions each wake the CEO with a diagnosis within seconds, token milestones per agent per task (checked once per step, reviewers' tokens counted against the task they review), keep-happening alerts are pressed on the CEO again, less often each time, and never page the human, alerts clear when the pattern stops, a worker who leaves mid-task is lost (one who leaves with nothing is a quiet finished), dismissing with a handoff moves the work and briefs the new owner, and the CEO gets a regular check-in with the numbers.");
process.exit(0);
