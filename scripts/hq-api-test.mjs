#!/usr/bin/env node
// RedPi HQ API test: runs a private hub (temp dir, random port) and exercises the plan,
// approval, worker, task, message, and auth flows. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schedulePlan, validatePlan } from "../hq/schedule.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "redpi-hq-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const fail = (msg, extra) => { console.error(`FAIL: ${msg}`, extra ?? ""); cleanup(); process.exit(1); };
let proc;
function cleanup() { try { proc?.kill(); } catch {} rmSync(dir, { recursive: true, force: true }); }

const plan = {
  title: "Support chat", summary: "A support chat backed by an agent.",
  techStack: [{ name: "Deep Agents", package: "deepagents", ecosystem: "pypi", uses: "create_deep_agent", source: "https://pypi.org/project/deepagents/", verified: true, verifiedFact: "create_deep_agent exists" }],
  architecture: { components: [{ id: "ui", name: "Web UI", kind: "ui" }, { id: "api", name: "API", kind: "service" }], links: [{ from: "ui", to: "api", label: "REST" }] },
  stories: [
    { id: "S1", title: "Backend", userStory: "As a user, I want answers", acceptance: ["answers"], tasks: [
      { id: "T1", title: "API skeleton", description: "FastAPI app", estimateHours: 4 },
      { id: "T2", title: "Agent", description: "Deep agent", estimateHours: 6, dependsOn: ["T1"] },
    ] },
    { id: "S2", title: "UI", userStory: "As a user, I want a chat box", acceptance: ["chat"], tasks: [
      { id: "T3", title: "Chat UI", description: "React chat", estimateHours: 3 },
    ] },
    { id: "S3", title: "Launch", userStory: "As an operator, I want it deployed", acceptance: ["live"], dependsOn: ["S1", "S2"], tasks: [
      { id: "T4", title: "Deploy", description: "Docker", estimateHours: 2 },
    ] },
  ],
};

// Pure scheduling checks.
const v = validatePlan(plan);
if (v.errors.length) fail("valid plan rejected", v.errors);
const s = schedulePlan(plan);
if (s.duration !== 12) fail(`duration should be 12h (T1 4 + T2 6 + T4 2), got ${s.duration}`);
if (s.criticalPath.join(",") !== "T1,T2,T4") fail(`critical path should be T1,T2,T4, got ${s.criticalPath}`);
if (s.tasks.T3.critical || s.tasks.T3.slack !== 7) fail(`T3 should have 7h slack, got ${s.tasks.T3.slack}`);
if (s.maxParallel !== 2) fail(`max parallel should be 2, got ${s.maxParallel}`);
const cyclic = structuredClone(plan);
cyclic.stories[0].tasks[0].dependsOn = ["T2"];
if (!validatePlan(cyclic).errors.some((e) => e.includes("cycle"))) fail("cycle not detected");
const badDep = structuredClone(plan);
badDep.stories[1].tasks[0].dependsOn = ["T99"];
if (!validatePlan(badDep).errors.some((e) => e.includes("T99"))) fail("unknown dependency not detected");
// Flows: broken references are errors, gaps are warnings.
if (!validatePlan(plan).warnings.some((w) => w.startsWith("no flows"))) fail("a plan without flows should be warned");
const sid = plan.stories[0].id;
const flow = { id: "login", title: "Sign in", storyIds: [sid], steps: [
  { id: "s1", where: "Browser · Next.js form", action: "User types username and password", kind: "user" },
  { id: "s2", where: "NestJS AuthService", action: "Password matches the hash?", kind: "decision", next: [{ to: "s3", label: "yes" }, { to: "s4", label: "no" }] },
  { id: "s3", where: "NestJS", action: "Issue a session", end: true },
  { id: "s4", where: "Browser", action: "Show an error", next: [{ to: "s1", label: "try again" }] } ] };
const withFlow = validatePlan({ ...plan, flows: [flow] });
if (withFlow.errors.length) fail(`valid flow rejected: ${withFlow.errors.join("; ")}`);
if (withFlow.warnings.some((w) => w.startsWith("no flows"))) fail("flows present but still warned as missing");
const badFlow = validatePlan({ ...plan, flows: [{ ...flow, storyIds: ["NOPE"], steps: [...flow.steps.slice(0, 3), { id: "s4", action: "x", next: [{ to: "zz" }] }, { id: "s4", action: "dup" }] }] });
for (const want of ["unknown story NOPE", "unknown step zz", "duplicate step id s4"]) if (!badFlow.errors.some((e) => e.includes(want))) fail(`flow check missing: ${want} (${badFlow.errors.join("; ")})`);
if (!validatePlan({ ...plan, flows: [{ ...flow, steps: [flow.steps[0], { ...flow.steps[1], next: [{ to: "s1" }] }] }] }).warnings.some((w) => w.includes("a decision should list each branch"))) fail("one-branch decision not warned");

