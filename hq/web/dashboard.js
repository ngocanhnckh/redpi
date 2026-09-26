import { ago, api, esc, live, pill, toast } from "/static/hq.js";
import { portraitUrl } from "/static/office/people.js";
import { Office } from "/static/office/office.js";
import { renderGraph } from "/static/graph.js";

const app = document.getElementById("app");
const runId = location.pathname.startsWith("/runs/") ? location.pathname.split("/")[2] : null;
const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done"]];
let state, prev, openPanel = null, draftTo = null, office = null, officeHost = null;

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let view = store.get(`redpi-view-${runId}`);

const workerState = (w) => !w.alive ? "offline" : w.needs_human || w.needs_input || w.parked ? "needs" : w.status === "working" ? "working" : w.status === "starting" ? "starting" : "idle";
const roleOf = (id) => id === "ceo" ? "ceo" : state?.workers.find((w) => w.id === id)?.role || "";
function avatar(name, id, size = "") {
  if (id === "human") return `<span class="avatar you ${size}" aria-hidden="true">You</span>`;
  return `<img class="avatar ${size}" alt="" src="${portraitUrl(name, roleOf(id))}">`;
}

// Screen readers hear what changed (the office canvas itself is decorative).
function announce(text) {
  const el = document.getElementById("live");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
}

async function loadHome() {
  const runs = await api("GET", "/api/runs");
  document.title = "RedPi HQ";
  document.getElementById("crumbs").textContent = "All projects on this machine";
  if (!runs.length) { app.innerHTML = `<div class="empty">No RedPlan runs yet. In any project, start Pi and run <code>/redplan &lt;what to build&gt;</code>.</div>`; return; }
  const byProject = new Map();
  for (const r of runs) (byProject.get(r.project_path) || byProject.set(r.project_path, []).get(r.project_path)).push(r);
  app.innerHTML = [...byProject.entries()].map(([path, list]) => `
    <section class="project"><h2 class="section-title">${esc(list[0].project_name)} <span class="mono faint" style="text-transform:none;letter-spacing:0">${esc(path)}</span></h2>
      <div class="runs">${list.map((r) => `
        <a class="panel run-card" href="/runs/${esc(r.id)}">
          <div style="display:flex;justify-content:space-between;gap:8px">${pill(r.status)}<span class="faint" style="font-size:12px">${ago(r.updated)}</span></div>
          <div class="t">${esc(r.title)}</div>
          <div class="bar"><i style="width:${r.tasks ? Math.round((r.done / r.tasks) * 100) : 0}%"></i></div>
          <div class="muted" style="font-size:12px;margin-top:6px">${r.tasks ? `${r.done}/${r.tasks} tasks done` : "planning"} · ${r.workers} worker${r.workers === 1 ? "" : "s"}</div>
        </a>`).join("")}</div>
    </section>`).join("");
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
  for (const t of tasks.filter((t) => t.status === "blocked")) items.push({ id: t.worker_id, level: "red", text: `${t.id} blocked${t.worker_id ? ` (${name(t.worker_id)})` : ""}: ${t.note || "no reason given"}` });
  for (const w of workers) {
    if (!w.alive && w.status !== "stopped") items.push({ id: w.id, level: "red", text: `${w.name} is offline`, action: "resume" });
    else if (w.needs_input) items.push({ id: w.id, level: "red", text: `${w.name}: ${w.needs_input.reason}` });
    else if (w.needs_human) items.push({ id: w.id, level: "red", text: `${w.name}: ${w.needs_human}` });
    else if (w.parked) items.push({ id: w.id, level: "amber", text: `${w.name} is idle while owning in-progress work` });
  }
  // Questions addressed to you that you have not answered yet.
  for (const m of messages.filter((m) => m.recipient === "human" && m.kind !== "system")) {
    if (!messages.some((r) => r.id > m.id && r.sender === "human" && r.recipient === m.sender)) items.push({ id: m.sender, level: "amber", text: `${m.senderName} asked you: ${m.body.slice(0, 140)}` });
  }
  return items.slice(0, 8);
}

