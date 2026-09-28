import { ago, api, esc, live, pill, signedInAs, toast } from "/static/hq.js";
import { portraitUrl } from "/static/office/people.js";
import { Office } from "/static/office/office.js";
import { renderGraph } from "/static/graph.js";
import { renderCharts } from "/static/charts.js";

const app = document.getElementById("app");
const runId = location.pathname.startsWith("/runs/") ? location.pathname.split("/")[2] : null;
const projectId = location.pathname.startsWith("/projects/") ? location.pathname.split("/")[2] : null;
const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done"]];
let renderedPanel = null;
let state, prev, openPanel = null, draftTo = null, office = null, officeHost = null;

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let view = store.get(`redpi-view-${runId}`);

const workerState = (w) => !w.alive ? "offline" : w.needs_human || w.needs_input || w.parked ? "needs" : w.status === "working" ? "working" : w.status === "starting" ? "starting" : "idle";
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
  const needs = projects.reduce((n, p) => n + p.awaiting_approval + p.workers.filter((w) => w.needsYou).length, 0);
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
  const needs = p.awaiting_approval + p.workers.filter((w) => w.needsYou).length;
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
    if (o && o.alive && !w.alive) lines.push(`${w.name} went offline`);
  }
  const tWas = new Map(a.tasks.map((t) => [t.id, t.status]));
  for (const t of b.tasks) if (tWas.get(t.id) && tWas.get(t.id) !== t.status && (t.status === "done" || t.status === "blocked")) lines.push(`${t.id} ${t.title} is ${t.status}`);
  const lastA = a.messages.at(-1)?.id || 0;
  const fresh = b.messages.filter((m) => m.id > lastA && m.kind !== "task");
  if (fresh.length) lines.push(`${fresh.length} new message${fresh.length > 1 ? "s" : ""}: ${fresh.slice(-2).map((m) => `${m.senderName} to ${m.recipientName}`).join(", ")}`);
  if (lines.length) announce(lines.join(". "));
}

