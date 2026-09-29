#!/usr/bin/env node
// RedPi HQ: one machine-wide hub for RedPlan plans, runs, workers, and messages.
// One SQLite database for every project on the machine; nothing is written into
// project folders, so concurrent projects never collide on paths.
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { schedulePlan, validatePlan } from "./schedule.mjs";
import { DEFAULT_HARNESS, HARNESS_IDS, HARNESSES, detectHarnesses, interactiveCommand } from "./harnesses.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const PORT = Number(process.env.REDPI_HQ_PORT || 47291);
// LAN-reachable by default (the dashboard is viewed from other machines); every request needs the token.
const HOST = process.env.REDPI_HQ_HOST || "0.0.0.0";
// Tests run workers on a private tmux server; real runs use the default one.
const TMUX = process.env.REDPI_TMUX_SOCKET ? ["-L", process.env.REDPI_TMUX_SOCKET] : [];
// Changes whenever the server code changes, so clients can restart a stale hub.
export const VERSION = createHash("sha1").update(readFileSync(join(HERE, "server.mjs"))).update(readFileSync(join(HERE, "schedule.mjs"))).update(readFileSync(join(HERE, "harnesses.mjs"))).digest("hex").slice(0, 12);

mkdirSync(HQ_DIR, { recursive: true });
const TOKEN_PATH = join(HQ_DIR, "token");
if (!existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
try { chmodSync(TOKEN_PATH, 0o600); } catch {}
const TOKEN = readFileSync(TOKEN_PATH, "utf8").trim();

// ---------- browser login ----------
// RedPi asks for a username and password the first time RedPlan or /hq runs and writes
// auth.json (scrypt hash). Browsers sign in with it; RedPi itself and its workers keep
// using the bearer token. Before a password exists, the old ?t=<token> links still work.
const AUTH_PATH = join(HQ_DIR, "auth.json");
const SECRET_PATH = join(HQ_DIR, "session-secret");
if (!existsSync(SECRET_PATH)) writeFileSync(SECRET_PATH, randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
const SESSION_SECRET = readFileSync(SECRET_PATH, "utf8").trim();
const SESSION_DAYS = 30;
let authCache = { mtime: -1, auth: null };
function loadAuth() {
  let mtime;
  try { mtime = statSync(AUTH_PATH).mtimeMs; } catch { authCache = { mtime: -1, auth: null }; return null; }
  if (mtime !== authCache.mtime) {
    let auth = null;
    try { const a = JSON.parse(readFileSync(AUTH_PATH, "utf8")); if (a.user && a.salt && a.hash) auth = a; } catch {}
    authCache = { mtime, auth };
  }
  return authCache.auth;
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function checkPassword(user, password) {
  const auth = loadAuth();
  if (!auth) return Promise.resolve(false);
  const { N = 16384, r = 8, p = 1 } = auth;
  return new Promise((resolve) => scrypt(String(password), Buffer.from(auth.salt, "hex"), 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
    resolve(!err && safeEqual(user, auth.user) && safeEqual(key.toString("hex"), auth.hash));
  }));
}
// Signed with the password hash too, so changing the password signs everyone out.
const sessionSig = (user, exp, auth) => createHmac("sha256", SESSION_SECRET).update(`${user}.${exp}.${auth.hash}`).digest("base64url");
function makeSession(user) {
  const exp = now() + SESSION_DAYS * 86400000;
  return `${Buffer.from(user).toString("base64url")}.${exp}.${sessionSig(user, exp, loadAuth())}`;
}
function sessionUser(req) {
  const auth = loadAuth();
  const m = /(?:^|;\s*)redpi_hq_s=([^;]+)/.exec(req.headers.cookie || "");
  if (!auth || !m) return null;
  const [u, exp, sig] = decodeURIComponent(m[1]).split(".");
  const user = Buffer.from(u || "", "base64url").toString();
  if (!sig || Number(exp) < now() || user !== auth.user) return null;
  return safeEqual(sig, sessionSig(user, exp, auth)) ? user : null;
}
// HTTP Basic auth for scripts (curl -u). Verified headers are cached briefly: scrypt is slow on purpose.
const basicOk = new Map();
async function basicUser(req) {
  const h = /^Basic (.+)$/.exec(req.headers.authorization || "")?.[1];
  const auth = loadAuth();
  if (!h || !auth) return null;
  const key = createHash("sha256").update(`${auth.hash}:${h}`).digest("hex");
  if ((basicOk.get(key) || 0) > now()) return auth.user;
  const raw = Buffer.from(h, "base64").toString(), i = raw.indexOf(":");
  if (i < 0 || !(await checkPassword(raw.slice(0, i), raw.slice(i + 1)))) return null;
  if (basicOk.size > 100) basicOk.clear();
  basicOk.set(key, now() + 5 * 60000);
  return auth.user;
}
// Slow down password guessing: 8 failures per address per 10 minutes, then a lockout.
const failures = new Map();
function loginAllowed(ip) {
  const f = failures.get(ip);
  if (!f || f.until < now()) { failures.delete(ip); return true; }
  return f.count < 8;
}
function loginFailed(ip) {
  const f = failures.get(ip);
  if (!f || f.until < now()) failures.set(ip, { count: 1, until: now() + 10 * 60000 });
  else f.count++;
}

const db = new DatabaseSync(join(HQ_DIR, "hq.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, request TEXT, status TEXT NOT NULL,
    ceo_session TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, schedule TEXT NOT NULL,
    warnings TEXT NOT NULL, status TEXT NOT NULL, comment TEXT, created INTEGER NOT NULL, decided INTEGER);
  CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, cwd TEXT NOT NULL,
    branch TEXT, tmux TEXT, status TEXT NOT NULL, current_task TEXT, last_message TEXT, activity TEXT, alive INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE (run_id, name));
  CREATE TABLE IF NOT EXISTS tasks (run_id TEXT NOT NULL, id TEXT NOT NULL, story_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    worker_id TEXT, note TEXT, updated INTEGER NOT NULL, PRIMARY KEY (run_id, id));
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS task_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT NOT NULL, from_status TEXT,
    to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT, target TEXT, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS plan_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, run_id TEXT NOT NULL, anchor TEXT NOT NULL,
    quote TEXT, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', n INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, sent INTEGER);
  CREATE INDEX IF NOT EXISTS plan_comments_plan ON plan_comments (plan_id, id);
  CREATE TABLE IF NOT EXISTS task_harness (run_id TEXT NOT NULL, task_id TEXT NOT NULL, harness TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (run_id, task_id));
  CREATE INDEX IF NOT EXISTS messages_run ON messages (run_id, id);
  CREATE INDEX IF NOT EXISTS transitions_task ON task_transitions (run_id, task_id, id);
  CREATE INDEX IF NOT EXISTS events_worker ON events (worker_id, id);
  CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, worker_id TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, model TEXT, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS usage_run ON usage (run_id, created);
  CREATE TABLE IF NOT EXISTS screenshots (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, worker_id TEXT NOT NULL, task_id TEXT, caption TEXT, file TEXT NOT NULL,
    mime TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS screenshots_run ON screenshots (run_id, created);
  CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    bytes INTEGER NOT NULL, file TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS attachments_task ON attachments (run_id, task_id);
`);

// Columns added after the first release: ALTER only when missing, so existing hubs upgrade in place.
for (const [table, col, type] of [
  ["workers", "session_file", "TEXT"], ["workers", "launch_id", "TEXT"], ["workers", "needs_input", "TEXT"], ["workers", "context", "TEXT"],
  ["workers", "parked_level", "INTEGER NOT NULL DEFAULT 0"], ["workers", "parked_at", "INTEGER"], ["workers", "needs_human", "TEXT"],
  ["events", "ms", "INTEGER"], ["events", "ok", "INTEGER"],
  ["workers", "harness", "TEXT NOT NULL DEFAULT 'pi'"], ["tasks", "harness", "TEXT NOT NULL DEFAULT 'pi'"],
  ["tasks", "blocked_on", "TEXT"],
  ["messages", "needs_reply", "INTEGER NOT NULL DEFAULT 0"],
  ["workers", "stop_requested", "TEXT"], ["workers", "stop_at", "INTEGER"],
  ["runs", "plan_nudged", "INTEGER"],
  // Tickets: tasks the human (or the CEO, for a request typed in its terminal) adds without a plan.
  // The CEO session's presence: when it last checked in, and what its RedPi can do (side answers, tickets).
  ["runs", "ceo_seen", "INTEGER"], ["runs", "ceo_caps", "TEXT"],
  ["tasks", "kind", "TEXT"], ["tasks", "priority", "TEXT"], ["tasks", "description", "TEXT"], ["tasks", "hours", "REAL"], ["tasks", "created", "INTEGER"],
  // Who reviews a task (it comes back to them after findings), and the last staffing nudge to the CEO.
  ["tasks", "reviewer_id", "TEXT"], ["runs", "staff_nudged", "INTEGER"], ["runs", "staff_key", "TEXT"],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Parked = alive, idle, owns in_progress work, and silent this long. Each ladder step waits this long again.
const PARK_MS = Number(process.env.REDPI_HQ_PARK_MS || 5 * 60 * 1000);
// A CEO still researching this long without a plan gets one nudge to submit what it has.
const PLAN_NUDGE_MS = Number(process.env.REDPI_HQ_PLAN_NUDGE_MS || 30 * 60 * 1000);
// Workers asked to stop (run done) close themselves; after this long HQ closes their tmux session.
const STOP_GRACE_MS = Number(process.env.REDPI_HQ_STOP_GRACE_MS || 3 * 60 * 1000);
// Staffing: at most this many builders; a staffing nudge to the CEO at most this often.
const MAX_BUILDERS = Number(process.env.REDPI_HQ_MAX_BUILDERS || 10);
const STAFF_NUDGE_MS = Number(process.env.REDPI_HQ_STAFF_NUDGE_MS || 10 * 60 * 1000);
// ...and only when the same work has been waiting this long (not while the CEO is still spawning).
const STAFF_GRACE_MS = Number(process.env.REDPI_HQ_STAFF_GRACE_MS || 3 * 60 * 1000);
const REVIEWER_RE = /review|qa|audit/i;
// Teammate back-and-forth per pair per hour: a warning at the first number, refused at the second.
const PAIR_WARN = 16, PAIR_MAX = 30;
const SHOTS_DIR = join(HQ_DIR, "screenshots");
const FILES_DIR = join(HQ_DIR, "attachments");
const PRIORITIES = ["urgent", "high", "normal", "low"];

const now = () => Date.now();
const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const TASK_STATUSES = ["todo", "in_progress", "review", "blocked", "done"];

// Earlier hubs marked every CEO message to the human as needing a reply; only questions do.
run(`UPDATE messages SET needs_reply = 0 WHERE recipient = 'human' AND sender = 'ceo' AND needs_reply = 1 AND rtrim(body, ' ' || char(9) || char(10) || char(13)) NOT LIKE '%?'`);

const RUN_STATUSES = ["planning", "awaiting_approval", "approved", "executing", "done", "cancelled"];

// ---------- live updates (server-sent events) ----------
const listeners = new Set();
function notify(runId, type) {
  const line = `data: ${JSON.stringify({ runId, type, at: now() })}\n\n`;
  for (const l of listeners) if (!l.runId || l.runId === runId) l.res.write(line);
}

// ---------- domain ----------
function ensureProject(path) {
  const existing = one("SELECT * FROM projects WHERE path = ?", path);
  if (existing) return existing;
  const p = { id: shortId("prj"), path, name: basename(path) || path, created: now() };
  run("INSERT INTO projects (id, path, name, created) VALUES (?, ?, ?, ?)", p.id, p.path, p.name, p.created);
  return p;
}

function participantName(runId, id) {
  if (id === "ceo") return "CEO";
  if (id === "human") return "You";
  if (id === "all") return "Everyone";
  return one("SELECT name FROM workers WHERE id = ? AND run_id = ?", id, runId)?.name || id;
}

function addMessage(runId, sender, recipient, kind, body, needsReply = false) {
  const r = run("INSERT INTO messages (run_id, sender, recipient, kind, body, needs_reply, created) VALUES (?, ?, ?, ?, ?, ?, ?)", runId, sender, recipient, kind, String(body), needsReply ? 1 : 0, now());
  touchRun(runId);
  notify(runId, "message");
  return Number(r.lastInsertRowid);
}

function touchRun(runId, status) {
  if (status) run("UPDATE runs SET status = ?, updated = ? WHERE id = ?", status, now(), runId);
  else run("UPDATE runs SET updated = ? WHERE id = ?", now(), runId);
}

function planView(row) {
  if (!row) return null;
  return { id: row.id, runId: row.run_id, version: row.version, status: row.status, comment: row.comment, created: row.created, decided: row.decided,
    plan: JSON.parse(row.json), schedule: JSON.parse(row.schedule), warnings: JSON.parse(row.warnings) };
}

function runView(runId) {
  const r = one("SELECT * FROM runs WHERE id = ?", runId);
  if (!r) return null;
  const project = one("SELECT * FROM projects WHERE id = ?", r.project_id);
  const plans = all("SELECT id, version, status, created FROM plans WHERE run_id = ? ORDER BY version", runId);
  const latest = planView(one("SELECT * FROM plans WHERE run_id = ? ORDER BY version DESC LIMIT 1", runId));
  const workers = all("SELECT * FROM workers WHERE run_id = ? ORDER BY created", runId).map(workerView);
  const tasks = all("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid", runId);
  const messages = all("SELECT * FROM (SELECT * FROM messages WHERE run_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id", runId)
    .map((m) => ({ ...m, senderName: participantName(runId, m.sender), recipientName: participantName(runId, m.recipient) }));
  // For the event board and the project charts: every task move, the latest worker
  // actions, and tool calls per worker in 5-minute buckets over the last two hours.
  const transitions = all("SELECT id, task_id, from_status, to_status, actor, reason, target, created FROM task_transitions WHERE run_id = ? ORDER BY id", runId);
  // Tool calls and the agents' own plain-language updates ("say"), each with its own cap so
  // busy tool use never crowds out what people said. The CEO's events use the id "ceo:<run>".
  const who = `(e.worker_id IN (SELECT id FROM workers WHERE run_id = ?) OR e.worker_id = ?)`;
  const events = all(`SELECT * FROM (SELECT e.id, e.worker_id, e.kind, e.text, e.ms, e.ok, e.created FROM events e WHERE ${who} AND e.kind IN ('tool', 'error') ORDER BY e.id DESC LIMIT 250)
    UNION ALL SELECT * FROM (SELECT e.id, e.worker_id, e.kind, e.text, e.ms, e.ok, e.created FROM events e WHERE ${who} AND e.kind IN ('say', 'job', 'shot') ORDER BY e.id DESC LIMIT 200)
    ORDER BY id`, runId, `ceo:${runId}`, runId, `ceo:${runId}`).map((e) => (e.worker_id === `ceo:${runId}` ? { ...e, worker_id: "ceo" } : e));
  const since = now() - 2 * 3600_000, bucket = 5 * 60_000;
  const activity = all(`SELECT e.worker_id, (e.created / ${bucket}) * ${bucket} AS at, COUNT(*) AS n FROM events e JOIN workers w ON w.id = e.worker_id
    WHERE w.run_id = ? AND e.kind = 'tool' AND e.created >= ? GROUP BY e.worker_id, at ORDER BY at`, runId, since);
  const approvedAt = one("SELECT decided FROM plans WHERE run_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", runId)?.decided || null;
  // Token use: totals per person, and a timeline in about 120 slots over the run so far.
  const usageTotals = all(`SELECT worker_id, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
    SUM(cost) AS cost, COUNT(*) AS calls, MIN(created) AS first, MAX(created) AS last FROM usage WHERE run_id = ? GROUP BY worker_id`, runId);
  const slot = Math.max(60_000, Math.ceil((now() - r.created) / 120 / 60_000) * 60_000);
  const usageSeries = all(`SELECT worker_id, (created / ${slot}) * ${slot} AS at, SUM(input + output + cache_read + cache_write) AS tokens, SUM(output) AS output, SUM(cost) AS cost
    FROM usage WHERE run_id = ? GROUP BY worker_id, at ORDER BY at`, runId);
  const screenshots = all("SELECT id, worker_id, task_id, caption, mime, bytes, created FROM screenshots WHERE run_id = ? ORDER BY created DESC LIMIT 200", runId);
  const attachments = all("SELECT id, task_id, name, mime, bytes, created FROM attachments WHERE run_id = ? ORDER BY created", runId);
  return { run: r, project, plans, plan: latest, workers, tasks, messages, transitions, events, activity, approvedAt, usage: { totals: usageTotals, series: usageSeries, slot }, screenshots, attachments, now: now() };
}

function workerView(w) {
  const attach = w.tmux ? `tmux ${TMUX.length ? `-L ${TMUX[1]} ` : ""}attach -t '=${w.tmux}'` : null;
  const json = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const harness = w.harness || DEFAULT_HARNESS;
  return { ...w, harness, harnessName: HARNESSES[harness]?.name || harness, activity: json(w.activity), needs_input: json(w.needs_input), context: json(w.context), alive: !!w.alive, attach,
    parked: w.parked_level > 0, open: harness === "pi" ? null : interactiveCommand(harness, w.session_file, w.cwd) };
}

function planReview(runId) {
  const row = one("SELECT json FROM plans WHERE run_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", runId);
  try { return JSON.parse(row?.json || "{}").review === "self" ? "self" : "independent"; } catch { return "independent"; }
}

function recordTransition(runId, taskId, from, to, actor, reason, target) {
  run("INSERT INTO task_transitions (run_id, task_id, from_status, to_status, actor, reason, target, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    runId, taskId, from, to, actor, reason || null, target || null, now());
}

// Who has to act for a blocked task to move: a teammate (worker id), "ceo", "human", or "external".
// Explicit waitingOn wins; otherwise a teammate named in the note, else the human only when the note
// clearly asks for a human decision, else the CEO. Most blockers are the team's to solve, not yours.
function whoMustAct(runId, task, waitingOn, note) {
  const team = all("SELECT id, name FROM workers WHERE run_id = ?", runId).filter((w) => w.id !== task.worker_id);
  const want = String(waitingOn || "").trim().toLowerCase();
  if (want) {
    if (["human", "you", "user", "owner"].includes(want)) return "human";
    if (want === "ceo" || want === "external") return want;
    const w = team.find((x) => x.id === waitingOn || x.name.toLowerCase() === want);
    if (w) return w.id;
    throw httpError(400, `waitingOn must be a teammate's name, "ceo", "human", or "external" (team: ${team.map((x) => x.name).join(", ") || "none"})`);
  }
  const text = String(note || "");
  const named = team.find((x) => new RegExp(`\\b${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  if (named) return named.id;
  if (/\b(the human|human (decision|input|approval)|needs? (your|the user's|the owner's) (decision|approval|input|answer)|ask(ing)? the (human|user))\b/i.test(text)) return "human";
  return "ceo";
}

// A blocker goes to whoever can clear it: the teammate it waits on hears it directly, and the CEO always
// knows (it coordinates and escalates to the human only for real decisions).
function routeBlocker(runId, task, actor, blockedOn, note) {
  const owner = one("SELECT name FROM workers WHERE id = ?", task.worker_id)?.name || "the owner";
  const target = blockedOn && blockedOn.startsWith("wkr_") ? one("SELECT id, name FROM workers WHERE id = ?", blockedOn) : null;
  if (target) addMessage(runId, task.worker_id || actor, target.id, "chat", `${task.id} (${task.title}) is blocked waiting on you. ${note}`);
  const who = target ? target.name : blockedOn === "human" ? "the human" : blockedOn === "external" ? "something outside the team" : "you (the CEO)";
  addMessage(runId, "human", "ceo", "system", `${task.id} ${task.title} is blocked (${owner}), waiting on ${who}. ${blockedOn === "human" ? "The human sees it under Needs you." : "Get it unblocked inside the team: have the teammate act now, or reassign the work. Ask the human only if it truly needs their decision."} Reason: ${note}`.slice(0, 4000));
}

// Blockers recorded before blocked_on existed get the same routing (so they leave Needs you unless they ask you).
for (const t of all("SELECT * FROM tasks WHERE status = 'blocked' AND blocked_on IS NULL")) {
  try { run("UPDATE tasks SET blocked_on = ? WHERE run_id = ? AND id = ?", whoMustAct(t.run_id, t, null, t.note), t.run_id, t.id); } catch {}
}

// Token use per model call, from worker heartbeats and the CEO's events.
function recordUsage(runId, workerId, list) {
  for (const u of (Array.isArray(list) ? list : []).slice(0, 100)) {
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
    run("INSERT INTO usage (run_id, worker_id, input, output, cache_read, cache_write, cost, model, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      runId, workerId, n(u.input), n(u.output), n(u.cacheRead), n(u.cacheWrite), Number.isFinite(Number(u.cost)) ? Number(u.cost) : 0, u.model ? String(u.model).slice(0, 120) : null, Number(u.at) || now());
  }
}

// A task that reaches review goes straight to a reviewer, not through the CEO: whoever reviewed it
// before (it comes back to them after their findings), else the reviewer with the shortest queue.
function routeReview(runId, t, note) {
  const owner = t.worker_id ? one("SELECT * FROM workers WHERE id = ?", t.worker_id) : null;
  const reviewers = all("SELECT * FROM workers WHERE run_id = ? AND alive = 1 AND stop_requested IS NULL AND id != ?", runId, t.worker_id || "").filter((w) => REVIEWER_RE.test(w.role));
  if (!reviewers.length) {
    addMessage(runId, "human", "ceo", "system", `${t.id} ${t.title} is ready for review and no reviewer is running. Spawn an independent reviewer now (redplan_spawn_worker, role "independent reviewer"; about one per three builders), or review it yourself.`);
    return null;
  }
  const load = (w) => one("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND reviewer_id = ? AND status = 'review' AND id != ?", runId, w.id, t.id).n;
  const pick = reviewers.find((w) => w.id === t.reviewer_id) || reviewers.map((w) => [w, load(w)]).sort((a, b) => a[1] - b[1])[0][0];
  run("UPDATE tasks SET reviewer_id = ? WHERE run_id = ? AND id = ?", pick.id, runId, t.id);
  const criteria = planAcceptance(runId, t.id);
  addMessage(runId, "human", pick.id, "brief", [
    `Review ${t.id} now${t.reviewer_id === pick.id ? " (back from your findings: check they were fixed)" : ""}: ${t.title}`,
    `Author: ${owner?.name || "unknown"}, workspace ${owner?.cwd || "unknown"}${owner?.branch ? ` on branch ${owner.branch}` : ""}.`,
    `How they verified it: ${note || t.note || "(not given)"}`,
    t.description ? `Task: ${t.description}` : "",
    criteria.length ? `Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}` : "",
    `Keep it in review while you check it. Check the exact change against the criteria and run its tests. Pass: move it to done with how you verified it, and list minor issues in that note rather than sending it back for them. Fail (a criterion not met, or a real bug): move it to in_progress with concrete findings; it goes back to ${owner?.name || "its author"} and returns to you for the re-check.`,
  ].filter(Boolean).join("\n"), true);
  const queue = load(pick) + 1;
  if (queue >= 3) addMessage(runId, "human", "ceo", "system", `Review queue: ${pick.name} has ${queue} tasks waiting for review. Spawn another independent reviewer now (redplan_spawn_worker) so reviews do not hold up the run.`);
  return pick;
}

// The approved plan: each task's dependencies, and its story's acceptance criteria.
function approvedPlan(runId) {
  const row = one("SELECT json, schedule FROM plans WHERE run_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", runId);
  try { return row ? { plan: JSON.parse(row.json), schedule: JSON.parse(row.schedule) } : null; } catch { return null; }
}
function planAcceptance(runId, taskId) {
  const story = (approvedPlan(runId)?.plan?.stories || []).find((st) => (st.tasks || []).some((x) => x.id === taskId));
  const task = story?.tasks.find((x) => x.id === taskId);
  return [...(Array.isArray(task?.acceptance) ? task.acceptance : []), ...(Array.isArray(story?.acceptance) ? story.acceptance : [])].map(String).slice(0, 12);
}

// Work waiting for hands: tasks that could start now (dependencies done) but nobody is on, because they
// are unowned, their owner is gone, or their owner is busy with another task. Tell the CEO exactly what to
// do (hand them to free builders, or spawn more), once per change and at most every STAFF_NUDGE_MS.
function staffingAdvice(runId) {
  const tasks = all("SELECT * FROM tasks WHERE run_id = ?", runId);
  const status = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
  const sched = approvedPlan(runId)?.schedule?.tasks || [];
  const deps = Object.fromEntries((Array.isArray(sched) ? sched : Object.values(sched)).map((x) => [x.id, x.deps || []]));
  const workers = all("SELECT * FROM workers WHERE run_id = ? AND alive = 1 AND stop_requested IS NULL", runId);
  const builders = workers.filter((w) => !REVIEWER_RE.test(w.role));
  const busy = (w) => tasks.some((t) => t.worker_id === w.id && t.status === "in_progress");
  const free = builders.filter((w) => !tasks.some((t) => t.worker_id === w.id && ["in_progress", "todo", "blocked"].includes(t.status)));
  const waiting = tasks.filter((t) => t.status === "todo" && (deps[t.id] || []).every((d) => !status[d] || status[d] === "done")).filter((t) => {
    const owner = workers.find((w) => w.id === t.worker_id);
    return !owner || busy(owner) || REVIEWER_RE.test(owner.role);
  });
  if (!waiting.length) return null;
  const why = (t) => { const o = workers.find((w) => w.id === t.worker_id); return o ? `${t.id} (queued behind ${o.name}'s ${tasks.find((x) => x.worker_id === o.id && x.status === "in_progress")?.id || "work"})` : `${t.id} (${t.worker_id ? "its owner is gone" : "unassigned"})`; };
  const list = waiting.slice(0, 12).map(why).join(", ") + (waiting.length > 12 ? `, and ${waiting.length - 12} more` : "");
  const key = waiting.map((t) => t.id).sort().join(",") + "|" + free.map((w) => w.id).sort().join(",");
  if (free.length) return { key, text: `Work is waiting while ${free.map((w) => w.name).join(", ")} ${free.length > 1 ? "are" : "is"} free: ${list}. Give them these now, one task each (redplan_update_task handoffTo for owned tasks, assignTo for unassigned ones), so they run in parallel.` };
  const room = Math.max(0, MAX_BUILDERS - builders.length);
  if (!room) return { key, text: `${waiting.length} task${waiting.length > 1 ? "s" : ""} could start now, but all ${builders.length} builders are busy and the team is at its limit (${MAX_BUILDERS}): ${list}. Keep the critical path moving first.` };
  const n = Math.min(waiting.length, room);
  return { key, text: `${waiting.length} task${waiting.length > 1 ? "s" : ""} could start now but every builder is busy: ${list}. Spawn ${n} more worker${n > 1 ? "s" : ""} now (redplan_spawn_worker, one task each; hand the queued tasks over with handoffTo) so they run in parallel instead of waiting.` };
}
const staffSeen = new Map();   // run id -> { key, since }: how long the same work has been waiting
function sweepStaffing() {
  for (const r of all("SELECT * FROM runs WHERE status = 'executing'")) {
    let advice;
    try { advice = staffingAdvice(r.id); } catch (e) { console.error(`staffing check failed for ${r.id}: ${e.message}`); continue; }
    if (!advice) { staffSeen.delete(r.id); if (r.staff_key) run("UPDATE runs SET staff_key = NULL WHERE id = ?", r.id); continue; }
    const seen = staffSeen.get(r.id);
    if (!seen || seen.key !== advice.key) { staffSeen.set(r.id, { key: advice.key, since: now() }); continue; }
    if (now() - seen.since < STAFF_GRACE_MS) continue;
    if (advice.key === r.staff_key || now() - (r.staff_nudged || 0) < STAFF_NUDGE_MS) continue;
    addMessage(r.id, "human", "ceo", "system", advice.text);
    run("UPDATE runs SET staff_nudged = ?, staff_key = ? WHERE id = ?", now(), advice.key, r.id);
  }
}
setInterval(sweepStaffing, Math.min(30000, Math.max(200, Math.min(STAFF_NUDGE_MS, STAFF_GRACE_MS || STAFF_NUDGE_MS) / 4))).unref();

// Every worker's own tasks are done: tell it once to report and stop (it is woken again only if asked something).
function maybeReleaseWorker(runId, workerId) {
  const w = one("SELECT * FROM workers WHERE id = ? AND run_id = ?", workerId, runId);
  if (!w || !w.alive) return;
  const open = one("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND worker_id = ? AND status != 'done'", runId, workerId).n;
  const reviewer = /review|qa|audit/i.test(w.role) && one("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND status IN ('review', 'in_progress', 'todo', 'blocked')", runId).n > 0;
  if (open || reviewer) return;
  addMessage(runId, "human", workerId, "system", "All your tasks are done. If you have not yet, send the CEO a short final report (what changed, how you verified it, anything left), then stop: do not start new work, do not reopen tasks, and do not reply to status updates. You will be woken if someone asks you something.");
}

// The run is done (or cancelled): ask every worker to close; HQ closes any still open after a grace period.
function stopWorkers(runId, reason) {
  for (const w of all("SELECT * FROM workers WHERE run_id = ? AND alive = 1 AND stop_requested IS NULL", runId)) {
    run("UPDATE workers SET stop_requested = ?, stop_at = ? WHERE id = ?", reason, now(), w.id);
    addMessage(runId, "human", w.id, "system", `${reason} Your session is closing now. Do not reply to this.`);
  }
  notify(runId, "worker");
}

// ---------- tmux liveness ----------
function refreshAlive() {
  const workers = all("SELECT id, run_id, tmux, alive FROM workers WHERE tmux IS NOT NULL AND status != 'finished'");
  for (const w of workers) {
    execFile("tmux", [...TMUX, "has-session", "-t", `=${w.tmux}`], { timeout: 2000 }, (err) => {
      const alive = err ? 0 : 1;
      if (alive !== w.alive) {
        run("UPDATE workers SET alive = ?, updated = ? WHERE id = ?", alive, now(), w.id);
        notify(w.run_id, "worker");
      }
    });
  }
}
setInterval(refreshAlive, 10000).unref();

// Workers asked to stop that are still open after the grace period: close their tmux session.
function sweepStops() {
  for (const w of all("SELECT * FROM workers WHERE alive = 1 AND stop_requested IS NOT NULL AND stop_at < ?", now() - STOP_GRACE_MS)) {
    if (w.tmux) execFile("tmux", [...TMUX, "kill-session", "-t", `=${w.tmux}`], { timeout: 3000 }, () => {});
    run("UPDATE workers SET alive = 0, status = 'stopped', updated = ? WHERE id = ?", now(), w.id);
    notify(w.run_id, "worker");
  }
}
setInterval(sweepStops, Math.min(15000, Math.max(500, STOP_GRACE_MS / 4))).unref();

// A CEO researching for a long time without a plan: one nudge to submit what it has.
function sweepPlanning() {
  for (const r of all("SELECT * FROM runs WHERE status = 'planning' AND plan_nudged IS NULL AND created < ?", now() - PLAN_NUDGE_MS)) {
    if (one("SELECT id FROM plans WHERE run_id = ? LIMIT 1", r.id)) { run("UPDATE runs SET plan_nudged = ? WHERE id = ?", now(), r.id); continue; }
    const mins = Math.round((now() - r.created) / 60000);
    addMessage(r.id, "human", "ceo", "system", `You have been researching for ${mins} minutes without submitting a plan. Submit the plan now with what you know (redplan_submit_plan); put open questions under risks, and keep researching only what the plan truly depends on.`);
    run("UPDATE runs SET plan_nudged = ? WHERE id = ?", now(), r.id);
  }
}
setInterval(sweepPlanning, Math.min(60000, Math.max(500, PLAN_NUDGE_MS / 4))).unref();

// Wake ladder for parked workers: nudge the worker, then tell the CEO, then flag the human.
function sweepParked() {
  const rows = all(`SELECT w.* FROM workers w WHERE w.alive = 1 AND w.status = 'idle'
    AND EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = w.run_id AND t.worker_id = w.id AND t.status = 'in_progress')`);
  for (const w of rows) {
    const since = w.parked_at || w.updated;
    if (now() - (w.parked_level ? since : w.updated) < PARK_MS) continue;
    const tasks = all("SELECT id FROM tasks WHERE run_id = ? AND worker_id = ? AND status = 'in_progress'", w.run_id, w.id).map((t) => t.id).join(", ");
    const mins = Math.max(1, Math.round((now() - w.updated) / 60000));
    const level = w.parked_level + 1;
    if (level === 1) addMessage(w.run_id, "human", w.id, "system", `You still own in-progress work (${tasks}) but have been idle for ~${mins} min. Continue it, mark it blocked with the reason, or hand it off.`);
    else if (level === 2) addMessage(w.run_id, "human", "ceo", "system", `${w.name} is parked: idle ~${mins} min while owning ${tasks}, and did not respond to a nudge. Check on them, reassign, or resume them.`);
    else if (level === 3) {
      run("UPDATE workers SET needs_human = ? WHERE id = ?", `Idle ~${mins} min on ${tasks}; nudges to the worker and the CEO did not help.`, w.id);
      addMessage(w.run_id, w.id, "human", "system", `${w.name} needs you: idle ~${mins} min on ${tasks} after nudging the worker and the CEO.`);
    } else continue;
    // Stamp without touching updated: the ladder keeps counting from the last real activity.
    run("UPDATE workers SET parked_level = ?, parked_at = ? WHERE id = ?", level, now(), w.id);
    notify(w.run_id, "worker");
  }
}
setInterval(sweepParked, Math.min(15000, Math.max(500, PARK_MS / 4))).unref();

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, { "content-type": isJson ? "application/json" : "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cookieToken(req) {
  const m = /(?:^|;\s*)redpi_hq=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}

function tokenOk(candidate) {
  return !!candidate && safeEqual(candidate, TOKEN);
}

// Who is asking: "token" (RedPi and its workers), a signed-in user, or null.
async function whoIs(req, url) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  if (tokenOk(bearer)) return "token";
  if (!loadAuth()) return tokenOk(cookieToken(req)) || tokenOk(url.searchParams.get("t")) ? "token" : null;
  return sessionUser(req) || (await basicUser(req));
}

const sessionCookie = (value, maxAge) => `redpi_hq_s=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : "/");

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const WEB = join(HERE, "web");
function serveFile(res, file) {
  // Static files are public (no sign-in), so never serve anything outside hq/web.
  const path = resolve(WEB, file);
  if (!path.startsWith(WEB + sep) || !existsSync(path) || !statSync(path).isFile()) return send(res, 404, "not found");
  res.writeHead(200, { "content-type": STATIC_TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
    "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  res.end(readFileSync(path));
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

route("GET", "/api/health", () => ({ ok: true, version: VERSION, pid: process.pid, port: PORT }));
route("POST", "/api/shutdown", (_b, _p, res) => { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 50); return undefined; });

route("GET", "/api/runs", () => all(`SELECT r.*, p.path AS project_path, p.name AS project_name,
    (SELECT COUNT(*) FROM workers w WHERE w.run_id = r.id) AS workers,
    (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id) AS tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.status = 'done') AS done
  FROM runs r JOIN projects p ON p.id = r.project_id ORDER BY r.updated DESC LIMIT 200`));

// Every project on the machine with what is going on in it, busiest first.
const ACTIVE = "('planning', 'awaiting_approval', 'approved', 'executing')";
route("GET", "/api/projects", () => all(`SELECT p.*,
    (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id) AS runs,
    (SELECT COUNT(*) FROM runs r WHERE r.project_id = p.id AND r.status IN ${ACTIVE}) AS active_runs,
    (SELECT MAX(r.updated) FROM runs r WHERE r.project_id = p.id) AS updated,
    (SELECT COUNT(*) FROM plans pl JOIN runs r ON r.id = pl.run_id WHERE r.project_id = p.id AND pl.status = 'pending') AS awaiting_approval,
    (SELECT COUNT(*) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = p.id AND r.status IN ${ACTIVE}) AS tasks,
    (SELECT COUNT(*) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = p.id AND r.status IN ${ACTIVE} AND t.status = 'done') AS done,
    (SELECT COUNT(*) FROM tasks t JOIN runs r ON r.id = t.run_id WHERE r.project_id = p.id AND r.status IN ${ACTIVE} AND t.status = 'blocked') AS blocked
  FROM projects p ORDER BY active_runs > 0 DESC, updated DESC`).map((p) => {
  const workers = all(`SELECT w.id, w.name, w.role, w.status, w.alive, w.needs_human, w.needs_input, w.parked_level, w.run_id FROM workers w
    JOIN runs r ON r.id = w.run_id WHERE r.project_id = ? AND r.status IN ${ACTIVE} AND w.status != 'finished' ORDER BY w.created`, p.id);
  const latest = one("SELECT id, title, status, updated FROM runs WHERE project_id = ? ORDER BY (status IN " + ACTIVE + ") DESC, updated DESC LIMIT 1", p.id);
  return { ...p, latest, workers: workers.map((w) => ({ id: w.id, name: w.name, role: w.role, status: w.status, alive: !!w.alive,
    needsYou: !!(w.needs_human || w.needs_input || w.parked_level > 0), runId: w.run_id })) };
}));

route("GET", "/api/projects/:id", (_b, p) => {
  const project = one("SELECT * FROM projects WHERE id = ?", p.id);
  if (!project) return notFound();
  return { project, runs: all(`SELECT r.*,
      (SELECT COUNT(*) FROM workers w WHERE w.run_id = r.id) AS workers,
      (SELECT COUNT(*) FROM workers w WHERE w.run_id = r.id AND w.alive = 1 AND w.status != 'finished') AS live_workers,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id) AS tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.status = 'done') AS done
    FROM runs r WHERE r.project_id = ? ORDER BY (r.status IN ${ACTIVE}) DESC, r.updated DESC`, p.id) };
});

route("POST", "/api/runs", (b) => {
  if (!b.projectPath || !b.title) throw httpError(400, "projectPath and title are required");
  const project = ensureProject(String(b.projectPath));
  const r = { id: shortId("run"), title: String(b.title).slice(0, 200) };
  run("INSERT INTO runs (id, project_id, title, request, status, ceo_session, created, updated) VALUES (?, ?, ?, ?, 'planning', ?, ?, ?)",
    r.id, project.id, r.title, b.request ? String(b.request) : null, b.ceoSession ? String(b.ceoSession) : null, now(), now());
  notify(r.id, "run");
  return runView(r.id);
});

route("GET", "/api/runs/:id", (_b, p) => runView(p.id) || notFound());

route("PATCH", "/api/runs/:id", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  if (b.status && !RUN_STATUSES.includes(b.status)) throw httpError(400, `status must be one of ${RUN_STATUSES.join(", ")}`);
  if (b.status) touchRun(p.id, b.status);
  if (b.status === "done" || b.status === "cancelled") stopWorkers(p.id, b.status === "done" ? "The run is complete: all work is finished." : "The run was cancelled.");
  notify(p.id, "run");
  return runView(p.id);
});

route("POST", "/api/runs/:id/plans", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  const { errors, warnings } = validatePlan(b.plan);
  if (errors.length) throw httpError(400, "plan has errors", { errors, warnings });
  const schedule = schedulePlan(b.plan);
  const version = (one("SELECT MAX(version) AS v FROM plans WHERE run_id = ?", p.id)?.v || 0) + 1;
  run("UPDATE plans SET status = 'superseded' WHERE run_id = ? AND status = 'pending'", p.id);
  const id = shortId("pln");
  run("INSERT INTO plans (id, run_id, version, json, schedule, warnings, status, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    id, p.id, version, JSON.stringify(b.plan), JSON.stringify(schedule), JSON.stringify(warnings), now());
  touchRun(p.id, "awaiting_approval");
  notify(p.id, "plan");
  return planView(one("SELECT * FROM plans WHERE id = ?", id));
});

// ---------- harnesses: which coding agent runs each task ----------
// Detected on this machine (the hub runs where the workers run), refreshed every 10 minutes.
let harnessCache = { at: 0, list: HARNESS_IDS.map((id) => ({ id, name: HARNESSES[id].name, short: HARNESSES[id].short, installed: id === DEFAULT_HARNESS, version: null })) };
async function harnesses(refresh = false) {
  if (refresh || now() - harnessCache.at > 10 * 60000) harnessCache = { at: now(), list: await detectHarnesses() };
  return harnessCache.list;
}
harnesses().catch(() => {});

// The human's choices for a run: "*" is the default for every task; a task id overrides it.
function harnessChoices(runId) {
  return Object.fromEntries(all("SELECT task_id, harness FROM task_harness WHERE run_id = ?", runId).map((r) => [r.task_id, r.harness]));
}
function taskHarness(choices, task) { return choices[task.id] || choices["*"] || (HARNESS_IDS.includes(task.harness) ? task.harness : DEFAULT_HARNESS); }

route("GET", "/api/harnesses", async (_b, _p, _res, url) => harnesses(url.searchParams.get("refresh") === "1"));

route("PUT", "/api/runs/:id/harness", async (b, p) => {
  const latest = one("SELECT * FROM plans WHERE run_id = ? ORDER BY version DESC LIMIT 1", p.id);
  if (!latest) return notFound();
  if (latest.status !== "pending") throw httpError(409, "harnesses are chosen while the plan awaits approval");
  const harness = String(b.harness || "");
  if (!HARNESS_IDS.includes(harness)) throw httpError(400, `harness must be one of ${HARNESS_IDS.join(", ")}`);
  if (!(await harnesses()).find((h) => h.id === harness)?.installed) throw httpError(400, `${HARNESSES[harness].name} is not installed on this machine`);
  const task = b.task ? String(b.task) : "*";
  const ids = JSON.parse(latest.json).stories?.flatMap((s) => (s.tasks || []).map((t) => t.id)) || [];
  if (task !== "*" && !ids.includes(task)) throw httpError(400, `unknown task ${task}`);
  // Choosing for every task replaces the per-task choices.
  if (task === "*") run("DELETE FROM task_harness WHERE run_id = ?", p.id);
  run("INSERT OR REPLACE INTO task_harness (run_id, task_id, harness, updated) VALUES (?, ?, ?, ?)", p.id, task, harness, now());
  notify(p.id, "harness");
  return harnessChoices(p.id);
});

// ---------- plan review: comments anchored to text or diagram spots ----------
// anchor: { kind: "text" | "pin", tab, target (e.g. "task:T2"), label (where, in words), diagram?, x?, y? (0–1 of the diagram) }
function commentView(c) { let anchor = {}; try { anchor = JSON.parse(c.anchor); } catch {} return { ...c, anchor }; }
const planComments = (planId) => all("SELECT * FROM plan_comments WHERE plan_id = ? ORDER BY id", planId).map(commentView);

function cleanAnchor(a) {
  a = a && typeof a === "object" ? a : {};
  const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const frac = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : undefined);
  // text: a quote inside a section · pin: a spot on a diagram · card: a whole card (e.g. one technology)
  const kind = a.kind === "pin" || a.kind === "card" ? a.kind : "text";
  return { kind, tab: str(a.tab, 40), target: str(a.target, 200), label: str(a.label, 300), diagram: str(a.diagram, 40), x: frac(a.x), y: frac(a.y), prefix: str(a.prefix, 80) };
}

function draftablePlan(id) {
  const row = one("SELECT * FROM plans WHERE id = ?", id);
  if (!row) notFound();
  if (row.status !== "pending") throw httpError(409, `plan v${row.version} is already ${row.status}; comments go on the pending version`);
  return row;
}

// Numbered feedback for the CEO, one line per comment, each saying where it points.
function feedbackText(comments) {
  return comments.map((c, i) => {
    const where = c.anchor.label || c.anchor.target || "the plan";
    const quote = c.quote ? ` on "${c.quote.replace(/\s+/g, " ").slice(0, 300)}"` : "";
    return `#${i + 1} [${where}]${quote}: ${c.body}`;
  }).join("\n");
}

