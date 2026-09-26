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

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const PORT = Number(process.env.REDPI_HQ_PORT || 47291);
// LAN-reachable by default (the dashboard is viewed from other machines); every request needs the token.
const HOST = process.env.REDPI_HQ_HOST || "0.0.0.0";
// Tests run workers on a private tmux server; real runs use the default one.
const TMUX = process.env.REDPI_TMUX_SOCKET ? ["-L", process.env.REDPI_TMUX_SOCKET] : [];
// Changes whenever the server code changes, so clients can restart a stale hub.
export const VERSION = createHash("sha1").update(readFileSync(join(HERE, "server.mjs"))).update(readFileSync(join(HERE, "schedule.mjs"))).digest("hex").slice(0, 12);

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
  CREATE INDEX IF NOT EXISTS messages_run ON messages (run_id, id);
  CREATE INDEX IF NOT EXISTS transitions_task ON task_transitions (run_id, task_id, id);
  CREATE INDEX IF NOT EXISTS events_worker ON events (worker_id, id);
`);

// Columns added after the first release: ALTER only when missing, so existing hubs upgrade in place.
for (const [table, col, type] of [
  ["workers", "session_file", "TEXT"], ["workers", "launch_id", "TEXT"], ["workers", "needs_input", "TEXT"], ["workers", "context", "TEXT"],
  ["workers", "parked_level", "INTEGER NOT NULL DEFAULT 0"], ["workers", "parked_at", "INTEGER"], ["workers", "needs_human", "TEXT"],
  ["events", "ms", "INTEGER"], ["events", "ok", "INTEGER"],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Parked = alive, idle, owns in_progress work, and silent this long. Each ladder step waits this long again.
const PARK_MS = Number(process.env.REDPI_HQ_PARK_MS || 5 * 60 * 1000);

const now = () => Date.now();
const shortId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const TASK_STATUSES = ["todo", "in_progress", "review", "blocked", "done"];
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

function addMessage(runId, sender, recipient, kind, body) {
  const r = run("INSERT INTO messages (run_id, sender, recipient, kind, body, created) VALUES (?, ?, ?, ?, ?, ?)", runId, sender, recipient, kind, String(body), now());
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
  return { run: r, project, plans, plan: latest, workers, tasks, messages };
}

function workerView(w) {
  const attach = w.tmux ? `tmux ${TMUX.length ? `-L ${TMUX[1]} ` : ""}attach -t '=${w.tmux}'` : null;
  const json = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return { ...w, activity: json(w.activity), needs_input: json(w.needs_input), context: json(w.context), alive: !!w.alive, attach, parked: w.parked_level > 0 };
}

function planReview(runId) {
  const row = one("SELECT json FROM plans WHERE run_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1", runId);
  try { return JSON.parse(row?.json || "{}").review === "self" ? "self" : "independent"; } catch { return "independent"; }
}

function recordTransition(runId, taskId, from, to, actor, reason, target) {
  run("INSERT INTO task_transitions (run_id, task_id, from_status, to_status, actor, reason, target, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    runId, taskId, from, to, actor, reason || null, target || null, now());
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw new Error("body too large"); chunks.push(c); }
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

route("GET", "/api/plans/:id", (_b, p) => {
  const plan = planView(one("SELECT * FROM plans WHERE id = ?", p.id));
  if (!plan) return notFound();
  const r = one("SELECT * FROM runs WHERE id = ?", plan.runId);
  return { ...plan, run: r, project: one("SELECT * FROM projects WHERE id = ?", r.project_id),
    latestVersion: one("SELECT MAX(version) AS v FROM plans WHERE run_id = ?", plan.runId).v };
});

route("POST", "/api/plans/:id/decision", (b, p) => {
  const row = one("SELECT * FROM plans WHERE id = ?", p.id);
  if (!row) return notFound();
  if (row.status !== "pending") throw httpError(409, `plan is already ${row.status}`);
  const approve = b.decision === "approve";
  if (!approve && b.decision !== "changes") throw httpError(400, "decision must be approve or changes");
  const comment = b.comment ? String(b.comment).slice(0, 20000) : null;
  run("UPDATE plans SET status = ?, comment = ?, decided = ? WHERE id = ?", approve ? "approved" : "changes_requested", comment, now(), p.id);
  if (approve) {
    const plan = JSON.parse(row.json);
    for (const story of plan.stories || []) for (const t of story.tasks || []) {
      run("INSERT OR REPLACE INTO tasks (run_id, id, story_id, title, status, worker_id, note, updated) VALUES (?, ?, ?, ?, 'todo', NULL, NULL, ?)", row.run_id, t.id, story.id, t.title, now());
    }
  }
  touchRun(row.run_id, approve ? "approved" : "planning");
  addMessage(row.run_id, "human", "ceo", "decision", approve
    ? `Plan v${row.version} APPROVED.${comment ? ` Comment: ${comment}` : ""} Start execution: form the team and spawn workers.`
    : `Plan v${row.version}: CHANGES REQUESTED. ${comment || "(no comment)"} Revise the plan and submit a new version.`);
  notify(row.run_id, "plan");
  return planView(one("SELECT * FROM plans WHERE id = ?", p.id));
});

route("POST", "/api/runs/:id/workers", (b, p) => {
  if (!one("SELECT id FROM runs WHERE id = ?", p.id)) return notFound();
  if (!b.name || !b.role || !b.cwd) throw httpError(400, "name, role, and cwd are required");
  if (one("SELECT id FROM workers WHERE run_id = ? AND name = ?", p.id, b.name)) throw httpError(409, `a worker named ${b.name} already exists in this run`);
  const id = shortId("wkr");
  run(`INSERT INTO workers (id, run_id, name, role, cwd, branch, tmux, status, launch_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
    id, p.id, String(b.name), String(b.role), String(b.cwd), b.branch || null, b.tmux || null, b.launchId || null, now(), now());
  for (const t of b.taskIds || []) run("UPDATE tasks SET worker_id = ?, updated = ? WHERE run_id = ? AND id = ?", id, now(), p.id, String(t));
  if (b.brief) addMessage(p.id, "ceo", id, "brief", b.brief);
  touchRun(p.id, "executing");
  notify(p.id, "worker");
  return workerView(one("SELECT * FROM workers WHERE id = ?", id));
});