// A fake `claude` on the hub's PATH: installed harnesses are detected with `<bin> --version`.
const fakeBin = join(dir, "fakebin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
const PATH_NO_CODEX = [fakeBin, ...(process.env.PATH || "").split(":").filter((d) => !existsSync(join(d, "codex")) && !existsSync(join(d, "opencode")))].join(":");
proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { env: { ...process.env, PATH: PATH_NO_CODEX, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1", REDPI_HQ_PARK_MS: "600", REDPI_HQ_STOP_GRACE_MS: "500", REDPI_HQ_PLAN_NUDGE_MS: "400", REDPI_HQ_STAFF_NUDGE_MS: "300", REDPI_HQ_STAFF_GRACE_MS: "300" }, stdio: "ignore" });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// Auth: no token → 401; token but no CSRF header on a mutation → 403.
if ((await fetch(`${base}/api/runs`)).status !== 401) fail("unauthenticated request was allowed");
const noHeader = await fetch(`${base}/api/runs`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
if (noHeader.status !== 403) fail(`mutation without X-RedPi-HQ should be 403, got ${noHeader.status}`);
const page = await fetch(`${base}/?t=${token}`, { redirect: "manual" });
if (page.status !== 302 || !/redpi_hq=/.test(page.headers.get("set-cookie") || "")) fail("token link did not set the session cookie");

const created = await api("POST", "/api/runs", { projectPath: "/tmp/demo-project", title: "Support chat", request: "build it" });
const runId = created.body.run.id;
const other = await api("POST", "/api/runs", { projectPath: "/tmp/demo-project", title: "Second plan, same folder" });
if (other.body.run.id === runId || other.body.project.id !== created.body.project.id) fail("two runs in one folder must share the project and stay separate");

const bad = await api("POST", `/api/runs/${runId}/plans`, { plan: cyclic });
if (bad.status !== 400 || !bad.body.errors?.length) fail("invalid plan accepted", bad.body);
const v1 = await api("POST", `/api/runs/${runId}/plans`, { plan });
if (v1.status !== 200 || v1.body.version !== 1 || v1.body.schedule.duration !== 12) fail("plan v1 not stored", v1.body);

// Review comments: drafts anchored to text or a diagram spot, sent to the CEO as one numbered message.
if ((await api("POST", `/api/plans/${v1.body.id}/decision`, { decision: "changes" })).status !== 400) fail("empty change request accepted");
const c1 = await api("POST", `/api/plans/${v1.body.id}/comments`, { anchor: { kind: "text", tab: "stories", target: "task:T2", label: "Stories & tasks › Task T2 · Agent", prefix: "" }, quote: "Deep agent", body: "Use LangGraph instead" });
const c2 = await api("POST", `/api/plans/${v1.body.id}/comments`, { anchor: { kind: "pin", tab: "architecture", diagram: "arch", x: 1.7, y: 0.25, target: "component:api", label: "Architecture diagram › API (service)" }, body: "Split this into two services" });
const c3 = await api("POST", `/api/plans/${v1.body.id}/comments`, { anchor: { kind: "text", tab: "overview", target: "summary", label: "Summary" }, quote: "support chat", body: "typo" });
if (c1.status !== 200 || c2.body.anchor.x !== 1 || c2.body.status !== "draft") fail("comment not stored or pin position not clamped", c2.body);
if ((await api("POST", `/api/plans/${v1.body.id}/comments`, { body: " " })).status !== 400) fail("empty comment accepted");
await api("PATCH", `/api/plans/${v1.body.id}/comments/${c1.body.id}`, { body: "Use LangGraph instead of a hand-rolled loop" });
await api("DELETE", `/api/plans/${v1.body.id}/comments/${c3.body.id}`);
const withComments = (await api("GET", `/api/plans/${v1.body.id}`)).body;
if (withComments.comments.length !== 2 || withComments.comments[0].body !== "Use LangGraph instead of a hand-rolled loop") fail("comment edit/delete wrong", withComments.comments);
const changes = await api("POST", `/api/plans/${v1.body.id}/decision`, { decision: "changes", comment: "use Postgres" });
if (changes.body.status !== "changes_requested") fail("changes decision not recorded", changes.body);
let inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
const req = inbox.find((m) => m.kind === "decision");
if (!req || !req.body.includes("use Postgres") || !req.body.includes('#1 [Stories & tasks › Task T2 · Agent] on "Deep agent": Use LangGraph instead of a hand-rolled loop')
  || !req.body.includes("#2 [Architecture diagram › API (service)]: Split this into two services") || !req.body.includes('"changes"')) fail("CEO did not receive the numbered, anchored comments", req?.body);
if ((await api("POST", `/api/plans/${v1.body.id}/comments`, { body: "late" })).status !== 409) fail("comment accepted on a decided plan");
if ((await api("DELETE", `/api/plans/${v1.body.id}/comments/${c1.body.id}`)).status !== 409) fail("sent comment deleted");
if ((await api("POST", `/api/runs/${runId}/plans`, { plan: { ...plan, changes: "not a list" } })).status !== 400) fail("bad changes list accepted");

const v2 = await api("POST", `/api/runs/${runId}/plans`, { plan: { ...plan, changes: ["#1 Agent now uses LangGraph", "#2 API split into auth and chat"] } });
const v2view = (await api("GET", `/api/plans/${v2.body.id}`)).body;
if (v2view.previous?.version !== 1 || v2view.previous.comments.map((c) => c.n).join() !== "1,2" || v2view.plan.changes.length !== 2) fail("new version does not show the previous comments and changes", v2view.previous);
if ((await api("GET", `/api/plans/${v1.body.id}`)).body.latestId !== v2.body.id) fail("old version does not link to the latest");
await api("POST", `/api/plans/${v2.body.id}/comments`, { anchor: { kind: "text", tab: "tech", target: "tech:deepagents", label: "Tech stack › Deep Agents" }, quote: "deepagents", body: "Pin the version" });
// Harness per task: Pi by default, Claude Code for T3 (installed), Codex refused (not installed).
const hs = (await api("GET", "/api/harnesses?refresh=1")).body;
if (!hs.find((h) => h.id === "claude")?.installed || hs.find((h) => h.id === "codex")?.installed || hs.find((h) => h.id === "claude").version !== "9.9.9 (Claude Code)") fail("harness detection wrong", hs);
if ((await api("PUT", `/api/runs/${runId}/harness`, { task: "T3", harness: "codex" })).status !== 400) fail("a harness that is not installed was accepted");
if ((await api("PUT", `/api/runs/${runId}/harness`, { task: "T9", harness: "claude" })).status !== 400) fail("unknown task accepted");
await api("PUT", `/api/runs/${runId}/harness`, { harness: "claude" });
await api("PUT", `/api/runs/${runId}/harness`, { task: "T1", harness: "pi" });
let choices = (await api("PUT", `/api/runs/${runId}/harness`, { task: "T2", harness: "pi" })).body;
if (choices["*"] !== "claude" || choices.T1 !== "pi") fail("harness choices wrong", choices);
choices = (await api("PUT", `/api/runs/${runId}/harness`, { harness: "pi" })).body;
if (Object.keys(choices).join() !== "*") fail("choosing for every task should clear per-task choices", choices);
for (const [task, harness] of [["T1", "pi"], ["T3", "claude"]]) await api("PUT", `/api/runs/${runId}/harness`, { task, harness });
if ((await api("GET", `/api/plans/${v2.body.id}`)).body.harness.T3 !== "claude") fail("plan view lacks harness choices");
const approved = await api("POST", `/api/plans/${v2.body.id}/decision`, { decision: "approve" });
if (approved.body.status !== "approved") fail("approve not recorded");
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
if (!inbox.some((m) => m.kind === "decision" && m.body.includes("APPROVED") && m.body.includes("#1 [Tech stack › Deep Agents]") && m.body.includes("Keep these notes in mind"))) fail("approval did not carry the notes");
if (!inbox.some((m) => m.kind === "decision" && m.body.includes("Pi (RedPi): T1, T2, T4; Claude Code: T3") && m.body.includes("pass that harness to redplan_spawn_worker"))) fail("approval did not list the harness per task", inbox.at(-1)?.body);
if ((await api("GET", `/api/runs/${runId}`)).body.tasks.find((t) => t.id === "T3").harness !== "claude") fail("task harness not stored at approval");
if ((await api("POST", `/api/plans/${v2.body.id}/decision`, { decision: "approve" })).status !== 409) fail("double decision allowed");
let state = (await api("GET", `/api/runs/${runId}`)).body;
if (state.tasks.length !== 4 || state.run.status !== "approved") fail("approval did not create tasks", state.run);

const alex = (await api("POST", `/api/runs/${runId}/workers`, { name: "Alex", role: "backend developer", cwd: "/tmp/demo-project", taskIds: ["T1", "T2"], brief: "Build the API", launchId: "L1" })).body;
if ((await api("POST", `/api/runs/${runId}/workers`, { name: "Pat", role: "frontend developer", cwd: "/tmp/demo-project", taskIds: ["T3"] })).status !== 400) fail("a Pi worker was given a Claude Code task");
const peter = (await api("POST", `/api/runs/${runId}/workers`, { name: "Peter", role: "frontend developer", cwd: "/tmp/demo-project", taskIds: ["T3"], harness: "claude" })).body;
// Staffing: one person holding most of the critical path is called out to the CEO.
if (!(peter.warnings || []).some((w) => /Alex owns 2 of 3 critical-path tasks \(10h of 12h\)/.test(w))) fail("critical-path load warning missing", peter.warnings);
if (peter.harness !== "claude" || peter.harnessName !== "Claude Code") fail("worker harness not stored", peter);
if ((await api("PUT", `/api/runs/${runId}/harness`, { task: "T3", harness: "pi" })).status !== 409) fail("harness changed after approval");
if ((await api("POST", `/api/runs/${runId}/workers`, { name: "Alex", role: "x", cwd: "/tmp" })).status !== 409) fail("duplicate worker name allowed");
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=${alex.id}&after=0`)).body;
if (inbox.length !== 1 || inbox[0].kind !== "brief") fail("worker brief not delivered", inbox);

await api("POST", `/api/runs/${runId}/messages`, { from: peter.id, to: alex.id, body: "What JSON shape does /chat return?" });
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=${alex.id}&after=${inbox[0].id}`)).body;
if (inbox.length !== 1 || inbox[0].senderName !== "Peter") fail("teammate message not delivered", inbox);
const peterInbox = (await api("GET", `/api/runs/${runId}/inbox?for=${peter.id}&after=0`)).body;
if (peterInbox.length) fail("sender received its own message", peterInbox);

await api("POST", `/api/workers/${alex.id}/heartbeat`, { status: "working", lastMessage: "Scaffolding FastAPI", events: [{ kind: "tool", text: "bash: uv init" }] });
const t1 = await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "in_progress", actor: alex.id });
if (t1.body.status !== "in_progress") fail("task update failed", t1.body);
const detail = (await api("GET", `/api/workers/${alex.id}`)).body;
if (detail.worker.current_task !== "T1" || detail.events.length !== 1 || detail.teammates[0].name !== "Peter") fail("worker detail wrong", detail);

