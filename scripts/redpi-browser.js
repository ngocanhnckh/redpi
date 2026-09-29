#!/usr/bin/env node
/**
 * RedPi browser CLI: compact Playwright automation without MCP context bloat.
 *
 * One real Chromium stays open between commands (reached over the DevTools protocol), so a page
 * keeps its state from one command to the next: a click that opens a dialog is still open for the
 * screenshot. Every command that shows the page first waits until it is actually ready (load event,
 * network quiet, fonts, visible images, no spinner, DOM settled) and says so, or says what is still
 * loading. The browser closes itself after REDPI_BROWSER_IDLE_MIN minutes unused (default 30).
 *
 * Usage examples:
 *   redpi-browser.js goto https://example.com
 *   redpi-browser.js text --max 4000
 *   redpi-browser.js click 'text=Sign in'
 *   redpi-browser.js type '#q' 'hello world' --submit
 *   redpi-browser.js viewport phone
 *   redpi-browser.js screenshot /tmp/page.png [--full]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
// Each RedPlan worker gets its own browser, so teammates never drive each other's page.
const WORKER = String(process.env.REDPI_HQ_WORKER || '').replace(/[^\w.-]/g, '');
const STATE_DIR = process.env.REDPI_BROWSER_DIR || path.join(AGENT_DIR, 'yitec', 'browser', ...(WORKER ? ['workers', WORKER] : []));
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const PROFILE = path.join(STATE_DIR, 'profile');
const DEFAULT_TIMEOUT = Number(process.env.REDPI_BROWSER_TIMEOUT || 15000);
const READY_MS = Number(process.env.REDPI_BROWSER_READY_MS || 15000);
const IDLE_MS = Number(process.env.REDPI_BROWSER_IDLE_MIN || 30) * 60 * 1000;
const HEADLESS = process.env.REDPI_BROWSER_HEADLESS !== 'false';
const SIZES = { desktop: [1280, 900], laptop: [1440, 900], tablet: [768, 1024], phone: [390, 844] };
const DEFAULT_SIZE = [Number(process.env.REDPI_BROWSER_WIDTH || 1280), Number(process.env.REDPI_BROWSER_HEIGHT || 900)];
const FULL_MAX_PX = 12000;
// Hard cap for one command, so a page that never settles cannot hang the caller.
const MAX_RUNTIME = Number(process.env.REDPI_BROWSER_MAX_MS || 50000);

function usage(code = 0) {
  console.log(`RedPi browser CLI

The browser stays open between commands, so the page keeps its state. Commands that show the page
wait until it is fully loaded first and report "ready", or what is still loading.

Commands:
  goto <url> [--max N]              open a page, wait until it is ready, show its text
  text [--max N]                    visible text of the current page
  html [--max N]
  title
  click <selector> [--max N]        click, then wait until the page is ready again
  type <selector> <text> [--submit] [--max N]
  wait-for <selector>               wait until an element is visible, then until ready
  wait-for-text <text> [--max N]
  ready [--timeout MS]              wait until the page is fully loaded and report
  reload | back
  viewport [WxH | phone | tablet | laptop | desktop]   show or set the window size
  screenshot <path> [--full]        visible area (or the whole page) once the page is ready
  eval <javascript> [--max N]
  console | errors | network [--max N]
  close                             close the browser (keeps logins)
  reset                             close it and forget everything (logins, history)

Options: --timeout MS limits the wait for readiness (default ${READY_MS}).
Selectors use Playwright syntax: text=Login, role=button[name="Save"], css selectors, etc.`);
  process.exit(code);
}
function parse(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const opts = { max: 3000, submit: false, full: false, timeout: READY_MS };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max') opts.max = Number(args[++i] || opts.max);
    else if (args[i] === '--timeout') opts.timeout = Number(args[++i] || opts.timeout);
    else if (args[i] === '--submit') opts.submit = true;
    else if (args[i] === '--full') opts.full = true;
    else rest.push(args[i]);
  }
  return { cmd, args: rest, opts };
}
function clip(s, max) {
  s = String(s ?? '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return s.length > max ? s.slice(0, max) + `\n… clipped (${s.length} chars total)` : s;
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(v) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}
function pushLog(state, key, value, limit = 120) {
  state[key] = Array.isArray(state[key]) ? state[key] : [];
  state[key].push({ at: new Date().toISOString(), ...value });
  if (state[key].length > limit) state[key] = state[key].slice(-limit);
}
function formatLogs(items, max) {
  if (!items?.length) return 'none';
  return clip(items.map((x, i) => `${i + 1}. ${x.at || ''} ${x.type || x.status || ''} ${x.url || ''}\n${x.text || x.error || x.method || ''}`).join('\n\n'), max);
}
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One command at a time per browser (several Pi sessions can share one): a folder lock.
async function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = path.join(STATE_DIR, '.lock');
  const until = Date.now() + MAX_RUNTIME;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > MAX_RUNTIME + 10000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() > until) throw new Error('the browser is busy with another command');
      await sleep(100);
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

async function getPlaywright() {
  try { return require('playwright'); }
  catch (e) {
    console.error('Playwright is not installed. From the RedPi checkout run: npm install && npx playwright install chromium');
    console.error('If installed as a Pi package, run npm install in the package checkout or reinstall RedPi after dependencies are added.');
    process.exit(2);
  }
}

function stopBrowser(state) {
  const pid = state.cdp?.pid;
  if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  delete state.cdp;
}

const chromiumLog = (f) => { try { return (fs.readFileSync(f, 'utf8').split('\n').find((l) => /FATAL|ERROR/.test(l)) || 'no output').slice(0, 400); } catch { return 'no output'; } };

// Start Chromium once, detached, with the DevTools port on localhost; later commands reconnect.
async function startBrowser(pw, state) {
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(PROFILE, f), { force: true });
  const exe = process.env.REDPI_BROWSER_EXECUTABLE || pw.chromium.executablePath();
  if (!fs.existsSync(exe)) throw new Error(`Executable doesn't exist at ${exe}. Run: npx playwright install chromium`);
  const [w, h] = state.viewport || DEFAULT_SIZE;
  const args = [
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    // Quiet like Playwright's own launch: no extensions, sync, updates or background fetches.
    '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-default-apps', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--no-service-autorun', '--password-store=basic', '--disable-popup-blocking',
    // A headless page must keep running timers and rendering at full speed between commands.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${w},${h}`, ...(HEADLESS ? ['--headless=new', '--hide-scrollbars'] : []),
    // Like Playwright's default launch: many distros block Chromium's user-namespace sandbox.
    ...(process.env.REDPI_BROWSER_SANDBOX === '1' ? [] : ['--no-sandbox']), 'about:blank',
  ];
  const logFile = path.join(STATE_DIR, 'chromium.log');
  const log = fs.openSync(logFile, 'w');
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.unref();
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  const until = Date.now() + 20000;
  let port = 0;
  while (!port && Date.now() < until) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Chromium exited at startup: ${chromiumLog(logFile)}`);
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch {}
    if (!port) await sleep(50);
  }
  if (!port) { try { process.kill(child.pid); } catch {} throw new Error(`Chromium did not start within 20s: ${chromiumLog(logFile)}`); }
  state.cdp = { pid: child.pid, port, started: new Date().toISOString() };
  state.viewport = [w, h];
  state.usedAt = Date.now();
  writeState(state);
  // A small watcher closes the browser after it has been idle for a while.
  spawn(process.execPath, [__filename, '__keeper'], { detached: true, stdio: 'ignore', env: { ...process.env, REDPI_BROWSER_DIR: STATE_DIR } }).unref();
  // The DevTools port is announced a moment before it accepts connections.
  for (let i = 0; ; i++) {
    try { return await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }); }
    catch (e) { if (i >= 20 || !alive(child.pid)) throw e; await sleep(150); }
  }
}

async function connect(pw, state) {
  if (state.cdp?.port && alive(state.cdp.pid)) {
    try { return { browser: await pw.chromium.connectOverCDP(`http://127.0.0.1:${state.cdp.port}`, { timeout: 5000 }), fresh: false }; }
    catch { stopBrowser(state); }
  } else delete state.cdp;
  return { browser: await startBrowser(pw, state), fresh: true };
}

// In-page recorder for what happens between commands (while no command is attached).
const HOOK = `(() => {
  if (window.__redpi) return;
  const log = window.__redpi = [];
  const push = (type, text) => { if (log.length < 200) log.push({ type, text: String(text).slice(0, 2000), url: location.href, at: new Date().toISOString() }); };
  for (const k of ['error', 'warn']) {
    const orig = console[k];
    console[k] = function (...a) { push(k === 'warn' ? 'warning' : 'error', a.map((x) => { try { return typeof x === 'string' ? x : x instanceof Error ? (x.stack || x.message) : JSON.stringify(x); } catch { return String(x); } }).join(' ')); return orig.apply(this, a); };
  }
  addEventListener('error', (e) => push('pageerror', e.message || (e.target && (e.target.src || e.target.href) ? 'failed to load ' + (e.target.src || e.target.href) : 'error')), true);
  addEventListener('unhandledrejection', (e) => push('pageerror', 'Unhandled rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
  window.__redpiLastChange = performance.now();
  new MutationObserver(() => { window.__redpiLastChange = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})()`;

async function withPage(fn) {
  return withLock(async () => {
    const pw = await getPlaywright();
    const state = readState();
    const { browser, fresh } = await connect(pw, state);
    const ctx = browser.contexts()[0] || await browser.newContext();
    // Only real tabs: not Chromium's own UI pages (toolbar, omnibox) or extensions.
    const pages = ctx.pages().filter((p) => !/^(chrome|chrome-extension|chrome-untrusted|devtools):/.test(p.url()));
    let page = pages.find((p) => state.url && p.url() === state.url) || pages[pages.length - 1] || await ctx.newPage();
    await page.bringToFront().catch(() => {});
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    // Requests in flight, for "network quiet" (streams such as SSE and websockets never finish, so they do not count).
    const inflight = new Map();
    const watch = (p) => {
      p.on('console', (msg) => pushLog(state, 'console', { type: msg.type(), text: msg.text().slice(0, 2000), url: p.url() }));
      p.on('pageerror', (err) => pushLog(state, 'errors', { type: 'pageerror', error: err.message, url: p.url() }));
      p.on('request', (r) => { if (!['eventsource', 'websocket'].includes(r.resourceType())) inflight.set(r, Date.now()); });
      p.on('requestfinished', (r) => inflight.delete(r));
      p.on('requestfailed', (r) => { inflight.delete(r); pushLog(state, 'network', { type: 'failed', method: r.method(), url: r.url(), error: r.failure()?.errorText || 'request failed' }); });
      p.on('response', (res) => { if (res.status() >= 400) pushLog(state, 'network', { type: 'http', status: res.status(), url: res.url(), text: res.statusText() }); });
    };
    watch(page);
    // A link that opens a new tab: follow it.
    ctx.on('page', (p) => { page = p; p.setDefaultTimeout(DEFAULT_TIMEOUT); watch(p); });
    // What the page logged while no command was attached.
    const drained = await page.evaluate(() => (window.__redpi ? window.__redpi.splice(0) : [])).catch(() => []);
    for (const e of drained) pushLog(state, e.type === 'pageerror' ? 'errors' : 'console', e);
    // The window size includes some browser frame: make the page itself exactly the chosen size.
    if (fresh) await setWindow(page, ...(state.viewport || DEFAULT_SIZE)).catch(() => {});
    if (fresh && state.url && page.url() === 'about:blank') {
      await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }
    const api = { page: () => page, inflight, state, ctx, restored: fresh && !!state.url };
    try {
      const result = await fn(api);
      return result;
    } finally {
      const p = page;
      await p.evaluate(HOOK).catch(() => {});
      await p.evaluate(() => { if (window.__redpi) window.__redpi.length = 0; }).catch(() => {});
      state.url = p.url();
      state.title = await p.title().catch(() => '');
      state.usedAt = Date.now();
      writeState(state);
      await browser.close().catch(() => {});   // disconnects; the browser and page stay open
    }
  });
}

/**
 * Wait until the page is actually ready: load event, no requests in flight for 500 ms, web fonts
 * loaded, visible images decoded, no visible loading indicator, the DOM unchanged for 400 ms, then
 * two painted frames. Returns what was still going on if the time runs out.
 */
