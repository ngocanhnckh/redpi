import { api, esc, hours, live, pill, toast } from "/static/hq.js";

const planId = location.pathname.split("/")[2];
const app = document.getElementById("app");
let tab = sessionStorage.getItem("redplan-tab") || "stories";
let data;

async function load() {
  try {
    data = await api("GET", `/api/plans/${planId}`);
    data.runState = await api("GET", `/api/runs/${data.runId}`);
    render();
  } catch (e) {
    app.innerHTML = `<div class="error-box">Could not load plan: ${esc(e.message)}</div>`;
  }
}

function render() {
  const { plan, schedule, warnings, project, run, runState } = data;
  document.title = `${plan.title} · RedPlan`;
  document.getElementById("crumbs").innerHTML = `<a href="/runs/${esc(run.id)}">${esc(project.name)} · ${esc(run.title)}</a>`;
  const tasks = plan.stories.flatMap((s) => s.tasks);
  const pending = data.status === "pending" && data.version === data.latestVersion;
  app.innerHTML = `
    <section class="hero">
      <div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${pill(data.status)}<span class="muted mono">v${data.version}</span><span class="muted mono" title="${esc(project.path)}">${esc(project.path)}</span></div>
        <h1>${esc(plan.title)}</h1>
        <p class="summary">${esc(plan.summary)}</p>
        ${plan.goal ? `<p class="muted"><b>Goal:</b> ${esc(plan.goal)}</p>` : ""}
        <div class="stats" style="margin-top:16px">
          <div class="panel stat"><div class="v">${hours(schedule.duration)}</div><div class="k">Critical path (wall clock)</div></div>
          <div class="panel stat"><div class="v">${hours(schedule.totalHours)}</div><div class="k">Total effort</div></div>
          <div class="panel stat"><div class="v">${schedule.maxParallel}×</div><div class="k">Max parallel tasks</div></div>
          <div class="panel stat"><div class="v">${plan.stories.length} / ${tasks.length}</div><div class="k">Stories / tasks</div></div>
        </div>
        ${warnings.length ? `<div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Needs attention</h2><span class="pill amber">${warnings.length}</span></div><div class="panel-body"><ul class="warn-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div></div>` : ""}
      </div>
      <aside class="panel decision">
        <div class="panel-head"><h2>Your decision</h2>${pill(data.status)}</div>
        <div class="panel-body">
          ${pending ? `
            <p class="muted" style="margin:0">Approve to let the CEO session form the team and start the workers. Or ask for changes: the plan comes back as a new version.</p>
            <textarea id="comment" placeholder="Comment (required for changes, optional for approval)"></textarea>
            <div class="row"><button class="btn primary" id="approve">Approve plan</button><button class="btn danger" id="changes">Request changes</button></div>`
          : data.status === "approved" ? `<p style="margin:0">Approved${data.comment ? `: <i>${esc(data.comment)}</i>` : "."} <a href="/runs/${esc(run.id)}">Watch execution →</a></p>`
          : data.status === "changes_requested" ? `<p style="margin:0">You asked for changes: <i>${esc(data.comment || "")}</i></p>`
          : `<p class="muted" style="margin:0">A newer version of this plan exists.</p>`}
          <div class="versions">${runState.plans.map((p) => `<a class="${p.id === data.id ? "cur" : ""}" href="/plans/${esc(p.id)}">v${p.version}</a>`).join("")}</div>
        </div>
      </aside>
    </section>
    <nav class="tabs" role="tablist">
      ${[["stories", "Stories & tasks"], ["timeline", "Timeline & critical path"], ["architecture", "Architecture"], ["tech", "Tech stack"], ["risks", "Risks & notes"]]
        .map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`).join("")}
    </nav>
    <section id="tab-body"></section>`;
  app.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.tab; sessionStorage.setItem("redplan-tab", tab); render(); });
  if (pending) {
    const decide = async (decision) => {
      const comment = document.getElementById("comment").value.trim();
      if (decision === "changes" && !comment) return toast("Say what should change");
      try { await api("POST", `/api/plans/${planId}/decision`, { decision, comment }); toast(decision === "approve" ? "Approved: the CEO is starting the team" : "Sent back for changes"); load(); }
      catch (e) { toast(e.message); }
    };
    document.getElementById("approve").onclick = () => decide("approve");
    document.getElementById("changes").onclick = () => decide("changes");
  }
  const body = document.getElementById("tab-body");
  if (tab === "stories") body.innerHTML = storiesView(plan, schedule);
  if (tab === "timeline") { body.innerHTML = timelineView(plan, schedule); drawGantt(plan, schedule); }
  if (tab === "architecture") { body.innerHTML = `<div class="panel"><div class="panel-head"><h2>Architecture</h2></div><div class="panel-body" id="arch"></div></div>`; drawArchitecture(plan.architecture); }
  if (tab === "tech") body.innerHTML = techView(plan.techStack || []);
  if (tab === "risks") body.innerHTML = risksView(plan);
}