// Closure rules: reasons are required, and the author cannot self-approve under independent review.
if ((await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "blocked", actor: alex.id })).status !== 400) fail("blocked without a reason was accepted");
if ((await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "done", actor: "ceo" })).status !== 400) fail("done without a verification note was accepted");
if ((await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "done", note: "tests pass", actor: alex.id })).status !== 409) fail("author marked own task done under independent review");
await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "review", note: "implemented, 3 tests pass", actor: alex.id });
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
if (!inbox.some((m) => m.body.includes("ready for review"))) fail("CEO not told a task is ready for review");
const reviewed = await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "done", note: "reviewed diff, tests pass", actor: peter.id });
if (reviewed.body.status !== "done") fail("independent reviewer could not mark done", reviewed.body);
const history = (await api("GET", `/api/runs/${runId}/tasks/T1/history`)).body;
if (history.map((h) => h.to_status).join(",") !== "in_progress,review,done" || history[2].actorName !== "Peter") fail("transition history wrong", history);

// Handoff: reassigns and records atomically, and tells the new owner.
if ((await api("POST", `/api/runs/${runId}/tasks/T2`, { handoffTo: "Peter", actor: alex.id })).status !== 400) fail("handoff without a note accepted");
const handed = await api("POST", `/api/runs/${runId}/tasks/T2`, { handoffTo: "peter", note: "schema done; endpoints next", actor: alex.id });
if (handed.body.worker_id !== peter.id) fail("handoff did not reassign", handed.body);
const peterMsgs = (await api("GET", `/api/runs/${runId}/inbox?for=${peter.id}&after=0`)).body;
if (!peterMsgs.some((m) => m.body.startsWith("Handing T2"))) fail("new owner not told about the handoff");
if ((await api("GET", `/api/runs/${runId}/tasks/T2/history`)).body.at(-1)?.target !== peter.id) fail("handoff not in history");

// Blockers go to whoever must act: a teammate named in the note (they are told directly), the CEO by
// default, the human only when asked for explicitly or clearly needed. Only human blocks are "needs you".
const blockT2 = (body) => api("POST", `/api/runs/${runId}/tasks/T2`, { status: "blocked", actor: peter.id, ...body });
const bt = await blockT2({ note: "waiting on Alex to merge the schema migration" });
const blockedOn = () => api("GET", `/api/runs/${runId}`).then((r) => r.body.tasks.find((t) => t.id === "T2").blocked_on);
if (bt.status !== 200 || (await blockedOn()) !== alex.id) fail("a blocker naming a teammate should wait on that teammate", bt.body);
if (!(await api("GET", `/api/runs/${runId}/inbox?for=${alex.id}&after=0`)).body.some((m) => /T2 .*blocked waiting on you/.test(m.body))) fail("the teammate was not told the task waits on them");
if (!(await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body.some((m) => m.kind === "system" && /T2 .*waiting on Alex/.test(m.body))) fail("the CEO was not told about the blocker");
if ((await api("GET", `/api/runs/${runId}/tasks/T2/history`)).body.at(-1)?.target !== alex.id) fail("blocker target not in history");
await blockT2({ note: "the vendor sandbox is down" });
if ((await blockedOn()) !== "ceo") fail("an unnamed blocker should default to the CEO, not the human");
await blockT2({ note: "need the production database password", waitingOn: "human" });
if ((await blockedOn()) !== "human") fail("waitingOn human not recorded");
if ((await blockT2({ note: "x", waitingOn: "Bob" })).status !== 400) fail("unknown waitingOn accepted");
await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "todo", actor: "ceo" });
if ((await blockedOn()) !== null) fail("blocked_on should clear when the task moves on");

