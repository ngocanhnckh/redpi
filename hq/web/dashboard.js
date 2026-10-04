import { ago, api, esc, live, pill, signedInAs, toast } from "/static/hq.js";
import { portraitUrl } from "/static/office/people.js";
import { Office } from "/static/office/office.js";
import { renderCharts, usageSummary, tokens as fmtTokens } from "/static/charts.js";
import { renderTimeline } from "/static/timeline.js";
import { md, plain } from "/static/md.js";
import { Inbox, inboxBadge } from "/static/inbox.js";
import { Chat } from "/static/chat.js";
import { busy } from "/static/hq.js";

const app = document.getElementById("app");
const runId = location.pathname.startsWith("/runs/") ? location.pathname.split("/")[2] : null;
const projectId = location.pathname.startsWith("/projects/") ? location.pathname.split("/")[2] : null;
const inboxPage = location.pathname === "/inbox";
const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done"]];
let renderedPanel = null;
let state, prev, openPanel = null, draftTo = null, office = null, officeHost = null, inboxHost = null, inboxView = null, chatHost = null, chatView = null;

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const VIEWS = [["office", "Office"], ["board", "Board"], ["feed", "Feed"], ["chat", "Chat"], ["inbox", "Inbox"], ["timeline", "Timeline"], ["stats", "Stats"], ["shots", "Screenshots"]];
let view = { graph: "stats" }[store.get(`redpi-view-${runId}`)] || store.get(`redpi-view-${runId}`);
if (view && !VIEWS.some(([k]) => k === view)) view = null;
// Auto-play: the view fades through Office, Board, Timeline, Stats and Screenshots (10 s each; ?autoplay_ms= for tests).
const AUTOPLAY_MS = Number(new URLSearchParams(location.search).get("autoplay_ms")) || 10_000;
let autoplay = store.get("redpi-autoplay") === "1", apTimer = null, apHover = false;
const viewScroll = {};

// Open work a worker is answerable for: tasks they own, or reviews routed to them.
const holds = (w) => (state?.tasks || []).filter((t) => t.status !== "done" && (t.status === "review" ? t.reviewer_id === w.id : t.worker_id === w.id));
// A worker who left holding nothing (finished, dismissed) is simply gone: no alert. Only leaving mid-task is "lost".
const workerState = (w) => !w.alive ? (holds(w).length ? "lost" : w.left_reason === "dismissed" ? "dismissed" : "left") : w.needs_human || w.needs_input || w.parked ? "needs" : w.status === "working" ? "working" : w.status === "starting" ? "starting" : "idle";
// A person's dot and one line on what they are up to (the chat sidebar and header).
function presence(id) {
  if (id === "ceo") {
    const link = ["done", "cancelled"].includes(state.run.status) ? { ok: true } : ceoLink();
    return { dot: link.ok ? "working" : "offline", label: link.ok ? (state.run.status === "awaiting_approval" ? "waiting for your approval" : state.run.status === "done" ? "run finished" : "coordinating the team") : "not connected: /reload its terminal" };
  }
  const w = state.workers.find((x) => x.id === id);
  if (!w) return { dot: "left", label: "" };
  const st = workerState(w), said = latestUpdate(id);
  const label = st === "lost" ? `session ended while holding ${holds(w).map((t) => t.id).join(", ")}` : st === "left" || st === "dismissed" ? `${st === "dismissed" ? "dismissed" : "left"}${w.left_at ? ` ${ago(w.left_at)}` : ""}`
    : said ? `“${plain(said.text).slice(0, 140)}”` : `${st}${w.current_task ? ` · ${w.current_task}` : ""}${w.activity?.text ? ` · ${w.activity.text}` : ""}`;
  return { dot: st === "needs" ? "offline" : st, label };
}
// The org chart order: each manager followed by their team, then everyone reporting to the CEO directly.
function orgOrder(workers) {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const lead = (w) => (w.manager_id && byId.has(w.manager_id) ? w.manager_id : null);
  const out = [];
  for (const m of workers.filter((w) => w.is_manager)) out.push(m, ...workers.filter((w) => lead(w) === m.id));
  return [...out, ...workers.filter((w) => !w.is_manager && !lead(w))];
}
const roleOf = (id) => id === "ceo" ? "ceo" : state?.workers.find((w) => w.id === id)?.role || "";
function avatar(name, id, size = "") {
  if (id === "human") return `<span class="avatar you ${size}" aria-hidden="true">You</span>`;
  if (id === "hq") return `<span class="avatar you hq ${size}" aria-hidden="true">HQ</span>`;
  return `<img class="avatar ${size}" alt="" src="${portraitUrl(name, roleOf(id))}">`;
}

// Screen readers hear what changed (the office canvas itself is decorative).
function announce(text) {
  const el = document.getElementById("live");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
}

const ACTIVE = new Set(["planning", "awaiting_approval", "approved", "executing"]);
let homeFilter = store.get("redpi-home-filter"), homeQuery = "";

function projectState(p) {
  if (p.awaiting_approval) return ["Plan awaiting approval", "amber"];
  if (p.active_runs) return [p.workers.some((w) => w.alive && w.status === "working") ? "Running" : "Active", "green"];
  return ["Idle", ""];
}

function runCard(r) {
  return `<a class="panel run-card" href="/runs/${esc(r.id)}">
    <div style="display:flex;justify-content:space-between;gap:8px">${pill(r.status)}<span class="faint" style="font-size:12px">${ago(r.updated)}</span></div>
    <div class="t">${esc(r.title)}</div>
    <div class="bar"><i style="width:${r.tasks ? Math.round((r.done / r.tasks) * 100) : 0}%"></i></div>
    <div class="muted" style="font-size:12px;margin-top:6px">${r.tasks ? `${r.done}/${r.tasks} tasks done` : "planning"} · ${r.workers} worker${r.workers === 1 ? "" : "s"}${r.live_workers ? ` (${r.live_workers} online)` : ""}</div>
  </a>`;
}

// Home: every project on the machine, the ones with work going on first.
async function loadHome() {
  const projects = await api("GET", "/api/projects");
  document.title = "RedPi HQ";
  document.getElementById("crumbs").textContent = "All projects on this machine";
  if (!projects.length) { app.innerHTML = `<div class="empty">No RedPlan projects yet. In any project, start Pi and run <code>/redplan &lt;what to build&gt;</code>.</div>`; return; }
  const active = projects.filter((p) => p.active_runs);
  if (homeFilter !== "all" && homeFilter !== "active") homeFilter = active.length ? "active" : "all";
  const online = projects.flatMap((p) => p.workers.filter((w) => w.alive));
  const needs = projects.reduce((n, p) => n + (p.inbox_open || 0), 0);
  const done = active.reduce((n, p) => n + p.done, 0), tasks = active.reduce((n, p) => n + p.tasks, 0);
  const focused = document.activeElement?.id === "psearch";
  app.innerHTML = `
    <div class="stats" style="margin-bottom:10px">
      <div class="panel stat"><div class="v">${active.length}</div><div class="k">project${active.length === 1 ? "" : "s"} with active runs</div></div>
      <div class="panel stat"><div class="v">${online.length}</div><div class="k">worker${online.length === 1 ? "" : "s"} online</div></div>
      <div class="panel stat"><div class="v" style="${needs ? "color:var(--red)" : ""}">${needs}</div><div class="k">need${needs === 1 ? "s" : ""} you</div></div>
      <div class="panel stat"><div class="v">${done}<span class="faint" style="font-size:14px">/${tasks}</span></div><div class="k">active tasks done</div></div>
    </div>
    <div class="home-bar">
      <div class="viewtabs" role="tablist" aria-label="Which projects">
        <button role="tab" data-f="active" aria-selected="${homeFilter === "active"}">Active <span class="faint">${active.length}</span></button>
        <button role="tab" data-f="all" aria-selected="${homeFilter === "all"}">All <span class="faint">${projects.length}</span></button>
      </div>
      <input type="search" id="psearch" placeholder="Find a project" aria-label="Find a project" value="${esc(homeQuery)}">
    </div>
    <div class="projects" id="plist"></div>`;
  const list = document.getElementById("plist");
  const paint = () => {
    const q = homeQuery.toLowerCase();
    const shown = projects.filter((p) => (homeFilter === "all" || p.active_runs) && (!q || `${p.name} ${p.path} ${p.latest?.title || ""}`.toLowerCase().includes(q)));
    list.innerHTML = shown.length ? shown.map(projectCard).join("") : `<div class="empty">${q ? "No project matches." : `No active runs right now. <button class="btn" data-f="all">Show all projects</button>`}</div>`;
    list.querySelector("[data-f]")?.addEventListener("click", () => setFilter("all"));
  };
  const setFilter = (f) => { homeFilter = f; store.set("redpi-home-filter", f); loadHome(); };
  app.querySelectorAll(".home-bar [data-f]").forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.f)));
  const search = document.getElementById("psearch");
  search.addEventListener("input", () => { homeQuery = search.value; paint(); });
  if (focused) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  paint();
}

function projectCard(p) {
  const [label, tone] = projectState(p);
  const live = p.workers.filter((w) => w.alive);
  const needs = p.inbox_open || 0;
  const faces = live.slice(0, 8).map((w) => `<img class="avatar sm ${w.needsYou ? "needs-ring" : ""}" alt="" title="${esc(w.name)} · ${esc(w.role)}${w.needsYou ? " · needs you" : ""}" src="${portraitUrl(w.name, w.role)}">`).join("");
  return `<a class="panel project-card ${p.active_runs ? "on" : ""}" href="/projects/${esc(p.id)}">
    <div class="pc-top"><span class="pc-name">${esc(p.name)}</span><span class="pill ${tone}">${esc(label)}</span></div>
    <div class="mono faint pc-path" title="${esc(p.path)}">${esc(p.path)}</div>
    ${p.latest ? `<div class="pc-run">${esc(p.latest.title)}</div>` : ""}
    ${p.active_runs && p.tasks ? `<div class="bar"><i style="width:${Math.round((p.done / p.tasks) * 100)}%"></i></div>` : ""}
    <div class="pc-meta">
      <span>${p.active_runs ? `${p.active_runs} active run${p.active_runs === 1 ? "" : "s"}` : `${p.runs} run${p.runs === 1 ? "" : "s"}`}${p.active_runs && p.tasks ? ` · ${p.done}/${p.tasks} tasks${p.blocked ? ` · <span style="color:var(--red)">${p.blocked} blocked</span>` : ""}` : ""}</span>
      <span class="faint">${p.updated ? ago(p.updated) : ""}</span>
    </div>
    ${live.length || needs ? `<div class="pc-team"><span class="pc-faces">${faces}${live.length > 8 ? `<span class="faint">+${live.length - 8}</span>` : ""}</span>
      ${needs ? `<span class="pill red">${needs} need${needs === 1 ? "s" : ""} you</span>` : `<span class="faint" style="font-size:12px">${live.length} online</span>`}</div>` : ""}
  </a>`;
}

