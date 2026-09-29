// Watched bash + redpi_job: quick commands unchanged, long ones moved to the background (not
// killed) with a health report, finish and "looks wrong" messages, wait, stop with a reason,
// abort kills the job. Runs the extension against a stub Pi in a temporary agent dir.
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "redpi-jobs-test-"));
Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, REDPI_WATCH_CHECKPOINT_SEC: "4", REDPI_WATCH_QUIET_SEC: "3", REDPI_WATCH_SAMPLE_SEC: "1" });
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); cleanup(); process.exit(1); };
const pids = new Set();
function cleanup() { for (const p of pids) { try { process.kill(-p, "SIGKILL"); } catch {} } rmSync(agentDir, { recursive: true, force: true }); }

const tools = {}, commands = {}, handlers = {}, sent = [], emitted = [];
const pi = {
  registerTool: (d) => { tools[d.name] = d; },
  registerCommand: (n, d) => { commands[n] = d; },
  on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
  events: { emit: (ch, d) => emitted.push({ ch, ...d }), on: () => () => {} },
  sendMessage: (msg, opts) => sent.push({ msg, opts }),
};
const { default: ext } = await import("../extensions/redpi-jobs.ts");
const jobs = await import("../lib/jobs.ts");
ext(pi);
if (!tools.bash || !tools.redpi_job || !commands.jobs) fail("bash, redpi_job and /jobs should be registered", Object.keys(tools));
const ctx = { cwd: agentDir, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined }, isIdle: () => true, ui: { setStatus() {}, notify() {} } };
const bash = async (command, timeout, signal) => {
  try { const r = await tools.bash.execute("t", { command, timeout }, signal, undefined, ctx); return { ok: true, text: r.content[0].text }; }
  catch (e) { return { ok: false, text: e.message }; }
};
const job = async (args) => { const r = await tools.redpi_job.execute("j", args, undefined, undefined, ctx); return r.content[0].text; };
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const idOf = (text) => /job (j[0-9a-z]+)/.exec(text)?.[1];
const track = (id) => { const m = jobs.readMeta(id); if (m?.pid) pids.add(m.pid); return m; };

// 1. Quick commands behave exactly as before: output, exit codes, no leftover job.
let r = await bash("echo hi; echo oops >&2; exit 3");
if (r.ok || !/hi/.test(r.text) || !/oops/.test(r.text) || !/Command exited with code 3/.test(r.text)) fail("quick failing command", r);
r = await bash("for i in 1 2 3; do echo line$i; sleep 0.2; done");
if (!r.ok || r.text.trim() !== "line1\nline2\nline3") fail("quick command output", r);
if (jobs.listJobs().length) fail("quick commands should leave no job behind", jobs.listJobs().map((m) => m.id));
// A short timeout still kills, as before.
r = await bash("sleep 10", 2);
if (r.ok || !/timed out after 2 seconds/.test(r.text)) fail("short timeout should still kill the command", r);

// 2. A long command is moved to the background at the checkpoint, not killed; wait returns when it finishes.
let t0 = Date.now();
r = await bash("echo start; for i in $(seq 1 16); do echo tick $i; sleep 0.5; done; echo end");
let id = idOf(r.text); let m = track(id);
if (!r.ok || !/moved to the background as job/.test(r.text) || !/was NOT stopped/.test(r.text) || !/Verdict:/.test(r.text) || Date.now() - t0 > 8000) fail("long command should come back at the checkpoint with a report", r.text.slice(-800));
if (!/start/.test(r.text) || !/tick/.test(r.text)) fail("output before the checkpoint should be kept", r.text.slice(0, 200));
if (jobs.refresh(m).state !== "running") fail("the job should still be running after the checkpoint", m);
let w = await job({ action: "wait", id, minutes: 1 });
if (!/It finished\./.test(w) || !/exit code 0/.test(w) || !/end/.test(w)) fail("wait should return when the job finishes, with its last output", w);
await sleep(1500);
if (sent.some((s) => s.msg.details?.id === id)) fail("no finish message while the agent was waiting on it", sent);

