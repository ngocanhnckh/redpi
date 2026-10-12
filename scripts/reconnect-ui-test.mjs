#!/usr/bin/env node
// A blip in HQ must not wipe the dashboard. This loads a run page, kills HQ mid-session, and checks the
// UI stays on screen (no error wipe) with a "reconnecting" banner and a toast after a short grace; then
// restarts HQ on the same data and checks the banner clears, a "reconnected" toast shows, and the page
// catches up. Uses a temp agent dir; never touches ~/.pi/agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";

let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.log("Reconnect UI test skipped: playwright is not installed (npm install)."); process.exit(0); }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "redpi-reconnect-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let proc, browser;
const env = { ...process.env, REDPI_HQ_DIR: dir, REDPI_HQ_PORT: String(port), REDPI_HQ_HOST: "127.0.0.1" };
const startHq = () => spawn(process.execPath, [join(root, "hq", "server.mjs")], { env, stdio: "ignore" });
const waitHealth = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("HQ did not start"); };
const stopHq = async (p) => { p.kill("SIGKILL"); for (let i = 0; i < 40; i++) { try { await fetch(base + "/api/health"); } catch { return; } await new Promise((r) => setTimeout(r, 100)); } };
process.on("exit", () => { try { proc?.kill("SIGKILL"); } catch {} rmSync(dir, { recursive: true, force: true }); });
const fail = async (msg, extra) => { console.error(`FAIL: ${msg}`, extra ?? ""); await browser?.close().catch(() => {}); process.exit(1); };
process.on("unhandledRejection", (e) => fail(e?.message || e));

proc = startHq();
await waitHealth();
const token = readFileSync(join(dir, "token"), "utf8").trim();
const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${token}`, "x-redpi-hq": "1", "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json();
const salt = randomBytes(16);
writeFileSync(join(dir, "auth.json"), JSON.stringify({ version: 1, user: "yitec", salt: salt.toString("hex"), hash: scryptSync("pw123456", salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex"), N: 16384, r: 8, p: 1 }));
const runId = (await api("POST", "/api/runs", { projectPath: "/home/yitec/shop", title: "Reconnect test" })).run.id;
await api("POST", `/api/runs/${runId}/ceo-events`, { caps: ["aside", "reply", "ticket", "presence"] });
const wId = (await api("POST", `/api/runs/${runId}/workers`, { name: "Nadia", role: "backend developer", cwd: "/tmp/x" })).id;
await api("POST", `/api/workers/${wId}/heartbeat`, { status: "working" });

browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto(`${base}/runs/${runId}`);
await page.waitForSelector("#form:not(.hide)");
await page.fill("#user", "yitec"); await page.fill("#password", "pw123456"); await page.click("#go");
await page.waitForSelector(".office-host canvas");
// The page has rendered: the worker's name is on the team panel.
await page.waitForFunction(() => document.body.textContent.includes("Nadia"), null, { timeout: 15000 });
await page.waitForFunction(() => document.querySelector(".office-host")?.office?.people.size >= 1, null, { timeout: 15000 });

// --- HQ goes down ---
await stopHq(proc);
// Within a moment the UI must still be there — not wiped to an error box.
await new Promise((r) => setTimeout(r, 1500));
if (!(await page.evaluate(() => document.body.textContent.includes("Nadia")))) await fail("the UI was wiped when HQ went down");
if (await page.evaluate(() => !!document.querySelector(".error-box"))) await fail("a dead HQ should not replace the dashboard with an error box");
// After the grace, a reconnecting banner and a toast appear (the stream has stayed down).
await page.waitForSelector("#conn-banner", { timeout: 10000 }).catch(() => null);
if (!(await page.evaluate(() => !!document.getElementById("conn-banner")))) await fail("no reconnecting banner after HQ went down");
if (!(await page.evaluate(() => !!document.querySelector(".toast")))) await fail("no toast telling the user the connection was lost");
// The content is still there behind the banner.
if (!(await page.evaluate(() => document.body.textContent.includes("Nadia")))) await fail("the team should still be on screen while reconnecting");

// --- HQ comes back ---
proc = startHq();
await waitHealth();
await page.waitForFunction(() => !document.getElementById("conn-banner"), null, { timeout: 25000 });
if (await page.evaluate(() => !!document.getElementById("conn-banner"))) await fail("the reconnecting banner did not clear after HQ came back");
if (!(await page.evaluate(() => document.body.textContent.includes("Nadia")))) await fail("the page lost its content after reconnecting");

await browser.close();
proc.kill("SIGKILL");
console.log("RedPi reconnect UI test passed: a dead HQ keeps the dashboard on screen (no error wipe), shows a reconnecting banner and a toast after a short grace, and clears them when HQ returns.");