// One project: its runs, active first.
async function loadProject() {
  const { project, runs } = await api("GET", `/api/projects/${projectId}`);
  document.title = `${project.name} · RedPi HQ`;
  document.getElementById("crumbs").innerHTML = `<a href="/">All projects</a> / ${esc(project.name)} <span class="faint mono">${esc(project.path)}</span>`;
  const active = runs.filter((r) => ACTIVE.has(r.status)), past = runs.filter((r) => !ACTIVE.has(r.status));
  app.innerHTML = `
    <div class="run-head"><h1>${esc(project.name)}</h1><span class="mono faint">${esc(project.path)}</span></div>
    ${active.length ? `<section class="project"><h2 class="section-title">Active runs</h2><div class="runs">${active.map(runCard).join("")}</div></section>` : `<div class="empty">No active run in this project. Start one in Pi here with <code>/redplan &lt;what to build&gt;</code>.</div>`}
    ${past.length ? `<section class="project"><h2 class="section-title">Finished</h2><div class="runs">${past.map(runCard).join("")}</div></section>` : ""}`;
}

async function loadRun() {
  prev = state;
  state = await api("GET", `/api/runs/${runId}`);
  if (prev) announceChanges(prev, state);
  renderRun();
  if (openPanel) renderPanel();
}

function announceChanges(a, b) {
  const lines = [];
  const was = new Map(a.workers.map((w) => [w.id, w]));
  for (const w of b.workers) {
    const o = was.get(w.id);
    if (o && workerState(o) !== "needs" && workerState(w) === "needs") lines.push(`${w.name} needs you`);
    if (o && o.alive && !w.alive && workerState(w) === "lost") lines.push(`${w.name}'s session ended while holding ${holds(w).map((t) => t.id).join(", ")}`);
  }
  const tWas = new Map(a.tasks.map((t) => [t.id, t.status]));
  for (const t of b.tasks) if (tWas.get(t.id) && tWas.get(t.id) !== t.status && (t.status === "done" || t.status === "blocked")) lines.push(`${t.id} ${t.title} is ${t.status}`);
  const lastA = a.messages.at(-1)?.id || 0;
  const fresh = b.messages.filter((m) => m.id > lastA && m.kind !== "task");
  if (fresh.length) lines.push(`${fresh.length} new message${fresh.length > 1 ? "s" : ""}: ${fresh.slice(-2).map((m) => `${m.senderName} to ${m.recipientName}`).join(", ")}`);
  if (lines.length) announce(lines.join(". "));
}

// The CEO session checks in every 30 s; an older RedPi in that terminal never does.
function ceoLink() {
  const r = state.run, caps = (() => { try { return JSON.parse(r.ceo_caps || "[]"); } catch { return []; } })();
  const fresh = r.ceo_seen && (state.now || Date.now()) - r.ceo_seen < 120_000;
  if (!r.ceo_seen) return { ok: false, text: "The CEO session is running an older RedPi: type /reload in the CEO's terminal so it can answer on the side, reply to you here, and take tickets." };
  if (!fresh) return { ok: false, text: `The CEO session has not checked in since ${ago(r.ceo_seen)}: is its terminal still open? Start it again (or /reload) so it can take messages and tickets.` };
  return { ok: caps.includes("aside"), text: caps.includes("aside") ? "" : "The CEO session's RedPi is out of date: type /reload in its terminal." };
}


// Scroll areas that are re-rendered keep the reader's place: a list of messages stays
// pinned to the newest one only while the reader is already at the bottom; otherwise it
// stays exactly where they were reading.
function saveScroll(sel) {
  const el = document.querySelector(sel);
  return el ? { top: el.scrollTop, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 30 } : null;
}
function restoreScroll(sel, saved, { toEnd = false } = {}) {
  const el = document.querySelector(sel);
  if (!el) return;
  const apply = () => { if (toEnd && (!saved || saved.atEnd)) el.scrollTop = el.scrollHeight; else if (saved) el.scrollTop = saved.top; };
  apply();
  requestAnimationFrame(apply);   // again once the new content has laid out
}

// ---------- the run page ----------
// The page skeleton is built once; each live update patches its regions in place, so the
// page never jumps, and your scroll position, focus, typed text and selections survive.
const $ = (id) => document.getElementById(id);
let built = null, feedUnseen = 0;
let feedFilter = { chat: "chat", updates: "updates", tools: "tools", actions: "tools" }[store.get("redpi-feed-filter")] || "all";
const STATUS_LABEL = { todo: "to do", in_progress: "in progress", review: "review", blocked: "blocked", done: "done" };
const STATUS_COLOR = { todo: "var(--faint)", in_progress: "var(--cyan)", review: "var(--amber)", blocked: "var(--red)", done: "var(--green)" };
const TOOL_ICON = { bash: "$", read: "<", edit: ">", write: ">", grep: "?", find: "?", ls: "?", glob: "?", redpi_jevgrep: "?", redpi_browser: "@", web: "@" };
const nameOf = (id) => id === "ceo" ? "CEO" : id === "human" ? "You" : id === "hq" ? "HQ" : id === "external" ? "something outside the team" : state.workers.find((w) => w.id === id)?.name || id;
const waitingOn = (t) => t.blocked_on === "human" ? "waiting on you" : t.blocked_on ? `waiting on ${nameOf(t.blocked_on)}` : "";
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildRun() {
  app.innerHTML = `
    <div id="live" class="sr-only" aria-live="polite"></div>
    <div class="run-head" id="run-head"></div>
    <div class="stats" id="stats" style="margin-bottom:10px"></div>
    <div class="run-main">
      <div class="panel view-panel">
        <div class="panel-head"><div class="viewtabs" role="tablist">
          ${VIEWS.map(([k, l]) => `<button role="tab" data-view="${k}">${l}</button>`).join("")}
        </div><span class="muted" id="view-hint" style="font-size:12px"></span>
        <button type="button" class="autoplay" id="autoplay" aria-pressed="false" title="Fade through Office, Board, Timeline, Stats and Screenshots every ${AUTOPLAY_MS / 1000} seconds (pauses while the pointer is over the view)">Auto-play</button></div>
        <div class="ap-bar" id="ap-bar" hidden><i></i></div>
        <div class="panel-body" id="view-body"></div>
      </div>
      <div class="panel feed-panel"><div class="feed-inner">
        <div class="panel-head"><h2>Event board</h2><div class="feed-filter" role="group" aria-label="Show">
          ${[["all", "All", "Everything"], ["updates", "Updates", "What the team says it is doing, and task moves"], ["chat", "Chat", "Messages"], ["tools", "Tools", "Every tool call"]].map(([k, l, t]) => `<button type="button" data-filter="${k}" aria-pressed="false" title="${t}">${l}</button>`).join("")}</div></div>
        <div class="chat-wrap"><div class="chat feed" id="feed" tabindex="0" aria-label="Team chat and actions"></div>
          <button class="chat-new" type="button" hidden></button></div>
        <div class="composer">
          <select id="to" aria-label="Send to"></select>
          <input type="text" id="draft" placeholder="Message… (they receive it as a message from you)" autocomplete="off">
          <button class="btn primary" id="send">Send</button>
        </div>
      </div></div>
    </div>
    <div class="panel team-panel"><div class="panel-head"><h2>Team</h2><span class="muted" style="font-size:12px">click anyone for details and to talk to them</span></div>
      <div class="panel-body team" id="team"></div></div>
    `;
  built = runId;
  bindAutoplay();
  const feed = $("feed"), newBtn = app.querySelector(".chat-new");
  const atEnd = () => feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  newBtn.onclick = () => feed.scrollTo({ top: feed.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" });
  feed.onscroll = () => { if (feedUnseen && atEnd()) { feedUnseen = 0; newBtn.hidden = true; } };
  applyFilter();
  const toSel = $("to");
  toSel.onchange = () => { draftTo = toSel.value; };
  const sendDraft = () => {
    const input = $("draft");
    const body = input.value.trim();
    if (!body) return;
    return busy($("send"), async () => {
      await api("POST", `/api/runs/${runId}/messages`, { from: "human", to: toSel.value, kind: "command", body });
      input.value = ""; feed.scrollTop = feed.scrollHeight;
      toast(toSel.value === "all" ? "Sent to everyone. Replies appear here and in each person's chat." : `Sent to ${nameOf(toSel.value)}. Their reply appears here and in their chat.`);
      loadRun();
    });
  };
  $("send").onclick = sendDraft;
  $("draft").onkeydown = (e) => { if (e.key === "Enter") sendDraft(); };
  // One click handler for every region, since regions are re-rendered in place.
  app.onclick = (e) => {
    const el = e.target.closest("[data-new-ticket],[data-shot],[data-view],[data-filter],[data-person],[data-task],[data-open],[data-ticket]");
    if (!el || !app.contains(el)) return;
    if (el.dataset.ticket) { switchView("inbox", false); inboxView?.select(Number(el.dataset.ticket), { reveal: true }); $("view-body").scrollIntoView?.({ block: "nearest" }); return; }
    if (el.dataset.newTicket) return openTicketForm();
    if (el.dataset.shot) return openShot(el.dataset.shot);
    if (el.dataset.view) { switchView(el.dataset.view, false); scheduleAutoplay(); }
    else if (el.dataset.filter) { feedFilter = el.dataset.filter; store.set("redpi-feed-filter", feedFilter); applyFilter(); feed.scrollTop = feed.scrollHeight; }
    else if (el.dataset.person) select(el.dataset.person);
    else if (el.dataset.task) { openPanel = { task: el.dataset.task }; renderPanel(); }
    else if (el.dataset.open !== undefined) { if (el.dataset.action === "resume") resume(el.dataset.open, el); else if (el.dataset.open) select(el.dataset.open); }
  };
}

function applyFilter() {
  const feed = $("feed");
  for (const f of ["updates", "chat", "tools"]) feed.classList.toggle(`f-${f}`, feedFilter === f);
  app.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === feedFilter)));
}

function updateChatTab() {
  const unread = chatView?.unreadTotal() || 0, ctab = app.querySelector('[data-view="chat"]');
  if (ctab) ctab.innerHTML = `Chat${unread ? ` <span class="tab-count quiet">${unread}</span>` : ""}`;
}

function updateTabs() {
  app.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $("view-hint").textContent = view === "office" ? "click a person · drag to pan · scroll to zoom · double-click to reset" : view === "board" ? "click a card for its history" : view === "timeline" ? "planned schedule with live progress · click a task" : view === "shots" ? "what the team checked in the browser · click to enlarge" : view === "inbox" ? "blockers, questions and approvals waiting on you · answer here" : view === "chat" ? "talk to the CEO and the team · #channels and direct messages" : view === "feed" ? "everything everyone says and does, live · watch for who has gone quiet" : "live project charts";
  const open = (state?.inbox || []).filter((i) => i.status === "open").length;
  const tab = app.querySelector('[data-view="inbox"]');
  if (tab) tab.innerHTML = `Inbox${open ? ` <span class="tab-count">${open}</span>` : ""}`;
  updateChatTab();
}

