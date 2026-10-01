// Watched long-running commands (original RedPi code).
//
// Agents used to block for hours on slow builds and polling loops without checking whether
// anything was still happening. RedPi's bash runs every command (except those with a short
// timeout) as a job it can watch. A command that is still running after ~10 minutes, or goes
// quiet with nothing using CPU, disk or network for ~5, is moved to the background with a
// health report instead of blocking or being killed, and the agent is told to investigate.
// While a job runs in the background, RedPi keeps watching: the agent gets a message when it
// finishes or starts looking wrong. Nothing is stopped automatically: only the agent (with the
// reason it concluded), or you aborting the command, stops a job.
import { createBashToolDefinition, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HealthSampler, ago, assess, listJobs, logFile, newJob, oneLine, pruneJobs, readFrom, readMeta, refresh, removeJob, report, startJob, stopJob, tailLog, writeMeta, type Assessment, type Health, type JobMeta } from "../lib/jobs.ts";
import { BRIDGE_BASH_TIMEOUT_S, isClaudeBridge } from "../lib/claude-bridge.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const ms = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v * 1000 : dflt; };
// Tunable for tests: seconds.
const CHECKPOINT_MS = ms("REDPI_WATCH_CHECKPOINT_SEC", 10 * 60_000);
const QUIET_MS = ms("REDPI_WATCH_QUIET_SEC", 5 * 60_000);
const SAMPLE_MS = ms("REDPI_WATCH_SAMPLE_SEC", 5000);
const REALERT_MS = 20 * 60_000;
const SHORT_TIMEOUT_S = 30;   // commands given a timeout this short run as before (and are killed at it)

