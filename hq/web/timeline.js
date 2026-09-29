// Timeline: the approved plan's Gantt chart with live progress (original RedPi code).
// Bars sit where the plan scheduled them (hours from the start, critical path outlined);
// each fills with its progress: done 100%, review 90%, not started 0%, blocked as far as it got,
// and in-progress work estimated from how long finished tasks really took against their
// estimates (the team's pace), capped below 100% until the task is actually done.
import { esc } from "/static/hq.js";
import { portraitUrl } from "/static/office/people.js";

const LABEL = { todo: "to do", in_progress: "in progress", review: "review", blocked: "blocked", done: "done" };
const pct = (x) => `${Math.round(x * 100)}%`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Progress (0..1) per task id, the team's pace, and when each task started and finished. */
export function progress(state) {
  const sched = state.plan?.schedule?.tasks || {};
  const moves = state.transitions || [];
  const now = state.now || Date.now();
  const started = {}, finished = {};
  for (const tr of moves) {
    if (tr.to_status === "in_progress" && !started[tr.task_id]) started[tr.task_id] = tr.created;
    if (tr.to_status === "done") finished[tr.task_id] = tr.created;
  }
  // Pace: real milliseconds per estimated hour, from finished tasks.
  const pace = median(state.tasks.filter((t) => t.status === "done" && started[t.id] && finished[t.id] && (sched[t.id]?.hours || t.hours) > 0)
    .map((t) => (finished[t.id] - started[t.id]) / (sched[t.id]?.hours || t.hours)));
  const of = {};
  for (const t of state.tasks) {
    const est = sched[t.id]?.hours || t.hours || 1;
    if (t.status === "done") of[t.id] = 1;
    else if (t.status === "review") of[t.id] = 0.9;
    else if (t.status === "todo" || !started[t.id]) of[t.id] = 0;
    else if (started[t.id] && pace) of[t.id] = Math.max(0.05, Math.min(0.85, (now - started[t.id]) / (est * pace)));
    else of[t.id] = 0.5;
  }
  return { of, pace, started, finished };
}

const PRIO = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

