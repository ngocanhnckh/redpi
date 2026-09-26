// RedPlan: plan with the user, get the plan approved in RedPi HQ, then run it with named
// worker sub-sessions (full Pi sessions in tmux) that coordinate through HQ.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const HQ_PORT = Number(process.env.REDPI_HQ_PORT || 47291);
const TMUX_SOCKET = process.env.REDPI_TMUX_SOCKET || "";
// Set in worker sessions by redplan_spawn_worker; absent in the CEO session.
const WORKER_ID = process.env.REDPI_HQ_WORKER || "";
const WORKER_RUN = process.env.REDPI_HQ_RUN || "";
const PKG_ROOT = resolve(typeof __dirname === "string" ? __dirname : process.cwd(), "..");
const SERVER = join(PKG_ROOT, "hq", "server.mjs");

const CEO_TOOLS = ["redplan_submit_plan", "redplan_spawn_worker", "redplan_status", "redplan_send", "redplan_update_task", "redplan_finish_run"];
const WORKER_TOOLS = ["redplan_update_task", "redplan_send", "redplan_team", "redplan_status"];
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

// Links carry the token once; the page then keeps it in a cookie.
function hqUrl(path: string): string {
  return `http://${lanHost()}:${HQ_PORT}${path}?t=${encodeURIComponent(hqToken())}`;
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
  team: Type.Optional(Type.Array(Type.Object({ name: Type.String(), role: Type.String(), taskIds: Type.Array(Type.String()) }), { description: "Proposed workers: one per parallel lane" })),
  risks: Type.Optional(Type.Array(Type.String())),
  outOfScope: Type.Optional(Type.Array(Type.String())),
});

// ---------- prompts ----------
const CEO_PROTOCOL = `RedPlan mode is ON. You are the CEO session: you plan with the human, get the plan approved in RedPi HQ, then lead a team of named worker sessions.

Phase 1 — Intake. Judge whether the request is deterministic: a clear spec or prototype with the users, scope, constraints, key technologies, and success criteria decided. If it is, say so in one line and skip to Phase 2. If not, load the grill-me skill and follow it: ask the human one focused question at a time until those decisions are made. Never guess a decision the human should make.

Phase 2 — Verify technology. For every library, framework, model, or service the human named or you choose, confirm the exact package and API from a primary source before planning with it: official docs, the package registry (e.g. \`curl -s https://pypi.org/pypi/<pkg>/json\`, \`npm view <pkg> version description\`), or the repository README (redpi_browser or curl). Record the package, what you will use from it, the source URL, and the fact you confirmed. Take names literally: "Deep Agents from LangChain" is the \`deepagents\` package and its create_deep_agent API, not an agent that thinks deeply; never substitute a similar-sounding concept. If you cannot verify something, set verified=false and add it to risks.

Phase 3 — Plan. Break the work into user stories a human understands, each with acceptance criteria and tasks. Tasks are human-readable but technical enough to judge the decision ("A user-management service using FastAPI and SQLAlchemy that stores roles in Postgres"), not file-level instructions. Estimate hours. Model dependencies precisely: a task depends on another only if it truly needs its output, so independent work can run in parallel. Include the architecture (components and links) and a proposed team (one worker per parallel lane, named, with a role). Submit with redplan_submit_plan; fix any validation errors it reports and resubmit. Then give the human the plan link and stop: do not implement anything before approval. Approval or change requests arrive as [RedPlan] messages.

Phase 4 — Execute (only after "Plan … APPROVED"). Form the team: usually 2–6 workers, one per parallel lane of the critical-path analysis. For each worker choose workspace "shared" when its tasks touch areas no teammate edits, or "worktree" (its own git branch) when teammates would edit the same files. Spawn each with redplan_spawn_worker and a self-contained brief: the goal, its tasks with acceptance criteria, the verified tech decisions it must use (exact packages/APIs), the interfaces it shares with named teammates, and how to verify its work. Then coordinate: answer [RedPlan] messages from workers quickly, unblock them, re-balance tasks, and keep the board honest. When every task is done: merge worktree branches, run the full verification, review the result against the plan, then call redplan_finish_run and report to the human.`;

