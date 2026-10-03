#!/usr/bin/env node
// Chat UI test: a private hub (temp dir, random port) and headless Chromium. Seeds a run with the CEO, two
// workers and a long history, then uses the Slack-like Chat tab: channels and direct messages, grouped
// messages, unread badges (in the sidebar and on the tab), the New line, @mentions, drafts that survive
// live updates, read-only channels, full screen, Show more, loading earlier history, and a phone layout.
// Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("Chat UI test skipped: playwright is not installed (npm install)."); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "redpi-chat-test-"));
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

const runId = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Shop" })).run.id;
const ceoIn = () => api("POST", `/api/runs/${runId}/ceo-events`, { caps: ["aside", "reply", "ticket", "presence"] }).catch(() => {});
await ceoIn();
setInterval(ceoIn, 20_000).unref();
const hire = async (name, role) => { const w = await api("POST", `/api/runs/${runId}/workers`, { name, role, cwd: "/tmp/shop" }); await api("POST", `/api/workers/${w.id}/heartbeat`, { status: "working" }); return w; };
const alex = await hire("Alex", "backend developer"), mia = await hire("Mia", "frontend developer");
// A manager with one report: both show as a team (the report under its manager).
const nina = await api("POST", `/api/runs/${runId}/workers`, { name: "Nina", role: "security manager", cwd: "/tmp/shop", isManager: true, team: "Security" });
await api("POST", `/api/workers/${nina.id}/heartbeat`, { status: "idle" });
const ben = await api("POST", `/api/runs/${runId}/workers`, { name: "Ben", role: "security engineer", cwd: "/tmp/shop", from: nina.id });
await api("POST", `/api/workers/${ben.id}/heartbeat`, { status: "working" });
const send = (from, to, body, kind = "chat") => api("POST", `/api/runs/${runId}/messages`, { from, to, body, kind, needsReply: false });
// Old history: more than the run payload carries (300), so "Load earlier" has something to load.
for (let i = 1; i <= 320; i++) await send("ceo", "human", `Status ${i}: all good.`);
await send("ceo", "human", "Two things before lunch.");
await send("ceo", "human", "First: the cart API is merged.");
await send(alex.id, mia.id, "The cart endpoint returns {items, total}.");
await send(mia.id, alex.id, "Thanks, wiring the badge now.");
await send("ceo", alex.id, `Brief for T2.\n\n${"Details of the cart rules. ".repeat(80)}\n\nEND-OF-BRIEF`, "brief");

