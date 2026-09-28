import { api, esc, hours, live, pill, signedInAs, toast } from "/static/hq.js";
import { closeComposer, compose, composerOpen, highlight, onComposerClose, pinTarget, readSelection } from "/static/annotate.js";
import { mountPanZoom, panZoomFrame } from "/static/panzoom.js";

const planId = location.pathname.split("/")[2];
const app = document.getElementById("app");
const TABS = [["stories", "Stories & tasks"], ["timeline", "Timeline & critical path"], ["architecture", "Architecture"], ["tech", "Tech stack"], ["risks", "Risks & notes"]];
const TAB_NAME = { ...Object.fromEntries(TABS), overview: "Overview" };
const DIAGRAM_NAME = { gantt: "Gantt chart", arch: "Architecture diagram" };
const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
let tab = store.get("redplan-tab") || "stories";
let harnessList = null;
let data, pinMode = null, selection = null, reloadLater = false, overall = store.get(`redplan-overall-${planId}`) || "";
const openStories = new Set();

// Live updates never yank the page out from under a comment being written or a selection.
async function load() {
  if (composerOpen() || selection) { reloadLater = true; return; }
  try {
    const next = await api("GET", `/api/plans/${planId}`);
    next.runState = await api("GET", `/api/runs/${next.runId}`);
    harnessList ||= await api("GET", "/api/harnesses").catch(() => [{ id: "pi", name: "Pi (RedPi)", short: "Pi", installed: true }]);
    // Most live events are about workers or chat: only redraw when this page would change.
    const key = (d) => JSON.stringify([d.status, d.comment, d.comments, d.harness, d.latestVersion, d.previous, d.runState.plans, d.runState.run.status]);
    const same = data && key(data) === key(next);
    data = next;
    if (!same) render();
  } catch (e) {
    app.innerHTML = `<div class="error-box">Could not load plan: ${esc(e.message)}</div>`;
  }
}
onComposerClose(() => { if (reloadLater && !selection) { reloadLater = false; setTimeout(load, 0); } });

const reviewing = () => data.status === "pending" && data.version === data.latestVersion;
const numbered = () => data.comments.map((c, i) => ({ ...c, num: c.n || i + 1 }));

