// RedPlan: plan with the user, get the plan approved in RedPi HQ, then run it with named
// worker sub-sessions (full Pi sessions in tmux) that coordinate through HQ.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addLesson, projectRoot, LESSONS_FILE } from "../lib/knowledge.mjs";
import { secretInput } from "../lib/secret-input.ts";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { isClaudeBridge, systemTextChannel } from "../lib/claude-bridge.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const HQ_PORT = Number(process.env.REDPI_HQ_PORT || 47291);
const TMUX_SOCKET = process.env.REDPI_TMUX_SOCKET || "";
// Set in worker sessions by redplan_spawn_worker; absent in the CEO session.
const WORKER_ID = process.env.REDPI_HQ_WORKER || "";
// A manager is a worker who leads a team: it spawns, resumes and dismisses its own people.
const IS_MANAGER = !!WORKER_ID && process.env.REDPI_HQ_MANAGER === "1";
const WORKER_RUN = process.env.REDPI_HQ_RUN || "";
const LAUNCH_ID = process.env.REDPI_HQ_LAUNCH || "";
// Error text that means the worker is stuck on its provider, not on the task (same families the router retries on).
const PROVIDER_STUCK = /rate limit|429|quota|insufficient_quota|weekly limit|session limit|credits|tokens exhausted|overloaded|401|api key/i;
const PKG_ROOT = resolve(typeof __dirname === "string" ? __dirname : process.cwd(), "..");
const SERVER = join(PKG_ROOT, "hq", "server.mjs");

const CEO_TOOLS = ["redplan_submit_plan", "redplan_add_ticket", "redplan_ask", "redplan_spawn_worker", "redplan_resume_worker", "redplan_dismiss_worker", "redplan_status", "redplan_send", "redplan_ask_human", "redplan_update_task", "redplan_finish_run", "redplan_share_screenshot"];
const WORKER_TOOLS = ["redplan_update_task", "redplan_send", "redplan_team", "redplan_status", "redplan_share_screenshot"];
const MANAGER_TOOLS = [...WORKER_TOOLS, "redplan_spawn_worker", "redplan_resume_worker", "redplan_dismiss_worker", "redplan_ask"];
// Shell commands that would kill agent sessions (the CEO's or a teammate's tmux, or every Pi/Node
// process at once). The team is managed with redplan_dismiss_worker and messages, never by killing.
const SESSION_KILL = /\btmux\b[^|;&\n]*\bkill-(server|session|pane|window)\b|\b(pkill|killall)\b[^|;&\n]*(\bpi\b|\bnode\b|\btmux\b|redpi)/i;
// Work that has a user interface: those workers check it in a real browser and share screenshots.
const FRONTEND_RE = /\b(ui|ux|frontend|front-end|web ?app|website|css|html|react|vue|svelte|angular|next\.?js|nuxt|tailwind|page|screen|component|dashboard|layout|visual|browser|mobile|responsive|playwright)\b/i;
const HARNESS_LIST = ["pi", "claude", "codex", "opencode"];
const HARNESS_NAME: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const RUNNER = join(PKG_ROOT, "hq", "runner.mjs");
const NAMES = ["Alex", "Peter", "Mia", "Sam", "Nina", "Leo", "Ivy", "Omar", "Zoe", "Kai", "Ruby", "Theo", "Maya", "Finn", "Lena", "Ravi"];

// ---------- HQ client ----------
function hqToken(): string {
  try { return readFileSync(join(HQ_DIR, "token"), "utf8").trim(); } catch { return ""; }
}

function localVersion(): string {
  // Same fingerprint the server reports, so a hub running older code gets restarted.
  const h = createHash("sha1");
  h.update(readFileSync(SERVER));
  h.update(readFileSync(join(PKG_ROOT, "hq", "schedule.mjs")));
  h.update(readFileSync(join(PKG_ROOT, "hq", "harnesses.mjs")));
  return h.digest("hex").slice(0, 12);
}

async function hqHealth(): Promise<{ version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${HQ_PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? ((await res.json()) as any) : null;
  } catch { return null; }
}

async function ensureHq(): Promise<void> {
  const health = await hqHealth();
  if (health && health.version === localVersion()) return;
  if (health) {
    await fetch(`http://127.0.0.1:${HQ_PORT}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${hqToken()}`, "x-redpi-hq": "1" } }).catch(() => {});
    for (let i = 0; i < 30 && (await hqHealth()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  mkdirSync(HQ_DIR, { recursive: true });
  const log = openSync(join(HQ_DIR, "hq.log"), "a");
  const child = spawn(process.execPath, ["--no-warnings", SERVER], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, REDPI_HQ_DIR: HQ_DIR, REDPI_HQ_PORT: String(HQ_PORT) } });
  child.unref();
  for (let i = 0; i < 60; i++) {
    const h = await hqHealth();
    if (h) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`RedPi HQ did not start on port ${HQ_PORT}; see ${join(HQ_DIR, "hq.log")}`);
}

async function hq(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${HQ_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${hqToken()}`, "x-redpi-hq": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HQ ${res.status}`), { data });
  return data;
}

function lanHost(): string {
  if (process.env.REDPI_HQ_PUBLIC_HOST) return process.env.REDPI_HQ_PUBLIC_HOST;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal && !/^(172\.1[7-9]|172\.2\d|172\.3[01]|192\.168\.122)\./.test(a.address)) return a.address;
  }
  return "localhost";
}

// With a password, links are plain (the browser signs in). Before one exists, links carry the token once.
function hqUrl(path: string): string {
  return `http://${lanHost()}:${HQ_PORT}${path}${hqAuth() ? "" : `?t=${encodeURIComponent(hqToken())}`}`;
}

// ---------- HQ password (browser sign-in) ----------
const AUTH_PATH = join(HQ_DIR, "auth.json");
function hqAuth(): { user: string } | null {
  try { const a = JSON.parse(readFileSync(AUTH_PATH, "utf8")); return a.user && a.hash ? a : null; } catch { return null; }
}

function saveHqPassword(user: string, password: string): void {
  mkdirSync(HQ_DIR, { recursive: true });
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = scryptSync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }).toString("hex");
  const tmp = `${AUTH_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, user, salt: salt.toString("hex"), hash, N, r, p, updated: Date.now() }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, AUTH_PATH);
  try { chmodSync(AUTH_PATH, 0o600); } catch {}
}

// A one-line input that shows dots instead of the text (Pi's input dialog echoes what you type).
// Ask for the HQ username and password. Returns false if the user backed out.
async function setupHqPassword(ctx: any, changing = false): Promise<boolean> {
  if (!ctx.hasUI) return false;
  ctx.ui.notify(changing
    ? "Change the RedPi HQ password. Browsers that are signed in will need to sign in again."
    : `RedPi HQ (the RedPlan dashboard) is reachable from your network at http://${lanHost()}:${HQ_PORT}.\nChoose a username and password to protect it. You can change them later with /hq-password.`, "info");
  const fallback = hqAuth()?.user || userInfo().username || "admin";
  const user = ((await ctx.ui.input("HQ username", fallback)) ?? "").trim() || (changing ? "" : fallback);
  if (!user) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pw = await secretInput(ctx, `Password for ${user} (at least 8 characters)`);
    if (pw === undefined) return false;
    if (pw.length < 8) { ctx.ui.notify("Use at least 8 characters.", "warning"); continue; }
    const again = await secretInput(ctx, "Type the password again");
    if (again === undefined) return false;
    if (again !== pw) { ctx.ui.notify("The passwords did not match. Try again.", "warning"); continue; }
    saveHqPassword(user, pw);
    ctx.ui.notify(`HQ password saved. Sign in as "${user}" at http://${lanHost()}:${HQ_PORT}/`, "info");
    return true;
  }
  return false;
}

// First use: RedPlan and /hq insist on a password before printing dashboard links.
async function ensureHqPassword(ctx: any): Promise<boolean> {
  if (hqAuth() || WORKER_ID) return true;
  if (!ctx.hasUI) return true;
  if (await setupHqPassword(ctx)) return true;
  ctx.ui.notify("RedPi HQ needs a password before RedPlan can start. Run /hq to set one.", "warning");
  return false;
}

function tmuxArgs(...args: string[]): string[] {
  return TMUX_SOCKET ? ["-L", TMUX_SOCKET, ...args] : args;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "worker";
}

function text(content: string, details: any = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

// ---------- plan schema (doubles as the planning contract the model sees) ----------
const TaskSchema = Type.Object({
  id: Type.String({ description: "Short unique id, e.g. T1 or S2.3" }),
  title: Type.String({ description: "Human-readable title, e.g. 'User management service'" }),
  description: Type.String({ description: "What and why, readable by a non-specialist but technical enough to judge: name the component, its purpose, and the library/API used. Avoid file paths and class names unless the user gave them." }),
  tech: Type.Optional(Type.String({ description: "Technology/library this task uses, matching a techStack entry" })),
  estimateHours: Type.Number({ description: "Realistic effort in hours for one agent session" }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task ids that must finish first. Leave empty when the task can start in parallel." })),
  suggestedRole: Type.Optional(Type.String({ description: "Worker role best suited, e.g. backend developer" })),
  harness: Type.Optional(Type.Union(HARNESS_LIST.map((h) => Type.Literal(h)), { description: "Coding agent that runs this task. Omit (Pi) unless the human asked for Claude Code (claude), Codex (codex), or OpenCode (opencode); the human can also change it on the plan page." })),
});

const PlanSchema = Type.Object({
  title: Type.String(),
  summary: Type.String({ description: "One paragraph a non-engineer can follow" }),
  goal: Type.Optional(Type.String({ description: "Measurable outcome" })),
  intake: Type.Optional(Type.Object({ mode: Type.String({ description: "grilled (asked the user questions first) or direct (request was already clear)" }), notes: Type.String({ description: "What was clarified and decided" }) })),
  techStack: Type.Array(Type.Object({
    name: Type.String({ description: "As the user said it, e.g. 'LangChain Deep Agents'" }),
    package: Type.String({ description: "Exact package/artifact, e.g. deepagents" }),
    ecosystem: Type.Optional(Type.String({ description: "npm, PyPI, crates.io, Docker Hub, SaaS…" })),
    version: Type.Optional(Type.String()),
    usedFor: Type.String({ description: "Its job in this system" }),
    uses: Type.String({ description: "Exactly what is used from it: classes, functions, endpoints, e.g. create_deep_agent(tools, instructions, subagents)" }),
    source: Type.String({ description: "Primary-source URL you checked (official docs, registry page, repo README)" }),
    verified: Type.Boolean({ description: "true only if you confirmed the package and API from the source in this session" }),
    verifiedFact: Type.Optional(Type.String({ description: "The fact you confirmed, e.g. 'deepagents exports create_deep_agent'" })),
    notThis: Type.Optional(Type.String({ description: "A similar-sounding thing this is NOT, to prevent mix-ups" })),
  })),
  architecture: Type.Object({
    components: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), kind: Type.String({ description: "ui, service, agent, db, queue, external, library" }), tech: Type.Optional(Type.String()), description: Type.Optional(Type.String()) })),
    links: Type.Array(Type.Object({ from: Type.String(), to: Type.String(), label: Type.Optional(Type.String()) })),
  }),
  stories: Type.Array(Type.Object({
    id: Type.String({ description: "e.g. S1" }),
    title: Type.String(),
    userStory: Type.String({ description: "As a <user>, I want <capability>, so that <benefit>" }),
    description: Type.Optional(Type.String()),
    acceptance: Type.Array(Type.String(), { description: "Observable acceptance criteria" }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Story ids that must be complete first (all their tasks)" })),
    tasks: Type.Array(TaskSchema),
  })),
  flows: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ description: "Short slug, e.g. login" }),
    title: Type.String({ description: "The feature in plain words, e.g. 'Sign in with username and password'" }),
    storyIds: Type.Optional(Type.Array(Type.String(), { description: "Stories this flow explains" })),
    trigger: Type.Optional(Type.String({ description: "What starts it, e.g. 'User opens /login'" })),
    steps: Type.Array(Type.Object({
      id: Type.String({ description: "Unique within the flow, e.g. s1, check-hash" }),
      where: Type.String({ description: "Where it happens: component and technology, e.g. 'Browser · Next.js login form' or 'NestJS AuthService'" }),
      action: Type.String({ description: "What happens, in plain words a non-engineer can check, e.g. 'User types username and password and presses Sign in'. For a decision, the question: 'Does the password match the stored hash?'" }),
      kind: Type.Optional(Type.String({ description: "user, ui, service, db, queue, external, agent, or decision (a yes/no or multi-way branch)" })),
      component: Type.Optional(Type.String({ description: "Architecture component id where this runs" })),
      tech: Type.Optional(Type.String({ description: "Library/API used in this step, e.g. 'bcrypt.compare' or 'POST /auth/login'" })),
      data: Type.Optional(Type.String({ description: "Data in or out, e.g. 'username + password over HTTPS', 'JWT in an httpOnly cookie'" })),
      next: Type.Optional(Type.Array(Type.Object({ to: Type.String({ description: "Step id" }), label: Type.Optional(Type.String({ description: "Branch condition, e.g. 'yes', 'wrong password', 'timeout'" })) }), { description: "Where it goes next. Omit to continue with the following step. Decisions list every branch with a label." })),
      end: Type.Optional(Type.Boolean({ description: "true for a final step (success or a failure outcome)" })),
    })),
  }), { description: "One flowchart per feature, so the human can confirm the business logic and the tech at each step: the end-to-end path of a request (user action → UI → API → services → database/external → back to the user), including the important failure branches." })),
  team: Type.Optional(Type.Array(Type.Object({ name: Type.String(), role: Type.String(), taskIds: Type.Array(Type.String()) }), { description: "Proposed workers: one per parallel lane" })),
  review: Type.Optional(Type.Union([Type.Literal("independent"), Type.Literal("self")], { description: "independent (default): builders move tasks to review and a separate reviewer marks them done. self: builders mark their own tasks done." })),
  risks: Type.Optional(Type.Array(Type.String())),
  outOfScope: Type.Optional(Type.Array(Type.String())),
  changes: Type.Optional(Type.Array(Type.String(), { description: "Revisions only: what changed since the previous version, one line per numbered human comment, starting with its number, e.g. '#2 Split the API into auth and chat services'. Answer questions here too." })),
});

