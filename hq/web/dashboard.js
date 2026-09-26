import { ago, api, esc, live, pill, toast } from "/static/hq.js";

const app = document.getElementById("app");
const runId = location.pathname.startsWith("/runs/") ? location.pathname.split("/")[2] : null;
const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "Review"], ["blocked", "Blocked"], ["done", "Done"]];
const PALETTE = ["#3dff8f", "#45e3ff", "#ffc94d", "#b995ff", "#ff8f6b", "#7af0c8", "#f0a6ff", "#9fd3ff"];
let state, openWorker = null, draftTo = null;

const colorFor = (id) => PALETTE[[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];
const avatar = (name, id, lg) => `<span class="avatar ${lg ? "lg" : ""}" style="background:${colorFor(id)}">${esc(String(name || "?")[0].toUpperCase())}</span>`;
const workerState = (w) => !w.alive ? "offline" : w.status === "working" ? "working" : w.status === "starting" ? "starting" : "idle";

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
  state = await api("GET", `/api/runs/${runId}`);
  renderRun();
  if (openWorker) renderDrawer();
}

function renderRun() {
  const { run, project, plan, workers, tasks, messages } = state;
  document.title = `${run.title} · RedPi HQ`;
  document.getElementById("crumbs").innerHTML = `${esc(project.name)} <span class="faint mono">${esc(project.path)}</span>`;
  const done = tasks.filter((t) => t.status === "done").length;
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  const titles = plan ? Object.fromEntries(plan.plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, { story: s, task: t }]))) : {};
  const chatScroll = document.querySelector(".chat");
  const stick = !chatScroll || chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 30;
  const draft = document.getElementById("draft")?.value || "";
  app.innerHTML = `
    <div class="run-head">
      <h1>${esc(run.title)}</h1>${pill(run.status)}
      ${plan ? `<a class="btn" href="/plans/${esc(plan.id)}">Plan v${plan.version} ${plan.status === "pending" ? "· needs your approval" : ""}</a>` : `<span class="muted">The CEO is still planning…</span>`}
      <span class="muted" style="margin-left:auto">updated ${ago(run.updated)}</span>
    </div>
    <div class="stats" style="margin-bottom:16px">
      <div class="panel stat"><div class="v">${done}/${tasks.length || "–"}</div><div class="k">Tasks done</div></div>
      <div class="panel stat"><div class="v">${tasks.filter((t) => t.status === "in_progress").length}</div><div class="k">In progress</div></div>
      <div class="panel stat"><div class="v" style="${tasks.some((t) => t.status === "blocked") ? "color:var(--red)" : ""}">${tasks.filter((t) => t.status === "blocked").length}</div><div class="k">Blocked</div></div>
      <div class="panel stat"><div class="v">${workers.filter((w) => workerState(w) === "working").length}/${workers.length}</div><div class="k">Workers active</div></div>
    </div>
    <div class="layout">
      <div class="panel"><div class="panel-head"><h2>Board</h2><span class="muted" style="font-size:12px">workers move their own cards</span></div>
        <div class="panel-body">${tasks.length ? `<div class="kanban">${COLUMNS.map(([k, label]) => {
          const cards = tasks.filter((t) => t.status === k);
          return `<div class="col ${k}"><h3>${label}<span>${cards.length}</span></h3><div class="cards">${cards.map((t) => {
            const w = byId[t.worker_id];
            return `<div class="card" title="${esc(titles[t.id]?.task.description || "")}"><div class="id">${esc(t.id)} · ${esc(titles[t.id]?.story.title || t.story_id)}</div><div class="tt">${esc(t.title)}</div>
              <div class="who">${w ? `${avatar(w.name, w.id)} ${esc(w.name)}` : `<span class="faint">unassigned</span>`}</div>${t.note && k !== "done" ? `<div class="note">${esc(t.note)}</div>` : ""}</div>`;
          }).join("")}</div></div>`;
        }).join("")}</div>` : `<div class="empty">The board fills in when you approve the plan.</div>`}</div></div>
      <div style="display:grid;gap:16px">
        <div class="panel"><div class="panel-head"><h2>Team</h2><span class="muted" style="font-size:12px">click to open</span></div>
          <div class="panel-body team">
            <button class="member" data-to="ceo">${avatar("C", "ceo")}<span><span class="name">CEO</span> <span class="role">lead Pi session</span><div class="doing">${esc(run.status === "awaiting_approval" ? "waiting for your approval" : run.status === "planning" ? "planning" : "coordinating the team")}</div></span><span></span></button>
            ${workers.map((w) => `<button class="member" data-worker="${esc(w.id)}">${avatar(w.name, w.id)}<span><span class="name">${esc(w.name)}</span> <span class="role">${esc(w.role)}</span>
              <div class="doing">${w.current_task ? `${esc(w.current_task)} · ` : ""}${esc(w.activity?.text || w.last_message || w.status)}</div></span><span class="dot ${workerState(w)}" title="${workerState(w)}"></span></button>`).join("")}
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
  app.querySelectorAll("[data-worker]").forEach((b) => b.onclick = () => { openWorker = b.dataset.worker; renderDrawer(); });
  app.querySelector("[data-to=ceo]").onclick = () => { draftTo = "ceo"; toSel.value = "ceo"; document.getElementById("draft").focus(); };
}

function msgView(m) {
  const id = m.sender;
  return `<div class="msg ${esc(m.kind)}"><div class="hdr">${avatar(m.senderName, id)}<span class="from">${esc(m.senderName)}</span>${m.kind !== "task" ? `<span class="to">→ ${esc(m.recipientName)}</span>` : ""}${m.kind === "interrupt" ? `<span class="pill cyan">interrupt</span>` : m.kind === "brief" ? `<span class="pill">brief</span>` : m.kind === "decision" ? `<span class="pill amber">decision</span>` : ""}<span class="when">${ago(m.created)}</span></div>
    <div class="body">${esc(m.kind === "brief" && m.body.length > 600 ? m.body.slice(0, 600) + "…" : m.body)}</div></div>`;
}

async function renderDrawer() {
  const root = document.getElementById("drawer-root");
  if (!openWorker) { root.innerHTML = ""; return; }
  let d;
  try { d = await api("GET", `/api/workers/${openWorker}`); } catch (e) { toast(e.message); openWorker = null; root.innerHTML = ""; return; }
  const w = d.worker;
  const keep = document.getElementById("wmsg");
  const kept = keep ? { value: keep.value, focused: document.activeElement === keep } : null;
  const attach = w.attach || "";
  root.innerHTML = `<aside class="drawer" role="dialog" aria-label="${esc(w.name)}">
    <div class="panel-head">${avatar(w.name, w.id, true)}<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:16px">${esc(w.name)}</div><div class="muted">${esc(w.role)}</div></div><span class="dot ${workerState(w)}"></span><span class="muted">${workerState(w)}</span><button class="btn" id="close" aria-label="Close">✕</button></div>
    <div class="scroll">
      ${attach ? `<div><div class="section-title" style="margin-bottom:6px">Live session</div><div class="cmd"><code>${esc(attach)}</code><button class="btn" id="copy">Copy</button></div><div class="faint" style="font-size:12px;margin-top:4px">Run this in a terminal on this machine to watch or type into ${esc(w.name)}'s Pi. Detach with Ctrl-b d.</div></div>` : ""}
      <div class="muted" style="font-size:13px">Working in <code>${esc(w.cwd)}</code>${w.branch ? ` on branch <code>${esc(w.branch)}</code>` : ""}</div>
      <div><div class="section-title" style="margin-bottom:6px">Tasks</div>${d.tasks.length ? d.tasks.map((t) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><span class="mono muted">${esc(t.id)}</span><span style="flex:1">${esc(t.title)}</span><span class="pill ${t.status === "done" ? "green" : t.status === "blocked" ? "red" : t.status === "in_progress" ? "cyan" : ""}">${esc(t.status.replace("_", " "))}</span></div>`).join("") : `<span class="muted">No tasks assigned.</span>`}</div>
      <div><div class="section-title" style="margin-bottom:6px">Latest message</div><div class="last">${esc(w.last_message || "Nothing yet.")}</div></div>
      <div><div class="section-title" style="margin-bottom:6px">Activity</div><div class="events">${d.events.length ? d.events.slice().reverse().map((e) => `<div class="ev"><span>${ago(e.created)}</span><span>${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("") : `<span class="muted">No activity yet.</span>`}</div></div>
      <div><div class="section-title" style="margin-bottom:6px">Talk to ${esc(w.name)}</div>
        <textarea id="wmsg" rows="3" placeholder="Instruction or question for ${esc(w.name)}"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn primary" id="wsend">Send</button><button class="btn danger" id="wint" title="Stops what ${esc(w.name)} is doing now, then delivers your message">Interrupt + send</button></div></div>
    </div></aside>`;
  if (kept) { const t = document.getElementById("wmsg"); t.value = kept.value; if (kept.focused) t.focus(); }
  document.getElementById("close").onclick = () => { openWorker = null; root.innerHTML = ""; };
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

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openWorker) { openWorker = null; document.getElementById("drawer-root").innerHTML = ""; } });

const refresh = () => (runId ? loadRun() : loadHome()).catch((e) => { app.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; });
refresh();
live(runId, refresh);