route("PATCH", "/api/workers/:id", (b, p) => {
  const w = one("SELECT * FROM workers WHERE id = ?", p.id);
  if (!w) return notFound();
  if (b.tmux !== undefined) run("UPDATE workers SET tmux = ?, alive = 1, updated = ? WHERE id = ?", b.tmux, now(), p.id);
  // A relaunch gets a new launch id; heartbeats from the previous process are ignored from now on.
  if (b.launchId) run("UPDATE workers SET launch_id = ?, alive = 1, parked_level = 0, needs_human = NULL, needs_input = NULL, updated = ? WHERE id = ?", String(b.launchId), now(), p.id);
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
  if (b.launchId && w.launch_id && b.launchId !== w.launch_id) return { ok: false, stale: true };
  run(`UPDATE workers SET status = COALESCE(?, status), current_task = COALESCE(?, current_task), last_message = COALESCE(?, last_message), activity = COALESCE(?, activity),
    session_file = COALESCE(?, session_file), context = COALESCE(?, context), alive = 1, parked_level = 0, parked_at = NULL, needs_human = NULL, updated = ? WHERE id = ?`,
    b.status ?? null, b.currentTask ?? null, b.lastMessage != null ? String(b.lastMessage).slice(0, 8000) : null, b.activity ? JSON.stringify(b.activity) : null,
    b.sessionFile ? String(b.sessionFile) : null, b.context ? JSON.stringify(b.context) : null, now(), p.id);
  // needsInput: {count, reason} while something waits on a person; null clears it.
  if (b.needsInput !== undefined) run("UPDATE workers SET needs_input = ? WHERE id = ?", b.needsInput ? JSON.stringify(b.needsInput) : null, p.id);
  for (const e of (b.events || []).slice(0, 50)) run("INSERT INTO events (worker_id, kind, text, ms, ok, created) VALUES (?, ?, ?, ?, ?, ?)",
    p.id, String(e.kind || "info"), String(e.text || "").slice(0, 2000), Number.isFinite(e.ms) ? Math.round(e.ms) : null, e.ok === undefined ? null : e.ok ? 1 : 0, now());
  run("DELETE FROM events WHERE worker_id = ? AND id < (SELECT COALESCE(MAX(id), 0) - 500 FROM events WHERE worker_id = ?)", p.id, p.id);
  notify(w.run_id, "worker");
  return { ok: true };
});

