// Pan and zoom for diagrams bigger than their panel.
//   drag: move · Ctrl/⌘ + scroll, trackpad pinch, or two-finger pinch: zoom at the pointer
//   sideways scroll: move left/right (plain vertical scroll still scrolls the page)
//   keys (when focused): arrows move, + / − zoom, 0 fits
//   buttons: − / + / Fit / Expand (full-window view; Esc closes)
// The transform goes on the content element itself, so anything positioned inside it in
// percentages (comment pins) stays attached to the same spot at every zoom. getBoundingClientRect
// reports the transformed box, so click-to-pin maths needs no change either.
// A drag never turns into a click: pin mode and pin buttons only see real clicks.

const views = new Map(); // key → { s, x, y, user }: survives the page re-rendering the diagram
const MIN = 0.2, MAX = 4, DRAG = 4;

export function mountPanZoom(root, { key, fit = "contain", minFit = 0.4, maxHeight = () => Math.min(innerHeight * 0.7, 680) } = {}) {
  const stage = root.querySelector(".pz-stage");
  const content = stage.firstElementChild;
  const label = root.querySelector("[data-pz=zoom]");
  const saved = views.get(key);
  const v = { s: 1, x: 0, y: 0, user: false, all: false };
  views.set(key, v);
  const size = () => ({ w: content.offsetWidth, h: content.offsetHeight });

  function clamp() {
    const { w, h } = size(), vw = stage.clientWidth, vh = stage.clientHeight, m = 48;
    v.s = Math.min(MAX, Math.max(MIN, v.s));
    const cw = w * v.s, ch = h * v.s;
    // Keep some of the diagram on screen; a smaller-than-view diagram may sit anywhere inside.
    v.x = Math.min(Math.max(0, vw - cw) + m, Math.max(Math.min(0, vw - cw) - m, v.x));
    v.y = Math.min(Math.max(0, vh - ch) + m, Math.max(Math.min(0, vh - ch) - m, v.y));
  }
  function apply() {
    clamp();
    content.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    content.style.setProperty("--pz-inv", String(1 / v.s));
    if (label) label.textContent = `${Math.round(v.s * 100)}%`;
    const { w, h } = size();
    root.classList.toggle("pz-overflow", w * v.s > stage.clientWidth + 1 || h * v.s > stage.clientHeight + 1);
  }
  // Size the frame to the diagram (up to maxHeight), then fit: whole diagram ("contain") or
  // its width ("width", for tall charts that are read by scrolling down).
  // all: the whole diagram however small (Fit button, "0"); otherwise not below minFit, so text
  // stays readable when a page opens and the rest is a drag away.
  function fitView(all = false) {
    const { w, h } = size();
    if (!w || !h) return;
    const vw = stage.clientWidth;
    const expanded = root.classList.contains("pz-expanded");
    const maxH = expanded ? stage.clientHeight : maxHeight();
    let s = Math.min(1, vw / w, fit === "contain" ? maxH / h : Infinity);
    if (!all) s = Math.max(Math.min(minFit, 1), s);
    s = Math.max(MIN, s);
    if (!expanded) stage.style.height = `${Math.max(160, Math.min(maxH, h * s))}px`;
    v.s = s;
    v.x = Math.max(0, (vw - w * s) / 2);
    v.y = Math.max(0, (stage.clientHeight - h * s) / 2);
    v.user = false;
    v.all = all;
    apply();
  }
  function zoomAt(factor, cx, cy) {
    const r = stage.getBoundingClientRect();
    const px = cx === undefined ? r.width / 2 : cx - r.left, py = cy === undefined ? r.height / 2 : cy - r.top;
    const s = Math.min(MAX, Math.max(MIN, v.s * factor));
    v.x = px - (px - v.x) * (s / v.s);
    v.y = py - (py - v.y) * (s / v.s);
    v.s = s;
    v.user = true;
    apply();
  }
  const pan = (dx, dy) => { v.x += dx; v.y += dy; v.user = true; apply(); };

  // ---- pointers: one pointer drags, two pinch ----
  const pts = new Map();
  let start = null, moved = false, pinch = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("button, a, input, select, textarea")) { if (e.pointerType === "mouse") return; }
    else if (e.pointerType === "mouse") e.preventDefault(); // no text selection while dragging
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, id: e.pointerId }; moved = false; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: v.x, vy: v.y };
      moved = true;
    }
    root.focus({ preventScroll: true });
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const r = stage.getBoundingClientRect();
      const s = Math.min(MAX, Math.max(MIN, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const px = pinch.mx - r.left, py = pinch.my - r.top;
      v.x = px - (px - pinch.vx) * (s / pinch.s) + (mx - pinch.mx);
      v.y = py - (py - pinch.vy) * (s / pinch.s) + (my - pinch.my);
      v.s = s; v.user = true; apply();
      return;
    }
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < DRAG) return;
    if (!moved) { moved = true; root.classList.add("pz-dragging"); try { stage.setPointerCapture(e.pointerId); } catch {} }
    v.x = start.vx + dx; v.y = start.vy + dy; v.user = true; apply();
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) { start = null; root.classList.remove("pz-dragging"); }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  // Swallow the click that ends a drag, before pin mode or a pin button sees it.
  stage.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);

  // ---- wheel and trackpad ----
  stage.addEventListener("wheel", (e) => {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * unit * 0.0022), e.clientX, e.clientY); return; }
    const { w, h } = size();
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    const canX = w * v.s > stage.clientWidth, canY = h * v.s > stage.clientHeight;
    if (sideways && canX) { e.preventDefault(); pan(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit, 0); }
    else if (root.classList.contains("pz-expanded") && canY) { e.preventDefault(); pan(0, -e.deltaY * unit); }
  }, { passive: false });
  // Safari's trackpad pinch.
  let g0 = 1;
  stage.addEventListener("gesturestart", (e) => { e.preventDefault(); g0 = v.s; });
  stage.addEventListener("gesturechange", (e) => { e.preventDefault(); zoomAt((g0 * e.scale) / v.s, e.clientX, e.clientY); });

  // ---- keyboard and buttons ----
  root.addEventListener("keydown", (e) => {
    if (e.target.closest("textarea, input, select")) return;
    const k = e.key, step = 60;
    if (k === "+" || k === "=") zoomAt(1.2);
    else if (k === "-" || k === "_") zoomAt(1 / 1.2);
    else if (k === "0") fitView(true);
    else if (k === "ArrowLeft") pan(step, 0);
    else if (k === "ArrowRight") pan(-step, 0);
    else if (k === "ArrowUp") pan(0, step);
    else if (k === "ArrowDown") pan(0, -step);
    else if (k === "Escape" && root.classList.contains("pz-expanded")) { expand(false); e.stopPropagation(); }
    else return;
    e.preventDefault();
  });
  function expand(on) {
    root.classList.toggle("pz-expanded", on);
    document.body.classList.toggle("pz-lock", on);
    const b = root.querySelector("[data-pz=expand]");
    if (b) { b.textContent = on ? "Close" : "Expand"; b.setAttribute("aria-pressed", String(on)); }
    if (on) stage.style.height = "";
    requestAnimationFrame(() => fitView(on));
  }
  root.querySelectorAll("[data-pz]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const act = b.dataset.pz;
    if (act === "in") zoomAt(1.25);
    if (act === "out") zoomAt(1 / 1.25);
    if (act === "fit" || act === "zoom") fitView(true);
    if (act === "expand") expand(!root.classList.contains("pz-expanded"));
  }));

  new ResizeObserver(() => { if (!v.user) fitView(v.all); else apply(); }).observe(stage);
  // Size the frame first, then put back a view the person had moved to before the re-render.
  fitView();
  if (saved?.user) { Object.assign(v, saved); apply(); }
  return { fit: fitView, zoomAt, pan, state: () => ({ ...v }) };
}

