// Jev in the agent loop (optional: only while the decision model is on, each part with its own
// switch in /redpi-decision):
//   - Safety check: before bash (or a redpi_job start) runs, exact rules let read-only commands
//     through and flag catastrophic ones; anything else gets one Jev call with four yes/no
//     questions. A flagged command needs the human's OK; with nobody to ask (RedPlan workers,
//     print mode) only a clearly risky one is blocked. "shadow" mode only logs.
//   - Stale-output pruning: when the context is large, Jev judges which older tool outputs are no
//     longer needed for the task, and those are replaced by a one-line stub on every later turn.
//     Decisions are stored in the session, so the prompt prefix stays stable (cache-friendly).
//   - /redpi-jev-stats: decisions by confidence band, layer, outcome, speed and cost.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { jevReady, loadJevConfig } from "../lib/jev.ts";
import { isClaudeBridge } from "../lib/claude-bridge.ts";
import {
  PRUNE_BATCH, PRUNE_KEEP_RECENT, PRUNE_MIN_CHARS, PRUNE_VERSION, SAFETY_VERSION, checkCommand, decisionStats,
  judgeStaleOutputs, logDecision, pruneStub, readDecisions, shortHash, type SafetyVerdict,
} from "../lib/jev-decisions.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const PRUNE_ENTRY = "redpi-prune";

const textOf = (content: any): string => Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text || "").join("\n") : typeof content === "string" ? content : "";
const sizeOf = (m: any) => (Array.isArray(m?.content) ? m.content : []).reduce((a: number, c: any) => a + (c?.type === "text" ? (c.text || "").length : c?.type === "image" ? 4000 : 0), 0);