function needsYou() {
  const { workers, tasks, messages } = state;
  const items = [];
  const name = (id) => workers.find((w) => w.id === id)?.name || id;
  for (const t of tasks.filter((t) => t.status === "blocked")) items.push({ id: t.worker_id, level: "red", text: `${t.id} blocked${t.worker_id ? ` (${name(t.worker_id)})` : ""}: ${t.note || "no reason given"}`.slice(0, 1200) });
  for (const w of workers) {
    if (!w.alive && w.status !== "stopped") items.push({ id: w.id, level: "red", text: `${w.name} is offline`, action: "resume" });
    else if (w.needs_input) items.push({ id: w.id, level: "red", text: `${w.name}: ${w.needs_input.reason}` });
    else if (w.needs_human) items.push({ id: w.id, level: "red", text: `${w.name}: ${w.needs_human}` });
    else if (w.parked) items.push({ id: w.id, level: "amber", text: `${w.name} is idle while owning in-progress work` });
  }
  // Questions addressed to you that you have not answered yet.
  // Replies count only when they ask you something back.
  for (const m of messages.filter((m) => m.recipient === "human" && m.kind !== "system" && m.kind !== "aside" && (m.kind !== "reply" || /\?\s*$/.test(m.body.trim().slice(-300))))) {
    if (!messages.some((r) => r.id > m.id && r.sender === "human" && r.kind !== "system" && r.recipient === m.sender)) items.push({ id: m.sender, level: "amber", text: `${m.senderName} asked you: ${m.body.slice(0, 140)}` });
  }
  return items.slice(0, 8);
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
const nameOf = (id) => id === "ceo" ? "CEO" : id === "human" ? "You" : state.workers.find((w) => w.id === id)?.name || id;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function buildRun() {
  app.innerHTML = `
    <div id="live" class="sr-only" aria-live="polite"></div>
    <div class="run-head" id="run-head"></div>
    <div id="needs-slot"></div>
    <div class="stats" id="stats" style="margin-bottom:10px"></div>
    <div class="run-main">
      <div class="panel view-panel">
        <div class="panel-head"><div class="viewtabs" role="tablist">
          ${[["office", "Office"], ["board", "Board"], ["graph", "Graph"]].map(([k, l]) => `<button role="tab" data-view="${k}">${l}</button>`).join("")}
        </div><span class="muted" id="view-hint" style="font-size:12px"></span></div>
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
    <section class="charts-section"><div class="section-head"><h2 class="section-title">Project charts</h2><span class="faint" style="font-size:12px">live</span></div><div class="charts" id="charts"></div></section>`;
  built = runId;
  const feed = $("feed"), newBtn = app.querySelector(".chat-new");
  const atEnd = () => feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  newBtn.onclick = () => feed.scrollTo({ top: feed.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" });
  feed.onscroll = () => { if (feedUnseen && atEnd()) { feedUnseen = 0; newBtn.hidden = true; } };
  applyFilter();
  const toSel = $("to");
  toSel.onchange = () => { draftTo = toSel.value; };
  const sendDraft = async () => {
    const input = $("draft");
    const body = input.value.trim();
    if (!body) return;
    try {
      await api("POST", `/api/runs/${runId}/messages`, { from: "human", to: toSel.value, kind: "command", body });
      input.value = ""; feed.scrollTop = feed.scrollHeight;
      toast(toSel.value === "all" ? "Sent to everyone. Replies appear here and in each person's chat." : `Sent to ${nameOf(toSel.value)}. Their reply appears here and in their chat.`);
      loadRun();
    }
    catch (e) { toast(e.message); }
  };
  $("send").onclick = sendDraft;
  $("draft").onkeydown = (e) => { if (e.key === "Enter") sendDraft(); };
  // One click handler for every region, since regions are re-rendered in place.
  app.onclick = (e) => {
    const el = e.target.closest("[data-view],[data-filter],[data-person],[data-task],[data-open]");
    if (!el || !app.contains(el)) return;
    if (el.dataset.view) { view = el.dataset.view; store.set(`redpi-view-${runId}`, view); renderView(); updateTabs(); }
    else if (el.dataset.filter) { feedFilter = el.dataset.filter; store.set("redpi-feed-filter", feedFilter); applyFilter(); feed.scrollTop = feed.scrollHeight; }
    else if (el.dataset.person) select(el.dataset.person);
    else if (el.dataset.task) { openPanel = { task: el.dataset.task }; renderPanel(); }
    else if (el.dataset.open !== undefined) { if (el.dataset.action === "resume") resume(el.dataset.open); else if (el.dataset.open) select(el.dataset.open); }
  };
}

function applyFilter() {
  const feed = $("feed");
  for (const f of ["updates", "chat", "tools"]) feed.classList.toggle(`f-${f}`, feedFilter === f);
  app.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === feedFilter)));
}

function updateTabs() {
  app.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $("view-hint").textContent = view === "office" ? "click a person · drag to pan · scroll to zoom · double-click to reset" : view === "board" ? "click a card for its history" : "drag to pin · click to open";
}

function renderRun() {
  const { run, project, plan, workers, tasks } = state;
  if (built !== runId || !$("run-head")) buildRun();
  document.title = `${run.title} · RedPi HQ`;
  $("crumbs").innerHTML = `<a href="/projects/${esc(project.id)}">${esc(project.name)}</a> <span class="faint mono">${esc(project.path)}</span>`;
  if (!view) view = workers.length ? "office" : "board";
  const done = tasks.filter((t) => t.status === "done").length;
  $("run-head").innerHTML = `<h1>${esc(run.title)}</h1>${pill(run.status)}
      ${plan ? `<a class="btn" href="/plans/${esc(plan.id)}">Plan v${plan.version} ${plan.status === "pending" ? "· needs your approval" : ""}</a>` : `<span class="muted">The CEO is still planning…</span>`}
      <span class="muted" style="margin-left:auto">updated ${ago(run.updated)}</span>`;
  const needs = needsYou();
  $("needs-slot").innerHTML = needs.length ? `<div class="needs" role="region" aria-label="Needs you"><span class="needs-title">Needs you</span>${needs.map((n) => `<button class="needs-item ${n.level}" data-open="${esc(n.id || "")}" ${n.action ? `data-action="${n.action}"` : ""} title="${esc(n.text)}">${esc(n.text)}</button>`).join("")}</div>` : "";
  $("stats").innerHTML = `
      <div class="panel stat"><div class="v">${done}/${tasks.length || "–"}</div><div class="k">Tasks done</div></div>
      <div class="panel stat"><div class="v">${tasks.filter((t) => t.status === "in_progress").length}</div><div class="k">In progress</div></div>
      <div class="panel stat"><div class="v" style="${tasks.some((t) => t.status === "blocked") ? "color:var(--red)" : ""}">${tasks.filter((t) => t.status === "blocked").length}</div><div class="k">Blocked</div></div>
      <div class="panel stat"><div class="v">${workers.filter((w) => workerState(w) === "working").length}/${workers.length}</div><div class="k">Workers active</div></div>`;
  updateTabs();
  renderView();
  renderFeed();
  renderTeam();
  syncRecipients();
  renderCharts($("charts"), state);
}

