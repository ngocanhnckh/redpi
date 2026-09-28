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
  const pace = median(state.tasks.filter((t) => t.status === "done" && started[t.id] && finished[t.id] && sched[t.id]?.hours > 0)
    .map((t) => (finished[t.id] - started[t.id]) / sched[t.id].hours));
  const of = {};
  for (const t of state.tasks) {
    const est = sched[t.id]?.hours || 1;
    if (t.status === "done") of[t.id] = 1;
    else if (t.status === "review") of[t.id] = 0.9;
    else if (t.status === "todo" || !started[t.id]) of[t.id] = 0;
    else if (started[t.id] && pace) of[t.id] = Math.max(0.05, Math.min(0.85, (now - started[t.id]) / (est * pace)));
    else of[t.id] = 0.5;
  }
  return { of, pace, started, finished };
}

export function renderTimeline(el, state) {
  const plan = state.plan?.plan, schedule = state.plan?.schedule;
  if (!plan || !schedule?.tasks || !state.tasks.length) { el.innerHTML = `<div class="empty">The timeline appears once the plan is approved and the board has tasks.</div>`; return; }
  const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  const workers = Object.fromEntries(state.workers.map((w) => [w.id, w]));
  const { of, pace } = progress(state);
  const dur = Math.max(1, schedule.duration);
  const x = (h) => (h / dur) * 100;
  const hoursOf = (id) => schedule.tasks[id]?.hours || 0;
  const total = state.tasks.reduce((n, t) => n + hoursOf(t.id), 0) || 1;
  const doneWork = state.tasks.reduce((n, t) => n + hoursOf(t.id) * (of[t.id] || 0), 0);
  const crit = schedule.criticalPath || [];
  const critDone = crit.filter((id) => byId[id]?.status === "done").length;
  const counts = state.tasks.reduce((c, t) => ({ ...c, [t.status]: (c[t.status] || 0) + 1 }), {});
  const step = [1, 2, 4, 8, 16, 24, 40, 80, 160, 320].find((s) => dur / s <= 10) || 640;
  const ticks = [];
  for (let h = 0; h <= dur + 1e-9; h += step) ticks.push(h);

  let rows = "";
  for (const s of plan.stories) {
    const ts = s.tasks.filter((t) => schedule.tasks[t.id] && byId[t.id]);
    if (!ts.length) continue;
    const es = Math.min(...ts.map((t) => schedule.tasks[t.id].es)), ef = Math.max(...ts.map((t) => schedule.tasks[t.id].ef));
    const sw = ts.reduce((n, t) => n + hoursOf(t.id), 0) || 1;
    const sp = ts.reduce((n, t) => n + hoursOf(t.id) * of[t.id], 0) / sw;
    const sDone = ts.filter((t) => byId[t.id].status === "done").length;
    rows += `<div class="tl-row story"><div class="tl-label"><b>${esc(s.id)}</b> ${esc(s.title)}<span class="tl-meta">${sDone}/${ts.length} · ${pct(sp)}</span></div>
      <div class="tl-track"><div class="tl-bar story" style="left:${x(es)}%;width:${Math.max(0.8, x(ef - es))}%" title="${esc(`${s.id} ${s.title}: ${pct(sp)} done (${sDone}/${ts.length} tasks)`)}"><i style="width:${pct(sp)}"></i></div></div></div>`;
    for (const t of ts) {
      const sc = schedule.tasks[t.id], task = byId[t.id], w = workers[task.worker_id], p = of[t.id];
      const label = task.status === "in_progress" ? (pace ? `~${pct(p)}` : "in progress") : task.status === "done" ? "done" : task.status === "review" ? "in review" : task.status === "blocked" ? "blocked" : "to do";
      rows += `<div class="tl-row task st-${esc(task.status)}${sc.critical ? " crit" : ""}" data-task="${esc(t.id)}" role="button" tabindex="0">
        <div class="tl-label"><span class="mono tl-id">${esc(t.id)}</span> <span class="tl-title">${esc(t.title)}</span>${w ? `<span class="tl-who"><img class="avatar sm" alt="" src="${portraitUrl(w.name, w.role)}">${esc(w.name)}</span>` : ""}</div>
        <div class="tl-track"><div class="tl-bar" style="left:${x(sc.es)}%;width:${Math.max(0.8, x(sc.hours))}%" title="${esc(`${t.id} ${t.title} · ${LABEL[task.status] || task.status} · planned h${+sc.es.toFixed(1)}–h${+sc.ef.toFixed(1)} (${sc.hours}h)${sc.critical ? " · critical path" : ""}`)}"><i style="width:${pct(p)}"></i></div>
          <span class="tl-pct" style="left:calc(${x(sc.ef)}% + 6px)">${esc(label)}</span></div></div>`;
    }
  }
  el.innerHTML = `<div class="tl">
    <div class="tl-summary">
      <div class="tl-overall"><div class="tl-big">${pct(doneWork / total)}</div><div class="tl-sum-text">of the estimated work done · ${counts.done || 0}/${state.tasks.length} tasks · critical path ${critDone}/${crit.length}${pace ? ` · pace ${Math.max(1, Math.round(pace / 60000))} min per estimated hour` : ""}</div>
        <div class="pbar"><i style="width:${pct(doneWork / total)}"></i></div></div>
      <div class="tl-legend"><span><i class="lg done"></i>done</span><span><i class="lg review"></i>review</span><span><i class="lg in_progress"></i>in progress</span><span><i class="lg blocked"></i>blocked</span><span><i class="lg todo"></i>to do</span><span><i class="lg crit"></i>critical path</span></div>
    </div>
    <div class="tl-grid" style="--step:${x(step)}%">
      <div class="tl-row tl-head"><div class="tl-label">Plan (hours from the start)</div><div class="tl-track">${ticks.map((h) => `<span class="tl-tick" style="left:${x(h)}%">h${h}</span>`).join("")}</div></div>
      ${rows}
    </div></div>`;
}