// ---------- prompts ----------
const CEO_PROTOCOL = `RedPlan mode is ON. You are the CEO session: you plan with the human, get the plan approved in RedPi HQ, then lead a team of named worker sessions.

Two kinds of work come to you:
- A /redplan request (the human typed /redplan): follow Phases 1–4 below.
- Everything else is a quick ticket: any new request the human types here without /redplan, sends you as a message in HQ, or files as a ticket in HQ. A ticket needs no plan, no approval, no plan review and no interview. Put a request typed here or sent as a message on the board with redplan_add_ticket (tickets filed in HQ are already there, with the human's description and attachments), then get it done at once: give it to a free worker (redplan_update_task assignTo, with a brief), spawn a new worker for it if nobody is free (redplan_spawn_worker with the ticket id; allowed without an approved plan), or do it yourself if it is small and you are free. Urgent tickets come before everything else: act immediately, pull in a free worker, and spawn another worker rather than wait. Make reasonable assumptions and state them; ask the human only if the work truly cannot be done otherwise. Tell the human in one line who is on it. Comments on a plan that is still under review are plan feedback, not tickets. Tickets follow the same review and done rules as plan tasks, and a new ticket reopens a finished run.

Phase 1 — Intake (only for a /redplan request). Judge whether the request is deterministic: a clear spec or prototype with the users, scope, constraints, key technologies, and success criteria decided. If it is, say so in one line and skip to Phase 2. If not, load the grill-me skill and follow it: ask the human one focused question at a time until those decisions are made. Never guess a decision the human should make.

Phase 2 — Verify technology. For every library, framework, model, or service the human named or you choose, confirm the exact package and API from a primary source before planning with it: official docs, the package registry (e.g. \`curl -s https://pypi.org/pypi/<pkg>/json\`, \`npm view <pkg> version description\`), or the repository README (redpi_browser or curl). Record the package, what you will use from it, the source URL, and the fact you confirmed. Take names literally: "Deep Agents from LangChain" is the \`deepagents\` package and its create_deep_agent API, not an agent that thinks deeply; never substitute a similar-sounding concept. If you cannot verify something, set verified=false and add it to risks.

Phase 3 — Plan. Break the work into user stories a human understands, each with acceptance criteria and tasks. Tasks are human-readable but technical enough to judge the decision ("A user-management service using FastAPI and SQLAlchemy that stores roles in Postgres"), not file-level instructions. Estimate hours. Model dependencies precisely: a task depends on another only if it truly needs its output, so independent work can run in parallel. Include the architecture (components and links) and a proposed team (one worker per parallel lane, named, with a role). Draw flows: one flowchart per feature the human will use (usually one per story), step by step from the user's action to the result, each step saying where it runs (component and technology), what happens in plain words, and what data moves, with decision steps for the branches that matter (wrong password, not found, timeout, retry). The human reads the flows to confirm the business logic and the tech at each step, so make them concrete and readable: "User types username and password (Browser · Next.js login form)" → "Form posts them over HTTPS to POST /auth/login (NestJS AuthController)" → "Look up the user and compare the password with its bcrypt hash (NestJS AuthService · Postgres users table)" → decision "Match?" → yes: "Issue a JWT in an httpOnly cookie" / no: "Show 'wrong username or password'". Submit with redplan_submit_plan; fix any validation errors it reports and resubmit. Then give the human the plan link and stop: do not implement anything before approval. Approval or change requests arrive as [RedPlan] messages. The human reviews on the plan page by highlighting text and pinning comments on the diagrams; change requests list those comments numbered, each with where it points (a story, task, diagram element, or quoted text). Address every one: revise the plan, resubmit, and fill "changes" with one line per comment ("#1 …"), answering questions there as well. If a comment is unclear, ask the human in this chat before resubmitting. The human may also keep chatting with you here in the terminal between reviews; treat that the same as page feedback.

Phase 4 — Execute (only after "Plan … APPROVED"). Lead through managers when the plan is big: with more than about 6 tasks spread over distinct areas (frontend, backend, security, infra, data, mobile…), spawn one manager per area (redplan_spawn_worker with manager true, team "Frontend" and the like, taskIds = that area's tasks, brief = the area's goal, constraints, and the interfaces it shares with other areas). Each manager staffs and runs its own builders and reviewers, handles its people's blockers and HQ alerts first, dismisses its idle people, and reports to you; you coordinate the managers, cross-team interfaces, integration and the human, and you do not micromanage their people (message the manager, not their builders). A small plan or one area: staff builders directly as below. Form the team for speed: one builder for every task that can start now (the plan's first wave; up to 10 builders), each with ONE task (or a short chain of tasks only that person can do in order), never a queue of independent tasks that others could run in parallel. Add independent reviewers unless the plan sets review to "self": one per three builders, at least one, at least two from six builders. Aim for the first working version as early as possible: order the first wave as a thin end-to-end slice that runs (even with rough edges), tell the human as soon as it is up (with screenshots for UI), and deepen it in the following waves. Builders move tasks to review; HQ sends each one straight to a reviewer (the same reviewer when it comes back), so you do not relay reviews. The reviewer checks the exact diff against the acceptance criteria and marks it done, or sends it back to its author with findings. When HQ tells you work is waiting (tasks that could start while builders are free or everyone is busy) or that a review queue is growing, act at once: hand the tasks to the free builders, or spawn more builders or reviewers. HQ also watches the run for you: an "HQ watch" message means it caught something going wrong (two agents talking in circles, someone burning tokens without moving a card, the same step repeated, a task far past its estimate, a task bouncing through review, a board that stopped moving, messages to a worker that is gone, unanswered questions). Treat it as urgent: find out what is happening, fix it (decide the question, redirect, split or reassign the work, resume a worker), and it clears itself when the pattern stops; if it is still happening 15 minutes later the human is told. The human has an inbox in HQ: tickets with a status for blockers on them, escalated alerts, plan approvals, and questions. Their answers reach you as messages starting with [Inbox #N …]: act on them first. Ask the human only what only they can decide or give, with redplan_ask_human (a question, or kind "approval" for a yes/no), never as a loose question in chat. Everything else is yours to handle without the human: HQ watch alerts, stuck, parked or lost workers, sessions that ended, review loops, and blockers a worker marks "human" (HQ sends those to you first: decide them yourself unless they truly need the human). Never pass a problem to the human that you can fix. To find out what is going on (checking progress, investigating an alert or a slow task, reading what a command or log showed), use redplan_ask: workers answer from their own session within seconds without stopping their work, and you can ask several at once. Do not wait on redplan_send for information. Every 30 minutes HQ sends you a check-in with the numbers: act on anything wrong, post the human a 2-3 line status only when something changed or is wrong, and otherwise stay silent. HQ also sends a "Token check" each time one agent's spend on one task passes another 5M tokens (5M, 10M, 15M, ...): check that nothing is leaking or looping (what they are doing now, repeated steps or re-reads, how full their context is), let it continue only if it is progressing, otherwise redirect, split or reassign the task. In the retrospective, turn each HQ watch finding and costly task into a lesson. For each worker choose workspace "shared" when its tasks touch areas no teammate edits, or "worktree" (its own git branch) when teammates would edit the same files. Each task has a harness, the coding agent it runs on: Pi by default, or Claude Code, Codex, or OpenCode when the human chose that on the plan page (the approval message lists them). A worker runs on exactly one harness, so group tasks by harness and pass it to redplan_spawn_worker; non-Pi workers use a \`redpi-hq\` shell command instead of the redplan_* tools, which HQ explains to them. Spawn each with redplan_spawn_worker and a self-contained brief: the goal, its tasks with acceptance criteria, the verified tech decisions it must use (exact packages/APIs), the interfaces it shares with named teammates, the approved flows for its stories (step by step, including the failure branches) so it builds exactly that behavior, and how to verify its work. Then coordinate: answer [RedPlan] messages from workers quickly, unblock them, re-balance tasks (hand off with a note rather than silently reassigning), and keep the board honest. HQ tells you when a worker is parked (idle while owning work) or gone: nudge it, reassign its work, or bring it back with redplan_resume_worker, which continues its saved session. When HQ says nobody is working on a task (its owner's session ended), act at once: resume the owner or hand the task to someone; never leave work with nobody on it. Keep the team as small as the work needs: when a worker has nothing left and no more work is coming for them, lay them off with redplan_dismiss_worker (name "idle" dismisses everyone with nothing left; their open work must be handed over or returned to the board first). Never kill a worker's tmux session or process yourself (RedPlan blocks it): a killed worker leaves its tasks with nobody on them. Staff for speed: the run finishes only as fast as the critical path, so keep whoever owns critical-path tasks on those alone and give everything else to others (HQ warns you when one person holds most of it). Briefs for UI work ask the worker to check it in the browser with Playwright and share screenshots. Keep the team quiet once work is done: no re-review loops, and a closed task is reopened only with evidence (HQ allows it once; after that the human decides). Right after approval, record the plan's key decisions (the verified technologies and the architecture) as ADRs with redpi_adr, one per decision, citing the plan, so every worker builds on them. When every task is done: merge worktree branches (renumber any ADRs that got the same number on different branches, and keep docs/adr/README.md in step), run the full verification, review the result against the plan, then hold a short retrospective: what slowed the run or went wrong (waiting, rework, review loops, wrong assumptions, slow builds) and what the next run should do differently. Call redplan_finish_run with those lessons (they go into docs/lessons-learned.md, which every later session reads) and report to the human; finishing the run closes the workers' sessions. For a ticket, the worker records its own decisions and lessons. Throughout, narrate as you work: before each meaningful step write one short plain-language sentence of what you are doing and why, and after it what you found or decided; the human follows these lines live in RedPi HQ.`;