route("GET", "/api/plans/:id", (_b, p) => {
  const plan = planView(one("SELECT * FROM plans WHERE id = ?", p.id));
  if (!plan) return notFound();
  const r = one("SELECT * FROM runs WHERE id = ?", plan.runId);
  const prev = one("SELECT id, version FROM plans WHERE run_id = ? AND version < ? ORDER BY version DESC LIMIT 1", plan.runId, plan.version);
  return { ...plan, run: r, project: one("SELECT * FROM projects WHERE id = ?", r.project_id),
    latestVersion: one("SELECT MAX(version) AS v FROM plans WHERE run_id = ?", plan.runId).v,
    latestId: one("SELECT id FROM plans WHERE run_id = ? ORDER BY version DESC LIMIT 1", plan.runId).id,
    comments: planComments(p.id),
    harness: harnessChoices(plan.runId),
    previous: prev ? { id: prev.id, version: prev.version, comments: planComments(prev.id).filter((c) => c.status === "sent") } : null };
});

route("POST", "/api/plans/:id/comments", (b, p) => {
  const row = draftablePlan(p.id);
  const body = String(b.body || "").trim();
  if (!body) throw httpError(400, "body is required");
  const r = run("INSERT INTO plan_comments (plan_id, run_id, anchor, quote, body, status, created, updated) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)",
    p.id, row.run_id, JSON.stringify(cleanAnchor(b.anchor)), b.quote ? String(b.quote).slice(0, 1000) : null, body.slice(0, 8000), now(), now());
  notify(row.run_id, "comments");
  return commentView(one("SELECT * FROM plan_comments WHERE id = ?", Number(r.lastInsertRowid)));
});

