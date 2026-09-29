// Project charts for a RedPlan run, drawn as plain SVG from live HQ data (original
// RedPi code): burndown with a forecast, cumulative flow, throughput, cycle time,
// workload per person, status breakdown, team activity, and token use (per person and over time). Everything is rebuilt from
// the task transition log, so the charts are exact and update with every change.
import { esc } from "/static/hq.js";

// Bottom-to-top stacking order for the flow chart.
const STATUS = [["done", "Done", "var(--green)"], ["review", "Review", "var(--amber)"], ["in_progress", "In progress", "var(--cyan)"], ["blocked", "Blocked", "var(--red)"], ["todo", "To do", "var(--faint)"]];
const COLOR = Object.fromEntries(STATUS.map(([k, , c]) => [k, c]));
const W = 440, H = 200, M = { l: 38, r: 14, t: 12, b: 24 };
const MIN = 60_000, HOUR = 3_600_000;

const lin = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) * (r1 - r0)) / (d1 - d0));
function nice(x) { if (x <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
// Ticks from 0 up to the first one at or above max, so the data always fits under the top tick.
function yTicks(max, n = 4) { const step = nice(max / n); const out = [0]; while (out.at(-1) < max - 1e-9) out.push(+(out.at(-1) + step).toFixed(6)); return { ticks: out, max: out.at(-1) || 1 }; }
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 10080].map((m) => m * MIN);
function timeTicks(t0, t1, n = 5) {
  const step = STEPS.find((s) => (t1 - t0) / s <= n) || STEPS.at(-1);
  const out = [];
  for (let v = Math.ceil(t0 / step) * step; v <= t1; v += step) out.push(v);
  return out;
}
function clock(t, span) {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return span > 36 * HOUR ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : hm;
}
export function duration(ms) {
  if (!(ms > 0)) return "0m";
  const m = Math.round(ms / MIN);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const num = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

// Axes and grid for a time × value chart.
function frame({ x, y, t0, t1, ticks, yFmt = num }) {
  let s = "";
  for (const v of ticks) s += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${M.l - 5}" y="${y(v) + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
  for (const t of timeTicks(t0, t1)) s += `<text class="tick" x="${x(t)}" y="${H - 7}" text-anchor="middle">${clock(t, t1 - t0)}</text>`;
  return s + `<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>`;
}
const svg = (label, body, h = H) => `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
const legend = (items) => `<div class="chart-legend">${items.map(([label, color, n]) => `<span><i style="background:${color}"></i>${esc(label)}${n != null ? ` <b>${esc(String(n))}</b>` : ""}</span>`).join("")}</div>`;

// Each task's estimate in hours; without estimates every task counts as one unit.
function sizes(state) {
  const est = new Map();
  for (const s of state.plan?.plan?.stories || []) for (const t of s.tasks || []) if (Number(t.estimateHours) > 0) est.set(t.id, Number(t.estimateHours));
  const hours = state.tasks.length > 0 && state.tasks.every((t) => est.has(t.id));
  return { hours, of: (id) => (hours ? est.get(id) : 1) };
}

// Replays the transition log into snapshots of every task's status over time.
export function timeline(state) {
  const { tasks, transitions = [] } = state;
  const now = state.now || Date.now();
  const size = sizes(state);
  const known = new Set(tasks.map((t) => t.id));
  const firstMove = transitions.find((tr) => known.has(tr.task_id))?.created;
  const start = Math.min(state.approvedAt || firstMove || now, firstMove || now);
  const status = new Map(tasks.map((t) => [t.id, "todo"]));
  const snap = (t) => {
    const counts = { todo: 0, in_progress: 0, review: 0, blocked: 0, done: 0 };
    let left = 0, total = 0;
    for (const [id, st] of status) { counts[st in counts ? st : "todo"]++; total += size.of(id); if (st !== "done") left += size.of(id); }
    return { t, counts, left, total };
  };
  const points = [snap(start)];
  for (const tr of transitions) {
    if (!known.has(tr.task_id)) continue;
    status.set(tr.task_id, tr.to_status);
    points.push(snap(Math.max(start, tr.created)));
  }
  // The live board is the truth for "now" (older hubs may lack some transitions).
  for (const t of tasks) status.set(t.id, t.status);
  points.push(snap(Math.max(now, start + MIN)));
  return { start, now: Math.max(now, start + MIN), points, hours: size.hours, size };
}

// Step path through (t, value) points.
function stepPath(points, x, y, val) {
  let d = "";
  points.forEach((p, i) => { d += i === 0 ? `M${x(p.t)},${y(val(p))}` : `H${x(p.t)}V${y(val(p))}`; });
  return d;
}

function burndown(state, tl) {
  const { points, start, now, hours } = tl;
  const last = points.at(-1), total = points[0].total;
  const doneAmt = total - last.left, elapsed = now - start;
  const unit = hours ? "h" : " tasks";
  const rate = doneAmt > 0 ? doneAmt / elapsed : 0;
  const finish = last.left > 0 && rate > 0 ? now + last.left / rate : null;
  const t1 = finish ? Math.min(finish, now + Math.max(elapsed, 30 * MIN) * 2) : now;
  const { ticks, max } = yTicks(Math.max(total, 1));
  const x = lin(start, t1, M.l, W - M.r), y = lin(0, max, H - M.b, M.t);
  const line = stepPath(points, x, y, (p) => p.left);
  let body = frame({ x, y, t0: start, t1, ticks, yFmt: (v) => (hours ? `${num(v)}h` : num(v)) });
  body += `<path class="area" style="fill:var(--cyan)" d="${line}V${y(0)}H${x(start)}Z"/><path class="line" style="stroke:var(--cyan)" d="${line}"/>`;
  if (finish) {
    const endLeft = finish > t1 ? last.left - rate * (t1 - now) : 0;
    body += `<path class="forecast" d="M${x(now)},${y(last.left)}L${x(t1)},${y(Math.max(0, endLeft))}"><title>Forecast at the current pace</title></path>`;
  }
  body += `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="${M.t}" y2="${H - M.b}"/>`;
  const doneTasks = last.counts.done, allTasks = state.tasks.length;
  const sub = last.left <= 0 ? `All ${allTasks} tasks done in ${duration(elapsed)}`
    : `${num(last.left)}${unit} of ${num(total)}${unit} left · ${doneTasks}/${allTasks} done${finish ? ` · forecast ${clock(finish, finish - start)} (in ${duration(finish - now)})` : " · no pace yet"}`;
  return { key: "burndown", title: "Burndown", sub, svg: svg(`Burndown: ${sub}`, body), legend: legend([[hours ? "Estimated hours left" : "Tasks left", "var(--cyan)"], ...(finish ? [["Forecast at current pace", "var(--muted)"]] : [])]) };
}

function flow(state, tl) {
  const { points, start, now } = tl;
  const n = state.tasks.length;
  const { ticks, max } = yTicks(Math.max(n, 1));
  const x = lin(start, now, M.l, W - M.r), y = lin(0, max, H - M.b, M.t);
  let body = frame({ x, y, t0: start, t1: now, ticks });
  const base = points.map(() => 0);
  for (const [k, label, color] of STATUS) {
    const top = points.map((p, i) => base[i] + p.counts[k]);
    if (top.some((v, i) => v !== base[i])) {
      // Forward along the band's top as steps, then back along its base.
      let d = "";
      points.forEach((p, i) => { d += i === 0 ? `M${x(p.t)},${y(top[i])}` : `H${x(p.t)}V${y(top[i])}`; });
      const n = points.length - 1;
      d += `V${y(base[n])}`;
      for (let i = n; i >= 1; i--) d += `V${y(base[i - 1])}H${x(points[i - 1].t)}`;
      body += `<path class="band" style="fill:${color}" d="${d}Z"><title>${esc(label)}</title></path>`;
    }
    top.forEach((v, i) => { base[i] = v; });
  }
  const c = points.at(-1).counts;
  const wip = c.in_progress + c.review;
  const sub = `${c.done} done · ${wip} in flight · ${c.blocked} blocked · ${c.todo} waiting`;
  return { key: "flow", title: "Cumulative flow", sub, svg: svg(`Cumulative flow: ${sub}`, body), legend: legend(STATUS.map(([k, label, color]) => [label, color, c[k]])) };
}

function throughput(state, tl) {
  const { start, now } = tl;
  const span = now - start;
  const size = [5, 10, 15, 30, 60, 120, 240, 480, 1440].map((m) => m * MIN).find((b) => span / b <= 16) || 1440 * MIN;
  const b0 = Math.floor(start / size) * size, count = Math.max(1, Math.ceil((now - b0) / size));
  const bins = new Array(count).fill(0);
  for (const tr of state.transitions || []) if (tr.to_status === "done" && tr.created >= b0) bins[Math.min(count - 1, Math.floor((tr.created - b0) / size))]++;
  const total = bins.reduce((a, b) => a + b, 0);
  const { ticks, max } = yTicks(Math.max(...bins, 1), 3);
  const x = lin(b0, b0 + count * size, M.l, W - M.r), y = lin(0, max, H - M.b, M.t);
  let body = frame({ x, y, t0: b0, t1: b0 + count * size, ticks });
  const bw = Math.max(2, (W - M.l - M.r) / count - 3);
  bins.forEach((v, i) => { if (v) body += `<rect class="cbar" style="fill:var(--green)" x="${x(b0 + i * size) + 1.5}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" rx="2"><title>${v} done ${clock(b0 + i * size, span)}–${clock(b0 + (i + 1) * size, span)}</title></rect>`; });
  const perHour = total / Math.max(span / HOUR, 1 / 60);
  const sub = `${total} task${total === 1 ? "" : "s"} done · ${perHour >= 10 ? Math.round(perHour) : perHour.toFixed(1)} per hour · ${duration(size)} bars`;
  return { key: "throughput", title: "Throughput", sub, svg: svg(`Throughput: ${sub}`, body), legend: "" };
}

function cycleTime(state, tl) {
  const now = tl.now;
  const rows = [];
  for (const t of state.tasks) {
    const moves = (state.transitions || []).filter((tr) => tr.task_id === t.id);
    const began = moves.find((tr) => tr.to_status === "in_progress")?.created;
    if (!began) continue;
    const ended = t.status === "done" ? moves.filter((tr) => tr.to_status === "done").at(-1)?.created : null;
    rows.push({ id: t.id, title: t.title, ms: (ended || now) - began, open: !ended, status: t.status, at: ended || now });
  }
  if (!rows.length) return { key: "cycle", title: "Cycle time", sub: "Starts when a task moves to in progress", svg: `<div class="chart-empty">No task started yet.</div>`, legend: "" };
  const shown = rows.sort((a, b) => b.at - a.at).slice(0, 10).reverse();
  const done = rows.filter((r) => !r.open).map((r) => r.ms).sort((a, b) => a - b);
  const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : 0, median = done.length ? done[Math.floor(done.length / 2)] : 0;
  const rowH = 17, h = M.t + shown.length * rowH + M.b, L = 56;
  const maxMs = Math.max(...shown.map((r) => r.ms), avg, MIN);
  const x = lin(0, maxMs, L, W - M.r - 40);
  let body = "";
  shown.forEach((r, i) => {
    const yy = M.t + i * rowH;
    body += `<text class="tick" x="${L - 6}" y="${yy + 11}" text-anchor="end">${esc(r.id)}</text>`;
    body += `<rect class="cbar${r.open ? " open" : ""}" style="fill:${r.open ? COLOR[r.status] || "var(--cyan)" : "var(--green)"}" x="${L}" y="${yy + 2}" width="${Math.max(2, x(r.ms) - L)}" height="${rowH - 5}" rx="2"><title>${esc(r.id)} ${esc(r.title)}: ${duration(r.ms)}${r.open ? " so far" : ""}</title></rect>`;
    body += `<text class="tick" x="${x(r.ms) + 4}" y="${yy + 11}">${duration(r.ms)}${r.open ? "…" : ""}</text>`;
  });
  if (avg) body += `<line class="avg" x1="${x(avg)}" x2="${x(avg)}" y1="${M.t - 2}" y2="${h - M.b + 2}"><title>Average ${duration(avg)}</title></line>`;
  const sub = done.length ? `avg ${duration(avg)} · median ${duration(median)} · ${done.length} done` : `${rows.length} in progress, none done yet`;
  return { key: "cycle", title: "Cycle time", sub, svg: svg(`Cycle time: ${sub}`, body, h), legend: legend([["Done", "var(--green)"], ["Still open", "var(--cyan)"], ...(avg ? [["Average", "var(--amber)"]] : [])]) };
}

function workload(state) {
  const people = state.workers.map((w) => ({ id: w.id, name: w.name }));
  if (state.tasks.some((t) => !t.worker_id)) people.push({ id: null, name: "Unassigned" });
  if (!people.length) return { key: "workload", title: "Workload", sub: "Appears when the team is formed", svg: `<div class="chart-empty">No one on the team yet.</div>`, legend: "" };
  const rowH = 20, L = 76, h = M.t + people.length * rowH + 8;
  const maxN = Math.max(1, ...people.map((p) => state.tasks.filter((t) => t.worker_id === p.id).length));
  const x = lin(0, maxN, L, W - M.r - 22);
  let body = "";
  people.forEach((p, i) => {
    const mine = state.tasks.filter((t) => t.worker_id === p.id);
    const yy = M.t + i * rowH;
    body += `<text class="tick" x="${L - 6}" y="${yy + 12}" text-anchor="end">${esc(p.name.length > 11 ? p.name.slice(0, 10) + "…" : p.name)}</text>`;
    let at = L;
    for (const [k, label, color] of STATUS) {
      const n = mine.filter((t) => t.status === k).length;
      if (!n) continue;
      const w = x(n) - L;
      body += `<rect class="cbar" style="fill:${color}" x="${at}" y="${yy + 3}" width="${Math.max(1, w - 1)}" height="${rowH - 7}" rx="2"><title>${esc(p.name)}: ${n} ${esc(label.toLowerCase())}</title></rect>`;
      at += w;
    }
    body += `<text class="tick" x="${at + 4}" y="${yy + 12}">${mine.length}</text>`;
  });
  const busiest = people.filter((p) => p.id).map((p) => ({ p, n: state.tasks.filter((t) => t.worker_id === p.id && t.status !== "done").length })).sort((a, b) => b.n - a.n)[0];
  const sub = `${state.workers.length} people · ${state.tasks.length} tasks${busiest?.n ? ` · most open: ${busiest.p.name} (${busiest.n})` : ""}`;
  return { key: "workload", title: "Workload", sub, svg: svg(`Workload: ${sub}`, body, h), legend: legend(STATUS.map(([, label, color]) => [label, color])) };
}

function breakdown(state) {
  const n = state.tasks.length, R = 62, r = 40, cx = 110, cy = 95;
  const counts = Object.fromEntries(STATUS.map(([k]) => [k, state.tasks.filter((t) => t.status === k).length]));
  let a = -Math.PI / 2, body = "";
  const arc = (a0, a1) => {
    const p = (ang, rad) => `${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r},${r} 0 ${large} 0 ${p(a0, r)}Z`;
  };
  for (const [k, label, color] of STATUS) {
    if (!counts[k]) continue;
    const span = (counts[k] / n) * Math.PI * 2;
    body += counts[k] === n ? `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" style="fill:none;stroke:${color};stroke-width:${R - r}"><title>${esc(label)}: ${counts[k]}</title></circle>`
      : `<path style="fill:${color}" d="${arc(a, a + span - 0.012)}"><title>${esc(label)}: ${counts[k]}</title></path>`;
    a += span;
  }
  const pct = Math.round((counts.done / n) * 100);
  body += `<text class="big" x="${cx}" y="${cy + 2}" text-anchor="middle">${pct}%</text><text class="tick" x="${cx}" y="${cy + 16}" text-anchor="middle">done</text>`;
  let ly = 44;
  for (const [k, label, color] of STATUS) {
    body += `<rect x="215" y="${ly - 8}" width="10" height="10" rx="2" style="fill:${color}"/><text class="lbl" x="232" y="${ly}">${esc(label)}</text><text class="lbl num" x="${W - 30}" y="${ly}" text-anchor="end">${counts[k]}</text>`;
    ly += 22;
  }
  const sub = `${counts.done} of ${n} tasks done${counts.blocked ? ` · ${counts.blocked} blocked` : ""}`;
  return { key: "status", title: "Status", sub, svg: svg(`Status: ${sub}`, body, 190), legend: "" };
}

function activity(state) {
  const now = state.now || Date.now(), bucket = 5 * MIN, cols = 24;
  const end = Math.floor(now / bucket) * bucket, first = end - (cols - 1) * bucket;
  const people = state.workers;
  if (!people.length) return { key: "activity", title: "Team activity", sub: "Tool calls per person", svg: `<div class="chart-empty">No one on the team yet.</div>`, legend: "" };
  const grid = new Map(people.map((w) => [w.id, new Array(cols).fill(0)]));
  let total = 0;
  for (const a of state.activity || []) {
    const i = Math.round((a.at - first) / bucket);
    if (i >= 0 && i < cols && grid.has(a.worker_id)) { grid.get(a.worker_id)[i] += a.n; total += a.n; }
  }
  const max = Math.max(1, ...[...grid.values()].flat());
  const L = 76, rowH = 18, cw = (W - L - M.r) / cols, h = M.t + people.length * rowH + M.b;
  let body = "";
  people.forEach((w, r) => {
    const yy = M.t + r * rowH;
    body += `<text class="tick" x="${L - 6}" y="${yy + 12}" text-anchor="end">${esc(w.name.length > 11 ? w.name.slice(0, 10) + "…" : w.name)}</text>`;
    grid.get(w.id).forEach((n, i) => {
      body += `<rect class="cell" x="${L + i * cw + 0.5}" y="${yy + 2}" width="${cw - 1.5}" height="${rowH - 5}" rx="2" style="fill:var(--green);fill-opacity:${n ? 0.18 + 0.82 * (n / max) : 0.05}"><title>${esc(w.name)}: ${n} tool call${n === 1 ? "" : "s"} at ${clock(first + i * bucket, 0)}</title></rect>`;
    });
  });
  body += `<text class="tick" x="${L}" y="${h - 7}">${clock(first, 0)}</text><text class="tick" x="${W - M.r}" y="${h - 7}" text-anchor="end">now</text>`;
  const sub = `${total} tool calls in the last 2 hours · 5-minute cells`;
  return { key: "activity", title: "Team activity", sub, svg: svg(`Team activity: ${sub}`, body, h), legend: "" };
}

// ---------- token use ----------
const PEOPLE_COLORS = ["var(--green)", "var(--cyan)", "var(--amber)", "#b995ff", "var(--red)", "#7fd1ae", "#f08bc0", "#9fb3a6"];
export function tokens(n) { n = Number(n) || 0; return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); }
const PARTS = [["input", "New input", "var(--cyan)"], ["cacheRead", "Cache read", "#b995ff"], ["cacheWrite", "Cache write", "var(--amber)"], ["output", "Output", "var(--green)"]];
function people(state) {
  const names = new Map([["ceo", "CEO"], ...state.workers.map((w) => [w.id, w.name])]);
  return (state.usage?.totals || []).map((u) => ({ ...u, name: names.get(u.worker_id) || u.worker_id, total: u.input + u.output + u.cacheRead + u.cacheWrite })).sort((a, b) => b.total - a.total);
}
function tokenUse(state) {
  const rows = people(state);
  if (!rows.length) return { key: "tokens", title: "Token use", sub: "Appears as the agents work (reported per model call)", svg: `<div class="chart-empty">No token use reported yet.</div>`, legend: "" };
  const rowH = 20, L = 76, h = M.t + rows.length * rowH + 8;
  const x = lin(0, Math.max(1, ...rows.map((r) => r.total)), L, W - M.r - 40);
  let body = "";
  rows.forEach((r, i) => {
    const yy = M.t + i * rowH;
    body += `<text class="tick" x="${L - 6}" y="${yy + 12}" text-anchor="end">${esc(r.name.length > 11 ? r.name.slice(0, 10) + "…" : r.name)}</text>`;
    let at = L;
    for (const [k, label, color] of PARTS) {
      if (!r[k]) continue;
      const w = x(r[k]) - L;
      body += `<rect class="cbar" style="fill:${color}" x="${at}" y="${yy + 3}" width="${Math.max(1, w - 0.5)}" height="${rowH - 7}" rx="2"><title>${esc(r.name)}: ${tokens(r[k])} ${esc(label.toLowerCase())}</title></rect>`;
      at += w;
    }
    body += `<text class="tick" x="${at + 4}" y="${yy + 12}">${tokens(r.total)}</text>`;
  });
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const total = sum("total"), inAll = sum("input") + sum("cacheRead") + sum("cacheWrite"), cost = sum("cost");
  const sub = `${tokens(total)} tokens in ${sum("calls")} model calls · ${tokens(sum("output"))} output · ${inAll ? Math.round((100 * sum("cacheRead")) / inAll) : 0}% of input from cache${cost > 0 ? ` · $${cost.toFixed(2)}` : ""}`;
  return { key: "tokens", title: "Token use", sub, svg: svg(`Token use: ${sub}`, body, h), legend: legend(PARTS.map(([k, label, color]) => [label, color, tokens(sum(k))])) };
}
function tokenTime(state) {
  const series = state.usage?.series || [], slot = state.usage?.slot || 5 * MIN;
  if (!series.length) return { key: "tokens-time", title: "Tokens over time", sub: "Appears as the agents work", svg: `<div class="chart-empty">No token use reported yet.</div>`, legend: "" };
  const rows = people(state), color = new Map(rows.map((r, i) => [r.worker_id, PEOPLE_COLORS[i % PEOPLE_COLORS.length]]));
  const now = state.now || Date.now();
  const t0 = Math.min(...series.map((p) => p.at)), t1 = Math.max(now, t0 + slot);
  const bySlot = new Map();
  for (const p of series) { const m = bySlot.get(p.at) || new Map(); m.set(p.worker_id, (m.get(p.worker_id) || 0) + p.tokens); bySlot.set(p.at, m); }
  const { ticks, max } = yTicks(Math.max(1, ...[...bySlot.values()].map((m) => [...m.values()].reduce((a, b) => a + b, 0))));
  const x = lin(t0, t1, M.l, W - M.r), y = lin(0, max, H - M.b, M.t);
  const bw = Math.max(1.5, x(t0 + slot) - x(t0) - 1);
  let body = frame({ x, y, t0, t1, ticks, yFmt: tokens });
  for (const [at, m] of bySlot) {
    let acc = 0;
    for (const r of rows) {
      const v = m.get(r.worker_id); if (!v) continue;
      body += `<rect class="cbar" style="fill:${color.get(r.worker_id)}" x="${x(at)}" y="${y(acc + v)}" width="${bw}" height="${Math.max(0.5, y(acc) - y(acc + v))}"><title>${esc(r.name)}: ${tokens(v)} tokens at ${clock(at, 0)}</title></rect>`;
      acc += v;
    }
  }
  const last = [...bySlot.entries()].filter(([at]) => now - at < 3600_000).reduce((n, [, m]) => n + [...m.values()].reduce((a, b) => a + b, 0), 0);
  const sub = `${tokens(last)} tokens in the last hour · ${duration(slot)} bars`;
  return { key: "tokens-time", title: "Tokens over time", sub, svg: svg(`Tokens over time: ${sub}`, body), legend: legend(rows.map((r) => [r.name, color.get(r.worker_id)])) };
}

/** Renders every chart into `root` from the run state (call on each live update). */
export function renderCharts(root, state) {
  if (!state.tasks.length) { root.innerHTML = `<div class="empty">Charts appear once the plan is approved and the board has tasks.</div>`; return; }
  const tl = timeline(state);
  const charts = [burndown(state, tl), flow(state, tl), throughput(state, tl), cycleTime(state, tl), workload(state), breakdown(state), activity(state), tokenUse(state), tokenTime(state)];
  root.innerHTML = charts.map((c) => `<section class="panel chart" data-chart="${c.key}"><div class="panel-head"><h2>${esc(c.title)}</h2></div>
    <div class="chart-body"><div class="chart-sub">${esc(c.sub)}</div>${c.svg}${c.legend}</div></section>`).join("");
}