function renderRun() {
  const { run, project, plan, workers, tasks } = state;
  if (built !== runId || !$("run-head")) buildRun();
  document.title = `${run.title} · RedPi HQ`;
  $("crumbs").innerHTML = `<a href="/projects/${esc(project.id)}">${esc(project.name)}</a> <span class="faint mono">${esc(project.path)}</span>`;
  if (!view) view = workers.length ? "office" : "board";
  const done = tasks.filter((t) => t.status === "done").length;
  // The one thing only you can fix: the CEO's terminal is closed or out of date. A small pill, not a banner.
  const link = ["done", "cancelled"].includes(run.status) ? { ok: true } : ceoLink();
  $("run-head").innerHTML = `<h1>${esc(run.title)}</h1>${pill(run.status)}${link.ok ? "" : ` <span class="pill red" title="${esc(link.text)}">CEO not connected</span>`}
      ${plan ? `<a class="btn" href="/plans/${esc(plan.id)}">Plan v${plan.version} ${plan.status === "pending" ? "· needs your approval" : ""}</a>` : `<span class="muted">The CEO is still planning…</span>`}
      <button class="btn primary new-ticket" data-new-ticket="1" title="Add work straight to the board: no plan or approval needed">+ New ticket</button>
      <span class="muted" style="margin-left:auto">updated ${ago(run.updated)}</span>`;
  $("stats").innerHTML = `
      <div class="panel stat"><div class="v">${done}/${tasks.length || "–"}</div><div class="k">Tasks done</div></div>
      <div class="panel stat"><div class="v">${tasks.filter((t) => t.status === "in_progress").length}</div><div class="k">In progress</div></div>
      <div class="panel stat"><div class="v" style="${tasks.some((t) => t.status === "blocked") ? "color:var(--red)" : ""}">${tasks.filter((t) => t.status === "blocked").length}</div><div class="k">Blocked</div></div>
      <div class="panel stat"><div class="v">${workers.filter((w) => workerState(w) === "working").length}/${workers.filter((w) => w.alive).length}</div><div class="k">Workers active</div></div>`;
  if (view !== "chat") ensureChat().update(state);
  updateTabs();
  renderView();
  renderFeed();
  renderTeam();
  syncRecipients();
}

// ---------- switching views, by hand or on auto-play ----------
function switchView(next, fade) {
  if (next === view) return;
  const body = $("view-body");
  viewScroll[view] = body.scrollTop;
  const go = () => { view = next; store.set(`redpi-view-${runId}`, view); renderView(); updateTabs(); body.classList.remove("fading"); };
  if (fade && !reduceMotion()) { body.classList.add("fading"); setTimeout(go, 260); }
  else go();
}

function scheduleAutoplay() {
  clearTimeout(apTimer); apTimer = null;
  const btn = $("autoplay"), bar = $("ap-bar");
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(autoplay));
  // Reading a drawer, a task, or the new-ticket form pauses the rotation, like hovering the view does.
  const paused = apHover || !!openPanel || !!document.querySelector(".modal-back");
  btn.textContent = autoplay ? (paused ? "Auto-play · paused" : "Auto-play · on") : "Auto-play";
  bar.hidden = !autoplay;
  if (!autoplay) return;
  // The bar fills over the interval; it restarts on every switch and holds while paused.
  const fill = bar.firstElementChild;
  fill.style.animation = "none"; void fill.offsetWidth;
  fill.style.animation = `ap-fill ${AUTOPLAY_MS}ms linear forwards`;
  fill.style.animationPlayState = paused ? "paused" : "running";
  if (paused) return;
  apTimer = setTimeout(() => {
    // Chat, the inbox and the live Feed are for reading/answering, not watching: auto-play passes them by.
    const cycle = VIEWS.filter(([k]) => k !== "inbox" && k !== "chat" && k !== "feed"), i = cycle.findIndex(([k]) => k === view);
    switchView(cycle[(i + 1) % cycle.length][0], true);
    scheduleAutoplay();
  }, AUTOPLAY_MS);
}

function bindAutoplay() {
  $("autoplay").onclick = () => { autoplay = !autoplay; store.set("redpi-autoplay", autoplay ? "1" : "0"); scheduleAutoplay(); };
  // Reading or pointing at the view holds the rotation; leaving it starts a fresh interval.
  const panel = app.querySelector(".view-panel");
  panel.addEventListener("pointerenter", () => { apHover = true; if (autoplay) scheduleAutoplay(); });
  panel.addEventListener("pointerleave", () => { apHover = false; if (autoplay) scheduleAutoplay(); });
  scheduleAutoplay();
}

// The chat keeps counting unread messages while another view is showing (for the tab's badge).
function ensureChat() {
  if (!chatHost) {
    chatHost = document.createElement("div");
    chatHost.className = "chat-host";
    chatView = new Chat(chatHost, { runId, avatar, presence, pendingText, onPerson: select, reload: loadRun, onUnread: updateChatTab, order: orgOrder });
  }
  return chatView;
}

// The Stats time filter: All, this week, or today. The trend charts clip to it; snapshots stay current.
const STATS_RANGES = [["all", "All"], ["week", "This week"], ["today", "Today"]];
let statsRange = STATS_RANGES.some(([k]) => k === store.get(`redpi-stats-range`)) ? store.get(`redpi-stats-range`) : "today";
function statsFrom() {
  const now = state?.now || Date.now();
  if (statsRange === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (statsRange === "week") return now - 7 * 86400_000;
  return 0;
}
function renderStats(body) {
  if (!body.querySelector(".charts")) {
    body.innerHTML = `<div class="stats-bar"><div class="viewtabs" role="tablist" aria-label="Time range">${STATS_RANGES.map(([k, l]) => `<button role="tab" data-range="${k}">${l}</button>`).join("")}</div>
      <span class="stats-total" aria-live="polite"></span><span class="muted stats-note" style="font-size:12px"></span></div><div class="charts" id="charts"></div>`;
    body.querySelector(".stats-bar").addEventListener("click", (e) => { const b = e.target.closest("[data-range]"); if (b) { statsRange = b.dataset.range; store.set("redpi-stats-range", statsRange); renderStats(body); } });
  }
  body.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.range === statsRange)));
  body.querySelector(".stats-note").textContent = statsRange === "all" ? "Whole run" : statsRange === "week" ? "Trends over the last 7 days · snapshots are current" : "Trends since midnight · snapshots are current";
  // The headline total the user asked for: all tokens used across the team in the selected window.
  const u = usageSummary(state, statsFrom()), word = statsRange === "all" ? "all time" : statsRange === "week" ? "this week" : "today";
  body.querySelector(".stats-total").innerHTML = u.tokens
    ? `<strong>${fmtTokens(u.tokens)}</strong> tokens ${word} · ${u.calls.toLocaleString()} call${u.calls === 1 ? "" : "s"} · ${u.people} active${u.cost > 0 ? ` · $${u.cost.toFixed(2)}` : ""}`
    : `<span class="muted">No token use ${word}</span>`;
  // Rebuild the nine SVGs only when the data (or range) changed, not on every live tick while Stats is open.
  const lastTr = (state.transitions || []).at(-1)?.id || 0, lastUse = (state.usage?.series || []).length;
  const sig = `${statsRange}|${state.tasks.map((t) => t.status).join("")}|${lastTr}|${lastUse}|${(state.workers || []).length}`;
  const charts = $("charts");
  if (charts.dataset.sig === sig && charts.children.length) return;
  charts.dataset.sig = sig;
  renderCharts(charts, state, statsFrom());
}

function renderView() {
  const body = $("view-body");
  if (view !== "shots") delete body.dataset.shotsKey;
  if (view === "office") {
    if (!officeHost) {
      officeHost = document.createElement("div");
      officeHost.className = "office-host";
      office = new Office(officeHost, { onSelect: select });
    }
    if (officeHost.parentNode !== body) body.replaceChildren(officeHost);
    body.dataset.view = "office";
    office.setActive(true);
    office.update(state);
    return;
  }
  office?.setActive(false);
  chatView?.setActive(view === "chat");
  if (view === "chat") {
    ensureChat();
    if (chatHost.parentNode !== body) body.replaceChildren(chatHost);
    body.dataset.view = "chat";
    chatView.setActive(true);
    chatView.update(state);
    return;
  }
  if (view === "inbox") {
    if (!inboxHost) {
      inboxHost = document.createElement("div");
      inboxHost.className = "inbox-host";
      inboxView = new Inbox(inboxHost, { roleOf, onChanged: () => { loadRun(); inboxBadge(); } });
    }
    if (inboxHost.parentNode !== body) body.replaceChildren(inboxHost);
    body.dataset.view = "inbox";
    inboxView.update(state.inbox || []);
    return;
  }
  // Board, Timeline, Stats and Screenshots scroll inside the view; each keeps its own place.
  const top = body.dataset.view === view ? body.scrollTop : viewScroll[view] || 0;
  body.dataset.view = view;
  if (view !== "board") delete body.dataset.boardSig;
  if (view === "feed") { renderFeedView(body); return; }
  if (view === "stats") { renderStats(body); body.scrollTop = top; return; }
  if (view === "timeline") { renderTimeline(body, state); body.scrollTop = top; return; }
  if (view === "shots") { renderShots(body); body.scrollTop = top; return; }
  const { tasks, workers, plan } = state;
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  const titles = plan ? Object.fromEntries(plan.plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, { story: s, task: t }]))) : {};
  // Rebuild only when a card changed: this ran a full innerHTML teardown on every live tick.
  const withAtt = new Set((state.attachments || []).map((a) => a.task_id));
  const boardSig = `${view}|${tasks.map((t) => `${t.id}:${t.status}:${t.worker_id || ""}:${t.priority || ""}:${(t.note || "").length}:${(state.taskTokens || {})[t.id] >= 1e6 ? 1 : 0}:${withAtt.has(t.id) ? 1 : 0}`).join(";")}`;
  if (body.dataset.boardSig === boardSig && body.querySelector(".kanban")) { body.scrollTop = top; return; }
  body.dataset.boardSig = boardSig;
  const left = body.querySelector(".kanban")?.scrollLeft || 0;
  body.innerHTML = tasks.length ? `<div class="kanban">${COLUMNS.map(([k, label]) => {
    const cards = tasks.filter((t) => t.status === k).map((t, i) => [t, i]).sort(([a, i], [b, j]) => prioRank(a) - prioRank(b) || i - j).map(([t]) => t);
    return `<div class="col ${k}"><h3>${label}<span>${cards.length}</span></h3><div class="cards">${cards.map((t) => {
      const w = byId[t.worker_id];
      return `<button class="card${t.kind === "ticket" ? ` ticket p-${esc(t.priority || "normal")}` : ""}" data-task="${esc(t.id)}" title="${esc(`${t.id} ${t.title}${t.note ? `\n\n${t.note}` : ""}`.slice(0, 1500))}"><div class="id">${esc(t.id)} · ${t.kind === "ticket" ? `<span class="prio p-${esc(t.priority || "normal")}" title="${esc(PRIO_LABEL[t.priority] || "Normal")} ticket">${esc(PRIO_LABEL[t.priority] || "Normal")}</span>${(state.attachments || []).some((a) => a.task_id === t.id) ? ` <span title="has attachments">📎</span>` : ""}` : esc(titles[t.id]?.story.title || t.story_id)}</div><div class="tt">${esc(t.title)}</div>
        <div class="who">${w ? `${avatar(w.name, w.id, "sm")} ${esc(w.name)}` : `<span class="faint">unassigned</span>`}</div>${(state.taskTokens || {})[t.id] >= 1e6 ? `<div class="faint" title="Tokens spent on this task by everyone">${((state.taskTokens[t.id]) / 1e6).toFixed(1)}M tokens</div>` : ""}${k === "review" && byId[t.reviewer_id] ? `<div class="waiting">Reviewer: ${esc(byId[t.reviewer_id].name)} · waiting ${Math.max(1, Math.round((Date.now() - t.updated) / 60000))} min</div>` : ""}${k === "blocked" && t.blocked_on ? `<div class="waiting ${t.blocked_on === "human" ? "you" : ""}">${esc(waitingOn(t))}</div>` : ""}${t.note && k !== "done" ? `<div class="note">${esc(t.note)}</div>` : ""}</button>`;
    }).join("")}</div></div>`;
  }).join("")}</div>` : `<div class="empty">The board fills in when you approve the plan.</div>`;
  const k = body.querySelector(".kanban");
  if (k) k.scrollLeft = left;
  body.scrollTop = top;
}

