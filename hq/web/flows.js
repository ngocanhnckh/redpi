// Feature flows: one flowchart per feature, so the human can check the business logic and the
// technology at each step ("User types username and password (Browser · Next.js form)" →
// "POST /auth/login (NestJS)" → "Compare with the bcrypt hash (Postgres)" → Match? yes / no …).
// Each flow is an SVG in the pan/zoom frame (pins work on it like on the other diagrams), plus
// the same steps as a numbered list you can comment on line by line.
import { esc } from "/static/hq.js";
import { mountPanZoom, panZoomFrame } from "/static/panzoom.js";

const KIND = {
  user: { color: "var(--cyan)", icon: "👤" }, ui: { color: "var(--cyan)", icon: "▭" },
  service: { color: "var(--green)", icon: "⚙" }, api: { color: "var(--green)", icon: "⚙" },
  db: { color: "var(--violet)", icon: "⛁" }, database: { color: "var(--violet)", icon: "⛁" },
  queue: { color: "var(--amber)", icon: "☰" }, external: { color: "var(--muted)", icon: "↗" },
  agent: { color: "var(--red)", icon: "◈" }, model: { color: "var(--red)", icon: "◈" },
  decision: { color: "var(--amber)", icon: "◆" },
};
const kindOf = (s) => KIND[String(s.kind || "").toLowerCase()] || { color: "var(--green)", icon: "•" };
const trim = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export const flowDiagram = (fid) => `flow:${fid}`;
export const stepAnchor = (fid, sid) => `flowstep:${fid}:${sid}`;

// Where each step goes next: explicit `next`, else the following step (unless it is an end).
export function flowEdges(flow) {
  const steps = flow.steps || [];
  const at = Object.fromEntries(steps.map((s, i) => [s.id, i]));
  const edges = [];
  steps.forEach((s, i) => {
    const next = Array.isArray(s.next) && s.next.length ? s.next.filter((n) => at[n?.to] !== undefined).map((n) => ({ from: i, to: at[n.to], label: n.label || "" }))
      : s.end || i === steps.length - 1 ? [] : [{ from: i, to: i + 1, label: "" }];
    edges.push(...next);
  });
  return edges;
}

export function wrapText(text, width, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= width) line += " " + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = trim(lines[maxLines - 1] + " …", width); }
  return lines;
}

// Rows = longest path from the start (links that loop back are drawn beside the boxes instead);
// the first branch continues straight down, other branches take the next free column.
function layout(flow) {
  const steps = flow.steps || [];
  const edges = flowEdges(flow);
  const out = steps.map((_, i) => edges.filter((e) => e.from === i));
  const state = [], back = new Set();
  const visit = (i) => { state[i] = 1; for (const e of out[i]) { if (state[e.to] === 1) back.add(e); else if (!state[e.to]) visit(e.to); } state[i] = 2; };
  steps.forEach((_, i) => { if (!state[i]) visit(i); });
  const row = steps.map(() => 0);
  for (let k = 0; k < steps.length; k++) for (const e of edges) if (!back.has(e) && row[e.to] < row[e.from] + 1) row[e.to] = row[e.from] + 1;
  const col = steps.map(() => -1), used = new Map();
  const take = (r, c) => { let x = Math.max(0, c); while (used.get(`${r}:${x}`)) x++; used.set(`${r}:${x}`, true); return x; };
  const order = steps.map((_, i) => i).sort((a, b) => row[a] - row[b] || a - b);
  for (const i of order) {
    if (col[i] < 0) col[i] = take(row[i], 0);
    out[i].filter((e) => !back.has(e)).forEach((e, k) => { if (col[e.to] < 0) col[e.to] = take(row[e.to], col[i] + (k === 0 ? 0 : k)); });
  }
  return { steps, edges, back, row, col };
}