function shellSettings(): { shellPath?: string; commandPrefix?: string } {
  try { const s = JSON.parse(readFileSync(join(AGENT_DIR, "settings.json"), "utf8")); return { shellPath: s.shellPath, commandPrefix: s.shellCommandPrefix }; } catch { return {}; }
}
function findShell(shellPath?: string): string {
  for (const p of [shellPath, "/bin/bash", "/usr/bin/bash"]) if (p && existsSync(p)) return p;
  return "/bin/sh";
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

type Live = { m: JobMeta; s: HealthSampler; h?: Health; a?: Assessment; alerted: Map<string, number>; waiters: number; lastProgress: number; sampling?: Promise<void> };

export default function (pi: ExtensionAPI) {
  if (process.platform !== "linux" || process.env.REDPI_WATCH === "0") return;
  const settings = shellSettings();
  const SHELL = findShell(settings.shellPath);
  const local = createLocalBashOperations({ shellPath: settings.shellPath });
  const live = new Map<string, Live>();
  let latestCtx: any;
  // The Claude bridge gives every bash call a 120 s timeout because Claude Code expects one.
  // Drop that default so long commands get the same watching (moved to the background after
  // ~10 minutes, never killed) as with any other provider; a timeout the model chose stays.
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName === "bash" && isClaudeBridge(ctx.model) && event.input?.timeout === BRIDGE_BASH_TIMEOUT_S) delete event.input.timeout;
    return undefined;
  });

  const track = (m: JobMeta): Live => { const l: Live = { m, s: new HealthSampler(m), alerted: new Map(), waiters: 0, lastProgress: 0 }; live.set(m.id, l); return l; };
  const sampleNow = (l: Live) => (l.sampling ??= l.s.sample().then((h) => { l.h = h; l.a = assess(l.m, h, QUIET_MS); }).catch(() => {}).finally(() => { l.sampling = undefined; }));
  const running = () => [...live.values()].filter((l) => l.m.state === "running").sort((a, b) => b.m.created - a.m.created);

  function updateStatus() {
    const ui = latestCtx?.ui; if (!ui?.setStatus) return;
    const r = running().filter((l) => Date.now() - l.m.created >= 20_000);
    ui.setStatus("redpi-jobs", r.length ? `⏳ ${oneLine(r[0].m, r[0].h, r[0].a)}${r.length > 1 ? ` (+${r.length - 1} more · /jobs)` : ""}` : undefined);
  }

  /** Tell the agent (waking it if idle), the person at the terminal, and RedPi HQ. */
  function deliver(kind: "alert" | "finished", l: Live, text: string, short: string) {
    latestCtx?.ui?.notify?.(short, kind === "alert" ? "warning" : "info");
    pi.events.emit("redpi:job", { kind, id: l.m.id, text: short });
    const idle = latestCtx?.isIdle?.() ?? true;
    const wake = process.env.REDPI_JOB_WAKE !== "0";
    try {
      pi.sendMessage({ customType: "redpi-job", content: text, display: true, details: { id: l.m.id, kind } },
        idle ? (wake ? { triggerTurn: true } : { deliverAs: "nextTurn" }) : { deliverAs: "steer" });
    } catch {}
  }

  function finishedText(l: Live): [string, string] {
    const m = l.m, out = tailLog(m.id, 25);
    const how = m.state === "exited" ? `finished with exit code ${m.exitCode}` : m.state === "stopped" ? "was stopped" : "is gone without an exit code";
    return [`[RedPi job ${m.id} ${how} after ${ago((m.ended || Date.now()) - m.created)}]\n${report(m)}\nLast output:\n${out || "(none)"}\nFull log: ${logFile(m.id)}`,
      `RedPi job ${m.id} ${how}: ${m.command.split("\n")[0].slice(0, 60)}`];
  }

  // One watcher for every job this Pi owns: health, alerts, finish notices, status line, HQ.
  let ticking = false;
  const monitor = setInterval(async () => {
    if (ticking) return; ticking = true;
    try {
      for (const l of [...live.values()]) {
        refresh(l.m);
        if (l.m.state !== "running") {
          live.delete(l.m.id);
          if (!l.m.attached && l.waiters === 0) { const [t, s] = finishedText(l); deliver("finished", l, t, s); }
          continue;
        }
        if (Date.now() - l.m.created < Math.min(15_000, QUIET_MS / 2)) continue;
        await sampleNow(l);
        if (!l.a || !l.h) continue;
        if (!l.m.attached && l.waiters === 0) {
          const fresh = l.a.findings.filter((f) => f.level === "warn" && Date.now() - (l.alerted.get(f.key) ?? 0) > REALERT_MS);
          if (fresh.length) {
            fresh.forEach((f) => l.alerted.set(f.key, Date.now()));
            deliver("alert", l, `[RedPi job ${l.m.id} needs a look: ${l.a.verdict}]\n${report(l.m, l.h, l.a)}\nIt is still running. Find out what is wrong before deciding (its logs, the processes, docker, disk, memory, network) and say what you found. Stop it only once you know, with redpi_job stop and the reason.`,
              `RedPi job ${l.m.id}: ${l.a.verdict} (${fresh[0].text.slice(0, 80)})`);
          }
        }
        if (Date.now() - l.lastProgress > 30_000) { l.lastProgress = Date.now(); pi.events.emit("redpi:job", { kind: "progress", id: l.m.id, since: l.m.created, text: `Waiting on ${oneLine(l.m, l.h, l.a)}` }); }
      }
      updateStatus();
    } finally { ticking = false; }
  }, SAMPLE_MS);
  monitor.unref?.();

  // ----- bash: same tool, same output, but long commands run as watched jobs -----
  const exec = async (command: string, cwd: string, opts: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) => {
    if (opts.timeout !== undefined && opts.timeout <= SHORT_TIMEOUT_S) return local.exec(command, cwd, opts);
    if (opts.signal?.aborted) throw new Error("aborted");
    let m: JobMeta;
    try { m = startJob(newJob({ command, cwd, shell: SHELL, attached: true }), opts.env); } catch { return local.exec(command, cwd, opts); }
    const l = track(m);
    // Hand control back before the caller's own timeout would have killed it.
    const limit = Math.min(CHECKPOINT_MS, opts.timeout ? opts.timeout * 1000 - 10_000 : Infinity);
    return new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let offset = 0, done = false;
      const pump = () => { const b = readFrom(logFile(m.id), offset); if (b.length) { offset += b.length; opts.onData(b); } };
      const end = (fn: () => void) => { if (done) return; done = true; clearInterval(t); opts.signal?.removeEventListener("abort", onAbort); fn(); updateStatus(); };
      const onAbort = () => end(() => {
        // You pressed Esc (or the turn was cancelled): that is a decision to stop it.
        m.attached = false; live.delete(m.id);
        stopJob(m, "aborted with the command", 3000).catch(() => {});
        reject(new Error("aborted"));
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const t = setInterval(() => {
        pump();
        refresh(m);
        if (m.state !== "running") return end(() => {
          pump(); live.delete(m.id);
          if (m.state === "exited" && Date.now() - m.created < 60_000) removeJob(m.id);
          resolve({ exitCode: m.state === "exited" ? (m.exitCode ?? null) : null });
        });
        const el = Date.now() - m.created;
        const stuck = !!l.a?.stuck && el >= QUIET_MS;
        if (el < limit && !stuck) return;
        end(() => {
          pump();
          m.attached = false; m.detachedAt = Date.now(); writeMeta(m);
          (l.a?.findings || []).filter((f) => f.level === "warn").forEach((f) => l.alerted.set(f.key, Date.now()));
          const why = stuck ? `went quiet and looks stuck after ${ago(el)}` : `is still running after ${ago(el)}`;
          pi.events.emit("redpi:job", { kind: "detached", id: m.id, text: `Moved a long command to the background as job ${m.id}: ${m.command.split("\n")[0].slice(0, 80)} (${stuck ? "looks stuck" : `running ${ago(el)}`})` });
          opts.onData(Buffer.from(`\n\n━━ RedPi: this command ${why}. It was moved to the background as job ${m.id} and was NOT stopped. ━━\n${report(m, l.h, l.a)}\n` +
            `Next: find out whether it is healthy before waiting more. Wait with redpi_job wait (it returns early if the job finishes or starts looking wrong); look deeper with redpi_job status / logs and ordinary commands (ps, docker ps/logs/stats, df, free). Stop it only once you know what is wrong: redpi_job stop with the reason. You also get a message when it finishes or looks wrong.\n`));
          resolve({ exitCode: 0 });
        });
      }, 250);
    });
  };
  pi.registerTool(createBashToolDefinition(process.cwd(), { operations: { exec }, shellPath: settings.shellPath, commandPrefix: settings.commandPrefix }) as any);

  // ----- redpi_job: start, watch, diagnose, stop -----
  const pick = (id?: string): JobMeta | undefined => (id ? live.get(id)?.m || readMeta(id) : running()[0]?.m || listJobs()[0]);
  pi.registerTool({
    name: "redpi_job",
    label: "Background job",
    description: "Run, watch and diagnose long-running commands (docker builds, big test suites, deploys, data jobs). Actions: start (run a command in the background), status (health report: output, processes, CPU, disk, memory, network, docker), logs (tail or grep its output), wait (block up to N minutes; returns early when it finishes or starts looking wrong), list, stop (only with the reason you concluded).",
    promptSnippet: "Run and watch long-running commands in the background, with health reports",
    promptGuidelines: [
      "Long commands are watched: a bash command still running after about 10 minutes, or quiet with nothing using CPU, disk or network for about 5, is moved to the background as a job (never killed) and you get a health report.",
      "Never poll with sleep loops. Start known-long work (docker builds, large test suites, deploys) with redpi_job start, then use redpi_job wait.",
      "When a job is slower than expected or looks stuck, investigate before waiting more: read its logs, look at its processes, docker ps/logs/stats, disk, memory and network, then say what you found.",
      "Stop a job only after you have concluded what is wrong, and give that reason to redpi_job stop.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "start | status | logs | wait | list | stop" }),
      id: Type.Optional(Type.String({ description: "Job id (e.g. j3k2a0). Defaults to the most recent running job." })),
      command: Type.Optional(Type.String({ description: "For start: the shell command to run in the background." })),
      expectMinutes: Type.Optional(Type.Number({ description: "For start: about how long it should take; you are told when it runs 50% over." })),
      minutes: Type.Optional(Type.Number({ description: "For wait: the most to wait, in minutes (default 10, max 30)." })),
      lines: Type.Optional(Type.Number({ description: "For logs: how many lines (default 80, max 400)." })),
      grep: Type.Optional(Type.String({ description: "For logs: only lines matching this regular expression (case-insensitive)." })),
      reason: Type.Optional(Type.String({ description: "For stop: what you concluded is wrong (required)." })),
    }),
    async execute(_toolCallId: string, p: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      latestCtx = ctx ?? latestCtx;
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
      const action = String(p.action || "").trim().toLowerCase();
      if (action === "list") {
        const jobs = listJobs().slice(0, 15);
        return text(jobs.length ? jobs.map((m) => { const l = live.get(m.id); return `${oneLine(refresh(m), l?.h, l?.a)}${m.state === "running" && !l ? " (watched by another Pi)" : ""}`; }).join("\n") : "No jobs.");
      }
      if (action === "start") {
        if (!p.command?.trim()) throw new Error("start needs a command");
        const cmd = settings.commandPrefix ? `${settings.commandPrefix}\n${p.command}` : p.command;
        const m = startJob(newJob({ command: cmd, cwd: ctx?.cwd || process.cwd(), shell: SHELL, attached: false, expectMin: p.expectMinutes }));
        m.detachedAt = m.created; writeMeta(m);
        const l = track(m);
        await sleep(3000); refresh(m);
        if (m.state !== "running") { live.delete(m.id); return text(`${report(m)}\nOutput:\n${tailLog(m.id, 40) || "(none)"}`); }
        return text(`Started job ${m.id} in the background.\n${tailLog(m.id, 10) ? `First output:\n${tailLog(m.id, 10)}\n` : ""}Use redpi_job wait ${m.id} to wait for it (returns early if it finishes or looks wrong), or keep working: you get a message when it finishes or starts looking wrong.`);
      }
      const m = pick(p.id);
      if (!m) throw new Error(p.id ? `no job ${p.id}` : "no jobs yet");
      refresh(m);
      if (action === "logs") {
        const n = Math.max(1, Math.min(400, Number(p.lines) || 80));
        return text(`${tailLog(m.id, n, p.grep) || (p.grep ? "(no matching lines)" : "(no output yet)")}\n\n[job ${m.id} · ${m.state} · full log: ${logFile(m.id)}]`);
      }
      if (action === "stop") {
        const reason = String(p.reason || "").trim();
        if (reason.length < 10) throw new Error("Give the reason you concluded it has to be stopped (what is wrong, and how you know). If you are not sure yet, investigate first: redpi_job status / logs, ps, docker ps/logs/stats, df, free.");
        if (m.state !== "running") return text(`${report(m)}\n(Nothing to stop.)`);
        await stopJob(m, reason);
        live.delete(m.id); updateStatus();
        pi.events.emit("redpi:job", { kind: "stopped", id: m.id, text: `Stopped job ${m.id}: ${reason.slice(0, 160)}` });
        return text(`${report(m)}\nLast output:\n${tailLog(m.id, 20) || "(none)"}`);
      }
      if (action === "status" || action === "wait") {
        if (m.state !== "running") return text(`${report(m)}\nLast output:\n${tailLog(m.id, 30) || "(none)"}\nFull log: ${logFile(m.id)}`);
        const l = live.get(m.id) || track(m);
        if (!l.h) { await sampleNow(l); await sleep(Math.min(5000, SAMPLE_MS)); }
        await sampleNow(l);
        if (action === "status") return text(report(m, l.h, l.a));
        const minutes = Math.max(0.1, Math.min(30, Number(p.minutes) || 10));
        const until = Date.now() + minutes * 60_000;
        const known = new Set((l.a?.findings || []).filter((f) => f.level === "warn").map((f) => f.key));
        let why = "";
        l.waiters++;
        try {
          while (!why) {
            if (signal?.aborted) { why = "Stopped waiting (cancelled). The job keeps running."; break; }
            if (Date.now() >= until) { why = `Still running after waiting ${ago(minutes * 60_000)}.`; break; }
            await sleep(Math.min(SAMPLE_MS, Math.max(200, until - Date.now())));
            refresh(m);
            if (m.state !== "running") { why = "It finished."; break; }
            await sampleNow(l);
            onUpdate?.(text(`⏳ ${oneLine(m, l.h, l.a)}`));
            const fresh = (l.a?.findings || []).filter((f) => f.level === "warn" && !known.has(f.key));
            if (fresh.length) { fresh.forEach((f) => l.alerted.set(f.key, Date.now())); why = `Stopped waiting early: it started looking wrong (${fresh.map((f) => f.text).join("; ")}). It is still running.`; }
          }
        } finally { l.waiters--; }
        if (m.state !== "running") { live.delete(m.id); updateStatus(); return text(`${why}\n${report(m)}\nLast output:\n${tailLog(m.id, 30) || "(none)"}\nFull log: ${logFile(m.id)}`); }
        return text(`${why}\n${report(m, l.h, l.a)}`);
      }
      throw new Error(`unknown action ${action}: use start, status, logs, wait, list or stop`);
    },
  } as any);

  pi.registerCommand("jobs", { description: "Long-running commands RedPi is watching, with their health", handler: async (_args: string, ctx: any) => {
    latestCtx = ctx;
    const jobs = listJobs().slice(0, 12);
    if (!jobs.length) return ctx.ui.notify("No background jobs.", "info");
    const r = jobs.filter((m) => refresh(m).state === "running");
    for (const m of r) { const l = live.get(m.id); if (l) await sampleNow(l); }
    ctx.ui.notify([...r.map((m) => { const l = live.get(m.id); return report(m, l?.h, l?.a); }), ...jobs.filter((m) => m.state !== "running").slice(0, 6).map((m) => oneLine(m))].join("\n\n"), "info");
  } });

  // Jobs from an earlier Pi in this folder that are still running: keep watching them.
  pi.on("session_start", async (_e: any, ctx: any) => {
    latestCtx = ctx;
    try { pruneJobs(); } catch {}
    const adopted: string[] = [];
    for (const m of listJobs()) {
      if (m.state !== "running" || m.cwd !== ctx.cwd || live.has(m.id)) continue;
      if (m.owner !== process.pid && pidAlive(m.owner)) continue;
      refresh(m);
      if (m.state !== "running") continue;
      m.owner = process.pid; m.attached = false; writeMeta(m);
      track(m); adopted.push(oneLine(m));
    }
    if (adopted.length) ctx.ui?.notify?.(`RedPi is still watching ${adopted.length} background job(s) from an earlier session:\n${adopted.join("\n")}\n(/jobs for details)`, "info");
  });
  for (const ev of ["agent_start", "turn_end", "agent_end"]) pi.on(ev as any, async (_e: any, ctx: any) => { latestCtx = ctx; updateStatus(); });
  pi.on("session_shutdown", async () => { clearInterval(monitor); });
}
