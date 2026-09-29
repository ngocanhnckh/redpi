// Coding-agent harnesses a RedPlan worker can run on. Pi workers are full Pi sessions with the
// RedPlan extension; every other harness is driven by hq/runner.mjs through its own headless,
// resumable CLI mode (one process per turn, same session every turn), so HQ always knows whether
// the worker is busy, and resuming is just "continue that session id". Nothing here writes to the
// harness's own config files.
import { execFile } from "node:child_process";

export const HARNESSES = {
  pi: { name: "Pi (RedPi)", short: "Pi", bin: "pi" },
  claude: { name: "Claude Code", short: "Claude", bin: "claude" },
  codex: { name: "Codex", short: "Codex", bin: "codex" },
  opencode: { name: "OpenCode", short: "OpenCode", bin: "opencode" },
};
export const HARNESS_IDS = Object.keys(HARNESSES);
export const DEFAULT_HARNESS = "pi";

// A harness is installed when `<bin> --version` answers (OpenRig checks runtimes the same way).
export function detectHarnesses(env = process.env) {
  return Promise.all(HARNESS_IDS.map((id) => new Promise((resolve) => {
    const h = HARNESSES[id];
    execFile(h.bin, ["--version"], { timeout: 10000, env }, (err, stdout, stderr) => {
      const line = String(stdout || stderr || "").trim().split("\n").filter(Boolean).pop() || "";
      // Pi is what runs RedPlan in the first place, even when its binary is not on the hub's PATH.
      resolve({ id, name: h.name, short: h.short, installed: id === DEFAULT_HARNESS || !err, version: err ? null : line.slice(0, 80) });
    });
  })));
}

// Worker autonomy: "full" matches Pi workers (no prompts, no sandbox); "sandboxed" lets each
// harness keep its own safety rails (Claude acceptEdits, Codex workspace-write, OpenCode asks).
// Headless modes never stop to ask: anything not allowed simply fails and the agent adapts.
//
// Returns { bin, args, stdin } for one turn. `session` is the harness session id once known.
// `fork` answers a side question on a copy of the session, leaving the real one untouched.
export function turnCommand(harness, { prompt, session, fresh, instructions, autonomy = "full", cwd, fork = false }) {
  const full = autonomy !== "sandboxed";
  if (harness === "claude") {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", full ? "bypassPermissions" : "acceptEdits"];
    if (fresh) args.push("--session-id", session);
    else args.push("--resume", session, ...(fork ? ["--fork-session"] : []));
    if (instructions) args.push("--append-system-prompt", instructions);
    return { bin: "claude", args, stdin: prompt };
  }
  if (harness === "codex") {
    const safety = full ? ["--dangerously-bypass-approvals-and-sandbox"] : fresh ? ["-s", "workspace-write"] : ["-c", 'sandbox_mode="workspace-write"'];
    if (fresh) return { bin: "codex", args: ["exec", "--json", "--skip-git-repo-check", "-C", cwd, ...safety, "-"], stdin: withInstructions(prompt, instructions) };
    if (fork) return { bin: "codex", args: ["exec", "fork", "--json", "--skip-git-repo-check", ...safety, session, "-"], stdin: prompt };
    return { bin: "codex", args: ["exec", "resume", "--json", "--skip-git-repo-check", ...safety, session, "-"], stdin: prompt };
  }
  if (harness === "opencode") {
    const args = ["run", "--format", "json", ...(full ? ["--auto"] : [])];
    if (!fresh) args.push("--session", session, ...(fork ? ["--fork"] : []));
    args.push(fresh ? withInstructions(prompt, instructions) : prompt);
    return { bin: "opencode", args, stdin: null };
  }
  throw new Error(`no headless driver for harness ${harness}`);
}

function withInstructions(prompt, instructions) {
  return instructions ? `${instructions}\n\n---\n\n${prompt}` : prompt;
}