async function settle(api, timeoutMs = READY_MS) {
  const page = api.page();
  const t0 = Date.now();
  const left = () => Math.max(0, t0 + timeoutMs - Date.now());
  await page.waitForLoadState('load', { timeout: left() }).catch(() => {});
  await page.evaluate(HOOK).catch(() => {});
  let quietSince = 0, last = null;
  while (left() > 0) {
    const now = Date.now();
    // A request open for over 10 s is a long poll or a stuck call: reported, but not waited for.
    const pending = [...api.inflight.entries()].filter(([, at]) => now - at < 10000).map(([r]) => r);
    const dom = await page.evaluate(() => {
      const busy = [];
      if (document.readyState !== 'complete') busy.push(`document still ${document.readyState}`);
      if (document.fonts && document.fonts.status !== 'loaded') busy.push('web fonts loading');
      const shown = (el) => {
        const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.bottom > 0 && r.top < innerHeight;
      };
      const imgs = [...document.images].filter((i) => shown(i) && (!i.complete || (i.currentSrc && i.naturalWidth === 0 && !i.dataset.redpiBroken)));
      // A broken image is complete with no size: report it once, do not wait for it.
      const broken = imgs.filter((i) => i.complete); broken.forEach((i) => { i.dataset.redpiBroken = '1'; });
      const loadingImgs = imgs.filter((i) => !i.complete);
      if (loadingImgs.length) busy.push(`${loadingImgs.length} image${loadingImgs.length > 1 ? 's' : ''} loading`);
      const sel = '[aria-busy="true"], [role="progressbar"]:not([aria-valuenow]), .spinner, .loader, .loading, .skeleton, [class*="spinner"], [class*="skeleton"], [class*="Spinner"], [class*="Skeleton"], [data-loading="true"]';
      const spin = [...document.querySelectorAll(sel)].filter(shown).slice(0, 3)
        .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
      if (spin.length) busy.push(`loading indicator visible (${spin.join(', ')})`);
      const body = document.body;
      if (!body || (!body.innerText.trim() && body.querySelectorAll('img,svg,canvas,video,input,button').length === 0)) busy.push('page is still blank');
      const still = performance.now() - (window.__redpiLastChange || 0);
      return { busy, still };
    }).catch(() => ({ busy: ['page is navigating'], still: 0 }));
    const netBusy = pending.length > 0;
    if (!netBusy && !quietSince) quietSince = now;
    if (netBusy) quietSince = 0;
    last = { pending, busy: dom.busy, still: dom.still };
    if (!netBusy && now - quietSince >= 500 && dom.busy.length === 0 && dom.still >= 400) {
      await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 500); })).catch(() => {});
      return { ready: true, ms: Date.now() - t0 };
    }
    await sleep(100);
  }
  const why = [];
  if (last?.pending.length) why.push(`${last.pending.length} request${last.pending.length > 1 ? 's' : ''} still loading (${last.pending.slice(0, 3).map((r) => `${r.method()} ${r.url().slice(0, 100)}`).join(', ')})`);
  if (last?.busy.length) why.push(...last.busy);
  if (last && last.still < 400 && !why.length) why.push('the page keeps changing (an animation or live data)');
  return { ready: false, ms: Date.now() - t0, why };
}
function readyLine(r) {
  if (r.ready) return `ready: page fully loaded (${(r.ms / 1000).toFixed(1)}s)`;
  return `NOT READY after ${(r.ms / 1000).toFixed(0)}s: ${r.why.join('; ') || 'still loading'}. What you see now may be incomplete; run \`ready\` to wait longer, or check \`errors\`.`;
}
async function pageSummary(page, max) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const title = await page.title().catch(() => '');
  return clip(`url: ${page.url()}\ntitle: ${title}\n\n${text}`, max);
}
function navError(e, url) {
  const m = String(e && e.message || e);
  if (/ERR_CONNECTION_REFUSED/.test(m)) return `Could not reach ${url}: connection refused. Is the dev server running on that port?`;
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return `Could not reach ${url}: the host name does not resolve.`;
  if (/Timeout/i.test(m)) return `${url} did not respond within ${Math.round(DEFAULT_TIMEOUT / 1000)}s.`;
  return m.split('\n')[0];
}
// Scroll through the page so lazy-loaded images and sections load before a full-page screenshot.
async function scrollThrough(page) {
  await page.evaluate(async (maxPx) => {
    const h = Math.min(document.documentElement.scrollHeight, maxPx);
    for (let y = 0; y < h; y += Math.max(200, innerHeight * 0.8)) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    scrollTo(0, 0);
  }, FULL_MAX_PX).catch(() => {});
}
async function setWindow(page, w, h) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
  } finally { await cdp.detach().catch(() => {}); }
  // The window may include a few pixels of frame: correct to the exact viewport.
  for (let i = 0; i < 3; i++) {
    const vp = await page.evaluate(() => [innerWidth, innerHeight]);
    if (vp[0] === w && vp[1] === h) break;
    const c2 = await page.context().newCDPSession(page);
    try {
      const { windowId, bounds } = await c2.send('Browser.getWindowForTarget');
      await c2.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + (w - vp[0]), height: bounds.height + (h - vp[1]) } });
    } finally { await c2.detach().catch(() => {}); }
  }
  return page.evaluate(() => [innerWidth, innerHeight]);
}