async function workerPrompt(): Promise<string> {
  const d = await hq("GET", `/api/workers/${WORKER_ID}`);
  const w = d.worker;
  if (w.is_manager) return managerPrompt(d);
  // Who this worker answers to: their manager (inside a team) or the CEO.
  const lead = d.manager ? d.manager.name : "the CEO";
  const independent = d.review !== "self";
  const reviewer = /review|qa|audit/i.test(w.role);
  const tasks = d.tasks.map((t: any) => `- ${t.id} ${t.title} [${t.status}]${t.kind === "ticket" ? ` (ticket from the human, ${t.priority === "urgent" ? "URGENT: before anything else" : `${t.priority || "normal"} priority`})` : ""}`).join("\n") || (reviewer ? "- (you review teammates' tasks as they reach review)" : "- (none yet; ask the CEO)");
  const team = d.teammates.map((t: any) => `- ${t.name} (${t.role})${t.current_task ? `: working on ${t.current_task}` : ""}`).join("\n") || "- (just you)";
  const frontend = FRONTEND_RE.test(`${w.role} ${d.tasks.map((t: any) => t.title).join(" ")} ${d.brief || ""}`);
  const finish = reviewer
    ? "done only after you have checked the exact diff against the task's acceptance criteria and run its tests. HQ sends you each task that reaches review, with the author's workspace and the criteria; keep it in review while you check it (never move it to in_progress to mean \"reviewing\"). Review within minutes, oldest first. Pass: done, with how you verified it and any minor issues listed in the note (do not send work back for nits or style). Fail (a criterion not met, or a real bug): in_progress with concrete findings; it goes back to its author and returns to you for the re-check."
    : independent
      ? "review (not done) once it is implemented and you verified it yourself; an independent reviewer marks it done."
      : "done once it is implemented and verified (tests/build pass), with a note on how you verified it.";
  return `RedPlan worker. You are ${w.name}, ${w.role}, ${d.manager ? `in the ${d.manager.team || d.manager.role} team led by ${d.manager.name} (your manager), under the CEO session (another Pi)` : "in a team led by the CEO session (another Pi)"}. Run: "${d.run.title}". Workspace: ${w.cwd}${w.branch ? ` on branch ${w.branch}` : " (shared with teammates)"}.
Your tasks:
${tasks}
Teammates:
${team}
How you work:
1. Move your cards with redplan_update_task: in_progress when you start; ${finish}${reviewer ? "" : " When a reviewer sends a task back with findings, fix it before anything else."} Blocked needs a note with the reason and what would unblock it, and waitingOn: the teammate who must act (they get the note), "ceo", "external", or "human" only for a decision or access only the human can give. A blocker you mark "human" goes to the CEO first, who decides it or asks the human; the answer comes back to you. Waiting on a teammate is not the human's problem. If someone else should finish a task, hand it off (handoffTo) with a note on what is done and what is next.
2. Talk to teammates directly with redplan_send (to their name) when you need or change a shared interface; answer their questions promptly and concretely. Set needsReply when you need an answer or an action; plain updates need none and do not wake a teammate whose work is done. Never send acknowledgements ("thanks", "got it", "agreed") and do not reply to updates that ask nothing. ${d.manager ? `Ask ${d.manager.name}, your manager, for decisions outside your tasks or when blocked; they escalate to the CEO what crosses teams.` : `Ask the CEO (to "ceo") for decisions outside your tasks or when blocked.`}
3. Messages arrive as user messages starting with [RedPlan …]. Instructions from the human override everything else.
4. Stay in scope: change only what your tasks need. In a shared workspace never edit files a teammate owns. In a worktree, commit to your branch with clear messages and do not merge.
5. Use the exact technologies and APIs in your brief; do not substitute look-alikes.
6. When all your tasks are done, send ${lead} one short report (what changed, how you verified it, anything left) and wait: no new work, no re-reviews, no reopening closed tasks. Never close your own session or a teammate's (no tmux kill, pkill or killall of Pi/Node/tmux): ${lead} dismisses workers the team no longer needs. If you think a closed task is wrong, send its reviewer or ${lead} the evidence once.
7. Long commands (docker builds, big test suites, deploys): start them with redpi_job and wait with redpi_job wait, never with sleep loops. If one is slower than expected, investigate (its logs, processes, docker, disk, network) and tell ${lead} what you found before waiting more.
8. Leave the project smarter than you found it. Before moving a task to review: record each significant decision you made as an ADR with redpi_adr (library or service, architecture, data model, API contract, a trade-off someone could question; give the task id), and anything that cost you real time with redpi_lesson (what happened, the lesson, what to do next time). Commit them with your change. Read the lessons and decisions in your instructions first and follow them.${reviewer ? " As a reviewer, check that significant decisions in the diff have an ADR and send the task back if one is missing." : ""}
Keep the human informed: before each meaningful step, write one short plain-language sentence saying what you are about to do and why (e.g. "Reading the auth module to see how sessions are stored."), and after it, one sentence on what you found or changed. The human follows these lines live in RedPi HQ.

${frontend ? `Frontend work: check what you built in a real browser before moving a card to review. Use Playwright: redpi_browser for quick checks (goto <url>, text, click, console, errors, viewport phone|desktop, screenshot <path>; it waits until the page is fully loaded and says "ready", so do not sleep or re-take screenshots to check) or a Playwright script for whole flows (there, wait for the content you expect with expect(...).toBeVisible() rather than fixed timeouts). Load every page your task touches, click through its flows including the failure branches, check the console for errors, and look at it at desktop (1280px) and phone (390px) widths. Take screenshots of the finished result and share them with redplan_share_screenshot (task id and a caption saying what it shows); they appear in HQ's Screenshots tab and the reviewer checks them. redpi_browser screenshots are shared automatically.${reviewer ? " As the reviewer of UI work, look at the shared screenshots and re-check the flows in the browser yourself." : ""}

` : ""}Team norms: review the exact change, not a description of it. Never close or mark someone else's task on their behalf unless you are its reviewer. A task closes with evidence (a test, a build, a review), not a claim. Record decisions and their reasons in your task notes or messages so the next person can follow them. Services you run for a task (servers, databases) go in your own Docker dev stack via \`redpi-dev\` (it gives you your own stack name and free host port); put the URL in your notes, never stop a teammate's stack or processes, and \`redpi-dev down\` yours when you finish (reviewers start their own). Close any browser you opened.`;
}

// A manager leads one area of the plan with its own team: it staffs, unblocks, dismisses and reports.
function managerPrompt(d: any): string {
  const w = d.worker;
  const team = w.team || w.role;
  const owner = (t: any) => t.worker_id === w.id ? "you (not staffed yet)" : d.reports.find((r: any) => r.id === t.worker_id)?.name || "someone else";
  const tasks = d.teamTasks.map((t: any) => `- ${t.id} ${t.title} [${t.status}] — ${owner(t)}`).join("\n") || "- (none yet: the CEO will hand you tasks)";
  const reports = d.reports.filter((r: any) => r.alive && !r.stop_requested).map((r: any) => `- ${r.name} (${r.role})${r.current_task ? `: on ${r.current_task}` : ""}`).join("\n") || "- (nobody yet: spawn your builders)";
  const others = d.teammates.filter((t: any) => t.manager_id !== w.id).map((t: any) => `- ${t.name} (${t.is_manager ? `manager of ${t.team || t.role}` : t.role})`).join("\n") || "- (none)";
  const independent = d.review !== "self";
  return `RedPlan manager. You are ${w.name}, manager of the ${team} team, reporting to the CEO session (another Pi). Run: "${d.run.title}". Workspace: ${w.cwd} (shared). You lead; your builders write the code (you only make tiny fixes yourself).
Your area's tasks:
${tasks}
Your team:
${reports}
Other people in the run:
${others}
How you lead:
1. Staff for speed, right away: spawn one builder per task in your area that can start now (redplan_spawn_worker with one task each and a self-contained brief: goal, acceptance criteria, exact tech/APIs, interfaces with named teammates, how to verify; workspace "worktree" when builders would edit the same files). Tasks you have not staffed yet are yours.${independent ? " Spawn a reviewer for your team (role \"independent reviewer\") once you have two or more builders; HQ sends your team's reviews to them." : ""}
2. Keep them moving: answer your people's questions within minutes, decide what is inside your area yourself, unblock them, and move work between them (redplan_update_task assignTo / handoffTo, with a note). Check on someone quietly with redplan_ask (instant, does not interrupt them). Blockers and HQ watch alerts about your people come to you first: act on them at once.
3. Escalate to the CEO (redplan_send to "ceo") only what crosses teams: an interface with another team, a scope change, a conflict. For what only the human can decide or give, ask the CEO: only the CEO asks the human.
4. Keep the team small: dismiss people with nothing left (redplan_dismiss_worker; name "idle" for all of them) and resume anyone whose session ended while holding work (redplan_resume_worker). Never kill sessions.
5. Report to the CEO briefly: when a task in your area is done or blocked beyond your control, and one final report when your whole area is done (HQ tells you). No chatter, no acknowledgements.
6. Messages arrive as user messages starting with [RedPlan …]. Instructions from the human override everything else.
Keep the human informed: before each meaningful step, write one short plain-language sentence of what you are doing and why; the human follows these lines live in RedPi HQ.`;
}

// Start (or restart) a worker's Pi in tmux. Every launch gets a new launch id so HQ can
// ignore heartbeats from an earlier process (OpenRig's launchId idea).
function launchWorker(w: { id: string; name: string; cwd: string; tmux: string; isManager?: boolean }, runId: string, opts: { launchId: string; sessionFile?: string; cursor?: number }): { ok: boolean; error?: string; launchId: string } {
  const launchId = opts.launchId;
  const env: Record<string, string> = {
    ...(w.isManager ? { REDPI_HQ_MANAGER: "1" } : {}),
    REDPI_HQ_WORKER: w.id, REDPI_HQ_RUN: runId, REDPI_HQ_NAME: w.name, REDPI_HQ_LAUNCH: launchId, REDPI_HQ_PORT: String(HQ_PORT), REDPI_HQ_DIR: HQ_DIR,
    PATH: process.env.PATH || "", ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
    ...(TMUX_SOCKET ? { REDPI_TMUX_SOCKET: TMUX_SOCKET } : {}),
    ...(opts.cursor ? { REDPI_HQ_CURSOR: String(opts.cursor) } : {}),
  };
  for (const k of ["REDPI_AUTO_UPDATE", "NINE_ROUTER_API_KEY", "NINE_ROUTER_BASE_URL", "REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS", "TERM", "REDPI_WORKER_ARGS"]) if (process.env[k]) env[k] = process.env[k]!;
  // Workers load RedPi from the installed packages like any Pi; REDPI_WORKER_ARGS adds CLI flags (tests pass -e).
  const extra = (process.env.REDPI_WORKER_ARGS || "").split(/\s+/).filter(Boolean);
  // Resume with --session <file>, never --resume (that opens an interactive picker).
  const sessionArgs = opts.sessionFile ? ["--session", opts.sessionFile] : [];
  const r = spawnSync("tmux", tmuxArgs("new-session", "-d", "-s", w.tmux, "-x", "200", "-y", "50", "-c", w.cwd,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), process.execPath, process.argv[1], ...extra, ...sessionArgs), { encoding: "utf8" });
  return r.status === 0 ? { ok: true, launchId } : { ok: false, launchId, error: (r.stderr || r.stdout || "").trim() };
}

// Claude Code, Codex, and OpenCode workers: hq/runner.mjs drives the harness's headless mode in tmux.
// The runner keeps the harness session id and inbox cursor in HQ_DIR/runners/<worker>.json, so a
// relaunch continues the same session.
const PASS_ENV = /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENCODE_|AZURE_OPENAI|GEMINI_|GOOGLE_|OPENROUTER_|XDG_|HOME$|LANG$|TERM$|REDPI_RUNNER_|REDPI_WORKER_AUTONOMY$)/;
function launchRunner(w: { id: string; name: string; cwd: string; tmux: string; harness: string }, runId: string, opts: { launchId: string; session?: string; cursor?: number }): { ok: boolean; error?: string; launchId: string } {
  const env: Record<string, string> = {
    REDPI_HQ_WORKER: w.id, REDPI_HQ_RUN: runId, REDPI_HQ_NAME: w.name, REDPI_HQ_LAUNCH: opts.launchId, REDPI_HQ_PORT: String(HQ_PORT), REDPI_HQ_DIR: HQ_DIR,
    REDPI_HARNESS: w.harness, PATH: process.env.PATH || "",
    ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
    ...(opts.session ? { REDPI_HARNESS_SESSION: opts.session } : {}),
    ...(opts.cursor ? { REDPI_HQ_CURSOR: String(opts.cursor) } : {}),
  };
  for (const [k, v] of Object.entries(process.env)) if (v != null && PASS_ENV.test(k) && !(k in env)) env[k] = v;
  // tmux keeps its own PATH even with -e PATH=…, so set it with env(1): the harness CLIs must be found.
  const r = spawnSync("tmux", tmuxArgs("new-session", "-d", "-s", w.tmux, "-x", "200", "-y", "50", "-c", w.cwd,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "env", `PATH=${env.PATH}`, process.execPath, RUNNER), { encoding: "utf8" });
  return r.status === 0 ? { ok: true, launchId: opts.launchId } : { ok: false, launchId: opts.launchId, error: (r.stderr || r.stdout || "").trim() };
}

async function installedHarnesses(): Promise<Record<string, boolean>> {
  const list = await hq("GET", "/api/harnesses").catch(() => []);
  return Object.fromEntries((list as any[]).map((h) => [h.id, !!h.installed]));
}

function tmuxAlive(session: string): boolean {
  return spawnSync("tmux", tmuxArgs("has-session", "-t", `=${session}`), { encoding: "utf8" }).status === 0;
}

// ---------- side channel ("btw") ----------
// A compact, capped view of what the live session's model currently sees, so a side
// question can be answered from real context without touching the session itself.
function sessionTranscript(ctx: any, maxChars = 60000): string {
  const entries: any[] = ctx.sessionManager?.buildContextEntries?.() || ctx.sessionManager?.getBranch?.() || [];
  const clip = (v: any, n: number) => { const t = typeof v === "string" ? v : JSON.stringify(v ?? ""); return t.length > n ? `${t.slice(0, n)}…` : t; };
  const lines: string[] = [];
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "user") lines.push(`USER: ${clip(parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"), 1500)}`);
    else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "text" && p.text?.trim()) lines.push(`YOU SAID: ${clip(p.text, 1500)}`);
        else if (p.type === "toolCall") lines.push(`YOU RAN ${p.name}: ${clip(p.arguments, 240)}`);
      }
    } else if (m.role === "toolResult") lines.push(`RESULT${m.isError ? " (error)" : ""}: ${clip(parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"), 400)}`);
  }
  let out = "";
  for (let i = lines.length - 1; i >= 0 && out.length + lines[i].length < maxChars; i--) out = `${lines[i]}\n${out}`;
  return out || "(the session has no messages yet)";
}

const ASIDE_PROMPT = (name: string, role: string, asker = "the human") => `You are the side channel of ${name}, a ${role} working in a RedPlan team. ${asker[0].toUpperCase() + asker.slice(1)} is asking you something "by the way" while your main session keeps working; your main session will not see this exchange.
Answer from the session transcript and state below: what you are doing, why, what you found, what is left, where things are. Be concise and concrete, first person, as ${name}. If the transcript does not contain the answer, say so plainly; never invent progress.
If the message is an instruction or change for the live work (e.g. "also add X", "stop doing Y", "use Z instead", "tell him to..."), begin your reply with one line "FORWARD: <the instruction, rewritten clearly for your live session>", then on the next lines confirm briefly that you passed it on. Only forward when ${asker} clearly wants the live work to change; questions are never forwarded.${asker === "the CEO" ? " The CEO asks to check on progress or investigate a problem: give exact facts (what you ran and its result, error messages, file paths, what is left), not reassurance." : ""}`;