// Normalise one JSON line of harness output into zero or more events:
// { session } | { tool, detail } | { text } | { done, ok, error } | { usage }
export function parseLine(harness, line) {
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  const out = [];
  const detailOf = (input) => {
    if (!input || typeof input !== "object") return String(input ?? "");
    return String(input.command ?? input.file_path ?? input.filePath ?? input.path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input)).split("\n")[0];
  };
  if (harness === "claude") {
    if (e.session_id && (e.type === "system" || e.type === "result")) out.push({ session: e.session_id });
    if (e.type === "assistant") for (const c of e.message?.content || []) {
      if (c.type === "text" && c.text?.trim()) out.push({ text: c.text });
      if (c.type === "tool_use") out.push({ tool: c.name, detail: detailOf(c.input) });
    }
    // Tokens per model call; the turn's cost comes with the result.
    const u = e.type === "assistant" && e.message?.usage;
    if (u) out.push({ usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, model: e.message?.model } });
    if (e.type === "result" && Number(e.total_cost_usd) > 0) out.push({ usage: { cost: Number(e.total_cost_usd) } });
    if (e.type === "result") out.push({ done: true, ok: !e.is_error && e.subtype === "success", error: e.is_error || e.subtype !== "success" ? String(e.result || e.subtype || "error") : "", final: typeof e.result === "string" ? e.result : "" });
  } else if (harness === "codex") {
    if (e.type === "thread.started" && e.thread_id) out.push({ session: e.thread_id });
    const item = e.item;
    if (e.type === "item.started" && item?.type === "command_execution") out.push({ tool: "shell", detail: String(item.command || "").split("\n")[0] });
    if (e.type === "item.completed" && item) {
      if (item.type === "agent_message" && item.text?.trim()) out.push({ text: item.text });
      if (item.type === "file_change") out.push({ tool: "edit", detail: (item.changes || []).map((c) => c.path).join(", ") });
      if (item.type === "mcp_tool_call") out.push({ tool: `${item.server || "mcp"}.${item.tool || "tool"}`, detail: "" });
      if (item.type === "web_search") out.push({ tool: "web_search", detail: item.query || "" });
    }
    if (e.type === "turn.completed" && e.usage) out.push({ usage: { input: (e.usage.input_tokens || 0) - (e.usage.cached_input_tokens || 0), cacheRead: e.usage.cached_input_tokens, output: e.usage.output_tokens } });
    if (e.type === "turn.completed") out.push({ done: true, ok: true, error: "" });
    if (e.type === "turn.failed") out.push({ done: true, ok: false, error: String(e.error?.message || "turn failed") });
    if (e.type === "error") out.push({ done: true, ok: false, error: String(e.message || "error") });
  } else if (harness === "opencode") {
    if (e.sessionID) out.push({ session: e.sessionID });
    if (e.type === "text" && e.part?.text?.trim()) out.push({ text: e.part.text });
    if (e.type === "tool_use" && e.part?.tool) out.push({ tool: e.part.tool, detail: detailOf(e.part.state?.input) });
    const tk = e.type === "step_finish" && e.part?.tokens;
    if (tk) out.push({ usage: { input: tk.input, output: tk.output, cacheRead: tk.cache?.read, cacheWrite: tk.cache?.write, cost: e.part.cost } });
    if (e.type === "error") out.push({ done: true, ok: false, error: String(e.error?.data?.message || e.error?.message || e.error?.name || "error") });
  }
  return out;
}

// How to open the worker's own session interactively (shown in the dashboard).
export function interactiveCommand(harness, session, cwd) {
  if (!session) return null;
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  if (harness === "claude") return `cd ${q(cwd)} && claude --resume ${session}`;
  if (harness === "codex") return `cd ${q(cwd)} && codex resume ${session}`;
  if (harness === "opencode") return `cd ${q(cwd)} && opencode --session ${session}`;
  return null;
}