route("PATCH", "/api/plans/:id/comments/:cid", (b, p) => {
  const row = draftablePlan(p.id);
  const c = one("SELECT * FROM plan_comments WHERE id = ? AND plan_id = ?", Number(p.cid), p.id);
  if (!c) return notFound();
  if (c.status !== "draft") throw httpError(409, "this comment was already sent");
  const body = String(b.body || "").trim();
  if (!body) throw httpError(400, "body is required");
  run("UPDATE plan_comments SET body = ?, updated = ? WHERE id = ?", body.slice(0, 8000), now(), c.id);
  notify(row.run_id, "comments");
  return commentView(one("SELECT * FROM plan_comments WHERE id = ?", c.id));
});

route("DELETE", "/api/plans/:id/comments/:cid", (_b, p) => {
  const row = draftablePlan(p.id);
  const c = one("SELECT * FROM plan_comments WHERE id = ? AND plan_id = ?", Number(p.cid), p.id);
  if (!c) return notFound();
  if (c.status !== "draft") throw httpError(409, "this comment was already sent");
  run("DELETE FROM plan_comments WHERE id = ?", c.id);
  notify(row.run_id, "comments");
  return { ok: true };
});

route("POST", "/api/plans/:id/decision", (b, p) => {
  const row = one("SELECT * FROM plans WHERE id = ?", p.id);
  if (!row) return notFound();
  if (row.status !== "pending") throw httpError(409, `plan is already ${row.status}`);
  const approve = b.decision === "approve";
  if (!approve && b.decision !== "changes") throw httpError(400, "decision must be approve or changes");
  const comment = b.comment ? String(b.comment).trim().slice(0, 20000) || null : null;
  const drafts = planComments(p.id).filter((c) => c.status === "draft");
  if (!approve && !comment && !drafts.length) throw httpError(400, "say what should change: add comments on the plan or an overall comment");
  run("UPDATE plans SET status = ?, comment = ?, decided = ? WHERE id = ?", approve ? "approved" : "changes_requested", comment, now(), p.id);
  drafts.forEach((c, i) => run("UPDATE plan_comments SET status = 'sent', n = ?, sent = ? WHERE id = ?", i + 1, now(), c.id));
  let harnessNote = "";
  if (approve) {
    const plan = JSON.parse(row.json);
    const choices = harnessChoices(row.run_id);
    const byHarness = {};
    for (const story of plan.stories || []) for (const t of story.tasks || []) {
      const h = taskHarness(choices, t);
      (byHarness[h] ||= []).push(t.id);
      run("INSERT OR REPLACE INTO tasks (run_id, id, story_id, title, status, worker_id, note, updated, harness) VALUES (?, ?, ?, ?, 'todo', NULL, NULL, ?, ?)", row.run_id, t.id, story.id, t.title, now(), h);
    }
    if (Object.keys(byHarness).some((h) => h !== DEFAULT_HARNESS)) {
      harnessNote = `\n\nHarness per task (the coding agent each task must run on): ${Object.entries(byHarness).map(([h, ids]) => `${HARNESSES[h].name}: ${ids.join(", ")}`).join("; ")}. A worker runs on one harness: give each worker only tasks of one harness and pass that harness to redplan_spawn_worker.`;
    }
  }
  touchRun(row.run_id, approve ? "approved" : "planning");
  const notes = drafts.length ? `\n\nComments from the plan page (${drafts.length}), each pointing at a place in plan v${row.version}:\n${feedbackText(drafts)}` : "";
  addMessage(row.run_id, "human", "ceo", "decision", approve
    ? `Plan v${row.version} APPROVED.${comment ? ` Comment: ${comment}` : ""}${drafts.length ? `${notes}\n\nKeep these notes in mind while executing (put them in the relevant workers' briefs).` : ""}${harnessNote} Start execution: form the team and spawn workers.`
    : `Plan v${row.version}: CHANGES REQUESTED.${comment ? `\nOverall: ${comment}` : ""}${notes}\n\nRevise the plan and submit a new version with redplan_submit_plan. Address every numbered comment and say how in the plan's "changes" list (one line per comment, starting with its number, e.g. "#1 …"). If a comment is a question, answer it there too; if a comment is unclear, ask the human here before resubmitting.`);
  notify(row.run_id, "plan");
  return planView(one("SELECT * FROM plans WHERE id = ?", p.id));
});

route("POST", "/api/runs/:id/workers", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  if (!b.name || !b.role || !b.cwd) throw httpError(400, "name, role, and cwd are required");
  if (one("SELECT id FROM workers WHERE run_id = ? AND name = ?", p.id, b.name)) throw httpError(409, `a worker named ${b.name} already exists in this run`);
  const harness = b.harness ? String(b.harness) : DEFAULT_HARNESS;
  if (!HARNESS_IDS.includes(harness)) throw httpError(400, `harness must be one of ${HARNESS_IDS.join(", ")}`);
  const mismatched = all("SELECT id, harness FROM tasks WHERE run_id = ?", p.id).filter((t) => (b.taskIds || []).map(String).includes(t.id) && t.harness !== harness);
  if (mismatched.length) throw httpError(400, `a worker runs on one harness: ${mismatched.map((t) => `${t.id} is set to ${HARNESSES[t.harness]?.name || t.harness}`).join(", ")}, not ${HARNESSES[harness].name}`);
  const id = shortId("wkr");
  run(`INSERT INTO workers (id, run_id, name, role, cwd, branch, tmux, status, launch_id, created, updated, harness) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?)`,
    id, p.id, String(b.name), String(b.role), String(b.cwd), b.branch || null, b.tmux || null, b.launchId || null, now(), now(), harness);
  for (const t of b.taskIds || []) run("UPDATE tasks SET worker_id = ?, updated = ? WHERE run_id = ? AND id = ?", id, now(), p.id, String(t));
  // Tickets carry the human's own description and attachments: the brief always includes them.
  const tickets = (b.taskIds || []).map((t) => one("SELECT * FROM tasks WHERE run_id = ? AND id = ? AND kind = 'ticket'", p.id, String(t))).filter(Boolean);
  if (b.brief) addMessage(p.id, "ceo", id, "brief", tickets.length ? `${b.brief}\n\n${tickets.map((t) => ticketText(p.id, t)).join("\n\n")}` : b.brief);
  touchRun(p.id, "executing");
  notify(p.id, "worker");
  return { ...workerView(one("SELECT * FROM workers WHERE id = ?", id)), warnings: loadWarnings(p.id) };
});