// Stale launch: a heartbeat from an earlier process must be ignored.
const stale = await api("POST", `/api/workers/${alex.id}/heartbeat`, { launchId: "OLD", status: "working", lastMessage: "ghost" });
if (!stale.body.stale || (await api("GET", `/api/workers/${alex.id}`)).body.worker.last_message === "ghost") fail("stale-launch heartbeat was applied");
await api("POST", `/api/workers/${alex.id}/heartbeat`, { launchId: "L1", sessionFile: "/tmp/s.jsonl", needsInput: { count: 1, reason: "rate limit" }, context: { tokens: 1000, window: 200000, percent: 0.5 },
  events: [{ kind: "tool", text: "bash: npm test", ms: 1234, ok: false }] });
const w2 = (await api("GET", `/api/workers/${alex.id}`)).body;
if (w2.worker.session_file !== "/tmp/s.jsonl" || w2.worker.needs_input?.reason !== "rate limit" || w2.worker.context?.tokens !== 1000) fail("session file / needs input / context not stored", w2.worker);
if (!w2.events.some((e) => e.ms === 1234 && e.ok === 0)) fail("timed tool event not stored", w2.events);

// Parked ladder (REDPI_HQ_PARK_MS=600): idle + in_progress + silent → worker nudge → CEO → human.
await api("POST", `/api/runs/${runId}/tasks/T3`, { status: "in_progress", actor: peter.id, workerId: peter.id });
await api("POST", `/api/workers/${peter.id}/heartbeat`, { status: "idle" });
const seen = async (who, text) => (await api("GET", `/api/runs/${runId}/inbox?for=${who}&after=0`)).body.some((m) => m.body.includes(text));
let ladder = false;
for (let i = 0; i < 60 && !ladder; i++) { await new Promise((r) => setTimeout(r, 150)); ladder = (await api("GET", `/api/workers/${peter.id}`)).body.worker.needs_human; }
if (!ladder) fail("parked worker never escalated to the human");
if (!(await seen(peter.id, "still own in-progress work")) || !(await seen("ceo", "Peter is parked")) || !(await seen("human", "Peter needs you"))) fail("wake ladder steps missing");
await api("POST", `/api/workers/${peter.id}/heartbeat`, { status: "working" });
if ((await api("GET", `/api/workers/${peter.id}`)).body.worker.parked) fail("activity did not reset the ladder");

// Independent review can't be skipped: straight to done is refused; through review it closes.
const skip = await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "done", note: "verified", actor: "ceo" });
if (skip.status !== 409 || !/move it to review first/.test(skip.body.error)) fail("done without review should be refused", skip);
for (const id of ["T2", "T3", "T4"]) { await api("POST", `/api/runs/${runId}/tasks/${id}`, { status: "review", note: "ready", actor: "ceo" }); await api("POST", `/api/runs/${runId}/tasks/${id}`, { status: "done", note: "verified", actor: "ceo" }); }
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
if (!inbox.some((m) => m.body.startsWith("All tasks are done"))) fail("CEO not told that all tasks are done");

const list = (await api("GET", "/api/runs")).body;
if (!list.some((r) => r.id === runId && r.done === 4 && r.workers === 2)) fail("run list counts wrong", list);

// Nothing left: each worker is told once to report and stop.
if (!(await seen(alex.id, "All your tasks are done")) || !(await seen(peter.id, "All your tasks are done"))) fail("workers with nothing left should be told to report and stop");
// Reopening a closed task: not by someone who did not close it; the closer or CEO once, with a reason; then only the human.
let rr = await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "in_progress", actor: alex.id, note: "found a bug" });
if (rr.status !== 409 || !/closed by CEO\. Only they, the CEO or the human can reopen it/.test(rr.body.error)) fail("the author reopened a task someone else closed", rr);
if ((await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "in_progress", actor: "ceo" })).status !== 400) fail("reopen without a reason allowed");
if ((await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "in_progress", actor: "ceo", note: "the retry path is untested" })).status !== 200) fail("the CEO could not reopen once");
await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "review", note: "retry covered", actor: alex.id }); await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "done", note: "checked", actor: "ceo" });
rr = await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "review", actor: "ceo", note: "again" });
if (rr.status !== 409 || !/already been reopened once/.test(rr.body.error)) fail("a second reopen should need the human", rr);
if ((await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "review", actor: "human", note: "one more look" })).status !== 200) fail("the human could not reopen");
await api("POST", `/api/runs/${runId}/tasks/T2`, { status: "done", note: "fine", actor: "human" });

// Wake rules: a question needs a reply, a statement does not, unless the sender says so.
const msg = (body, extra = {}) => api("POST", `/api/runs/${runId}/messages`, { from: alex.id, to: peter.id, body, ...extra });
const q = (await msg("Which port does the chat UI call?")).body.id, fyi = (await msg("FYI: the API branch is merged.")).body.id, asked = (await msg("Please review my diff.", { needsReply: true })).body.id;
const flags = Object.fromEntries((await api("GET", `/api/runs/${runId}/inbox?for=${peter.id}&after=0`)).body.filter((m) => [q, fyi, asked].includes(m.id)).map((m) => [m.id, m.needs_reply]));
if (flags[q] !== 1 || flags[fyi] !== 0 || flags[asked] !== 1) fail("needs_reply flags wrong", flags);
// Back-and-forth between two teammates: a warning, then refused with a pointer to the CEO.
let warned = null, refused = null;
for (let i = 0; i < 40 && !refused; i++) { const r = await msg(`Round ${i}: ok.`); if (r.body.warning && !warned) warned = r.body.warning; if (r.status === 429) refused = r.body.error; }
if (!/Wrap up/.test(warned || "") || !/send the CEO one message/.test(refused || "")) fail("pair back-and-forth not capped", { warned, refused });

