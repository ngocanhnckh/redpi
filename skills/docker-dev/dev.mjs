#!/usr/bin/env node
// redpi-dev: run a project's services in Docker for development, with the code bind-mounted for
// hot reload and every process inside a container with a memory, CPU and process limit. Stopping,
// restarting and watching a service is then one compose command, never a hunt for host PIDs.
//
//   redpi-dev init [--port N] [--mem 1g] [--cpus 2] [--image IMG] [--cmd "..."] [--force]
//   redpi-dev up [service...]            start (or update) and wait until the port answers
//   redpi-dev status                     state, URL, memory/CPU against the limits, OOM kills
//   redpi-dev logs [service] [--tail N] [--since 10m]
//   redpi-dev restart [service...] | down [-v] | exec <service> -- <cmd...>
//   redpi-dev ls                         every RedPi dev stack on this machine
//
// Options for every command: --file <compose file>, --project <name>.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEV_FILES = ["compose.dev.yaml", "compose.dev.yml", "docker-compose.dev.yaml", "docker-compose.dev.yml"];
const OTHER_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "yitec", "dev");

function parse(argv) {
  const opts = { tail: 150 }; const args = []; let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest = argv.slice(i + 1); break; }
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) { args.push(a); continue; }
    const flag = ["force", "volumes", "all", "no-wait", "public"].includes(m[1]);
    opts[m[1]] = flag ? true : (m[2] ?? argv[++i]);
  }
  if (argv.includes("-v")) { opts.volumes = true; args.splice(args.indexOf("-v"), 1); }
  return { cmd: args.shift(), args, opts, rest: rest || [] };
}

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
// Nothing reads the terminal: compose `run` would otherwise attach to stdin and wait on it.
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...o });

function dockerOk() {
  const r = sh("docker", ["compose", "version", "--short"]);
  if (r.error) die("Docker is not installed. Install Docker Engine with the compose plugin, or run the service directly and say so.", 3);
  if (r.status !== 0) die(`docker compose is not available: ${(r.stderr || "").trim().slice(0, 300)}`, 3);
  const info = sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) die(`The Docker daemon is not reachable: ${(info.stderr || "").trim().slice(0, 300)}\nStart Docker, or check that this user may use it (docker group).`, 3);
}

function gitRoot(dir) {
  const r = sh("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() : "";
}

// The dev compose file: --file, else the nearest compose.dev.yaml up to the git root.
function findFile(opts, { quiet = false } = {}) {
  if (opts.file) { const f = resolve(opts.file); if (!existsSync(f)) die(`No such file: ${f}`); return f; }
  const stop = gitRoot(process.cwd());
  for (let d = process.cwd(); ; d = dirname(d)) {
    for (const n of DEV_FILES) if (existsSync(join(d, n))) return join(d, n);
    if (d === stop || d === dirname(d)) break;
  }
  if (quiet) return "";
  const other = OTHER_FILES.map((n) => join(process.cwd(), n)).find(existsSync);
  die(`No compose.dev.yaml here. Run \`redpi-dev init\` to create one.${other ? `\nThis project has ${basename(other)}: if that is its dev setup, use it with --file ${basename(other)}.` : ""}`);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
// One stack per folder and per RedPlan worker, so teammates never share or stop each other's.
function projectName(file, opts) {
  if (opts.project) return slug(opts.project);
  if (process.env.COMPOSE_PROJECT_NAME) return slug(process.env.COMPOSE_PROJECT_NAME);
  const who = process.env.REDPI_HQ_NAME || process.env.REDPI_HQ_WORKER;
  const worker = who ? `-${who}` : "";
  return slug(`redpi-${basename(dirname(file))}${worker}`);
}

function compose(ctx, args, o = {}) {
  return sh("docker", ["compose", "-p", ctx.project, "-f", ctx.file, ...args], { cwd: dirname(ctx.file), env: ctx.env, ...o });
}

const statePath = (project) => join(STATE_DIR, `${project}.json`);
const readJson = (f, d = {}) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "0.0.0.0", () => s.close(() => res(true)));
  });
}
async function freePort() {
  return new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function published(ctx) {
  const out = new Set();
  for (const c of psJson(ctx)) for (const p of c.Publishers || []) if (p.PublishedPort) out.add(p.PublishedPort);
  return out;
}

// Host ports come from ${DEV_PORT...:-N} in the file. Keep the port a stack already has, else
// take N when it is free, else any free port, so parallel stacks never collide.
async function portEnv(ctx) {
  const text = readFileSync(ctx.file, "utf8");
  const saved = readJson(statePath(ctx.project)).ports || {};
  const ours = published(ctx);
  const env = {};
  for (const [, name, def] of text.matchAll(/\$\{(DEV_PORT\w*):-(\d+)\}/g)) {
    if (env[name] || process.env[name]) continue;
    const want = [saved[name], Number(def)].filter(Boolean);
    let port = 0;
    for (const p of want) if (ours.has(p) || await portFree(p)) { port = p; break; }
    env[name] = String(port || await freePort());
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(ctx.project), JSON.stringify({ file: ctx.file, ports: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, Number(v)])) }, null, 2));
  return env;
}

