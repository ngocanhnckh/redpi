// ADRs and lessons learned: numbered records with an index (parallel writers never clash), supersede,
// newest-first lessons without duplicates, the text every session gets (trusted projects only), and
// the redpi-hq commands non-Pi workers use. Runs in a temporary git repository.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = mkdtempSync(join(tmpdir(), "redpi-knowledge-test-"));
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); rmSync(repo, { recursive: true, force: true }); process.exit(1); };
execFileSync("git", ["init", "-q", repo]);
const sub = join(repo, "src");
execFileSync("mkdir", ["-p", sub]);
const k = await import("../lib/knowledge.mjs");

// Tools through the extension, as an agent would call them (from a subfolder: files land at the repo root).
const tools = {}, handlers = {}, commands = {};
const pi = { registerTool: (d) => { tools[d.name] = d; }, registerCommand: (n, d) => { commands[n] = d; }, on: (e, f) => { handlers[e] = f; } };
const { default: ext } = await import("../extensions/redpi-knowledge.ts");
ext(pi);
if (!tools.redpi_adr || !tools.redpi_lesson || !commands.decisions) fail("tools and /decisions should be registered");
const ctx = { cwd: sub, isProjectTrusted: () => true, ui: { notify() {} } };
const run = async (name, args) => (await tools[name].execute("x", args, undefined, undefined, ctx)).content[0].text;
let out = await run("redpi_adr", { title: "Use Postgres for orders", context: "Orders need transactions and reporting.", decision: "Postgres 16 via the `pg` package.", alternatives: "SQLite (no concurrent writers), MongoDB (no joins).", consequences: "Needs a database container in dev.", task: "T1.2" });
if (!/Recorded ADR 0001/.test(out)) fail("first ADR", out);
const adr1 = readFileSync(join(repo, "docs/adr", readdirSync(join(repo, "docs/adr")).find((f) => f.startsWith("0001-"))), "utf8");
if (!/^# 1\. Use Postgres for orders/m.test(adr1) || !/- Status: accepted/.test(adr1) || !/## Alternatives considered/.test(adr1) || !/- Task: T1\.2/.test(adr1)) fail("ADR content", adr1);

// Five writers at once (the CLI, as Claude Code / Codex workers use it) get five different numbers.
const cli = (args, cwd = sub) => new Promise((ok) => { const p = spawn(process.execPath, [join(root, "hq/cli.mjs"), ...args], { cwd, env: { ...process.env, REDPI_HQ_WORKER: "", REDPI_HQ_RUN: "" } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", (code) => ok({ code, o })); });
const many = await Promise.all([1, 2, 3, 4, 5].map((i) => cli(["adr", "--title", `Decision ${i}`, "--context", "Why", "it matters", "--decision", "Do", "it", "--consequences", "Fine"])));
if (many.some((r) => r.code !== 0)) fail("parallel CLI ADRs failed", many);
const nums = k.listAdrs(repo).map((a) => a.number);
if (nums.join() !== "1,2,3,4,5,6") fail("parallel writers should get unique consecutive numbers", nums);
if (!/Context\n\nWhy it matters/.test(readFileSync(join(repo, "docs/adr", k.listAdrs(repo)[1].file), "utf8"))) fail("CLI flag values with spaces");
if ((await cli(["adr", "--title", "No context"])).code === 0) fail("an ADR without its sections should be refused");
// Supersede: the old record says so, and the index lists every record.
out = await run("redpi_adr", { title: "Move orders to CockroachDB", context: "Multi-region.", decision: "CockroachDB.", consequences: "New driver.", supersedes: 1 });
if (!/Recorded ADR 0007/.test(out) || !/superseded by 0007/.test(readFileSync(join(repo, "docs/adr", k.listAdrs(repo)[0].file), "utf8"))) fail("supersede", out);
const index = readFileSync(join(repo, "docs/adr/README.md"), "utf8");
if ((index.match(/^\| 00\d\d \|/gm) || []).length !== 7 || !/\| 0001 \| \[Use Postgres for orders\]\(0001-use-postgres-for-orders\.md\) \| superseded by 0007/.test(index)) fail("ADR index", index);

// Lessons: newest first, duplicates skipped.
out = await run("redpi_lesson", { what: "The docker build took 40 minutes because the cache was busted by COPY . .", lesson: "Copy dependency manifests before the source so the install layer stays cached.", nextTime: "COPY package*.json first, npm ci, then COPY the rest.", area: "docker build" });
if (!/Lesson added/.test(out)) fail("lesson", out);
out = await run("redpi_lesson", { what: "Waited on review for an hour", lesson: "Tell the reviewer when a task reaches review.", nextTime: "redplan_send the reviewer with the diff summary." });
out = await run("redpi_lesson", { what: "again", lesson: "Copy dependency manifests before the source so the install layer stays cached!", nextTime: "same" });
if (!/already in/.test(out)) fail("duplicate lesson should be skipped", out);
const r = await cli(["lesson", "--what", "Flaky e2e", "--lesson", "Wait for network idle before asserting.", "--next", "Use waitForLoadState('networkidle')."]);
if (r.code !== 0 || !/Lesson added/.test(r.o)) fail("CLI lesson", r);
// Parallel lessons are all kept.
const par = await Promise.all([1, 2, 3, 4].map((i) => cli(["lesson", "--what", `Parallel ${i}`, "--lesson", `Parallel lesson ${i} stays`, "--next", "n"])));
if (par.some((x) => x.code !== 0)) fail("parallel lessons failed", par);
const lessons = readFileSync(join(repo, "docs/lessons-learned.md"), "utf8");
const order = ["Parallel lesson", "Wait for network idle", "Tell the reviewer", "Copy dependency manifests"].map((s) => lessons.indexOf(s));
if (!/^# Lessons learned/.test(lessons) || order.some((i) => i < 0) || !(order[0] < order[1] && order[1] < order[2] && order[2] < order[3]) || (lessons.match(/^## /gm) || []).length !== 7 || [1, 2, 3, 4].some((i) => !lessons.includes(`Parallel lesson ${i} stays`))) fail("lessons should be newest first with no duplicates", lessons);

// Every session in a trusted project is told the lessons and decisions; untrusted projects only get the policy.
const sys = (await handlers.before_agent_start({ systemPrompt: "BASE" }, ctx)).systemPrompt;
if (!/^BASE/.test(sys) || !/record it with redpi_adr/.test(sys) || !/Lessons learned in this project/.test(sys) || !/Copy dependency manifests/.test(sys) || !/0007 Move orders to CockroachDB \[accepted \(supersedes 0001\)\]/.test(sys) || !/0001 Use Postgres for orders \[superseded by 0007\]/.test(sys)) fail("session prompt", sys);
const untrusted = (await handlers.before_agent_start({ systemPrompt: "BASE" }, { ...ctx, isProjectTrusted: () => false })).systemPrompt;
if (/Copy dependency manifests/.test(untrusted) || !/redpi_adr/.test(untrusted)) fail("untrusted projects must not have their files injected", untrusted);
// Long files are capped, newest kept.
for (let i = 0; i < 80; i++) k.addLesson(repo, { what: `thing ${i}`, lesson: `Lesson number ${i} about something specific`, nextTime: "do better" });
const capped = k.knowledgeText(repo);
if (capped.length > 9000 || !/Lesson number 79/.test(capped) || /Lesson number 0 /.test(capped) || !/older lessons in the file/.test(capped)) fail("capping", capped.length);

rmSync(repo, { recursive: true, force: true });
console.log("RedPi knowledge test passed: ADRs numbered and indexed (parallel writers never clash), supersede, lessons newest first without duplicates, the redpi-hq adr/lesson commands, lessons and decisions in every trusted session's prompt, capped.");