// One person owning most of the critical path makes the whole run wait on them: say so when staffing.
function loadWarnings(runId) {
  const plan = planView(one("SELECT * FROM plans WHERE run_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", runId));
  const crit = plan?.schedule?.criticalPath || [];
  if (crit.length < 3) return [];
  const hours = (id) => plan.schedule.tasks?.[id]?.hours || 0;
  const total = crit.reduce((n, id) => n + hours(id), 0) || 1;
  const owners = new Map();
  for (const t of all("SELECT id, worker_id FROM tasks WHERE run_id = ?", runId)) if (crit.includes(t.id) && t.worker_id) owners.set(t.worker_id, [...(owners.get(t.worker_id) || []), t.id]);
  const team = all("SELECT id, name FROM workers WHERE run_id = ?", runId);
  if (team.length < 2) return [];
  return [...owners].filter(([, ids]) => ids.reduce((n, id) => n + hours(id), 0) / total > 0.6).map(([wid, ids]) => {
    const name = team.find((w) => w.id === wid)?.name || wid, h = ids.reduce((n, id) => n + hours(id), 0);
    return `${name} owns ${ids.length} of ${crit.length} critical-path tasks (${Math.round(h)}h of ${Math.round(total)}h): the run finishes only as fast as ${name} does. Keep ${name} on those alone, give everything else to others, and split any large critical task that has independent parts.`;
  });
}

