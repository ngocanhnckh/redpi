// docker-dev skill: `redpi-dev init` picks the stack, port and limits; with Docker available, a
// small Node app runs in a limited container, hot-reloads an edit, gets its own stack and port per
// RedPlan worker, reports an out-of-memory kill, reaps orphaned child processes (no zombies), keeps
// repo files owned by the user, and `down` removes everything. Skips the Docker part without Docker.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEV = join(root, "skills", "docker-dev", "dev.mjs");
const dir = mkdtempSync(join(tmpdir(), "redpi-dev-test-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") };
for (const k of ["REDPI_HQ_WORKER", "REDPI_HQ_NAME", "COMPOSE_PROJECT_NAME", "DEV_PORT"]) delete env[k];
const run = (cwd, args, extra = {}) => { const r = spawnSync(process.execPath, [DEV, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 300000 }); return { out: `${r.stdout}${r.stderr}`, status: r.status }; };
const stacks = [];
const cleanup = () => { for (const [cwd, extra] of stacks) run(cwd, ["down", "-v"], extra); rmSync(dir, { recursive: true, force: true }); };
const fail = (msg, extra = "") => { console.error("FAIL:", msg, "\n", extra); cleanup(); process.exit(1); };
const project = (name, files) => { const d = join(dir, name); mkdirSync(d, { recursive: true }); for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), t); } return d; };