// The frame around a diagram: a slim bar (hint + view buttons) above the stage, so the buttons
// never cover the diagram, and the stage the moving content goes inside.
export function panZoomFrame(name, inner) {
  const touch = matchMedia("(pointer: coarse)").matches;
  const hint = touch ? "Drag to move · pinch to zoom" : `Drag to move · ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} + scroll or pinch to zoom`;
  return `<div class="pz" tabindex="0" role="group" aria-label="${name}: drag to move, Ctrl or ⌘ plus scroll or pinch to zoom, arrow keys move, plus and minus zoom, 0 fits">
    <div class="pz-bar no-annotate">
      <span class="pz-hint">${hint}</span>
      <div class="pz-tools" role="toolbar" aria-label="${name} view">
        <button class="btn" type="button" data-pz="out" aria-label="Zoom out">−</button>
        <button class="btn pz-zoom" type="button" data-pz="zoom" title="Fit to view" aria-label="Fit to view">100%</button>
        <button class="btn" type="button" data-pz="in" aria-label="Zoom in">+</button>
        <button class="btn" type="button" data-pz="fit">Fit</button>
        <button class="btn" type="button" data-pz="expand" aria-pressed="false">Expand</button>
      </div>
    </div>
    <div class="pz-stage">${inner}</div>
  </div>`;
}