route("PATCH", "/api/workers/:id", (b, p) => {
  const w = one("SELECT * FROM workers WHERE id = ?", p.id);
  if (!w) return notFound();
  if (b.tmux !== undefined) run("UPDATE workers SET tmux = ?, alive = 1, updated = ? WHERE id = ?", b.tmux, now(), p.id);
  // A relaunch gets a new launch id; heartbeats from the previous process are ignored from now on.
  if (b.launchId) run("UPDATE workers SET launch_id = ?, alive = 1, parked_level = 0, needs_human = NULL, needs_input = NULL, stop_requested = NULL, stop_at = NULL, status = CASE WHEN status = 'stopped' THEN 'starting' ELSE status END, updated = ? WHERE id = ?", String(b.launchId), now(), p.id);
  if (b.status) run("UPDATE workers SET status = ?, updated = ? WHERE id = ?", String(b.status), now(), p.id);
  notify(w.run_id, "worker");
  return workerView(one("SELECT * FROM workers WHERE id = ?", p.id));
});

route("GET", "/api/workers/:id", (_b, p) => {
  const w = one("SELECT * FROM workers WHERE id = ?", p.id);
  if (!w) return notFound();
  const teammates = all("SELECT id, name, role, status, current_task FROM workers WHERE run_id = ? AND id != ?", w.run_id, w.id);
  const tasks = all("SELECT * FROM tasks WHERE run_id = ? AND worker_id = ?", w.run_id, w.id);
  const events = all("SELECT * FROM (SELECT * FROM events WHERE worker_id = ? ORDER BY id DESC LIMIT 120) ORDER BY id", w.id);
  const brief = one("SELECT id, body FROM messages WHERE run_id = ? AND recipient = ? AND kind = 'brief' ORDER BY id LIMIT 1", w.run_id, w.id);
  return { worker: workerView(w), teammates, tasks, events, run: one("SELECT * FROM runs WHERE id = ?", w.run_id), review: planReview(w.run_id), brief: brief?.body || null,
    lastMessageId: one("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE run_id = ?", w.run_id).id };
});

