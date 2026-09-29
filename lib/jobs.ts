// Long-running command jobs (original RedPi code).
//
// A job is a shell command run in its own session by a small supervisor shell that writes
// the output to a log file and the exit code to a file. That lets a command keep running
// after the tool call that started it returns, survive a Pi restart, and still report how
// it ended. The health sampler reads /proc and Docker to tell "busy but quiet" apart from
// "stuck", and explains what it sees in plain language, so an agent investigates a slow
// build instead of sleeping on it. Linux only (it reads /proc); elsewhere commands run as usual.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";

export const JOBS_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "yitec", "jobs");

export type JobState = "running" | "exited" | "stopped" | "lost";
export type JobMeta = {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  created: number;
  owner: number;             // pid of the Pi process watching it
  attached: boolean;         // a bash tool call is still streaming it
  state: JobState;
  pid?: number;              // supervisor pid = session id of the whole process tree
  pidStart?: number;         // /proc start time, guards against pid reuse
  exitCode?: number | null;
  ended?: number;
  detachedAt?: number;
  stopReason?: string;
  expectMin?: number;
};

const dirOf = (id: string) => join(JOBS_DIR, id);
const metaFile = (id: string) => join(dirOf(id), "meta.json");
export const logFile = (id: string) => join(dirOf(id), "out.log");
const exitFile = (id: string) => join(dirOf(id), "exit");