// Token use per model call, from workers and the CEO, summed per person with a timeline.
await api("POST", `/api/workers/${alex.id}/heartbeat`, { usage: [{ input: 1000, output: 200, cacheRead: 5000, cost: 0.01, model: "m1" }, { input: 10, output: 5 }] });
await api("POST", `/api/runs/${runId}/ceo-events`, { usage: [{ input: 300, output: 50 }] });
const uv = (await api("GET", `/api/runs/${runId}`)).body.usage;
const ua = uv.totals.find((u) => u.worker_id === alex.id), uc = uv.totals.find((u) => u.worker_id === "ceo");
if (!ua || ua.input !== 1010 || ua.output !== 205 || ua.cacheRead !== 5000 || ua.calls !== 2 || !uc || uc.output !== 50 || !uv.series.length) fail("token usage wrong", uv);

// Screenshots: stored, served to signed-in viewers only, listed, and announced on the event board.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const shotId = (await api("POST", `/api/runs/${runId}/screenshots`, { from: peter.id, taskId: "T3", caption: "Chat UI at 390px", data: png })).body.id;
if (!shotId) fail("screenshot upload failed");
if ((await api("POST", `/api/runs/${runId}/screenshots`, { from: peter.id, data: Buffer.from("not an image").toString("base64") })).status !== 400) fail("non-image accepted as a screenshot");
if ((await api("POST", `/api/runs/${runId}/screenshots`, { from: "someone", data: png })).status !== 400) fail("screenshot from outside the run accepted");
const img = await fetch(`${base}/api/screenshots/${shotId}`, { headers: { authorization: `Bearer ${token}` } });
if (img.status !== 200 || img.headers.get("content-type") !== "image/png" || Buffer.from(await img.arrayBuffer()).toString("base64") !== png) fail("screenshot not served back");
if ((await fetch(`${base}/api/screenshots/${shotId}`)).status !== 401) fail("screenshots must need sign-in");
const sv = (await api("GET", `/api/runs/${runId}`)).body;
if (sv.screenshots[0]?.caption !== "Chat UI at 390px" || sv.screenshots[0].task_id !== "T3" || !sv.events.some((e) => e.kind === "shot" && /Chat UI at 390px/.test(e.text))) fail("screenshot not listed or announced", sv.screenshots);

// Finishing a run closes the workers: heartbeats answer "stop", and HQ closes any that linger.
const run3 = (await api("POST", "/api/runs", { projectPath: "/tmp/stop-project", title: "Stop test" })).body.run.id;
const w3 = (await api("POST", `/api/runs/${run3}/workers`, { name: "Kai", role: "developer", cwd: "/tmp/stop-project", launchId: "K2" })).body;
const staleHb = (await api("POST", `/api/workers/${w3.id}/heartbeat`, { launchId: "K1", status: "working" })).body;
if (!staleHb.stale || !/newer launch/.test(staleHb.stop || "")) fail("a stale process should be told to stop", staleHb);
await api("PATCH", `/api/runs/${run3}`, { status: "done" });
const hb = (await api("POST", `/api/workers/${w3.id}/heartbeat`, { launchId: "K2", status: "idle" })).body;
if (!/run is complete/.test(hb.stop || "") || !(await api("GET", `/api/runs/${run3}/inbox?for=${w3.id}&after=0`)).body.some((m) => /Your session is closing/.test(m.body))) fail("workers not asked to close when the run is done", hb);
let closed = false;
for (let i = 0; i < 40 && !closed; i++) { await new Promise((r) => setTimeout(r, 150)); const wv = (await api("GET", `/api/workers/${w3.id}`)).body.worker; closed = !wv.alive && wv.status === "stopped"; }
if (!closed) fail("a worker that did not close was not closed by HQ");
// Resuming it clears the stop.
await api("PATCH", `/api/workers/${w3.id}`, { launchId: "K3" });
if ((await api("POST", `/api/workers/${w3.id}/heartbeat`, { launchId: "K3", status: "working" })).body.stop) fail("a resumed worker was still told to stop");

// A CEO researching too long without a plan gets one nudge.
const run4 = (await api("POST", "/api/runs", { projectPath: "/tmp/slow-plan", title: "Slow plan" })).body.run.id;
let nudged = false;
for (let i = 0; i < 40 && !nudged; i++) { await new Promise((r) => setTimeout(r, 150)); nudged = (await api("GET", `/api/runs/${run4}/inbox?for=ceo&after=0`)).body.filter((m) => /without submitting a plan/.test(m.body)).length === 1; }
if (!nudged) fail("no planning nudge");
// The CEO session checks in (with what its RedPi can do), so the dashboard can tell an out-of-date CEO.
if ((await api("GET", `/api/runs/${run4}`)).body.run.ceo_seen) fail("no CEO has checked in yet");
await api("POST", `/api/runs/${run4}/ceo-events`, { caps: ["aside", "reply", "ticket", "presence"] });
const r4 = (await api("GET", `/api/runs/${run4}`)).body.run;
if (!(Date.now() - r4.ceo_seen < 5000) || !JSON.parse(r4.ceo_caps).includes("aside")) fail("CEO presence not recorded", r4);

// Tickets: the human adds work straight to the board (no plan), with attachments; the CEO is told to
// get it done now; a ticket reopens a finished run; assigning gives the worker the full ticket.
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNQOJAARAwQCgAiDgUBwxGaiQAAAABJRU5ErkJggg==", "base64");
if ((await api("POST", `/api/runs/${run3}/tickets`, { title: " " })).status !== 400) fail("a ticket without a title should be refused");
if ((await api("POST", `/api/runs/${run3}/tickets`, { title: "x", priority: "asap" })).status !== 400) fail("an unknown priority should be refused");
if ((await api("POST", `/api/runs/${run3}/tickets`, { title: "x", attachments: [{ name: "big.bin", data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }] })).status !== 413) fail("an attachment over 10 MB should be refused");
const tk = await api("POST", `/api/runs/${run3}/tickets`, { title: "Checkout button does nothing on Safari", description: "Steps:\n1. Open /checkout\n2. Click **Pay**", priority: "urgent", hours: 2,
  attachments: [{ name: "safari.png", data: PNG1.toString("base64") }, { name: "../../console log.txt", data: Buffer.from("TypeError: x is undefined\n").toString("base64") }, { name: "page.html", data: Buffer.from("<script>alert(1)</script>").toString("base64") }] });