route("POST", "/api/workers/:id/heartbeat", (b, p) => {
  const w = one("SELECT * FROM workers WHERE id = ?", p.id);
  if (!w) return notFound();
  // A heartbeat from an earlier launch (a leftover process) must not make the new launch look alive or idle.
  if (b.launchId && w.launch_id && b.launchId !== w.launch_id) return { ok: false, stale: true, stop: `A newer launch of ${w.name} replaced this process.` };
  run(`UPDATE workers SET status = COALESCE(?, status), current_task = COALESCE(?, current_task), last_message = COALESCE(?, last_message), activity = COALESCE(?, activity),
    session_file = COALESCE(?, session_file), context = COALESCE(?, context), alive = 1, parked_level = 0, parked_at = NULL, needs_human = NULL, updated = ? WHERE id = ?`,
    b.status ?? null, b.currentTask ?? null, b.lastMessage != null ? String(b.lastMessage).slice(0, 8000) : null, b.activity ? JSON.stringify(b.activity) : null,
    b.sessionFile ? String(b.sessionFile) : null, b.context ? JSON.stringify(b.context) : null, now(), p.id);
  // needsInput: {count, reason} while something waits on a person; null clears it.
  if (b.needsInput !== undefined) run("UPDATE workers SET needs_input = ? WHERE id = ?", b.needsInput ? JSON.stringify(b.needsInput) : null, p.id);
  for (const e of (b.events || []).slice(0, 50)) run("INSERT INTO events (worker_id, kind, text, ms, ok, created) VALUES (?, ?, ?, ?, ?, ?)",
    p.id, String(e.kind || "info"), String(e.text || "").slice(0, 2000), Number.isFinite(e.ms) ? Math.round(e.ms) : null, e.ok === undefined ? null : e.ok ? 1 : 0, now());
  run("DELETE FROM events WHERE worker_id = ? AND id < (SELECT COALESCE(MAX(id), 0) - 500 FROM events WHERE worker_id = ?)", p.id, p.id);
  recordUsage(w.run_id, p.id, b.usage);
  notify(w.run_id, "worker");
  return w.stop_requested ? { ok: true, stop: w.stop_requested } : { ok: true };
});

// The CEO session's activity: its tool calls and plain-language updates, for the event board.
route("POST", "/api/runs/:id/ceo-events", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  const id = `ceo:${p.id}`;
  for (const e of (b.events || []).slice(0, 50)) run("INSERT INTO events (worker_id, kind, text, ms, ok, created) VALUES (?, ?, ?, ?, ?, ?)",
    id, String(e.kind || "info"), String(e.text || "").slice(0, 2000), Number.isFinite(e.ms) ? Math.round(e.ms) : null, e.ok === undefined ? null : e.ok ? 1 : 0, now());
  run("DELETE FROM events WHERE worker_id = ? AND id < (SELECT COALESCE(MAX(id), 0) - 500 FROM events WHERE worker_id = ?)", id, id);
  recordUsage(p.id, "ceo", b.usage);
  const first = !one("SELECT ceo_seen FROM runs WHERE id = ?", p.id).ceo_seen;
  run("UPDATE runs SET ceo_seen = ?, ceo_caps = COALESCE(?, ceo_caps) WHERE id = ?", now(), Array.isArray(b.caps) ? JSON.stringify(b.caps.map(String).slice(0, 20)) : null, p.id);
  if (first || (b.events || []).length || (b.usage || []).length) notify(p.id, "worker");
  return { ok: true };
});

