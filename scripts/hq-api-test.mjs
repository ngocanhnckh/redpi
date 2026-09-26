#!/usr/bin/env node
// RedPi HQ API test: runs a private hub (temp dir, random port) and exercises the plan,
// approval, worker, task, message, and auth flows. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { env: { ...process.env, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1", REDPI_HQ_PARK_MS: "600" }, stdio: "ignore" });
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

const changes = await api("POST", `/api/plans/${v1.body.id}/decision`, { decision: "changes", comment: "use Postgres" });
if (changes.body.status !== "changes_requested") fail("changes decision not recorded", changes.body);
let inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
if (!inbox.some((m) => m.kind === "decision" && m.body.includes("use Postgres"))) fail("CEO did not receive the change request", inbox);

const v2 = await api("POST", `/api/runs/${runId}/plans`, { plan });
const approved = await api("POST", `/api/plans/${v2.body.id}/decision`, { decision: "approve" });
if (approved.body.status !== "approved") fail("approve not recorded");
if ((await api("POST", `/api/plans/${v2.body.id}/decision`, { decision: "approve" })).status !== 409) fail("double decision allowed");
let state = (await api("GET", `/api/runs/${runId}`)).body;
if (state.tasks.length !== 4 || state.run.status !== "approved") fail("approval did not create tasks", state.run);

const alex = (await api("POST", `/api/runs/${runId}/workers`, { name: "Alex", role: "backend developer", cwd: "/tmp/demo-project", taskIds: ["T1", "T2"], brief: "Build the API", launchId: "L1" })).body;
const peter = (await api("POST", `/api/runs/${runId}/workers`, { name: "Peter", role: "frontend developer", cwd: "/tmp/demo-project", taskIds: ["T3"] })).body;
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

for (const id of ["T2", "T3", "T4"]) await api("POST", `/api/runs/${runId}/tasks/${id}`, { status: "done", note: "verified", actor: "ceo" });
inbox = (await api("GET", `/api/runs/${runId}/inbox?for=ceo&after=0`)).body;
if (!inbox.some((m) => m.body.startsWith("All tasks are done"))) fail("CEO not told that all tasks are done");

const list = (await api("GET", "/api/runs")).body;
if (!list.some((r) => r.id === runId && r.done === 4 && r.workers === 2)) fail("run list counts wrong", list);

console.log("RedPi HQ API test passed: scheduling + critical path, validation, auth + CSRF, plan approval loop, workers, inbox, closure rules, review gate, history, handoff, stale launches, parked ladder.");
cleanup();