export function flowsView(plan, pending, pinButton) {
  const flows = plan.flows || [];
  if (!flows.length) return `<div class="empty">No flows in this plan yet. Ask the CEO for one flowchart per feature (comment on the plan or tell it in the terminal).</div>`;
  const storyTitle = Object.fromEntries((plan.stories || []).map((s) => [s.id, s.title]));
  return flows.map((f) => {
    const L = layout(f);
    const byEdge = (i) => L.edges.filter((e) => e.from === i);
    return `<div class="panel flow" id="flow-${esc(f.id)}" data-anchor="flow:${esc(f.id)}" data-label="${esc(`Flow · ${f.title}`)}">
      <div class="panel-head"><h2 class="flow-title">${esc(f.title)}</h2>
        <span class="flow-stories">${(f.storyIds || []).map((id) => `<span class="pill" title="${esc(storyTitle[id] || "")}">${esc(id)}</span>`).join("")}</span>
        <span style="flex:1"></span>${pending ? pinButton(flowDiagram(f.id)) : ""}</div>
      <div class="panel-body">
        ${panZoomFrame(`Flow: ${f.title}`, `<div class="diagram" data-diagram="${esc(flowDiagram(f.id))}" data-flow="${esc(f.id)}"></div>`)}
        <ol class="flow-steps">${L.steps.map((s, i) => {
          const next = byEdge(i).filter((e) => e.label || e.to !== i + 1).map((e) => `${e.label ? `${esc(e.label)} → ` : "→ "}step ${e.to + 1}`);
          return `<li data-anchor="${esc(stepAnchor(f.id, s.id))}" data-label="${esc(`Flow ${f.title} · step ${i + 1}`)}">
            <span class="fs-where" style="color:${kindOf(s).color}">${esc(s.where || "")}</span> ${esc(s.action)}${s.tech ? ` <span class="fs-meta">· ${esc(s.tech)}</span>` : ""}${s.data ? ` <span class="fs-meta">· data: ${esc(s.data)}</span>` : ""}${next.length ? ` <span class="fs-next">${next.join(" · ")}</span>` : ""}${s.end || !byEdge(i).length ? ` <span class="fs-next">■ end</span>` : ""}</li>`;
        }).join("")}</ol>
      </div></div>`;
  }).join("");
}