function renderView() {
  const body = $("view-body");
  if (view === "office") {
    if (!officeHost) {
      officeHost = document.createElement("div");
      officeHost.className = "office-host";
      office = new Office(officeHost, { onSelect: select });
    }
    if (officeHost.parentNode !== body) body.replaceChildren(officeHost);
    office.setActive(true);
    office.update(state);
    return;
  }
  office?.setActive(false);
  if (view === "graph") { body.innerHTML = `<div id="graph-host" class="graph-host"></div>`; renderGraph($("graph-host"), state, select); return; }
  const { tasks, workers, plan } = state;
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  const titles = plan ? Object.fromEntries(plan.plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, { story: s, task: t }]))) : {};
  const left = body.querySelector(".kanban")?.scrollLeft || 0;
  body.innerHTML = tasks.length ? `<div class="kanban">${COLUMNS.map(([k, label]) => {
    const cards = tasks.filter((t) => t.status === k);
    return `<div class="col ${k}"><h3>${label}<span>${cards.length}</span></h3><div class="cards">${cards.map((t) => {
      const w = byId[t.worker_id];
      return `<button class="card" data-task="${esc(t.id)}" title="${esc(titles[t.id]?.task.description || "")}"><div class="id">${esc(t.id)} · ${esc(titles[t.id]?.story.title || t.story_id)}</div><div class="tt">${esc(t.title)}</div>
        <div class="who">${w ? `${avatar(w.name, w.id, "sm")} ${esc(w.name)}` : `<span class="faint">unassigned</span>`}</div>${t.note && k !== "done" ? `<div class="note">${esc(t.note)}</div>` : ""}</button>`;
    }).join("")}</div></div>`;
  }).join("")}</div>` : `<div class="empty">The board fills in when you approve the plan.</div>`;
  const k = body.querySelector(".kanban");
  if (k) k.scrollLeft = left;
}

// ---------- event board: chat and actions in one live feed ----------
function feedItems() {
  const { messages, events = [], transitions = [] } = state;
  const items = [];
  // Task moves come from the transition log (who, from → to, why), so their chat echoes are skipped.
  for (const m of messages) if (!(m.kind === "task" && transitions.length)) items.push({ key: `m${m.id}`, t: m.created, kind: "chat", html: () => msgView(m) });
  for (const tr of transitions) items.push({ key: `t${tr.id}`, t: tr.created, kind: "updates", html: () => moveView(tr) });
  for (const e of events) {
    if (e.kind === "say") items.push({ key: `e${e.id}`, t: e.created, kind: "updates", html: () => sayView(e) });
    else if (e.kind === "tool" || e.kind === "error") items.push({ key: `e${e.id}`, t: e.created, kind: "tools", html: () => eventView(e) });
  }
  return items.sort((a, b) => a.t - b.t);
}