if (tk.status !== 200 || tk.body.id !== "TK-1" || tk.body.kind !== "ticket" || tk.body.priority !== "urgent" || tk.body.status !== "todo" || tk.body.hours !== 2) fail("ticket not created", tk);
const rv3 = (await api("GET", `/api/runs/${run3}`)).body;
if (rv3.run.status !== "executing") fail("a ticket should reopen a finished run", rv3.run.status);
const atts = rv3.attachments.filter((a) => a.task_id === "TK-1");
if (atts.length !== 3 || atts[0].mime !== "image/png" || atts[1].name !== "console log.txt" || atts[1].mime !== "text/plain") fail("attachments not stored with safe names and types", atts);
if (!rv3.transitions.some((t) => t.task_id === "TK-1" && t.to_status === "todo" && t.actor === "human")) fail("a new ticket should be in the task history");
const ceoTicket = (await api("GET", `/api/runs/${run3}/inbox?for=ceo&after=0`)).body.find((m) => m.kind === "ticket");
if (!ceoTicket || !/TK-1 · URGENT/.test(ceoTicket.body) || !/act on it right away/.test(ceoTicket.body) || !/free now: Kai/.test(ceoTicket.body) || !/Click \*\*Pay\*\*/.test(ceoTicket.body) || !ceoTicket.needs_reply) fail("the CEO was not told to act on the urgent ticket", ceoTicket);
const paths = [...ceoTicket.body.matchAll(/: (\/\S+)$/gm)].map((m) => m[1]);
if (paths.length !== 3 || !paths.every((f) => f.startsWith(join(dir, "attachments")) && existsSync(f) && (statSync(f).mode & 0o077) === 0)) fail("attachment paths for the agents missing or not private", paths);
const attImg = await fetch(`${base}/api/attachments/${atts[0].id}`, { headers: { authorization: `Bearer ${token}` } });
if (attImg.status !== 200 || attImg.headers.get("content-type") !== "image/png" || !/^inline/.test(attImg.headers.get("content-disposition"))) fail("image attachment should show inline");
const html = await fetch(`${base}/api/attachments/${atts[2].id}`, { headers: { authorization: `Bearer ${token}` } });
if (!/^attachment/.test(html.headers.get("content-disposition")) || /html/.test(html.headers.get("content-type")) || !/sandbox/.test(html.headers.get("content-security-policy"))) fail("non-image attachments must download, never render", Object.fromEntries(html.headers));
if ((await fetch(`${base}/api/attachments/${atts[0].id}`)).status !== 401) fail("attachments need sign-in");
// The CEO assigns it: a brief is required; the worker gets the whole ticket and the card is theirs.
if ((await api("POST", `/api/runs/${run3}/tasks/TK-1`, { assignTo: "Kai", actor: "ceo" })).status !== 400) fail("assigning without a brief should be refused");
const asg = await api("POST", `/api/runs/${run3}/tasks/TK-1`, { assignTo: "Kai", actor: "ceo", note: "Reproduce in WebKit, fix the handler, add a test." });
if (asg.status !== 200 || asg.body.worker_id !== w3.id) fail("assign failed", asg);
const brief = (await api("GET", `/api/runs/${run3}/inbox?for=${w3.id}&after=0`)).body.find((m) => m.kind === "brief" && /TK-1/.test(m.body));
if (!brief || !/You now own TK-1 · URGENT/.test(brief.body) || !/Reproduce in WebKit/.test(brief.body) || !/safari\.png/.test(brief.body) || !/URGENT: put it before anything else/.test(brief.body)) fail("assigned worker did not get the full ticket", brief);
// A ticket from the CEO (a request typed in its terminal) goes on the board without a message back to it.
const tk2 = await api("POST", `/api/runs/${run3}/tickets`, { from: "ceo", title: "Add a dark mode toggle" });
if (tk2.body.id !== "TK-2" || tk2.body.priority !== "normal" || (await api("GET", `/api/runs/${run3}/inbox?for=ceo&after=0`)).body.filter((m) => m.kind === "ticket").length !== 1) fail("CEO ticket wrong", tk2);
if ((await api("POST", `/api/runs/${run3}/tickets`, { from: w3.id, title: "x" })).status !== 400) fail("workers cannot file tickets");
// A worker spawned for a ticket gets the ticket in its brief.
const w5 = (await api("POST", `/api/runs/${run3}/workers`, { name: "Zoe", role: "frontend developer", cwd: "/tmp/stop-project", taskIds: ["TK-2"], brief: "Build the toggle." })).body;
const zb = (await api("GET", `/api/runs/${run3}/inbox?for=${w5.id}&after=0`)).body.find((m) => m.kind === "brief");
if (!zb || !/Build the toggle\./.test(zb.body) || !/Ticket TK-2 · NORMAL priority/.test(zb.body)) fail("spawned worker's brief lacks the ticket", zb);

// Home page data: projects with their live team, active ones first.
await api("POST", "/api/runs", { projectPath: "/tmp/other-project", title: "Other project" });
await api("PATCH", `/api/runs/${runId}`, { status: "executing" });
const projects = (await api("GET", "/api/projects")).body;
const demo = projects.find((p) => p.path === "/tmp/demo-project");
if (!demo || demo.runs !== 2 || demo.active_runs !== 2 || demo.workers.length !== 2 || demo.done !== 4) fail("project summary wrong", demo);
if (!projects.some((p) => p.path === "/tmp/other-project" && p.runs === 1)) fail("second project missing from home", projects);
const proj = (await api("GET", `/api/projects/${demo.id}`)).body;
if (proj.runs.length !== 2 || !proj.runs.some((r) => r.id === runId)) fail("project page runs wrong", proj);

