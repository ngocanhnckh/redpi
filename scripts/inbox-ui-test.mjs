#!/usr/bin/env node
// Inbox UI test: a private hub (temp dir, random port) and headless Chromium. Seeds a blocker on the human,
// an agent's question and a plan waiting for approval, then answers them in the browser: from the Needs-you
// strip into the run's Inbox tab, live updates that keep what you are typing, the /inbox page across
// projects with the header badge, and a phone-width layout. Never touches ~/.pi/agent.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("Inbox UI test skipped: playwright is not installed (npm install)."); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "redpi-inbox-test-"));
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

const plan = (title) => ({
  title, summary: "A small shop with a cart and checkout.",
  techStack: [{ name: "Node", package: "node", ecosystem: "npm", uses: "http", source: "https://nodejs.org", verified: true, verifiedFact: "exists" }],
  architecture: { components: [{ id: "api", name: "API", kind: "service" }], links: [] },
  stories: [{ id: "S1", title: "Cart", userStory: "As a shopper, I want a cart", acceptance: ["add and remove items"], tasks: [
    { id: "T1", title: "Payments", description: "Stripe checkout", estimateHours: 3 },
    { id: "T2", title: "Cart API", description: "REST", estimateHours: 2 },
  ] }],
});
// Run 1: approved, a worker blocked on the human, and a question from the CEO.
const runId = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Shop" })).run.id;
const ceoIn = (id) => api("POST", `/api/runs/${id}/ceo-events`, { caps: ["aside", "reply", "ticket", "presence"] }).catch(() => {});
await ceoIn(runId);
setInterval(() => ceoIn(runId), 20_000).unref();
const pv = await api("POST", `/api/runs/${runId}/plans`, { plan: plan("Shop") });
await api("POST", `/api/plans/${pv.id}/decision`, { decision: "approve" });
await api("PATCH", `/api/runs/${runId}`, { status: "executing" });
const ana = await api("POST", `/api/runs/${runId}/workers`, { name: "Ana", role: "backend developer", cwd: "/tmp/shop", taskIds: ["T1"] });
await api("POST", `/api/workers/${ana.id}/heartbeat`, { status: "working" });
await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "in_progress", actor: ana.id, workerId: ana.id });
await api("POST", `/api/runs/${runId}/tasks/T1`, { status: "blocked", note: "I need the **Stripe live key** to finish checkout. Test keys work; live checkout needs yours.", waitingOn: "human", actor: "ceo" });
// Run 2 (another project): a plan waiting for approval.
const run2 = (await api("POST", "/api/runs", { projectPath: "/home/yitec/blog", title: "Blog" })).run.id;
const pv2 = await api("POST", `/api/runs/${run2}/plans`, { plan: plan("Blog") });