export default function (pi: ExtensionAPI) {
  let lastIntent = "";
  const verdicts = new Map<string, SafetyVerdict>();
  const allowed = new Set<string>();
  const pruned = new Map<string, string>(); // toolCallId -> stub
  const kept = new Map<string, string>(); // toolCallId -> task it was judged for
  let judging = false;

  pi.on("message_end", async (event: any) => {
    if (event.message?.role === "assistant") { const t = textOf(event.message.content).trim(); if (t) lastIntent = t; }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    verdicts.clear(); allowed.clear(); pruned.clear(); kept.clear();
    try {
      for (const e of ctx.sessionManager.getEntries?.() || []) {
        if (e?.type === "custom" && e.customType === PRUNE_ENTRY) for (const [id, stub] of Object.entries(e.data?.stubs || {})) pruned.set(id, String(stub));
      }
    } catch {}
  });

  // ---- Safety check ------------------------------------------------------------------------
  pi.on("tool_call", async (event: any, ctx: any) => {
    const cfg = loadJevConfig(AGENT_DIR);
    if (!jevReady(cfg)) return undefined;
    // A RedPlan agent (worker or CEO) runs unattended in tmux with nobody watching.
    const autonomous = !!(process.env.REDPI_HQ_WORKER || process.env.REDPI_HQ_CEO);
    const mode = cfg.safety ?? "ask";
    const autoMode = cfg.safetyAutonomous ?? "shadow";
    if ((autonomous ? autoMode : mode) === "off") return undefined; // check turned off for this kind of session: no Jev call
    const input = event.input || {};
    const command = event.toolName === "bash" ? input.command : event.toolName === "redpi_job" && input.action === "start" ? input.command : undefined;
    if (typeof command !== "string" || !command.trim()) return undefined;
    const key = command.trim();
    if (allowed.has(key)) return undefined;
    const threshold = cfg.safetyThreshold ?? 0.5;
    let v = verdicts.get(key);
    if (!v) {
      v = await checkCommand(cfg, command, ctx.cwd, { intent: lastIntent, signal: ctx.signal, threshold });
      if (v.layer === "jev") verdicts.set(key, v);
    }
    if (v.layer === "code" && !v.risky) return undefined; // read-only: nothing to decide, nothing to log
    const log = (outcome: string) => logDecision(AGENT_DIR, {
      kind: "safety", version: SAFETY_VERSION, model: v!.model, layer: v!.layer, outcome, ms: v!.ms, answers: v!.scores, threshold,
      inputTokens: v!.inputTokens, inputHash: shortHash(key), ...(cfg.logInputs ? { input: key.slice(0, 500) } : {}),
      ...(v!.error ? { extra: { error: v!.error } } : {}),
    });
    if (!v.risky) { log(v.layer === "error" ? "allowed (decision model unavailable)" : v.unsure ? "allowed (unsure)" : "allowed"); return undefined; }
    const why = v.reasons.join("; ");
    if (!autonomous && mode === "shadow") { log("would ask (shadow mode)"); return undefined; }
    // Never wait on a dialog in an unattended agent's pane.
    const someoneToAsk = ctx.hasUI && !autonomous;
    if (someoneToAsk) {
      const shown = key.length > 500 ? `${key.slice(0, 500)}…` : key;
      const choice = await ctx.ui.select(`RedPi safety check: this command may ${why}.\n\n${shown}\n`, ["Block it", "Allow once", "Allow this exact command for the rest of the session"], { timeout: 10 * 60 * 1000 });
      if (choice?.startsWith("Allow")) {
        if (choice.includes("rest of the session")) allowed.add(key);
        log("approved by human");
        return undefined;
      }
      log(choice ? "blocked by human" : "blocked (no answer in 10 minutes)");
      return { block: true, reason: `The human did not approve this command after the RedPi safety check flagged that it may ${why}. Do not run it again as is: ask what they want, or use a safer alternative.` };
    }
    // Nobody can approve. By default the factory must never be stuck on a flagged command, so we log it
    // and let it run (shadow). "block" keeps the old run-blocking behaviour. ("off" returned early above.)
    if (autoMode === "shadow") { log("would block (autonomous, shadow) — allowed to keep the run moving"); return undefined; }
    const sure = v.layer === "code" || Object.values(v.scores).some((p) => p >= (cfg.safetyBlockThreshold ?? 0.8));
    if (!sure) { log("allowed (nobody to ask, below the block threshold)"); return undefined; }
    log("blocked (nobody to ask)");
    return { block: true, reason: `Blocked by the RedPi safety check: this command may ${why}, and nobody is here to approve it. Use a safer alternative. If it really is needed, ask the human to run it${process.env.REDPI_HQ_WORKER ? " (message them through redpi-hq with the exact command and why)" : ""}.` };
  });

  // ---- Stale-output pruning ----------------------------------------------------------------
  pi.on("context", async (event: any, ctx: any) => {
    const cfg = loadJevConfig(AGENT_DIR);
    // Claude Code keeps its own copy of the conversation under the Claude bridge, so edits here
    // would never reach the model: skip the Jev call.
    if (!jevReady(cfg) || cfg.prune === false || isClaudeBridge(ctx.model)) return undefined;
    const messages: any[] = event.messages || [];
    const stubbed = () => messages.map((m) => (m?.role === "toolResult" && pruned.has(m.toolCallId) ? { ...m, content: [{ type: "text", text: pruned.get(m.toolCallId) }] } : m));
    let out = pruned.size ? stubbed() : messages;
    let changed = out !== messages && out.some((m, i) => m !== messages[i]);

    const usage = ctx.getContextUsage?.();
    const window = usage?.contextWindow || ctx.model?.contextWindow || 0;
    const tokens = Number(usage?.tokens || 0);
    const due = tokens >= Math.max(cfg.pruneMinTokens ?? 60_000, window * (cfg.pruneAt ?? 0.3));
    if (due && !judging) {
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const task = textOf(lastUser?.content);
      const taskKey = shortHash(task);
      const calls = new Map<string, { name: string; args: string }>();
      for (const m of messages) if (m?.role === "assistant" && Array.isArray(m.content)) for (const c of m.content) if (c?.type === "toolCall") calls.set(c.id, { name: c.name, args: JSON.stringify(c.arguments ?? {}) });
      const results = messages.filter((m) => m?.role === "toolResult");
      const recent = new Set(results.slice(-PRUNE_KEEP_RECENT).map((m) => m.toolCallId));
      const candidates = results.filter((m) => !recent.has(m.toolCallId) && !pruned.has(m.toolCallId) && kept.get(m.toolCallId) !== taskKey && sizeOf(m) >= PRUNE_MIN_CHARS);
      const pending = candidates.reduce((a, m) => a + sizeOf(m), 0);
      // Only when enough would be saved to pay for re-sending the changed part of the prompt once.
      if (task && pending >= (cfg.pruneMinChars ?? 60_000)) {
        judging = true;
        const batch = candidates.slice(0, PRUNE_BATCH);
        try {
          const r = await judgeStaleOutputs(cfg, task, lastIntent, batch.map((m) => ({ id: m.toolCallId, tool: m.toolName || calls.get(m.toolCallId)?.name || "tool", input: calls.get(m.toolCallId)?.args || "", output: textOf(m.content) })), { signal: ctx.signal });
          const sure = cfg.pruneConfidence ?? 0.9;
          const stubs: Record<string, string> = {};
          let droppedChars = 0;
          batch.forEach((m, i) => {
            const needed = r.needed[i];
            if (needed <= 1 - sure) {
              const stub = pruneStub(m.toolName || "tool", calls.get(m.toolCallId)?.args || "", sizeOf(m), 1 - needed);
              pruned.set(m.toolCallId, stub); stubs[m.toolCallId] = stub; droppedChars += sizeOf(m);
            } else kept.set(m.toolCallId, taskKey);
          });
          if (Object.keys(stubs).length) { try { pi.appendEntry(PRUNE_ENTRY, { version: PRUNE_VERSION, stubs }); } catch {} }
          logDecision(AGENT_DIR, { kind: "prune", version: PRUNE_VERSION, model: r.model, layer: "jev", ms: r.ms, inputTokens: r.inputTokens, threshold: sure,
            outcome: Object.keys(stubs).length ? "dropped" : "kept all", extra: { judged: batch.length, dropped: Object.keys(stubs).length, droppedChars, contextTokens: tokens } });
          if (Object.keys(stubs).length) { out = stubbed(); changed = true; ctx.ui?.setStatus?.("redpi-prune", `pruned ${Object.keys(stubs).length} stale outputs (~${Math.round(droppedChars / 4000)}k tok)`); }
        } catch (e: any) {
          logDecision(AGENT_DIR, { kind: "prune", version: PRUNE_VERSION, layer: "error", outcome: "skipped (decision model unavailable)", extra: { error: String(e?.message || e) } });
        } finally { judging = false; }
      }
    }
    return changed ? { messages: out } : undefined;
  });

  pi.registerCommand("redpi-jev-stats", {
    description: "Decision model (Jev) decisions: confidence bands, which layer decided, outcomes, speed and cost. Args: number of days (default 7)",
    handler: async (args, ctx) => {
      const days = Number(String(args || "").trim()) || 7;
      const cfg = loadJevConfig(AGENT_DIR);
      const head = `Decision model: ${jevReady(cfg) ? "ON" : "OFF"} · safety check ${jevReady(cfg) ? cfg.safety ?? "ask" : "off"} (agents ${jevReady(cfg) ? cfg.safetyAutonomous ?? "shadow" : "off"}) · pruning ${jevReady(cfg) && cfg.prune !== false ? "on" : "off"} · last ${days} day(s)`;
      ctx.ui.notify(`${head}\n\n${decisionStats(readDecisions(AGENT_DIR, Date.now() - days * 86_400_000))}`, "info");
    },
  });
}
