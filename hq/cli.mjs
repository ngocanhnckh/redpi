#!/usr/bin/env node
// redpi-hq: the RedPlan board and team chat for workers that are not Pi (Claude Code, Codex,
// OpenCode). The agent runs it from its shell; identity comes from the environment its runner set.
// Same rules as the Pi worker tools: blocked needs a reason, done needs how it was verified.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addLesson, projectRoot, writeAdr } from "../lib/knowledge.mjs";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HQ_DIR = process.env.REDPI_HQ_DIR || join(AGENT_DIR, "yitec", "hq");
const PORT = Number(process.env.REDPI_HQ_PORT || 47291);
const ME = process.env.REDPI_HQ_WORKER || "";
const RUN = process.env.REDPI_HQ_RUN || "";
const STATUSES = ["todo", "in_progress", "review", "blocked", "done"];

const USAGE = `redpi-hq — your RedPlan board and team chat
  redpi-hq status                              the run: tasks, owners, workers
  redpi-hq team                                you, your tasks, your teammates
  redpi-hq task <id> <status> [note]           status: ${STATUSES.join(" | ")}
  redpi-hq task <id> blocked --on <who> <note> who must act: a teammate's name, ceo, external, or human
        blocked needs a note (reason); done needs a note (how you verified it)
  redpi-hq task <id> --handoff <name> <note>   hand a task to a teammate
  redpi-hq send <name|ceo|all> [--reply] <message>
                                               message a teammate, the CEO, or everyone (--reply: you need an answer;
                                               plain updates do not wake an idle teammate)
  redpi-hq adr --title T --context C --decision D --consequences X [--alternatives A] [--task ID] [--supersedes N]
                                               record a significant decision in docs/adr/ (numbered, indexed)
  redpi-hq lesson --what W --lesson L --next N [--area A]
                                               add a lesson learned to docs/lessons-learned.md`;

// --key value flags (a value runs to the next --flag).
function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)$/.exec(args[i]);
    if (!m) continue;
    const vals = [];
    while (i + 1 < args.length && !/^--[a-z]+$/.test(args[i + 1])) vals.push(args[++i]);
    out[m[1]] = vals.join(" ");
  }
  return out;
}

function die(msg) { console.error(msg); process.exit(1); }

async function hq(method, path, body) {
  let token = "";
  try { token = readFileSync(join(HQ_DIR, "token"), "utf8").trim(); } catch { die(`redpi-hq: no HQ token in ${HQ_DIR}`); }
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  }).catch((e) => die(`redpi-hq: HQ is not reachable on port ${PORT} (${e.message})`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`redpi-hq: ${data.error || `HQ ${res.status}`}`);
  return data;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { console.log(USAGE); process.exit(0); }
// Decisions and lessons live in the project, so they work with or without HQ.
if (cmd === "adr" || cmd === "lesson") {
  const f = flags(rest), root = projectRoot(process.cwd()), by = process.env.REDPI_HQ_NAME || undefined;
  try {
    if (cmd === "adr") {
      const r = writeAdr(root, { title: f.title, context: f.context, decision: f.decision, alternatives: f.alternatives, consequences: f.consequences, task: f.task, supersedes: f.supersedes ? Number(f.supersedes) : undefined, by });
      console.log(`Recorded ADR ${String(r.number).padStart(4, "0")}: ${r.path}`);
    } else {
      const r = addLesson(root, { what: f.what, lesson: f.lesson, nextTime: f.next, area: f.area, by });
      console.log(r.added ? `Lesson added to ${r.path}` : `That lesson is already in ${r.path}`);
    }
  } catch (e) { die(`redpi-hq: ${e.message} (${cmd === "adr" ? "--title, --context, --decision, --consequences" : "--what, --lesson, --next"} are required)`); }
  process.exit(0);
}
if (!ME || !RUN) die("redpi-hq: not running inside a RedPlan worker (REDPI_HQ_WORKER / REDPI_HQ_RUN are not set)");

if (cmd === "status") {
  const s = await hq("GET", `/api/runs/${RUN}`);
  const who = Object.fromEntries(s.workers.map((w) => [w.id, w.name]));
  console.log(`Run: ${s.run.title} [${s.run.status}]`);
  for (const t of s.tasks) console.log(`  ${t.id} ${t.title} [${t.status}]${t.worker_id ? ` — ${who[t.worker_id] || t.worker_id}` : ""}${t.note ? ` (${t.note})` : ""}`);
  console.log("Workers:");
  for (const w of s.workers) console.log(`  ${w.name} (${w.role}, ${w.harness || "pi"}) — ${w.alive ? w.status : "offline"}${w.current_task ? `, on ${w.current_task}` : ""}`);
} else if (cmd === "team") {
  const d = await hq("GET", `/api/workers/${ME}`);
  console.log(`You: ${d.worker.name} (${d.worker.role})`);
  for (const t of d.tasks) console.log(`  ${t.id} ${t.title} [${t.status}]`);
  for (const t of d.teammates) console.log(`${t.name} (${t.role}) — ${t.status}${t.current_task ? `, on ${t.current_task}` : ""}`);
} else if (cmd === "task") {
  const [id, ...more] = rest;
  if (!id) die(USAGE);
  let status, handoffTo, note, waitingOn;
  if (more[0] === "--handoff") { handoffTo = more[1]; note = more.slice(2).join(" "); if (!handoffTo) die("redpi-hq: --handoff needs a teammate name"); }
  else {
    status = more[0];
    if (!STATUSES.includes(status)) die(`redpi-hq: status must be one of ${STATUSES.join(", ")}`);
    let args = more.slice(1);
    if (args[0] === "--on") { waitingOn = args[1]; args = args.slice(2); }
    note = args.join(" ").replace(/^--note\s+/, "");
  }
  const t = await hq("POST", `/api/runs/${RUN}/tasks/${encodeURIComponent(id)}`, { status, note: note || undefined, handoffTo, waitingOn, actor: ME, ...(status === "in_progress" ? { workerId: ME } : {}) });
  console.log(handoffTo ? `${t.id} handed to ${handoffTo}.` : `${t.id} is now ${t.status}.`);
} else if (cmd === "send") {
  const [to, ...words0] = rest;
  const needsReply = words0[0] === "--reply" ? true : undefined;
  const message = (needsReply ? words0.slice(1) : words0).join(" ").trim();
  if (!to || !message) die("redpi-hq: send <name|ceo|all> <message>");
  const s = await hq("GET", `/api/runs/${RUN}`);
  const lower = to.toLowerCase();
  const target = lower === "ceo" || lower === "all" ? lower : s.workers.find((w) => w.name.toLowerCase() === lower || w.id === to)?.id;
  if (!target) die(`redpi-hq: no teammate named "${to}". Team: ${s.workers.map((w) => w.name).join(", ")}, or "ceo" / "all".`);
  if (target === ME) die("redpi-hq: that is you.");
  const r = await hq("POST", `/api/runs/${RUN}/messages`, { from: ME, to: target, kind: "chat", body: message, ...(needsReply ? { needsReply } : {}) });
  console.log(`Sent to ${to}.${r.warning ? `\nHQ: ${r.warning}` : ""}`);
} else die(USAGE);
