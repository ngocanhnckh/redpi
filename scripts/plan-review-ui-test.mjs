#!/usr/bin/env node
// Plan review UI test: a private hub (temp dir, random port) and headless Chromium. Highlights text,
// pins comments on the architecture and Gantt diagrams, edits one, sends the feedback, and checks the
// CEO gets one numbered, anchored message; then the next version shows what changed. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("Plan review UI test skipped: playwright is not installed (npm install)."); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "redpi-review-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
// Only a (fake) Claude Code is installed besides Pi, so Codex and OpenCode show as not installed.
mkdirSync(join(dir, "bin"));
writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
const PATH = [join(dir, "bin"), ...(process.env.PATH || "").split(":").filter((d) => !existsSync(join(d, "codex")) && !existsSync(join(d, "opencode")))].join(":");
const proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { env: { ...process.env, PATH, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1" }, stdio: "ignore" });
process.on("exit", () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
process.on("unhandledRejection", (e) => fail(e?.message || e));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
const plan = {
  title: "Support chat with a deep agent", summary: "A support chat for customers, answered by a LangChain deep agent that can look up orders and hand off to a human.",
  goal: "Answer 70% of support questions without a human.",
  techStack: [{ name: "Deep Agents", package: "deepagents", ecosystem: "PyPI", usedFor: "the agent", uses: "create_deep_agent(tools, instructions)", source: "https://pypi.org/project/deepagents/", verified: true, verifiedFact: "create_deep_agent exists" },
    { name: "FastAPI", package: "fastapi", ecosystem: "PyPI", usedFor: "HTTP API", uses: "FastAPI, APIRouter", source: "https://fastapi.tiangolo.com", verified: true }],
  architecture: { components: [{ id: "ui", name: "Chat widget", kind: "ui", tech: "React" }, { id: "api", name: "Chat API", kind: "service", tech: "FastAPI", description: "Streams answers to the widget." }, { id: "agent", name: "Support agent", kind: "agent", tech: "deepagents" }, { id: "db", name: "Orders DB", kind: "db", tech: "Postgres" }],
    links: [{ from: "ui", to: "api", label: "SSE" }, { from: "api", to: "agent", label: "invoke" }, { from: "agent", to: "db", label: "SQL" }] },
  stories: [
    { id: "S1", title: "Customers get answers", userStory: "As a customer, I want answers in the chat, so that I do not wait for email.", acceptance: ["Answers stream in under 2 s", "Order lookups are correct"], tasks: [
      { id: "T1", title: "Chat API skeleton", description: "A FastAPI app with an SSE endpoint that streams tokens.", estimateHours: 4 },
      { id: "T2", title: "Support agent", description: "A deep agent with an order lookup tool and a handoff tool.", estimateHours: 8, dependsOn: ["T1"] } ] },
    { id: "S2", title: "Chat widget", userStory: "As a customer, I want a chat box on every page.", acceptance: ["Works on mobile"], tasks: [
      { id: "T3", title: "React widget", description: "An embeddable React chat widget.", estimateHours: 6 } ] },
  ],
  risks: ["Order data may be stale"], outOfScope: ["Voice"],
};
const r = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Support chat" })).run.id;
const pl = await api("POST", `/api/runs/${r}/plans`, { plan });
const salt = randomBytes(16);
writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, user: "yitec", salt: salt.toString("hex"), hash: scryptSync("password123", salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"), N: 16384, r: 8, p: 1 }));
const browser = await chromium.launch();
const errors = [];
async function login(ctx) {
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/plans/${pl.id}`);
  await page.waitForSelector("#form:not(.hide)");
  await page.fill("#user", "yitec"); await page.fill("#password", "password123"); await page.click("#go");
  await page.waitForSelector("details.story");
  return page;
}
async function selectText(page, selector, text) {
  await page.locator(selector).first().scrollIntoViewIfNeeded(); // people select text they can see
  await page.evaluate(([sel, t]) => {
    const el = document.querySelector(sel);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(t); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length); getSelection().removeAllRanges(); getSelection().addRange(r); return; } }
    throw new Error("text not found: " + t);
  }, [selector, text]);
  await page.waitForSelector(".sel-btn:not([hidden])", { timeout: 10000 });
}
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: "dark" });
const page = await login(ctx);
// 1. highlight text in a task
await selectText(page, '[data-anchor="task:T2"] .td', "order lookup tool");
await page.click(".sel-btn");
await page.waitForSelector(".composer-pop textarea");
await page.fill(".composer-pop textarea", "Also add a refund tool, read-only for now.");
await page.keyboard.press("Control+Enter");
await page.waitForSelector('mark.anno');
// 2. highlight in the summary (overview)
await selectText(page, ".summary", "hand off to a human");
await page.click(".sel-btn"); await page.fill(".composer-pop textarea", "Handoff must go to Zendesk."); await page.click('[data-act=save]');
await page.waitForFunction(() => document.querySelectorAll(".anno-badge").length === 2);
// 3. pin on architecture
await page.click('[data-tab=architecture]');
await page.click('[data-pin=arch]');
await page.locator('[data-anchor="component:agent"] rect').first().scrollIntoViewIfNeeded();
const comp = await page.locator('[data-anchor="component:agent"] rect').first().boundingBox();
await page.mouse.click(comp.x + comp.width / 2, comp.y + comp.height / 2);
await page.waitForSelector(".composer-pop textarea");
const where = await page.textContent(".cp-where");
await page.fill(".composer-pop textarea", "Run the agent in its own worker process.");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(".pin");
// 4. pin on the gantt
await page.keyboard.press("Escape");
await page.click('[data-tab=timeline]');
await page.click('[data-pin=gantt]');
await page.locator('[data-anchor="task:T3"] rect.bar').first().scrollIntoViewIfNeeded();
const bar = await page.locator('[data-anchor="task:T3"] rect.bar').first().boundingBox();
await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
await page.fill(".composer-pop textarea", "Widget can start later, no rush.");
await page.keyboard.press("Control+Enter");
await page.waitForSelector(".pin");
// 5. jump back to comment 1 from the list, edit it
await page.click('[data-jump]:first-of-type >> nth=0');
await page.waitForSelector('[data-tab=stories][aria-selected=true]');
await page.click('[data-edit] >> nth=0');
await page.fill(".composer-pop textarea", "Also add a refund tool (read-only).");
await page.click('[data-act=save]');
await page.waitForFunction(() => document.querySelector(".fb-body")?.textContent.includes("(read-only)"));
// 6. overall comment + send
await page.fill("#comment", "Looks good otherwise.");
await page.click("#send");
await page.waitForSelector("text=You asked for changes");
const inbox = await api("GET", `/api/runs/${r}/inbox?for=ceo&after=0`);
const msg = inbox.find((m) => m.kind === "decision")?.body || "";
if (where !== "Architecture diagram › Support agent (agent)") fail(`pin did not name the component under it: ${where}`);
for (const line of ['Overall: Looks good otherwise.', '#1 [Stories & tasks › Task T2 · Support agent] on "order lookup tool": Also add a refund tool (read-only).',
  '#2 [Overview › Summary] on "hand off to a human": Handoff must go to Zendesk.', '#3 [Architecture diagram › Support agent (agent)]: Run the agent in its own worker process.', '#4 [Gantt chart › T3 · React widget'])
  if (!msg.includes(line)) fail(`CEO message is missing: ${line}\n${msg}`);
// 7. v2 arrives: shows what changed and old comments
const v2 = await api("POST", `/api/runs/${r}/plans`, { plan: { ...plan, changes: ["#1 Added a read-only refund tool to the agent", "#2 Handoff now creates a Zendesk ticket", "#3 The agent runs in its own worker", "#4 Widget moved after the API"] } });
await page.goto(`${base}/plans/${v2.id}`);
await page.waitForSelector(".changes");
await page.click(".prev-fb summary");
if ((await page.locator(".prev-fb .fb-item").count()) !== 4 || (await page.locator(".changes-list li").count()) !== 4) fail("v2 does not show the v1 comments and what changed");
// light + phone
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", hasTouch: true });
const phone = await login(ctx2);
await phone.goto(`${base}/plans/${pl.id}`); await phone.waitForSelector("details.story");
await phone.goto(`${base}/plans/${v2.id}`); await phone.waitForSelector(".changes");
await selectText(phone, ".summary", "support chat");
await phone.click(".sel-btn"); await phone.waitForSelector(".composer-pop textarea");
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
if (overflow) fail("plan page overflows horizontally on a phone");
// Coding agent per task: everything on Pi by default; put T3 on Claude Code; Codex is not installed.
await page.click("[data-tab=stories]");
await page.waitForSelector("[data-harness-all]");
if (await page.$eval("[data-harness-task=T1]", (el) => el.value) !== "pi") fail("tasks should default to Pi");
if (!(await page.$eval('[data-harness-task=T1] option[value=codex]', (o) => o.disabled && o.textContent.includes("not installed")))) fail("Codex should be listed as not installed");
await page.evaluate(() => { document.querySelector('details[data-story="S2"]').open = true; });
await page.selectOption("[data-harness-task=T3]", "claude");
await page.waitForFunction(() => document.querySelector(".harness-bar")?.textContent.includes("Claude Code 1"));
if (await page.$eval("[data-harness-all]", (el) => el.value) !== "") fail("mixed agents should show as Mixed");
if ((await api("GET", `/api/plans/${v2.id}`)).harness.T3 !== "claude") fail("per-task harness not saved");
await page.selectOption("[data-harness-all]", "claude");
await page.waitForFunction(() => document.querySelector(".harness-bar")?.textContent.includes("Claude Code 3"));
await page.selectOption("[data-harness-all]", "pi");
await page.selectOption("[data-harness-task=T3]", "claude");
await page.waitForFunction(() => document.querySelector(".harness-bar")?.textContent.includes("Pi (RedPi) 2"));
await page.click("#approve");
await page.waitForSelector("text=Watch execution");
const approvedMsg = (await api("GET", `/api/runs/${r}/inbox?for=ceo&after=0`)).filter((m) => m.kind === "decision").pop()?.body || "";
if (!approvedMsg.includes("Pi (RedPi): T1, T2; Claude Code: T3")) fail(`approval message lacks the harness per task: ${approvedMsg}`);
if (!(await page.textContent(".harness-bar")).includes("Coding agents: Pi (RedPi) 2 · Claude Code 1")) fail("approved plan should show the agents read-only");
// Big diagrams: a wide, tangled architecture (a long chain, a return link, two links between the
// same pair, a crowded column) opens fitted inside its frame, can be dragged and zoomed, and pins
// still land on the component under the pointer at any zoom. A drag in comment mode drops no pin.
{
  const comps = ["lib:library:Framework mapping data", "web:ui:ARROW Web", "api:service:ARROW API", "worker:agent:ARROW Worker", "sup:agent:Deep Agent supervisor", "sandbox:service:CLI sandbox", "pg:db:Postgres", "s3:external:Object store", "llm:model:Model gateway", "q:queue:Job queue"]
    .map((c) => { const [id, kind, name] = c.split(":"); return { id, kind, name, tech: `${kind} tech` }; });
  const links = [["lib", "web", "matrix + coverage rows"], ["web", "api", "REST"], ["api", "worker", "run control, matrix, checklist"], ["worker", "sup", "drives assessment"], ["worker", "sup", "maps ingests"], ["sup", "sandbox", "shell"], ["sup", "worker", "progress"], ["api", "pg", "SQL"], ["api", "s3", "reports"], ["api", "llm", "summaries"], ["api", "q", "jobs"]]
    .map(([from, to, label]) => ({ from, to, label }));
  const wideRun = (await api("POST", "/api/runs", { projectPath: "/home/yitec/arrowish", title: "Wide diagram" })).run.id;
  // Two cards for one package (as real plans do: the library and one of its parts).
  const techStack = [...plan.techStack, { name: "deepagents LocalShellBackend", package: "deepagents", ecosystem: "PyPI", usedFor: "the sandboxed shell", uses: "LocalShellBackend(root_dir, env)", source: "https://pypi.org/project/deepagents/", verified: true }];
  const wide = await api("POST", `/api/runs/${wideRun}/plans`, { plan: { ...plan, techStack, architecture: { components: comps, links } } });
  const w = await ctx.newPage();
  w.on("pageerror", (e) => errors.push(e.message));
  await w.goto(`${base}/plans/${wide.id}`);
  await w.waitForSelector("details.story");
  await w.click("[data-tab=architecture]");
  await w.waitForSelector(".pz .diagram svg");
  await w.evaluate(() => document.querySelector(".pz").scrollIntoView({ block: "start" }));
  const frame = async () => w.evaluate(() => {
    const st = document.querySelector(".pz-stage").getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.pz [data-anchor^="component:"] rect:first-of-type')].map((r) => r.getBoundingClientRect());
    return { st: { l: st.left, r: st.right, t: st.top, b: st.bottom }, inside: boxes.every((b) => b.left >= st.left - 1 && b.right <= st.right + 1 && b.top >= st.top - 1 && b.bottom <= st.bottom + 1), zoom: document.querySelector("[data-pz=zoom]").textContent, first: boxes[0].left };
  });
  const f0 = await frame();
  if (!f0.inside) fail("the architecture does not open fitted inside its frame");
  if (await w.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail("the architecture makes the page scroll sideways");
  // Labels never share a spot.
  const overlaps = await w.evaluate(() => {
    const rs = [...document.querySelectorAll(".arch .elabel")].map((t) => t.getBoundingClientRect());
    return rs.some((a, i) => rs.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  });
  if (overlaps) fail("architecture link labels overlap");
  // Ctrl + scroll zooms in at the pointer; the zoom level shows.
  const cx = (f0.st.l + f0.st.r) / 2, cy = (f0.st.t + f0.st.b) / 2;
  await w.mouse.move(cx, cy);
  await w.keyboard.down("Control"); await w.mouse.wheel(0, -400); await w.keyboard.up("Control");
  const f1 = await frame();
  if (parseInt(f1.zoom) <= parseInt(f0.zoom)) fail(`ctrl+scroll did not zoom in (${f0.zoom} → ${f1.zoom})`);
  if (f1.inside) fail("zoomed in, the diagram should overflow its frame");
  // Drag moves it.
  await w.mouse.move(cx, cy); await w.mouse.down(); await w.mouse.move(cx - 200, cy - 20, { steps: 6 }); await w.mouse.up();
  const f2 = await frame();
  if (Math.abs(f2.first - (f1.first - 200)) > 2) fail(`drag did not move the diagram by 200px (${f1.first} → ${f2.first})`);
  // Comment mode: a drag drops no pin; a click pins the component under the pointer, even zoomed and moved.
  await w.click("[data-pin=arch]");
  await w.mouse.move(cx, cy); await w.mouse.down(); await w.mouse.move(cx + 120, cy, { steps: 5 }); await w.mouse.up();
  if (await w.$(".composer-pop")) fail("dragging in comment mode opened a comment");
  const target = await w.evaluate(([l, r, t, b]) => {
    const els = [...document.querySelectorAll('.pz [data-anchor^="component:"]')];
    for (const el of els) { const x = el.querySelector("rect").getBoundingClientRect(); const px = x.left + x.width / 2, py = x.top + x.height / 2; if (px > l + 20 && px < r - 20 && py > t + 40 && py < b - 30) return { id: el.dataset.anchor, label: el.dataset.label, px, py }; }
  }, [f2.st.l, f2.st.r, f2.st.t, f2.st.b]);
  if (!target) fail("no component visible after zoom and drag");
  await w.mouse.click(target.px, target.py);
  await w.waitForSelector(".composer-pop textarea");
  const pinWhere = await w.textContent(".cp-where");
  if (pinWhere !== `Architecture diagram › ${target.label}`) fail(`zoomed pin named ${pinWhere}, expected ${target.label}`);
  await w.fill(".composer-pop textarea", "Pinned while zoomed.");
  await w.keyboard.press("Control+Enter");
  await w.waitForSelector(".pz .pin");
  const pinOff = await w.evaluate((id) => { const r = document.querySelector(".pz .pin").getBoundingClientRect(); const c = document.querySelector(`.pz [data-anchor="${id}"] rect`).getBoundingClientRect(); return { d: Math.hypot(r.left + r.width / 2 - (c.left + c.width / 2), r.bottom - (c.top + c.height / 2)), c: [c.left + c.width / 2, c.top + c.height / 2] }; }, target.id);
  if (pinOff.d > 3) fail(`the pin is drawn ${pinOff.d.toFixed(1)}px away from the component center it was placed on`);
  // Zooming again keeps the pin on its spot and at a readable size.
  await w.click("[data-pz=in]");
  const pinSize = await w.evaluate(() => document.querySelector(".pz .pin").getBoundingClientRect().height);
  if (pinSize < 20 || pinSize > 30) fail(`pins should stay a constant size at any zoom (got ${pinSize}px)`);
  // Fit, Expand (fills the window), Esc closes it.
  await w.click("[data-pin=arch]");
  await w.click("[data-pz=expand]");
  const exp = await w.evaluate(() => { const r = document.querySelector(".pz").getBoundingClientRect(); return r.width > innerWidth - 40 && r.height > innerHeight - 40; });
  if (!exp) fail("Expand did not fill the window");
  await w.screenshot({ path: process.env.REDPI_SHOTS ? `${process.env.REDPI_SHOTS}/arch-expanded.png` : join(dir, "x.png") });
  await w.keyboard.press("Escape");
  if (await w.$(".pz-expanded")) fail("Esc did not close the expanded view");
  await w.click("[data-pz=fit]");
  if (!(await frame()).inside) fail("Fit did not bring the whole diagram back into view");
  if (process.env.REDPI_SHOTS) await w.screenshot({ path: `${process.env.REDPI_SHOTS}/arch-fit.png` });
  // The Gantt chart gets the same frame.
  await w.click("[data-tab=timeline]");
  await w.waitForSelector(".pz #gantt svg");
  // Every block has a 💬 button: stories, tasks, acceptance criteria, risks, overview.
  await w.click("[data-tab=stories]");
  await w.waitForSelector("details.story");
  for (const a of ["story:S1", "task:T1", "acc:S1:0", "summary", "goal"]) if (!(await w.$(`[data-card-comment="${a}"]`))) fail(`no comment button on ${a}`);
  await w.evaluate(() => { document.querySelector('details[data-story="S1"]').open = true; });
  await w.click('[data-card-comment="task:T2"]');
  await w.waitForSelector(".composer-pop textarea");
  if ((await w.textContent(".cp-where")) !== "Stories & tasks › Task T2 · Support agent") fail(`task comment names ${await w.textContent(".cp-where")}`);
  await w.fill(".composer-pop textarea", "Split this into two tasks.");
  await w.keyboard.press("Control+Enter");
  await w.waitForSelector('[data-anchor="task:T2"] .card-badge');
  if (process.env.REDPI_SHOTS) { await w.locator('details[data-story="S1"]').scrollIntoViewIfNeeded(); await w.screenshot({ path: `${process.env.REDPI_SHOTS}/stories.png` }); }
  // The story header button comments without opening/closing the story.
  const openBefore = await w.$eval('details[data-story="S2"]', (d) => d.open);
  await w.click('[data-card-comment="story:S2"]');
  await w.waitForSelector(".composer-pop textarea");
  if ((await w.$eval('details[data-story="S2"]', (d) => d.open)) !== openBefore) fail("the story comment button toggled the story");
  await w.keyboard.press("Escape");
  await w.click("[data-tab=risks]");
  if (!(await w.$('[data-card-comment="risk:0"]'))) fail("no comment button on a risk");
  // Tech stack: 💬 on a card comments on the whole card; a highlight on the second card of a
  // package lands on that card (not lost looking in the first); both reach the CEO.
  await w.click("[data-tab=tech]");
  await w.waitForSelector('[data-card-comment="tech:deepagents#2"]');
  await w.click('[data-card-comment="tech:deepagents#2"]');
  await w.waitForSelector(".composer-pop textarea");
  if ((await w.textContent(".cp-where")) !== "Tech stack › deepagents LocalShellBackend (deepagents)") fail(`card comment names ${await w.textContent(".cp-where")}`);
  await w.fill(".composer-pop textarea", "Run it inside a container, not on the host.");
  await w.keyboard.press("Control+Enter");
  await w.waitForSelector('[data-anchor="tech:deepagents#2"] .card-badge');
  await selectText(w, '[data-anchor="tech:deepagents#2"]', "the sandboxed shell");
  await w.click(".sel-btn");
  await w.fill(".composer-pop textarea", "Which commands may it run?");
  await w.keyboard.press("Control+Enter");
  await w.waitForSelector('[data-anchor="tech:deepagents#2"] mark.anno');
  if (await w.$(".fb-item.orphan")) fail("a tech stack comment was lost (orphaned)");
  if (process.env.REDPI_SHOTS) { await w.locator(".tech").scrollIntoViewIfNeeded(); await w.screenshot({ path: `${process.env.REDPI_SHOTS}/tech.png` }); }
  if (await w.$('[data-anchor="tech:deepagents"] .card-badge, [data-anchor="tech:deepagents"] mark.anno')) fail("second-card comments showed on the first deepagents card");
  await w.click("#send");
  await w.waitForSelector("text=You asked for changes");
  const wideMsg = (await api("GET", `/api/runs/${wideRun}/inbox?for=ceo&after=0`)).find((m) => m.kind === "decision")?.body || "";
  for (const line of ["[Stories & tasks › Task T2 · Support agent]: Split this into two tasks.", "[Tech stack › deepagents LocalShellBackend (deepagents)]: Run it inside a container, not on the host.", '[Tech stack › deepagents LocalShellBackend (deepagents)] on "the sandboxed shell": Which commands may it run?'])
    if (!wideMsg.includes(line)) fail(`CEO message is missing: ${line}\n${wideMsg}`);
  // Phone: one finger drags the diagram, and the page itself never scrolls sideways.
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", hasTouch: true });
  const p = await login(pctx);
  await p.goto(`${base}/plans/${wide.id}`); await p.waitForSelector("details.story");
  await p.click("[data-tab=architecture]"); await p.waitForSelector(".pz .diagram svg");
  if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) fail("wide architecture overflows the phone screen");
  if (process.env.REDPI_SHOTS) await p.screenshot({ path: `${process.env.REDPI_SHOTS}/arch-phone.png`, fullPage: false });
  await pctx.close();
  await w.close();
}
await browser.close();
const real = errors.filter((e) => !/status of 401/.test(e));
if (real.length) fail(`console errors:\n${real.join("\n")}`);
console.log("Plan review UI test passed: text highlights, diagram pins on architecture and Gantt, edit, send feedback → one numbered anchored CEO message, v2 shows what changed and the v1 comments, coding agent per task (installed only, all/each, sent with the approval), big diagrams (fit, drag, zoom, pins at any zoom, expand), a comment button on every story, task, criterion, risk and card, phone layout.");
process.exit(0);