function moveView(tr) {
  const title = state.tasks.find((t) => t.id === tr.task_id)?.title || "";
  const who = tr.actor && tr.actor !== "human" ? `<button class="linkish" data-person="${esc(tr.actor)}">${esc(nameOf(tr.actor))}</button>` : `<b>${esc(nameOf(tr.actor || "human"))}</b>`;
  return `<div class="act move"><span class="act-dot" style="background:${STATUS_COLOR[tr.to_status] || "var(--faint)"}"></span>
    <span class="act-text">${who} moved <button class="linkish" data-task="${esc(tr.task_id)}">${esc(tr.task_id)}</button> ${esc(title)}: ${tr.from_status ? `${esc(STATUS_LABEL[tr.from_status] || tr.from_status)} → ` : ""}<b style="color:${STATUS_COLOR[tr.to_status] || "inherit"}">${esc(STATUS_LABEL[tr.to_status] || tr.to_status)}</b>${tr.target ? ` for ${esc(nameOf(tr.target))}` : ""}${tr.reason ? `<span class="muted"> · ${esc(tr.reason)}</span>` : ""}</span>
    <span class="when" data-t="${tr.created}">${ago(tr.created)}</span></div>`;
}

// An agent's own words about what it is doing: the human-readable progress line.
function sayView(e) {
  const text = String(e.text).replace(/\s+\n/g, "\n").trim();
  return `<div class="upd"><div class="upd-hdr">${avatar(nameOf(e.worker_id), e.worker_id, "sm")}<button class="linkish" data-person="${esc(e.worker_id)}">${esc(nameOf(e.worker_id))}</button><span class="when" data-t="${e.created}">${ago(e.created)}</span></div>
    <div class="upd-body">${esc(text.length > 700 ? text.slice(0, 700) + "…" : text)}</div></div>`;
}