// Browser sign-in: once auth.json exists, pages need a password; RedPi's bearer token keeps working.
const setPassword = (user, pw) => {
  const salt = randomBytes(16);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, user, salt: salt.toString("hex"), hash: scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"), N: 16384, r: 8, p: 1 }));
};
const cookieJar = page.headers.get("set-cookie").split(";")[0];
if ((await fetch(`${base}/api/runs`, { headers: { cookie: cookieJar } })).status !== 200) fail("token cookie should work before a password exists");
setPassword("boss", "correct horse");
await new Promise((r) => setTimeout(r, 20));
if ((await fetch(`${base}/api/runs`, { headers: { cookie: cookieJar } })).status !== 401) fail("old token cookie still works after a password was set");
const gate = await fetch(`${base}/runs/${runId}?x=1`, { redirect: "manual" });
if (gate.status !== 302 || gate.headers.get("location") !== `/login?next=${encodeURIComponent(`/runs/${runId}?x=1`)}`) fail("page did not redirect to sign-in", gate.headers.get("location"));
const tlink = await fetch(`${base}/?t=${token}`, { redirect: "manual" });
if (/redpi_hq=/.test(tlink.headers.get("set-cookie") || "")) fail("token link must not sign browsers in once a password exists");
for (const evil of ["/static/..%2fserver.mjs", "/static/%2e%2e/server.mjs", "/static/..%2f..%2fpackage.json", "/static/office"])
  { const r = await fetch(base + evil, { redirect: "manual" }); if (r.status === 200 || /machine-wide hub|"name": "redpi"/.test(await r.text())) fail(`static path escaped hq/web: ${evil}`); }