async function keeper() {
  for (;;) {
    await sleep(15000);
    const s = readState();
    if (!alive(s.cdp?.pid)) return;
    if (Date.now() - Number(s.usedAt || Date.parse(s.cdp.started) || Date.now()) > IDLE_MS) { try { process.kill(s.cdp.pid, 'SIGTERM'); } catch {} return; }
  }
}

(async () => {
  const { cmd, args, opts } = parse(process.argv.slice(2));
  if (cmd === '__keeper') { await keeper(); process.exit(0); }
  if (!cmd || cmd === 'help' || cmd === '--help') usage(0);
  setTimeout(() => {
    console.error(`redpi-browser: stopped after ${Math.round(MAX_RUNTIME / 1000)}s (page too slow or still loading).`);
    process.exit(124);
  }, MAX_RUNTIME).unref();
  const out = (s) => { console.log(s); };
  if (cmd === 'reset' || cmd === 'close') {
    await withLock(async () => {
      const s = readState(); stopBrowser(s);
      await sleep(300);
      if (cmd === 'reset') fs.rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); else writeState(s);
    });
    return out(cmd === 'reset' ? 'reset ok: browser closed, profile and history cleared' : 'browser closed (logins kept)');
  }
  if (cmd === 'console' || cmd === 'network' || cmd === 'errors') {
    // With the browser open, first collect what the page logged since the last command.
    const s = alive(readState().cdp?.pid) ? await withPage(async (api) => api.state) : readState();
    if (cmd === 'console') return out(formatLogs(s.console || [], opts.max));
    if (cmd === 'network') return out(formatLogs(s.network || [], opts.max));
    return out(formatLogs([...(s.errors || []), ...(s.console || []).filter((x) => ['error', 'warning'].includes(x.type)), ...(s.network || [])], opts.max));
  }
  const show = async (api, before = '') => {
    const r = await settle(api, opts.timeout);
    return `${before}${readyLine(r)}\n${await pageSummary(api.page(), opts.max)}`;
  };
  const restoredNote = (api) => (api.restored ? `(the browser had closed; reopened ${api.state.url})\n` : '');
  let result;
  switch (cmd) {
    case 'goto': {
      const url = args[0]; if (!url) usage(1);
      result = await withPage(async (api) => {
        api.state.console = []; api.state.errors = []; api.state.network = [];
        let res;
        try { res = await api.page().goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }); }
        catch (e) { process.exitCode = 1; return navError(e, url); }
        const status = res && res.status() >= 400 ? `HTTP ${res.status()} ${res.statusText()}\n` : '';
        return show(api, status);
      });
      break;
    }
    case 'text': result = await withPage((api) => show(api, restoredNote(api))); break;
    case 'ready': result = await withPage(async (api) => `${restoredNote(api)}${readyLine(await settle(api, opts.timeout))}\nurl: ${api.page().url()}`); break;
    case 'html': result = await withPage(async (api) => { const r = await settle(api, opts.timeout); return clip(`${readyLine(r)}\nurl: ${api.page().url()}\n\n${await api.page().content()}`, opts.max); }); break;
    case 'title': result = await withPage(async (api) => `url: ${api.page().url()}\ntitle: ${await api.page().title()}`); break;
    case 'reload': result = await withPage(async (api) => { await api.page().reload({ waitUntil: 'domcontentloaded' }); return show(api); }); break;
    case 'back': result = await withPage(async (api) => { await api.page().goBack({ waitUntil: 'domcontentloaded' }); return show(api); }); break;
    case 'click': {
      const sel = args[0]; if (!sel) usage(1);
      result = await withPage(async (api) => { await api.page().locator(sel).first().click(); await sleep(50); return show(api); });
      break;
    }
    case 'type': {
      const [sel, ...textParts] = args; const text = textParts.join(' '); if (!sel || !text) usage(1);
      result = await withPage(async (api) => { const loc = api.page().locator(sel).first(); await loc.fill(text); if (opts.submit) { await loc.press('Enter'); await sleep(50); } return show(api); });
      break;
    }
    case 'wait-for': {
      const sel = args.join(' '); if (!sel) usage(1);
      result = await withPage(async (api) => { await api.page().locator(sel).first().waitFor({ state: 'visible', timeout: opts.timeout }); return show(api); });
      break;
    }
    case 'wait-for-text': {
      const text = args.join(' '); if (!text) usage(1);
      result = await withPage(async (api) => { await api.page().getByText(text, { exact: false }).first().waitFor({ timeout: opts.timeout }); return show(api); });
      break;
    }
    case 'eval': {
      const js = args.join(' '); if (!js) usage(1);
      result = await withPage(async (api) => clip(JSON.stringify(await api.page().evaluate(js), null, 2), opts.max));
      break;
    }
    case 'viewport': {
      const arg = String(args[0] || '').toLowerCase();
      const size = SIZES[arg] || (/^(\d+)\s*[x×,]\s*(\d+)$/.exec(arg) || []).slice(1, 3).map(Number);
      result = await withPage(async (api) => {
        if (!arg) { const vp = await api.page().evaluate(() => [innerWidth, innerHeight]); return `viewport: ${vp[0]}×${vp[1]}`; }
        if (size.length !== 2 || !(size[0] > 100 && size[1] > 100)) { process.exitCode = 1; return 'viewport needs WxH (e.g. 390x844) or phone, tablet, laptop, desktop'; }
        const vp = await setWindow(api.page(), size[0], size[1]);
        api.state.viewport = [size[0], size[1]];
        const r = await settle(api, opts.timeout);
        return `viewport: ${vp[0]}×${vp[1]}\n${readyLine(r)}`;
      });
      break;
    }
    case 'screenshot': {
      const file = path.resolve(args[0] || path.join(STATE_DIR, `screenshot-${Date.now()}.png`));
      result = await withPage(async (api) => {
        let r = await settle(api, opts.timeout);
        const page = api.page();
        const size = await page.evaluate(() => [innerWidth, innerHeight, document.documentElement.scrollHeight]);
        let note = '';
        if (opts.full) {
          await scrollThrough(page);
          r = await settle(api, Math.min(opts.timeout, 8000));
          size[2] = await page.evaluate(() => document.documentElement.scrollHeight);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tall = opts.full && size[2] > FULL_MAX_PX;
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', ...(opts.full ? (tall ? { fullPage: true, clip: { x: 0, y: 0, width: size[0], height: FULL_MAX_PX } } : { fullPage: true }) : {}) });
        if (tall) note = ` (page is ${size[2]}px tall; captured the top ${FULL_MAX_PX}px)`;
        const shotH = opts.full ? Math.min(size[2], FULL_MAX_PX) : size[1];
        return `${restoredNote(api)}screenshot: ${file}\n${size[0]}×${shotH}, ${opts.full ? 'whole page' : 'visible area'}${note}\n${readyLine(r)}\nurl: ${page.url()}`;
      });
      break;
    }
    default: usage(1);
  }
  out(result);
})().then(() => process.exit(process.exitCode || 0), (e) => {
  const m = e && e.message || String(e);
  console.error(/Executable doesn't exist|playwright install/i.test(m) ? m : (e && e.stack || m).split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