// The latest thing someone said about their work (for team cards and panels).
function latestUpdate(id, maxAgeMs = 15 * 60_000) {
  const e = (state.events || []).filter((x) => x.kind === "say" && x.worker_id === id).at(-1);
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

function renderTeam() {
  const { run, workers } = state;
  // Each card says what the person last told us they are doing, in their words; else the live tool.
  const doing = (id, fallback) => { const u = latestUpdate(id); return u ? `<div class="doing said" title="${esc(u.text)}">“${esc(u.text.split("\n")[0])}”</div>` : `<div class="doing">${esc(fallback)}</div>`; };
  $("team").innerHTML = `<button class="member" data-person="ceo">${avatar("CEO", "ceo")}<span><span class="name">CEO</span> <span class="role">lead Pi session</span>${doing("ceo", run.status === "awaiting_approval" ? "waiting for your approval" : run.status === "planning" ? "planning" : run.status === "done" ? "run finished" : "coordinating the team")}</span><span class="dot working"></span></button>
    ${workers.map((w) => `<button class="member" data-person="${esc(w.id)}">${avatar(w.name, w.id)}<span><span class="name">${esc(w.name)}</span> <span class="role">${esc(w.role)}</span>${w.harness && w.harness !== "pi" ? ` <span class="pill violet harness-pill">${esc(w.harnessName)}</span>` : ""}
      ${doing(w.id, `${w.current_task ? `${w.current_task} · ` : ""}${w.activity?.text || w.last_message || w.status}`)}</span><span class="dot ${workerState(w) === "needs" ? "offline" : workerState(w)}" title="${workerState(w)}"></span></button>`).join("")}`;
}

// The composer's recipients follow the team without resetting your choice.
function syncRecipients() {
  const sel = $("to");
  const opts = [["ceo", "CEO"], ["all", "Everyone"], ...state.workers.map((w) => [w.id, w.name])];
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

async function resume(workerId) {
  try { await api("POST", `/api/workers/${workerId}/resume-request`); toast("Asked the CEO to resume them"); loadRun(); } catch (e) { toast(e.message); }
}

function msgView(m) {
  // HQ's own notes to the CEO (review ready, all done) are stored as from the human; say who really sent them.
  if (m.kind === "system" && m.sender === "human") m = { ...m, sender: "hq", senderName: "HQ" };
  const from = m.sender === "human" || m.sender === "hq" ? `<span class="from">${esc(m.senderName)}</span>` : `<button class="from linkish" data-person="${esc(m.sender)}">${esc(m.senderName)}</button>`;
  const to = m.recipient === "human" || m.recipient === "all" ? esc(m.recipientName) : `<button class="linkish to-link" data-person="${esc(m.recipient)}">${esc(m.recipientName)}</button>`;
  return `<div class="msg ${esc(m.kind)}${m.sender === "human" || m.recipient === "human" ? " with-you" : ""}"><div class="hdr">${avatar(m.senderName, m.sender, "sm")}${from}${m.kind !== "task" ? `<span class="to">→ ${to}</span>` : ""}${m.kind === "interrupt" ? `<span class="pill cyan">interrupt</span>` : m.kind === "brief" ? `<span class="pill">brief</span>` : m.kind === "decision" ? `<span class="pill amber">decision</span>` : m.kind === "aside" ? `<span class="pill violet">btw</span>` : m.kind === "reply" ? `<span class="pill green">reply</span>` : ""}<span class="when" data-t="${m.created}">${ago(m.created)}</span></div>
    <div class="body">${esc(m.kind === "brief" && m.body.length > 600 ? m.body.slice(0, 600) + "…" : m.body)}</div></div>`;
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
  const tag = m.kind === "aside" ? "btw" : m.kind === "interrupt" ? "interrupt" : m.kind === "decision" ? "plan decision" : m.kind === "reply" ? "reply" : m.recipient === "all" ? "to everyone" : "";
  const body = m.body.length > 6000 ? m.body.slice(0, 6000) + "…" : m.body;
  return `<div class="bub ${mine ? "me" : "them"}${m.kind === "interrupt" ? " int" : ""}"><div class="bub-meta">${esc(mine ? "You" : m.senderName)}${tag ? ` · ${esc(tag)}` : ""} · <span class="when" data-t="${m.created}">${ago(m.created)}</span></div><div class="bub-body">${esc(body)}</div></div>`;
}

function pendingNote(id, name, msgs) {
  const lastMine = [...msgs].reverse().find((m) => m.sender === "human");
  if (!lastMine || msgs.some((m) => m.id > lastMine.id && m.sender === id)) return "";
  const w = id === "ceo" ? null : state.workers.find((x) => x.id === id);
  const text = w && !w.alive ? `${name} is offline. Your message waits in their inbox until they are back.`
    : lastMine.kind === "aside" ? `${name} is answering on the side…`
      : `${name} has your message. Their reply appears here when they finish the current turn.`;
  return `<div class="bub them pending"><div class="bub-body">${esc(text)}<span class="dots">…</span></div></div>`;
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
          ${w ? `<button class="btn" id="wask" title="${esc(name)} answers from a copy of their session without stopping their work">Ask on the side</button>` : ""}
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
      if (e.target.closest("#resume")) resume(id);
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
      const send = async (kind) => {
        const body = input.value.trim() || (kind === "interrupt" ? "Stop what you are doing and wait for instructions." : "");
        if (!body) return;
        try {
          await api("POST", `/api/runs/${runId}/messages`, { from: "human", to: id, kind, body });
          input.value = "";
          const t = $("thread"); if (t) t.dataset.stick = "1";
          loadRun();
        } catch (err) { toast(err.message); }
      };
      root.querySelector("#wsend").onclick = () => send("command");
      root.querySelector("#wint").onclick = () => send("interrupt");
      root.querySelector("#wask")?.addEventListener("click", () => send("aside"));
      input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send("command"); } };
      input.focus();
    }
  }
  // Live parts: status, banners, then the tab's content.
  const st = w ? workerState(w) : state.run.status;
  $("p-status").innerHTML = w ? `<span class="pill ${st === "working" ? "green" : st === "needs" || st === "offline" ? "red" : ""}">${esc(st)}</span>` : pill(state.run.status);
  // What this person is blocked on, in full, so you can answer it right here.
  const blocked = w ? state.tasks.filter((t) => t.worker_id === id && t.status === "blocked") : [];
  const blockers = blocked.map((t) => `<div class="block-card"><div class="block-head"><span class="pill red">blocked</span><button class="linkish" data-task="${esc(t.id)}">${esc(t.id)}</button> <b>${esc(t.title)}</b><span style="flex:1"></span>${tab === "chat" ? `<button class="btn" data-reply-task="${esc(t.id)}">Reply about ${esc(t.id)}</button>` : ""}</div><div class="block-note">${esc(t.note || "No reason given.")}</div></div>`).join("");
  const banner = w && !w.alive ? `<div class="banner red">${esc(name)}'s session is gone. <button class="btn" id="resume">Ask the CEO to resume</button></div>`
    : w?.needs_input ? `<div class="banner red">${esc(w.needs_input.reason)}</div>` : w?.needs_human ? `<div class="banner red">${esc(w.needs_human)}</div>`
      : w?.parked ? `<div class="banner amber">Idle while owning in-progress work; HQ is nudging them.</div>` : "";
  if (tab === "chat") {
    const top = banner + blockers;
    const slot = $("p-banner");
    if (slot.dataset.html !== top) { slot.innerHTML = top; slot.dataset.html = top; }   // keep your scroll in a long note
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
  body.innerHTML = tab === "activity" && !w ? updatesList("ceo") : w ? await workerDetails(w, tab, tab === "details" ? banner + blockers : banner) : ceoDetails();
  body.scrollTop = pos.top;
}

