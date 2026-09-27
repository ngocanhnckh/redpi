#!/usr/bin/env node
// A stand-in for the claude / codex / opencode CLIs in tests. It speaks each one's headless JSON
// event format (as documented and observed), logs every invocation, and acts on the prompt:
//   "[RedPlan brief" + "TASK=<id>"  → uses `redpi-hq` to start the task, message the CEO, move it to review
//   "SLOWTASK"                        → hangs (only an interrupt ends it)
//   "PROVIDER-DOWN"                   → fails like a rate-limited provider
//   a fork (side question)            → answers; "please also" in the question → FORWARD line
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const [harness, ...args] = process.argv.slice(2);
if (args.includes("--version")) { console.log(`9.9.9 (fake ${harness})`); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

let session, fork = false, prompt;
if (harness === "claude") {
  session = after("--session-id") || after("--resume");
  fork = args.includes("--fork-session");
  prompt = readFileSync(0, "utf8");
} else if (harness === "codex") {
  const sub = args[1];
  fork = sub === "fork";
  session = sub === "resume" || sub === "fork" ? args[args.length - 2] : undefined;
  prompt = readFileSync(0, "utf8");
} else {
  session = after("--session");
  fork = args.includes("--fork");
  prompt = args[args.length - 1];
}
const resumed = !!session && (harness !== "claude" || args.includes("--resume"));
if (!session || fork) session = harness === "claude" ? (fork ? randomUUID() : session) : `${harness}-${randomUUID().slice(0, 8)}`;
if (process.env.FAKE_HARNESS_LOG) appendFileSync(process.env.FAKE_HARNESS_LOG, JSON.stringify({ harness, args, prompt, fork, resumed, session, worker: process.env.REDPI_HQ_WORKER, cwd: process.cwd(), sys: after("--append-system-prompt") || "" }) + "\n");

const say = (text) => {
  if (harness === "claude") emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  else if (harness === "codex") emit({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
  else emit({ type: "text", sessionID: session, part: { type: "text", text } });
};
const tool = (command) => {
  if (harness === "claude") emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  else if (harness === "codex") emit({ type: "item.started", item: { id: "c", type: "command_execution", command, status: "in_progress" } });
  else emit({ type: "tool_use", sessionID: session, part: { type: "tool", tool: "bash", state: { status: "completed", input: { command } } } });
  execFileSync("sh", ["-c", command], { stdio: ["ignore", "ignore", "inherit"] });
};
const finish = (ok, final, error = "") => {
  if (harness === "claude") emit({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: ok ? final : error, session_id: session });
  else if (harness === "codex") emit(ok ? { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } } : { type: "turn.failed", error: { message: error } });
  else if (!ok) emit({ type: "error", sessionID: session, error: { name: "APIError", data: { message: error } } });
  else emit({ type: "step_finish", sessionID: session, part: { type: "step-finish", reason: "stop" } });
  process.exit(ok ? 0 : 1);
};

if (harness === "claude") emit({ type: "system", subtype: "init", session_id: session });
else if (harness === "codex") emit({ type: "thread.started", thread_id: session });
else emit({ type: "step_start", sessionID: session, part: { type: "step-start" } });

if (fork) {
  const q = prompt.split("THE HUMAN ASKS").pop().toLowerCase();
  const text = q.includes("please also") ? "FORWARD: Also add a /health endpoint.\nPassed that on to my live session." : `${harness} worker here (btw): halfway through my task.`;
  say(text); finish(true, text);
} else if (prompt.includes("PROVIDER-DOWN")) {
  finish(false, "", "rate limit exceeded (429)");
} else if (prompt.includes("SLOWTASK") && !prompt.includes("INTERRUPTED-NOW")) {
  say("Working on the slow task…");
  setTimeout(() => finish(true, "slow task done"), 60000);
} else if (prompt.includes("[RedPlan brief")) {
  const task = /TASK=(\w+)/.exec(prompt)?.[1] || "T1";
  tool(`redpi-hq task ${task} in_progress`);
  tool(`redpi-hq send ceo "${harness} worker: started ${task}"`);
  tool(`redpi-hq task ${task} review "fake tests pass"`);
  const text = `Done with ${task}; moved it to review.`;
  say(text); finish(true, text);
} else {
  const text = `ack (${harness}, ${resumed ? "same session" : "new session"}): ${prompt.split("\n").find((l) => l.trim() && !l.startsWith("[")) || ""}`;
  say(text); finish(true, text);
}