function render() {
  const { plan, schedule, warnings, project, run, runState } = data;
  document.title = `${plan.title} · RedPlan`;
  document.getElementById("crumbs").innerHTML = `<a href="/runs/${esc(run.id)}">${esc(project.name)} · ${esc(run.title)}</a>`;
  const tasks = plan.stories.flatMap((s) => s.tasks);
  const pending = reviewing();
  if (!document.querySelector("details.story")) { if (!openStories.size && plan.stories[0]) openStories.add(plan.stories[0].id); }
  app.innerHTML = `
    <section class="hero">
      <div data-anchor="overview" data-label="Overview">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pill(data.status)}<span class="muted mono">v${data.version}</span><span class="muted mono" title="${esc(project.path)}">${esc(project.path)}</span></div>
        <h1 data-anchor="title" data-label="Title">${esc(plan.title)}</h1>
        <p class="summary" data-anchor="summary" data-label="Summary">${esc(plan.summary)}</p>
        ${plan.goal ? `<p class="muted" data-anchor="goal" data-label="Goal"><b>Goal:</b> ${esc(plan.goal)}</p>` : ""}
        ${(plan.changes || []).length && data.previous ? `<div class="panel changes" style="margin-top:14px" data-anchor="changes" data-label="What changed"><div class="panel-head"><h2>What changed since v${data.previous.version}</h2><span class="pill cyan">${plan.changes.length}</span></div><div class="panel-body"><ul class="changes-list">${plan.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>` : ""}
        <div class="stats no-annotate" style="margin-top:16px">
          <div class="panel stat"><div class="v">${hours(schedule.duration)}</div><div class="k">Critical path (wall clock)</div></div>
          <div class="panel stat"><div class="v">${hours(schedule.totalHours)}</div><div class="k">Total effort</div></div>
          <div class="panel stat"><div class="v">${schedule.maxParallel}×</div><div class="k">Max parallel tasks</div></div>
          <div class="panel stat"><div class="v">${plan.stories.length} / ${tasks.length}</div><div class="k">Stories / tasks</div></div>
        </div>
        ${warnings.length ? `<div class="panel" style="margin-top:14px" data-anchor="warnings" data-label="Needs attention"><div class="panel-head"><h2>Needs attention</h2><span class="pill amber">${warnings.length}</span></div><div class="panel-body"><ul class="warn-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div></div>` : ""}
      </div>
      <aside class="panel decision no-annotate">${decisionPanel(pending, run, runState)}</aside>
    </section>
    <nav class="tabs" role="tablist">
      ${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${tabCount(k)}</button>`).join("")}
    </nav>
    <section id="tab-body" data-anchor="tab:${tab}" data-label="${esc(TAB_NAME[tab])}"></section>`;
  app.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
  wireDecision(pending);
  const body = document.getElementById("tab-body");
  if (tab === "stories") { body.innerHTML = harnessBar(plan, pending) + storiesView(plan, schedule, pending); wireHarness(); }
  if (tab === "timeline") { body.innerHTML = timelineView(plan, schedule, pending); drawGantt(plan, schedule); }
  if (tab === "architecture") { body.innerHTML = `<div class="panel"><div class="panel-head"><h2>Architecture</h2>${pending ? pinButton("arch") : ""}</div><div class="panel-body" id="arch"></div></div>`; drawArchitecture(plan.architecture); }
  if (tab === "tech") body.innerHTML = techView(plan.techStack || [], pending);
  if (tab === "risks") body.innerHTML = risksView(plan);
  body.querySelectorAll("details.story").forEach((d) => {
    d.open = openStories.has(d.dataset.story);
    d.addEventListener("toggle", () => { if (d.open) openStories.add(d.dataset.story); else openStories.delete(d.dataset.story); });
  });
  wirePins();
  applyAnnotations();
}

function switchTab(k) { tab = k; store.set("redplan-tab", tab); pinMode = null; render(); }

function tabCount(k) {
  const n = data.comments.filter((c) => c.anchor.tab === k).length;
  return n ? ` <span class="tab-count" aria-label="${n} comments">${n}</span>` : "";
}

const pinButton = (diagram) => `<button class="btn pin-toggle" type="button" data-pin="${diagram}" aria-pressed="${pinMode === diagram}">${pinMode === diagram ? "Done commenting" : "💬 Comment on diagram"}</button>`;

// ---------- the review panel ----------
function commentItem(c, editable) {
  return `<li class="fb-item ${c.status}" data-cid="${c.id}">
    <button class="fb-jump" type="button" data-jump="${c.id}" aria-label="Show comment ${c.num} in the plan"><span class="num">${c.num}</span>
      <span class="fb-text"><span class="fb-where">${esc(c.anchor.label || "Plan")}</span>
      ${c.quote ? `<span class="fb-quote">“${esc(c.quote.replace(/\s+/g, " ").slice(0, 120))}”</span>` : ""}
      <span class="fb-body">${esc(c.body)}</span></span></button>
    ${editable ? `<button class="icon-btn" type="button" data-edit="${c.id}" aria-label="Edit comment ${c.num}">✎</button>` : ""}
  </li>`;
}

function decisionPanel(pending, run, runState) {
  const list = numbered();
  const drafts = list.filter((c) => c.status === "draft");
  const prev = data.previous;
  const versions = `<div class="versions">${runState.plans.map((p) => `<a class="${p.id === data.id ? "cur" : ""}" href="/plans/${esc(p.id)}">v${p.version}</a>`).join("")}</div>`;
  const prevBlock = prev?.comments.length ? `<details class="prev-fb"><summary>Your ${prev.comments.length} comment${prev.comments.length === 1 ? "" : "s"} on v${prev.version}</summary>
    <a href="/plans/${esc(prev.id)}" style="font-size:12px">Open v${prev.version} with its highlights →</a>
    <ol class="fb-list" style="margin-top:8px">${prev.comments.map((c) => `<li class="fb-item sent"><span class="num">${c.n}</span><span class="fb-text"><span class="fb-where">${esc(c.anchor.label || "Plan")}</span><span class="fb-body">${esc(c.body)}</span></span></li>`).join("")}</ol></details>` : "";
  if (pending) return `
    <div class="panel-head"><h2>Review</h2>${pill(data.status)}</div>
    <div class="panel-body">
      <p class="muted" style="margin:0 0 10px">Highlight any text, press <b>💬</b> on a tech stack card, or use <b>💬 Comment on diagram</b> on the timeline and architecture, to leave comments. Then send them to the CEO in one go: it revises the plan and a new version appears here. You can keep chatting with it in the terminal too.</p>
      ${list.length ? `<ol class="fb-list">${list.map((c) => commentItem(c, true)).join("")}</ol>` : `<div class="fb-empty">No comments yet. Select some text in the plan to start.</div>`}
      <label class="fb-overall">Overall comment <span class="faint">(optional)</span>
        <textarea id="comment" placeholder="Anything that is not about one spot">${esc(overall)}</textarea></label>
      <div class="row">
        <button class="btn primary" id="send" ${drafts.length || overall.trim() ? "" : "disabled"}>Send feedback${drafts.length ? ` (${drafts.length})` : ""}</button>
        <button class="btn" id="approve">${drafts.length ? `Approve with ${drafts.length} note${drafts.length === 1 ? "" : "s"}` : "Approve plan"}</button>
      </div>
      ${prevBlock}${versions}
    </div>`;
  const sent = list.filter((c) => c.status === "sent");
  const latest = data.version !== data.latestVersion ? `<p style="margin:0 0 8px">A newer version exists: <a href="/plans/${esc(data.latestId)}">open v${data.latestVersion} →</a></p>` : "";
  const status = data.status === "approved" ? `<p style="margin:0">Approved${data.comment ? `: <i>${esc(data.comment)}</i>` : "."} <a href="/runs/${esc(run.id)}">Watch execution →</a></p>`
    : data.status === "changes_requested" ? `<p style="margin:0">You asked for changes${data.comment ? `: <i>${esc(data.comment)}</i>` : "."}${data.version === data.latestVersion ? ` <span class="muted">The CEO is revising the plan; the new version appears here.</span>` : ""}</p>`
    : `<p class="muted" style="margin:0">A newer version of this plan exists.</p>`;
  return `<div class="panel-head"><h2>Your decision</h2>${pill(data.status)}</div>
    <div class="panel-body">${latest}${status}
      ${sent.length ? `<div class="section-title" style="margin-top:12px">Comments sent</div><ol class="fb-list">${sent.map((c) => commentItem(c, false)).join("")}</ol>` : ""}
      ${prevBlock}${versions}</div>`;
}

function wireDecision(pending) {
  document.querySelectorAll("[data-jump]").forEach((b) => b.onclick = () => jumpTo(Number(b.dataset.jump)));
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => editComment(Number(b.dataset.edit), b.getBoundingClientRect()));
  if (!pending) return;
  const text = document.getElementById("comment"), send = document.getElementById("send");
  const drafts = () => data.comments.filter((c) => c.status === "draft").length;
  text.oninput = () => { overall = text.value; store.set(`redplan-overall-${planId}`, overall); send.disabled = !drafts() && !overall.trim(); };
  const decide = async (decision) => {
    closeComposer();
    const n = drafts();
    if (decision === "changes" && !n && !overall.trim()) return toast("Add a comment first");
    try {
      await api("POST", `/api/plans/${planId}/decision`, { decision, comment: overall.trim() });
      overall = ""; store.set(`redplan-overall-${planId}`, "");
      toast(decision === "approve" ? "Approved: the CEO is starting the team" : `Sent ${n ? `${n} comment${n === 1 ? "" : "s"}` : "your feedback"} to the CEO. It is revising the plan.`);
      load();
    } catch (e) { toast(e.message); }
  };
  send.onclick = () => decide("changes");
  document.getElementById("approve").onclick = () => decide("approve");
}

// ---------- annotations in the page ----------
function applyAnnotations() {
  const list = numbered();
  const tabBody = document.getElementById("tab-body"), hero = app.querySelector(".hero > div");
  for (const c of list) {
    const a = c.anchor;
    if (a.kind === "pin") {
      if (a.tab !== tab) continue;
      const host = app.querySelector(`.diagram[data-diagram="${CSS.escape(a.diagram || "")}"]`);
      if (!host) continue;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `pin ${c.status}`;
      pin.dataset.cid = c.id;
      pin.style.left = `${(a.x ?? 0.5) * 100}%`;
      pin.style.top = `${(a.y ?? 0.5) * 100}%`;
      pin.textContent = c.num;
      pin.title = c.body;
      pin.setAttribute("aria-label", `Comment ${c.num}: ${c.body}`);
      host.appendChild(pin);
      continue;
    }
    const scope = a.tab === "overview" ? hero : a.tab === tab ? tabBody : null;
    if (!scope) continue;
    if (a.kind === "card") {
      const card = scope.querySelector(`[data-anchor="${CSS.escape(a.target || "")}"]`);
      const spot = card?.querySelector(".card-tools") || card;
      if (!spot) { document.querySelector(`.fb-item[data-cid="${c.id}"]`)?.classList.add("orphan"); continue; }
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = `anno-badge card-badge ${c.status}`;
      badge.dataset.cid = c.id;
      badge.textContent = c.num;
      badge.title = c.body;
      badge.setAttribute("aria-label", `Comment ${c.num}: ${c.body}`);
      spot.appendChild(badge);
      card.classList.add("has-comment");
      continue;
    }
    // Same target on several elements (older plans anchored duplicate packages alike): use the one holding the quote.
    const target = CSS.escape(a.target || "");
    const els = [...(scope.matches(`[data-anchor="${target}"]`) ? [scope] : []), ...scope.querySelectorAll(`[data-anchor="${target}"], [data-anchor^="${target}#"]`)].filter((e) => !e.closest("svg"));
    let marks = [];
    for (const el of els) { marks = highlight(el, c.quote, a.prefix, { class: `anno ${c.status}`, "data-cid": String(c.id) }); if (marks.length) break; }
    if (!marks.length) { document.querySelector(`.fb-item[data-cid="${c.id}"]`)?.classList.add("orphan"); continue; }
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = `anno-badge ${c.status}`;
    badge.dataset.cid = c.id;
    badge.textContent = c.num;
    badge.setAttribute("aria-label", `Comment ${c.num}: ${c.body}`);
    marks.at(-1).after(badge);
  }
}

app.addEventListener("click", (e) => {
  const hit = e.target.closest("mark.anno, .anno-badge, .pin");
  if (hit && !pinMode && getSelection()?.isCollapsed !== false) { e.preventDefault(); e.stopPropagation(); editComment(Number(hit.dataset.cid), hit.getBoundingClientRect()); }
}, true);

async function editComment(id, rect) {
  const c = numbered().find((x) => x.id === id);
  if (!c) return;
  const draft = c.status === "draft" && reviewing();
  const v = await compose({ rect, where: `#${c.num} · ${c.anchor.label || "Plan"}`, quote: c.quote, value: c.body, readOnly: !draft,
    onDelete: draft ? async () => { try { await api("DELETE", `/api/plans/${planId}/comments/${id}`); data.comments = data.comments.filter((x) => x.id !== id); render(); } catch (e) { toast(e.message); } } : undefined });
  if (!v || !draft || v === c.body) return;
  try { const u = await api("PATCH", `/api/plans/${planId}/comments/${id}`, { body: v }); data.comments = data.comments.map((x) => (x.id === id ? u : x)); render(); } catch (e) { toast(e.message); }
}

async function addComment(anchor, quote, rect) {
  const body = await compose({ rect, where: anchor.label, quote });
  if (!body) return;
  try { data.comments.push(await api("POST", `/api/plans/${planId}/comments`, { anchor, quote, body })); render(); toast("Comment added. Send feedback when you are done."); }
  catch (e) { toast(e.message); }
}

function jumpTo(id) {
  const c = data.comments.find((x) => x.id === id);
  if (!c) return;
  if (c.anchor.tab && c.anchor.tab !== "overview" && c.anchor.tab !== tab) switchTab(c.anchor.tab);
  const el = app.querySelector(`.anno-badge[data-cid="${id}"], .pin[data-cid="${id}"]`);
  if (!el) return toast(c.anchor.kind === "text" ? "That text is not in this version any more" : "Pin not found");
  const story = el.closest("details.story");
  if (story && !story.open) story.open = true;
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  app.querySelectorAll(`[data-cid="${id}"]`).forEach((m) => { m.classList.remove("flash"); void m.offsetWidth; m.classList.add("flash"); });
}

// Selecting text in the plan offers a "Comment" button next to the selection.
const selBtn = document.createElement("button");
selBtn.type = "button";
selBtn.className = "sel-btn btn primary";
selBtn.textContent = "💬 Comment";
selBtn.hidden = true;
document.body.appendChild(selBtn);
selBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
selBtn.addEventListener("click", () => {
  const s = selection;
  hideSel();
  getSelection()?.removeAllRanges();
  if (!s) return;
  const inHero = !!s.el.closest(".hero");
  const t = inHero ? "overview" : tab;
  const label = s.el.id === "tab-body" || s.el.dataset.anchor === "overview" ? TAB_NAME[t] : `${TAB_NAME[t]} › ${s.el.dataset.label || s.el.dataset.anchor}`;
  addComment({ kind: "text", tab: t, target: s.el.dataset.anchor, label, prefix: s.prefix }, s.quote, s.rect);
});
function hideSel() {
  selBtn.hidden = true;
  selection = null;
  if (reloadLater && !composerOpen()) { reloadLater = false; setTimeout(load, 0); }
}
let selTimer;
function checkSelection() {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!data || !reviewing() || composerOpen()) return;
    const s = readSelection(app);
    if (!s) return hideSel();
    selection = s;
    selBtn.hidden = false;
    const w = selBtn.offsetWidth, h = selBtn.offsetHeight;
    selBtn.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, s.rect.right - w / 2))}px`;
    selBtn.style.top = `${s.rect.bottom + 8 + h < innerHeight ? s.rect.bottom + 8 : Math.max(8, s.rect.top - h - 8)}px`;
  }, 120);
}
document.addEventListener("selectionchange", checkSelection);
addEventListener("scroll", () => { if (selection) checkSelection(); }, { passive: true });

// Diagram pins: in comment mode a click drops a numbered bubble where you clicked.
function wirePins() {
  app.querySelectorAll("[data-card-comment]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    addComment({ kind: "card", tab, target: b.dataset.cardComment, label: `${TAB_NAME[tab]} › ${b.dataset.cardLabel}` }, null, b.getBoundingClientRect());
  });
  app.querySelectorAll("[data-pin]").forEach((b) => b.onclick = () => { pinMode = pinMode === b.dataset.pin ? null : b.dataset.pin; render(); if (pinMode) toast("Click anywhere on the diagram to pin a comment"); });
  app.querySelectorAll(".diagram").forEach((host) => {
    const on = pinMode === host.dataset.diagram;
    host.classList.toggle("pinning", on);
    if (!on) return;
    host.onclick = (e) => {
      if (e.target.closest(".pin")) return;
      const svg = host.querySelector("svg");
      const r = host.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      const t = pinTarget(svg, e);
      const label = `${DIAGRAM_NAME[host.dataset.diagram]}${t.label ? ` › ${t.near ? "near " : ""}${t.label}` : ""}`;
      addComment({ kind: "pin", tab, diagram: host.dataset.diagram, x, y, target: t.target, label }, null, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    };
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pinMode && !composerOpen()) { pinMode = null; render(); } });

// ---------- which coding agent runs each task ----------
const harnessOf = (t) => data.harness?.[t.id] || data.harness?.["*"] || t.harness || "pi";
const harnessName = (id) => harnessList?.find((h) => h.id === id)?.name || id;
function harnessSelect(value, attrs, label) {
  return `<select class="harness-select" ${attrs} aria-label="${esc(label)}">${value ? "" : `<option value="" selected disabled>Mixed</option>`}${(harnessList || []).map((h) => `<option value="${esc(h.id)}" ${h.id === value ? "selected" : ""} ${h.installed ? "" : "disabled"}>${esc(h.name)}${h.installed ? "" : " (not installed)"}</option>`).join("")}</select>`;
}
function harnessBar(plan, pending) {
  const tasks = plan.stories.flatMap((s) => s.tasks);
  const counts = {};
  for (const t of tasks) counts[harnessOf(t)] = (counts[harnessOf(t)] || 0) + 1;
  const summary = Object.entries(counts).map(([h, n]) => `${esc(harnessName(h))} ${n}`).join(" · ");
  if (!pending) return `<div class="harness-bar no-annotate"><span class="muted">Coding agents: ${summary}</span></div>`;
  const all = Object.keys(counts).length === 1 ? Object.keys(counts)[0] : "";
  return `<div class="harness-bar no-annotate">
    <label>Run every task with ${harnessSelect(all, `data-harness-all`, "Coding agent for every task")}</label>
    <span class="muted">${summary}. Pi is the default; you can pick per task below. Only agents installed on this machine can be chosen.</span>
  </div>`;
}
function wireHarness() {
  const put = async (task, harness) => {
    try { data.harness = await api("PUT", `/api/runs/${data.runId}/harness`, { task, harness }); render(); toast(`${task === "*" ? "Every task" : task} → ${harnessName(harness)}`); }
    catch (e) { toast(e.message); render(); }
  };
  app.querySelectorAll("[data-harness-all]").forEach((el) => el.onchange = () => put("*", el.value));
  app.querySelectorAll("[data-harness-task]").forEach((el) => el.onchange = () => put(el.dataset.harnessTask, el.value));
}

function storiesView(plan, schedule, pending) {
  const crit = new Set(schedule.criticalPath);
  return plan.stories.map((s, i) => {
    const hrs = s.tasks.reduce((n, t) => n + Number(t.estimateHours), 0);
    const onCrit = s.tasks.some((t) => crit.has(t.id));
    return `<details class="panel story" data-story="${esc(s.id)}" data-anchor="story:${esc(s.id)}" data-label="${esc(`Story ${s.id} · ${s.title}`)}">
      <summary><span class="chev">›</span>
        <span><span class="sid">${esc(s.id)}</span> <span class="story-title">${esc(s.title)}</span><div class="user-story">${esc(s.userStory)}</div></span>
        <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${onCrit ? `<span class="pill red">critical path</span>` : ""}${(s.dependsOn || []).length ? `<span class="pill">after ${esc(s.dependsOn.join(", "))}</span>` : ""}<span class="pill">${s.tasks.length} tasks · ${hours(hrs)}</span></span>
      </summary>
      <div class="story-body">
        ${s.description ? `<p style="margin:0 0 8px">${esc(s.description)}</p>` : ""}
        ${(s.acceptance || []).length ? `<div class="section-title">Acceptance</div><ul class="acc">${s.acceptance.map((a, ai) => `<li data-anchor="acc:${esc(s.id)}:${ai}" data-label="${esc(`Story ${s.id} · acceptance ${ai + 1}`)}">${esc(a)}</li>`).join("")}</ul>` : ""}
        ${s.tasks.map((t) => { const st = schedule.tasks[t.id]; return `
          <div class="task ${st.critical ? "crit" : ""}" data-anchor="task:${esc(t.id)}" data-label="${esc(`Task ${t.id} · ${t.title}`)}">
            <div class="tid">${esc(t.id)}</div>
            <div><div class="tt">${esc(t.title)}</div><div class="td">${esc(t.description)}</div>
              <div class="meta">${t.tech ? `<span class="pill cyan">${esc(t.tech)}</span>` : ""}${t.suggestedRole ? `<span class="pill">${esc(t.suggestedRole)}</span>` : ""}${st.deps.length ? `<span class="pill">needs ${esc(st.deps.join(", "))}</span>` : `<span class="pill green">can start now</span>`}${st.critical ? `<span class="pill red">critical</span>` : `<span class="pill">slack ${hours(st.slack)}</span>`}</div></div>
            <div class="est">${hours(st.hours)}<br><span class="faint">h${st.es}–${st.ef}</span>
              <div class="no-annotate" style="margin-top:6px">${pending ? harnessSelect(harnessOf(t), `data-harness-task="${esc(t.id)}"`, `Coding agent for ${t.id}`) : harnessOf(t) !== "pi" ? `<span class="pill violet">${esc(harnessName(harnessOf(t)))}</span>` : ""}</div></div>
          </div>`; }).join("")}
      </div></details>`;
  }).join("");
}

function timelineView(plan, schedule, pending) {
  const names = Object.fromEntries(plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, t.title])));
  return `
    <div class="panel"><div class="panel-head"><h2>Gantt</h2><span class="muted mono" style="margin-right:auto">${hours(schedule.duration)} wall clock · ${hours(schedule.totalHours)} effort</span>${pending ? pinButton("gantt") : ""}</div>
      <div class="panel-body"><div class="legend"><span><i style="background:var(--red)"></i>critical path</span><span><i style="background:var(--green-dim)"></i>has slack</span><span><i style="border-top:1px dashed var(--faint);height:0"></i>slack (can slip without delaying the project)</span></div>
      ${panZoomFrame("Gantt chart", `<div class="diagram" data-diagram="gantt" id="gantt"></div>`)}</div></div>
    <div class="stats" style="margin-top:14px">
      <div class="panel" style="grid-column:1/-1" data-anchor="critical-path" data-label="Critical path"><div class="panel-head"><h2>Critical path</h2><span class="pill red">${schedule.criticalPath.length} tasks</span></div>
        <div class="panel-body mono">${schedule.criticalPath.map((id) => `<span class="pill red" title="${esc(names[id])}">${esc(id)}</span>`).join(" → ")}</div></div>
      <div class="panel" style="grid-column:1/-1" data-anchor="parallel" data-label="What can run in parallel"><div class="panel-head"><h2>What can run in parallel</h2><span class="muted">tasks that can start at the same time</span></div>
        <div class="panel-body waves">${schedule.waves.map((w) => `<div class="wave"><span class="mono muted">from h${w.start}</span><div class="chips">${w.tasks.map((id) => `<span class="pill ${schedule.tasks[id].critical ? "red" : "green"}">${esc(id)} · ${esc(names[id])}</span>`).join("")}</div></div>`).join("")}</div></div>
      ${(plan.team || []).length ? `<div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Proposed team</h2></div><div class="panel-body waves">${plan.team.map((m) => `<div class="wave" data-anchor="team:${esc(m.name)}" data-label="${esc(`Proposed team · ${m.name}`)}"><b>${esc(m.name)}</b><div><span class="muted">${esc(m.role)}</span><div class="chips" style="margin-top:4px">${(m.taskIds || []).map((id) => `<span class="pill">${esc(id)}</span>`).join("")}</div></div></div>`).join("")}</div></div>` : ""}
    </div>`;
}

function drawGantt(plan, schedule) {
  const el = document.getElementById("gantt");
  const rowH = 26, labelW = 300, top = 26;
  const rows = plan.stories.flatMap((s) => [{ story: s }, ...s.tasks.map((t) => ({ task: t }))]);
  const chartW = Math.max(520, el.closest(".pz").clientWidth - labelW - 12);
  const scale = chartW / Math.max(1, schedule.duration);
  const step = [1, 2, 4, 8, 16, 24, 40, 80, 160].find((s) => s * scale >= 56) || 320;
  const h = top + rows.length * rowH + 8;
  let svg = `<svg class="gantt" width="${labelW + chartW + 10}" height="${h}" role="img" aria-label="Gantt chart">`;
  for (let x = 0; x <= schedule.duration; x += step) svg += `<line class="grid" x1="${labelW + x * scale}" x2="${labelW + x * scale}" y1="${top - 6}" y2="${h}"/>${(schedule.duration - x) * scale > 30 ? `<text x="${labelW + x * scale + 3}" y="14">h${x}</text>` : ""}`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    if (r.story) { svg += `<g data-anchor="story:${esc(r.story.id)}" data-label="${esc(`Story ${r.story.id} · ${r.story.title}`)}"><rect class="story-row" x="0" y="${y}" width="${labelW + chartW + 10}" height="${rowH}"/><text class="label" x="8" y="${y + 17}" style="font-weight:600">${esc(r.story.id)} · ${esc(trim(r.story.title, 34))}</text></g>`; return; }
    const t = schedule.tasks[r.task.id];
    const x = labelW + t.es * scale, w = Math.max(3, t.hours * scale);
    svg += `<g data-anchor="task:${esc(r.task.id)}" data-label="${esc(`${r.task.id} · ${r.task.title} (h${t.es}–h${t.ef})`)}"><rect class="row-hit" x="0" y="${y}" width="${labelW + chartW + 10}" height="${rowH}"/><text class="label" x="20" y="${y + 17}">${esc(r.task.id)} ${esc(trim(r.task.title, 32))}</text>`;
    if (!t.critical && t.slack > 0) svg += `<line class="slack" x1="${x + w}" x2="${x + w + t.slack * scale}" y1="${y + rowH / 2}" y2="${y + rowH / 2}"/>`;
    svg += `<rect class="bar ${t.critical ? "crit" : ""}" x="${x}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="3"><title>${esc(r.task.id)} ${esc(r.task.title)}: h${t.es}–h${t.ef} (${hours(t.hours)})${t.critical ? ", critical" : `, slack ${hours(t.slack)}`}</title></rect></g>`;
  });
  el.innerHTML = svg + "</svg>";
  // Long plans are read top to bottom: fit the width and pan down.
  mountPanZoom(el.closest(".pz"), { key: `${planId}:gantt`, fit: "width", minFit: 0.6 });
}