// What someone has said about their work, newest first.
function updatesList(id) {
  const ups = (state.events || []).filter((e) => e.kind === "say" && e.worker_id === id).slice(-30).reverse();
  return `<div><div class="section-title" style="margin-bottom:6px">Updates in their words</div>${ups.length ? `<div class="upd-list">${ups.map((e) => `<div class="upd-item"><span class="when">${ago(e.created)}</span><div class="upd-body">${esc(e.text.length > 1500 ? e.text.slice(0, 1500) + "…" : e.text)}</div></div>`).join("")}</div>` : `<span class="muted">No updates yet. They appear as ${esc(nameOf(id))} explains what they are doing.</span>`}</div>`;
}

function ceoDetails() {
  const { run, plan, workers, tasks, messages } = state;
  const told = messages.filter((m) => m.sender === "ceo" && m.recipient !== "human").slice(-10);
  const done = tasks.filter((t) => t.status === "done").length;
  const doing = run.status === "awaiting_approval" ? "Waiting for you to approve the plan." : run.status === "planning" ? "Planning: researching the project and drafting the plan." : run.status === "done" ? "The run is finished." : `Leading ${workers.length} worker${workers.length === 1 ? "" : "s"}: assigning tasks, answering questions, reviewing work.`;
  const u = latestUpdate("ceo");
  return `<div>${esc(doing)}</div>${u ? `<div class="upd-body">“${esc(u.text)}”</div>` : ""}
    <div class="mini-stats"><span><b>${done}/${tasks.length || "–"}</b> tasks done</span><span><b>${tasks.filter((t) => t.status === "in_progress").length}</b> in progress</span><span><b>${tasks.filter((t) => t.status === "blocked").length}</b> blocked</span><span><b>${workers.filter((w) => workerState(w) === "working").length}/${workers.length}</b> working</span></div>
    ${plan ? `<div><a class="btn" href="/plans/${esc(plan.id)}">Open plan v${plan.version}${plan.status === "pending" ? " · needs your approval" : ""}</a></div>` : ""}
    <div><div class="section-title" style="margin-bottom:6px">Latest to the team</div>${told.length ? `<div class="mini-msgs">${told.map(msgView).join("")}</div>` : `<span class="muted">Nothing yet.</span>`}</div>`;
}

