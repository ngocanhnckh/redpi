#!/usr/bin/env node
/**
 * RedPi browser CLI: compact Playwright automation without MCP context bloat.
 * Usage examples:
 *   redpi-browser.js goto https://example.com
 *   redpi-browser.js text --max 4000
 *   redpi-browser.js click 'text=Sign in'
 *   redpi-browser.js type '#q' 'hello world'
 *   redpi-browser.js screenshot /tmp/page.png
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const STATE_DIR = process.env.REDPI_BROWSER_DIR || path.join(AGENT_DIR, 'yitec', 'browser');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const DEFAULT_TIMEOUT = Number(process.env.REDPI_BROWSER_TIMEOUT || 15000);

function usage(code = 0) {
  console.log(`RedPi browser CLI\n\nCommands:\n  goto <url> [--max N]\n  text [--max N]\n  html [--max N]\n  title\n  click <selector> [--max N]\n  type <selector> <text> [--submit] [--max N]\n  eval <javascript> [--max N]\n  screenshot <path>\n  reset\n\nSelectors use Playwright syntax: text=Login, role=button[name="Save"], css selectors, etc.\nOutput is intentionally compact for token efficiency.`);
  process.exit(code);
}
function parse(argv) {
  const args = [...argv];
  const cmd = args.shift();
  const opts = { max: 3000, submit: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max') opts.max = Number(args[++i] || opts.max);
    else if (args[i] === '--submit') opts.submit = true;
    else rest.push(args[i]);
  }
  return { cmd, args: rest, opts };
}
function clip(s, max) {
  s = String(s ?? '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return s.length > max ? s.slice(0, max) + `\n… clipped (${s.length} chars total)` : s;
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(v) { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(v, null, 2) + '\n'); }
async function getPlaywright() {
  try { return require('playwright'); }
  catch (e) {
    console.error('Playwright is not installed. From the RedPi checkout run: npm install && npx playwright install chromium');
    console.error('If installed as a Pi package, run npm install in the package checkout or reinstall RedPi after dependencies are added.');
    process.exit(2);
  }
}
async function withPage(fn) {
  const { chromium } = await getPlaywright();
  const state = readState();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const headless = process.env.REDPI_BROWSER_HEADLESS !== 'false';
  const ctx = await chromium.launchPersistentContext(path.join(STATE_DIR, 'profile'), {
    headless,
    viewport: { width: Number(process.env.REDPI_BROWSER_WIDTH || 1280), height: Number(process.env.REDPI_BROWSER_HEIGHT || 900) },
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    if (state.url && page.url() === 'about:blank') await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }).catch(() => {});
    const result = await fn(page, state);
    state.url = page.url();
    state.title = await page.title().catch(() => '');
    state.at = new Date().toISOString();
    writeState(state);
    return result;
  } finally {
    await ctx.close();
  }
}
function pageSummary(page, max) {
  return page.locator('body').innerText({ timeout: 5000 }).then(txt => txt).catch(() => '').then(async text => {
    const title = await page.title().catch(() => '');
    return clip(`url: ${page.url()}\ntitle: ${title}\n\n${text}`, max);
  });
}
(async () => {
  const { cmd, args, opts } = parse(process.argv.slice(2));
  if (!cmd || cmd === 'help' || cmd === '--help') usage(0);
  if (cmd === 'reset') { fs.rmSync(STATE_DIR, { recursive: true, force: true }); console.log('reset ok'); return; }
  if (cmd === 'goto') {
    const url = args[0]; if (!url) usage(1);
    console.log(await withPage(async page => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }); return pageSummary(page, opts.max); })); return;
  }
  if (cmd === 'text') { console.log(await withPage(page => pageSummary(page, opts.max))); return; }
  if (cmd === 'html') { console.log(await withPage(async page => clip(`url: ${page.url()}\n\n${await page.content()}`, opts.max))); return; }
  if (cmd === 'title') { console.log(await withPage(async page => `url: ${page.url()}\ntitle: ${await page.title()}`)); return; }
  if (cmd === 'click') {
    const sel = args[0]; if (!sel) usage(1);
    console.log(await withPage(async page => { await page.locator(sel).first().click(); await page.waitForLoadState('domcontentloaded').catch(()=>{}); return pageSummary(page, opts.max); })); return;
  }
  if (cmd === 'type') {
    const [sel, ...textParts] = args; const text = textParts.join(' '); if (!sel || !text) usage(1);
    console.log(await withPage(async page => { const loc = page.locator(sel).first(); await loc.fill(text); if (opts.submit) await loc.press('Enter'); await page.waitForLoadState('domcontentloaded').catch(()=>{}); return pageSummary(page, opts.max); })); return;
  }
  if (cmd === 'eval') {
    const js = args.join(' '); if (!js) usage(1);
    console.log(await withPage(async page => clip(JSON.stringify(await page.evaluate(js), null, 2), opts.max))); return;
  }
  if (cmd === 'screenshot') {
    const out = path.resolve(args[0] || path.join(STATE_DIR, `screenshot-${Date.now()}.png`));
    await withPage(async page => { await page.screenshot({ path: out, fullPage: true }); return ''; });
    console.log(`screenshot: ${out}`); return;
  }
  usage(1);
})().catch(e => { console.error(e && e.stack || String(e)); process.exit(1); });