function context(opts, { quiet = false } = {}) {
  const file = findFile(opts, { quiet });
  if (!file) return null;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const ctx = { file, project: projectName(file, opts) };
  ctx.env = { ...process.env, REDPI_UID: String(uid), REDPI_GID: String(gid), COMPOSE_PROJECT_NAME: ctx.project };
  return ctx;
}

function psJson(ctx, all = true) {
  const r = compose(ctx, ["ps", ...(all ? ["-a"] : []), "--format", "json"]);
  if (r.status !== 0) return [];
  const t = r.stdout.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Containers run as the host user so files they write in the mounted code stay editable.
// A new named volume is owned by root, so hand it to that user once before the first start.
function prepareVolumes(ctx) {
  const cfg = compose(ctx, ["config", "--format", "json"]);
  if (cfg.status !== 0) die(`The compose file is not valid:\n${cfg.stderr.trim().slice(0, 2000)}`);
  const conf = JSON.parse(cfg.stdout);
  for (const [name, svc] of Object.entries(conf.services || {})) {
    // A volume inside the mounted code (node_modules) needs its folder to exist first, or
    // Docker creates it on the host as root.
    for (const b of (svc.volumes || []).filter((v) => v.type === "bind" && v.source)) {
      for (const v of (svc.volumes || []).filter((x) => x.type === "volume" && x.target?.startsWith(`${b.target}/`))) {
        try { mkdirSync(join(b.source, v.target.slice(b.target.length + 1)), { recursive: true }); } catch {}
      }
    }
    if (!svc.user || /^0(:|$)|^root/.test(svc.user)) continue;
    const vols = (svc.volumes || []).filter((v) => v.type === "volume" && v.source);
    const fresh = vols.filter((v) => sh("docker", ["volume", "inspect", `${ctx.project}_${v.source}`]).status !== 0);
    if (!fresh.length) continue;
    const dirs = fresh.map((v) => v.target);
    const r = compose(ctx, ["run", "--rm", "-T", "--no-deps", "--user", "0", "--entrypoint", "sh", name, "-c", `mkdir -p ${dirs.join(" ")} && chown ${svc.user} ${dirs.join(" ")}`]);
    if (r.status !== 0) console.error(`note: could not prepare volumes for ${name}: ${(r.stderr || "").trim().slice(0, 300)}`);
  }
  return conf;
}

const human = (b) => { const u = ["B", "KiB", "MiB", "GiB"]; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${b.toFixed(i ? 1 : 0).replace(/\.0$/, "")}${u[i]}`; };

function statusText(ctx) {
  const rows = psJson(ctx);
  if (!rows.length) return `${ctx.project}: nothing running (file ${ctx.file}). Start it with \`redpi-dev up\`.`;
  const ids = rows.map((r) => r.ID);
  const stats = {};
  const running = rows.filter((r) => r.State === "running").map((r) => r.ID);
  if (running.length) {
    const s = sh("docker", ["stats", "--no-stream", "--format", "{{json .}}", ...running]);
    for (const l of (s.stdout || "").split("\n").filter(Boolean)) { const j = JSON.parse(l); stats[j.ID.slice(0, 12)] = j; }
  }
  const insp = {};
  const ir = sh("docker", ["inspect", ...ids]);
  for (const c of ir.status === 0 ? JSON.parse(ir.stdout) : []) insp[c.Id.slice(0, 12)] = c;
  const lines = [`${ctx.project} (${ctx.file})`];
  for (const r of rows) {
    const id = r.ID.slice(0, 12); const st = stats[id]; const c = insp[id] || {};
    const limit = c.HostConfig?.Memory ? human(c.HostConfig.Memory) : "no limit";
    const urls = [...new Set((r.Publishers || []).filter((p) => p.PublishedPort).map((p) => `http://${p.URL && p.URL !== "0.0.0.0" && p.URL !== "::" ? p.URL : "localhost"}:${p.PublishedPort}`))];
    const state = r.Health ? `${r.State} (${r.Health})` : r.State;
    let line = `- ${r.Service}: ${state}${urls.length ? `  ${urls.join(" ")}` : ""}`;
    if (st) line += `  mem ${st.MemUsage.split(" / ")[0]} of ${limit} (${st.MemPerc})  cpu ${st.CPUPerc}${c.HostConfig?.NanoCpus ? ` of ${c.HostConfig.NanoCpus / 1e9} cores` : ""}  pids ${st.PIDs}`;
    else line += `  limit ${limit}`;
    if (c.RestartCount) line += `  restarts ${c.RestartCount}`;
    if (c.State?.OOMKilled) line += `\n  OUT OF MEMORY: ${r.State === "running" ? "a process in it was killed at" : "it was killed at"} the ${limit} limit. Raise mem_limit for ${r.Service} in ${basename(ctx.file)} (about 1.5x what it needs), then \`redpi-dev up\`.`;
    else if (r.State === "exited") line += `  exit ${c.State?.ExitCode ?? r.ExitCode}: see \`redpi-dev logs ${r.Service}\``;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---- init: write compose.dev.yaml for the stack found in this folder ----
function detect(dir, opts) {
  const has = (f) => existsSync(join(dir, f));
  const read = (f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } };
  if (has("package.json")) {
    const pkg = readJson(join(dir, "package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
    const script = ["dev", "start", "serve"].find((s) => pkg.scripts?.[s]);
    const body = script ? pkg.scripts[script] : "";
    const scriptPort = Number((/(?:--port[= ]|-p )(\d{2,5})/.exec(body) || [])[1]) || 0;
    let port = 3000, flags = "", mem = "768m", kind = "Node service";
    if (deps.next) { kind = "Next.js dev server"; port = 3000; flags = " --hostname 0.0.0.0"; mem = "2g"; }
    else if (deps.astro) { kind = "Astro dev server"; port = 4321; flags = " --host 0.0.0.0"; mem = "1g"; }
    else if (deps.nuxt) { kind = "Nuxt dev server"; port = 3000; flags = " --host 0.0.0.0"; mem = "1536m"; }
    else if (deps.vite || /\bvite\b/.test(body)) { kind = "Vite dev server"; port = 5173; flags = " --host 0.0.0.0"; mem = "1g"; }
    else if (deps["@angular/core"]) { kind = "Angular dev server"; port = 4200; flags = " --host 0.0.0.0"; mem = "1536m"; }
    if (scriptPort) { port = scriptPort; flags = flags.replace(/ --port \d+/, ""); }
    if (flags && !scriptPort) flags += ` --port ${port}`;
    const nodeMajor = (/(\d{2})/.exec(read(".nvmrc") || pkg.engines?.node || "") || [])[1] || "22";
    const image = pm === "bun" ? "oven/bun:1-debian" : `node:${nodeMajor}-bookworm-slim`;
    const install = { npm: "npm install --no-audit --no-fund", pnpm: "corepack enable --install-directory /tmp/bin && PATH=/tmp/bin:$$PATH pnpm install", yarn: "corepack enable --install-directory /tmp/bin && PATH=/tmp/bin:$$PATH yarn install", bun: "bun install" }[pm];
    const pmBin = pm === "npm" || pm === "bun" ? pm : `PATH=/tmp/bin:$$PATH ${pm}`;
    const run = script ? `${pmBin} run ${script}${flags ? `${pm === "npm" ? " --" : ""}${flags}` : ""}` : "";
    // Reinstall only when the manifest or lock file changed since the last start.
    const lock = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].filter(has);
    const cmd = run && `h=$$(cat ${lock.join(" ")} | sha1sum); [ \"$$(cat node_modules/.redpi-installed 2>/dev/null)\" = \"$$h\" ] || { ${install} && echo \"$$h\" > node_modules/.redpi-installed; }; exec ${run}`;
    return { kind, image, port, mem, cpus: mem === "2g" ? "2" : "1.5", cmd, workdir: "/app", volumes: [["deps", "/app/node_modules"]], env: { HOST: "0.0.0.0", PORT: String(port), HOME: "/tmp", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" } };
  }
  const pyproject = read("pyproject.toml"); const reqs = read("requirements.txt");
  if (pyproject || reqs || has("manage.py")) {
    const text = `${pyproject}\n${reqs}`.toLowerCase();
    const uv = has("uv.lock");
    const py = uv ? "uv run" : "/venv/bin/python -m";
    let kind = "Python service", port = 8000, run = "";
    if (has("manage.py")) { kind = "Django dev server"; run = `${uv ? "uv run python" : "/venv/bin/python"} manage.py runserver 0.0.0.0:8000`; }
    else if (/fastapi|starlette|uvicorn/.test(text)) {
      const mod = ["app/main.py", "src/main.py", "main.py", "app.py", "api/main.py"].find(has);
      kind = "FastAPI (uvicorn --reload)"; run = mod ? `${py} uvicorn ${mod.replace(/\.py$/, "").replace(/\//g, ".")}:app --reload --host 0.0.0.0 --port 8000` : "";
    } else if (/flask/.test(text)) {
      const mod = ["app.py", "wsgi.py", "app/__init__.py"].find(has);
      kind = "Flask dev server"; port = 5000; run = `${py} flask${mod ? ` --app ${mod.replace(/\/__init__\.py$|\.py$/, "")}` : ""} run --debug --host 0.0.0.0 --port 5000`;
    }
    const install = uv ? "uv sync" : reqs ? "/venv/bin/pip install -q -r requirements.txt" : "/venv/bin/pip install -q -e .";
    const lock = ["uv.lock", "requirements.txt", "pyproject.toml"].filter(has);
    const setup = uv ? "" : "[ -x /venv/bin/python ] || python -m venv /venv; ";
    const cmd = run && `${setup}h=$$(cat ${lock.join(" ")} | sha1sum); [ \"$$(cat /venv/.redpi-installed 2>/dev/null)\" = \"$$h\" ] || { ${install} && echo \"$$h\" > /venv/.redpi-installed; }; exec ${run}`;
    return { kind, image: uv ? "ghcr.io/astral-sh/uv:python3.12-bookworm-slim" : "python:3.12-slim-bookworm", port, mem: "768m", cpus: "1.5", cmd, workdir: "/app", volumes: [["venv", "/venv"]], env: { HOME: "/tmp", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", ...(uv ? { UV_PROJECT_ENVIRONMENT: "/venv", UV_LINK_MODE: "copy", UV_CACHE_DIR: "/tmp/uv-cache" } : {}) } };
  }
  if (has("go.mod")) {
    const v = (/^go (\d+\.\d+)/m.exec(read("go.mod")) || [])[1] || "1.23";
    return { kind: "Go service (restart after edits, or use air for reload)", image: `golang:${v}-bookworm`, port: 8080, mem: "1g", cpus: "2", cmd: "exec go run .", workdir: "/app", volumes: [["gocache", "/tmp/go"]], env: { HOME: "/tmp", GOPATH: "/tmp/go", GOCACHE: "/tmp/go/cache", PORT: "8080" } };
  }
  return { kind: "unknown stack", image: opts.image || "", port: 8080, mem: "1g", cpus: "1.5", cmd: "", workdir: "/app", volumes: [], env: { HOME: "/tmp" } };
}

const q = (s) => JSON.stringify(String(s));
function initFile(opts) {
  const dir = process.cwd();
  const out = join(dir, "compose.dev.yaml");
  const existing = findFile(opts, { quiet: true });
  if (existing && !opts.force) die(`${existing} already exists: use it (\`redpi-dev up\`), edit it, or pass --force to replace it.`);
  const d = detect(dir, opts);
  const port = Number(opts.port || d.port);
  const image = opts.image || d.image;
  const cmd = opts.cmd ? `exec ${opts.cmd}` : d.cmd;
  if (!image) die("Could not tell what this project is. Pass --image <image> --cmd \"<start command>\" --port <port>.");
  const mem = opts.mem || d.mem; const cpus = opts.cpus || d.cpus;
  const svc = slug(opts.service || "app");
  const env = { ...d.env, ...(d.env.PORT ? { PORT: String(port) } : {}) };
  const bind = opts.public ? "" : "127.0.0.1:";
  const lines = [
    "# Dev stack made by redpi-dev (RedPi docker-dev skill). The code is bind-mounted for hot reload;",
    "# everything runs inside the container with the limits below. Size the limits to the service:",
    "# `redpi-dev status` shows use against the limit and flags OOM kills.",
    "# Run it with: redpi-dev up | status | logs | restart | down",
    "services:",
    `  ${svc}:`,
    `    image: ${image}`,
    `    working_dir: ${d.workdir}`,
    ...(cmd ? [`    command: ["sh", "-c", ${q(cmd)}]`] : ["    # TODO: the start command, e.g. command: [\"sh\", \"-c\", \"exec npm run dev\"]", "    command: [\"sleep\", \"infinity\"]"]),
    "    user: \"${REDPI_UID:-1000}:${REDPI_GID:-1000}\"",
    "    init: true               # reaps child processes (no zombies) and forwards stop signals",
    `    mem_limit: ${mem}             # hard memory cap; the kernel kills the container above it`,
    `    memswap_limit: ${mem}`,
    `    cpus: ${cpus}`,
    "    pids_limit: 512",
    "    stop_grace_period: 5s",
    "    restart: \"no\"",
    "    ports:",
    `      - "${bind}\${DEV_PORT:-${port}}:${port}"`,
    "    volumes:",
    `      - .:${d.workdir}`,
    ...d.volumes.map(([n, p]) => `      - ${n}:${p}`),
    ...(existsSync(join(dir, ".env")) ? ["    env_file:", "      - path: .env", "        required: false"] : []),
    "    environment:",
    ...Object.entries(env).map(([k, v]) => `      ${k}: ${q(v)}`),
    "    labels:",
    "      redpi.dev: \"1\"",
    "    healthcheck:             # healthy once the port accepts connections",
    `      test: ["CMD", "bash", "-c", "</dev/tcp/127.0.0.1/${port}"]`,
    "      interval: 10s",
    "      timeout: 3s",
    "      retries: 3",
    "      start_period: 10m",
    "      start_interval: 1s",
  ];
  if (d.volumes.length) lines.push("volumes:", ...d.volumes.map(([n]) => `  ${n}:`));
  writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`Wrote ${out}\nstack: ${d.kind}; image ${image}; port ${port}; limits ${mem} memory, ${cpus} CPUs.`);
  if (!cmd) console.log("Set the start command in the file (it runs `sleep infinity` until you do), then `redpi-dev up`.");
  console.log("Adjust mem_limit to what this service needs; add databases or other services to the same file with their own limits.");
}

async function main() {
  const { cmd, args, opts, rest } = parse(process.argv.slice(2));
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (cmd === "init") return initFile(opts);
  dockerOk();
  if (cmd === "ls") {
    const r = sh("docker", ["ps", "-a", "--filter", "label=redpi.dev=1", "--format", "{{.Label \"com.docker.compose.project\"}}\t{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.RunningFor}}\t{{.Ports}}"]);
    const rows = (r.stdout || "").trim();
    console.log(rows ? `project\tservice\tstate\tage\tports\n${rows}\nStop one with: redpi-dev down --project <project>` : "No RedPi dev stacks.");
    return;
  }
  const ctx = cmd === "down" && opts.project ? { project: slug(opts.project), file: readJson(statePath(slug(opts.project))).file || "" } : context(opts);
  if (cmd === "down" && ctx.file && !existsSync(ctx.file)) ctx.file = "";
  ctx.env ||= { ...process.env };
  switch (cmd) {
    case "up": {
      Object.assign(ctx.env, await portEnv(ctx));
      prepareVolumes(ctx);
      const wait = opts["no-wait"] ? [] : ["--wait", "--wait-timeout", String(opts.timeout || 600)];
      const r = compose(ctx, ["up", "-d", "--remove-orphans", ...wait, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      if (r.status !== 0) {
        console.log(`up failed (exit ${r.status}):\n${(r.stderr || r.stdout).trim().split("\n").slice(-15).join("\n")}\n`);
        console.log(statusText(ctx));
        const logs = compose(ctx, ["logs", "--no-color", "--tail", "40", ...args]);
        console.log(`\nlast logs:\n${(logs.stdout || "").trim()}`);
        process.exitCode = 1;
        return;
      }
      console.log(`ready: ${ctx.project} is up\n${statusText(ctx)}`);
      return;
    }
    case "status": case "ps": console.log(statusText(ctx)); return;
    case "logs": {
      const r = compose(ctx, ["logs", "--no-color", "--tail", String(opts.tail), ...(opts.since ? ["--since", opts.since] : []), ...args]);
      console.log((r.stdout || "").trim() || "(no logs)");
      if (r.status !== 0) console.error(r.stderr.trim());
      return;
    }
    case "restart": {
      const r = compose(ctx, ["restart", ...args], { stdio: ["ignore", "inherit", "inherit"] });
      if (r.status === 0) console.log(statusText(ctx)); else process.exitCode = r.status;
      return;
    }
    case "down": {
      const r = ctx.file
        ? compose(ctx, ["down", "--remove-orphans", "--timeout", "5", ...(opts.volumes ? ["-v"] : [])])
        : sh("docker", ["compose", "-p", ctx.project, "down", "--remove-orphans", "--timeout", "5", ...(opts.volumes ? ["-v"] : [])], { env: ctx.env });
      if (r.status === 0) console.log(`${ctx.project} stopped and removed${opts.volumes ? " (with its volumes)" : ""}.`);
      else { console.error((r.stderr || "").trim().split("\n").slice(-10).join("\n")); process.exitCode = r.status; }
      return;
    }
    case "exec": {
      const [svc] = args;
      if (!svc || !rest.length) die("usage: redpi-dev exec <service> -- <command...>");
      const r = compose(ctx, ["exec", "-T", svc, ...rest], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "config": { const r = compose(ctx, ["config"]); console.log(r.stdout || r.stderr); return; }
    default: die(`unknown command: ${cmd} (try --help)`);
  }
}

main().catch((e) => die(`redpi-dev: ${e.message}`));