const KIND_COLOR = { ui: "var(--cyan)", service: "var(--green)", api: "var(--green)", db: "var(--violet)", database: "var(--violet)", queue: "var(--amber)", external: "var(--muted)", library: "var(--red)", model: "var(--red)", agent: "var(--red)" };

function drawArchitecture(arch) {
  const el = document.getElementById("arch");
  const comps = arch?.components || [];
  if (!comps.length) { el.innerHTML = `<div class="empty">No architecture in this plan.</div>`; return; }
  const links = (arch.links || []).filter((l) => comps.some((c) => c.id === l.from) && comps.some((c) => c.id === l.to));
  // Columns = longest path over the links, ignoring links that close a loop (A → B → A): those
  // are drawn as return curves. Counting them pushed looping components one column further
  // right per pass, which made diagrams extremely wide.
  const out = Object.fromEntries(comps.map((c) => [c.id, links.filter((l) => l.from === c.id)]));
  const state = {}, loops = new Set();
  const visit = (id) => {
    state[id] = 1;
    for (const l of out[id]) { if (state[l.to] === 1) loops.add(l); else if (!state[l.to]) visit(l.to); }
    state[id] = 2;
  };
  for (const c of comps) if (!state[c.id]) visit(c.id);
  const level = Object.fromEntries(comps.map((c) => [c.id, 0]));
  for (let i = 0; i < comps.length; i++) for (const l of links) if (!loops.has(l) && level[l.to] < level[l.from] + 1) level[l.to] = level[l.from] + 1;
  const cols = [];
  for (const c of comps) (cols[level[c.id]] ||= []).push(c);
  const W = 190, H = 64, gx = 150, gy = 36, pad = 24, back = 46;
  const pos = {};
  cols.forEach((col, ci) => col.forEach((c, ri) => { pos[c.id] = { x: pad + ci * (W + gx), y: pad + ri * (H + gy) }; }));
  const names = Object.fromEntries(comps.map((c) => [c.id, c.name]));
  const width = pad * 2 + cols.length * W + (cols.length - 1) * gx;
  const returns = links.some((l) => pos[l.to].x <= pos[l.from].x);
  const height = pad * 2 + Math.max(...cols.map((c) => c.length)) * (H + gy) - gy + (returns ? back + 24 : 0);
  // Labels sit in the gap between columns (forward links) or under the return curve, trimmed to
  // the space they have; links sharing a gap and height are stacked instead of printed on top of each other.
  const maxChars = Math.floor((gx - 12) / 6.2);
  const taken = [];
  const place = (x, y) => { while (taken.some((t) => Math.abs(t.x - x) < gx * 0.8 && Math.abs(t.y - y) < 13)) y += 14; taken.push({ x, y }); return y; };
  let svg = `<div class="diagram" data-diagram="arch"><svg class="arch" width="${width}" height="${height}" role="img" aria-label="Architecture diagram"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--faint)"/></marker></defs>`;
  let labels = "";
  for (const l of links) {
    const a = pos[l.from], b = pos[l.to];
    const forward = b.x > a.x;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const low = Math.max(a.y, b.y) + H + back;
    const d = forward ? `M${x1},${y1} C${x1 + gx / 2},${y1} ${x2 - gx / 2},${y2} ${x2},${y2}` : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${low} ${b.x + W / 2},${low} ${b.x + W / 2},${b.y + H}`;
    svg += `<g data-anchor="link:${esc(l.from)}>${esc(l.to)}" data-label="${esc(`${names[l.from]} → ${names[l.to]}${l.label ? ` (${l.label})` : ""}`)}"><title>${esc(`${names[l.from]} → ${names[l.to]}${l.label ? `: ${l.label}` : ""}`)}</title><path class="edge" d="${d}" marker-end="url(#arr)"/><path class="edge-hit" d="${d}"/></g>`;
    if (l.label) {
      const lx = forward ? (x1 + x2) / 2 : (a.x + b.x) / 2 + W / 2;
      const ly = place(lx, forward ? (y1 + y2) / 2 - 6 : a.y + H + back * 0.75 + 12);
      labels += `<text class="elabel" x="${lx}" y="${ly}" text-anchor="middle"><title>${esc(l.label)}</title>${esc(trim(l.label, forward ? maxChars : 40))}</text>`;
    }
  }
  for (const c of comps) {
    const p = pos[c.id], color = KIND_COLOR[String(c.kind || "").toLowerCase()] || "var(--green)";
    svg += `<g data-anchor="component:${esc(c.id)}" data-label="${esc(`${c.name} (${c.kind || "component"})`)}"><title>${esc(c.name)}${c.tech ? ` (${esc(c.tech)})` : ""}${c.description ? `: ${esc(c.description)}` : ""}</title>
      <rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="var(--panel-2)" stroke="${color}" stroke-width="1.5"/>
      <rect x="${p.x}" y="${p.y}" width="4" height="${H}" rx="2" fill="${color}"/>
      <text class="kind" x="${p.x + 14}" y="${p.y + 18}">${esc(String(c.kind || "").toUpperCase())}</text>
      <text x="${p.x + 14}" y="${p.y + 36}" style="font-weight:600">${esc(trim(c.name, 24))}</text>
      ${c.tech ? `<text class="kind" x="${p.x + 14}" y="${p.y + 53}">${esc(trim(c.tech, 28))}</text>` : ""}</g>`;
  }
  // Labels last, with a halo, so no box or line covers them.
  el.innerHTML = panZoomFrame("Architecture diagram", svg + labels + `</svg></div>`) + (comps.some((c) => c.description) ? `<div class="tech" style="margin-top:14px">${comps.filter((c) => c.description).map((c) => `<div class="panel card" data-anchor="component:${esc(c.id)}" data-label="${esc(`${c.name} (${c.kind || "component"})`)}"><b>${esc(c.name)}</b> <span class="muted mono">${esc(c.kind || "")}</span><div class="muted" style="font-size:13px;margin-top:4px">${esc(c.description)}</div></div>`).join("")}</div>` : "");
  mountPanZoom(el.querySelector(".pz"), { key: `${planId}:arch`, fit: "contain", minFit: 0.45 });
}

function techView(stack, pending) {
  if (!stack.length) return `<div class="empty">No technologies listed.</div>`;
  // One package can appear on several cards (two parts of the same library): each card needs its
  // own anchor, or comments on the second card are looked for in the first one and get lost.
  const seen = {};
  return `<div class="tech">${stack.map((t) => {
    const ok = t.verified === true && /^https?:\/\//.test(t.source || "");
    const n = (seen[t.package] = (seen[t.package] || 0) + 1);
    const anchor = `tech:${t.package}${n > 1 ? `#${n}` : ""}`, label = `${t.name} (${t.package})`;
    return `<div class="panel card" data-anchor="${esc(anchor)}" data-label="${esc(label)}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><div><div style="font-weight:600">${esc(t.name)}</div><div class="pkg">${esc(t.package)}${t.version ? `<span class="muted">@${esc(t.version)}</span>` : ""}</div></div>
        <div class="card-tools no-annotate">${ok ? `<span class="pill green">verified</span>` : `<span class="pill amber">unverified</span>`}${pending ? cardCommentButton(anchor, label) : ""}</div></div>
      <dl>
        ${t.ecosystem ? `<dt>From</dt><dd>${esc(t.ecosystem)}</dd>` : ""}
        ${t.usedFor ? `<dt>Used for</dt><dd>${esc(t.usedFor)}</dd>` : ""}
        ${t.uses ? `<dt>We use</dt><dd class="mono">${esc(t.uses)}</dd>` : ""}
        ${t.verifiedFact ? `<dt>Checked</dt><dd>${esc(t.verifiedFact)}</dd>` : ""}
        ${t.notThis ? `<dt>Not to confuse</dt><dd>${esc(t.notThis)}</dd>` : ""}
        ${t.source ? `<dt>Source</dt><dd><a href="${esc(safeUrl(t.source))}" target="_blank" rel="noopener noreferrer">${esc(trim(t.source, 60))}</a></dd>` : ""}
      </dl></div>`;
  }).join("")}</div>`;
}

function risksView(plan) {
  const risks = plan.risks || [];
  const intake = plan.intake;
  return `<div class="stats">
    ${intake ? `<div class="panel" style="grid-column:1/-1" data-anchor="intake" data-label="How this plan was made"><div class="panel-head"><h2>How this plan was made</h2><span class="pill">${intake.mode === "grilled" ? "questions asked first" : "request was already clear"}</span></div><div class="panel-body">${esc(intake.notes || "")}</div></div>` : ""}
    <div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Risks</h2></div><div class="panel-body">${risks.length ? `<ul style="margin:0;padding-left:18px">${risks.map((r, ri) => `<li data-anchor="risk:${ri}" data-label="Risk ${ri + 1}">${esc(typeof r === "string" ? r : `${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ""}`)}</li>`).join("")}</ul>` : `<span class="muted">None listed.</span>`}</div></div>
    ${(plan.outOfScope || []).length ? `<div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Out of scope</h2></div><div class="panel-body"><ul style="margin:0;padding-left:18px">${plan.outOfScope.map((r, ri) => `<li data-anchor="oos:${ri}" data-label="Out of scope ${ri + 1}">${esc(r)}</li>`).join("")}</ul></div></div>` : ""}
  </div>`;
}

// "💬" on a card: comment on the whole card (no text selection needed).
const cardCommentButton = (anchor, label) => `<button class="btn card-comment" type="button" data-card-comment="${esc(anchor)}" data-card-label="${esc(label)}" aria-label="${esc(`Comment on ${label}`)}" title="Comment on this">💬</button>`;

function trim(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : "#"; }

load().then(() => data && live(data.runId, load));
signedInAs();