async function workerPrompt(): Promise<string> {
  const d = await hq("GET", `/api/workers/${WORKER_ID}`);
  const w = d.worker;
  const tasks = d.tasks.map((t: any) => `- ${t.id} ${t.title} [${t.status}]`).join("\n") || "- (none yet; ask the CEO)";
  const team = d.teammates.map((t: any) => `- ${t.name} (${t.role})${t.current_task ? `: working on ${t.current_task}` : ""}`).join("\n") || "- (just you)";
  return `RedPlan worker. You are ${w.name}, ${w.role}, in a team led by the CEO session (another Pi). Run: "${d.run.title}". Workspace: ${w.cwd}${w.branch ? ` on branch ${w.branch}` : " (shared with teammates)"}.
Your tasks:
${tasks}
Teammates:
${team}
How you work:
1. Move your cards with redplan_update_task: in_progress when you start a task, done when it is implemented and verified (tests/build pass), blocked with a reason when stuck.
2. Talk to teammates directly with redplan_send (to their name) when you need or change a shared interface; answer their questions promptly and concretely. Ask the CEO (to "ceo") for decisions outside your tasks or when blocked.
3. Messages arrive as user messages starting with [RedPlan …]. Instructions from the human override everything else.
4. Stay in scope: change only what your tasks need. In a shared workspace never edit files a teammate owns. In a worktree, commit to your branch with clear messages and do not merge.
5. Use the exact technologies and APIs in your brief; do not substitute look-alikes.
6. When all your tasks are done, send the CEO a short report (what changed, how you verified it, anything left) and stop.`;
}

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
  let runId = WORKER_RUN || "";
  let latestCtx: any;
  let inboxCursor = 0;
  let poller: NodeJS.Timeout | undefined;
  let delivering = false;
  const pendingEvents: { kind: string; text: string }[] = [];
  let beatTimer: NodeJS.Timeout | undefined;
  let beatState: any = {};

  const me = () => (WORKER_ID ? WORKER_ID : "ceo");
  const active = () => !!(runId && (WORKER_ID || runId));

  function setTools() {
    const ours = new Set([...CEO_TOOLS, ...WORKER_TOOLS]);
    const keep = pi.getActiveTools().filter((t) => !ours.has(t));
    const add = WORKER_ID ? WORKER_TOOLS : runId ? CEO_TOOLS : [];
    pi.setActiveTools([...keep, ...add]);
  }

  // ----- heartbeat (workers) -----
  function beat(patch: any, event?: { kind: string; text: string }) {
    if (!WORKER_ID) return;
    beatState = { ...beatState, ...patch };
    if (event) pendingEvents.push(event);
    if (beatTimer) return;
    beatTimer = setTimeout(async () => {
      beatTimer = undefined;
      const body = { ...beatState, events: pendingEvents.splice(0) };
      beatState = {};
      await hq("POST", `/api/workers/${WORKER_ID}/heartbeat`, body).catch(() => {});
    }, 700);
  }

  // ----- inbox -----
  function format(m: any): string {
    const from = m.senderName || m.sender;
    if (m.kind === "brief") return `[RedPlan brief from the CEO]\n\n${m.body}`;
    if (m.kind === "decision") return `[RedPlan · decision from the human]\n${m.body}`;
    if (m.kind === "system") return `[RedPlan · HQ]\n${m.body}`;
    if (m.sender === "human") return `[RedPlan · instruction from the human via HQ]\n${m.body}`;
    return `[RedPlan · message from ${from}]\n${m.body}\n(Reply with redplan_send to "${from === "CEO" ? "ceo" : from}" if needed.)`;
  }

  async function pollInbox() {
    if (delivering || !runId || !latestCtx) return;
    delivering = true;
    try {
      const msgs: any[] = await hq("GET", `/api/runs/${runId}/inbox?for=${encodeURIComponent(me())}&after=${inboxCursor}`);
      if (!msgs.length) return;
      inboxCursor = msgs[msgs.length - 1].id;
      pi.appendEntry("redplan-cursor", { runId, cursor: inboxCursor });
      const urgent = msgs.some((m) => m.kind === "interrupt" || m.sender === "human");
      if (msgs.some((m) => m.kind === "interrupt") && !latestCtx.isIdle()) {
        // Abort, then wait for the run to wind down: a steer queued onto an aborted run is never read.
        latestCtx.abort();
        for (let i = 0; i < 100 && !latestCtx.isIdle(); i++) await new Promise((r) => setTimeout(r, 100));
      }
      const body = msgs.map(format).join("\n\n---\n\n");
      if (latestCtx.isIdle()) pi.sendUserMessage(body);
      else pi.sendUserMessage(body, { deliverAs: urgent ? "steer" : "followUp" });
      beat({}, { kind: "inbox", text: msgs.map((m) => `${m.senderName}: ${String(m.body).slice(0, 120)}`).join(" | ") });
    } catch { /* HQ restarting or unreachable: retry on the next tick */ }
    finally { delivering = false; }
  }

  function startPolling() {
    if (poller) clearInterval(poller);
    poller = setInterval(pollInbox, 2000);
    poller.unref?.();
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
    inboxCursor = cursor?.data?.cursor || 0;
    setTools();
    if (WORKER_ID) {
      await ensureHq().catch(() => {});
      beat({ status: "idle" }, { kind: "session", text: "Worker session started" });
      ctx.ui.setStatus("redplan", `RedPlan worker · ${process.env.REDPI_HQ_NAME || ""}`);
    } else if (runId) {
      ctx.ui.setStatus("redplan", `RedPlan CEO · ${hqUrl(`/runs/${runId}`)}`);
    }
    if (runId) startPolling();
  });

  pi.on("session_shutdown", async () => {
    if (poller) clearInterval(poller);
    if (WORKER_ID) await hq("POST", `/api/workers/${WORKER_ID}/heartbeat`, { status: "stopped", events: [{ kind: "session", text: "Worker session ended" }] }).catch(() => {});
  });

  pi.on("agent_start", async (_e: any, ctx: any) => { latestCtx = ctx; beat({ status: "working" }); });
  pi.on("agent_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    const last = event.messages?.filter((m: any) => m.role === "assistant").at(-1);
    const said = (Array.isArray(last?.content) ? last.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
    beat({ status: "idle", ...(said ? { lastMessage: said } : {}) }, said ? { kind: "reply", text: said.slice(0, 300) } : undefined);
  });
  pi.on("tool_execution_start", async (event: any) => {
    const a = event.args || {};
    const detail = a.command || a.path || a.file_path || a.pattern || a.to || a.taskId || "";
    const line = `${event.toolName}${detail ? `: ${String(detail).split("\n")[0].slice(0, 160)}` : ""}`;
    beat({ activity: { text: line, at: Date.now() } }, { kind: "tool", text: line });
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (WORKER_ID) {
      const prompt = await workerPrompt().catch(() => "");
      return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
    }
    if (!runId) return undefined;
    let where = "";
    try {
      const s = await hq("GET", `/api/runs/${runId}`);
      const done = s.tasks.filter((t: any) => t.status === "done").length;
      where = `\nCurrent run: "${s.run.title}" status=${s.run.status}${s.plan ? `, plan v${s.plan.version} ${s.plan.status}` : ", no plan yet"}${s.tasks.length ? `, tasks ${done}/${s.tasks.length} done` : ""}, workers: ${s.workers.map((w: any) => `${w.name} (${w.role}, ${w.alive ? w.status : "offline"})`).join(", ") || "none"}. Dashboard: ${hqUrl(`/runs/${runId}`)}`;
    } catch {}
    return { systemPrompt: `${event.systemPrompt}\n\n${CEO_PROTOCOL}${where}` };
  });

  // ----- commands -----
  pi.registerCommand("redplan", { description: "Plan with you, get approval in RedPi HQ, then run the plan with named worker sessions", handler: async (args: string, ctx: any) => {
    if (WORKER_ID) return ctx.ui.notify("This is a RedPlan worker session; start /redplan from the CEO session.", "warning");
    let request = (args || "").trim();
    if (!request && ctx.hasUI) request = ((await ctx.ui.editor?.("What should RedPlan plan and build?", "")) || (await ctx.ui.input("What should RedPlan plan and build?", "Describe the goal"))) ?? "";
    request = request.trim();
    if (!request) return ctx.ui.notify("Usage: /redplan <what to build>", "error");
    if (runId && ctx.hasUI && !(await ctx.ui.confirm("Start a new RedPlan run?", "This session is already leading a run. Start a new one? (The old run stays in HQ.)"))) return;
    try { await ensureHq(); } catch (e: any) { return ctx.ui.notify(e.message, "error"); }
    const created = await hq("POST", "/api/runs", { projectPath: ctx.cwd, title: request.split("\n")[0].slice(0, 90), request, ceoSession: ctx.sessionManager?.getSessionFile?.() || null });
    runId = created.run.id;
    inboxCursor = 0;
    pi.appendEntry("redplan-run", { runId });
    setTools();
    startPolling();
    ctx.ui.setStatus("redplan", `RedPlan CEO · ${hqUrl(`/runs/${runId}`)}`);
    ctx.ui.notify(`RedPlan run started.\nDashboard: ${hqUrl(`/runs/${runId}`)}\nAll projects: ${hqUrl("/")}`, "info");
    pi.sendUserMessage(`[RedPlan] New request:\n\n${request}\n\nFollow the RedPlan protocol, starting with Phase 1 (intake).`);
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

  pi.registerCommand("hq", { description: "Open RedPi HQ: all RedPlan runs on this machine", handler: async (_args: string, ctx: any) => {
    try { await ensureHq(); } catch (e: any) { return ctx.ui.notify(e.message, "error"); }
    ctx.ui.notify(`RedPi HQ: ${hqUrl(runId ? `/runs/${runId}` : "/")}`, "info");
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
    for (const w of s.workers) lines.push(`Worker ${w.name} (${w.role}) — ${w.alive ? w.status : "OFFLINE (tmux session gone)"}${w.current_task ? `, on ${w.current_task}` : ""}; tmux: ${w.tmux || "-"}; cwd: ${w.cwd}${w.branch ? ` [${w.branch}]` : ""}`);
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
    }),
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const state = await hq("GET", `/api/runs/${runId}`);
      if (!state.plan || state.plan.status !== "approved") throw new Error("The plan is not approved yet. Wait for the human's approval.");
      const known = new Set(state.tasks.map((t: any) => t.id));
      const unknown = params.taskIds.filter((t: string) => !known.has(t));
      if (unknown.length) throw new Error(`Unknown task ids: ${unknown.join(", ")}`);
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

      const worker = await hq("POST", `/api/runs/${runId}/workers`, { name, role: params.role, cwd, branch, tmux: session, taskIds: params.taskIds, brief: params.brief });
      const env: Record<string, string> = {
        REDPI_HQ_WORKER: worker.id, REDPI_HQ_RUN: runId, REDPI_HQ_NAME: name, REDPI_HQ_PORT: String(HQ_PORT), REDPI_HQ_DIR: HQ_DIR,
        PATH: process.env.PATH || "", ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
        ...(TMUX_SOCKET ? { REDPI_TMUX_SOCKET: TMUX_SOCKET } : {}),
      };
      for (const k of ["REDPI_AUTO_UPDATE", "NINE_ROUTER_API_KEY", "NINE_ROUTER_BASE_URL", "REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS", "TERM"]) if (process.env[k]) env[k] = process.env[k]!;
      const piCli = process.argv[1];
      // Workers load RedPi from the installed packages like any Pi; REDPI_WORKER_ARGS adds CLI flags (tests pass -e).
      const extra = (process.env.REDPI_WORKER_ARGS || "").split(/\s+/).filter(Boolean);
      if (process.env.REDPI_WORKER_ARGS) env.REDPI_WORKER_ARGS = process.env.REDPI_WORKER_ARGS;
      const r = spawnSync("tmux", tmuxArgs("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", cwd,
        ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), process.execPath, piCli, ...extra), { encoding: "utf8" });
      if (r.status !== 0) {
        await hq("PATCH", `/api/workers/${worker.id}`, { status: "failed" }).catch(() => {});
        throw new Error(`tmux failed to start ${name}: ${(r.stderr || r.stdout).trim()}`);
      }
      const attach = `tmux ${TMUX_SOCKET ? `-L ${TMUX_SOCKET} ` : ""}attach -t '=${session}'`;
      return text(`${name} (${params.role}) started on ${params.taskIds.join(", ")} in ${cwd}${branch ? ` [branch ${branch}]` : ""}.\nWatch or join: ${attach}\nDashboard: ${hqUrl(`/runs/${runId}`)}\n${name} receives the brief automatically and will message you with questions and reports.`, { workerId: worker.id, name, session });
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

  pi.registerTool({
    name: "redplan_send", label: "RedPlan message",
    description: "Send a message to a teammate by name, to the CEO (\"ceo\"), or to everyone (\"all\"). It is delivered into their session.",
    parameters: Type.Object({ to: Type.String({ description: "Teammate name, \"ceo\", or \"all\"" }), message: Type.String() }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const s = await hq("GET", `/api/runs/${runId}`);
      const target = String(params.to).trim();
      const lower = target.toLowerCase();
      let to = lower === "ceo" || lower === "all" ? lower : s.workers.find((w: any) => w.name.toLowerCase() === lower || w.id === target)?.id;
      if (!to) throw new Error(`No teammate named "${target}". Team: ${s.workers.map((w: any) => w.name).join(", ") || "(none)"}, or "ceo" / "all".`);
      if (to === me()) throw new Error("That is you.");
      await hq("POST", `/api/runs/${runId}/messages`, { from: me(), to, kind: "chat", body: params.message });
      return text(`Sent to ${target}.`);
    },
  } as any);

  pi.registerTool({
    name: "redplan_update_task", label: "Update RedPlan task",
    description: "Move a task card on the RedPlan board: todo, in_progress, review, blocked (give a reason), or done (verified).",
    parameters: Type.Object({
      taskId: Type.String(),
      status: Type.Union(["todo", "in_progress", "review", "blocked", "done"].map((s) => Type.Literal(s))),
      note: Type.Optional(Type.String({ description: "Reason when blocked; short result or verification when done" })),
    }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      const t = await hq("POST", `/api/runs/${runId}/tasks/${encodeURIComponent(params.taskId)}`, { status: params.status, note: params.note, actor: me(), ...(WORKER_ID && params.status === "in_progress" ? { workerId: WORKER_ID } : {}) });
      return text(`${t.id} is now ${t.status}.`);
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
    description: "Mark the run done after all tasks are complete, work is integrated, and verification passed. Include the final report for the human.",
    parameters: Type.Object({ report: Type.String() }),
    async execute(_id: string, params: any) {
      if (!runId) throw new Error("No RedPlan run in this session.");
      await hq("POST", `/api/runs/${runId}/messages`, { from: "ceo", to: "human", kind: "chat", body: params.report });
      await hq("PATCH", `/api/runs/${runId}`, { status: "done" });
      return text(`Run marked done. Report posted to HQ: ${hqUrl(`/runs/${runId}`)}`);
    },
  } as any);
}
