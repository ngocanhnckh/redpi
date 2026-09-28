#!/usr/bin/env node
// Office UI test: a private hub (temp dir, random port) and headless Chromium. Drives real worker
// heartbeats and messages, then checks where the pixel people go: the files room while searching,
// back to the desk to write code, the meeting room when teammates talk, coffee chats when idle,
// restless trips from the desk, and nobody moves under reduced motion. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("Office UI test skipped: playwright is not installed (npm install)."); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "redpi-office-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const proc = spawn(process.execPath, [join(root, "hq", "server.mjs")], { env: { ...process.env, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1" }, stdio: "ignore" });
let browser;
process.on("exit", () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); });
const fail = async (msg, extra) => { console.error(`FAIL: ${msg}`, extra ?? ""); await browser?.close().catch(() => {}); process.exit(1); };
process.on("unhandledRejection", (e) => fail(e?.message || e));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/api/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
const salt = randomBytes(16);
writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, user: "yitec", salt: salt.toString("hex"), hash: scryptSync("password123", salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"), N: 16384, r: 8, p: 1 }));

const runId = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Office test" })).run.id;
const ids = {};
for (const [name, role] of [["Alex", "backend developer"], ["Priya", "frontend developer"], ["Sam", "data engineer"], ["Rin", "designer"]])
  ids[name] = (await api("POST", `/api/runs/${runId}/workers`, { name, role, cwd: "/tmp/office-test" })).id;
const beat = (name, b) => api("POST", `/api/workers/${ids[name]}/heartbeat`, b);
const act = (name, tool, text) => beat(name, { status: "working", activity: { tool, text, at: Date.now() } });
for (const n of Object.keys(ids)) await beat(n, { status: "working" });

browser = await chromium.launch();
const errors = [];
const shots = process.env.REDPI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
async function open(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...options });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/runs/${runId}`);
  await page.waitForSelector("#form:not(.hide)");
  await page.fill("#user", "yitec"); await page.fill("#password", "password123"); await page.click("#go");
  await page.waitForSelector(".office-host canvas");
  await page.waitForFunction(() => document.querySelector(".office-host")?.office?.people.size >= 5);
  return page;
}
// Where everyone is, in tiles, and what they are doing.
const who = (page) => page.evaluate(() => {
  const o = document.querySelector(".office-host").office, m = o.map;
  const inside = (r, t) => t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;
  const out = {};
  for (const p of o.people.values()) out[p.name] = { tile: p.tile, dir: p.dir, mode: p.mode, errand: p.errand?.kind || null, arrived: !!p.errand?.arrived, sitting: p.sitting, walking: p.walking, running: p.running,
    inFiles: inside(m.files, p.tile), inMeeting: inside(m.meeting, p.tile), atSeat: p.seatIndex !== undefined && p.tile.x === m.seats[p.seatIndex].x && p.tile.y === m.seats[p.seatIndex].y, bubble: p.bubble.state !== "hidden" ? p.bubble.text : null, talk: p.bubble.talk };
  return out;
});
async function until(page, what, test, ms = 12000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await who(page); if (test(last)) return last; await page.waitForTimeout(150); }
  await fail(`timed out waiting for ${what}`, JSON.stringify(last, null, 1));
}
const shot = async (page, name) => { if (shots) await page.locator(".office-host").screenshot({ path: join(shots, `office-${name}.png`) }); };

const page = await open();
// No restless trips or coffee chats during the scripted checks unless a check asks for one.
const calm = () => page.evaluate(() => { const o = document.querySelector(".office-host").office; o.nextSocial = 1e9; for (const p of o.people.values()) p.restlessAt = 1e9; });
await until(page, "everyone seated at their desk", (w) => ["Alex", "Priya", "Sam", "Rin"].every((n) => w[n].atSeat && w[n].sitting));
await calm();
await shot(page, "desks");

// The map has a files & servers room and a closed meeting room, all reachable.
const layout = await page.evaluate(async () => {
  const { activityKind } = await import("/static/office/office.js");
  const m = document.querySelector(".office-host").office.map;
  return { files: m.fileSpots.length, servers: m.serverSpots.length, seats: m.meetingSeats.length,
    kinds: [["grep", "grep: TODO"], ["read", "read: a.ts"], ["bash", "bash: cd src && ls"], ["bash", "bash: rg auth"], ["bash", "bash: npm test"], ["bash", "bash: docker compose up"], ["edit", "edit: a.ts"], ["write", "write: b.ts"], ["bash", "bash: echo hi"], ["redplan_update_task", "redplan_update_task: T1"]]
      .map(([tool, text]) => activityKind({ tool, text })) };
});
if (layout.files < 3 || layout.servers < 2 || layout.seats < 8) await fail("office rooms missing", layout);
if (layout.kinds.join() !== "research,research,research,research,server,server,code,code,other,other") await fail("activity kinds wrong", layout.kinds);

// Searching the codebase: Alex runs to the files room, and the bubble shows the real search.
await act("Alex", "grep", "grep: createUser");
let w = await until(page, "Alex running to the files room", (w) => w.Alex.errand === "files" && (w.Alex.running || w.Alex.inFiles));
w = await until(page, "Alex at the shelves", (w) => w.Alex.inFiles && w.Alex.arrived && !w.Alex.walking);
if (w.Alex.dir !== "up" || !/createUser/.test(w.Alex.bubble || "")) await fail("Alex not facing the shelves with the search bubble", w.Alex);
await shot(page, "files");
// More research keeps them there; writing code sends them back to type at the desk.
await act("Alex", "read", "read: src/users.ts");
await page.waitForTimeout(400);
if ((await who(page)).Alex.errand !== "files") await fail("more research should keep Alex in the files room");
await act("Alex", "edit", "edit: src/users.ts");
await until(page, "Alex back typing at the desk", (w) => w.Alex.atSeat && w.Alex.sitting && !w.Alex.errand);
const monitorOn = await page.evaluate(() => { const o = document.querySelector(".office-host").office; return o.state.monitors.get([...o.people.values()].find((p) => p.name === "Alex").seatIndex); });
if (monitorOn !== "on") await fail("Alex's monitor should be on while typing", monitorOn);
await calm();

// Teammates talking meet in the meeting room, sit facing each other, and the speaker shows the real message.
await api("POST", `/api/runs/${runId}/messages`, { from: ids.Priya, to: ids.Sam, body: "Which JSON schema does the orders endpoint return?" });
w = await until(page, "Priya and Sam in the meeting room", (w) => w.Priya.inMeeting && w.Sam.inMeeting && w.Priya.arrived && w.Sam.arrived && !w.Priya.walking && !w.Sam.walking);
if (!w.Priya.sitting || !w.Sam.sitting || w.Priya.tile.x !== w.Sam.tile.x || w.Priya.dir === w.Sam.dir) await fail("the two should sit across the table facing each other", { p: w.Priya, s: w.Sam });
if (!/Sam: Which JSON schema/.test(w.Priya.bubble || "")) await fail("speaker bubble should show the message", w.Priya.bubble);
if (!(await page.evaluate(() => document.querySelector(".office-host").office.state.meetingOn))) await fail("meeting screen should be on");
await shot(page, "meeting");
// A reply keeps the meeting going with the replier speaking.
await api("POST", `/api/runs/${runId}/messages`, { from: ids.Sam, to: ids.Priya, body: "An array of orders with id, status and total." });
w = await until(page, "Sam's reply bubble", (w) => /Priya: An array of orders/.test(w.Sam.bubble || ""), 5000);
if (!w.Sam.inMeeting) await fail("the reply should not end the meeting");
// Then they go back to work at their desks.
await until(page, "Priya and Sam back at their desks", (w) => w.Priya.atSeat && w.Sam.atSeat && !w.Priya.errand && !w.Sam.errand, 25000);
await calm();

// A message for the human: the sender walks to the YOU terminal.
await api("POST", `/api/runs/${runId}/messages`, { from: ids.Rin, to: "human", body: "Pick a colour for the brand, please" });
w = await until(page, "Rin at the YOU terminal", (w) => w.Rin.errand === "terminal" && w.Rin.arrived);
if (!/You: Pick a colour/.test(w.Rin.bubble || "")) await fail("Rin should show the message at the terminal", w.Rin.bubble);
await until(page, "Rin back at the desk", (w) => w.Rin.atSeat && !w.Rin.errand, 20000);

// Restless: nobody sits at the desk forever; a trip happens and they come back.
await page.evaluate(() => { const o = document.querySelector(".office-host").office; for (const p of o.people.values()) if (p.name === "Alex") p.restlessAt = 0; });
w = await until(page, "Alex takes a break from the desk", (w) => !!w.Alex.errand);
if (!["servers", "coffee", "window", "files", "visit"].includes(w.Alex.errand)) await fail("unexpected restless trip", w.Alex.errand);
await until(page, "Alex back at the desk after the trip", (w) => w.Alex.atSeat && w.Alex.sitting && !w.Alex.errand, 25000);

// Idle teammates chat over coffee (dots, no invented text).
await beat("Sam", { status: "idle" }); await beat("Rin", { status: "idle" });
await until(page, "Sam and Rin idle", (w) => w.Sam.mode === "idle" && w.Rin.mode === "idle");
await page.evaluate(() => { document.querySelector(".office-host").office.nextSocial = 0; });
w = await until(page, "a coffee chat", (w) => w.Sam.errand === "chat" && w.Rin.errand === "chat" && w.Sam.arrived && w.Rin.arrived);
if (!w.Sam.talk || !w.Rin.talk || w.Sam.bubble || w.Rin.bubble) await fail("coffee chat should be a dots bubble without text", { s: w.Sam, r: w.Rin });
await shot(page, "coffee");

// Team chat: opens on the newest message, keeps your place while you read older ones as
// live updates arrive, counts new messages instead of jumping, and follows new messages
// again once you are back at the bottom. The worker drawer keeps its place too.
const say = (body) => api("POST", `/api/runs/${runId}/messages`, { from: "human", to: "ceo", body });
for (let i = 0; i < 30; i++) await say(`Note ${i}: ${"a long line of text to fill the chat ".repeat(4)}`);
const count = () => page.evaluate(() => document.querySelectorAll(".chat .msg").length);
const chatAt = () => page.evaluate(() => { const c = document.querySelector(".chat"), b = document.querySelector(".chat-new"); return { top: c.scrollTop, end: c.scrollHeight - c.clientHeight, newVisible: !b.hidden, newText: b.textContent }; });
await page.waitForFunction(() => document.querySelectorAll(".chat .msg").length >= 30, null, { timeout: 10000 }).catch(async () => fail("chat did not load the messages", await page.evaluate(() => document.querySelectorAll(".chat .msg").length)));
await page.waitForTimeout(300);
let c = await chatAt();
if (c.end < 200 || c.end - c.top > 30) await fail("chat should open at the newest message", c);
await page.evaluate(() => { document.querySelector(".chat").scrollTop = 150; });
const before1 = await count();
await beat("Alex", { status: "working", activity: { tool: "edit", text: "edit: x.ts", at: Date.now() } });   // live update, no new message
await say("A new message while you read");
await page.waitForFunction((n) => document.querySelectorAll(".chat .msg").length > n, before1);
await page.waitForTimeout(400);
c = await chatAt();
if (Math.abs(c.top - 150) > 2) await fail("chat jumped while reading older messages", c);
if (!c.newVisible || !/1 new/.test(c.newText)) await fail("new-message button should show while reading", c);
await page.click(".chat-new");
await page.waitForFunction(() => { const c = document.querySelector(".chat"); return c.scrollHeight - c.clientHeight - c.scrollTop < 30; });
await page.waitForTimeout(500);
if ((await chatAt()).newVisible) await fail("new-message button should hide at the bottom");
const before2 = await count();
await say("Another one at the bottom");
await page.waitForFunction((n) => document.querySelectorAll(".chat .msg").length > n, before2);
await page.waitForTimeout(300);
c = await chatAt();
if (c.end - c.top > 30 || c.newVisible) await fail("chat should follow new messages at the bottom", c);
// Worker drawer: scroll down, a live update arrives, the drawer stays put.
for (let i = 0; i < 25; i++) await beat("Alex", { status: "working", events: [{ kind: "tool", text: `bash: step ${i}` }] });
await page.click(`.member[data-person="${ids.Alex}"]`);
await page.setViewportSize({ width: 1400, height: 480 });
await page.waitForSelector(".drawer .scroll");
await page.waitForTimeout(300);
const dEnd = await page.evaluate(() => { const d = document.querySelector(".drawer .scroll"); d.scrollTop = 120; return d.scrollHeight - d.clientHeight; });
if (dEnd < 120) await fail("drawer too short to test scrolling", await page.evaluate(() => { const d = document.querySelector(".drawer .scroll"); return { sh: d.scrollHeight, ch: d.clientHeight, ev: d.querySelectorAll(".ev").length, dh: document.querySelector(".drawer").clientHeight }; }));
await beat("Alex", { status: "working", events: [{ kind: "tool", text: "bash: one more" }] });
await page.waitForTimeout(1200);
const dTop = await page.evaluate(() => document.querySelector(".drawer .scroll").scrollTop);
if (Math.abs(dTop - 120) > 2) await fail("worker drawer jumped on a live update", dTop);
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1400, height: 900 });

// Layout: the event board sits beside the office at the same height; the team and the
// project charts come below.
const lay = await page.evaluate(() => {
  const v = document.querySelector(".view-panel").getBoundingClientRect(), f = document.querySelector(".feed-panel").getBoundingClientRect();
  const t = document.querySelector(".team-panel").getBoundingClientRect(), c = document.querySelector(".charts-section").getBoundingClientRect();
  return { beside: f.left >= v.right - 1 && Math.abs(f.top - v.top) < 2, sameHeight: Math.abs(f.height - v.height) < 2, teamBelow: t.top >= v.bottom, chartsBelow: c.top >= t.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
});
if (!lay.beside || !lay.sameHeight || !lay.teamBelow || !lay.chartsBelow || lay.overflow) await fail("run layout wrong", lay);

// The page never jumps on live updates: scrolled down with a half-typed message, updates
// arrive (heartbeats, a new message), and the scroll position, focus and text stay.
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.click("#draft"); await page.keyboard.type("half typed");
const y0 = await page.evaluate(() => scrollY);
for (let i = 0; i < 3; i++) { await beat("Priya", { status: "working", events: [{ kind: "tool", text: `read: src/file${i}.ts`, ms: 40 }] }); await page.waitForTimeout(300); }
await say("Update while you scroll");
await page.waitForTimeout(800);
const kept = await page.evaluate(() => ({ y: scrollY, focus: document.activeElement?.id, text: document.getElementById("draft").value }));
if (Math.abs(kept.y - y0) > 2 || kept.focus !== "draft" || kept.text !== "half typed") await fail("the page jumped or lost your typing on a live update", { y0, ...kept });
await page.fill("#draft", "");

// The event board shows actions next to chat, and the filter narrows it.
await page.waitForFunction(() => document.querySelectorAll("#feed .act.tool").length >= 3);
if (!(await page.locator("#feed .act.tool", { hasText: "read: src/file2.ts" }).count())) await fail("tool action missing from the event board");
await page.click('[data-filter="actions"]');
if (await page.evaluate(() => [...document.querySelectorAll("#feed .msg")].some((m) => m.offsetParent))) await fail("Actions filter still shows chat");
await page.click('[data-filter="chat"]');
if (await page.evaluate(() => [...document.querySelectorAll("#feed .act")].some((m) => m.offsetParent))) await fail("Chat filter still shows actions");
await page.click('[data-filter="all"]');

// The CEO can be opened from the team list and from the office floor, and you can talk to them.
await page.click('.member[data-person="ceo"]');
await page.waitForSelector('.drawer[aria-label="CEO"] #wmsg');
const winY = await page.evaluate(() => scrollY);
await page.fill("#wmsg", "Please prioritise the login flow");
await page.click("#wsend");
await page.waitForFunction(() => /Please prioritise the login flow/.test(document.querySelector(".drawer .talk")?.textContent || ""));
if (shots) await page.screenshot({ path: join(shots, "ceo-drawer.png") });
const sent = (await api("GET", `/api/runs/${runId}`)).messages.filter((m) => m.sender === "human" && m.recipient === "ceo" && m.kind === "command" && /prioritise the login/.test(m.body));
if (sent.length !== 1) await fail("message to the CEO not sent once as a command", sent);
if (Math.abs((await page.evaluate(() => scrollY)) - winY) > 2) await fail("opening the CEO scrolled the page");
await page.keyboard.press("Escape");
await page.evaluate(() => window.scrollTo(0, 0));
const ceoAt = await page.evaluate(() => {
  const o = document.querySelector(".office-host").office, p = o.people.get("ceo"), f = p.feet(), { ox, oy } = o.camera.offset(), r = o.canvas.getBoundingClientRect();
  return { x: r.left + ox + f.x * o.camera.zoom, y: r.top + oy + (f.y - 14) * o.camera.zoom };
});
await page.mouse.click(ceoAt.x, ceoAt.y);
await page.waitForSelector('.drawer[aria-label="CEO"]', { timeout: 3000 }).catch(() => fail("clicking the CEO on the office floor did not open the CEO", ceoAt));
await page.keyboard.press("Escape");

// Charts: a second run with an approved plan and tasks moving through the board.
const plan = {
  title: "Shop checkout", summary: "Checkout for the shop.", goal: "Customers can pay.",
  techStack: [{ name: "FastAPI", package: "fastapi", ecosystem: "PyPI", usedFor: "API", uses: "FastAPI", source: "https://fastapi.tiangolo.com", verified: true }],
  architecture: { components: [{ id: "api", name: "API", kind: "service", tech: "FastAPI" }, { id: "db", name: "DB", kind: "db", tech: "Postgres" }], links: [{ from: "api", to: "db", label: "SQL" }] },
  stories: [{ id: "S1", title: "Pay", userStory: "As a customer, I want to pay.", acceptance: ["Card payments work"], tasks: [
    { id: "T1", title: "Cart API", description: "Cart endpoints.", estimateHours: 4 },
    { id: "T2", title: "Payments", description: "Stripe charge.", estimateHours: 6 },
    { id: "T3", title: "Receipts", description: "Email receipts.", estimateHours: 2 },
    { id: "T4", title: "Refunds", description: "Refund endpoint.", estimateHours: 3 }] }],
  risks: ["Card declines"], outOfScope: ["Crypto"],
};
const run2 = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Checkout" })).run.id;
const pl2 = await api("POST", `/api/runs/${run2}/plans`, { plan });
await api("POST", `/api/plans/${pl2.id}/decision`, { decision: "approve" });
const kim = (await api("POST", `/api/runs/${run2}/workers`, { name: "Kim", role: "backend developer", cwd: "/tmp/checkout", taskIds: ["T1", "T2", "T3"] })).id;
const lee = (await api("POST", `/api/runs/${run2}/workers`, { name: "Lee", role: "reviewer", cwd: "/tmp/checkout", taskIds: ["T4"] })).id;
const move = (task, status, actor, note) => api("POST", `/api/runs/${run2}/tasks/${task}`, { status, actor, note });
await move("T1", "in_progress", kim); await move("T1", "review", kim, "tests pass"); await move("T1", "done", lee, "reviewed the diff");
await move("T2", "in_progress", kim); await move("T4", "blocked", lee, "needs the payments API");
await api("POST", `/api/workers/${kim}/heartbeat`, { status: "working", events: [{ kind: "tool", text: "bash: pytest -q", ms: 1200, ok: true }, { kind: "tool", text: "bash: npm run build", ms: 900, ok: false }] });
await page.goto(`${base}/runs/${run2}`);
await page.waitForSelector(".chart");
const charts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".chart")].map((c) => [c.dataset.chart, { sub: c.querySelector(".chart-sub").textContent, svg: !!c.querySelector("svg"), legend: c.querySelector(".chart-legend")?.textContent || "" }])));
const keys = ["burndown", "flow", "throughput", "cycle", "workload", "status", "activity"];
if (keys.some((k) => !charts[k]?.svg)) await fail("charts missing", Object.keys(charts));
if (!/11h of 15h left · 1\/4 done/.test(charts.burndown.sub)) await fail("burndown numbers wrong", charts.burndown.sub);
if (!/1 done · 1 in flight · 1 blocked · 1 waiting/.test(charts.flow.sub)) await fail("cumulative flow numbers wrong", charts.flow.sub);
if (!/^1 task done/.test(charts.throughput.sub)) await fail("throughput wrong", charts.throughput.sub);
if (!/1 done/.test(charts.cycle.sub)) await fail("cycle time wrong", charts.cycle.sub);
if (!/2 people · 4 tasks · most open: Kim \(2\)/.test(charts.workload.sub)) await fail("workload wrong", charts.workload.sub);
if (!/1 of 4 tasks done · 1 blocked/.test(charts.status.sub)) await fail("status wrong", charts.status.sub);
if (!/2 tool calls/.test(charts.activity.sub)) await fail("activity wrong", charts.activity.sub);
// Moves show on the event board as actions, with the failed tool call in red; no duplicate task echoes.
const feed2 = await page.evaluate(() => ({ moves: [...document.querySelectorAll("#feed .act.move")].map((e) => e.textContent.replace(/\s+/g, " ")), bad: document.querySelectorAll("#feed .act.tool.bad").length, echoes: document.querySelectorAll("#feed .msg.task").length }));
if (feed2.moves.length !== 5 || !feed2.moves.some((m) => /Lee moved T4 Refunds: to do → blocked · needs the payments API/.test(m)) || feed2.bad !== 1 || feed2.echoes) await fail("event board actions wrong", feed2);
// Live: finishing another task updates the charts without a reload.
await move("T2", "review", kim, "done"); await move("T2", "done", lee, "checked");
await page.waitForFunction(() => /5h of 15h left · 2\/4 done/.test(document.querySelector('[data-chart="burndown"] .chart-sub')?.textContent || ""), null, { timeout: 5000 }).catch(async () => fail("charts did not update live", await page.textContent('[data-chart="burndown"] .chart-sub')));
if (shots) await page.locator(".charts-section").screenshot({ path: join(shots, "charts.png") });
if (shots) await page.screenshot({ path: join(shots, "run-page.png"), fullPage: true });
// Phone: one column, no sideways scroll.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(300);
if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) await fail("run page scrolls sideways on a phone");
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(`${base}/runs/${runId}`);
await page.waitForSelector(".office-host canvas");

// Dark theme renders the same rooms.
const dark = await open({ colorScheme: "dark" });
await dark.waitForTimeout(800);
await shot(dark, "dark");
await dark.close();

// Board: long unbreakable text (paths, package names) wraps inside the card instead of
// pushing it out of its column.
const spill = await page.evaluate(() => {
  const long = "apps/worker/app/deep_agent_runtime_adapter_with_a_very_long_name.py";
  const k = document.createElement("div");
  k.className = "kanban"; k.style.width = "900px";
  k.innerHTML = ["todo", "in_progress", "review", "blocked", "done"].map((c) => `<div class="col ${c}"><h3>${c}<span>1</span></h3><div class="cards"><button class="card"><div class="id">T1.1 · ${long}</div><div class="tt">Adopt deepagents and remove browser-use</div><div class="note">Starting: ${long} behind ${long}</div></button></div></div>`).join("");
  document.body.appendChild(k);
  const out = [...k.querySelectorAll(".col")].map((col) => { const c = col.getBoundingClientRect(), d = col.querySelector(".card").getBoundingClientRect(); return d.right - c.right; });
  k.remove();
  return out;
});
if (spill.some((d) => d > 0.5)) await fail("board cards overflow their columns", spill);

// No console errors so far.
if (errors.length) await fail("console errors", errors);

// Reduced motion: nobody runs off; activity and messages leave people where they are.
const still = await open({ reducedMotion: "reduce" });
const before = await who(still);
await act("Alex", "grep", "grep: orders");
await api("POST", `/api/runs/${runId}/messages`, { from: ids.Priya, to: ids.Alex, body: "Ready for review?" });
await still.waitForTimeout(2500);
const after = await who(still);
if (after.Alex.errand || after.Priya.errand || after.Alex.tile.x !== before.Alex.tile.x || after.Priya.tile.y !== before.Priya.tile.y) await fail("people moved under reduced motion", { before: before.Alex, after: after.Alex });
if (errors.length) await fail("console errors", errors);

await browser.close();
console.log("RedPi office UI test passed: files room for research, back to the desk for code, meeting room for talks with replies, YOU terminal, restless trips, coffee chats, reduced motion, board cards stay in their columns, chat and drawer keep your reading place, event board beside the office with filters, no page jumps, the CEO opens from the team and the floor and takes messages, live project charts.");
process.exit(0);