route("POST", "/api/runs/:id/tasks/:task", (b, p) => {
  const t = one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task);
  if (!t) throw httpError(404, `no task ${p.task} in this run (tasks exist after the plan is approved)`);
  if (b.status && !TASK_STATUSES.includes(b.status)) throw httpError(400, `status must be one of ${TASK_STATUSES.join(", ")}`);
  const actor = String(b.actor || "ceo");
  const note = b.note != null ? String(b.note).trim().slice(0, 2000) : "";

  // Assign an unowned task (a new ticket, usually) to a teammate with a brief: it becomes their work now.
  if (b.assignTo) {
    const target = one("SELECT * FROM workers WHERE run_id = ? AND (id = ? OR lower(name) = lower(?))", p.id, String(b.assignTo), String(b.assignTo));
    if (!target) throw httpError(400, `no worker ${b.assignTo} in this run`);
    if (t.worker_id && t.worker_id !== target.id && actor !== "ceo" && actor !== "human") throw httpError(409, `${p.task} belongs to ${participantName(p.id, t.worker_id)}: hand it off instead (handoffTo, with a note)`);
    if (!note) throw httpError(400, "assigning needs a note: the brief (what to do, acceptance criteria, how to verify)");
    run("UPDATE tasks SET worker_id = ?, status = CASE WHEN status = 'done' THEN status ELSE 'todo' END, updated = ? WHERE run_id = ? AND id = ?", target.id, now(), p.id, p.task);
    run("UPDATE workers SET stop_requested = NULL, stop_at = NULL WHERE id = ?", target.id);
    recordTransition(p.id, p.task, t.status, t.status === "done" ? "done" : "todo", actor, `Assigned to ${target.name}`, target.id);
    addMessage(p.id, actor, target.id, "brief", `${ticketText(p.id, one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task), "You now own")}\n\nBrief: ${note}\n\nStart now${t.priority === "urgent" ? " (URGENT: put it before anything else)" : ""}: move it to in_progress, do it, verify it, then move it to review with how you verified it.`, true);
    addMessage(p.id, actor, "all", "task", `${p.task} ${t.title}: assigned to ${target.name}`);
    notify(p.id, "task");
    return one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task);
  }

  // Handoff: reassign and record in one transaction, so work is never silently dropped.
  if (b.handoffTo) {
    const target = one("SELECT * FROM workers WHERE run_id = ? AND (id = ? OR lower(name) = lower(?))", p.id, String(b.handoffTo), String(b.handoffTo));
    if (!target) throw httpError(400, `no worker ${b.handoffTo} in this run`);
    if (!note) throw httpError(400, "a handoff needs a note: what is done and what the new owner should do next");
    db.exec("BEGIN");
    try {
      run("UPDATE tasks SET worker_id = ?, status = 'todo', note = ?, updated = ? WHERE run_id = ? AND id = ?", target.id, note, now(), p.id, p.task);
      recordTransition(p.id, p.task, t.status, "todo", actor, note, target.id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    addMessage(p.id, actor, target.id, "chat", `Handing ${p.task} (${t.title}) to you. ${note}`);
    addMessage(p.id, actor, "all", "task", `${p.task} ${t.title}: handed off to ${target.name} (${note})`);
    notify(p.id, "task");
    return one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task);
  }

  if (b.status === "blocked" && !note) throw httpError(400, "blocked needs a note with the reason and what would unblock it");
  const blockedOn = b.status === "blocked" ? whoMustAct(p.id, t, b.waitingOn, note) : null;
  if (b.status === "done" && !note) throw httpError(400, "done needs a note saying how the work was verified (tests, build, review)");
  // Reopening a closed task: only whoever closed it, the CEO, or the human, with a reason, and only once
  // (after that the human decides). This stops tasks bouncing between done and review.
  if (t.status === "done" && b.status && b.status !== "done" && actor !== "human") {
    const closer = one("SELECT actor FROM task_transitions WHERE run_id = ? AND task_id = ? AND to_status = 'done' ORDER BY id DESC LIMIT 1", p.id, p.task)?.actor;
    if (actor !== "ceo" && actor !== closer) throw httpError(409, `${p.task} was closed by ${participantName(p.id, closer || "ceo")}. Only they, the CEO or the human can reopen it. If something is wrong, send them your evidence (redplan_send) instead.`);
    if (!note) throw httpError(400, "reopening a closed task needs a note: what is wrong and how you know");
    const reopened = one("SELECT COUNT(*) AS n FROM task_transitions WHERE run_id = ? AND task_id = ? AND from_status = 'done'", p.id, p.task).n;
    if (reopened >= 1) throw httpError(409, `${p.task} has already been reopened once. Leave it closed and tell the CEO what is still wrong; the human decides whether it is worth reopening.`);
  }
  // Independent review cannot be skipped: work reaches done from review, unless the human decides otherwise.
  if (b.status === "done" && t.status !== "review" && t.status !== "done" && actor !== "human" && planReview(p.id) === "independent") {
    throw httpError(409, `${p.task} is ${t.status}: move it to review first; the independent reviewer (or the CEO) marks it done after checking the change`);
  }
  // Independent review: the author moves work to review; someone else marks it done.
  if (b.status === "done" && t.worker_id && actor === t.worker_id && planReview(p.id) === "independent") {
    throw httpError(409, "this plan uses independent review: move the task to review; the reviewer (or the CEO) marks it done");
  }

  // Sending reviewed work back: it returns to its author with the findings, never to the reviewer.
  const bounce = t.status === "review" && b.status === "in_progress" && t.worker_id && actor !== t.worker_id;
  if (bounce && !note) throw httpError(400, `sending ${p.task} back needs the findings: what fails and how you checked (it goes back to ${participantName(p.id, t.worker_id)}). To review it, leave it in review.`);
  // Starting a task makes you its owner only if it has none (or is yours); a reviewer never takes it over.
  const owner = b.workerId && !bounce && (!t.worker_id || t.worker_id === b.workerId || actor === "ceo" || actor === "human") ? b.workerId : null;
  run("UPDATE tasks SET status = COALESCE(?, status), worker_id = COALESCE(?, worker_id), note = COALESCE(?, note), updated = ? WHERE run_id = ? AND id = ?",
    b.status || null, owner, note || null, now(), p.id, p.task);
  if (bounce) {
    if (actor.startsWith("wkr_")) run("UPDATE tasks SET reviewer_id = ? WHERE run_id = ? AND id = ?", actor, p.id, p.task);
    addMessage(p.id, actor, t.worker_id, "brief", `Changes requested on ${p.task} (${t.title}) by ${participantName(p.id, actor)}:\n${note}\n\nFix these before starting anything else, verify again, then move it back to review; ${participantName(p.id, actor)} re-checks it.`, true);
  }
  if (b.status) run("UPDATE tasks SET blocked_on = ? WHERE run_id = ? AND id = ?", blockedOn, p.id, p.task);
  if (b.status === "blocked" && (b.status !== t.status || blockedOn !== t.blocked_on)) routeBlocker(p.id, t, actor, blockedOn, note);
  if (b.status && b.status !== t.status) {
    recordTransition(p.id, p.task, t.status, b.status, actor, note, b.status === "blocked" ? blockedOn : null);
    addMessage(p.id, actor, "all", "task", `${p.task} ${t.title}: ${t.status} → ${b.status}${note ? ` (${note})` : ""}`);
    if (b.status === "review" && t.worker_id) {
      if (planReview(p.id) === "independent") routeReview(p.id, one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task), note);
      else addMessage(p.id, "human", "ceo", "system", `${p.task} ${t.title} is ready for review.`);
    }
  }
  if (b.status === "in_progress" && actor.startsWith("wkr_")) run("UPDATE workers SET current_task = ?, updated = ? WHERE id = ?", p.task, now(), actor);
  const open = one("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND status != 'done'", p.id).n;
  if (!open && b.status === "done") addMessage(p.id, "human", "ceo", "system", "All tasks are done. Integrate the work (merge worktrees), run the full verification, do a final review, then report to the human and finish the run (redplan_finish_run), which closes the workers' sessions.");
  if (b.status === "done" && t.status !== "done") {
    if (t.worker_id) maybeReleaseWorker(p.id, t.worker_id);
    // A reviewer with nothing left to review is done too.
    for (const r of all("SELECT id FROM workers WHERE run_id = ? AND id != ?", p.id, t.worker_id || "")) maybeReleaseWorker(p.id, r.id);
  }
  notify(p.id, "task");
  return one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task);
});

route("GET", "/api/runs/:id/tasks/:task/history", (_b, p) =>
  all("SELECT * FROM task_transitions WHERE run_id = ? AND task_id = ? ORDER BY id", p.id, p.task)
    .map((h) => ({ ...h, actorName: participantName(p.id, h.actor), targetName: h.target ? participantName(p.id, h.target) : null })));

// Dashboard "Resume" button: the CEO owns relaunching, so ask it.
route("POST", "/api/workers/:id/resume-request", (_b, p) => {
  const w = one("SELECT * FROM workers WHERE id = ?", p.id);
  if (!w) return notFound();
  addMessage(w.run_id, "human", "ceo", "command", `Please resume ${w.name} with redplan_resume_worker (its tmux session is gone).`);
  return { ok: true };
});

route("POST", "/api/runs/:id/messages", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  if (!b.body || !b.to) throw httpError(400, "to and body are required");
  // aside: a "btw" side question answered by the worker without touching its live session.
  // reply: an agent's answer to the human's message, posted back when its turn ends.
  // quick: the instant answer to it, posted within seconds while the live session takes the message in.
  const kind = ["chat", "command", "interrupt", "aside", "reply", "quick"].includes(b.kind) ? b.kind : "chat";
  const from = String(b.from || "human"), to = String(b.to), body = String(b.body).slice(0, 20000);
  // Does this need an answer? Said explicitly, or a question, or anything from the human or the CEO.
  // (A report to the human is not a question: only a real question, or a sender who says so, waits on them.)
  const needsReply = b.needsReply !== undefined ? !!b.needsReply : /\?\s*$/.test(body.trim()) || ((from === "human" || from === "ceo") && to !== "human");
  // Teammates going back and forth: warn, then refuse, and point them at the CEO.
  let warning;
  if (from.startsWith("wkr_") && to.startsWith("wkr_") && kind === "chat") {
    const n = one(`SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND kind = 'chat' AND created > ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))`, p.id, now() - 3600_000, from, to, to, from).n;
    const other = participantName(p.id, to);
    if (n >= PAIR_MAX) throw httpError(429, `You and ${other} have exchanged ${n} messages in the last hour. Stop the back-and-forth: send the CEO one message with what you agree on and what is still open, and let the CEO decide.`);
    if (n >= PAIR_WARN) warning = `You and ${other} have exchanged ${n} messages in the last hour. Wrap up: settle it in this message, or ask the CEO to decide. Do not reply to acknowledgements.`;
  }
  const id = addMessage(p.id, from, to, kind, body, needsReply);
  return warning ? { id, warning } : { id };
});

route("GET", "/api/runs/:id/inbox", (_b, p, _res, url) => {
  const who = url.searchParams.get("for");
  const after = Number(url.searchParams.get("after") || 0);
  if (!who) throw httpError(400, "for is required");
  return all(`SELECT * FROM messages WHERE run_id = ? AND id > ? AND sender != ? AND (recipient = ? OR recipient = 'all') AND kind != 'task' ORDER BY id LIMIT 100`, p.id, after, who, who)
    .map((m) => ({ ...m, senderName: participantName(p.id, m.sender) }));
});