browser = await chromium.launch();
const errors = [];
const shots = process.env.REDPI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const snap = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
async function open(path, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/net::ERR_(CONNECTION_CLOSED|ABORTED)/.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}${path}`);
  await page.waitForSelector("#form:not(.hide)");
  await page.fill("#user", "yitec"); await page.fill("#password", "password123"); await page.click("#go");
  return page;
}

// 1. The run page: no alert strip; the Inbox tab counts the blocker, and opening it shows the ticket.
let page = await open(`/runs/${runId}`);
await page.waitForFunction(() => document.querySelector('[data-view="inbox"]')?.textContent.trim() === "Inbox 1");
if (await page.$(".needs, .needs-item")) await fail("there should be no Needs-you strip on the run page");
if (await page.$(".run-head .pill.red")) await fail("a connected CEO should show no warning");
await page.waitForFunction(() => document.getElementById("inbox-count")?.textContent === "2");   // header: every project
await page.click('[data-view="inbox"]');
await page.waitForSelector(".ib-detail.has .ib-dt");
if ((await page.textContent(".ib-dt")) !== "T1 Payments") await fail("the ticket should open", await page.textContent(".ib-dt"));
if (!(await page.innerHTML(".ib-body")).includes("<strong>Stripe live key</strong>")) await fail("the ticket body should render markdown");
if ((await page.textContent(".ib-row.on .ib-status")) !== "Waiting on you") await fail("an open ticket waits on you");
await snap(page, "inbox-run");

// 2. A live update while typing: a new question arrives; the draft stays.
await page.fill(".ib-compose textarea", "It is in 1Password under Stripe / live.");
await api("POST", `/api/runs/${runId}/messages`, { from: "ceo", to: "human", kind: "chat", body: "Should checkout also offer PayPal?" });
await page.waitForFunction(() => [...document.querySelectorAll(".ib-row .ib-title b")].some((b) => b.textContent === "Should checkout also offer PayPal?"));
if ((await page.inputValue(".ib-compose textarea")) !== "It is in 1Password under Stripe / live.") await fail("a live update should keep what you are typing");
// Unblock with the answer: the task goes back to work and Ana gets it.
await page.click('.ib-acts [data-act="unblock"]');
await page.waitForFunction(() => /^Resolved/.test(document.querySelector(".ib-res")?.textContent || ""));
const t1 = (await api("GET", `/api/runs/${runId}`)).tasks.find((t) => t.id === "T1");
if (t1.status !== "in_progress") await fail("Unblock should put T1 back to work", t1);
const anaInbox = await api("GET", `/api/runs/${runId}/inbox?for=${ana.id}&after=0`);
if (!anaInbox.some((m) => /The human unblocked T1\.\nIt is in 1Password under Stripe \/ live\./.test(m.body))) await fail("Ana should get the answer");
// Reply to the question: it waits on the CEO, and the CEO's answer closes it.
await page.click(".ib-tabs [data-ibf='open']");
await page.click(".ib-row[data-ib]");
await page.fill(".ib-compose textarea", "Not yet: card only for launch.");
await page.keyboard.press("Control+Enter");
await page.waitForFunction(() => /Waiting on CEO/.test(document.querySelector(".ib-detail .ib-dh")?.textContent || ""));
await api("POST", `/api/runs/${runId}/messages`, { from: "ceo", to: "human", kind: "reply", body: "Understood: card only. Noted in the ADR." });
await page.waitForFunction(() => document.querySelectorAll(".ib-thread .ib-c").length === 2 && /Resolved/.test(document.querySelector(".ib-dh")?.textContent || ""));
await snap(page, "inbox-thread");
if ((await page.textContent('[data-view="inbox"]')).trim() !== "Inbox") await fail("nothing should wait on you in this run now");

// 3. /inbox: every project's tickets, with the plan approval from the other project; approve it there.
page = await open("/inbox");
await page.waitForSelector(".inbox-page .ib-row[data-ib]");
const rows = await page.$$eval(".ib-row[data-ib] .ib-sub", (els) => els.map((e) => e.textContent));
if (!rows.some((r) => /blog \/ Blog/.test(r))) await fail("the inbox page should show each ticket's project and run", rows);
if ((await page.textContent("#inbox-count")) !== "1") await fail("the header badge should count open tickets", await page.textContent("#inbox-count"));
await page.waitForSelector(".ib-detail.has .ib-dt");
if (!/^Approve plan v1: Blog/.test(await page.textContent(".ib-dt"))) await fail("the open plan approval should be selected first", await page.textContent(".ib-dt"));
if (!(await page.$(`.ib-meta a[href="/plans/${pv2.id}"]`))) await fail("a plan approval should link to the plan page");
await snap(page, "inbox-page");
await page.click('.ib-acts [data-act="approve"]');
await page.waitForFunction(() => /Approved/.test(document.querySelector(".ib-dh")?.textContent || ""));
if ((await api("GET", `/api/runs/${run2}`)).plan.status !== "approved") await fail("approving in the inbox should approve the plan");
await page.waitForFunction(() => document.getElementById("inbox-count")?.hidden);

// 4. Phone width: the list, then the ticket full screen with a way back; nothing wider than the screen.
await api("POST", `/api/runs/${runId}/inbox`, { from: ana.id, kind: "approval", body: "Drop the legacy orders table? It only has test rows.", taskId: "T1" });
page = await open("/inbox", { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
await page.waitForSelector(".ib-row[data-ib]");
if (await page.$(".ib-detail.has")) await fail("on a phone the list comes first");
await page.tap(".ib-row[data-ib]");
await page.waitForSelector(".ib-detail.has .ib-back");
const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
if (wide > 1) await fail(`the phone layout scrolls sideways by ${wide}px`);
await snap(page, "inbox-phone");
await page.tap(".ib-back");
await page.waitForSelector(".ib-detail:not(.has)", { state: "attached" });

const real = errors.filter((e) => !/Failed to load resource.*(401|404)/.test(e));
if (real.length) await fail("console errors", real);
await browser.close();
console.log("Inbox UI test passed: no alert strip, the Inbox tab and header badge count what waits on you, live updates keep your draft, Unblock and Reply reach the right agent and the thread updates live, /inbox shows every project and approves a plan, and the phone layout works.");
process.exit(0);