// 1. init picks the stack, port, start command and limits (no Docker needed).
const cases = [
  ["next", { "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "15" } }), "pnpm-lock.yaml": "" }, [/node:22-bookworm-slim/, /pnpm run dev --hostname 0\.0\.0\.0 --port 3000/, /mem_limit: 2g/, /:3000"/]],
  ["vite", { "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }), ".nvmrc": "20\n" }, [/node:20-bookworm-slim/, /npm run dev -- --host 0\.0\.0\.0 --port 5173/, /mem_limit: 1g/, /DEV_PORT:-5173/]],
  ["fastapi", { "requirements.txt": "fastapi\nuvicorn\n", "app/main.py": "" }, [/python:3\.12-slim/, /uvicorn app\.main:app --reload --host 0\.0\.0\.0 --port 8000/, /venv:\/venv/, /mem_limit: 768m/]],
  ["django", { "requirements.txt": "django\n", "manage.py": "" }, [/manage\.py runserver 0\.0\.0\.0:8000/]],
  ["gosvc", { "go.mod": "module x\n\ngo 1.22\n" }, [/golang:1\.22-bookworm/, /go run \./]],
];
for (const [name, files, want] of cases) {
  const d = project(name, files);
  const r = run(d, ["init"]);
  const yaml = readFileSync(join(d, "compose.dev.yaml"), "utf8");
  for (const re of want) if (!re.test(yaml)) fail(`${name}: compose.dev.yaml should match ${re}`, `${r.out}\n${yaml}`);
  for (const re of [/init: true/, /memswap_limit/, /cpus: /, /pids_limit: 512/, /127\.0\.0\.1:\$\{DEV_PORT/, /REDPI_UID/, /redpi\.dev: "1"/]) if (!re.test(yaml)) fail(`${name}: missing ${re}`, yaml);
}
let r = run(join(dir, "vite"), ["init"]);
if (r.status === 0 || !/already exists/.test(r.out)) fail("init should not overwrite an existing file", r.out);
r = run(join(dir, "vite"), ["init", "--force", "--mem", "3g", "--port", "4000", "--public"]);
const forced = readFileSync(join(dir, "vite", "compose.dev.yaml"), "utf8");
if (!/mem_limit: 3g/.test(forced) || !/"\$\{DEV_PORT:-4000\}:4000"/.test(forced)) fail("--mem/--port/--public should be honoured", forced);

// 2. With Docker: run, reload, parallel stacks, OOM, zombies, ownership, down.
const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
if (docker.status !== 0) { console.log("docker-dev test: init checks passed; Docker part skipped (no Docker daemon)."); cleanup(); process.exit(0); }
if (spawnSync("docker", ["image", "inspect", "node:22-bookworm-slim"]).status !== 0) { console.log("docker-dev test: init checks passed; Docker part skipped (image node:22-bookworm-slim not pulled)."); cleanup(); process.exit(0); }

const app = project("webapp", {
  "package.json": JSON.stringify({ name: "webapp", private: true, scripts: { dev: "node --watch server.js" } }),
  "server.js": "require('http').createServer((q, r) => r.end('v1')).listen(process.env.PORT, process.env.HOST);\n",
});
run(app, ["init", "--mem", "256m"]);
stacks.push([app, {}]);
r = run(app, ["up"]);
const url = (/http:\/\/127\.0\.0\.1:(\d+)/.exec(r.out) || [])[0];
if (r.status !== 0 || !/^ready: /m.test(r.out) || !url || !/of 256MiB/.test(r.out)) fail("up should wait until healthy and print the URL and limit", r.out);
const get = async () => { try { return await (await fetch(url)).text(); } catch { return ""; } };
if (await get() !== "v1") fail("service should answer on its URL");
writeFileSync(join(app, "server.js"), readFileSync(join(app, "server.js"), "utf8").replace("'v1'", "'v2'"));
let body = "";
for (let i = 0; i < 40 && body !== "v2"; i++) { await new Promise((res) => setTimeout(res, 250)); body = await get(); }
if (body !== "v2") fail("an edit on the host should hot-reload in the container", body);

// A second worker in the same folder gets its own stack and a different free port.
stacks.push([app, { REDPI_HQ_NAME: "kai" }]);
r = run(app, ["up"], { REDPI_HQ_NAME: "kai" });
const url2 = (/http:\/\/127\.0\.0\.1:(\d+)/.exec(r.out) || [])[0];
if (r.status !== 0 || !/-kai/.test(r.out) || !url2 || url2 === url) fail("a second worker should get its own stack and port", r.out);
r = run(app, ["ls"]);
if (!/-kai\tapp\trunning/.test(r.out)) fail("ls should list both stacks", r.out);
r = run(app, ["up"]);
if (!r.out.includes(url)) fail("up again should keep the stack's port", r.out);

// init: true reaps orphaned grandchildren, so nothing piles up as a zombie.
run(app, ["exec", "app", "--", "node", "-e", "for (let i = 0; i < 5; i++) require('child_process').spawn('sh', ['-c', 'sleep 0.2 & exit 0'], { stdio: 'ignore', detached: true }).unref()"]);
await new Promise((res) => setTimeout(res, 1500));
r = run(app, ["exec", "app", "--", "sh", "-c", "grep -l '^State:.*Z' /proc/[0-9]*/status 2>/dev/null | wc -l"]);
if (r.out.trim() !== "0") fail("orphaned children should be reaped by init", r.out);

// A process that outgrows the limit is killed there, and status says so with the fix.
run(app, ["exec", "app", "--", "node", "-e", "const a = []; for (;;) a.push(Buffer.alloc(32 << 20, 1))"]);
r = run(app, ["status"]);
if (!/OUT OF MEMORY/.test(r.out) || !/Raise mem_limit for app/.test(r.out)) fail("status should report the OOM kill", r.out);

// Files the container writes in the repo belong to the user, not root.
run(app, ["exec", "app", "--", "sh", "-c", "echo x > generated.txt"]);
if (statSync(join(app, "generated.txt")).uid !== process.getuid() || statSync(join(app, "node_modules")).uid !== process.getuid()) fail("repo files should stay owned by the user");

r = run(app, ["down", "-v"], { REDPI_HQ_NAME: "kai" });
if (r.status !== 0 || !/stopped and removed/.test(r.out)) fail("down", r.out);
r = run(app, ["down", "-v"]);
stacks.length = 0;
r = run(app, ["ls"]);
if (/redpi-webapp/.test(r.out)) fail("down should remove the stacks", r.out);
cleanup();
console.log("docker-dev test passed: init detects Next/Vite/FastAPI/Django/Go with sized limits; the app runs limited in Docker, hot-reloads, gets its own stack and port per worker, keeps its port, reaps zombies, reports OOM, keeps files user-owned, and down removes it.");