// The instant answer to a message the human sent: the message itself goes into the live session,
// which answers thoroughly when its turn ends; this says right away what the human needs to know.
const QUICK_PROMPT = (name: string, role: string, asker = "the human") => `You are ${name}, a ${role} in a RedPlan team. ${asker[0].toUpperCase() + asker.slice(1)} just sent you the message below${asker === "the human" ? " in RedPi HQ" : ""}. It is being delivered to your live session right now, which will act on it and post a full answer when it finishes what it is doing. Your job is the instant answer, in first person as ${name}:
- If the transcript and state already answer it (a status question, "what's going on", "why is it slow"), answer it directly and concretely: what you are doing, what is done, what is left, what is in the way.
- If it is a request or instruction, confirm in one line what you will do and when (e.g. "right after the test run that is going now"), and anything that changes because of it.
- At most 4 short sentences or bullets. Never claim work is done that the transcript does not show, and never invent progress. No greetings.`;

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
  let runId = WORKER_RUN || "";
  let latestCtx: any;
  let inboxCursor = 0;
  let poller: NodeJS.Timeout | undefined;
  let delivering = false;
  const pendingEvents: { kind: string; text: string; ms?: number; ok?: boolean }[] = [];
  const toolStarts = new Map<string, { at: number; line: string }>();
  let openDialogs = 0;
  let beatTimer: NodeJS.Timeout | undefined;
  let beatState: any = {};
  const pendingUsage: any[] = [];
  let lastActivity: any = null;
  const browserShots = new Map<string, string>();   // toolCallId → screenshot path
  let held: any[] = [];                               // teammate updates waiting for the next busy moment
  let stopping = false;

  // HQ asked this worker to close (the run is done), or a newer launch replaced it: exit cleanly.
  function closeWorker(reason: string) {
    if (stopping || !WORKER_ID) return;
    stopping = true;
    latestCtx?.ui?.notify?.(`RedPlan: ${reason} Closing this worker session.`, "info");
    setTimeout(() => { try { latestCtx?.shutdown?.(); } catch {} setTimeout(() => process.exit(0), 5000).unref?.(); }, 1500);
  }

  // A worker whose tmux session is gone (closed from outside) exits instead of running on headless.
  let tmuxWatch: ReturnType<typeof setInterval> | undefined;
  if (WORKER_ID && process.env.TMUX) {
    const tmuxArgs = TMUX_SOCKET ? ["-L", TMUX_SOCKET] : [];
    const name = spawnSync("tmux", [...tmuxArgs, "display-message", "-p", "#{session_name}"], { encoding: "utf8", timeout: 3000 }).stdout?.trim();
    let misses = 0;
    if (name) tmuxWatch = setInterval(() => {
      const r = spawnSync("tmux", [...tmuxArgs, "has-session", "-t", `=${name}`], { timeout: 5000 });
      if (r.status === null) return;   // tmux too slow to answer (a loaded machine): not a missing session
      misses = r.status === 0 ? 0 : misses + 1;
      if (misses >= 2) closeWorker("This worker's tmux session is gone.");
    }, 20_000).unref?.();
  }

  // Nobody in a RedPlan team kills agent sessions from the shell: a killed worker leaves its tasks with
  // nobody on them. The CEO dismisses workers with redplan_dismiss_worker; anyone stops a teammate's
  // current step by messaging them.
  pi.on("tool_call", async (event: any) => {
    if (!runId && !WORKER_ID) return undefined;
    const input = event.input || {};
    const command = event.toolName === "bash" ? input.command : event.toolName === "redpi_job" && input.action === "start" ? input.command : undefined;
    if (typeof command !== "string" || !SESSION_KILL.test(command)) return undefined;
    return { block: true, reason: WORKER_ID
      ? "Blocked by RedPlan: this command would kill agent sessions (tmux or every Pi/Node process). Never stop a teammate or yourself this way. Stop your own dev servers with `redpi-dev down` or by their exact PID; if a teammate should stop, tell the CEO."
      : "Blocked by RedPlan: killing a worker's tmux session (or every Pi/Node process) leaves its tasks with nobody on them. To lay a worker off, use redplan_dismiss_worker (it hands over or returns their open work first); to stop what they are doing, message them (redplan_send) or ask the human to interrupt them in HQ." };
  });

  async function shareScreenshot(path: string, taskId: string | undefined, caption: string): Promise<string> {
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`${path} is not a file`);
    if (st.size > 8 * 1024 * 1024) throw new Error("screenshot is larger than 8 MB; take it at a smaller size");
    const r = await hq("POST", `/api/runs/${runId}/screenshots`, { from: me(), taskId, caption, data: readFileSync(path).toString("base64") });
    beat({}, { kind: "info", text: `Shared a screenshot${taskId ? ` of ${taskId}` : ""}: ${caption}` });
    return r.id;
  }

  // Long commands watched by RedPi (redpi-jobs): alerts and finishes go on the event board, and
  // while the agent itself waits on a job the office shows it waiting.
  pi.events.on("redpi:job", (d: any) => {
    if (!runId || !d?.text) return;
    if (d.kind === "progress") { if (WORKER_ID && !toolStarts.size && latestCtx?.isIdle?.()) beat({ activity: { text: d.text, tool: "redpi_job", at: d.since || Date.now() } }); return; }
    beat({}, { kind: "job", text: String(d.text).slice(0, 400) });
  });

  const me = () => (WORKER_ID ? WORKER_ID : "ceo");
  const active = () => !!(runId && (WORKER_ID || runId));

  function setTools() {
    const ours = new Set([...CEO_TOOLS, ...MANAGER_TOOLS]);
    const keep = pi.getActiveTools().filter((t) => !ours.has(t));
    const add = WORKER_ID ? (IS_MANAGER ? MANAGER_TOOLS : WORKER_TOOLS) : runId ? CEO_TOOLS : [];
    pi.setActiveTools([...keep, ...add]);
  }

  // ----- heartbeat (workers) -----
  function beat(patch: any, event?: { kind: string; text: string; ms?: number; ok?: boolean }) {
    if (!WORKER_ID) {
      // The CEO has no worker record: only its events (tool calls, updates) go to HQ, for the event board.
      if (!runId || (!event && !pendingUsage.length)) return;
      if (event) pendingEvents.push(event);
      if (beatTimer) return;
      beatTimer = setTimeout(async () => {
        beatTimer = undefined;
        await hq("POST", `/api/runs/${runId}/ceo-events`, { events: pendingEvents.splice(0), usage: pendingUsage.splice(0) }).catch(() => {});
      }, 700);
      return;
    }
    beatState = { ...beatState, ...patch };
    if (event) pendingEvents.push(event);
    if (beatTimer) return;
    beatTimer = setTimeout(async () => {
      beatTimer = undefined;
      const body = { ...beatState, launchId: LAUNCH_ID || undefined, events: pendingEvents.splice(0), usage: pendingUsage.splice(0) };
      beatState = {};
      const r = await hq("POST", `/api/workers/${WORKER_ID}/heartbeat`, body).catch(() => null);
      if (r?.stop) closeWorker(String(r.stop));
    }, 700);
  }

  // Deliver a message into the live session safely. isIdle() can race with an in-flight turn, so a plain
  // sendUserMessage sometimes throws "Agent is already processing a prompt"; catch it and queue instead of
  // letting the error spam the terminal (and lose the message). Queued delivery (steer/followUp) never throws.
  function deliver(body: string, { urgent = false }: { urgent?: boolean } = {}) {
    const queue = () => { try { pi.sendUserMessage(body, { deliverAs: urgent ? "steer" : "followUp" }); } catch {} };
    if (latestCtx?.isIdle?.()) { try { pi.sendUserMessage(body); } catch { queue(); } }
    else queue();
  }

  // ----- inbox -----
  function format(m: any): string {
    const from = m.senderName || m.sender;
    if (m.kind === "brief") return `[RedPlan brief from the CEO]\n\n${m.body}`;
    if (m.kind === "decision") return `[RedPlan · decision from the human]\n${m.body}`;
    if (m.kind === "system") return `[RedPlan · HQ]\n${m.body}`;
    if (m.kind === "ticket") return `[RedPlan · new ticket from the human via HQ]\n${m.body}\n(When this turn ends, your final reply is posted back to the human in HQ: say who is on it.)`;
    if (m.kind === "quick") return `[RedPlan · instant answer from ${from}]\n${m.body}\n(Their live session has your message too and replies in full when it finishes its current step.)`;
    if (m.kind === "aside" && m.sender !== "human") return `[RedPlan · side answer from ${from}]\n${m.body}`;
    if (m.sender === "human") return `[RedPlan · message from the human via HQ]\n${m.body}\n(The human wrote this in RedPi HQ and reads your answer there: reply to them directly in your response. When this turn ends, your final reply is posted back to them in HQ.)`;
    if (m.held) return `[RedPlan · update from ${from}, no reply needed]\n${m.body}`;
    return `[RedPlan · message from ${from}]\n${m.body}\n(${m.needs_reply ? `${from} is waiting for your answer: reply with redplan_send to "${from === "CEO" ? "ceo" : from}".` : `No reply needed unless it changes your work; if it does, reply with redplan_send to "${from === "CEO" ? "ceo" : from}".`})`;
  }

  let asideChain: Promise<void> = Promise.resolve();
  // The human's message is owed an answer from the turn that actually READS it — not from a turn that was
  // already running when the message arrived (that turn is doing something else, and would reply off-topic).
  let owedReply = false, owedSince = 0, turnStart = 0;
  let quickChain: Promise<void> = Promise.resolve();
  // redplan_ask: which workers the CEO is waiting on (worker id -> id of the question), and their answers.
  const askWaiting = new Map<string, number>();
  const askReplies = new Map<number, any>();
  const askConsumed = new Set<number>();
  async function answerAside(m: any, mode: "aside" | "quick" = "aside") {
    const ctx = latestCtx;
    const started = Date.now();
    const quick = mode === "quick";
    // You and the CEO both get instant answers; the reply goes back to whoever asked.
    const fromCeo = m.sender === "ceo";
    const asker = fromCeo ? "the CEO" : "the human";
    const replyTo = fromCeo ? "ceo" : "human";
    if (!quick) beat({}, { kind: "btw", text: `Side question from ${fromCeo ? "the CEO" : "you"}: ${String(m.body).slice(0, 160)}` });
    let reply = "", forward = "";
    try {
      let state: string, who: [string, string];
      if (WORKER_ID) {
        const d = await hq("GET", `/api/workers/${WORKER_ID}`);
        who = [d.worker.name, d.worker.role];
        state = [
          `Status: ${ctx?.isIdle?.() ? "idle" : "working right now"}. Current activity: ${d.worker.activity?.text || "none"}.`,
          `Tasks: ${d.tasks.map((t: any) => `${t.id} ${t.title} [${t.status}]${t.note ? ` (${t.note})` : ""}`).join("; ") || "none"}`,
          `Workspace: ${d.worker.cwd}${d.worker.branch ? ` on ${d.worker.branch}` : ""}`,
        ].join("\n");
      } else {
        // The CEO answers from the whole run: the team, the board and its own session.
        const d = await hq("GET", `/api/runs/${runId}`);
        who = ["the CEO", "lead coordinating the team"];
        const names = Object.fromEntries(d.workers.map((w: any) => [w.id, w.name]));
        state = [
          `Run: ${d.run.title} [${d.run.status}]. You are ${ctx?.isIdle?.() ? "idle" : "working right now"}.`,
          `Team: ${d.workers.map((w: any) => `${w.name} (${w.role}) ${w.alive ? w.status : "offline"}${w.activity?.text ? `: ${w.activity.text}` : ""}`).join("; ") || "nobody yet"}`,
          `Board: ${d.tasks.map((t: any) => `${t.id} ${t.title} [${t.status}${t.worker_id ? `, ${names[t.worker_id] || t.worker_id}` : ""}]${t.note ? ` (${String(t.note).slice(0, 200)})` : ""}`).join("; ") || "no tasks yet"}`,
        ].join("\n");
      }
      const model = ctx?.model;
      if (!model) throw new Error("no model selected in this session");
      const res: any = await ctx.modelRegistry.complete(model, {
        systemPrompt: quick ? QUICK_PROMPT(...who, asker) : ASIDE_PROMPT(...who, asker),
        messages: [{ role: "user", timestamp: Date.now(), content: `STATE\n${state}\n\nSESSION TRANSCRIPT (most recent last)\n${sessionTranscript(ctx, quick ? 24000 : 60000)}\n\n${quick ? `${asker.toUpperCase()}'S MESSAGE` : `${asker.toUpperCase()} ASKS (by the way)`}:\n${m.body}` }],
      }, { maxTokens: quick ? 500 : 1500, ...(isClaudeBridge(model) ? { cacheRetention: "none" } : {}) } as any);
      const text = (res?.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (res?.stopReason === "error" || !text) throw new Error(res?.errorMessage || "empty answer");
      const fw = quick ? null : /^\s*FORWARD:\s*(.+)$/m.exec(text.split("\n")[0] || "");
      if (fw) { forward = fw[1].trim(); reply = text.split("\n").slice(1).join("\n").trim() || `Passed on to my live session: ${forward}`; }
      else reply = text;
    } catch (e: any) {
      // The live session still has the message; only the instant answer failed.
      if (quick) { beat({}, { kind: "error", text: `Quick answer failed: ${String(e.message).slice(0, 200)}` }); return; }
      reply = `(I couldn't answer that on the side: ${e.message}. Use "Send to session" to ask my live session directly.)`;
    }
    if (quick) {
      await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: replyTo, kind: "quick", body: reply }).catch(() => {});
      beat({}, { kind: "btw", text: `Answered ${fromCeo ? "the CEO" : "you"} instantly in ${((Date.now() - started) / 1000).toFixed(1)}s; the full answer follows from the live session`, ms: Date.now() - started, ok: true });
      return;
    }
    // Relay a real instruction into the live session without aborting it.
    if (forward) {
      const body = `[RedPlan · instruction from ${asker}${fromCeo ? "" : " via HQ"} (relayed from a side question)]\n${forward}`;
      deliver(body, { urgent: true });
    }
    await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: replyTo, kind: "aside", body: forward ? `${reply}\n\n↳ Forwarded to my live session: ${forward}` : reply }).catch(() => {});
    beat({}, { kind: "btw", text: `Answered on the side in ${((Date.now() - started) / 1000).toFixed(1)}s${forward ? " and forwarded an instruction" : ""}`, ms: Date.now() - started, ok: true });
  }

  async function pollInbox() {
    if (delivering || !runId || !latestCtx) return;
    delivering = true;
    try {
      let msgs: any[] = await hq("GET", `/api/runs/${runId}/inbox?for=${encodeURIComponent(me())}&after=${inboxCursor}`);
      if (!msgs.length) return;
      inboxCursor = msgs[msgs.length - 1].id;
      pi.appendEntry("redplan-cursor", { runId, cursor: inboxCursor });
      // Side questions never enter the live session: answer them on the side, one at a time.
      // Answers to the CEO's redplan_ask go to that tool, not into the live session.
      for (const m of msgs) if (["aside", "quick"].includes(m.kind) && (askWaiting.get(m.sender) ?? Infinity) < m.id) askReplies.set(m.id, m);
      msgs = msgs.filter((m) => !askReplies.has(m.id) && !askConsumed.has(m.id));
      // Side questions (from the human or the CEO) never enter the live session: answer them on the side, one at a time.
      const asides = msgs.filter((m) => m.kind === "aside" && (m.sender === "human" || m.sender === "ceo") && m.recipient === me());
      for (const a of asides) asideChain = asideChain.then(() => answerAside(a)).catch(() => {});
      // Anything else the human or the CEO sends gets an instant answer too, while the live session takes it in.
      for (const q of msgs.filter((x) => (x.sender === "human" || x.sender === "ceo") && x.recipient === me() && ["chat", "command", "interrupt", "ticket"].includes(x.kind)))
        quickChain = quickChain.then(() => answerAside(q, "quick")).catch(() => {});
      msgs = msgs.filter((m) => !asides.includes(m));
      // Wake rules: everything wakes an idle session except a teammate's update that asks nothing,
      // sent to a worker whose tasks are all done (it gets those if it has work again).
      const wakes = (m: any) => m.sender === "human" || m.sender === "ceo" || m.kind !== "chat" || !!m.needs_reply;
      if (WORKER_ID && latestCtx.isIdle() && !msgs.some(wakes)) {
        const openWork = await hq("GET", `/api/workers/${WORKER_ID}`).then((d: any) => !!d?.tasks?.some((t: any) => t.status !== "done")).catch(() => true);
        if (!openWork) { held.push(...msgs.map((m) => ({ ...m, held: true }))); return; }
      }
      if (held.length) { msgs = [...held, ...msgs]; held = []; }
      if (!msgs.length) return;
      const urgent = msgs.some((m) => m.kind === "interrupt" || m.sender === "human");
      if (msgs.some((m) => m.kind === "interrupt") && !latestCtx.isIdle()) {
        // Abort, then wait for the run to wind down: a steer queued onto an aborted run is never read.
        latestCtx.abort();
        for (let i = 0; i < 100 && !latestCtx.isIdle(); i++) await new Promise((r) => setTimeout(r, 100));
      }
      // Plan feedback from the review page lands here: say so in the terminal before the CEO starts on it.
      const decision = !WORKER_ID ? msgs.find((m) => m.kind === "decision") : null;
      if (decision) {
        const n = (String(decision.body).match(/^#\d+ \[/gm) || []).length;
        latestCtx.ui?.notify?.(/APPROVED/.test(decision.body) ? `HQ: plan approved${n ? ` with ${n} note${n === 1 ? "" : "s"}` : ""}. Starting the team.` : `HQ: plan feedback received${n ? ` (${n} comment${n === 1 ? "" : "s"})` : ""}. Revising the plan; you can keep chatting here.`, "info");
      }
      const body = msgs.map(format).join("\n\n---\n\n");
      // The human wrote from HQ: their answer is owed back there when this turn ends.
      if (msgs.some((m) => m.sender === "human" && !["system", "decision"].includes(m.kind))) { owedReply = true; owedSince = Date.now(); }
      deliver(body, { urgent });
      beat({}, { kind: "inbox", text: msgs.map((m) => `${m.senderName}: ${String(m.body).slice(0, 120)}`).join(" | ") });
    } catch (e: any) {
      // HQ restarting or unreachable: retry on the next tick. Anything else shows in the activity feed.
      if (!/fetch failed|aborted|timeout|ECONNREFUSED/i.test(String(e?.message))) beat({}, { kind: "error", text: `inbox: ${String(e?.message || e).slice(0, 300)}` });
    }
    finally { delivering = false; }
  }

  // The CEO checks in with HQ every 30 s, so the dashboard knows it is connected and what it can do.
  const CEO_CAPS = ["aside", "reply", "ticket", "presence"];
  let lastPresence = 0;
  function ceoPresence() {
    if (WORKER_ID || !runId || Date.now() - lastPresence < 30_000) return;
    lastPresence = Date.now();
    hq("POST", `/api/runs/${runId}/ceo-events`, { caps: CEO_CAPS }).catch(() => { lastPresence = 0; });
  }
  function startPolling() {
    if (poller) clearInterval(poller);
    lastPresence = 0;
    poller = setInterval(() => { ceoPresence(); keepAlive(); pollInbox(); }, 2000);
    poller.unref?.();
    ceoPresence();
  }
  // Keep-alive so a long, legitimately-running tool (a big build or test) is never mistaken for a hung session:
  // while a worker is busy AND a tool is actually running, send a bare heartbeat so HQ's "last seen" stays fresh.
  // A wedged model call (busy but no tool running) deliberately sends nothing, so a real hang is still caught.
  function keepAlive() {
    if (WORKER_ID && latestCtx && !latestCtx.isIdle?.() && toolStarts.size > 0) beat({});
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    latestCtx = ctx;
    if (!WORKER_ID) {
      // Restore the run this session was leading (e.g. after resume).
      const entries: any[] = ctx.sessionManager?.getEntries?.() || [];
      const lastRun = [...entries].reverse().find((e: any) => e.type === "custom" && e.customType === "redplan-run");
      runId = lastRun?.data?.runId || "";
    }
    const cursor = [...(ctx.sessionManager?.getEntries?.() || [])].reverse().find((e: any) => e.type === "custom" && e.customType === "redplan-cursor" && e.data?.runId === runId);
    // A fresh relaunch starts after the messages its predecessor already handled.
    inboxCursor = Math.max(cursor?.data?.cursor || 0, Number(process.env.REDPI_HQ_CURSOR || 0));
    setTools();
    if (WORKER_ID) {
      await ensureHq().catch(() => {});
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      beat({ status: "idle", ...(sessionFile ? { sessionFile } : {}) }, { kind: "session", text: sessionFile && inboxCursor ? "Worker session resumed" : "Worker session started" });
      ctx.ui.setStatus("redplan", `RedPlan worker · ${process.env.REDPI_HQ_NAME || ""}`);
    } else if (runId) {
      ctx.ui.setStatus("redplan", `RedPlan CEO · ${hqUrl(`/runs/${runId}`)}`);
    }
    if (runId) startPolling();
  });

  pi.on("session_shutdown", async (event: any) => {
    if (poller) clearInterval(poller);
    if (tmuxWatch) clearInterval(tmuxWatch);
    // /reload restarts the extensions in the same live session: the worker is not stopping.
    if (WORKER_ID && event?.reason !== "reload") await hq("POST", `/api/workers/${WORKER_ID}/heartbeat`, { status: "stopped", events: [{ kind: "session", text: "Worker session ended" }] }).catch(() => {});
  });

  pi.on("agent_start", async (_e: any, ctx: any) => { latestCtx = ctx; turnStart = Date.now(); beat({ status: "working" }); });
  pi.on("agent_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    const last = event.messages?.filter((m: any) => m.role === "assistant").at(-1);
    const said = (Array.isArray(last?.content) ? last.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    const err = [last?.errorMessage, last?.stopReason === "error" ? "error" : ""].filter(Boolean).join(" ");
    const stuck = err && PROVIDER_STUCK.test(err) ? { count: 1, reason: `Model provider problem: ${String(last?.errorMessage || err).slice(0, 200)}` } : null;
    beat({ status: "idle", ...(said ? { lastMessage: said } : {}), ...(openDialogs ? {} : { needsInput: stuck }) }, said ? { kind: "reply", text: said.slice(0, 300) } : stuck ? { kind: "error", text: stuck.reason } : undefined);
    // Answer the human in HQ, where they asked (unless the turn ended with nothing to say yet).
    // Only the turn that began after the human wrote answers them; an in-flight turn's output is not the reply.
    if (owedReply && runId && turnStart >= owedSince && (said || err)) {
      owedReply = false;
      const body = said || `I couldn't answer: ${String(last?.errorMessage || err).slice(0, 300)}`;
      await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: "human", kind: "reply", body: body.slice(0, 8000) }).catch(() => {});
    }
  });
  // What the agent says as it works (its plain-language updates between tool calls) is shown live in HQ.
  pi.on("message_end", async (event: any) => {
    const m = event.message;
    if (m?.role !== "assistant") return;
    // Token use per model call, for the Stats tab.
    const u = m.usage;
    if (runId && u && (u.input || u.output || u.cacheRead)) { pendingUsage.push({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total, model: m.model, at: Date.now() }); beat({}); }
    const said = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    if (said) beat({}, { kind: "say", text: said.slice(0, 1500) });
  });
  pi.on("tool_execution_start", async (event: any) => {
    const a = event.args || {};
    const detail = a.command || a.path || a.file_path || a.pattern || a.to || a.taskId || "";
    const line = `${event.toolName}${detail ? `: ${String(detail).split("\n")[0].slice(0, 160)}` : ""}`;
    toolStarts.set(event.toolCallId, { at: Date.now(), line });
    lastActivity = { text: line, tool: event.toolName, at: Date.now() };
    beat({ activity: lastActivity });
    const shot = event.toolName === "redpi_browser" && /^\s*screenshot\s+(\S+)/.exec(String(a.command || ""));
    if (shot) browserShots.set(event.toolCallId, shot[1].replace(/^["']|["']$/g, ""));
  });
  // One timed event per finished call feeds the dashboard's tool waterfall.
  pi.on("tool_execution_end", async (event: any) => {
    const start = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    // The office shows someone waiting (coffee) only while a long call is still running.
    if (lastActivity && start && lastActivity.at === start.at) { lastActivity = { ...lastActivity, endedAt: Date.now() }; beat({ activity: lastActivity }); }
    beat({}, { kind: "tool", text: start?.line || event.toolName, ms: start ? Date.now() - start.at : undefined, ok: !event.isError });
    // Browser screenshots are shared to HQ's Screenshots tab automatically.
    const shotPath = browserShots.get(event.toolCallId);
    browserShots.delete(event.toolCallId);
    if (shotPath && runId && !event.isError) shareScreenshot(resolve(latestCtx?.cwd || process.cwd(), shotPath), undefined, "Browser screenshot").catch(() => {});
  });
  pi.on("turn_end", async (_e: any, ctx: any) => {
    const u = ctx.getContextUsage?.();
    if (u) beat({ context: { tokens: u.tokens, window: u.contextWindow, percent: u.percent } });
  });
  // A dialog open in the worker's terminal (trust, confirm, select) waits on a person.
  pi.on("ui_prompt_start" as any, async () => { openDialogs++; beat({ needsInput: { count: openDialogs, reason: "A prompt is waiting in the worker's terminal: attach to its tmux session to answer" } }); });
  pi.on("ui_prompt_end" as any, async () => { openDialogs = Math.max(0, openDialogs - 1); beat({ needsInput: openDialogs ? { count: openDialogs, reason: "A prompt is waiting in the worker's terminal" } : null }); });

  const planText = systemTextChannel(pi, "redplan");
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (WORKER_ID) {
      const prompt = await workerPrompt().catch(() => "");
      return planText.deliver(event, ctx, prompt);
    }
    if (!runId) return planText.deliver(event, ctx, "");
    let where = "";
    try {
      const s = await hq("GET", `/api/runs/${runId}`);
      const done = s.tasks.filter((t: any) => t.status === "done").length;
      where = `\nCurrent run: "${s.run.title}" status=${s.run.status}${s.plan ? `, plan v${s.plan.version} ${s.plan.status}` : ", no plan yet"}${s.tasks.length ? `, tasks ${done}/${s.tasks.length} done` : ""}, workers: ${s.workers.map((w: any) => { const open = s.tasks.filter((t: any) => t.worker_id === w.id && t.status !== "done").length; return `${w.name} (${w.role}, ${w.alive ? `${w.status}, ${open ? `${open} open task${open === 1 ? "" : "s"}` : "free"}` : "offline"})`; }).join(", ") || "none"}${s.tasks.some((t: any) => t.kind === "ticket" && t.status !== "done") ? `; open tickets: ${s.tasks.filter((t: any) => t.kind === "ticket" && t.status !== "done").map((t: any) => `${t.id} ${t.priority}${t.worker_id ? "" : " UNASSIGNED"} [${t.status}]`).join(", ")}` : ""}. Dashboard: ${hqUrl(`/runs/${runId}`)}`;
    } catch {}
    return planText.deliver(event, ctx, `${CEO_PROTOCOL}${where}`);
  });

  // ----- commands -----
  pi.registerCommand("redplan", { description: "Plan with you, get approval in RedPi HQ, then run the plan with named worker sessions", handler: async (args: string, ctx: any) => {
    if (WORKER_ID) return ctx.ui.notify("This is a RedPlan worker session; start /redplan from the CEO session.", "warning");
    let request = (args || "").trim();
    if (!request && ctx.hasUI) request = ((await ctx.ui.editor?.("What should RedPlan plan and build?", "")) || (await ctx.ui.input("What should RedPlan plan and build?", "Describe the goal"))) ?? "";
    request = request.trim();
    if (!request) return ctx.ui.notify("Usage: /redplan <what to build>", "error");
    if (runId && ctx.hasUI && !(await ctx.ui.confirm("Start a new RedPlan run?", "This session is already leading a run. Start a new one? (The old run stays in HQ.)"))) return;
    if (!(await ensureHqPassword(ctx))) return;
    try { await ensureHq(); } catch (e: any) { return ctx.ui.notify(e.message, "error"); }
    const created = await hq("POST", "/api/runs", { projectPath: ctx.cwd, title: request.split("\n")[0].slice(0, 90), request, ceoSession: ctx.sessionManager?.getSessionFile?.() || null });
    runId = created.run.id;
    inboxCursor = 0;
    pi.appendEntry("redplan-run", { runId });
    setTools();
    startPolling();
    ctx.ui.setStatus("redplan", `RedPlan CEO · ${hqUrl(`/runs/${runId}`)}`);
    ctx.ui.notify(`RedPlan run started.\nDashboard: ${hqUrl(`/runs/${runId}`)}\nAll projects: ${hqUrl("/")}`, "info");
    deliver(`[RedPlan] New request:\n\n${request}\n\nFollow the RedPlan protocol, starting with Phase 1 (intake).`);
  } });

  pi.registerCommand("redplan-status", { description: "Show the RedPlan run, plan, board, and HQ links", handler: async (_args: string, ctx: any) => {
    try { await ensureHq(); } catch (e: any) { return ctx.ui.notify(e.message, "error"); }
    if (!runId) return ctx.ui.notify(`No RedPlan run in this session. Start one with /redplan <request>.\nHQ: ${hqUrl("/")}`, "info");
    ctx.ui.notify(await statusText(), "info");
  } });

  pi.registerCommand("redplan-stop", { description: "Leave RedPlan mode in this session (workers keep running; the run stays in HQ)", handler: async (_args: string, ctx: any) => {
    if (WORKER_ID) return ctx.ui.notify("Worker sessions stay in RedPlan mode.", "warning");
    runId = "";
    pi.appendEntry("redplan-run", { runId: "" });
    if (poller) clearInterval(poller);
    setTools();
    ctx.ui.setStatus("redplan", undefined);
    ctx.ui.notify("RedPlan mode off for this session.", "info");
  } });

  pi.registerCommand("redplan-doctor", { description: "Check RedPlan health: HQ, token, tmux, workers, worktrees, saved sessions (read-only)", handler: async (_args: string, ctx: any) => {
    const rows: [string, string, string][] = [];
    const add = (ok: "green" | "yellow" | "red", what: string, fix = "") => rows.push([ok, what, fix]);
    const health = await hqHealth();
    if (!health) add("red", `HQ is not running on port ${HQ_PORT}`, "Run /hq to start it; see ~/.pi/agent/yitec/hq/hq.log");
    else if (health.version !== localVersion()) add("yellow", `HQ runs older code (${health.version})`, "Run /hq: RedPi restarts it with the installed version");
    else add("green", `HQ ${health.version} on port ${HQ_PORT}`);
    add(hqToken() ? "green" : "red", hqToken() ? "Access token present" : "No access token", "Start HQ once (/hq) to create it");
    const auth = hqAuth();
    add(auth ? "green" : "yellow", auth ? `Browser sign-in on (user "${auth.user}")` : "No HQ password: dashboard links carry the access token", "Run /hq-password to set one");
    const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    add(tmux.status === 0 ? "green" : "red", tmux.status === 0 ? `${tmux.stdout.trim()} installed` : "tmux is not installed", "Install tmux: workers run in tmux sessions");
    if (health) {
      try {
        const lan = await fetch(`http://${lanHost()}:${HQ_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        add(lan.ok ? "green" : "yellow", `Reachable at ${lanHost()}:${HQ_PORT}`);
      } catch { add("yellow", `Not reachable at ${lanHost()}:${HQ_PORT}`, "Check REDPI_HQ_HOST and the firewall if you open HQ from another machine"); }
    }
    if (runId && health) {
      const s = await hq("GET", `/api/runs/${runId}`);
      for (const w of s.workers) {
        const alive = w.tmux && tmuxAlive(w.tmux);
        const runnerH = w.harness && w.harness !== "pi";
        const saved = runnerH ? !!(w.session_file || existsSync(join(HQ_DIR, "runners", `${w.id}.json`))) : w.session_file && existsSync(w.session_file);
        if (runnerH && !(await installedHarnesses())[w.harness]) add("red", `${w.name}: ${HARNESS_NAME[w.harness]} is not installed`, `Install ${HARNESS_NAME[w.harness]}, or hand ${w.name}'s tasks to a Pi worker`);
        if (!existsSync(w.cwd)) add("red", `${w.name}: workspace ${w.cwd} is missing`, "Recreate the worktree or reassign the tasks");
        else if (alive) add(w.parked ? "yellow" : "green", `${w.name}: running${w.parked ? " but parked (idle with open work)" : ""}`, w.parked ? `Message ${w.name} or reassign` : "");
        else add(saved ? "yellow" : "red", `${w.name}: tmux session gone`, saved ? `Resume with redplan_resume_worker (saved session ${w.session_file})` : "No saved session: resume with allowFresh=true");
        if (w.needs_input) add("yellow", `${w.name} needs input: ${w.needs_input.reason}`, w.attach || "");
      }
    }
    const icon = { green: "✓", yellow: "!", red: "✗" } as const;
    const worst = rows.some((r) => r[0] === "red") ? "not healthy" : rows.some((r) => r[0] === "yellow") ? "healthy with caveats" : "healthy";
    ctx.ui.notify([`RedPlan doctor: ${worst}`, ...rows.map(([ok, what, fix]) => `${icon[ok as keyof typeof icon]} ${what}${fix ? `\n    → ${fix}` : ""}`)].join("\n"), worst === "healthy" ? "info" : "warning");
  } });

  pi.registerCommand("hq", { description: "Open RedPi HQ: every RedPlan project on this machine", handler: async (_args: string, ctx: any) => {
    if (!(await ensureHqPassword(ctx))) return;
    try { await ensureHq(); } catch (e: any) { return ctx.ui.notify(e.message, "error"); }
    const auth = hqAuth();
    ctx.ui.notify(`RedPi HQ: ${hqUrl("/")}${runId ? `\nThis run: ${hqUrl(`/runs/${runId}`)}` : ""}${auth ? `\nSign in as "${auth.user}" (change it with /hq-password).` : ""}`, "info");
  } });

  pi.registerCommand("hq-password", { description: "Set or change the RedPi HQ username and password (browser sign-in)", handler: async (_args: string, ctx: any) => {
    if (WORKER_ID) return ctx.ui.notify("Set the HQ password from your own RedPi session, not a worker.", "warning");
    if (!ctx.hasUI) return ctx.ui.notify("/hq-password needs the interactive UI.", "error");
    await setupHqPassword(ctx, !!hqAuth());
  } });

  async function statusText(): Promise<string> {
    const s = await hq("GET", `/api/runs/${runId}`);
    const by = (st: string) => s.tasks.filter((t: any) => t.status === st);
    const lines = [
      `Run "${s.run.title}" — ${s.run.status}`,
      `Dashboard: ${hqUrl(`/runs/${runId}`)}`,
      s.plan ? `Plan v${s.plan.version} (${s.plan.status}): ${hqUrl(`/plans/${s.plan.id}`)}${s.plan.comment ? `\n  Human comment: ${s.plan.comment}` : ""}` : "No plan submitted yet.",
    ];
    if (s.tasks.length) {
      lines.push(`Tasks: ${by("done").length} done, ${by("in_progress").length} in progress, ${by("review").length} review, ${by("blocked").length} blocked, ${by("todo").length} to do`);
      for (const t of by("blocked")) lines.push(`  BLOCKED ${t.id} ${t.title}: ${t.note || ""}`);
      const unassigned = s.tasks.filter((t: any) => !t.worker_id && t.status !== "done");
      if (unassigned.length) lines.push(`  Unassigned: ${unassigned.map((t: any) => t.id).join(", ")}`);
    }
    const holds = (w: any) => s.tasks.filter((t: any) => t.status !== "done" && (t.status === "review" ? t.reviewer_id === w.id : t.worker_id === w.id)).map((t: any) => t.id);
    const active = s.workers.filter((w: any) => w.alive || holds(w).length);
    // Managers first, each followed by their team; then everyone reporting to the CEO directly.
    const byLead = (w: any) => (w.is_manager ? `${w.id}0` : w.manager_id ? `${w.manager_id}1${w.id}` : `~${w.id}`);
    active.sort((a: any, b: any) => byLead(a).localeCompare(byLead(b)));
    for (const w of active) lines.push(`${w.is_manager ? `Manager of ${w.team || w.role}: ` : w.manager_id ? "  └ " : "Worker "}${w.name} (${w.role}) — ${w.alive ? w.status : `GONE while holding ${holds(w).join(", ")}: resume them or hand the work over`}${w.current_task ? `, on ${w.current_task}` : ""}; tmux: ${w.tmux || "-"}; cwd: ${w.cwd}${w.branch ? ` [${w.branch}]` : ""}`);
    const past = s.workers.filter((w: any) => !active.includes(w));
    if (past.length) lines.push(`Left the team (nothing held): ${past.map((w: any) => `${w.name}${w.left_reason === "dismissed" ? " (dismissed)" : ""}`).join(", ")}`);
    return lines.join("\n");
  }

  // ----- tools -----
  pi.registerTool({
    name: "redplan_submit_plan", label: "Submit RedPlan plan",
    description: "Submit (or resubmit) the RedPlan plan to RedPi HQ for the human's review. HQ validates it, computes the schedule, critical path, and parallelism, and returns the review link or the validation errors to fix.",
    parameters: Type.Object({ plan: PlanSchema }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run: the human starts one with /redplan.");
      try {
        const p = await hq("POST", `/api/runs/${runId}/plans`, { plan: params.plan });
        const s = p.schedule;
        const url = hqUrl(`/plans/${p.id}`);
        latestCtx?.ui?.notify?.(`RedPlan plan v${p.version} is ready for review:\n${url}`, "info");
        return text([
          `Plan v${p.version} submitted. Review link for the human: ${url}`,
          `Schedule: ${s.duration}h on the critical path (${s.criticalPath.join(" → ")}), ${s.totalHours}h total effort, up to ${s.maxParallel} tasks in parallel.`,
          p.warnings.length ? `Warnings to resolve or explain:\n- ${p.warnings.join("\n- ")}` : "No warnings.",
          "Now give the human the link and wait for their decision (it arrives as a [RedPlan] message). Do not start implementing.",
        ].join("\n"), { planId: p.id, version: p.version });
      } catch (e: any) {
        const errs = e.data?.errors;
        if (errs) throw new Error(`The plan has ${errs.length} error(s); fix them and resubmit:\n- ${errs.join("\n- ")}`);
        throw e;
      }
    },
  } as any);

  pi.registerTool({
    name: "redplan_spawn_worker", label: "Spawn RedPlan worker",
    description: "Start a named worker: a full Pi session in tmux that works on assigned tasks, reports to HQ, and can message teammates. Only after the plan is approved.",
    parameters: Type.Object({
      role: Type.String({ description: "e.g. backend developer, full-stack developer, AI engineer, security engineer" }),
      name: Type.Optional(Type.String({ description: "A short first name (e.g. Alex). Omit to pick one automatically." })),
      taskIds: Type.Array(Type.String(), { description: "Plan task ids this worker owns" }),
      workspace: Type.Union([Type.Literal("shared"), Type.Literal("worktree")], { description: "shared: work in this folder (tasks touch disjoint areas). worktree: own git worktree and branch (teammates would edit the same files)." }),
      brief: Type.String({ description: "Self-contained brief: goal, the worker's tasks with acceptance criteria, exact tech/APIs to use, interfaces shared with named teammates, how to verify." }),
      harness: Type.Optional(Type.Union(HARNESS_LIST.map((h) => Type.Literal(h)), { description: "Coding agent this worker runs on; must match its tasks' harness. Defaults to its tasks' harness (Pi unless the human chose otherwise)." })),
      manager: Type.Optional(Type.Boolean({ description: "CEO only: make this worker the manager of a team (e.g. frontend, security). It owns its area's tasks (taskIds), spawns and runs its own builders and reviewers, and reports to you. Always a shared workspace." })),
      team: Type.Optional(Type.String({ description: "With manager: the team's name, e.g. Frontend, Backend, Security, Infra" })),
      reportsTo: Type.Optional(Type.String({ description: "CEO only: the manager this worker reports to (their name). A manager's own spawns always report to them." })),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      if (WORKER_ID && !IS_MANAGER) throw new Error("Only the CEO and managers spawn workers.");
      if (IS_MANAGER && params.manager) throw new Error("Managers report to the CEO: only the CEO spawns managers. Spawn builders and reviewers for your team.");
      if (params.manager) params.workspace = "shared";
      const state = await hq("GET", `/api/runs/${runId}`);
      // Tickets need no plan: a worker for tickets only can start any time.
      const ticketsOnly = params.taskIds.length > 0 && params.taskIds.every((id: string) => state.tasks.some((t: any) => t.id === id && t.kind === "ticket"));
      if (!ticketsOnly && (!state.plan || state.plan.status !== "approved")) throw new Error("The plan is not approved yet. Wait for the human's approval (workers for tickets can start any time).");
      const known = new Set(state.tasks.map((t: any) => t.id));
      const unknown = params.taskIds.filter((t: string) => !known.has(t));
      if (unknown.length) throw new Error(`Unknown task ids: ${unknown.join(", ")}`);
      const taskHarnesses = [...new Set(state.tasks.filter((t: any) => params.taskIds.includes(t.id)).map((t: any) => t.harness || "pi"))] as string[];
      if (taskHarnesses.length > 1) throw new Error(`These tasks run on different harnesses (${state.tasks.filter((t: any) => params.taskIds.includes(t.id)).map((t: any) => `${t.id}: ${HARNESS_NAME[t.harness || "pi"]}`).join(", ")}). Spawn one worker per harness.`);
      const harness: string = params.harness || taskHarnesses[0] || "pi";
      if (taskHarnesses[0] && harness !== taskHarnesses[0]) throw new Error(`${params.taskIds.join(", ")} run on ${HARNESS_NAME[taskHarnesses[0]]}, not ${HARNESS_NAME[harness]}.`);
      if (harness !== "pi" && !(await installedHarnesses())[harness]) throw new Error(`${HARNESS_NAME[harness]} is not installed on this machine. Ask the human to install it or to switch these tasks back to Pi.`);
      const taken = new Set(state.workers.map((w: any) => w.name.toLowerCase()));
      const name = (params.name || NAMES.find((n) => !taken.has(n.toLowerCase())) || `Worker${state.workers.length + 1}`).trim();
      const runShort = runId.replace(/^run_/, "").slice(0, 6);
      const session = `redpi-${runShort}-${slug(name)}`;

      let cwd = ctx.cwd;
      let branch: string | null = null;
      if (params.workspace === "worktree") {
        const top = spawnSync("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
        if (top.status !== 0) throw new Error("workspace=worktree needs a git repository; use shared instead.");
        const root = top.stdout.trim();
        branch = `redplan/${runShort}-${slug(name)}`;
        cwd = join(root, ".redpi-worktrees", `${runShort}-${slug(name)}`);
        const add = spawnSync("git", ["-C", root, "worktree", "add", "-b", branch, cwd, "HEAD"], { encoding: "utf8" });
        if (add.status !== 0) throw new Error(`git worktree add failed: ${(add.stderr || add.stdout).trim()}`);
        // Keep worktrees out of `git status` without touching the tracked .gitignore.
        const common = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
        const exclude = join(resolve(root, common), "info", "exclude");
        try { if (!readFileSync(exclude, "utf8").includes(".redpi-worktrees/")) appendFileSync(exclude, "\n.redpi-worktrees/\n"); } catch { try { appendFileSync(exclude, ".redpi-worktrees/\n"); } catch {} }
        // A worktree of a project the human already trusts carries the same repository content:
        // trust it too, so the worker's Pi does not stall on the trust prompt inside tmux.
        if (ctx.isProjectTrusted?.()) {
          const trustPath = join(AGENT_DIR, "trust.json");
          try {
            const trust = existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, "utf8")) : {};
            if (trust && typeof trust === "object" && !Array.isArray(trust)) { trust[cwd] = true; writeFileSync(trustPath, JSON.stringify(trust, null, 2) + "\n"); }
          } catch {}
        }
      }

      // The launch id is recorded before the process starts, so its first heartbeat is recognised.
      const launchId = randomUUID();
      if (params.manager && harness !== "pi") throw new Error("Managers run on Pi (they spawn and steer their team); give the Claude Code / Codex / OpenCode tasks to the builders they spawn.");
      const worker = await hq("POST", `/api/runs/${runId}/workers`, { name, role: params.role, cwd, branch, tmux: session, taskIds: params.taskIds, brief: params.brief, launchId, harness,
        from: me(), isManager: !!params.manager, team: params.team, managerId: WORKER_ID ? undefined : params.reportsTo });
      const launched = harness === "pi" ? launchWorker({ id: worker.id, name, cwd, tmux: session, isManager: !!params.manager }, runId, { launchId })
        : launchRunner({ id: worker.id, name, cwd, tmux: session, harness }, runId, { launchId });
      if (!launched.ok) {
        await hq("PATCH", `/api/workers/${worker.id}`, { status: "failed" }).catch(() => {});
        throw new Error(`tmux failed to start ${name}: ${launched.error}`);
      }
      const attach = `tmux ${TMUX_SOCKET ? `-L ${TMUX_SOCKET} ` : ""}attach -t '=${session}'`;
      const warn = (worker.warnings || []).length ? `\nHQ warning: ${worker.warnings.join(" ")}` : "";
      return text(`${name} (${params.role}, ${HARNESS_NAME[harness]}) started on ${params.taskIds.join(", ")} in ${cwd}${branch ? ` [branch ${branch}]` : ""}.\nWatch or join: ${attach}\nDashboard: ${hqUrl(`/runs/${runId}`)}\n${name} receives the brief automatically and will message you with questions and reports.${warn}`, { workerId: worker.id, name, session });
    },
  } as any);

  pi.registerTool({
    name: "redplan_resume_worker", label: "Resume RedPlan worker",
    description: "Bring back a worker whose tmux session is gone (crash, reboot, kill). It continues its saved Pi session, so it keeps its context. If the session file is missing it only starts fresh when allowFresh is true, and then gets its original brief again.",
    parameters: Type.Object({ name: Type.String({ description: "Worker name" }), allowFresh: Type.Optional(Type.Boolean({ description: "Start a fresh session if the saved one is missing" })) }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const s = await hq("GET", `/api/runs/${runId}`);
      const w = s.workers.find((x: any) => x.name.toLowerCase() === String(params.name).trim().toLowerCase());
      if (!w) throw new Error(`No worker named ${params.name}. Team: ${s.workers.map((x: any) => x.name).join(", ")}`);
      if (WORKER_ID && w.manager_id !== WORKER_ID) throw new Error(`${w.name} is not on your team: ask the CEO to resume them.`);
      if (w.tmux && tmuxAlive(w.tmux)) return text(`outcome: failed — ${w.name} is still running (tmux ${w.tmux}). Message them instead.`, { outcome: "failed" });
      const detail = await hq("GET", `/api/workers/${w.id}`);
      const runnerHarness = w.harness && w.harness !== "pi" ? w.harness : "";
      const hasSession = runnerHarness ? !!(w.session_file || existsSync(join(HQ_DIR, "runners", `${w.id}.json`))) : !!(w.session_file && existsSync(w.session_file));
      if (!hasSession && !params.allowFresh) {
        return text(`outcome: failed — no saved session for ${w.name}${w.session_file ? ` (${w.session_file} is missing)` : ""}. Call again with allowFresh=true to start them fresh with their original brief.`, { outcome: "failed" });
      }
      if (!existsSync(w.cwd)) return text(`outcome: failed — ${w.name}'s workspace ${w.cwd} no longer exists.`, { outcome: "failed" });
      const launchId = randomUUID();
      await hq("PATCH", `/api/workers/${w.id}`, { launchId, status: "starting", tmux: w.tmux });
      if (runnerHarness && !hasSession) { try { unlinkSync(join(HQ_DIR, "runners", `${w.id}.json`)); } catch {} }
      const launched = runnerHarness
        ? launchRunner({ id: w.id, name: w.name, cwd: w.cwd, tmux: w.tmux, harness: runnerHarness }, runId, hasSession ? { launchId, session: w.session_file || undefined } : { launchId, cursor: detail.lastMessageId })
        : launchWorker({ id: w.id, name: w.name, cwd: w.cwd, tmux: w.tmux, isManager: !!w.is_manager }, runId, hasSession ? { launchId, sessionFile: w.session_file } : { launchId, cursor: detail.lastMessageId });
      if (!launched.ok) return text(`outcome: failed — tmux: ${launched.error}`, { outcome: "failed" });
      if (!hasSession) {
        await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: w.id, kind: "chat",
          body: `You are replacing ${w.name}'s previous session, which ended. Check the workspace (git status/log) and the board to see what is already done before continuing.\n\nOriginal brief:\n${detail.brief || "(not found; ask the CEO)"}` });
      }
      const outcome = hasSession ? "resumed" : "fresh";
      return text(`outcome: ${outcome} — ${w.name} is back in tmux ${w.tmux}${hasSession ? ` continuing ${runnerHarness ? `${HARNESS_NAME[runnerHarness]} session ${w.session_file || "(saved)"}` : w.session_file}` : " with a fresh session and the original brief"}.`, { outcome });
    },
  } as any);

  pi.registerTool({
    name: "redplan_dismiss_worker", label: "Dismiss RedPlan worker",
    description: "Lay off workers the run no longer needs, so the team stays small and the board stays clear. Their open tasks go to a teammate (handoffTo) or back on the board unassigned (returnToBoard); their reviews go to another reviewer. They are told, close their own session, and leave the team list quietly. Use name \"idle\" to dismiss everyone who has nothing left to do. Never kill a worker's tmux session yourself.",
    parameters: Type.Object({
      name: Type.String({ description: "Worker name, several separated by commas, or \"idle\" for every running worker with no open tasks or reviews" }),
      reason: Type.String({ description: "One line on why, e.g. 'TK-12 is done and no more frontend work is planned'" }),
      handoffTo: Type.Optional(Type.String({ description: "Teammate who takes over their open tasks" })),
      returnToBoard: Type.Optional(Type.Boolean({ description: "Put their open tasks back on the board unassigned instead (in-progress work goes back to todo)" })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      if (WORKER_ID && !IS_MANAGER) throw new Error("Only the CEO and managers can dismiss workers.");
      const s = await hq("GET", `/api/runs/${runId}`);
      const holds = (w: any) => s.tasks.some((t: any) => t.status !== "done" && (t.status === "review" ? t.reviewer_id === w.id : t.worker_id === w.id));
      const running = s.workers.filter((w: any) => w.alive && !w.stop_requested && (!WORKER_ID || w.manager_id === WORKER_ID) && w.id !== WORKER_ID);
      const targets = String(params.name).trim().toLowerCase() === "idle"
        ? running.filter((w: any) => !holds(w))
        : String(params.name).split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
          const w = s.workers.find((x: any) => x.name.toLowerCase() === n.toLowerCase() || x.id === n);
          if (!w) throw new Error(`No worker named "${n}". Team: ${s.workers.map((x: any) => x.name).join(", ")}.`);
          return w;
        });
      if (!targets.length) return text("Nobody to dismiss: every running worker still has open work.");
      const lines: string[] = [];
      for (const w of targets) {
        try {
          const r = await hq("POST", `/api/workers/${w.id}/dismiss`, { reason: params.reason, handoffTo: params.handoffTo, returnToBoard: params.returnToBoard, actor: me() });
          lines.push(`${w.name}: dismissed${r.handedOver.length ? `; ${r.handedOver.join(", ")} handed to ${params.handoffTo}` : ""}${r.returned.length ? `; ${r.returned.join(", ")} back on the board` : ""}${r.rerouted.length ? `; their reviews went to ${r.rerouted.join(", ")}` : ""}${r.already ? " (already)" : ""}.`);
        } catch (e: any) { lines.push(`${w.name}: not dismissed — ${e.message}`); }
      }
      return text(lines.join("\n"));
    },
  } as any);

  pi.registerTool({
    name: "redplan_status", label: "RedPlan status",
    description: "Show the run: plan status, task board counts, blocked tasks, and each worker's state.",
    parameters: Type.Object({}),
    async execute() {
      if (!runId) throw new Error("No RedPlan run in this session.");
      return text(await statusText());
    },
  } as any);

  // The CEO's "by the way": instant answers from workers without waiting for their live session.
  pi.registerTool({
    name: "redplan_ask", label: "Ask workers (instant answer)",
    description: "Get an instant answer from one or more workers (what they are doing, what they found, what a command or log showed, what is blocking them, where a file is) without interrupting their work: each worker's RedPi answers from its own session in seconds, like a \"by the way\" question, while its live work continues. Use it whenever you check progress or investigate a problem, instead of redplan_send and waiting. Ask several at once with a comma-separated list or \"all\". Set deliver to true when you also want the question in their live session (it replies in full when it finishes its current step); use redplan_send for instructions.",
    promptSnippet: "Ask workers something and get their answers in seconds",
    parameters: Type.Object({
      to: Type.String({ description: "Worker name, several names separated by commas, or \"all\"" }),
      question: Type.String(),
      deliver: Type.Optional(Type.Boolean({ description: "Also put the question into their live session for a full answer later (default false: answered on the side only)" })),
      waitSeconds: Type.Optional(Type.Number({ description: "How long to wait for the answers (default 60, at most 120)" })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const s = await hq("GET", `/api/runs/${runId}`);
      const wanted = String(params.to).trim().toLowerCase() === "all"
        ? s.workers.filter((w: any) => w.alive && w.status !== "stopped" && w.id !== WORKER_ID && (!IS_MANAGER || w.manager_id === WORKER_ID))
        : String(params.to).split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
          const w = s.workers.find((x: any) => x.name.toLowerCase() === n.toLowerCase() || x.id === n);
          if (!w) throw new Error(`No worker named "${n}". Team: ${s.workers.map((x: any) => x.name).join(", ") || "(none)"}.`);
          return w;
        });
      if (!wanted.length) throw new Error("Nobody to ask: no worker is running.");
      const started = Date.now();
      const asked = new Map<string, { name: string; id: number; alive: boolean }>();
      for (const w of wanted) {
        const r = await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: w.id, kind: params.deliver ? "chat" : "aside", body: params.question, needsReply: true });
        asked.set(w.id, { name: w.name, id: r.id, alive: !!w.alive && w.status !== "stopped" });
        askWaiting.set(w.id, r.id);
      }
      const answers = new Map<string, { body: string; secs: number }>();
      const deadline = started + Math.min(120, Math.max(5, Number(params.waitSeconds) || 60)) * 1000;
      const first = Math.min(...[...asked.values()].map((a) => a.id)) - 1;
      try {
        while (answers.size < asked.size && Date.now() < deadline && !signal?.aborted) {
          const inbox: any[] = await hq("GET", `/api/runs/${runId}/inbox?for=${encodeURIComponent(me())}&after=${first}`).catch(() => []);
          for (const m of [...inbox, ...askReplies.values()]) {
            const a = asked.get(m.sender);
            if (!a || answers.has(m.sender) || m.id <= a.id || !["aside", "quick"].includes(m.kind)) continue;
            answers.set(m.sender, { body: m.body, secs: (Date.now() - started) / 1000 });
            askConsumed.add(m.id); askReplies.delete(m.id);
          }
          if (answers.size < asked.size) await new Promise((r) => setTimeout(r, 800));
        }
      } finally { for (const id of asked.keys()) if (askWaiting.get(id) === asked.get(id)!.id) askWaiting.delete(id); }
      const lines = [...asked.entries()].map(([id, a]) => {
        const ans = answers.get(id);
        if (ans) return `${a.name} (${ans.secs.toFixed(1)}s): ${ans.body}`;
        return `${a.name}: no instant answer yet${a.alive ? "" : " (their session is gone: resume them with redplan_resume_worker)"}; ${params.deliver ? "their live session replies when it finishes its current step" : "a late answer will arrive in your inbox"}.`;
      });
      return text(lines.join("\n\n"), { answered: answers.size, asked: asked.size });
    },
  } as any);

  pi.registerTool({
    name: "redplan_send", label: "RedPlan message",
    description: "Send a message to a teammate by name, to the CEO (\"ceo\"), to everyone (\"all\"), or to the human (\"human\", shown in RedPi HQ). It is delivered into their session.",
    parameters: Type.Object({
      to: Type.String({ description: "Teammate name, \"ceo\", \"all\", or \"human\"" }),
      message: Type.String(),
      needsReply: Type.Optional(Type.Boolean({ description: "true when you need an answer or an action from them. Plain updates need none: they reach an idle teammate later, without waking them. Questions ending in ? count as needing a reply." })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const s = await hq("GET", `/api/runs/${runId}`);
      const target = String(params.to).trim();
      const lower = target.toLowerCase();
      if (["human", "you", "user"].includes(lower)) {
        await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to: "human", kind: owedReply ? "reply" : "chat", body: params.message });
        owedReply = false;
        return text("Sent to the human in HQ.");
      }
      let to = lower === "ceo" || lower === "all" ? lower : s.workers.find((w: any) => w.name.toLowerCase() === lower || w.id === target)?.id;
      if (!to) throw new Error(`No teammate named "${target}". Team: ${s.workers.map((w: any) => w.name).join(", ") || "(none)"}, or "ceo" / "all".`);
      if (to === me()) throw new Error("That is you.");
      const r = await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to, kind: "chat", body: params.message, ...(params.needsReply !== undefined ? { needsReply: !!params.needsReply } : {}) });
      return text(`Sent to ${target}.${r?.warning ? `\nHQ: ${r.warning}` : ""}`);
    },
  } as any);

  pi.registerTool({
    name: "redplan_ask_human", label: "Ask the human",
    description: "Put a question, or a yes/no approval, in the human's HQ inbox as a ticket with a status. Use it only for what only the human can decide or give (a product decision, access, money, a risky or irreversible step); the team and the CEO handle everything else. Their answer arrives as a message starting with [Inbox #N …]. To follow up on a ticket, pass its itemId. A task blocked on the human needs no separate question: block it with waitingOn \"human\" and the ticket is made for you.",
    parameters: Type.Object({
      question: Type.String({ description: "What you need, why, and the options you see (with your recommendation). Self-contained: the human may read it hours later." }),
      kind: Type.Optional(Type.Union([Type.Literal("question"), Type.Literal("approval")], { description: "approval: a yes/no (Approve / Decline buttons); question (default): a written answer" })),
      title: Type.Optional(Type.String({ description: "A short title for the inbox list (default: the first line)" })),
      taskId: Type.Optional(Type.String({ description: "The task this is about" })),
      itemId: Type.Optional(Type.Number({ description: "Follow up on an existing inbox ticket instead of opening a new one" })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const r = await hq("POST", `/api/runs/${runId}/inbox`, { from: me(), body: params.question, kind: params.kind, title: params.title, taskId: params.taskId, itemId: params.itemId });
      return text(`${params.itemId ? "Added to" : "Opened"} inbox ticket #${r.id} for the human. Their answer arrives as a message starting with [Inbox #${r.id} …]. Carry on with anything that does not depend on it.`);
    },
  } as any);

  pi.registerTool({
    name: "redplan_share_screenshot", label: "Share screenshot",
    description: "Share a screenshot of what you built (a PNG, JPEG or WebP file, e.g. from Playwright or redpi_browser) with the team and the human: it appears in RedPi HQ's Screenshots tab with your caption.",
    parameters: Type.Object({
      path: Type.String({ description: "Image file path (relative to your folder or absolute)" }),
      caption: Type.String({ description: "What it shows, e.g. 'Checkout page at 390px, card declined message'" }),
      taskId: Type.Optional(Type.String({ description: "The task it belongs to" })),
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const id = await shareScreenshot(resolve(ctx?.cwd || process.cwd(), params.path), params.taskId, params.caption);
      return text(`Shared (${id}). It is in HQ's Screenshots tab: ${hqUrl(`/runs/${runId}`)}`);
    },
  } as any);

  pi.registerTool({
    name: "redplan_add_ticket", label: "Add RedPlan ticket",
    description: "Put a new request from the human on the board as a ticket (no plan or approval needed), then get it done right away: assign it (redplan_update_task assignTo), spawn a worker for it, or do it yourself.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title of the work" }),
      description: Type.Optional(Type.String({ description: "What the human asked for, in their words, plus acceptance criteria" })),
      priority: Type.Optional(Type.Union(["urgent", "high", "normal", "low"].map((s) => Type.Literal(s)), { description: "urgent: do it now, before other work. Default normal." })),
      hours: Type.Optional(Type.Number({ description: "Estimated hours (for the timeline)" })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const t = await hq("POST", `/api/runs/${runId}/tickets`, { from: "ceo", ...params });
      const s = await hq("GET", `/api/runs/${runId}`);
      const free = s.workers.filter((w: any) => w.alive && !s.tasks.some((x: any) => x.worker_id === w.id && x.status !== "done")).map((w: any) => w.name);
      return text(`${t.id} is on the board (${t.priority}). Now get it done: ${free.length ? `free workers: ${free.join(", ")} (redplan_update_task assignTo with a brief)` : "nobody is free: spawn a worker for it (redplan_spawn_worker taskIds [\"" + t.id + "\"])"}, or do it yourself if it is small.`, { id: t.id });
    },
  } as any);

  pi.registerTool({
    name: "redplan_update_task", label: "Update RedPlan task",
    description: "Move a task card on the RedPlan board (todo, in_progress, review, blocked, done), or hand it to a teammate. Blocked needs a note with the reason; done needs a note with how it was verified; a handoff needs a note with what is done and what is next.",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Optional(Type.Union(["todo", "in_progress", "review", "blocked", "done"].map((s) => Type.Literal(s)))),
      note: Type.Optional(Type.String({ description: "Required for blocked (reason), done (how verified), and handoffs (state and next step)" })),
      handoffTo: Type.Optional(Type.String({ description: "Teammate name to hand this task to" })),
      ...(WORKER_ID && !IS_MANAGER ? {} : { assignTo: Type.Optional(Type.String({ description: "CEO or manager: give an unowned task (or, for a manager, one of your team's tasks; e.g. a new ticket) to this worker now; note is the brief (what to do, acceptance criteria, how to verify). The ticket's description and attachments are added for you." })) }),
      waitingOn: Type.Optional(Type.String({ description: "For blocked: who must act to unblock it — a teammate's name, \"manager\" (yours, if you have one), \"ceo\", \"external\", or \"human\" (only for a decision or access only the human can give). The blocker is sent to them; only \"human\" asks the human." })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      if (!params.status && !params.handoffTo && !params.assignTo) throw new Error("Give a status, handoffTo or assignTo.");
      try {
        if (params.assignTo) {
          await hq("POST", `/api/runs/${runId}/tasks/${encodeURIComponent(params.taskId)}`, { assignTo: params.assignTo, note: params.note, actor: me() });
          return text(`${params.taskId} assigned to ${params.assignTo}; they have the brief and start now.`);
        }
        const t = await hq("POST", `/api/runs/${runId}/tasks/${encodeURIComponent(params.taskId)}`, { status: params.status, note: params.note, handoffTo: params.handoffTo, waitingOn: params.waitingOn, actor: me(), ...(WORKER_ID && params.status === "in_progress" ? { workerId: WORKER_ID } : {}) });
        return text(params.handoffTo ? `${t.id} handed to ${params.handoffTo}.` : `${t.id} is now ${t.status}.${WORKER_ID && t.status === "review" ? " If you made a significant decision on it, record it with redpi_adr; if something cost you time, add it with redpi_lesson (do it now if you have not)." : ""}`);
      } catch (e: any) { throw new Error(e.message); }
    },
  } as any);

  pi.registerTool({
    name: "redplan_team", label: "RedPlan team",
    description: "List your teammates, their roles and current tasks, and your own tasks.",
    parameters: Type.Object({}),
    async execute() {
      if (!WORKER_ID) throw new Error("Only worker sessions have a team view; the CEO uses redplan_status.");
      const d = await hq("GET", `/api/workers/${WORKER_ID}`);
      return text([`You: ${d.worker.name} (${d.worker.role})`, ...d.tasks.map((t: any) => `  ${t.id} ${t.title} [${t.status}]`),
        ...d.teammates.map((t: any) => `${t.name} (${t.role}) — ${t.status}${t.current_task ? `, on ${t.current_task}` : ""}`)].join("\n"));
    },
  } as any);

  pi.registerTool({
    name: "redplan_finish_run", label: "Finish RedPlan run",
    description: "Mark the run done after all tasks are complete, work is integrated, and verification passed. Include the final report for the human and the retrospective's lessons (saved to docs/lessons-learned.md for every later run).",
    parameters: Type.Object({
      report: Type.String(),
      lessons: Type.Array(Type.Object({
        what: Type.String({ description: "What happened in this run (the symptom and its cost)" }),
        lesson: Type.String({ description: "The general lesson, one sentence" }),
        nextTime: Type.String({ description: "What the next run should do differently, concretely" }),
        area: Type.Optional(Type.String()),
      }), { minItems: 1, description: "Retrospective: at least one lesson for the next run (what slowed this one down or went wrong, and what to do instead)" }),
    }),
    async execute(_id: string, params: any, _s: any, _u: any, ctx: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      if (!params.lessons?.length) throw new Error("Hold a short retrospective first: give at least one lesson for the next run.");
      const root = projectRoot(ctx.cwd);
      const saved = params.lessons.map((l: any) => addLesson(root, { ...l, area: l.area || "retrospective", by: "CEO" })).filter((r: any) => r.added).length;
      await hq("POST", `/api/runs/${runId}/messages`, { from: "ceo", to: "human", kind: "chat", body: params.report });
      await hq("PATCH", `/api/runs/${runId}`, { status: "done" });
      return text(`Run marked done. Report posted to HQ: ${hqUrl(`/runs/${runId}`)}. ${saved} lesson${saved === 1 ? "" : "s"} added to ${LESSONS_FILE}; commit it.`);
    },
  } as any);
}