export function writeMeta(m: JobMeta) {
  const tmp = `${metaFile(m.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 1));
  renameSync(tmp, metaFile(m.id));
}
export function readMeta(id: string): JobMeta | undefined {
  try { return JSON.parse(readFileSync(metaFile(id), "utf8")); } catch { return undefined; }
}

let seq = 0;
export function newJob(o: { command: string; cwd: string; shell: string; attached: boolean; expectMin?: number }): JobMeta {
  const id = `j${Date.now().toString(36).slice(-5)}${(seq++ % 36).toString(36)}`;
  mkdirSync(dirOf(id), { recursive: true });
  writeFileSync(join(dirOf(id), "cmd.sh"), o.command);
  const m: JobMeta = { id, command: o.command, cwd: o.cwd, shell: o.shell, created: Date.now(), owner: process.pid, attached: o.attached, state: "running", expectMin: o.expectMin };
  writeMeta(m);
  return m;
}

/** Start the supervisor: `<shell> -c "$(cat cmd.sh)"` in a new session, output to the log, exit code to a file. */
export function startJob(m: JobMeta, env: NodeJS.ProcessEnv = process.env): JobMeta {
  const d = dirOf(m.id);
  const script = `"$0" -c "$(cat "$1")" > "$2" 2>&1 < /dev/null; code=$?; echo $code > "$3.tmp" && mv "$3.tmp" "$3"`;
  const child = spawn(m.shell, ["-c", script, m.shell, join(d, "cmd.sh"), logFile(m.id), exitFile(m.id)], { cwd: m.cwd, env, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  m.pid = child.pid;
  m.pidStart = child.pid ? procStat(child.pid)?.start : undefined;
  writeMeta(m);
  return m;
}

function alive(m: JobMeta): boolean {
  if (!m.pid) return false;
  const s = procStat(m.pid);
  return !!s && s.state !== "Z" && (m.pidStart === undefined || s.start === m.pidStart);
}

/** Bring the state up to date: exited (with code), lost (gone without a code), or still running. */
export function refresh(m: JobMeta): JobMeta {
  if (m.state !== "running") return m;
  if (existsSync(exitFile(m.id))) {
    const code = Number(readFileSync(exitFile(m.id), "utf8").trim());
    m.state = "exited"; m.exitCode = Number.isFinite(code) ? code : null; m.ended = statSync(exitFile(m.id)).mtimeMs;
    writeMeta(m);
  } else if (!alive(m)) {
    m.state = "lost"; m.exitCode = null; m.ended = Date.now();
    writeMeta(m);
  }
  return m;
}

/** Stop the whole process tree: TERM, then KILL after a grace period. */
export async function stopJob(m: JobMeta, reason: string, graceMs = 8000): Promise<JobMeta> {
  if (m.pid && alive(m)) {
    try { process.kill(-m.pid, "SIGTERM"); } catch {}
    const until = Date.now() + graceMs;
    while (Date.now() < until && alive(m)) await new Promise((r) => setTimeout(r, 200));
    if (alive(m)) try { process.kill(-m.pid, "SIGKILL"); } catch {}
  }
  refresh(m);
  if (m.state === "running" || m.state === "lost") { m.state = "stopped"; m.ended = Date.now(); }
  m.stopReason = reason;
  writeMeta(m);
  return m;
}

export function removeJob(id: string) { try { rmSync(dirOf(id), { recursive: true, force: true }); } catch {} }

export function listJobs(): JobMeta[] {
  let ids: string[] = [];
  try { ids = readdirSync(JOBS_DIR); } catch { return []; }
  return ids.map(readMeta).filter((m): m is JobMeta => !!m).sort((a, b) => b.created - a.created);
}

/** Keep the last 40 finished jobs and nothing older than three days. */
export function pruneJobs() {
  const done = listJobs().filter((m) => m.state !== "running");
  done.forEach((m, i) => { if (i >= 40 || Date.now() - (m.ended || m.created) > 3 * 86400_000) removeJob(m.id); });
}

/** The last `lines` lines of the log (optionally only those matching `grep`, case-insensitive). */
export function tailLog(id: string, lines = 80, grep?: string): string {
  const text = readTail(logFile(id), grep ? 2_000_000 : 256_000);
  let out = text.split("\n");
  if (out.length && out[out.length - 1] === "") out.pop();
  if (grep) { let re: RegExp; try { re = new RegExp(grep, "i"); } catch { re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } out = out.filter((l) => re.test(l)); }
  return out.slice(-lines).join("\n");
}

export function readFrom(file: string, offset: number, max = 1_000_000): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    if (size <= offset) return Buffer.alloc(0);
    const n = Math.min(size - offset, max), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, offset);
    return buf;
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) closeSync(fd); }
}
function readTail(file: string, bytes: number): string {
  try { const size = statSync(file).size; return readFrom(file, Math.max(0, size - bytes), bytes).toString("utf8"); } catch { return ""; }
}

// ---------- health ----------

type ProcStat = { pid: number; comm: string; state: string; ppid: number; session: number; ticks: number; start: number; rssPages: number };
function procStat(pid: number): ProcStat | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = s.lastIndexOf(")");
    const f = s.slice(close + 2).split(" ");   // f[0] = field 3 (state)
    return { pid, comm: s.slice(s.indexOf("(") + 1, close), state: f[0], ppid: +f[1], session: +f[3], ticks: +f[11] + +f[12], start: +f[19], rssPages: +f[21] };
  } catch { return undefined; }
}
function tree(session: number): ProcStat[] {
  const out: ProcStat[] = [];
  let pids: string[] = [];
  try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const p of pids) { const s = procStat(+p); if (s && s.session === session) out.push(s); }
  return out;
}
/** Bytes read + written by the process (files, pipes and sockets), from /proc/<pid>/io. */
function procIo(pid: number): number {
  try { const t = readFileSync(`/proc/${pid}/io`, "utf8"); return Number(/^rchar: (\d+)/m.exec(t)?.[1] || 0) + Number(/^wchar: (\d+)/m.exec(t)?.[1] || 0); } catch { return 0; }
}
function systemCpu(): { total: number; idle: number; iowait: number } {
  try {
    const v = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
    return { total: v.slice(0, 8).reduce((a, b) => a + b, 0), idle: v[3] + v[4], iowait: v[4] };
  } catch { return { total: 0, idle: 0, iowait: 0 }; }
}
function netBytes(): number {
  try {
    return readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).reduce((n, l) => {
      const [name, rest] = l.split(":"); if (!rest || name.trim() === "lo") return n;
      const f = rest.trim().split(/\s+/).map(Number); return n + (f[0] || 0) + (f[8] || 0);
    }, 0);
  } catch { return 0; }
}
function memFreePct(): number | undefined {
  try {
    const t = readFileSync("/proc/meminfo", "utf8");
    const g = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(t)?.[1]);
    return (100 * g("MemAvailable")) / g("MemTotal");
  } catch { return undefined; }
}
function diskUsedPct(path: string): number | undefined {
  try { const s = statfsSync(path); return 100 * (1 - s.bavail / s.blocks); } catch { return undefined; }
}
function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((res) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 2_000_000 }, (err, out) => res(err ? "" : String(out))));
}

const ERR_RE = /\b(error|failed|failure|fatal|exception|traceback|panic|refused|timed? ?out|no space left|oomkilled|out of memory|killed|denied|unauthorized|forbidden|too many requests|rate limit|429|50[234]\b|unreachable|could not resolve|temporary failure)/i;
const STEP_RE = /^#(\d+) \[(?:[^\]]*? )?(\d+)\/(\d+)\] (.+)$/;

type Container = { name: string; state: string; status: string; cpu?: string; mem?: string };
export type Health = {
  at: number;
  elapsedMs: number;
  logBytes: number;
  lastOutputAt: number;
  lastLine: string;
  step?: { k: number; n: number; text: string; since: number };
  procs: number;
  names: string[];
  dState: number;
  jobCpu?: number;           // % of one core, averaged over the last minute
  jobIo?: number;            // bytes/s the job's processes read or write (files, pipes, sockets)
  dockerish: boolean;
  sysCpu?: number;           // % of all cores
  iowait?: number;
  cores: number;
  load: number;
  memFree?: number;
  disk?: number;
  dockerDisk?: number;
  netRate?: number;          // bytes/s, last minute
  errorsRecent: number;      // error-like lines in the last 2 minutes
  lastError?: string;
  repeating?: string;
  containers: Container[];
};

type Point = { at: number; ticks: number; io: number; cpu: { total: number; idle: number; iowait: number }; net: number };

/** Keeps the history for one job; call sample() every few seconds. */
export class HealthSampler {
  job: JobMeta;
  points: Point[] = [];
  offset = 0;
  errors: { at: number; line: string }[] = [];
  step?: { k: number; n: number; text: string; since: number };
  lastDocker = 0;
  containers: Container[] = [];
  latest?: Health;
  constructor(job: JobMeta) { this.job = job; }

  async sample(): Promise<Health> {
    const m = this.job, now = Date.now();
    let size = 0, mtime = m.created;
    try { const st = statSync(logFile(m.id)); size = st.size; mtime = st.mtimeMs; } catch {}
    // New output: count error-like lines and follow build steps.
    if (size > this.offset) {
      const chunk = readFrom(logFile(m.id), Math.max(this.offset, size - 1_000_000)).toString("utf8");
      this.offset = size;
      for (const line of chunk.split("\n")) {
        const l = line.trim(); if (!l) continue;
        if (ERR_RE.test(l)) this.errors.push({ at: now, line: l.slice(0, 200) });
        const s = STEP_RE.exec(l);
        if (s && (!this.step || this.step.k !== +s[2] || this.step.n !== +s[3])) this.step = { k: +s[2], n: +s[3], text: s[4].slice(0, 100), since: now };
      }
      this.errors = this.errors.slice(-200);
    }
    this.errors = this.errors.filter((e) => now - e.at < 120_000);
    const tail = readTail(logFile(m.id), 16_000).split("\n").map((l) => l.trim()).filter(Boolean);
    const last40 = tail.slice(-40), norm = new Set(last40.map((l) => l.replace(/[\d.:]+/g, "#")));
    const procs = m.pid ? tree(m.pid) : [];
    this.points.push({ at: now, ticks: procs.reduce((n, p) => n + p.ticks, 0), io: procs.reduce((n, p) => n + procIo(p.pid), 0), cpu: systemCpu(), net: netBytes() });
    this.points = this.points.filter((p) => now - p.at <= 70_000);
    // Rates over the last 30 s: long enough to smooth, short enough to notice a job going quiet.
    const b = this.points[this.points.length - 1], a = this.points.find((p) => b.at - p.at <= 30_000) || b, dt = (b.at - a.at) / 1000;
    const dTotal = b.cpu.total - a.cpu.total;
    // Docker: containers started by this job (or restarting), every 30 s at most.
    const dockerish = /docker|podman|compose/.test(m.command) || procs.some((p) => /docker|compose|buildx/.test(p.comm));
    if (dockerish && now - this.lastDocker > 30_000) {
      this.lastDocker = now;
      const rows = (await run("docker", ["ps", "-a", "--format", "{{json .}}"], 6000)).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const since = m.created - 5000;
      const mine = rows.filter((r: any) => Date.parse(String(r.CreatedAt).replace(/ ([+-]\d{2})(\d{2}) \S+$/, "$1:$2").replace(" ", "T")) >= since || /restarting/i.test(r.State)).slice(0, 8);
      const stats = mine.some((r: any) => r.State === "running")
        ? Object.fromEntries((await run("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...mine.filter((r: any) => r.State === "running").map((r: any) => r.Names)], 12000)).split("\n").filter(Boolean).map((l) => { try { const j = JSON.parse(l); return [j.Name, j]; } catch { return [null, null]; } }))
        : {};
      this.containers = mine.map((r: any) => ({ name: r.Names, state: r.State, status: r.Status, cpu: stats[r.Names]?.CPUPerc, mem: stats[r.Names]?.MemUsage?.split(" / ")[0] }));
    }
    this.latest = {
      at: now,
      elapsedMs: now - m.created,
      logBytes: size,
      lastOutputAt: size > 0 ? mtime : m.created,
      lastLine: (tail[tail.length - 1] || "").slice(0, 160),
      step: this.step,
      procs: procs.length,
      names: [...new Set(procs.map((p) => p.comm))].slice(0, 6),
      dState: procs.filter((p) => p.state === "D").length,
      jobCpu: dt >= 4 ? (100 * (b.ticks - a.ticks)) / 100 / dt : undefined,
      jobIo: dt >= 4 ? Math.max(0, b.io - a.io) / dt : undefined,
      dockerish,
      sysCpu: dTotal > 0 ? 100 * (1 - (b.cpu.idle - a.cpu.idle) / dTotal) : undefined,
      iowait: dTotal > 0 ? (100 * (b.cpu.iowait - a.cpu.iowait)) / dTotal : undefined,
      cores: cpus().length,
      load: loadavg()[0],
      memFree: memFreePct(),
      disk: diskUsedPct(m.cwd),
      dockerDisk: dockerish ? diskUsedPct("/var/lib/docker") : undefined,
      netRate: dt >= 4 ? (b.net - a.net) / dt : undefined,
      errorsRecent: this.errors.length,
      lastError: this.errors[this.errors.length - 1]?.line,
      repeating: last40.length >= 20 && norm.size <= 3 ? last40[last40.length - 1].slice(0, 160) : undefined,
      containers: this.containers,
    };
    return this.latest;
  }
}

export type Finding = { key: string; level: "watch" | "warn"; text: string };
export type Assessment = { verdict: string; level: "ok" | "watch" | "warn"; findings: Finding[]; stuck: boolean; hints: string[] };

const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s` : `${Math.floor(ms / 3600_000)}h${String(Math.round((ms % 3600_000) / 60_000)).padStart(2, "0")}m`);
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const rate = (b?: number) => (b === undefined ? "?" : b < 1024 ? `${Math.round(b)} B/s` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB/s` : `${(b / 1024 / 1024).toFixed(1)} MB/s`);
export const ago = mins;

/** Plain-language read of a job's health. `quietMs`: how long without output counts as quiet. */
export function assess(m: JobMeta, h: Health, quietMs = 5 * 60_000): Assessment {
  const f: Finding[] = [], hints: string[] = [];
  const quiet = h.at - h.lastOutputAt;
  const dockerCpu = h.containers.reduce((n, c) => n + (parseFloat(c.cpu || "0") || 0), 0);
  const busyCpu = (h.jobCpu ?? 0) > 5 || dockerCpu > 5;
  // Only the job's own signs of life count: machine-wide numbers move for unrelated reasons.
  const busyIo = (h.jobIo ?? 0) > 10 * 1024;
  const busyDisk = h.dState > 0;
  const active = busyCpu || busyIo || busyDisk;
  // A docker build works inside the daemon, not in this job's processes: a busy machine may be the build.
  const machineBusy = h.dockerish && ((h.netRate ?? 0) > 50 * 1024 || (h.sysCpu ?? 0) > 20);
  const docker = h.containers.length > 0 || /docker|compose/.test(m.command);
  if (h.errorsRecent >= 3) f.push({ key: "errors", level: "warn", text: `${h.errorsRecent} error-like lines in the last 2 minutes; latest: ${h.lastError}` });
  if (h.repeating) f.push({ key: "repeat", level: "warn", text: `the same line keeps repeating (a retry loop?): ${h.repeating}` });
  for (const c of h.containers) {
    if (/restarting/i.test(c.state) || /restarting/i.test(c.status)) f.push({ key: `restart:${c.name}`, level: "warn", text: `container ${c.name} keeps restarting (${c.status})` });
    else if (/unhealthy/i.test(c.status)) f.push({ key: `unhealthy:${c.name}`, level: "warn", text: `container ${c.name} is unhealthy (${c.status})` });
    else if (c.state === "exited" && !/Exited \(0\)/.test(c.status)) f.push({ key: `exited:${c.name}`, level: "warn", text: `container ${c.name} exited: ${c.status}` });
  }
  if ((h.disk ?? 0) >= 95 || (h.dockerDisk ?? 0) >= 95) f.push({ key: "disk", level: "warn", text: `disk nearly full (${Math.round(Math.max(h.disk ?? 0, h.dockerDisk ?? 0))}% used)` });
  if (h.memFree !== undefined && h.memFree < 5) f.push({ key: "memory", level: "warn", text: `memory almost exhausted (${h.memFree.toFixed(1)}% free): swapping or OOM kills are likely` });
  const stuck = quiet >= quietMs && !active && !machineBusy && h.elapsedMs >= quietMs;
  if (stuck) f.push({ key: "stuck", level: "warn", text: `no output for ${mins(quiet)} and nothing is using CPU, disk or network${h.step ? ` (on build step ${h.step.k}/${h.step.n}: ${h.step.text})` : ""}` });
  else if (quiet >= quietMs && active) f.push({ key: "quiet", level: "watch", text: `no output for ${mins(quiet)}, but it is working (${[busyCpu && `CPU ${Math.round((h.jobCpu ?? 0) + dockerCpu)}%`, busyIo && `I/O ${rate(h.jobIo)}`, busyDisk && `${h.dState} process(es) waiting on disk`].filter(Boolean).join(", ")})` });
  else if (quiet >= quietMs) f.push({ key: "quiet", level: "watch", text: `no output for ${mins(quiet)}; its own processes are idle, but the machine is busy (CPU ${Math.round(h.sysCpu ?? 0)}%, network ${rate(h.netRate)}), which may be the docker build` });
  const downloading = /download|pull|fetch|install|clone|resolv|collecting/i.test(`${h.step?.text || ""} ${h.lastLine}`) || h.names.some((n) => /^(pip|npm|pnpm|yarn|apt|apt-get|curl|wget|git|cargo|go|mvn|gradle)/.test(n));
  if (downloading && h.netRate !== undefined && h.netRate > 0 && h.netRate < 100 * 1024 && !busyCpu) f.push({ key: "slownet", level: "watch", text: `downloading slowly: ${rate(h.netRate)}` });
  if (h.step && h.at - h.step.since >= 10 * 60_000) f.push({ key: `step:${h.step.k}`, level: "watch", text: `on build step ${h.step.k}/${h.step.n} for ${mins(h.at - h.step.since)}: ${h.step.text}` });
  if (m.expectMin && h.elapsedMs > 1.5 * m.expectMin * 60_000) f.push({ key: "overdue", level: "warn", text: `running ${mins(h.elapsedMs)}, expected about ${m.expectMin}m` });

  const keys = new Set(f.map((x) => x.key.split(":")[0]));
  if (keys.has("stuck")) {
    hints.push(`see what each process is doing: ps -o pid,stat,etime,pcpu,rss,args -s ${m.pid} (state D waits on disk; S with 0% CPU waits on network, a lock or input)`);
    if (docker) hints.push("docker ps -a; docker logs --tail 50 <container>; docker stats --no-stream; for builds, re-run with --progress=plain to see the step's output");
    hints.push("if it waits on the network: check DNS, proxy and the registry/package index (curl -sSI <url>)");
  }
  if (keys.has("errors") || keys.has("repeat")) hints.push(`read the errors: redpi_job logs ${m.id} with grep "error|fail|refused|timeout"`);
  if (keys.has("restart") || keys.has("unhealthy") || keys.has("exited")) hints.push("docker logs --tail 80 <container>; docker inspect --format '{{json .State}}' <container>");
  if (keys.has("disk")) hints.push("df -h; docker system df (docker builder prune frees build cache, only if you decide to)");
  if (keys.has("memory")) hints.push("free -m; dmesg | tail -20 (OOM killer); docker stats --no-stream");
  if (keys.has("slownet")) hints.push("measure the link (curl -o /dev/null -w '%{speed_download}' <mirror>) and consider a closer mirror or cache");

  const level = f.some((x) => x.level === "warn") ? "warn" : f.length ? "watch" : "ok";
  const verdict = keys.has("stuck") ? "looks stuck"
    : keys.has("errors") || keys.has("repeat") || keys.has("restart") || keys.has("exited") || keys.has("unhealthy") ? "running, with problems"
    : keys.has("overdue") ? "slower than expected"
    : keys.has("slownet") ? "slow download"
    : keys.has("quiet") ? "busy but quiet"
    : h.elapsedMs < 30_000 ? "starting" : "progressing";
  return { verdict, level, findings: f, stuck, hints };
}

export function oneLine(m: JobMeta, h?: Health, a?: Assessment): string {
  const cmd = m.command.split("\n")[0].replace(/\s+/g, " ").slice(0, 40);
  if (m.state !== "running") return `${m.id} ${m.state}${m.exitCode != null ? ` (${m.exitCode})` : ""} · ${cmd}`;
  const bits = [`${m.id} ${cmd} ${mins(Date.now() - m.created)}`];
  if (h?.step) bits.push(`step ${h.step.k}/${h.step.n}`);
  if (h && h.at - h.lastOutputAt >= 60_000) bits.push(`quiet ${mins(h.at - h.lastOutputAt)}`);
  if (a && a.level !== "ok") bits.push(`${a.level === "warn" ? "⚠ " : ""}${a.verdict}`);
  return bits.join(" · ");
}

/** The full health report an agent (or a person) reads. */
export function report(m: JobMeta, h?: Health, a?: Assessment): string {
  const cmd = m.command.split("\n")[0].slice(0, 160) + (m.command.includes("\n") || m.command.length > 160 ? " …" : "");
  const lines = [`Job ${m.id} · \`${cmd}\``];
  if (m.state !== "running") {
    lines.push(`State: ${m.state === "exited" ? `finished with exit code ${m.exitCode}` : m.state === "stopped" ? `stopped${m.stopReason ? ` (${m.stopReason})` : ""}` : "gone without an exit code (killed from outside, or the machine restarted)"} after ${mins((m.ended || Date.now()) - m.created)}.`);
    return lines.join("\n");
  }
  lines.push(`State: running for ${mins(Date.now() - m.created)}${m.detachedAt ? ` (in the background since ${mins(m.detachedAt - m.created)})` : ""}${m.expectMin ? `, expected about ${m.expectMin}m` : ""}.`);
  if (!h || !a) return lines.join("\n");
  lines.push(`Verdict: ${a.verdict}.`);
  for (const x of a.findings) lines.push(`${x.level === "warn" ? "⚠" : "•"} ${x.text}`);
  lines.push(`Output: ${h.logBytes ? `${size(h.logBytes)}, last line ${mins(h.at - h.lastOutputAt)} ago: ${h.lastLine || "(blank)"}` : "none yet"}${h.step ? ` · build step ${h.step.k}/${h.step.n} for ${mins(h.at - h.step.since)}` : ""}`);
  lines.push(`Processes: ${h.procs}${h.names.length ? ` (${h.names.join(", ")})` : ""} · job CPU ${h.jobCpu === undefined ? "?" : `${Math.round(h.jobCpu)}%`} · job I/O ${rate(h.jobIo)}${h.dState ? ` · ${h.dState} waiting on disk` : ""}`);
  lines.push(`Machine: CPU ${h.sysCpu === undefined ? "?" : `${Math.round(h.sysCpu)}%`} of ${h.cores} cores · iowait ${h.iowait === undefined ? "?" : `${Math.round(h.iowait)}%`} · load ${h.load.toFixed(1)} · memory ${h.memFree === undefined ? "?" : `${Math.round(h.memFree)}% free`} · disk ${h.disk === undefined ? "?" : `${Math.round(h.disk)}% used`}${h.dockerDisk !== undefined ? ` (docker ${Math.round(h.dockerDisk)}%)` : ""} · network ${rate(h.netRate)}`);
  if (h.containers.length) lines.push(`Docker: ${h.containers.map((c) => `${c.name} ${c.status}${c.cpu ? `, CPU ${c.cpu}` : ""}${c.mem ? `, ${c.mem}` : ""}`).join(" · ")}`);
  if (a.hints.length) lines.push(`Check next: ${a.hints.join(" | ")}`);
  return lines.join("\n");
}