route("POST", "/api/runs/:id/tasks/:task", (b, p) => {
  const t = one("SELECT * FROM tasks WHERE run_id = ? AND id = ?", p.id, p.task);
  if (!t) throw httpError(404, `no task ${p.task} in this run (tasks exist after the plan is approved)`);
  if (b.status && !TASK_STATUSES.includes(b.status)) throw httpError(400, `status must be one of ${TASK_STATUSES.join(", ")}`);
  const actor = String(b.actor || "ceo");
  const note = b.note != null ? String(b.note).trim().slice(0, 2000) : "";

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
  if (b.status === "done" && !note) throw httpError(400, "done needs a note saying how the work was verified (tests, build, review)");
  // Independent review: the author moves work to review; someone else marks it done.
  if (b.status === "done" && t.worker_id && actor === t.worker_id && planReview(p.id) === "independent") {
    throw httpError(409, "this plan uses independent review: move the task to review; the reviewer (or the CEO) marks it done");
  }

  run("UPDATE tasks SET status = COALESCE(?, status), worker_id = COALESCE(?, worker_id), note = COALESCE(?, note), updated = ? WHERE run_id = ? AND id = ?",
    b.status || null, b.workerId || null, note || null, now(), p.id, p.task);
  if (b.status && b.status !== t.status) {
    recordTransition(p.id, p.task, t.status, b.status, actor, note, null);
    addMessage(p.id, actor, "all", "task", `${p.task} ${t.title}: ${t.status} → ${b.status}${note ? ` (${note})` : ""}`);
    if (b.status === "review" && t.worker_id) {
      addMessage(p.id, "human", "ceo", "system", `${p.task} ${t.title} is ready for review. ${planReview(p.id) === "independent" ? "Have the independent reviewer check the exact diff against the acceptance criteria." : ""}`.trim());
    }
  }
  if (b.status === "in_progress" && actor.startsWith("wkr_")) run("UPDATE workers SET current_task = ?, updated = ? WHERE id = ?", p.task, now(), actor);
  const open = one("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ? AND status != 'done'", p.id).n;
  if (!open && b.status === "done") addMessage(p.id, "human", "ceo", "system", "All tasks are done. Integrate the work (merge worktrees), run the full verification, do a final review, then report to the human.");
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
  const kind = ["chat", "command", "interrupt", "aside"].includes(b.kind) ? b.kind : "chat";
  const id = addMessage(p.id, String(b.from || "human"), String(b.to), kind, String(b.body).slice(0, 20000));
  return { id };
});

route("GET", "/api/runs/:id/inbox", (_b, p, _res, url) => {
  const who = url.searchParams.get("for");
  const after = Number(url.searchParams.get("after") || 0);
  if (!who) throw httpError(400, "for is required");
  return all(`SELECT * FROM messages WHERE run_id = ? AND id > ? AND sender != ? AND (recipient = ? OR recipient = 'all') AND kind != 'task' ORDER BY id LIMIT 100`, p.id, after, who, who)
    .map((m) => ({ ...m, senderName: participantName(p.id, m.sender) }));
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
      const body = req.method === "GET" ? {} : await readBody(req);
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