if ((await fetch(`${base}/login`)).status !== 200 || (await fetch(`${base}/static/hq.css`)).status !== 200) fail("login page and static files must be public");
if ((await api("GET", "/api/runs")).status !== 200) fail("bearer token stopped working");
const login = (user, password, headers = { "x-redpi-hq": "1" }) => fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ user, password, next: "//evil.example" }) });
if ((await login("boss", "correct horse", {})).status !== 403) fail("login without X-RedPi-HQ should be 403");
if ((await login("boss", "wrong")).status !== 401) fail("wrong password accepted");
const ok = await login("boss", "correct horse");
const okBody = await ok.json();
const sess = (ok.headers.get("set-cookie") || "").split(";")[0];
if (ok.status !== 200 || !sess.startsWith("redpi_hq_s=") || okBody.next !== "/") fail("sign-in failed or allowed an open redirect", okBody);
if ((await fetch(`${base}/api/projects`, { headers: { cookie: sess } })).status !== 200) fail("session cookie rejected");
if ((await fetch(`${base}/runs/${runId}`, { headers: { cookie: sess }, redirect: "manual" })).status !== 200) fail("signed-in page did not load");
const who = await (await fetch(`${base}/api/session`, { headers: { cookie: sess } })).json();
if (!who.signedIn || who.user !== "boss" || !who.passwordSet) fail("session endpoint wrong", who);
if ((await fetch(`${base}/api/projects`, { headers: { cookie: sess.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).status !== 401) fail("tampered session accepted");
const basic = "Basic " + Buffer.from("boss:correct horse").toString("base64");
if ((await fetch(`${base}/api/projects`, { headers: { authorization: basic } })).status !== 200) fail("HTTP Basic auth rejected");
if ((await fetch(`${base}/api/projects`, { headers: { authorization: "Basic " + Buffer.from("boss:nope").toString("base64") } })).status !== 401) fail("bad Basic auth accepted");
setPassword("boss", "a new password");
await new Promise((r) => setTimeout(r, 20));
if ((await fetch(`${base}/api/projects`, { headers: { cookie: sess } })).status !== 401) fail("changing the password did not sign browsers out");
if ((await fetch(`${base}/api/projects`, { headers: { authorization: basic } })).status !== 401) fail("cached Basic auth survived a password change");
let locked = false;
for (let i = 0; i < 10 && !locked; i++) locked = (await login("boss", `guess${i}`)).status === 429;
if (!locked) fail("repeated wrong passwords were never rate limited");

// Reviews go straight to a reviewer (not through the CEO); work sent back returns to its author, never
// to the reviewer; the same reviewer re-checks it; a growing review queue and work waiting for hands are
// reported to the CEO with what to do.
{
  const rid = (await api("POST", "/api/runs", { projectPath: "/tmp/demo-review", title: "Review flow" })).body.run.id;
  const pv = await api("POST", `/api/runs/${rid}/plans`, { plan });
  await api("POST", `/api/plans/${pv.body.id}/decision`, { decision: "approve" });
  const hire = async (name, role, taskIds = []) => (await api("POST", `/api/runs/${rid}/workers`, { name, role, cwd: "/tmp/demo-review", taskIds })).body;
  const bo = await hire("Bo", "backend developer", ["T1", "T3"]);
  const ria = await hire("Ria", "independent reviewer");
  const set = (task, body) => api("POST", `/api/runs/${rid}/tasks/${task}`, body);
  const inboxOf = async (who) => (await api("GET", `/api/runs/${rid}/inbox?for=${who}&after=0`)).body;
  await set("T1", { status: "in_progress", actor: bo.id, workerId: bo.id });
  await set("T1", { status: "review", note: "pytest: 5 passed", actor: bo.id });
  const brief = (await inboxOf(ria.id)).find((m) => m.kind === "brief" && /^Review T1 now/.test(m.body));
  if (!brief || !/Author: Bo/.test(brief.body) || !/pytest: 5 passed/.test(brief.body) || !/- answers/.test(brief.body)) fail("a task in review should go straight to the reviewer with the author, their verification and the criteria", brief);
  if ((await inboxOf("ceo")).some((m) => /T1 .*ready for review/.test(m.body))) fail("the CEO should not have to relay reviews when a reviewer is running");
  // The reviewer marking "reviewing" by moving it to in_progress is refused without findings, and never takes it over.
  const noFindings = await set("T1", { status: "in_progress", actor: ria.id, workerId: ria.id });
  if (noFindings.status !== 400 || !/needs the findings/.test(noFindings.body.error)) fail("sending work back without findings should be refused", noFindings);
  const back = await set("T1", { status: "in_progress", note: "POST /chat returns 500 on an empty body", actor: ria.id, workerId: ria.id });
  if (back.body.worker_id !== bo.id || back.body.reviewer_id !== ria.id) fail("work sent back should stay with its author and remember its reviewer", back.body);
  if (!(await inboxOf(bo.id)).some((m) => m.kind === "brief" && /Changes requested on T1 \(API skeleton\) by Ria:\nPOST \/chat returns 500/.test(m.body))) fail("the author should get the findings");
  await set("T1", { status: "review", note: "fixed, empty body now 400", actor: bo.id });
  if (!(await inboxOf(ria.id)).some((m) => /^Review T1 now \(back from your findings/.test(m.body))) fail("the same reviewer should re-check it");
  // Review queue: three waiting on one reviewer tells the CEO to add a reviewer.
  const cy = await hire("Cy", "frontend developer", ["T2"]);
  for (const [task, who] of [["T3", bo], ["T2", cy]]) { await set(task, { status: "in_progress", actor: who.id, workerId: who.id }); await set(task, { status: "review", note: "done", actor: who.id }); }
  if (!(await inboxOf("ceo")).some((m) => /Review queue: Ria has 3 tasks waiting/.test(m.body))) fail("a growing review queue should be reported to the CEO");
  // Work waiting for hands: once T1-T3 are done, T4 can start, nobody owns it, and Bo and Cy are free.
  for (const task of ["T1", "T2", "T3"]) await set(task, { status: "done", note: "reviewed, tests pass", actor: ria.id });
  let advice;
  for (let i = 0; i < 40 && !advice; i++) { await new Promise((r) => setTimeout(r, 100)); advice = (await inboxOf("ceo")).find((m) => /Work is waiting while Bo, Cy are free: T4 \(unassigned\)/.test(m.body)); }
  if (!advice) fail("the CEO should be told to give waiting work to a free builder", (await inboxOf("ceo")).map((m) => m.body.slice(0, 90)));
}

// Dismissing workers the team no longer needs: refused while they still own building work (hand it over or
// put it back on the board first), their open work returns to the board, their reviews go to another
// reviewer, their session is told to close, and they leave quietly ("dismissed", not "lost").
{
  const rid = (await api("POST", "/api/runs", { projectPath: "/tmp/demo-dismiss", title: "Dismiss" })).body.run.id;
  const pv = await api("POST", `/api/runs/${rid}/plans`, { plan });
  await api("POST", `/api/plans/${pv.body.id}/decision`, { decision: "approve" });
  const hire = async (name, role, taskIds = []) => (await api("POST", `/api/runs/${rid}/workers`, { name, role, cwd: "/tmp/demo-dismiss", taskIds })).body;
  const [bo, ria, rex] = [await hire("Bo", "backend developer", ["T1", "T3"]), await hire("Ria", "independent reviewer"), await hire("Rex", "independent reviewer")];
  const beat = (w, b = {}) => api("POST", `/api/workers/${w.id}/heartbeat`, { status: "idle", ...b });
  for (const w of [bo, ria, rex]) await beat(w);
  const set = (task, body) => api("POST", `/api/runs/${rid}/tasks/${task}`, body);
  const inboxOf = async (who) => (await api("GET", `/api/runs/${rid}/inbox?for=${who}&after=0`)).body;
  const st = async () => (await api("GET", `/api/runs/${rid}`)).body;
  const dismiss = (w, b) => api("POST", `/api/workers/${w.id}/dismiss`, { reason: "No more backend work.", actor: "ceo", ...b });
  await set("T1", { status: "in_progress", actor: bo.id, workerId: bo.id });
  await set("T1", { status: "review", note: "pytest: 5 passed", actor: bo.id });
  const reviewer = (await st()).tasks.find((t) => t.id === "T1").reviewer_id;
  await set("T3", { status: "in_progress", actor: bo.id, workerId: bo.id });
  const refused = await dismiss(bo);
  if (refused.status !== 409 || !/Bo still owns T3 \(in progress\)/.test(refused.body.error) || /T1/.test(refused.body.error)) fail("dismissing a worker who owns building work should be refused, naming it (work in review is not theirs to finish)", refused);
  const back = await dismiss(bo, { returnToBoard: true });
  if (back.status !== 200 || back.body.returned.join() !== "T3" || !back.body.wasRunning) fail("dismiss with returnToBoard", back);
  const t3 = (await st()).tasks.find((t) => t.id === "T3");
  if (t3.status !== "todo" || t3.worker_id) fail("T3 should be back on the board, unassigned", t3);
  const hb = await beat(bo);
  if (!/dismissed from this run: No more backend work/.test(hb.body.stop || "")) fail("the dismissed worker's next heartbeat should tell it to close", hb.body);
  if (!(await inboxOf(bo.id)).some((m) => m.kind === "system" && /You have been dismissed/.test(m.body))) fail("the dismissed worker should be told why");
  await beat(bo, { status: "stopped" });
  const gone = (await st()).workers.find((w) => w.id === bo.id);
  if (gone.alive || gone.left_reason !== "dismissed") fail("a dismissed worker should leave as dismissed", gone);
  if ((await dismiss(bo)).body.already !== true) fail("dismissing twice is a no-op");
  // The reviewer of T1 is dismissed: T1 goes to the other reviewer.
  const [rv, other] = reviewer === ria.id ? [ria, rex] : [rex, ria];
  const rr = await dismiss(rv, { reason: "One reviewer is enough." });
  if (rr.status !== 200 || rr.body.rerouted.join() !== other.name) fail("a dismissed reviewer's reviews should go to another reviewer", rr);
  const t1 = (await st()).tasks.find((t) => t.id === "T1");
  if (t1.reviewer_id !== other.id || !(await inboxOf(other.id)).some((m) => /^Review T1 now/.test(m.body))) fail("the other reviewer should own and be briefed on T1", t1);
  const bad = await dismiss(other, { handoffTo: "Bo" });
  if (bad.status !== 400 || !/Bo is not running/.test(bad.body.error)) fail("handing work to a worker who left should be refused", bad);
}

console.log("RedPi HQ API test passed: scheduling + critical path, validation, auth + CSRF, plan approval loop, workers, inbox, closure rules, review gate, reviews routed straight to reviewers and sent-back work kept with its author, dismissing workers (refused while they own work; work back on the board; reviews rerouted; quiet exit), staffing advice, history, handoff, blockers routed to whoever must act, stale launches, parked ladder, stop when done, tickets (attachments, urgent handling, assign, reopening a finished run), reopen limits, needs-reply flags, back-and-forth cap, token usage, screenshots, closing workers when the run is done, planning nudge, CEO presence, projects home, password sign-in, plan review comments, harness per task.");
cleanup();