// ---------- tickets: work the human adds straight to the board, no plan or approval ----------
function ticketText(runId, t, lead = "Ticket") {
  const files = all("SELECT * FROM attachments WHERE run_id = ? AND task_id = ? ORDER BY created", runId, t.id);
  return [`${lead} ${t.id}${t.kind === "ticket" ? ` · ${String(t.priority || "normal").toUpperCase()} priority` : ""}${t.hours ? ` · about ${t.hours}h` : ""}`,
    `Title: ${t.title}`,
    t.description ? `Description:\n${t.description}` : "",
    files.length ? `Attachments (local files; open them with read, images included):\n${files.map((f) => `- ${f.name} (${f.mime}, ${Math.max(1, Math.round(f.bytes / 1024))} KB): ${join(FILES_DIR, f.file)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
function sniffFile(buf) {
  const img = sniffImage(buf);
  if (img) return IMAGE_TYPES[img];
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return IMAGE_TYPES.gif;
  if (buf.length > 4 && buf.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  // Text if it decodes as UTF-8 without control characters (other than tabs and newlines).
  const head = buf.subarray(0, 4096).toString("utf8");
  if (!/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(head)) return "text/plain";
  return "application/octet-stream";
}
const safeName = (n) => basename(String(n || "file")).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "file";
route("POST", "/api/runs/:id/tickets", (b, p) => {
  const r = one("SELECT * FROM runs WHERE id = ?", p.id);
  if (!r) return notFound();
  const from = String(b.from || "human");
  if (from !== "human" && from !== "ceo") throw httpError(400, "tickets come from the human or the CEO");
  const title = String(b.title || "").trim().slice(0, 200);
  if (!title) throw httpError(400, "a ticket needs a title");
  const priority = b.priority ? String(b.priority).toLowerCase() : "normal";
  if (!PRIORITIES.includes(priority)) throw httpError(400, `priority must be one of ${PRIORITIES.join(", ")}`);
  const description = b.description ? String(b.description).trim().slice(0, 20000) || null : null;
  const hours = Number(b.hours) > 0 ? Math.min(1000, Math.round(Number(b.hours) * 10) / 10) : null;
  const files = (Array.isArray(b.attachments) ? b.attachments : []).map((a) => ({ name: safeName(a?.name), data: Buffer.from(String(a?.data || ""), "base64") }));
  if (files.length > 10) throw httpError(400, "up to 10 attachments per ticket");
  if (files.some((f) => !f.data.length)) throw httpError(400, "an attachment is empty");
  if (files.some((f) => f.data.length > 10 * 1024 * 1024)) throw httpError(413, "each attachment can be up to 10 MB");
  if (files.reduce((n, f) => n + f.data.length, 0) > 25 * 1024 * 1024) throw httpError(413, "attachments can be up to 25 MB per ticket");
  const n = 1 + all("SELECT id FROM tasks WHERE run_id = ? AND kind = 'ticket'", p.id).reduce((m, t) => Math.max(m, Number(/^TK-(\d+)$/.exec(t.id)?.[1] || 0)), 0);
  const id = `TK-${n}`;
  run("INSERT INTO tasks (run_id, id, story_id, title, status, worker_id, note, updated, harness, kind, priority, description, hours, created) VALUES (?, ?, 'tickets', ?, 'todo', NULL, NULL, ?, ?, 'ticket', ?, ?, ?, ?)",
    p.id, id, title, now(), DEFAULT_HARNESS, priority, description, hours, now());
  if (files.length) mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const aid = shortId("att");
    const file = `${aid}-${f.name.replace(/ /g, "_")}`;
    writeFileSync(join(FILES_DIR, file), f.data, { mode: 0o600 });
    run("INSERT INTO attachments (id, run_id, task_id, name, mime, bytes, file, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", aid, p.id, id, f.name, sniffFile(f.data), f.data.length, file, now());
  }
  recordTransition(p.id, id, null, "todo", from, `New ${priority} ticket`, null);
  // A finished run takes new work again: it is running, and workers that were closing stay.
  if (r.status === "done" || r.status === "cancelled") {
    touchRun(p.id, "executing");
    run("UPDATE workers SET stop_requested = NULL, stop_at = NULL WHERE run_id = ? AND alive = 1", p.id);
  } else touchRun(p.id);
  const t = one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, id);
  if (from === "human") {
    const idle = all("SELECT w.name, (SELECT COUNT(*) FROM tasks t WHERE t.run_id = w.run_id AND t.worker_id = w.id AND t.status != 'done') AS open FROM workers w WHERE w.run_id = ? AND w.alive = 1 AND w.stop_requested IS NULL", p.id)
      .filter((w) => !w.open).map((w) => w.name);
    addMessage(p.id, "human", "ceo", "ticket", `${ticketText(p.id, t, "New ticket")}\n\nIt is on the board (to do, unassigned) and on the timeline. A ticket needs no plan and no approval: get it done now, without asking questions unless it truly cannot be done otherwise.${priority === "urgent"
      ? ` URGENT: act on it right away, before other work. Assign it to someone free${idle.length ? ` (free now: ${idle.join(", ")})` : ""} with redplan_update_task assignTo and a brief, or spawn a new worker for it with redplan_spawn_worker if nobody is free; if it is small, you may do it yourself.`
      : ` Assign it to someone free${idle.length ? ` (free now: ${idle.join(", ")})` : ""} with redplan_update_task assignTo and a brief, spawn a worker for it if nobody is free and it should not wait, or do it yourself if it is small.`} Then tell the human in one line who is on it.`, true);
  }
  notify(p.id, "task");
  return t;
});
route("GET", "/api/attachments/:id", (_b, p, res) => {
  const row = one("SELECT * FROM attachments WHERE id = ?", p.id);
  if (!row) return notFound();
  let data;
  try { data = readFileSync(join(FILES_DIR, basename(row.file))); } catch { return notFound(); }
  // Images show inline; everything else downloads, never rendered as a page.
  const inline = row.mime.startsWith("image/");
  res.writeHead(200, { "content-type": inline ? row.mime : row.mime === "text/plain" ? "text/plain; charset=utf-8" : "application/octet-stream", "x-content-type-options": "nosniff",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${row.name.replace(/"/g, "")}"`, "cache-control": "private, max-age=86400", "content-length": data.length,
    "content-security-policy": "default-src 'none'; sandbox" });
  res.end(data);
});

// Screenshots agents take of what they built (the Screenshots tab). PNG, JPEG or WebP, up to 8 MB.
const SHOT_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
route("POST", "/api/runs/:id/screenshots", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  const from = String(b.from || "");
  if (from !== "ceo" && !one("SELECT id FROM workers WHERE id = ? AND run_id = ?", from, p.id)) throw httpError(400, "from must be a worker of this run or the CEO");
  const data = Buffer.from(String(b.data || ""), "base64");
  const ext = sniffImage(data);
  if (!ext) throw httpError(400, "data must be a base64 PNG, JPEG or WebP image");
  if (data.length > 8 * 1024 * 1024) throw httpError(413, "screenshot too large (8 MB max)");
  const id = shortId("shot");
  mkdirSync(SHOTS_DIR, { recursive: true, mode: 0o700 });
  const file = `${id}.${ext}`;
  writeFileSync(join(SHOTS_DIR, file), data, { mode: 0o600 });
  const caption = b.caption ? String(b.caption).slice(0, 300) : null, taskId = b.taskId ? String(b.taskId).slice(0, 40) : null;
  run("INSERT INTO screenshots (id, run_id, worker_id, task_id, caption, file, mime, bytes, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, p.id, from, taskId, caption, file, SHOT_TYPES[ext], data.length, now());
  run("INSERT INTO events (worker_id, kind, text, created) VALUES (?, 'shot', ?, ?)", from === "ceo" ? `ceo:${p.id}` : from, `Shared a screenshot${taskId ? ` of ${taskId}` : ""}${caption ? `: ${caption}` : ""}`, now());
  notify(p.id, "screenshot");
  return { id };
});
route("GET", "/api/screenshots/:id", (_b, p, res) => {
  const row = one("SELECT * FROM screenshots WHERE id = ?", p.id);
  if (!row) return notFound();
  let data;
  try { data = readFileSync(join(SHOTS_DIR, basename(row.file))); } catch { return notFound(); }
  res.writeHead(200, { "content-type": row.mime, "cache-control": "private, max-age=86400", "content-length": data.length });
  res.end(data);
});

function httpError(status, message, extra) { const e = new Error(message); e.status = status; e.extra = extra; return e; }
function notFound() { throw httpError(404, "not found"); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, version: VERSION, pid: process.pid, port: PORT });
    // Public: the login page and the static assets (the open-source UI code, no data).
    if (req.method === "GET" && url.pathname.startsWith("/static/")) { let f; try { f = decodeURIComponent(url.pathname.slice(8)); } catch { return send(res, 404, "not found"); } return serveFile(res, f); }
    if (req.method === "GET" && url.pathname === "/login") return serveFile(res, "login.html");
    // Mutations need a custom header, which cross-site pages cannot send without CORS approval.
    if (req.method !== "GET" && req.headers["x-redpi-hq"] !== "1") return send(res, 403, { error: "missing X-RedPi-HQ header" });
    if (req.method === "POST" && url.pathname === "/api/login") {
      const ip = req.socket.remoteAddress || "?";
      if (!loadAuth()) return send(res, 409, { error: "No HQ password yet. In RedPi, run /hq to set one." });
      if (!loginAllowed(ip)) return send(res, 429, { error: "Too many failed sign-ins. Try again in 10 minutes." });
      const b = await readBody(req);
      if (!(await checkPassword(b.user || "", b.password || ""))) { loginFailed(ip); return send(res, 401, { error: "Wrong username or password." }); }
      failures.delete(ip);
      return send(res, 200, { ok: true, next: safeNext(b.next) }, { "set-cookie": sessionCookie(makeSession(loadAuth().user), SESSION_DAYS * 86400) });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") return send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    if (req.method === "GET" && url.pathname === "/api/session") {
      const who = await whoIs(req, url);
      return send(res, 200, { passwordSet: !!loadAuth(), signedIn: !!who, user: who && who !== "token" ? who : null });
    }
    const who = await whoIs(req, url);
    if (!who) {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        url.searchParams.delete("t");
        return send(res, 302, "", { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
      }
      return send(res, 401, { error: "unauthorized" });
    }
    // Pages: a ?t= link (before a password exists) sets the cookie once, then redirects to a clean URL.
    if (req.method === "GET" && !url.pathname.startsWith("/api/") && url.searchParams.has("t")) {
      const ok = tokenOk(url.searchParams.get("t")) && !loadAuth();
      url.searchParams.delete("t");
      return send(res, 302, "", { location: url.pathname + (url.search || ""), ...(ok ? { "set-cookie": `redpi_hq=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` } : {}) });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/runs/") || url.pathname.startsWith("/projects/"))) return serveFile(res, "dashboard.html");
    if (req.method === "GET" && url.pathname.startsWith("/plans/")) return serveFile(res, "plan.html");
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      const l = { res, runId: url.searchParams.get("run") || null };
      listeners.add(l);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clearInterval(ping); listeners.delete(l); });
      return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = req.method === "GET" ? {} : await readBody(req, url.pathname.endsWith("/screenshots") ? 12 * 1024 * 1024 : url.pathname.endsWith("/tickets") ? 36 * 1024 * 1024 : undefined);
      const out = await r.handler(body, m.groups || {}, res, url);
      if (out !== undefined) send(res, 200, out);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message, ...(e.extra || {}) });
  }
});

server.on("error", (e) => {
  // Another hub already owns the port: that one serves every project, so just exit.
  if (e.code === "EADDRINUSE") { console.error(`RedPi HQ: port ${PORT} in use, exiting`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => {
  writeFileSync(join(HQ_DIR, "hq.pid"), `${process.pid}\n`);
  console.log(`RedPi HQ ${VERSION} listening on ${HOST}:${PORT} (db ${join(HQ_DIR, "hq.db")})`);
});