// ---------- Feed: everything everyone says and does, live, so a silent (stuck) agent is obvious ----------
let feedViewQuery = "", feedViewAgent = null, feedViewSaysOnly = false, feedTicker = null;
const VERBAL_KINDS = new Set(["say", "reply", "btw", "info", "job", "error"]);
const FEED_TAG = { say: "says", reply: "answer", btw: "btw", info: "note", job: "job", error: "error", chat: "message", command: "message", brief: "brief", decision: "decision", interrupt: "interrupt", aside: "btw", quick: "quick", ticket: "ticket", system: "HQ" };
function feedEntries() {
  const out = [];
  for (const e of state.events || []) if (VERBAL_KINDS.has(e.kind)) out.push({ id: `e${e.id}`, who: e.worker_id, kind: e.kind, text: e.text, created: e.created });
  for (const m of state.messages || []) if (m.kind !== "task") out.push({ id: `m${m.id}`, who: m.sender, to: m.recipient, kind: m.kind, text: m.body, created: m.created });
  return out.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}
function renderFeedView(body) {
  if (!body.querySelector(".livefeed")) {
    body.innerHTML = `<div class="livefeed">
      <div class="lf-agents" id="lf-agents" role="group" aria-label="Who is talking — click to filter"></div>
      <div class="lf-bar">
        <input type="search" id="lf-q" placeholder="Filter the stream…" autocomplete="off">
        <label class="lf-toggle"><input type="checkbox" id="lf-says"> Narration only</label>
        <span class="muted lf-count" id="lf-count"></span>
      </div>
      <div class="lf-stream" id="lf-stream" tabindex="0" aria-label="Everything the team is saying and doing, newest at the bottom"></div></div>`;
    body.querySelector("#lf-q").value = feedViewQuery;
    body.querySelector("#lf-says").checked = feedViewSaysOnly;
    body.querySelector("#lf-q").addEventListener("input", (e) => { feedViewQuery = e.target.value; paintFeedStream(body, true); });
    body.querySelector("#lf-says").addEventListener("change", (e) => { feedViewSaysOnly = e.target.checked; paintFeedStream(body, true); });
    body.querySelector("#lf-agents").addEventListener("click", (e) => { const c = e.target.closest("[data-agent]"); if (!c) return; feedViewAgent = feedViewAgent === c.dataset.agent ? null : c.dataset.agent; paintFeedAgents(body); paintFeedStream(body, true); });
  }
  paintFeedAgents(body);
  paintFeedStream(body);
  if (!feedTicker) feedTicker = setInterval(() => { if (view === "feed" && document.getElementById("lf-agents")) paintFeedAgents(body); else { clearInterval(feedTicker); feedTicker = null; } }, 1000);
}
// Per-agent pulse: how long since each person last said or did anything. Green = fresh, amber = quiet,
// red = silent while supposedly working (a likely hang). This is the at-a-glance "who is stuck".
function paintFeedAgents(body) {
  const host = body.querySelector("#lf-agents"); if (!host) return;
  const now = Date.now();
  const last = new Map();
  for (const e of feedEntries()) last.set(e.who, Math.max(last.get(e.who) || 0, e.created));
  const ceoSeen = state.run?.ceo_seen;
  const people = [{ id: "ceo", name: "CEO", working: state.run?.status === "executing", seen: ceoSeen }]
    .concat(orgOrder(state.workers.filter((w) => w.alive)).map((w) => ({ id: w.id, name: w.name, working: w.status === "working" || w.status === "starting", seen: w.updated })));
  host.innerHTML = people.map((p) => {
    const at = Math.max(last.get(p.id) || 0, p.seen || 0);
    const age = at ? now - at : Infinity;
    const tone = age < 60_000 ? "fresh" : age < 5 * 60_000 ? (p.working ? "warn" : "idle") : (p.working ? "stuck" : "idle");
    const ageTxt = at ? ago(at).replace(/ ago$/, "") : "—";
    return `<button type="button" class="lf-chip ${tone}${feedViewAgent === p.id ? " on" : ""}" data-agent="${esc(p.id)}" title="${esc(p.name)} last spoke or acted ${at ? ago(at) : "never"}${p.working ? " · working" : ""}"><span class="lf-dot"></span>${esc(p.name)} <span class="faint">${esc(ageTxt)}</span></button>`;
  }).join("");
}
function paintFeedStream(body, force) {
  const stream = body.querySelector("#lf-stream"); if (!stream) return;
  let entries = feedEntries();
  if (feedViewAgent) entries = entries.filter((e) => e.who === feedViewAgent || e.to === feedViewAgent);
  if (feedViewSaysOnly) entries = entries.filter((e) => ["say", "reply", "btw"].includes(e.kind));
  const q = feedViewQuery.trim().toLowerCase();
  if (q) entries = entries.filter((e) => String(e.text || "").toLowerCase().includes(q) || nameOf(e.who).toLowerCase().includes(q));
  const sig = `${feedViewAgent || ""}|${feedViewSaysOnly}|${q}|${entries.length}|${entries.at(-1)?.id || ""}`;
  const countEl = body.querySelector("#lf-count");
  if (countEl) countEl.textContent = `${entries.length} line${entries.length === 1 ? "" : "s"}`;
  if (!force && stream.dataset.sig === sig) return;
  const atEnd = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 40;
  stream.dataset.sig = sig;
  stream.innerHTML = entries.length ? entries.map((e) => {
    const to = e.to && e.to !== "all" && !VERBAL_KINDS.has(e.kind) ? ` <span class="faint">→ ${esc(nameOf(e.to))}</span>` : e.to === "all" ? ` <span class="faint">→ everyone</span>` : "";
    return `<div class="lf-item k-${esc(e.kind)}">${avatar(nameOf(e.who), e.who, "sm")}
      <div class="lf-b"><div class="lf-m"><b>${esc(nameOf(e.who))}</b>${to} <span class="lf-tag">${esc(FEED_TAG[e.kind] || e.kind)}</span><span class="when faint" data-t="${e.created}">${ago(e.created)}</span></div>
      <div class="lf-t md">${md(String(e.text || ""))}</div></div></div>`;
  }).join("") : `<div class="empty">${feedViewAgent || q || feedViewSaysOnly ? "Nothing matches this filter yet." : "Nothing said yet. As the CEO and the team work, everything they say and do streams here."}</div>`;
  if (force || atEnd) stream.scrollTop = stream.scrollHeight;
}

// ---------- tickets: the human adds work straight to the board ----------
const PRIO_LABEL = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const prioRank = (t) => t.kind === "ticket" ? ({ urgent: 0, high: 1, normal: 3, low: 4 })[t.priority] ?? 3 : 2;
const kb = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const readB64 = (file) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, "")); r.onerror = () => fail(r.error); r.readAsDataURL(file); });

function openTicketForm() {
  if (document.getElementById("ticket-form")) return;
  const back = document.activeElement;
  const files = [];
  const wrap = document.createElement("div");
  wrap.className = "modal-back";
  wrap.innerHTML = `<form class="modal panel" id="ticket-form" role="dialog" aria-modal="true" aria-labelledby="tk-h" novalidate>
    <div class="panel-head"><h2 id="tk-h">New ticket</h2><span class="muted" style="font-size:12px">goes straight to the board; the CEO gets it done, no plan or approval</span><button type="button" class="btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body">
      <label class="fld"><span>Title</span><input id="tk-title" maxlength="200" required autocomplete="off" placeholder="e.g. Login button does nothing on Safari"></label>
      <label class="fld"><span>Description <em class="faint">Markdown · paste or drop files here</em></span><textarea id="tk-desc" rows="7" placeholder="What should happen, what happens now, where, and how to check it's done"></textarea></label>
      <div class="fld-row">
        <fieldset class="fld prio-pick"><legend>Priority</legend>${["urgent", "high", "normal", "low"].map((p) => `<label class="p-${p}"><input type="radio" name="tk-prio" value="${p}"${p === "normal" ? " checked" : ""}><span>${PRIO_LABEL[p]}</span></label>`).join("")}</fieldset>
        <label class="fld hours"><span>Estimate <em class="faint">hours, optional</em></span><input id="tk-hours" type="number" min="0" step="0.5" inputmode="decimal"></label>
      </div>
      <p class="prio-hint muted" id="tk-hint"></p>
      <div class="fld"><span>Attachments <em class="faint">up to 10 files, 10 MB each</em></span>
        <label class="drop" id="tk-drop"><input type="file" id="tk-files" multiple class="sr-only"><span>Drop files here, paste a screenshot, or <u>choose files</u></span></label>
        <ul class="att-list" id="tk-list"></ul></div>
      <div class="form-err" id="tk-err" role="alert"></div>
    </div>
    <div class="modal-foot"><span class="faint" style="font-size:12px">Ctrl+Enter to add</span><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary" id="tk-go">Add ticket</button></div>
  </form>`;
  document.body.append(wrap);
  const form = wrap.querySelector("form"), list = wrap.querySelector("#tk-list"), err = wrap.querySelector("#tk-err");
  const hint = () => {
    const p = form.querySelector("[name=tk-prio]:checked").value;
    wrap.querySelector("#tk-hint").textContent = p === "urgent" ? "Urgent: the CEO acts on it right away, before other work, and brings in or spawns a worker if nobody is free."
      : p === "high" ? "High: next in line for the first free person." : p === "low" ? "Low: picked up when the team has room." : "Normal: assigned to a free person, or a new worker if nobody is free.";
  };
  hint();
  const draw = () => { list.innerHTML = files.map((f, i) => `<li>${f.type.startsWith("image/") ? "🖼" : "📄"} <span class="nm">${esc(f.name)}</span> <span class="faint">${kb(f.size)}</span><button type="button" class="linkish" data-rm="${i}" aria-label="Remove ${esc(f.name)}">remove</button></li>`).join(""); };
  const add = (fl) => {
    for (const f of fl) {
      if (files.length >= 10) { err.textContent = "Up to 10 attachments per ticket."; break; }
      if (f.size > 10 * 1024 * 1024) { err.textContent = `${f.name} is larger than 10 MB.`; continue; }
      files.push(f.name && f.name !== "image.png" ? f : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type }));
    }
    draw();
  };
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey, true); back?.focus?.(); if (autoplay) scheduleAutoplay(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    else if (e.key === "Tab") {
      const f = [...form.querySelectorAll("input,textarea,button")].filter((x) => !x.disabled && x.offsetParent && x.type !== "radio" || x.checked);
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) return close();
    const rm = e.target.closest("[data-rm]");
    if (rm) { files.splice(Number(rm.dataset.rm), 1); err.textContent = ""; draw(); }
  });
  form.addEventListener("change", (e) => { if (e.target.name === "tk-prio") hint(); if (e.target.id === "tk-files") { add(e.target.files); e.target.value = ""; } });
  const drop = wrap.querySelector("#tk-drop");
  for (const el of [drop, wrap.querySelector("#tk-desc")]) {
    el.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); drop.classList.add("over"); } });
    el.addEventListener("dragleave", () => drop.classList.remove("over"));
    el.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); drop.classList.remove("over"); add(e.dataTransfer.files); } });
  }
  form.addEventListener("paste", (e) => { const fl = [...(e.clipboardData?.files || [])]; if (fl.length) { e.preventDefault(); add(fl); } });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = form.querySelector("#tk-title").value.trim();
    if (!title) { err.textContent = "Give the ticket a title."; form.querySelector("#tk-title").focus(); return; }
    const go = form.querySelector("#tk-go");
    go.disabled = true; go.textContent = files.length ? "Uploading…" : "Adding…"; err.textContent = "";
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, data: await readB64(f) })));
      const priority = form.querySelector("[name=tk-prio]:checked").value;
      const t = await api("POST", `/api/runs/${runId}/tickets`, { title, description: form.querySelector("#tk-desc").value, priority, hours: form.querySelector("#tk-hours").value || undefined, attachments });
      close();
      toast(`${t.id} added${priority === "urgent" ? " as urgent" : ""}. The CEO has it and will say who is on it.`);
      announce(`Ticket ${t.id} added`);
      refresh();
    } catch (x) { err.textContent = x.message; go.disabled = false; go.textContent = "Add ticket"; }
  });
  form.querySelector("#tk-title").focus();
}