export function renderTimeline(el, state) {
  const plan = state.plan?.status === "approved" || state.approvedAt ? state.plan?.plan : null;
  const schedule = plan ? state.plan?.schedule : null;
  const tickets = state.tasks.filter((t) => t.kind === "ticket");
  if ((!plan || !schedule?.tasks) && !tickets.length || !state.tasks.length) { el.innerHTML = `<div class="empty">The timeline appears once the plan is approved or a ticket is added.</div>`; return; }
  const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  const workers = Object.fromEntries(state.workers.map((w) => [w.id, w]));
  const { of, pace, started } = progress(state);
  // Tickets sit where they were filed, on the plan's clock: hour 0 is the approval (or the first
  // ticket), and real time turns into plan hours at the team's pace (one hour per hour until known).
  const hourMs = pace || 3600_000;
  const origin = state.approvedAt || Math.min(...tickets.map((t) => t.created || state.run?.created || Date.now()));
  const sched = { ...(schedule?.tasks || {}) };
  for (const t of tickets) {
    const hours = t.hours || 1, begin = started[t.id] || t.created || origin;
    const es = Math.max(0, (begin - origin) / hourMs);
    sched[t.id] = { es, ef: es + hours, hours, critical: false };
  }
  const dur = Math.max(1, schedule?.duration || 0, ...tickets.map((t) => sched[t.id].ef));
  const x = (h) => (h / dur) * 100;
  const hoursOf = (id) => sched[id]?.hours || 0;
  const total = state.tasks.reduce((n, t) => n + hoursOf(t.id), 0) || 1;
  const doneWork = state.tasks.reduce((n, t) => n + hoursOf(t.id) * (of[t.id] || 0), 0);
  const crit = schedule?.criticalPath || [];
  const critDone = crit.filter((id) => byId[id]?.status === "done").length;
  const counts = state.tasks.reduce((c, t) => ({ ...c, [t.status]: (c[t.status] || 0) + 1 }), {});
  const step = [1, 2, 4, 8, 16, 24, 40, 80, 160, 320].find((s) => dur / s <= 10) || 640;
  const ticks = [];
  for (let h = 0; h <= dur + 1e-9; h += step) ticks.push(h);

  const group = (cls, id, title, ts) => {
    const es = Math.min(...ts.map((t) => sched[t.id].es)), ef = Math.max(...ts.map((t) => sched[t.id].ef));
    const sw = ts.reduce((n, t) => n + hoursOf(t.id), 0) || 1;
    const sp = ts.reduce((n, t) => n + hoursOf(t.id) * of[t.id], 0) / sw;
    const sDone = ts.filter((t) => byId[t.id].status === "done").length;
    return `<div class="tl-row story${cls}"><div class="tl-label">${id ? `<b>${esc(id)}</b> ` : ""}${esc(title)}<span class="tl-meta">${sDone}/${ts.length} · ${pct(sp)}</span></div>
      <div class="tl-track"><div class="tl-bar story" style="left:${x(es)}%;width:${Math.max(0.8, x(ef - es))}%" title="${esc(`${id ? `${id} ` : ""}${title}: ${pct(sp)} done (${sDone}/${ts.length} tasks)`)}"><i style="width:${pct(sp)}"></i></div></div></div>`;
  };
  const row = (t) => {
    const sc = sched[t.id], task = byId[t.id], w = workers[task.worker_id], p = of[t.id];
    const label = task.status === "in_progress" ? (pace ? `~${pct(p)}` : "in progress") : task.status === "done" ? "done" : task.status === "review" ? "in review" : task.status === "blocked" ? "blocked" : "to do";
    const ticket = task.kind === "ticket";
    const when = ticket ? `${task.priority || "normal"} ticket · about ${sc.hours}h` : `planned h${+sc.es.toFixed(1)}–h${+sc.ef.toFixed(1)} (${sc.hours}h)${sc.critical ? " · critical path" : ""}`;
    return `<div class="tl-row task st-${esc(task.status)}${sc.critical ? " crit" : ""}" data-task="${esc(t.id)}" role="button" tabindex="0">
      <div class="tl-label"><span class="mono tl-id">${esc(t.id)}</span> ${ticket ? `<span class="prio p-${esc(task.priority || "normal")}">${esc(PRIO[task.priority] || "Normal")}</span>` : ""}<span class="tl-title">${esc(t.title)}</span>${w ? `<span class="tl-who"><img class="avatar sm" alt="" src="${portraitUrl(w.name, w.role)}">${esc(w.name)}</span>` : ""}</div>
      <div class="tl-track"><div class="tl-bar" style="left:${x(sc.es)}%;width:${Math.max(0.8, x(sc.hours))}%" title="${esc(`${t.id} ${t.title} · ${LABEL[task.status] || task.status} · ${when}`)}"><i style="width:${pct(p)}"></i></div>
        <span class="tl-pct" style="left:calc(${x(sc.ef)}% + 6px)">${esc(label)}</span></div></div>`;
  };

  let rows = "";
  for (const s of plan?.stories || []) {
    const ts = s.tasks.filter((t) => schedule.tasks[t.id] && byId[t.id]);
    if (!ts.length) continue;
    rows += group("", s.id, s.title, ts);
    for (const t of ts) rows += row(t);
  }
  if (tickets.length) {
    rows += group(" tickets", "", "Tickets", tickets);
    for (const t of tickets) rows += row(t);
  }
  el.innerHTML = `<div class="tl">
    <div class="tl-summary">
      <div class="tl-overall"><div class="tl-big">${pct(doneWork / total)}</div><div class="tl-sum-text">of the estimated work done · ${counts.done || 0}/${state.tasks.length} tasks${crit.length ? ` · critical path ${critDone}/${crit.length}` : ""}${tickets.length ? ` · ${tickets.filter((t) => t.status !== "done").length} open ticket${tickets.filter((t) => t.status !== "done").length === 1 ? "" : "s"}` : ""}${pace ? ` · pace ${Math.max(1, Math.round(pace / 60000))} min per estimated hour` : ""}</div>
        <div class="pbar"><i style="width:${pct(doneWork / total)}"></i></div></div>
      <div class="tl-legend"><span><i class="lg done"></i>done</span><span><i class="lg review"></i>review</span><span><i class="lg in_progress"></i>in progress</span><span><i class="lg blocked"></i>blocked</span><span><i class="lg todo"></i>to do</span>${crit.length ? `<span><i class="lg crit"></i>critical path</span>` : ""}</div>
    </div>
    <div class="tl-grid" style="--step:${x(step)}%">
      <div class="tl-row tl-head"><div class="tl-label">${plan ? "Plan" : "Tickets"} (hours from the start)</div><div class="tl-track">${ticks.map((h) => `<span class="tl-tick" style="left:${x(h)}%">h${h}</span>`).join("")}</div></div>
      ${rows}
    </div></div>`;
}