function renderRun() {
  const { run, project, plan, workers, tasks, messages } = state;
  document.title = `${run.title} · RedPi HQ`;
  document.getElementById("crumbs").innerHTML = `${esc(project.name)} <span class="faint mono">${esc(project.path)}</span>`;
  if (!view) view = workers.length ? "office" : "board";
  const done = tasks.filter((t) => t.status === "done").length;
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  const titles = plan ? Object.fromEntries(plan.plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, { story: s, task: t }]))) : {};
  const chatScroll = document.querySelector(".chat");
  const stick = !chatScroll || chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 30;
  const draft = document.getElementById("draft")?.value || "";
  const needs = needsYou();
  if (officeHost && officeHost.parentNode) officeHost.remove();   // keep the canvas alive across re-renders
  app.innerHTML = `
    <div id="live" class="sr-only" aria-live="polite"></div>
    <div class="run-head">
      <h1>${esc(run.title)}</h1>${pill(run.status)}
      ${plan ? `<a class="btn" href="/plans/${esc(plan.id)}">Plan v${plan.version} ${plan.status === "pending" ? "· needs your approval" : ""}</a>` : `<span class="muted">The CEO is still planning…</span>`}
      <span class="muted" style="margin-left:auto">updated ${ago(run.updated)}</span>
    </div>
    ${needs.length ? `<div class="needs" role="region" aria-label="Needs you"><span class="needs-title">Needs you</span>${needs.map((n) => `<button class="needs-item ${n.level}" data-open="${esc(n.id || "")}" ${n.action ? `data-action="${n.action}"` : ""}>${esc(n.text)}</button>`).join("")}</div>` : ""}
    <div class="stats" style="margin-bottom:16px">
      <div class="panel stat"><div class="v">${done}/${tasks.length || "–"}</div><div class="k">Tasks done</div></div>
      <div class="panel stat"><div class="v">${tasks.filter((t) => t.status === "in_progress").length}</div><div class="k">In progress</div></div>
      <div class="panel stat"><div class="v" style="${tasks.some((t) => t.status === "blocked") ? "color:var(--red)" : ""}">${tasks.filter((t) => t.status === "blocked").length}</div><div class="k">Blocked</div></div>
      <div class="panel stat"><div class="v">${workers.filter((w) => workerState(w) === "working").length}/${workers.length}</div><div class="k">Workers active</div></div>
    </div>
    <div class="layout ${view === "office" ? "wide" : ""}">
      <div class="panel view-panel">
        <div class="panel-head"><div class="viewtabs" role="tablist">
          ${[["office", "Office"], ["board", "Board"], ["graph", "Graph"]].map(([k, l]) => `<button role="tab" data-view="${k}" aria-selected="${view === k}">${l}</button>`).join("")}
        </div><span class="muted" style="font-size:12px">${view === "office" ? "click a person · drag to pan · scroll to zoom · double-click to reset" : view === "board" ? "click a card for its history" : "drag to pin · click to open"}</span></div>
        <div class="panel-body" id="view-body">
          ${view === "office" ? `<div id="view-slot"></div>` : view === "graph" ? `<div id="graph-host" class="graph-host"></div>` : tasks.length ? `<div class="kanban">${COLUMNS.map(([k, label]) => {
            const cards = tasks.filter((t) => t.status === k);
            return `<div class="col ${k}"><h3>${label}<span>${cards.length}</span></h3><div class="cards">${cards.map((t) => {
              const w = byId[t.worker_id];
              return `<button class="card" data-task="${esc(t.id)}" title="${esc(titles[t.id]?.task.description || "")}"><div class="id">${esc(t.id)} · ${esc(titles[t.id]?.story.title || t.story_id)}</div><div class="tt">${esc(t.title)}</div>
                <div class="who">${w ? `${avatar(w.name, w.id, "sm")} ${esc(w.name)}` : `<span class="faint">unassigned</span>`}</div>${t.note && k !== "done" ? `<div class="note">${esc(t.note)}</div>` : ""}</button>`;
            }).join("")}</div></div>`;
          }).join("")}</div>` : `<div class="empty">The board fills in when you approve the plan.</div>`}
        </div>
      </div>
      <div class="side">
        <div class="panel"><div class="panel-head"><h2>Team</h2><span class="muted" style="font-size:12px">click to open</span></div>
          <div class="panel-body team">
            <button class="member" data-to="ceo">${avatar("CEO", "ceo")}<span><span class="name">CEO</span> <span class="role">lead Pi session</span><div class="doing">${esc(run.status === "awaiting_approval" ? "waiting for your approval" : run.status === "planning" ? "planning" : "coordinating the team")}</div></span><span></span></button>
            ${workers.map((w) => `<button class="member" data-worker="${esc(w.id)}">${avatar(w.name, w.id)}<span><span class="name">${esc(w.name)}</span> <span class="role">${esc(w.role)}</span>
              <div class="doing">${w.current_task ? `${esc(w.current_task)} · ` : ""}${esc(w.activity?.text || w.last_message || w.status)}</div></span><span class="dot ${workerState(w) === "needs" ? "offline" : workerState(w)}" title="${workerState(w)}"></span></button>`).join("")}
          </div></div>
        <div class="panel"><div class="panel-head"><h2>Team chat</h2><span class="muted" style="font-size:12px">${messages.length} messages</span></div>
          <div class="chat">${messages.length ? messages.map(msgView).join("") : `<div class="empty">No messages yet.</div>`}</div>
          <div class="composer">
            <select id="to" aria-label="Send to"><option value="ceo">CEO</option><option value="all">Everyone</option>${workers.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("")}</select>
            <input type="text" id="draft" placeholder="Message… (they receive it as a message from you)" autocomplete="off">
            <button class="btn primary" id="send">Send</button>
          </div></div>
      </div>
    </div>`;

  if (view === "office") {
    if (!officeHost) {
      officeHost = document.createElement("div");
      officeHost.className = "office-host";
      office = new Office(officeHost, { onSelect: select });
    }
    document.getElementById("view-slot").replaceWith(officeHost);
    office.setActive(true);
    office.update(state);
  } else {
    office?.setActive(false);
    if (view === "graph") renderGraph(document.getElementById("graph-host"), state, select);
  }

  const toSel = document.getElementById("to");
  if (draftTo) toSel.value = draftTo;
  toSel.onchange = () => { draftTo = toSel.value; };
  document.getElementById("draft").value = draft;
  const chat = document.querySelector(".chat");
  if (stick) chat.scrollTop = chat.scrollHeight;
  const sendDraft = async () => {
    const input = document.getElementById("draft");
    const body = input.value.trim();
    if (!body) return;
    try { await api("POST", `/api/runs/${runId}/messages`, { from: "human", to: toSel.value, kind: "command", body }); input.value = ""; loadRun(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById("send").onclick = sendDraft;
  document.getElementById("draft").onkeydown = (e) => { if (e.key === "Enter") sendDraft(); };
  app.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => { view = b.dataset.view; store.set(`redpi-view-${runId}`, view); renderRun(); });
  app.querySelectorAll("[data-worker]").forEach((b) => b.onclick = () => select(b.dataset.worker));
  app.querySelectorAll("[data-task]").forEach((b) => b.onclick = () => { openPanel = { task: b.dataset.task }; renderPanel(); });
  app.querySelectorAll("[data-open]").forEach((b) => b.onclick = async () => {
    if (b.dataset.action === "resume") return resume(b.dataset.open);
    if (b.dataset.open) select(b.dataset.open);
  });
  app.querySelector("[data-to=ceo]").onclick = () => select("ceo");
}

function select(id) {
  if (!id || id === "human") return;
  if (id === "ceo") { draftTo = "ceo"; const s = document.getElementById("to"); if (s) s.value = "ceo"; document.getElementById("draft")?.focus(); return; }
  openPanel = { worker: id };
  renderPanel();
}

async function resume(workerId) {
  try { await api("POST", `/api/workers/${workerId}/resume-request`); toast("Asked the CEO to resume them"); loadRun(); } catch (e) { toast(e.message); }
}

function msgView(m) {
  return `<div class="msg ${esc(m.kind)}"><div class="hdr">${avatar(m.senderName, m.sender, "sm")}<span class="from">${esc(m.senderName)}</span>${m.kind !== "task" ? `<span class="to">→ ${esc(m.recipientName)}</span>` : ""}${m.kind === "interrupt" ? `<span class="pill cyan">interrupt</span>` : m.kind === "brief" ? `<span class="pill">brief</span>` : m.kind === "decision" ? `<span class="pill amber">decision</span>` : ""}<span class="when">${ago(m.created)}</span></div>
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

async function renderPanel() {
  const root = document.getElementById("drawer-root");
  if (!openPanel) { root.innerHTML = ""; return; }
  if (openPanel.task) return renderTask(root, openPanel.task);
  let d;
  try { d = await api("GET", `/api/workers/${openPanel.worker}`); } catch (e) { toast(e.message); openPanel = null; root.innerHTML = ""; return; }
  const w = d.worker;
  const keep = document.getElementById("wmsg");
  const kept = keep ? { value: keep.value, focused: document.activeElement === keep } : null;
  const attach = w.attach || "";
  const ctx = w.context;
  root.innerHTML = `<aside class="drawer" role="dialog" aria-label="${esc(w.name)}">
    <div class="panel-head">${avatar(w.name, w.id, "lg")}<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:16px">${esc(w.name)}</div><div class="muted">${esc(w.role)}</div></div><span class="dot ${workerState(w) === "needs" ? "offline" : workerState(w)}"></span><span class="muted">${workerState(w)}</span><button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="scroll">
      ${!w.alive ? `<div class="banner red">${esc(w.name)}'s session is gone. <button class="btn" id="resume">Ask the CEO to resume</button></div>` : ""}
      ${w.needs_input ? `<div class="banner red">${esc(w.needs_input.reason)}</div>` : w.needs_human ? `<div class="banner red">${esc(w.needs_human)}</div>` : w.parked ? `<div class="banner amber">Idle while owning in-progress work; HQ is nudging them.</div>` : ""}
      ${attach ? `<div><div class="section-title" style="margin-bottom:6px">Live session</div><div class="cmd"><code>${esc(attach)}</code><button class="btn" id="copy">Copy</button></div><div class="faint" style="font-size:12px;margin-top:4px">Run this in a terminal on this machine to watch or type into ${esc(w.name)}'s Pi. Detach with Ctrl-b d.</div></div>` : ""}
      <div class="muted" style="font-size:13px">Working in <code>${esc(w.cwd)}</code>${w.branch ? ` on branch <code>${esc(w.branch)}</code>` : ""}</div>
      ${ctx && ctx.percent != null ? `<div><div class="section-title" style="margin-bottom:6px">Context</div><div class="bar"><i style="width:${Math.min(100, ctx.percent)}%;background:${ctx.percent > 80 ? "var(--red)" : ctx.percent > 50 ? "var(--amber)" : "var(--green)"}"></i></div><div class="faint" style="font-size:12px;margin-top:4px">${Math.round(ctx.percent)}% of ${Math.round((ctx.window || 0) / 1000)}k tokens</div></div>` : ""}
      <div><div class="section-title" style="margin-bottom:6px">Tasks</div>${d.tasks.length ? d.tasks.map((t) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><span class="mono muted">${esc(t.id)}</span><span style="flex:1">${esc(t.title)}</span><span class="pill ${t.status === "done" ? "green" : t.status === "blocked" ? "red" : t.status === "in_progress" ? "cyan" : ""}">${esc(t.status.replace("_", " "))}</span></div>`).join("") : `<span class="muted">No tasks assigned.</span>`}</div>
      <div><div class="section-title" style="margin-bottom:6px">Latest message</div><div class="last">${esc(w.last_message || "Nothing yet.")}</div></div>
      <div><div class="section-title" style="margin-bottom:6px">Tool calls</div>${waterfall(d.events)}</div>
      <div><div class="section-title" style="margin-bottom:6px">Activity</div><div class="events">${d.events.length ? d.events.slice().reverse().map((e) => `<div class="ev"><span>${ago(e.created)}</span><span>${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("") : `<span class="muted">No activity yet.</span>`}</div></div>
      <div><div class="section-title" style="margin-bottom:6px">Talk to ${esc(w.name)}</div>
        <textarea id="wmsg" rows="3" placeholder="Instruction or question for ${esc(w.name)}"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary" id="wsend">Send</button><button class="btn danger" id="wint" title="Stops what ${esc(w.name)} is doing now, then delivers your message">Interrupt + send</button></div></div>
    </div></aside>`;
  if (kept) { const t = document.getElementById("wmsg"); t.value = kept.value; if (kept.focused) t.focus(); }
  document.getElementById("close").onclick = closePanel;
  document.getElementById("resume")?.addEventListener("click", () => resume(w.id));
  const copy = document.getElementById("copy");
  if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(attach); toast("Copied"); } catch { toast("Select the command and copy it"); } };
  const send = async (kind) => {
    const body = document.getElementById("wmsg").value.trim() || (kind === "interrupt" ? "Stop what you are doing and wait for instructions." : "");
    if (!body) return;
    try { await api("POST", `/api/runs/${w.run_id}/messages`, { from: "human", to: w.id, kind, body }); toast(kind === "interrupt" ? `Interrupting ${w.name}` : `Sent to ${w.name}`); document.getElementById("wmsg").value = ""; loadRun(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById("wsend").onclick = () => send("command");
  document.getElementById("wint").onclick = () => send("interrupt");
}

async function renderTask(root, taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) { closePanel(); return; }
  const meta = state.plan?.plan.stories.flatMap((s) => s.tasks.map((k) => ({ story: s, task: k }))).find((x) => x.task.id === taskId);
  let history = [];
  try { history = await api("GET", `/api/runs/${runId}/tasks/${encodeURIComponent(taskId)}/history`); } catch {}
  root.innerHTML = `<aside class="drawer" role="dialog" aria-label="Task ${esc(taskId)}">
    <div class="panel-head"><div style="flex:1;min-width:0"><div class="mono muted">${esc(taskId)} · ${esc(meta?.story.title || t.story_id)}</div><div style="font-weight:700;font-size:16px">${esc(t.title)}</div></div>${pill(t.status === "done" ? "done" : t.status)}<button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="scroll">
      ${meta ? `<div>${esc(meta.task.description)}</div>${meta.task.tech ? `<div><span class="pill cyan">${esc(meta.task.tech)}</span></div>` : ""}` : ""}
      ${t.note ? `<div><div class="section-title" style="margin-bottom:6px">Latest note</div><div class="last">${esc(t.note)}</div></div>` : ""}
      <div><div class="section-title" style="margin-bottom:6px">History</div>${history.length ? `<ol class="history">${history.map((h) => `<li><span class="mono">${esc(h.from_status || "–")} → ${esc(h.to_status)}</span> by <b>${esc(h.actorName)}</b>${h.targetName ? ` → ${esc(h.targetName)}` : ""} <span class="faint">${ago(h.created)}</span>${h.reason ? `<div class="muted">${esc(h.reason)}</div>` : ""}</li>`).join("")}</ol>` : `<span class="muted">No changes yet.</span>`}</div>
    </div></aside>`;
  document.getElementById("close").onclick = closePanel;
}

function closePanel() { openPanel = null; document.getElementById("drawer-root").innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPanel) closePanel(); });

const refresh = () => (runId ? loadRun() : loadHome()).catch((e) => { app.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; });
refresh();
live(runId, refresh);
