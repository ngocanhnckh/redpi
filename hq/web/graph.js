// Communication graph for a RedPlan run: people are nodes, edge width is how much
// they talk. The layout is ported from munder-difflin
// (components/memoryGraph/forceLayout.ts, MIT, Copyright (c) 2026 Chaitanya Giri):
// deterministic Fruchterman–Reingold on a phyllotaxis seed, pinned (dragged) nodes
// stay put, and the CEO gets extra pull toward the centre.
import { esc } from "/static/hq.js";
import { portraitUrl } from "/static/office/people.js";

const GOLDEN_ANGLE = 2.399963229728653;

export function forceLayout(nodes, edges, { width, height, pinned = {}, iterations = 320, padding = 36 }) {
  const ids = nodes.map((n) => n.id);
  const cx = width / 2, cy = height / 2;
  const usableR = Math.max(40, Math.min(width, height) / 2 - padding);
  const pos = new Map();
  ids.forEach((id, i) => { const r = usableR * Math.sqrt((i + 0.5) / Math.max(1, ids.length)), a = i * GOLDEN_ANGLE; pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }); });
  for (const id of ids) if (pinned[id]) pos.set(id, { ...pinned[id] });
  if (ids.length <= 1) return pos;
  const k = Math.sqrt((width * height) / ids.length) * 0.55, k2 = k * k, gravity = 0.045;
  const bias = new Map(nodes.map((n) => [n.id, n.gravityBias ?? 1]));
  const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
  let temp = Math.min(width, height) * 0.12;
  const cool = Math.pow(0.02, 1 / iterations);
  for (let it = 0; it < iterations; it++) {
    for (const id of ids) { const d = disp.get(id); d.x = 0; d.y = 0; }
    for (let i = 0; i < ids.length; i++) {
      const pi = pos.get(ids[i]), di = disp.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const pj = pos.get(ids[j]);
        let dx = pi.x - pj.x, dy = pi.y - pj.y, dist = Math.hypot(dx, dy);
        if (dist < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; dist = Math.hypot(dx, dy); }
        const f = k2 / dist, ux = dx / dist, uy = dy / dist, dj = disp.get(ids[j]);
        di.x += ux * f; di.y += uy * f; dj.x -= ux * f; dj.y -= uy * f;
      }
    }
    for (const e of edges) {
      const ps = pos.get(e.source), pt = pos.get(e.target);
      if (!ps || !pt) continue;
      const dx = ps.x - pt.x, dy = ps.y - pt.y, dist = Math.hypot(dx, dy) || 0.01;
      const f = ((dist * dist) / k) * (e.strength ?? 1), ux = dx / dist, uy = dy / dist;
      const ds = disp.get(e.source), dt = disp.get(e.target);
      ds.x -= ux * f; ds.y -= uy * f; dt.x += ux * f; dt.y += uy * f;
    }
    for (const id of ids) { const p = pos.get(id), d = disp.get(id), g = gravity * (bias.get(id) ?? 1); d.x += (cx - p.x) * g; d.y += (cy - p.y) * g; }
    for (const id of ids) {
      if (pinned[id]) { pos.set(id, { ...pinned[id] }); continue; }
      const p = pos.get(id), d = disp.get(id), len = Math.hypot(d.x, d.y) || 0.01, step = Math.min(len, temp);
      p.x = Math.max(padding, Math.min(width - padding, p.x + (d.x / len) * step));
      p.y = Math.max(padding, Math.min(height - padding, p.y + (d.y / len) * step));
    }
    temp *= cool;
  }
  return pos;
}

const pins = {};

/** Render the talk graph into `el` (an SVG host). `onSelect(id)` opens a person. */
export function renderGraph(el, state, onSelect) {
  const { workers, messages } = state;
  const people = [{ id: "ceo", name: "CEO", role: "ceo" }, ...workers.map((w) => ({ id: w.id, name: w.name, role: w.role, alive: w.alive })), { id: "human", name: "You", role: "human" }];
  const counts = new Map();
  for (const m of messages) {
    if (m.kind === "task" || m.recipient === "all") continue;
    const a = m.sender, b = m.recipient;
    if (a === b) continue;
    const key = [a, b].sort().join("→");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const edges = [...counts.entries()].map(([k, n]) => { const [source, target] = k.split("→"); return { source, target, n, strength: Math.min(2, 0.5 + n / 6) }; })
    .filter((e) => people.some((p) => p.id === e.source) && people.some((p) => p.id === e.target));
  const width = Math.max(320, el.clientWidth || 800), height = 480;
  // Extra padding leaves room for portraits above and name labels below each node.
  const pos = forceLayout(people.map((p) => ({ id: p.id, gravityBias: p.id === "ceo" ? 3 : 1 })), edges, { width, height, pinned: pins, padding: 60 });
  const max = Math.max(1, ...edges.map((e) => e.n));
  const recent = new Set(messages.slice(-5).filter((m) => m.kind !== "task").map((m) => [m.sender, m.recipient].sort().join("→")));
  el.innerHTML = `<svg class="graph" width="${width}" height="${height}" role="img" aria-label="Who talks to whom">
    ${edges.map((e) => { const a = pos.get(e.source), b = pos.get(e.target), hot = recent.has([e.source, e.target].sort().join("→"));
      return `<line class="edge ${hot ? "hot" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${1 + (e.n / max) * 6}"><title>${e.n} messages</title></line>`; }).join("")}
    ${people.map((p) => { const q = pos.get(p.id);
      const img = p.role === "human" ? "" : `<image href="${portraitUrl(p.name, p.role)}" x="${q.x - 18}" y="${q.y - 28}" width="36" height="56" style="image-rendering:pixelated"/>`;
      return `<g class="node ${p.alive === false ? "off" : ""}" data-id="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.name)}">
        <circle cx="${q.x}" cy="${q.y}" r="26" class="${p.id === "ceo" ? "ceo" : p.id === "human" ? "you" : ""}"/>${img}
        ${p.role === "human" ? `<text x="${q.x}" y="${q.y + 4}" text-anchor="middle" class="you-label">YOU</text>` : ""}
        <text x="${q.x}" y="${q.y + 42}" text-anchor="middle">${esc(p.name)}</text></g>`; }).join("")}
  </svg>`;
  // Drag to pin a node (as in the original); click or Enter opens the person.
  const svg = el.querySelector("svg");
  let drag = null;
  svg.querySelectorAll(".node").forEach((n) => {
    n.addEventListener("pointerdown", (e) => { drag = { id: n.dataset.id, el: n, sx: e.clientX, sy: e.clientY, moved: false }; n.setPointerCapture(e.pointerId); });
    n.addEventListener("keydown", (e) => { if (e.key === "Enter") onSelect(n.dataset.id); });
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) drag.el.setAttribute("transform", `translate(${dx} ${dy})`);
  });
  svg.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) return onSelect(d.id);
    const start = pos.get(d.id);
    pins[d.id] = { x: start.x + e.clientX - d.sx, y: start.y + e.clientY - d.sy };
    renderGraph(el, state, onSelect);
  });
}