function ticketDetails(t) {
  const files = (state.attachments || []).filter((a) => a.task_id === t.id);
  return `<div class="tk-meta"><span class="prio p-${esc(t.priority || "normal")}">${esc(PRIO_LABEL[t.priority] || "Normal")}</span> ticket${t.hours ? ` · about ${esc(t.hours)}h` : ""}${t.created ? ` · added ${ago(t.created)}` : ""}</div>
    ${t.description ? `<div class="md tk-desc">${md(t.description)}</div>` : ""}
    ${files.length ? `<div><div class="section-title" style="margin-bottom:6px">Attachments</div><div class="att-grid">${files.map((f) => f.mime.startsWith("image/")
      ? `<a class="att img" href="/api/attachments/${encodeURIComponent(f.id)}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(f.name)}" src="/api/attachments/${encodeURIComponent(f.id)}"><span>${esc(f.name)}</span></a>`
      : `<a class="att" href="/api/attachments/${encodeURIComponent(f.id)}" download="${esc(f.name)}">📄 <span>${esc(f.name)}</span> <span class="faint">${kb(f.bytes)}</span></a>`).join("")}</div></div>` : ""}`;
}

// ---------- screenshots: what agents checked in the browser, newest first ----------
function shotCaption(s) {
  return `<figcaption><div class="shot-who">${avatar(nameOf(s.worker_id), s.worker_id, "sm")}<button class="linkish" data-person="${esc(s.worker_id)}">${esc(nameOf(s.worker_id))}</button>${s.task_id ? `<button class="linkish mono" data-task="${esc(s.task_id)}">${esc(s.task_id)}</button>` : ""}<span class="when" data-t="${s.created}">${ago(s.created)}</span></div>${s.caption ? `<div class="shot-cap">${esc(s.caption)}</div>` : ""}</figcaption>`;
}
function renderShots(body) {
  const shots = state.screenshots || [];
  // Only rebuild when the list changes, so images never reload on every update.
  const key = shots.map((s) => s.id).join(",") + "|" + state.workers.map((w) => w.name).join(",");
  if (body.dataset.shotsKey === key && body.querySelector(".shots, .empty")) {
    body.querySelectorAll(".when[data-t]").forEach((w) => { w.textContent = ago(Number(w.dataset.t)); });
    return;
  }
  body.dataset.shotsKey = key;
  body.innerHTML = shots.length ? `<div class="shots">${shots.map((s) => `<figure class="shot">
      <button class="shot-img" data-shot="${esc(s.id)}" aria-label="Enlarge screenshot${s.caption ? `: ${esc(s.caption)}` : ""}"><img loading="lazy" decoding="async" alt="${esc(s.caption || `Screenshot by ${nameOf(s.worker_id)}`)}" src="/api/screenshots/${encodeURIComponent(s.id)}"></button>
      ${shotCaption(s)}</figure>`).join("")}</div>`
    : `<div class="empty">No screenshots yet. Agents on frontend work check their pages in a browser and share what they see here.</div>`;
}
// Lightbox: click to enlarge, arrows for the next and previous one, Esc to close.
let shotOpen = null;
function openShot(id) {
  const shots = state.screenshots || [];
  const i = shots.findIndex((s) => s.id === id);
  if (i < 0) return closeShot();
  const s = shots[i];
  let lb = document.getElementById("lightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "lightbox"; lb.className = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true");
    document.body.append(lb);
    lb.onclick = (e) => {
      const b = e.target.closest("[data-nav],[data-person],[data-task],.lb-close");
      if (b?.dataset.nav) return openShot(b.dataset.nav);
      if (b?.dataset.person) { closeShot(); return select(b.dataset.person); }
      if (b?.dataset.task) { closeShot(); openPanel = { task: b.dataset.task }; return renderPanel(); }
      if (b || e.target === lb) closeShot();
    };
  }
  const prev = shots[i + 1], next = shots[i - 1];
  shotOpen = id;
  lb.setAttribute("aria-label", `Screenshot by ${nameOf(s.worker_id)}`);
  lb.innerHTML = `<figure><img alt="${esc(s.caption || `Screenshot by ${nameOf(s.worker_id)}`)}" src="/api/screenshots/${encodeURIComponent(s.id)}">${shotCaption(s)}</figure>
    <button class="lb-close btn" aria-label="Close">✕</button>
    ${prev ? `<button class="lb-nav prev btn" data-nav="${esc(prev.id)}" aria-label="Older screenshot">‹</button>` : ""}${next ? `<button class="lb-nav next btn" data-nav="${esc(next.id)}" aria-label="Newer screenshot">›</button>` : ""}
    <div class="lb-count faint">${shots.length - i} of ${shots.length}</div>`;
  lb.querySelector(".lb-close").focus();
}
function closeShot() {
  const lb = document.getElementById("lightbox");
  if (lb) lb.remove();
  const back = shotOpen && document.querySelector(`[data-shot="${CSS.escape(shotOpen)}"]`);
  shotOpen = null;
  back?.focus();
}
document.addEventListener("keydown", (e) => {
  if (!shotOpen) return;
  if (e.key === "Escape") { e.stopImmediatePropagation(); closeShot(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const b = document.querySelector(`#lightbox .lb-nav.${e.key === "ArrowLeft" ? "prev" : "next"}`);
    if (b) { e.preventDefault(); openShot(b.dataset.nav); }
  }
}, true);

// ---------- event board: chat and actions in one live feed ----------
function feedItems() {
  const { messages, events = [], transitions = [] } = state;
  const items = [];
  // Task moves come from the transition log (who, from → to, why), so their chat echoes are skipped.
  for (const m of messages) if (!(m.kind === "task" && transitions.length)) items.push({ key: `m${m.id}`, t: m.created, kind: "chat", html: () => msgView(m) });
  for (const tr of transitions) items.push({ key: `t${tr.id}`, t: tr.created, kind: "updates", html: () => moveView(tr) });
  for (const e of events) {
    if (e.kind === "say") items.push({ key: `e${e.id}`, t: e.created, kind: "updates", html: () => sayView(e) });
    else if (e.kind === "job" || e.kind === "shot") items.push({ key: `e${e.id}`, t: e.created, kind: "updates", html: () => noticeView(e) });
    else if (e.kind === "tool" || e.kind === "error") items.push({ key: `e${e.id}`, t: e.created, kind: "tools", html: () => eventView(e) });
  }
  return items.sort((a, b) => a.t - b.t);
}

function moveView(tr) {
  const title = state.tasks.find((t) => t.id === tr.task_id)?.title || "";
  const who = tr.actor && tr.actor !== "human" ? `<button class="linkish" data-person="${esc(tr.actor)}">${esc(nameOf(tr.actor))}</button>` : `<b>${esc(nameOf(tr.actor || "human"))}</b>`;
  return `<div class="act move"><span class="act-dot" style="background:${STATUS_COLOR[tr.to_status] || "var(--faint)"}"></span>
    <span class="act-text">${who} moved <button class="linkish" data-task="${esc(tr.task_id)}">${esc(tr.task_id)}</button> ${esc(title)}: ${tr.from_status ? `${esc(STATUS_LABEL[tr.from_status] || tr.from_status)} → ` : ""}<b style="color:${STATUS_COLOR[tr.to_status] || "inherit"}">${esc(STATUS_LABEL[tr.to_status] || tr.to_status)}</b>${tr.target ? (tr.to_status === "blocked" ? `, waiting on ${esc(tr.target === "human" ? "you" : nameOf(tr.target))}` : ` for ${esc(nameOf(tr.target))}`) : ""}${tr.reason ? `<span class="muted"> · ${esc(tr.reason)}</span>` : ""}</span>
    <span class="when" data-t="${tr.created}">${ago(tr.created)}</span></div>`;
}

// An agent's own words about what it is doing: the human-readable progress line.
function sayView(e) {
  const text = String(e.text).replace(/\s+\n/g, "\n").trim();
  return `<div class="upd"><div class="upd-hdr">${avatar(nameOf(e.worker_id), e.worker_id, "sm")}<button class="linkish" data-person="${esc(e.worker_id)}">${esc(nameOf(e.worker_id))}</button><span class="when" data-t="${e.created}">${ago(e.created)}</span></div>
    <div class="upd-body md">${md(text.length > 700 ? text.slice(0, 700) + "…" : text)}</div></div>`;
}

// Background jobs (long builds, docker) and shared screenshots, as one-line updates.
function noticeView(e) {
  const text = String(e.text);
  const shot = e.kind === "shot" && (state.screenshots || []).find((s) => s.worker_id === e.worker_id && Math.abs(s.created - e.created) < 5000);
  const bad = e.kind === "job" && /stuck|looks wrong|failed|exit code [1-9]|error/i.test(text);
  return `<div class="act notice${bad ? " bad" : ""}"><span class="act-icon">${e.kind === "shot" ? "📷" : "⏳"}</span>
    <span class="act-text"><button class="linkish" data-person="${esc(e.worker_id)}">${esc(nameOf(e.worker_id))}</button> ${esc(text.length > 400 ? text.slice(0, 400) + "…" : text)}${shot ? ` <button class="linkish" data-shot="${esc(shot.id)}">view</button>` : ""}</span>
    <span class="when" data-t="${e.created}">${ago(e.created)}</span></div>`;
}

// Latest "say" per worker, computed once per state in a single pass instead of scanning all events per worker.
let _sayCache = null, _sayState = null;
function saysByWorker() {
  if (_sayState === state) return _sayCache;
  const m = new Map();
  for (const e of state?.events || []) if (e.kind === "say") m.set(e.worker_id, e);
  _sayCache = m; _sayState = state;
  return m;
}
// The latest thing someone said about their work (for team cards and panels).
function latestUpdate(id, maxAgeMs = 15 * 60_000) {
  const e = saysByWorker().get(id);
  return e && Date.now() - e.created < maxAgeMs ? e : null;
}

function eventView(e) {
  const tool = String(e.text).split(":")[0].toLowerCase();
  const bad = e.kind === "error" || e.ok === 0;
  return `<div class="act tool${bad ? " bad" : ""}"><span class="act-icon">${esc(e.kind === "error" ? "!" : TOOL_ICON[tool] || (tool.startsWith("redplan_") ? "✉" : "•"))}</span>
    <span class="act-text"><button class="linkish" data-person="${esc(e.worker_id)}">${esc(nameOf(e.worker_id))}</button> <code>${esc(String(e.text).slice(0, 220))}</code>${e.ms != null ? ` <span class="faint">${e.ms < 1000 ? `${e.ms}ms` : `${(e.ms / 1000).toFixed(1)}s`}</span>` : ""}${bad && e.kind !== "error" ? ` <span class="bad-tag">failed</span>` : ""}</span>
    <span class="when" data-t="${e.created}">${ago(e.created)}</span></div>`;
}

// Patches the feed in place: existing entries stay, new ones slot into time order, and
// ones that aged out are removed while the entry you are reading stays put.
function renderFeed() {
  const feed = $("feed"), newBtn = app.querySelector(".chat-new");
  const atEnd = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  const anchor = [...feed.children].find((el) => el.offsetTop + el.offsetHeight > feed.scrollTop);
  const anchorTop = anchor?.offsetTop;
  const existing = new Map([...feed.children].map((el) => [el.dataset.key, el]));
  let prev = null, added = 0;
  const wanted = (kind) => feedFilter === "all" || feedFilter === kind;
  const tpl = document.createElement("template");
  for (const it of feedItems()) {
    let el = existing.get(it.key);
    if (el) existing.delete(it.key);
    else {
      tpl.innerHTML = it.html().trim();
      el = tpl.content.firstElementChild;
      el.dataset.key = it.key;
      if (wanted(it.kind)) added++;
    }
    const want = prev ? prev.nextElementSibling : feed.firstElementChild;
    if (el !== want) feed.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  feed.querySelectorAll(".when[data-t]").forEach((w) => { w.textContent = ago(Number(w.dataset.t)); });
  if (atEnd) { feed.scrollTop = feed.scrollHeight; feedUnseen = 0; }
  else {
    if (anchor?.isConnected) feed.scrollTop += anchor.offsetTop - anchorTop;   // keep your place
    feedUnseen += added;
  }
  newBtn.hidden = !feedUnseen;
  newBtn.textContent = `↓ ${feedUnseen} new`;
}

let pastOpen = false, teamSig = "";
function renderTeam() {
  const { run, workers } = state;
  // Rebuild only when something a card shows actually changed (this panel is always visible, so it ran every tick).
  const sig = `${run.status}|${pastOpen}|${workers.map((w) => `${w.id}:${workerState(w)}:${w.current_task || ""}:${w.activity?.text || ""}:${latestUpdate(w.id)?.id || 0}:${w.is_manager ? 1 : 0}:${w.manager_id || ""}`).join(";")}`;
  if (sig === teamSig && $("team").children.length) return;
  teamSig = sig;
  // Each card says what the person last told us they are doing, in their words; else the live tool.
  const doing = (id, fallback) => { const u = latestUpdate(id); return u ? `<div class="doing said" title="${esc(plain(u.text))}">“${esc(plain(u.text))}”</div>` : `<div class="doing">${esc(fallback)}</div>`; };
  // The team is who is here (or left mid-task, so you see it); everyone who left with nothing on them is folded away.
  const current = orgOrder(workers.filter((w) => w.alive || workerState(w) === "lost")), past = workers.filter((w) => !current.includes(w));
  const managerName = (w) => workers.find((m) => m.id === w.manager_id)?.name;
  const card = (w) => { const st = workerState(w), gone = !w.alive;
    const what = st === "lost" ? `session ended while holding ${holds(w).map((t) => t.id).join(", ")}` : gone ? `${st === "dismissed" ? "dismissed" : "left"}${w.left_at ? ` ${ago(w.left_at)}` : ""}` : `${w.current_task ? `${w.current_task} · ` : ""}${w.activity?.text || w.last_message || w.status}`;
    const report = w.manager_id && current.some((m) => m.id === w.manager_id);
    return `<button class="member${gone ? ` gone ${st}` : ""}${w.is_manager ? " manager" : ""}${report ? " report" : ""}" data-person="${esc(w.id)}">${avatar(w.name, w.id)}<span><span class="name">${esc(w.name)}</span> <span class="role">${esc(w.role)}</span>${w.is_manager ? ` <span class="pill amber harness-pill">manages ${esc(w.team || "a team")}</span>` : report ? ` <span class="faint" style="font-size:11px">→ ${esc(managerName(w))}</span>` : ""}${w.harness && w.harness !== "pi" ? ` <span class="pill violet harness-pill">${esc(w.harnessName)}</span>` : ""}
      ${gone ? `<div class="doing">${esc(what)}</div>` : doing(w.id, what)}</span><span class="dot ${st === "needs" ? "offline" : st}" title="${st}"></span></button>`; };
  $("team").innerHTML = `<button class="member" data-person="ceo">${avatar("CEO", "ceo")}<span><span class="name">CEO</span> <span class="role">lead Pi session</span>${doing("ceo", run.status === "awaiting_approval" ? "waiting for your approval" : run.status === "planning" ? "planning" : run.status === "done" ? "run finished" : "coordinating the team")}</span><span class="dot working"></span></button>
    ${current.map(card).join("")}
    ${past.length ? `<details class="past-team"${pastOpen ? " open" : ""}><summary>Past teammates (${past.length}): finished or dismissed, nothing left on them</summary><div class="team past">${past.map(card).join("")}</div></details>` : ""}`;
  $("team").querySelector(".past-team")?.addEventListener("toggle", (e) => { pastOpen = e.target.open; });
}

// The composer's recipients follow the team without resetting your choice.
function syncRecipients() {
  const sel = $("to");
  const opts = [["ceo", "CEO"], ["all", "Everyone"], ...state.workers.filter((w) => w.alive || workerState(w) === "lost" || w.id === draftTo).map((w) => [w.id, w.name])];
  const sig = opts.map((o) => o.join("=")).join("|");
  if (sel.dataset.sig !== sig) {
    const keep = draftTo || sel.value || "ceo";
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
    sel.dataset.sig = sig;
    sel.value = opts.some(([v]) => v === keep) ? keep : "ceo";
  }
}

function select(id) {
  if (!id || id === "human") return;
  if (personId() === id && !openPanel.task) return renderPanel();   // already open: keep the tab
  openPanel = id === "ceo" ? { ceo: true } : { worker: id };
  renderPanel();
}

async function resume(workerId, btn) {
  return busy(btn, async () => { await api("POST", `/api/workers/${workerId}/resume-request`); toast("Asked the CEO to resume them"); loadRun(); });
}

function msgView(m) {
  // HQ's own notes to the CEO (review ready, all done) are stored as from the human; say who really sent them.
  if (m.kind === "system" && m.sender === "human") m = { ...m, sender: "hq", senderName: "HQ" };
  const from = m.sender === "human" || m.sender === "hq" ? `<span class="from">${esc(m.senderName)}</span>` : `<button class="from linkish" data-person="${esc(m.sender)}">${esc(m.senderName)}</button>`;
  const to = m.recipient === "human" || m.recipient === "all" ? esc(m.recipientName) : `<button class="linkish to-link" data-person="${esc(m.recipient)}">${esc(m.recipientName)}</button>`;
  return `<div class="msg ${esc(m.kind)}${m.sender === "human" || m.recipient === "human" ? " with-you" : ""}"><div class="hdr">${avatar(m.senderName, m.sender, "sm")}${from}${m.kind !== "task" ? `<span class="to">→ ${to}</span>` : ""}${m.kind === "interrupt" ? `<span class="pill cyan">interrupt</span>` : m.kind === "brief" ? `<span class="pill">brief</span>` : m.kind === "decision" ? `<span class="pill amber">decision</span>` : m.kind === "aside" ? `<span class="pill violet">btw</span>` : m.kind === "reply" ? `<span class="pill green">reply</span>` : m.kind === "ticket" ? `<span class="pill amber">ticket</span>` : m.kind === "quick" ? `<span class="pill cyan">quick answer</span>` : ""}<span class="when" data-t="${m.created}">${ago(m.created)}</span></div>
    ${m.kind === "task" ? `<div class="body">${esc(m.body)}</div>` : `<div class="body md">${md(m.kind === "brief" && m.body.length > 600 ? m.body.slice(0, 600) + "…" : m.body)}</div>`}</div>`;
}

// Tool waterfall (ported idea from munder-difflin's ToolWaterfall.tsx): one bar per
// timed tool call, width ∝ duration, green ok / red failed, newest last.
function waterfall(events) {
  const calls = events.filter((e) => e.kind === "tool" && e.ms != null).slice(-60);
  if (!calls.length) return `<span class="muted">No timed tool calls yet.</span>`;
  const max = Math.max(...calls.map((c) => c.ms), 1);
  const total = calls.reduce((n, c) => n + c.ms, 0);
  return `<div class="muted" style="font-size:12px;margin-bottom:6px">${calls.length} calls · ${(total / 1000).toFixed(1)}s total · ${calls.filter((c) => c.ok === 0).length} failed</div>
    <div class="wf">${calls.map((c) => `<div class="wf-row" title="${esc(c.text)} — ${c.ms} ms${c.ok === 0 ? " (failed)" : ""}"><span class="wf-label">${esc(c.text)}</span><span class="wf-track"><i class="${c.ok === 0 ? "bad" : ""}" style="width:${Math.max(2, Math.round((c.ms / max) * 100))}%"></i></span><span class="wf-ms">${c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}</span></div>`).join("")}</div>`;
}

// ---------- a person's panel (the CEO or a worker): Chat, Details, Activity ----------
// Chat is a messenger: your messages on the right, their replies on the left, the box
// pinned at the bottom. Agents post their answer back here when the turn that handled
// your message ends. The panel is built once per person and tab; live updates patch it
// in place, so what you are typing is never touched.
const personId = () => (openPanel?.ceo ? "ceo" : openPanel?.worker);

// Your conversation with one person: what you sent them (or everyone) and what they sent you.
function conversation(id) {
  return (state?.messages || []).filter((m) => m.kind !== "system" && m.kind !== "task" &&
    ((m.sender === "human" && (m.recipient === id || m.recipient === "all")) || (m.sender === id && m.recipient === "human")));
}

function bubble(m) {
  const mine = m.sender === "human";
  const tag = m.kind === "aside" ? "btw" : m.kind === "interrupt" ? "interrupt" : m.kind === "decision" ? "plan decision" : m.kind === "reply" ? "full answer" : m.kind === "quick" ? "quick answer" : m.kind === "ticket" ? "ticket" : m.recipient === "all" ? "to everyone" : "";
  const body = m.body.length > 6000 ? m.body.slice(0, 6000) + "…" : m.body;
  return `<div class="bub ${mine ? "me" : "them"}${m.kind === "interrupt" ? " int" : ""}"><div class="bub-meta">${esc(mine ? "You" : m.senderName)}${tag ? ` · ${esc(tag)}` : ""} · <span class="when" data-t="${m.created}">${ago(m.created)}</span></div><div class="bub-body${mine ? "" : " md"}">${mine ? esc(body) : md(body)}</div></div>`;
}

// What is happening with your last message to someone (a quick answer came, the full one is coming; they
// are offline; ...), as plain text, or "" when nothing is pending. The drawer and the Chat view both show it.
function pendingText(id, name, msgs) {
  const lastMine = [...msgs].reverse().find((m) => m.sender === "human");
  const after = lastMine ? msgs.filter((m) => m.id > lastMine.id && m.sender === id) : [];
  // The instant answer came; the full one follows when their live session finishes the turn.
  if (lastMine && lastMine.kind !== "aside" && after.length && after.every((m) => m.kind === "quick")) {
    if (Date.now() - lastMine.created > 45 * 60_000) return "";
    return `${name}'s full answer follows when they finish what they're doing`;
  }
  if (!lastMine || after.length) return "";
  const w = id === "ceo" ? null : state.workers.find((x) => x.id === id);
  const link = id === "ceo" ? ceoLink() : { ok: true };
  const text = w && !w.alive ? (workerState(w) === "lost" ? `${name}'s session ended. Your message waits in their inbox if the CEO resumes them.` : `${name} has left the team, so nobody reads this. Ask the CEO instead.`)
    : !link.ok ? link.text
    : lastMine.kind === "aside" ? (Date.now() - lastMine.created > 3 * 60_000 ? `${name} has not answered on the side after ${ago(lastMine.created).replace(/ ago$/, "")}. The model may be slow or failing; check ${name}'s terminal.` : `${name} is answering on the side…`)
      : `${name} has your message: a quick answer comes in a few seconds, the full one when they finish the current turn.`;
  return text;
}
function pendingNote(id, name, msgs) {
  const text = pendingText(id, name, msgs);
  return text ? `<div class="bub them pending"><div class="bub-body">${esc(text)}<span class="dots">…</span></div></div>` : "";
}

function personSkeleton(id, tab) {
  const w = id === "ceo" ? null : state.workers.find((x) => x.id === id);
  const name = w ? w.name : "CEO";
  const role = w ? `${w.role}${w.harness && w.harness !== "pi" ? ` · ${w.harnessName}` : ""}` : "Lead Pi session: plans, forms the team, reviews, reports to you";
  const tabs = [["chat", "Chat"], ["details", "Details"], ["activity", "Activity"]];
  return `<aside class="drawer" role="dialog" aria-label="${esc(name)}">
    <div class="panel-head">${avatar(name, id, "lg")}<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:16px">${esc(name)}</div><div class="muted" style="font-size:13px">${esc(role)}</div></div><span id="p-status"></span><button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="drawer-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-ptab="${k}" aria-selected="${k === tab}">${l}</button>`).join("")}</div>
    ${tab === "chat" ? `<div class="chat-pane">
      <div id="p-banner"></div>
      <div class="thread" id="thread" aria-live="polite" aria-label="Conversation with ${esc(name)}"></div>
      <div class="drawer-composer">
        <textarea id="wmsg" rows="2" placeholder="Message ${esc(name)}…" aria-label="Message ${esc(name)}"></textarea>
        <div class="composer-actions"><span class="faint hint">Enter sends · Shift+Enter new line · replies appear above</span>
          <button class="btn" id="wask" title="${esc(name)} answers from a copy of their session without stopping their work">Ask on the side</button>
          <button class="btn danger" id="wint" title="Stops what ${esc(name)} is doing now, then delivers your message">Interrupt + send</button>
          <button class="btn primary" id="wsend" title="Delivered into ${esc(name)}'s session as your next message">Send</button></div>
      </div></div>` : `<div class="scroll" id="p-body"></div>`}
  </aside>`;
}

async function renderPerson(root) {
  const id = personId(), tab = openPanel.tab || "chat";
  const w = id === "ceo" ? null : state.workers.find((x) => x.id === id);
  if (id !== "ceo" && !w) { closePanel(); return; }
  const name = w ? w.name : "CEO";
  const key = `p:${id}:${tab}`;
  if (renderedPanel !== key || !root.querySelector(".drawer")) {
    root.innerHTML = personSkeleton(id, tab);
    renderedPanel = key;
    root.querySelector("#close").onclick = closePanel;
    root.querySelectorAll("[data-ptab]").forEach((b) => b.onclick = () => { openPanel.tab = b.dataset.ptab; renderPanel(); });
    root.onclick = async (e) => {
      const c = e.target.closest("[data-copy]");
      if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast("Copied"); } catch { toast("Select the command and copy it"); } }
      if (e.target.closest("#resume")) resume(id, e.target.closest("#resume"));
      const rt = e.target.closest("[data-reply-task]");
      if (rt) {
        const input = root.querySelector("#wmsg");
        const lead = `About ${rt.dataset.replyTask}: `;
        if (!input.value.startsWith(lead)) input.value = lead + input.value;
        input.focus(); input.setSelectionRange(input.value.length, input.value.length);
        return;
      }
      const tk = e.target.closest("[data-task]"), who = e.target.closest("[data-person]");
      if (tk) { openPanel = { task: tk.dataset.task }; renderPanel(); }
      else if (who && who.dataset.person !== id) select(who.dataset.person);
    };
    if (tab === "chat") {
      const input = root.querySelector("#wmsg");
      const send = (kind, btn) => {
        const body = input.value.trim() || (kind === "interrupt" ? "Stop what you are doing and wait for instructions." : "");
        if (!body) return;
        return busy(btn, async () => {
          await api("POST", `/api/runs/${runId}/messages`, { from: "human", to: id, kind, body });
          input.value = "";
          const t = $("thread"); if (t) t.dataset.stick = "1";
          loadRun();
        });
      };
      root.querySelector("#wsend").onclick = (e) => send("command", e.currentTarget);
      root.querySelector("#wint").onclick = (e) => send("interrupt", e.currentTarget);
      root.querySelector("#wask")?.addEventListener("click", (e) => send("aside", e.currentTarget));
      input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send("command", root.querySelector("#wsend")); } };
      input.focus();
    }
  }
  // Live parts: status, banners, then the tab's content.
  const st = w ? workerState(w) : state.run.status;
  $("p-status").innerHTML = w ? `<span class="pill ${st === "working" ? "green" : st === "needs" || st === "lost" ? "red" : ""}">${esc(st)}</span>` : pill(state.run.status);
  // What this person is blocked on, in full, so you can answer it right here.
  const blocked = w ? state.tasks.filter((t) => t.worker_id === id && t.status === "blocked") : [];
  const blockers = blocked.map((t) => `<div class="block-card ${t.blocked_on === "human" ? "" : "team"}"><div class="block-head"><span class="pill ${t.blocked_on === "human" ? "red" : "amber"}">blocked</span><button class="linkish" data-task="${esc(t.id)}">${esc(t.id)}</button> <b>${esc(t.title)}</b><span style="flex:1"></span>${tab === "chat" ? `<button class="btn" data-reply-task="${esc(t.id)}">Reply about ${esc(t.id)}</button>` : ""}</div>
    ${t.blocked_on && t.blocked_on !== "human" ? `<div class="block-who">${esc(waitingOn(t))}: the team is handling it (they and the CEO have the note). You only need to act if you want to.</div>` : t.blocked_on === "human" ? `<div class="block-who you">Waiting on you.</div>` : ""}
    <div class="block-note">${esc(t.note || "No reason given.")}</div></div>`).join("");
  const banner = w && !w.alive ? (workerState(w) === "lost" ? `<div class="banner red">${esc(name)}'s session ended while holding ${esc(holds(w).map((t) => t.id).join(", "))}. <button class="btn" id="resume">Ask the CEO to resume</button></div>`
      : `<div class="banner">${esc(name)} ${workerState(w) === "dismissed" ? "was dismissed" : "left"}${w.left_at ? ` ${ago(w.left_at)}` : ""} with nothing left to do. Their history stays here.</div>`)
    : w?.needs_input ? `<div class="banner red">${esc(w.needs_input.reason)}</div>` : w?.needs_human ? `<div class="banner red">${esc(w.needs_human)}</div>`
      : w?.parked ? `<div class="banner amber">Idle while owning in-progress work; HQ is nudging them.</div>` : "";
  if (tab === "chat") {
    const top = banner + blockers;
    const slot = $("p-banner");
    // Diff on a stable key (not the HTML, which carries a live "3m ago" that changes every tick and lost scroll).
    const bannerKey = `${w ? workerState(w) : state.run.status}|${w?.needs_input?.reason || ""}|${w?.needs_human || ""}|${blocked.map((t) => `${t.id}:${t.status}:${(t.note || "").length}`).join(",")}`;
    if (slot.dataset.key !== bannerKey) { slot.innerHTML = top; slot.dataset.key = bannerKey; }   // keep your scroll in a long note
    const thread = $("thread");
    const msgs = conversation(id);
    const atEnd = thread.dataset.stick === "1" || !thread.children.length || thread.scrollTop + thread.clientHeight >= thread.scrollHeight - 40;
    delete thread.dataset.stick;
    const items = msgs.map((m) => ({ key: `m${m.id}`, html: bubble(m) }));
    const pending = pendingNote(id, name, msgs);
    if (pending) items.push({ key: `pending${msgs.at(-1)?.id}`, html: pending });
    if (!items.length) items.push({ key: blocked.length ? "empty-blocked" : "empty", html: `<div class="thread-empty">${blocked.length ? `Answer the blocker above (or use Reply about ${esc(blocked[0].id)}); ${esc(name)}'s reply appears here.` : `No messages yet. Say hello, give an instruction, or ask a question: ${esc(name)} replies here.`}</div>` });
    const existing = new Map([...thread.children].map((el) => [el.dataset.key, el]));
    const tpl = document.createElement("template");
    let prev = null;
    for (const it of items) {
      let el = existing.get(it.key);
      if (el) existing.delete(it.key);
      else { tpl.innerHTML = it.html.trim(); el = tpl.content.firstElementChild; el.dataset.key = it.key; }
      const want = prev ? prev.nextElementSibling : thread.firstElementChild;
      if (el !== want) thread.insertBefore(el, want);
      prev = el;
    }
    for (const el of existing.values()) el.remove();
    thread.querySelectorAll(".when[data-t]").forEach((x) => { x.textContent = ago(Number(x.dataset.t)); });
    if (atEnd) thread.scrollTop = thread.scrollHeight;
    return;
  }
  const body = $("p-body");
  const pos = { top: body.scrollTop };
  body.innerHTML = tab === "activity" && !w ? updatesList("ceo") : w ? workerDetails(w, tab, tab === "details" ? banner + blockers : banner) : ceoDetails();
  body.scrollTop = pos.top;
}

// What someone has said about their work, newest first.
function updatesList(id) {
  const ups = (state.events || []).filter((e) => e.kind === "say" && e.worker_id === id).slice(-30).reverse();
  return `<div><div class="section-title" style="margin-bottom:6px">Updates in their words</div>${ups.length ? `<div class="upd-list">${ups.map((e) => `<div class="upd-item"><span class="when">${ago(e.created)}</span><div class="upd-body md">${md(e.text.length > 1500 ? e.text.slice(0, 1500) + "…" : e.text)}</div></div>`).join("")}</div>` : `<span class="muted">No updates yet. They appear as ${esc(nameOf(id))} explains what they are doing.</span>`}</div>`;
}

function ceoDetails() {
  const { run, plan, workers, tasks, messages } = state;
  const told = messages.filter((m) => m.sender === "ceo" && m.recipient !== "human").slice(-10);
  const done = tasks.filter((t) => t.status === "done").length;
  const doing = run.status === "awaiting_approval" ? "Waiting for you to approve the plan." : run.status === "planning" ? "Planning: researching the project and drafting the plan." : run.status === "done" ? "The run is finished." : `Leading ${workers.length} worker${workers.length === 1 ? "" : "s"}: assigning tasks, answering questions, reviewing work.`;
  const u = latestUpdate("ceo");
  return `<div>${esc(doing)}</div>${u ? `<div class="upd-body md">${md(u.text)}</div>` : ""}
    <div class="mini-stats"><span><b>${done}/${tasks.length || "–"}</b> tasks done</span><span><b>${tasks.filter((t) => t.status === "in_progress").length}</b> in progress</span><span><b>${tasks.filter((t) => t.status === "blocked").length}</b> blocked</span><span><b>${workers.filter((w) => workerState(w) === "working").length}/${workers.length}</b> working</span></div>
    ${plan ? `<div><a class="btn" href="/plans/${esc(plan.id)}">Open plan v${plan.version}${plan.status === "pending" ? " · needs your approval" : ""}</a></div>` : ""}
    <div><div class="section-title" style="margin-bottom:6px">Latest to the team</div>${told.length ? `<div class="mini-msgs">${told.map(msgView).join("")}</div>` : `<span class="muted">Nothing yet.</span>`}</div>`;
}

// Rendered straight from the run state (already loaded): no per-click fetch, so the drawer opens instantly.
function workerDetails(w, tab, banner) {
  const evs = (state.events || []).filter((e) => e.worker_id === w.id);
  if (tab === "activity") {
    const recent = evs.slice(-60);
    return `${updatesList(w.id)}<div><div class="section-title" style="margin-bottom:6px">Tool calls</div>${waterfall(recent)}</div>
      <div><div class="section-title" style="margin-bottom:6px">Recent activity</div><div class="events">${recent.length ? recent.slice().reverse().map((e) => `<div class="ev"><span>${ago(e.created)}</span><span>${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("") : `<span class="muted">No activity yet.</span>`}</div></div>`;
  }
  const ww = w, ctx = ww.context, attach = ww.attach || "";
  const dTasks = (state.tasks || []).filter((t) => t.worker_id === w.id);
  const lead = ww.manager_id ? (state.workers.find((m) => m.id === ww.manager_id)?.name) : null;
  const reports = ww.is_manager ? (state.workers.find ? state.workers.filter((x) => x.manager_id === w.id) : []) : [];
  const team = (state.messages || []).filter((m) => m.kind !== "task" && m.kind !== "system" && m.sender !== "human" && m.recipient !== "human" && (m.sender === w.id || m.recipient === w.id)).slice(-15);
  return `${banner}
    ${ww.is_manager ? `<div class="muted" style="font-size:13px">Manages ${esc(ww.team || "a team")}${reports.length ? `: ${reports.map((r) => esc(r.name)).join(", ")}` : " (no reports yet)"}</div>` : lead ? `<div class="muted" style="font-size:13px">Reports to ${esc(lead)}</div>` : ""}
    <div><div class="section-title" style="margin-bottom:6px">Now</div>${latestUpdate(w.id) ? `<div class="upd-body">“${esc(latestUpdate(w.id).text)}”</div>` : ""}<div class="muted" style="font-size:13px;margin-top:4px">${ww.current_task ? `<span class="mono">${esc(ww.current_task)}</span> · ` : ""}${esc(ww.activity?.text || ww.status)}</div></div>
    <div><div class="section-title" style="margin-bottom:6px">Tasks</div>${dTasks.length ? dTasks.map((t) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><button class="linkish mono" data-task="${esc(t.id)}">${esc(t.id)}</button><span style="flex:1">${esc(t.title)}</span><span class="pill ${t.status === "done" ? "green" : t.status === "blocked" ? "red" : t.status === "in_progress" ? "cyan" : ""}">${esc(t.status.replace("_", " "))}</span></div>`).join("") : `<span class="muted">No tasks assigned.</span>`}</div>
    ${ctx && ctx.percent != null ? `<div><div class="section-title" style="margin-bottom:6px">Context</div><div class="bar"><i style="width:${Math.min(100, ctx.percent)}%;background:${ctx.percent > 80 ? "var(--red)" : ctx.percent > 50 ? "var(--amber)" : "var(--green)"}"></i></div><div class="faint" style="font-size:12px;margin-top:4px">${Math.round(ctx.percent)}% of ${Math.round((ctx.window || 0) / 1000)}k tokens</div></div>` : ""}
    <div><div class="section-title" style="margin-bottom:6px">Latest message</div><div class="last md">${ww.last_message ? md(ww.last_message) : "Nothing yet."}</div></div>
    <div><div class="section-title" style="margin-bottom:6px">With the team</div>${team.length ? `<div class="mini-msgs">${team.map(msgView).join("")}</div>` : `<span class="muted">No messages with teammates yet.</span>`}</div>
    ${attach ? `<div><div class="section-title" style="margin-bottom:6px">Live session</div><div class="cmd"><code>${esc(attach)}</code><button class="btn" data-copy="${esc(attach)}">Copy</button></div><div class="faint" style="font-size:12px;margin-top:4px">${ww.harness && ww.harness !== "pi" ? `Run this in a terminal on this machine to watch ${esc(w.name)}'s ${esc(ww.harnessName)} turns; type a line there to message them.` : `Run this in a terminal on this machine to watch or type into ${esc(w.name)}'s Pi.`} Detach with Ctrl-b d.</div></div>` : ""}
    ${ww.open ? `<div><div class="section-title" style="margin-bottom:6px">Open in ${esc(ww.harnessName)}</div><div class="cmd"><code>${esc(ww.open)}</code><button class="btn" data-copy="${esc(ww.open)}">Copy</button></div></div>` : ""}
    <div class="muted" style="font-size:13px">Working in <code>${esc(ww.cwd)}</code>${ww.branch ? ` on branch <code>${esc(ww.branch)}</code>` : ""}</div>`;
}

async function renderPanel() {
  const root = document.getElementById("drawer-root");
  if (!openPanel) { root.innerHTML = ""; return; }
  if (openPanel.task) return renderTask(root, openPanel.task);
  return renderPerson(root);
}

const taskHistory = new Map();   // cached per task so the drawer opens instantly, then fills in
async function renderTask(root, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) { closePanel(); return; }
  const meta = state.plan?.plan.stories.flatMap((s) => s.tasks.map((k) => ({ story: s, task: k }))).find((x) => x.task.id === taskId);
  const history = taskHistory.get(taskId) || null;   // null = not loaded yet
  const drawerPos = renderedPanel === `t:${taskId}` ? saveScroll(".drawer .scroll") : null;
  renderedPanel = `t:${taskId}`;
  root.innerHTML = `<aside class="drawer" role="dialog" aria-label="Task ${esc(taskId)}">
    <div class="panel-head"><div style="flex:1;min-width:0"><div class="mono muted">${esc(taskId)} · ${esc(t.kind === "ticket" ? "Ticket" : meta?.story.title || t.story_id)}</div><div style="font-weight:700;font-size:16px">${esc(t.title)}</div></div>${pill(t.status === "done" ? "done" : t.status)}<button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="scroll">
      ${meta ? `<div>${esc(meta.task.description)}</div>${meta.task.tech ? `<div><span class="pill cyan">${esc(meta.task.tech)}</span></div>` : ""}` : ""}
      ${t.kind === "ticket" ? ticketDetails(t) : ""}
      <div class="muted">${t.worker_id ? `Owner: <button class="linkish" data-person="${esc(t.worker_id)}">${esc(nameOf(t.worker_id))}</button>` : "Not assigned yet"}</div>
      ${t.note ? `<div><div class="section-title" style="margin-bottom:6px">Latest note</div><div class="last md">${md(t.note)}</div></div>` : ""}
      <div><div class="section-title" style="margin-bottom:6px">History</div>${history === null ? `<div class="loading-row">Loading history…</div>` : history.length ? `<ol class="history">${history.map((h) => `<li><span class="mono">${esc(h.from_status || "–")} → ${esc(h.to_status)}</span> by <b>${esc(h.actorName)}</b>${h.targetName ? ` → ${esc(h.targetName)}` : ""} <span class="faint">${ago(h.created)}</span>${h.reason ? `<div class="muted">${esc(h.reason)}</div>` : ""}</li>`).join("")}</ol>` : `<span class="muted">No changes yet.</span>`}</div>
    </div></aside>`;
  restoreScroll(".drawer .scroll", drawerPos);
  document.getElementById("close").onclick = closePanel;
  root.onclick = (e) => { const who = e.target.closest("[data-person]"); if (who) select(who.dataset.person); };
  if (history === null && !taskHistory.has(taskId)) {
    try { taskHistory.set(taskId, await api("GET", `/api/runs/${runId}/tasks/${encodeURIComponent(taskId)}/history`)); }
    catch { taskHistory.set(taskId, []); }
    if (renderedPanel === `t:${taskId}` && openPanel?.task === taskId) renderTask(root, taskId);   // fill in, keep scroll
  }
}

function closePanel() { openPanel = null; renderedPanel = null; document.getElementById("drawer-root").innerHTML = ""; if (autoplay) scheduleAutoplay(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPanel) closePanel(); });

const refresh = () => { inboxBadge(); return (runId ? loadRun() : projectId ? loadProject() : inboxPage ? loadInboxPage() : loadHome()).catch((e) => { app.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }); };

// /inbox: every ticket waiting on you, across all projects.
let pageInbox = null;
async function loadInboxPage() {
  const { items } = await api("GET", "/api/inbox?status=all&thread=1");
  document.title = `Inbox${items.some((i) => i.status === "open") ? ` (${items.filter((i) => i.status === "open").length})` : ""} · RedPi HQ`;
  document.getElementById("crumbs").textContent = "Your inbox: everything waiting on you, in every project";
  if (!pageInbox) {
    app.classList.add("inbox-page");
    app.innerHTML = "";
    pageInbox = new Inbox(app, { showRun: true, onChanged: () => { loadInboxPage(); inboxBadge(); } });
    const want = Number((location.hash.match(/^#ticket-(\d+)$/) || [])[1]);
    pageInbox.update(items);
    if (want) pageInbox.select(want, { reveal: true });
    return;
  }
  pageInbox.update(items);
}
refresh();
live(runId, refresh);
signedInAs();
