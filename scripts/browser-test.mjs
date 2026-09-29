// Browser CLI: the page stays open between commands, and commands wait until it is really ready
// (slow API behind a spinner, late images), report what is still loading when it never settles,
// keep what a click opened for the next command, collect errors logged between commands, set phone
// width, and explain a dev server that is down. Uses its own browser folder; needs Playwright Chromium.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "redpi-browser-test-"));
const env = { ...process.env, REDPI_BROWSER_DIR: join(dir, "browser"), REDPI_BROWSER_READY_MS: "12000" };
delete env.REDPI_HQ_WORKER;
let server;
const done = async (code) => { await cli("reset"); server?.close(); rmSync(dir, { recursive: true, force: true }); process.exit(code); };
const fail = async (msg, extra) => { console.error("FAIL:", msg, "\n", extra ?? ""); await done(1); };
// Async: the test's own page server must keep answering while a command runs.
function cli(...args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(root, "scripts/redpi-browser.js"), ...args], { env });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => c.kill("SIGKILL"), 70000);
    c.on("close", (status) => { clearTimeout(kill); resolve({ out, status }); });
  });
}

const png = (w, h) => {
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])) >>> 0, 8 + d.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w * 3 + 1) * h, 90))), chunk("IEND", Buffer.alloc(0))]);
};
const pages = {
  "/slow": `<!doctype html><title>Slow</title><div class="spinner">Loading…</div><ul id="list"></ul><img src="/img.png" width="200" height="100">
<script>fetch('/api/data').then(r => r.json()).then(d => { document.querySelector('.spinner').remove(); document.getElementById('list').innerHTML = d.items.map(i => '<li>' + i + '</li>').join(''); document.body.insertAdjacentHTML('beforeend', '<p>Loaded ' + d.items.length + ' items</p>'); });</script>`,
  "/modal": `<!doctype html><title>Modal</title><button onclick="document.body.insertAdjacentHTML('beforeend','<div role=dialog>Hello modal</div>')">Open</button>`,
  "/busy": `<!doctype html><title>Busy</title><p id="t">0</p><script>setTimeout(() => fetch('/api/hang'), 100);</script>`,
  "/late": `<!doctype html><title>Late</title><p>quiet page</p><script>setTimeout(() => console.error('late boom'), 2500);</script>`,
};
server = createServer((req, res) => {
  if (req.url === "/api/data") return setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ items: ["a", "b", "c"] })); }, 1500);
  if (req.url === "/img.png") return setTimeout(() => { res.setHeader("content-type", "image/png"); res.end(png(200, 100)); }, 800);
  if (req.url === "/api/hang") return;   // never answers
  res.setHeader("content-type", "text/html"); res.end(pages[req.url] || "<p>404</p>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// 1. A slow API behind a spinner and a late image: goto waits for the real content.
let r = await cli("goto", `${base}/slow`);
if (/Executable doesn't exist|Playwright is not installed/.test(r.out)) { console.log("Browser test skipped: Playwright Chromium is not installed."); await done(0); }
if (!/^ready: page fully loaded/m.test(r.out) || !r.out.includes("Loaded 3 items") || r.out.includes("Loading…")) await fail("goto should wait until the data rendered", r.out);
const state = () => JSON.parse(readFileSync(join(dir, "browser", "state.json"), "utf8"));
const pid = state().cdp?.pid;
// 2. A screenshot right after is of the finished page, from the same browser (no reload).
r = await cli("screenshot", join(dir, "a.png"));
if (!/ready: page fully loaded/.test(r.out) || state().cdp?.pid !== pid) await fail("screenshot should reuse the open browser and be ready", r.out);
const shot = readFileSync(join(dir, "a.png"));
if (shot.readUInt32BE(16) !== 1280 || shot.readUInt32BE(20) !== 900) await fail("default screenshot is the 1280×900 visible area", [shot.readUInt32BE(16), shot.readUInt32BE(20)]);
// 3. What a click opens is still there for the next command.
await cli("goto", `${base}/modal`);
r = await cli("click", "text=Open");
if (!r.out.includes("Hello modal")) await fail("click should show the dialog", r.out);
r = await cli("text");
if (!r.out.includes("Hello modal")) await fail("the dialog should still be open in the next command (no reload)", r.out);
// 4. A page that never settles: reported as not ready, with the reason, within the timeout.
const t0 = Date.now();
r = await cli("goto", `${base}/busy`, "--timeout", "2500");
if (!/NOT READY after \d+s: 1 request still loading \(GET .*\/api\/hang\)/.test(r.out) || Date.now() - t0 > 15000) await fail("a page that never settles should say what is still loading", r.out);
// 5. An error logged after the command returned is still collected.
await cli("goto", `${base}/late`);
await new Promise((res) => setTimeout(res, 3000));
r = await cli("errors");
if (!r.out.includes("late boom")) await fail("errors logged between commands should be collected", r.out);
// 6. Phone width sticks for later commands and screenshots.
r = await cli("viewport", "phone");
if (!r.out.includes("viewport: 390×844")) await fail("viewport phone", r.out);
r = await cli("eval", "innerWidth");
if (r.out.trim() !== "390") await fail("phone width should persist", r.out);
await cli("screenshot", join(dir, "p.png"));
if (readFileSync(join(dir, "p.png")).readUInt32BE(16) !== 390) await fail("phone screenshot width");
// 7. A dev server that is down gets a plain explanation.
const closed = await new Promise((res) => { const t = createServer(); t.listen(0, "127.0.0.1", () => { const port = t.address().port; t.close(() => res(port)); }); });
r = await cli("goto", `http://127.0.0.1:${closed}/`);
if (r.status === 0 || !/connection refused\. Is the dev server running/.test(r.out)) await fail("connection refused should be explained", r.out);
// 8. reset closes the browser.
await cli("reset");
await new Promise((res) => setTimeout(res, 500));
let running = true; try { process.kill(pid, 0); } catch { running = false; }
if (running) await fail("reset should close the browser");

console.log("Browser test passed: pages are ready before text and screenshots (slow API, spinner, late image), the browser and page stay open between commands, never-settling pages say what is loading, late errors are collected, phone width sticks, a down dev server is explained, reset closes it.");
await done(0);