function storiesView(plan, schedule) {
  const crit = new Set(schedule.criticalPath);
  return plan.stories.map((s, i) => {
    const hrs = s.tasks.reduce((n, t) => n + Number(t.estimateHours), 0);
    const onCrit = s.tasks.some((t) => crit.has(t.id));
    return `<details class="panel story" ${i === 0 ? "open" : ""}>
      <summary><span class="chev">›</span>
        <span><span class="sid">${esc(s.id)}</span> <span class="story-title">${esc(s.title)}</span><div class="user-story">${esc(s.userStory)}</div></span>
        <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${onCrit ? `<span class="pill red">critical path</span>` : ""}${(s.dependsOn || []).length ? `<span class="pill">after ${esc(s.dependsOn.join(", "))}</span>` : ""}<span class="pill">${s.tasks.length} tasks · ${hours(hrs)}</span></span>
      </summary>
      <div class="story-body">
        ${s.description ? `<p style="margin:0 0 8px">${esc(s.description)}</p>` : ""}
        ${(s.acceptance || []).length ? `<div class="section-title">Acceptance</div><ul class="acc">${s.acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
        ${s.tasks.map((t) => { const st = schedule.tasks[t.id]; return `
          <div class="task ${st.critical ? "crit" : ""}">
            <div class="tid">${esc(t.id)}</div>
            <div><div class="tt">${esc(t.title)}</div><div class="td">${esc(t.description)}</div>
              <div class="meta">${t.tech ? `<span class="pill cyan">${esc(t.tech)}</span>` : ""}${t.suggestedRole ? `<span class="pill">${esc(t.suggestedRole)}</span>` : ""}${st.deps.length ? `<span class="pill">needs ${esc(st.deps.join(", "))}</span>` : `<span class="pill green">can start now</span>`}${st.critical ? `<span class="pill red">critical</span>` : `<span class="pill">slack ${hours(st.slack)}</span>`}</div></div>
            <div class="est">${hours(st.hours)}<br><span class="faint">h${st.es}–${st.ef}</span></div>
          </div>`; }).join("")}
      </div></details>`;
  }).join("");
}

function timelineView(plan, schedule) {
  const names = Object.fromEntries(plan.stories.flatMap((s) => s.tasks.map((t) => [t.id, t.title])));
  return `
    <div class="panel"><div class="panel-head"><h2>Gantt</h2><span class="muted mono">${hours(schedule.duration)} wall clock · ${hours(schedule.totalHours)} effort</span></div>
      <div class="panel-body"><div class="legend"><span><i style="background:var(--red)"></i>critical path</span><span><i style="background:var(--green-dim)"></i>has slack</span><span><i style="border-top:1px dashed var(--faint);height:0"></i>slack (can slip without delaying the project)</span></div>
      <div class="gantt-wrap" id="gantt"></div></div></div>
    <div class="stats" style="margin-top:14px">
      <div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Critical path</h2><span class="pill red">${schedule.criticalPath.length} tasks</span></div>
        <div class="panel-body mono">${schedule.criticalPath.map((id) => `<span class="pill red" title="${esc(names[id])}">${esc(id)}</span>`).join(" → ")}</div></div>
      <div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>What can run in parallel</h2><span class="muted">tasks that can start at the same time</span></div>
        <div class="panel-body waves">${schedule.waves.map((w) => `<div class="wave"><span class="mono muted">from h${w.start}</span><div class="chips">${w.tasks.map((id) => `<span class="pill ${schedule.tasks[id].critical ? "red" : "green"}">${esc(id)} · ${esc(names[id])}</span>`).join("")}</div></div>`).join("")}</div></div>
      ${(plan.team || []).length ? `<div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Proposed team</h2></div><div class="panel-body waves">${plan.team.map((m) => `<div class="wave"><b>${esc(m.name)}</b><div><span class="muted">${esc(m.role)}</span><div class="chips" style="margin-top:4px">${(m.taskIds || []).map((id) => `<span class="pill">${esc(id)}</span>`).join("")}</div></div></div>`).join("")}</div></div>` : ""}
    </div>`;
}

function drawGantt(plan, schedule) {
  const el = document.getElementById("gantt");
  const rowH = 26, labelW = 300, top = 26;
  const rows = plan.stories.flatMap((s) => [{ story: s }, ...s.tasks.map((t) => ({ task: t }))]);
  const chartW = Math.max(520, el.clientWidth - labelW - 10);
  const scale = chartW / Math.max(1, schedule.duration);
  const step = [1, 2, 4, 8, 16, 24, 40, 80, 160].find((s) => s * scale >= 56) || 320;
  const h = top + rows.length * rowH + 8;
  let svg = `<svg class="gantt" width="${labelW + chartW + 10}" height="${h}" role="img" aria-label="Gantt chart">`;
  for (let x = 0; x <= schedule.duration; x += step) svg += `<line class="grid" x1="${labelW + x * scale}" x2="${labelW + x * scale}" y1="${top - 6}" y2="${h}"/>${(schedule.duration - x) * scale > 30 ? `<text x="${labelW + x * scale + 3}" y="14">h${x}</text>` : ""}`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    if (r.story) { svg += `<rect class="story-row" x="0" y="${y}" width="${labelW + chartW + 10}" height="${rowH}"/><text class="label" x="8" y="${y + 17}" style="font-weight:600">${esc(r.story.id)} · ${esc(trim(r.story.title, 34))}</text>`; return; }
    const t = schedule.tasks[r.task.id];
    const x = labelW + t.es * scale, w = Math.max(3, t.hours * scale);
    svg += `<text class="label" x="20" y="${y + 17}">${esc(r.task.id)} ${esc(trim(r.task.title, 32))}</text>`;
    if (!t.critical && t.slack > 0) svg += `<line class="slack" x1="${x + w}" x2="${x + w + t.slack * scale}" y1="${y + rowH / 2}" y2="${y + rowH / 2}"/>`;
    svg += `<rect class="bar ${t.critical ? "crit" : ""}" x="${x}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="3"><title>${esc(r.task.id)} ${esc(r.task.title)}: h${t.es}–h${t.ef} (${hours(t.hours)})${t.critical ? ", critical" : `, slack ${hours(t.slack)}`}</title></rect>`;
  });
  el.innerHTML = svg + "</svg>";
}

const KIND_COLOR = { ui: "var(--cyan)", service: "var(--green)", api: "var(--green)", db: "var(--violet)", database: "var(--violet)", queue: "var(--amber)", external: "var(--muted)", library: "var(--red)", model: "var(--red)", agent: "var(--red)" };

function drawArchitecture(arch) {
  const el = document.getElementById("arch");
  const comps = arch?.components || [];
  if (!comps.length) { el.innerHTML = `<div class="empty">No architecture in this plan.</div>`; return; }
  const links = (arch.links || []).filter((l) => comps.some((c) => c.id === l.from) && comps.some((c) => c.id === l.to));
  const level = Object.fromEntries(comps.map((c) => [c.id, 0]));
  for (let i = 0; i < comps.length; i++) for (const l of links) if (level[l.to] < level[l.from] + 1 && level[l.from] + 1 < comps.length) level[l.to] = level[l.from] + 1;
  const cols = [];
  for (const c of comps) (cols[level[c.id]] ||= []).push(c);
  const W = 190, H = 64, gx = 110, gy = 28, pad = 20;
  const pos = {};
  cols.forEach((col, ci) => col.forEach((c, ri) => { pos[c.id] = { x: pad + ci * (W + gx), y: pad + ri * (H + gy) }; }));
  const width = pad * 2 + cols.length * W + (cols.length - 1) * gx;
  const height = pad * 2 + Math.max(...cols.map((c) => c.length)) * (H + gy) - gy;
  let svg = `<div style="overflow-x:auto"><svg class="arch" width="${width}" height="${height}" role="img" aria-label="Architecture diagram"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--faint)"/></marker></defs>`;
  for (const l of links) {
    const a = pos[l.from], b = pos[l.to];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const d = x2 > x1 ? `M${x1},${y1} C${x1 + gx / 2},${y1} ${x2 - gx / 2},${y2} ${x2},${y2}` : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 40} ${b.x + W / 2},${b.y + H + 40} ${b.x + W / 2},${b.y + H}`;
    svg += `<path class="edge" d="${d}" marker-end="url(#arr)"/>`;
    if (l.label) svg += `<text class="elabel" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(trim(l.label, 22))}</text>`;
  }
  for (const c of comps) {
    const p = pos[c.id], color = KIND_COLOR[String(c.kind || "").toLowerCase()] || "var(--green)";
    svg += `<g><title>${esc(c.name)}${c.tech ? ` (${esc(c.tech)})` : ""}${c.description ? `: ${esc(c.description)}` : ""}</title>
      <rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="var(--panel-2)" stroke="${color}" stroke-width="1.5"/>
      <rect x="${p.x}" y="${p.y}" width="4" height="${H}" rx="2" fill="${color}"/>
      <text class="kind" x="${p.x + 14}" y="${p.y + 18}">${esc(String(c.kind || "").toUpperCase())}</text>
      <text x="${p.x + 14}" y="${p.y + 36}" style="font-weight:600">${esc(trim(c.name, 24))}</text>
      ${c.tech ? `<text class="kind" x="${p.x + 14}" y="${p.y + 53}">${esc(trim(c.tech, 28))}</text>` : ""}</g>`;
  }
  el.innerHTML = svg + `</svg></div>${comps.some((c) => c.description) ? `<div class="tech" style="margin-top:14px">${comps.filter((c) => c.description).map((c) => `<div class="panel card"><b>${esc(c.name)}</b> <span class="muted mono">${esc(c.kind || "")}</span><div class="muted" style="font-size:13px;margin-top:4px">${esc(c.description)}</div></div>`).join("")}</div>` : ""}`;
}

function techView(stack) {
  if (!stack.length) return `<div class="empty">No technologies listed.</div>`;
  return `<div class="tech">${stack.map((t) => {
    const ok = t.verified === true && /^https?:\/\//.test(t.source || "");
    return `<div class="panel card">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><div><div style="font-weight:600">${esc(t.name)}</div><div class="pkg">${esc(t.package)}${t.version ? `<span class="muted">@${esc(t.version)}</span>` : ""}</div></div>
        ${ok ? `<span class="pill green">verified</span>` : `<span class="pill amber">unverified</span>`}</div>
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
    ${intake ? `<div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>How this plan was made</h2><span class="pill">${intake.mode === "grilled" ? "questions asked first" : "request was already clear"}</span></div><div class="panel-body">${esc(intake.notes || "")}</div></div>` : ""}
    <div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Risks</h2></div><div class="panel-body">${risks.length ? `<ul style="margin:0;padding-left:18px">${risks.map((r) => `<li>${esc(typeof r === "string" ? r : `${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ""}`)}</li>`).join("")}</ul>` : `<span class="muted">None listed.</span>`}</div></div>
    ${(plan.outOfScope || []).length ? `<div class="panel" style="grid-column:1/-1"><div class="panel-head"><h2>Out of scope</h2></div><div class="panel-body"><ul style="margin:0;padding-left:18px">${plan.outOfScope.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div></div>` : ""}
  </div>`;
}

function trim(s, n) { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : "#"; }

load().then(() => data && live(data.runId, load));