browser = await chromium.launch();
const errors = [];
const shots = process.env.REDPI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
async function open(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/net::ERR_(CONNECTION_CLOSED|ABORTED)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/runs/${runId}`);
  await page.waitForSelector("#form:not(.hide)");
  await page.fill("#user", "yitec"); await page.fill("#password", "password123"); await page.click("#go");
  await page.waitForSelector('[data-view="chat"]');
  return page;
}
const page = await open();
await page.click('[data-view="chat"]');
await page.waitForSelector(".cx-item[data-conv='dm:ceo'].on");
// Sidebar: channels, then a direct message with the CEO and each teammate.
const side = await page.$$eval(".cx-item", (els) => els.map((e) => e.dataset.conv));
if (side.join() !== `team,agents,hq,dm:ceo,dm:${nina.id},dm:${ben.id},dm:${alex.id},dm:${mia.id}`) await fail("the sidebar should list channels, then managers with their teams, then the rest", side);
if (!(await page.$(`.cx-item.report[data-conv="dm:${ben.id}"]`)) || !/manages Security/.test(await page.getAttribute(`.cx-item[data-conv="dm:${nina.id}"]`, "title"))) await fail("a report should sit under its manager");
const team = await page.$$eval("#team .member", (els) => els.map((e) => `${e.dataset.person}:${e.classList.contains("manager") ? "M" : e.classList.contains("report") ? "R" : "-"}`));
if (team.slice(1, 3).join() !== `${nina.id}:M,${ben.id}:R`) await fail("the team panel should show the manager, then their team", team);
// Grouping: the CEO's back-to-back messages share one header.
const lastGroup = await page.$$eval(".cx-g", (gs) => { const g = gs.at(-1); return { name: g.querySelector(".cx-gh b, .cx-from")?.textContent, n: g.querySelectorAll(".cx-m").length }; });
if (lastGroup.name !== "CEO" || lastGroup.n < 2) await fail("consecutive messages from one sender should be grouped", lastGroup);
if (!(await page.$(".cx-day"))) await fail("messages should have a day divider");

// Unread: a message from Alex while you read the CEO's DM shows a badge on Alex; the Chat tab counts it while on Board.
await send(alex.id, "human", "Quick one: should the cart keep items for guests?");
await page.waitForFunction((id) => document.querySelector(`.cx-item[data-conv="dm:${id}"] .cx-badge`)?.textContent === "1", alex.id);
await page.click('[data-view="board"]');
await send(alex.id, "human", "Also: the cart total excludes tax for now.");
await page.waitForFunction(() => document.querySelector('[data-view="chat"] .tab-count')?.textContent === "2");
await page.click('[data-view="chat"]');
await page.click(`.cx-item[data-conv="dm:${alex.id}"]`);
await page.waitForSelector(".cx-unread-line");
await page.waitForFunction((id) => !document.querySelector(`.cx-item[data-conv="dm:${id}"] .cx-badge`), alex.id);
if (await page.$('[data-view="chat"] .tab-count')) await fail("reading the conversation should clear the tab's badge");
if (!/backend developer/.test(await page.textContent(".cx-head"))) await fail("a DM header should show the person's role");

// Composer: @mention, a draft that survives a live update, Enter sends to Alex, then the pending note.
await page.click(".cx-compose textarea");
await page.keyboard.type("Yes for 7 days, ask @Mi");
await page.waitForSelector(".cx-mention:not([hidden]) .cx-opt[data-name='Mia']");
await page.keyboard.press("Enter");
if ((await page.inputValue(".cx-compose textarea")) !== "Yes for 7 days, ask @Mia ") await fail("picking a mention should insert the name", await page.inputValue(".cx-compose textarea"));
await page.keyboard.type("about the badge.");
await send(mia.id, alex.id, "Badge done.");   // a live update while typing
await page.waitForTimeout(800);
if ((await page.inputValue(".cx-compose textarea")) !== "Yes for 7 days, ask @Mia about the badge.") await fail("a live update should keep the draft");
await page.keyboard.press("Enter");
await page.waitForFunction(() => /quick answer comes in a few seconds/.test(document.querySelector(".cx-pending")?.textContent || ""));
const sent = (await api("GET", `/api/runs/${runId}`)).messages.at(-1);
if (sent.recipient !== alex.id || sent.body !== "Yes for 7 days, ask @Mia about the badge." || sent.kind !== "command") await fail("Enter should send to Alex", sent);
if ((await page.inputValue(".cx-compose textarea")) !== "") await fail("sending should clear the box");
// The brief is long: collapsed with Show more.
await page.click(".cx-item[data-conv='agents']");
await page.waitForSelector(".cx-m.long .cx-more");
if (!/Alex → Mia|→ Mia/.test(await page.textContent(".cx-list"))) await fail("#agents should show who talks to whom");
if (!(await page.$(".cx-ro"))) await fail("#agents should be read-only");
await page.click(".cx-m.long .cx-more");
if (!(await page.isVisible(".cx-m.long.open"))) await fail("Show more should expand the message");
await snap(page, "chat-agents");
// #team: posting reaches everyone.
await page.click(".cx-item[data-conv='team']");
await page.fill(".cx-compose textarea", "Demo at 4pm, please have the cart ready.");
await page.click(".cx-acts [data-send='command']");
await page.waitForFunction(() => /Demo at 4pm/.test(document.querySelector(".cx-list")?.textContent || ""));
if ((await api("GET", `/api/runs/${runId}`)).messages.at(-1).recipient !== "all") await fail("#team should post to everyone");
// Full screen and back.
await page.click(".cx-full");
const full = await page.evaluate(() => { const r = document.querySelector(".view-panel").getBoundingClientRect(); return document.body.classList.contains("chat-full") && r.top === 0 && Math.round(r.width) === innerWidth; });
if (!full) await fail("full screen should cover the window");
await page.click(`.cx-item[data-conv="dm:${alex.id}"]`);
await snap(page, "chat-full");
await page.keyboard.press("Escape");
if (await page.evaluate(() => document.body.classList.contains("chat-full"))) await fail("Esc should leave full screen");
// Earlier history: the CEO's DM loads what the run payload did not carry.
await page.click(".cx-item[data-conv='dm:ceo']");
await page.waitForSelector(".cx-earlier");
const before = await page.$$eval(".cx-m", (els) => els.length);
await page.click(".cx-earlier");
await page.waitForFunction((n) => document.querySelectorAll(".cx-m").length > n, before);
if (!(await page.textContent(".cx-list")).includes("Status 1: all good.")) await fail("loading earlier should reach the first message");
if (await page.$(".cx-earlier")) await fail("once everything is loaded the button should go");

// Phone width: the conversation list first, then a conversation with a way back; nothing wider than the screen.
const phone = await open({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
await phone.tap('[data-view="chat"]');
await phone.waitForSelector(".cx-side .cx-item");
if (await phone.isVisible(".cx-main")) await fail("on a phone the conversation list comes first");
await phone.tap(`.cx-item[data-conv="dm:${mia.id}"]`);
await phone.waitForSelector(".cx-back");
if (!(await phone.isVisible(".cx-compose textarea"))) await fail("the conversation should open with its composer");
const wide = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
if (wide > 1) await fail(`the phone layout scrolls sideways by ${wide}px`);
await snap(phone, "chat-phone");
await phone.tap(".cx-back");
await phone.waitForSelector(".cx-side .cx-item");

const real = errors.filter((e) => !/Failed to load resource.*(401|404)/.test(e));
if (real.length) await fail("console errors", real);
await browser.close();
console.log("Chat UI test passed: channels and direct messages (managers with their teams), grouped messages with day dividers, unread badges in the sidebar and on the tab, the New line, @mentions, drafts kept through live updates, Enter sends with a pending note, read-only #agents with Show more, #team posts to everyone, full screen, earlier history, and the phone layout.");
process.exit(0);