async function workerDetails(w, tab, banner) {
  let d;
  try { d = await api("GET", `/api/workers/${w.id}`); } catch (e) { return `<div class="error-box">${esc(e.message)}</div>`; }
  if (tab === "activity") return `${updatesList(w.id)}<div><div class="section-title" style="margin-bottom:6px">Tool calls</div>${waterfall(d.events)}</div>
      <div><div class="section-title" style="margin-bottom:6px">Activity</div><div class="events">${d.events.length ? d.events.slice().reverse().map((e) => `<div class="ev"><span>${ago(e.created)}</span><span>${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("") : `<span class="muted">No activity yet.</span>`}</div></div>`;
  const ww = d.worker, ctx = ww.context, attach = ww.attach || "";
  const team = (state.messages || []).filter((m) => m.kind !== "task" && m.kind !== "system" && m.sender !== "human" && m.recipient !== "human" && (m.sender === w.id || m.recipient === w.id)).slice(-15);
  return `${banner}
    <div><div class="section-title" style="margin-bottom:6px">Now</div>${latestUpdate(w.id) ? `<div class="upd-body">“${esc(latestUpdate(w.id).text)}”</div>` : ""}<div class="muted" style="font-size:13px;margin-top:4px">${ww.current_task ? `<span class="mono">${esc(ww.current_task)}</span> · ` : ""}${esc(ww.activity?.text || ww.status)}</div></div>
    <div><div class="section-title" style="margin-bottom:6px">Tasks</div>${d.tasks.length ? d.tasks.map((t) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><button class="linkish mono" data-task="${esc(t.id)}">${esc(t.id)}</button><span style="flex:1">${esc(t.title)}</span><span class="pill ${t.status === "done" ? "green" : t.status === "blocked" ? "red" : t.status === "in_progress" ? "cyan" : ""}">${esc(t.status.replace("_", " "))}</span></div>`).join("") : `<span class="muted">No tasks assigned.</span>`}</div>
    ${ctx && ctx.percent != null ? `<div><div class="section-title" style="margin-bottom:6px">Context</div><div class="bar"><i style="width:${Math.min(100, ctx.percent)}%;background:${ctx.percent > 80 ? "var(--red)" : ctx.percent > 50 ? "var(--amber)" : "var(--green)"}"></i></div><div class="faint" style="font-size:12px;margin-top:4px">${Math.round(ctx.percent)}% of ${Math.round((ctx.window || 0) / 1000)}k tokens</div></div>` : ""}
    <div><div class="section-title" style="margin-bottom:6px">Latest message</div><div class="last">${esc(ww.last_message || "Nothing yet.")}</div></div>
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

async function renderTask(root, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) { closePanel(); return; }
  const meta = state.plan?.plan.stories.flatMap((s) => s.tasks.map((k) => ({ story: s, task: k }))).find((x) => x.task.id === taskId);
  let history = [];
  try { history = await api("GET", `/api/runs/${runId}/tasks/${encodeURIComponent(taskId)}/history`); } catch {}
  const drawerPos = renderedPanel === `t:${taskId}` ? saveScroll(".drawer .scroll") : null;
  renderedPanel = `t:${taskId}`;
  root.innerHTML = `<aside class="drawer" role="dialog" aria-label="Task ${esc(taskId)}">
    <div class="panel-head"><div style="flex:1;min-width:0"><div class="mono muted">${esc(taskId)} · ${esc(meta?.story.title || t.story_id)}</div><div style="font-weight:700;font-size:16px">${esc(t.title)}</div></div>${pill(t.status === "done" ? "done" : t.status)}<button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="scroll">
      ${meta ? `<div>${esc(meta.task.description)}</div>${meta.task.tech ? `<div><span class="pill cyan">${esc(meta.task.tech)}</span></div>` : ""}` : ""}
      ${t.note ? `<div><div class="section-title" style="margin-bottom:6px">Latest note</div><div class="last">${esc(t.note)}</div></div>` : ""}
      <div><div class="section-title" style="margin-bottom:6px">History</div>${history.length ? `<ol class="history">${history.map((h) => `<li><span class="mono">${esc(h.from_status || "–")} → ${esc(h.to_status)}</span> by <b>${esc(h.actorName)}</b>${h.targetName ? ` → ${esc(h.targetName)}` : ""} <span class="faint">${ago(h.created)}</span>${h.reason ? `<div class="muted">${esc(h.reason)}</div>` : ""}</li>`).join("")}</ol>` : `<span class="muted">No changes yet.</span>`}</div>
    </div></aside>`;
  restoreScroll(".drawer .scroll", drawerPos);
  document.getElementById("close").onclick = closePanel;
}

function closePanel() { openPanel = null; renderedPanel = null; document.getElementById("drawer-root").innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPanel) closePanel(); });

const refresh = () => (runId ? loadRun() : projectId ? loadProject() : loadHome()).catch((e) => { app.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; });
refresh();
live(runId, refresh);
signedInAs();