// 3. Nobody waiting: a finish message wakes the (idle) agent.
r = await bash("for i in $(seq 1 12); do echo work $i; sleep 0.5; done; exit 4");
id = idOf(r.text); track(id);
for (let i = 0; i < 40 && !sent.some((s) => s.msg.details?.id === id); i++) await sleep(250);
const fin = sent.find((s) => s.msg.details?.id === id);
if (!fin || !/finished with exit code 4/.test(fin.msg.content) || !fin.opts.triggerTurn || fin.msg.customType !== "redpi-job") fail("finish message missing or wrong", fin);
if (!emitted.some((e) => e.ch === "redpi:job" && e.kind === "finished" && e.id === id)) fail("finish should be shared with HQ");

// 4. It goes quiet with nothing happening: a "looks stuck" message, and stop needs a reason.
r = await bash("for i in $(seq 1 10); do echo busy $i; sleep 0.5; done; sleep 60");
id = idOf(r.text); m = track(id);
for (let i = 0; i < 60 && !sent.some((s) => s.msg.details?.id === id && s.msg.details.kind === "alert"); i++) await sleep(250);
const alert = sent.find((s) => s.msg.details?.id === id && s.msg.details.kind === "alert");
if (!alert || !/looks stuck/.test(alert.msg.content) || !/nothing is using CPU, disk or network/.test(alert.msg.content) || !/still running/.test(alert.msg.content) || !/Check next:/.test(alert.msg.content)) fail("stuck alert missing or unclear", alert?.msg.content);
if (!/sleep/.test(alert.msg.content)) fail("the report should name the processes", alert.msg.content);
let err = await job({ action: "stop", id, reason: "stuck" }).catch((e) => e.message);
if (!/Give the reason/.test(err)) fail("stop without a real reason should be refused", err);
if (jobs.refresh(m).state !== "running") fail("a refused stop must not stop the job");
const st = await job({ action: "stop", id, reason: "It sleeps for 60 s doing nothing: the test's own stuck step." });
if (!/stopped \(It sleeps/.test(st)) fail("stop with a reason", st);
if (existsSync(`/proc/${m.pid}`) && jobs.refresh(jobs.readMeta(id)).state === "running") fail("stopped job still running");

// 5. Esc (abort) while it runs stops the whole job.
const ac = new AbortController();
const pending = bash("sleep 30 & sleep 30; wait", undefined, ac.signal);
await sleep(1200);
const live = jobs.listJobs().find((j) => j.state === "running" && /sleep 30 &/.test(j.command)); if (live) track(live.id);
ac.abort();
r = await pending;
await sleep(3500);
if (r.ok || !/aborted/i.test(r.text) || !live || jobs.readMeta(live.id).state !== "stopped" || jobs.readMeta(live.id).pid && existsSync(`/proc/${jobs.readMeta(live.id).pid}`)) fail("abort should stop the job and its children", { r, live: live && jobs.readMeta(live.id) });

// 6. start/logs/status/list, and errors in the output are called out.
const started = await job({ action: "start", command: "for i in 1 2 3 4 5 6; do echo \"ERROR: connection refused to db:5432 attempt $i\"; sleep 0.3; done; sleep 20", expectMinutes: 1 });
id = idOf(started); track(id);
if (!/Started job/.test(started)) fail("start", started);
await sleep(2500);
const status = await job({ action: "status", id });
if (!/error-like lines/.test(status) || !/connection refused/.test(status) || !/read the errors/.test(status)) fail("status should call out the errors", status);
const logs = await job({ action: "logs", id, grep: "attempt [56]" });
if (!/attempt 5/.test(logs) || /attempt 1/.test(logs)) fail("logs grep", logs);
if (!new RegExp(id).test(await job({ action: "list" }))) fail("list");
await job({ action: "stop", id, reason: "Test finished checking error reporting." });

cleanup();
console.log("RedPi jobs test passed: quick commands unchanged, short timeouts still kill, long commands move to the background with a report instead of blocking, wait returns on finish, finish and stuck messages wake the agent and reach HQ, stop needs a reason, abort stops the whole job, start/status/logs/list, errors called out.");
process.exit(0);