export function drawFlows(plan, planId) {
  for (const f of plan.flows || []) {
    const el = document.querySelector(`.diagram[data-flow="${CSS.escape(f.id)}"]`);
    if (!el) continue;
    const L = layout(f);
    const W = 300, GX = 70, GY = 58, pad = 24, TOP = 16;
    const boxes = L.steps.map((s) => {
      const action = wrapText(s.action, 38, 4);
      const meta = wrapText([s.tech, s.data ? `data: ${s.data}` : ""].filter(Boolean).join(" · "), 46, 2);
      return { s, action, meta, h: 34 + action.length * 17 + (meta.length ? 6 + meta.length * 13 : 0) + 10 };
    });
    const rows = Math.max(0, ...L.row) + 1, cols = Math.max(0, ...L.col) + 1;
    const rowH = Array.from({ length: rows }, (_, r) => Math.max(40, ...boxes.filter((_, i) => L.row[i] === r).map((b) => b.h)));
    const rowY = []; let y = pad + TOP;
    for (let r = 0; r < rows; r++) { rowY[r] = y; y += rowH[r] + GY; }
    // Room on the right for loop-back curves and their labels.
    const backLabel = Math.max(0, ...[...L.back].map((e) => Math.min(28, (e.label || "").length)));
    const side = L.back.size ? 70 + backLabel * 7 : 0;
    const width = pad * 2 + cols * W + (cols - 1) * GX + side, height = y - GY + pad;
    const pos = boxes.map((b, i) => ({ x: pad + L.col[i] * (W + GX), y: rowY[L.row[i]], h: b.h }));
    let svg = `<svg class="flowchart" width="${width}" height="${height}" role="img" aria-label="${esc(`Flow: ${f.title}`)}"><defs><marker id="farr-${esc(f.id)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="var(--faint)"/></marker></defs>`;
    let labels = "";
    const taken = [];
    const place = (x, y, h = 12) => { while (taken.some((t) => Math.abs(t.x - x) < 90 && y - 10 < t.y - 10 + t.h && t.y - 10 < y - 10 + h)) y += 14; taken.push({ x, y, h }); return y; };
    for (const e of L.edges) {
      const a = pos[e.from], b = pos[e.to];
      let d, lx, ly;
      if (L.back.has(e)) {
        const x1 = a.x + W, y1 = a.y + a.h / 2, x2 = b.x + W, y2 = b.y + b.h / 2, bend = Math.max(x1, x2) + 50;
        d = `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`;
        lx = bend - 10; ly = (y1 + y2) / 2;
      } else {
        const x1 = a.x + W / 2, y1 = a.y + a.h, x2 = b.x + W / 2, y2 = b.y;
        d = `M${x1},${y1} C${x1},${y1 + GY / 2} ${x2},${y2 - GY / 2} ${x2},${y2}`;
        lx = (x1 + x2) / 2 + (x1 === x2 ? 6 : 0); ly = (y1 + y2) / 2 + 4;
      }
      svg += `<path class="edge" d="${d}" marker-end="url(#farr-${esc(f.id)})"/>`;
      if (e.label) {
        const lines = wrapText(e.label, 22, 3), y0 = place(lx, ly - (lines.length - 1) * 6, lines.length * 12 + 2), anchor = L.back.has(e) || x1Same(a, b) ? "start" : "middle";
        labels += `<text class="elabel" x="${lx}" y="${y0}" text-anchor="${anchor}"><title>${esc(e.label)}</title>${lines.map((ln, i) => `<tspan x="${lx}" dy="${i ? 12 : 0}">${esc(ln)}</tspan>`).join("")}</text>`;
      }
    }
    if (f.trigger) svg += `<text class="ftrigger" x="${pos[0].x + W / 2}" y="${pos[0].y - 8}" text-anchor="middle">▶ ${esc(trim(f.trigger, 48))}</text>`;
    boxes.forEach((b, i) => {
      const s = b.s, p = pos[i], k = kindOf(s), decision = String(s.kind || "").toLowerCase() === "decision";
      const end = s.end || !L.edges.some((e) => e.from === i);
      svg += `<g data-anchor="${esc(stepAnchor(f.id, s.id))}" data-label="${esc(`step ${i + 1} · ${trim(s.action, 50)}`)}"><title>${esc(`${i + 1}. ${s.where ? `${s.where}: ` : ""}${s.action}${s.tech ? ` (${s.tech})` : ""}${s.data ? ` · data: ${s.data}` : ""}`)}</title>
        <rect x="${p.x}" y="${p.y}" width="${W}" height="${b.h}" rx="${decision ? 18 : 8}" fill="var(--panel-2)" stroke="${k.color}" stroke-width="${end ? 2.5 : 1.5}" ${decision ? `stroke-dasharray="6 3"` : ""}/>
        <text class="fnum" x="${p.x + W - 10}" y="${p.y + 16}" text-anchor="end">${i + 1}</text>
        <text class="fwhere" x="${p.x + 12}" y="${p.y + 17}" style="fill:${k.color}">${k.icon} ${esc(trim(s.where || s.kind || "", 40))}</text>
        ${b.action.map((line, li) => `<text class="faction" x="${p.x + 12}" y="${p.y + 36 + li * 17}">${esc(line)}</text>`).join("")}
        ${b.meta.map((line, li) => `<text class="fmeta" x="${p.x + 12}" y="${p.y + 36 + b.action.length * 17 + 4 + li * 13}">${esc(line)}</text>`).join("")}
        ${end ? `<text class="fend" x="${p.x + W - 10}" y="${p.y + b.h - 7}" text-anchor="end">■ end</text>` : ""}</g>`;
    });
    el.innerHTML = svg + labels + "</svg>";
    mountPanZoom(el.closest(".pz"), { key: `${planId}:flow:${f.id}`, fit: "contain", minFit: 0.6, maxHeight: () => Math.min(innerHeight * 0.75, 760) });
  }
}
const x1Same = (a, b) => a.x === b.x;
