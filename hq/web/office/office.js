// The RedPi Office: an animated floor where the CEO and each worker are pixel
// people who walk, sit and type, wait at the door when they need you, and send
// envelopes to each other as messages flow.
//
// Engine pieces are ported from munder-difflin (MIT, Copyright (c) 2026 Chaitanya
// Giri) and, through it, shahar061/the-office (ISC): Camera (scene/office/Camera.ts),
// character walking/sitting/cheer (Character.ts, CharacterSprite.ts), tool and
// thinking bubbles (ToolBubble.ts, ThoughtBubble.ts), message envelopes
// (MessageEnvelope.ts), the lit desk screen (DeskScreen.ts), and the rule that a
// cheer needs real work behind it (CHEER_MIN_BUSY_MS). Rewritten for Canvas 2D.
// The room art, layout, and data mapping are original RedPi code.
import { buildMap, TILE } from "./map.js";
import { drawDynamic, drawItem, paintStatic, palette, SORTED } from "./tiles.js";
import { sceneFrames, SCENE_H, SCENE_W } from "./people.js";
import { findPath } from "./pathfinding.js";

const SPEED = 64;                 // px/sec (the original uses 48 on a smaller map)
const CHEER_MIN_BUSY_MS = 60_000; // no confetti for trivial work
const MAX_ENVELOPES = 16;
const SEAT_CROP = 9;              // legs hidden behind the desk while seated
const SIT_DROP = 6;
const motionOK = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
const TOOL_ICONS = { read: "<", edit: ">", write: ">", bash: "$", grep: "?", find: "?", ls: "?", glob: "?", redpi_browser: "@", web: "@" };
const KIND_COLOR = { chat: "#45e3ff", brief: "#b995ff", decision: "#ffc94d", system: "#ffc94d", task: "#3dff8f", command: "#ff4d5e", interrupt: "#ff4d5e" };

function toolIcon(tool) {
  const t = String(tool || "").toLowerCase();
  if (t.startsWith("redplan_")) return "✉";
  return TOOL_ICONS[t] || "*";
}

// ---------- camera (port of Camera.ts: fit, clamp, lerp, focus, manual pan) ----------
class Camera {
  constructor() { this.x = 0; this.y = 0; this.zoom = 1; this.tx = 0; this.ty = 0; this.tz = 1; this.vw = 800; this.vh = 500; this.mw = 640; this.mh = 480; this.manual = false; }
  setMap(w, h) { this.mw = w; this.mh = h; if (!this.manual) this.fit(true); }
  setView(w, h) { this.vw = w; this.vh = h; if (!this.manual) this.fit(true); }
  minZoom() { return Math.min(this.vw / this.mw, this.vh / this.mh); }
  fit(snap) { this.manual = false; this.tx = this.mw / 2; this.ty = this.mh / 2; this.tz = this.minZoom(); if (snap) { this.x = this.tx; this.y = this.ty; this.zoom = this.tz; } }
  focus(wx, wy, zoom) { this.manual = true; this.tx = wx; this.ty = wy; this.tz = Math.max(this.minZoom(), Math.min(6, zoom ?? Math.max(this.zoom, this.minZoom() * 1.8))); }
  pan(dx, dy) { this.manual = true; this.tx -= dx / this.zoom; this.ty -= dy / this.zoom; this.x = this.tx; this.y = this.ty; }
  zoomAt(factor, sx, sy) {
    this.manual = true;
    const wx = this.x + (sx - this.vw / 2) / this.zoom, wy = this.y + (sy - this.vh / 2) / this.zoom;
    this.tz = this.zoom = Math.max(this.minZoom(), Math.min(6, this.zoom * factor));
    this.tx = this.x = wx - (sx - this.vw / 2) / this.zoom; this.ty = this.y = wy - (sy - this.vh / 2) / this.zoom;
  }
  update() {
    const k = motionOK() ? 0.1 : 1;
    this.x += (this.tx - this.x) * k; this.y += (this.ty - this.y) * k; this.zoom += (this.tz - this.zoom) * k;
  }
  // Screen offset of the world origin, clamped so the map never drifts off-screen.
  offset() {
    let ox = this.vw / 2 - this.x * this.zoom, oy = this.vh / 2 - this.y * this.zoom;
    const sw = this.mw * this.zoom, sh = this.mh * this.zoom;
    ox = sw <= this.vw ? (this.vw - sw) / 2 : Math.min(0, Math.max(this.vw - sw, ox));
    oy = sh <= this.vh ? (this.vh - sh) / 2 : Math.min(0, Math.max(this.vh - sh, oy));
    return { ox, oy };
  }
  toWorld(sx, sy) { const { ox, oy } = this.offset(); return { x: (sx - ox) / this.zoom, y: (sy - oy) / this.zoom }; }
}

// ---------- bubble (port of ToolBubble/ThoughtBubble: fade in, linger, fade out, thinking dots) ----------
class Bubble {
  constructor() { this.text = ""; this.state = "hidden"; this.t = 0; this.alpha = 0; this.thinking = false; this.sticky = false; }
  show(text, { thinking = false, sticky = false } = {}) {
    this.thinking = thinking; this.sticky = sticky;
    this.text = text.length > 64 ? text.slice(0, 63) + "…" : text;
    if (this.state === "hidden" || this.state === "out") { this.state = "in"; this.t = 0; } else { this.state = "on"; this.alpha = 1; }
    this.t = 0;
  }
  linger() { if (this.state !== "hidden" && !this.sticky) { this.state = "linger"; this.t = 0; } }
  hide() { this.state = "hidden"; this.alpha = 0; }
  update(dt) {
    this.t += dt;
    if (this.state === "in") { this.alpha = Math.min(1, this.t / 0.15); if (this.alpha >= 1) this.state = "on"; }
    else if (this.state === "on" && !this.sticky && this.t > 4) this.linger();
    else if (this.state === "linger" && this.t > 2) { this.state = "out"; this.t = 0; }
    else if (this.state === "out") { this.alpha = Math.max(0, 1 - this.t / 0.3); if (this.alpha <= 0) this.hide(); }
  }
  draw(ctx, x, y, t, maxX = Infinity) {
    if (this.state === "hidden") return;
    const label = this.thinking ? ".".repeat(1 + (Math.floor(t / 0.5) % 3)) : this.text;
    ctx.font = "bold 5px monospace";
    const lines = wrap(ctx, label, 84);
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 6, h = lines.length * 6 + 4;
    // Keep the bubble inside the room so it never clips at the edges.
    const bx = Math.round(Math.max(2, Math.min(maxX - w - 2, x - w / 2))), by = Math.round(Math.max(2, y - h));
    ctx.globalAlpha = this.alpha * 0.95;
    ctx.fillStyle = "#0b1510"; roundRect(ctx, bx, by, w, h, 2); ctx.fill();
    ctx.fillStyle = "#0b1510"; ctx.fillRect(Math.round(x) - 1, by + h, 3, 2);
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = "#d9f7e3"; ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, bx + 3, by + 7 + i * 6));
    ctx.globalAlpha = 1;
  }
}

function wrap(ctx, text, max) {
  const out = []; let line = "";
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > max && line) { out.push(line); line = word; } else line = next;
    if (out.length === 2) break;
  }
  if (out.length < 2 && line) out.push(line);
  return out.length ? out : [""];
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- envelope (port of MessageEnvelope.ts: eased arc, bob, arrival burst) ----------
class Envelope {
  constructor(from, to, color) {
    this.sx = from.x; this.sy = from.y - 22; this.ex = to.x; this.ey = to.y - 22; this.color = color;
    this.dur = Math.min(2, Math.max(0.8, Math.hypot(this.ex - this.sx, this.ey - this.sy) / 230));
    this.t = 0; this.burst = -1; this.done = false;
  }
  update(dt) {
    if (this.burst < 0) { this.t += dt; if (this.t >= this.dur) this.burst = 0; }
    else { this.burst += dt; if (this.burst >= 0.34) this.done = true; }
  }
  draw(ctx) {
    if (this.burst >= 0) {
      const bt = Math.min(this.burst / 0.34, 1);
      ctx.globalAlpha = 1 - bt; ctx.strokeStyle = "#ffc94d"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(this.ex, this.ey, 3 + bt * 12, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      return;
    }
    const p = Math.min(this.t / this.dur, 1), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const x = this.sx + (this.ex - this.sx) * e, y = this.sy + (this.ey - this.sy) * e - 38 * Math.sin(Math.PI * e);
    ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.rotate(Math.sin(this.t * 6) * 0.12);
    ctx.globalAlpha = Math.min(1, this.t / 0.14, (1 - p) * this.dur / 0.22 + 0.001);
    ctx.fillStyle = this.color; ctx.fillRect(-7, -5, 14, 10);
    ctx.strokeStyle = "#0e1f15"; ctx.lineWidth = 1; ctx.strokeRect(-6.5, -4.5, 13, 9);
    ctx.beginPath(); ctx.moveTo(-6.5, -4.5); ctx.lineTo(0, 2); ctx.lineTo(6.5, -4.5); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }
}

// ---------- person (port of Character + CharacterSprite) ----------
class Person {
  constructor(office, id, name, role, tile) {
    Object.assign(this, { office, id, name, role });
    this.tile = { ...tile }; this.px = tile.x * TILE + 8; this.py = tile.y * TILE + 16;
    this.path = []; this.dir = "down"; this.walking = false; this.sitting = false; this.sitDx = 0;
    this.frameT = Math.random(); this.onArrive = null; this.alpha = 0; this.gone = false; this.leaving = false;
    this.mood = "ok"; this.glyph = null; this.bubble = new Bubble(); this.cheerT = -1; this.confetti = [];
    this.nextWander = 0; this.mode = null; this.context = null; this.busySince = 0; this.flash = 0;
  }
  goTo(tile, then) {
    this.onArrive = then || null;
    // On the first view people are already where they belong; later changes animate.
    if (!motionOK() || this.office.placing) { this.teleport(tile); return; }
    if (this.tile.x === tile.x && this.tile.y === tile.y) { this.arrive(); return; }
    const path = findPath(this.office.map, this.tile, tile);
    if (!path) { this.teleport(tile); return; }
    this.sitting = false; this.path = path; this.walking = true;
  }
  teleport(tile) { this.tile = { ...tile }; this.px = tile.x * TILE + 8; this.py = tile.y * TILE + 16; this.path = []; this.walking = false; this.arrive(); }
  arrive() { const cb = this.onArrive; this.onArrive = null; this.walking = false; if (cb) cb(); }
  sit(seat, dx = 0) { this.sitting = true; this.sitDx = dx; this.dir = seat.dir || "down"; }
  cheer() {
    if (!motionOK()) { this.flash = 1.2; return; }
    this.cheerT = 0; this.confetti = [];
    const colors = ["#3dff8f", "#ff4d5e", "#45e3ff", "#ffc94d", "#b995ff"];
    for (let i = 0; i < 14; i++) this.confetti.push({ x: (Math.random() - 0.5) * 8, y: -24 - Math.random() * 6, vx: (Math.random() - 0.5) * 46, vy: -30 - Math.random() * 40, c: colors[i % colors.length] });
  }
  update(dt) {
    this.frameT += dt;
    this.alpha = this.leaving ? Math.max(0, this.alpha - dt * 1.5) : Math.min(1, this.alpha + dt * 2);
    if (this.leaving && this.alpha === 0) this.gone = true;
    if (this.walking && this.path.length) {
      const next = this.path[0];
      const tx = next.x * TILE + 8, ty = next.y * TILE + 16;
      const dx = tx - this.px, dy = ty - this.py, dist = Math.hypot(dx, dy), step = SPEED * dt;
      this.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy < 0 ? "up" : "down";
      if (dist <= step) { this.px = tx; this.py = ty; this.tile = { ...next }; this.path.shift(); if (!this.path.length) this.arrive(); }
      else { this.px += (dx / dist) * step; this.py += (dy / dist) * step; }
    }
    if (this.cheerT >= 0) {
      this.cheerT += dt;
      for (const c of this.confetti) { c.vy += 120 * dt; c.x += c.vx * dt; c.y += c.vy * dt; }
      if (this.cheerT > 1.6) this.cheerT = -1;
    }
    if (this.flash > 0) this.flash -= dt;
    this.bubble.update(dt);
  }
  // Feet position, including the seated slide toward the desk.
  feet() { return { x: this.px + (this.sitting ? this.sitDx : 0), y: this.py + (this.sitting ? SIT_DROP : 0) }; }
  draw(ctx) {
    if (this.alpha <= 0) return;
    const frames = sceneFrames(this.name, this.role, this.mood);
    const set = this.dir === "up" ? frames.back : frames.front;
    const f = this.walking ? [0, 1, 2, 1][Math.floor(this.frameT * 8) % 4] : 0;
    const hop = this.cheerT >= 0 ? -Math.abs(Math.sin(this.cheerT * 9)) * 5 : 0;
    const { x, y } = this.feet();
    const cropH = this.sitting ? SCENE_H - SEAT_CROP : SCENE_H;
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(Math.round(x - 6), Math.round(y - 1), 12, 2);
    ctx.save();
    if (this.dir === "left") { ctx.translate(Math.round(x), 0); ctx.scale(-1, 1); ctx.translate(-Math.round(x), 0); }
    ctx.drawImage(set[f], 0, 0, SCENE_W, cropH, Math.round(x - SCENE_W / 2), Math.round(y - SCENE_H + hop), SCENE_W, cropH);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // Name tag, context gauge, status glyph, bubble, confetti: always on top.
  drawOverlay(ctx, t, selected) {
    if (this.alpha <= 0) return;
    const { x, y } = this.feet();
    const head = y - SCENE_H - 2;
    ctx.globalAlpha = this.alpha;
    ctx.font = "bold 5px monospace"; ctx.textAlign = "center";
    const w = Math.ceil(ctx.measureText(this.name).width) + 4;
    ctx.fillStyle = selected ? "#3dff8f" : "rgba(8,17,12,0.8)"; ctx.fillRect(Math.round(x - w / 2), Math.round(y + 1), w, 7);
    ctx.fillStyle = selected ? "#04130a" : "#d9f7e3"; ctx.fillText(this.name, Math.round(x), Math.round(y + 6));
    if (this.context && this.context.percent != null) {
      const pct = Math.max(0, Math.min(1, this.context.percent / 100));
      ctx.fillStyle = "rgba(8,17,12,0.8)"; ctx.fillRect(Math.round(x - 8), Math.round(y + 9), 16, 2);
      ctx.fillStyle = pct > 0.8 ? "#ff4d5e" : pct > 0.5 ? "#ffc94d" : "#3dff8f"; ctx.fillRect(Math.round(x - 8), Math.round(y + 9), Math.max(1, Math.round(16 * pct)), 2);
    }
    if (this.glyph) {
      const bob = motionOK() ? Math.round(Math.sin(t * 5) * 1.5) : 0;
      ctx.fillStyle = this.glyph.color; ctx.fillRect(Math.round(x - 4), Math.round(head - 10 + bob), 8, 9);
      ctx.fillStyle = "#04130a"; ctx.font = "bold 7px monospace"; ctx.fillText(this.glyph.text, Math.round(x), Math.round(head - 3 + bob));
    }
    if (this.flash > 0) { ctx.strokeStyle = "#3dff8f"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y - 16, 14, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = 1;
    this.bubble.draw(ctx, x, head - (this.glyph ? 12 : 1), t, this.office.map.W * TILE);
    if (this.cheerT >= 0) for (const c of this.confetti) { ctx.fillStyle = c.c; ctx.fillRect(Math.round(x + c.x), Math.round(y + c.y), 2, 2); }
  }
  hit(wx, wy) { const { x, y } = this.feet(); return this.alpha > 0.3 && wx >= x - 9 && wx <= x + 9 && wy >= y - SCENE_H && wy <= y + 8; }
}

// ---------- the office ----------
export class Office {
  constructor(root, { onSelect } = {}) {
    this.root = root; this.onSelect = onSelect || (() => {});
    this.canvas = document.createElement("canvas");
    this.canvas.className = "office-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.camera = new Camera();
    this.people = new Map(); this.envelopes = []; this.selected = null;
    this.map = null; this.staticLayer = null; this.theme = null; this.t = 0; this.last = 0;
    this.active = true; this.lastMsgId = null; this.prevTasks = new Map(); this.data = null; this.humanPing = 0;
    this.state = { monitors: new Map(), counts: {}, waiting: false, typing: new Set(), humanPing: 0 };
    new ResizeObserver(() => this.resize()).observe(root);
    this.resize();
    this.bindInput();
    document.addEventListener("visibilitychange", () => this.kick());
    this.kick();
  }

  setActive(on) { this.active = on; this.kick(); }
  kick() { if (!this.raf && this.active && !document.hidden) { this.last = performance.now(); this.raf = requestAnimationFrame((ts) => this.frame(ts)); } }

  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.vw = Math.max(200, r.width); this.vh = Math.max(200, r.height);
    this.canvas.width = Math.round(this.vw * dpr); this.canvas.height = Math.round(this.vh * dpr);
    this.canvas.style.width = `${this.vw}px`; this.canvas.style.height = `${this.vh}px`;
    this.dpr = dpr;
    this.camera.setView(this.vw, this.vh);
  }

  bindInput() {
    let drag = null, moved = false;
    this.canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; moved = false; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) { this.camera.pan(dx, dy); drag = { x: e.clientX, y: e.clientY }; }
    });
    this.canvas.addEventListener("pointerup", (e) => {
      drag = null;
      if (moved) return;
      const r = this.canvas.getBoundingClientRect();
      const w = this.camera.toWorld(e.clientX - r.left, e.clientY - r.top);
      const hitP = [...this.people.values()].filter((p) => p.hit(w.x, w.y)).sort((a, b) => b.py - a.py)[0];
      if (hitP) { this.selected = hitP.id; this.camera.focus(hitP.px, hitP.py - 16); this.onSelect(hitP.id); }
      else {
        const desk = this.map?.items.find((it) => it.type === "desk" && w.x >= it.x * TILE && w.x <= (it.x + it.w) * TILE && w.y >= it.y * TILE - 8 && w.y <= (it.y + 1) * TILE);
        const owner = desk && (desk.owner === "ceo" ? "ceo" : this.seatOwner.get(desk.owner));
        if (owner) { this.selected = owner; this.onSelect(owner); }
      }
    });
    this.canvas.addEventListener("dblclick", () => { this.selected = null; this.camera.fit(false); });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.camera.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  currentTheme() {
    const forced = document.documentElement.dataset.theme;
    return forced || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  }

  ensureMap(workerCount) {
    const pods = Math.max(1, Math.ceil(workerCount / 4));
    const theme = this.currentTheme();
    if (this.map && this.pods === pods && this.theme === theme) return;
    this.pods = pods; this.theme = theme;
    this.map = buildMap(workerCount);
    this.pal = palette(theme);
    this.staticLayer = paintStatic(this.map, this.pal);
    this.camera.setMap(this.map.W * TILE, this.map.H * TILE);
    // Existing people keep walking on the new map from where they stand.
    for (const p of this.people.values()) { p.path = []; p.walking = false; if (!this.map.isWalkable(p.tile.x, p.tile.y)) p.teleport(this.map.entry); }
  }

  person(id, name, role, startTile) {
    let p = this.people.get(id);
    if (!p) { p = new Person(this, id, name, role, startTile); this.people.set(id, p); }
    p.name = name; p.role = role; p.leaving = false; p.gone = false;
    return p;
  }

  seatPos(id) {
    const p = this.people.get(id);
    if (p) return p.feet();
    if (id === "human") return { x: this.map.you.x * TILE + 8, y: this.map.you.y * TILE + 14 };
    return null;
  }

  /** Feed the latest run state from HQ. */
  update(data) {
    this.data = data;
    this.placing = !this.placedOnce;
    this.placedOnce = true;
    const { run, workers, tasks, messages } = data;
    this.ensureMap(workers.length);
    const m = this.map;
    const now = Date.now();
    this.seatOwner = new Map(workers.map((w, i) => [i, w.id]));
    const monitors = new Map(), typing = new Set();
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const blockedBy = new Set(tasks.filter((t) => t.status === "blocked").map((t) => t.worker_id));

    // CEO: whiteboard while planning, desk while leading, meeting table when the run is done.
    const ceo = this.person("ceo", "CEO", "ceo", m.ceoSeat);
    const ceoMode = ["planning", "awaiting_approval"].includes(run.status) ? "board" : run.status === "done" ? "meeting" : "desk";
    if (ceo.mode !== ceoMode) {
      ceo.mode = ceoMode;
      if (ceoMode === "board") ceo.goTo(m.whiteboardSpot, () => { ceo.dir = "up"; });
      else if (ceoMode === "meeting") ceo.goTo(m.meetingSeats[0], () => { ceo.dir = "down"; ceo.cheer(); });
      else ceo.goTo(m.ceoSeat, () => ceo.sit(m.ceoSeat, 0));
    }
    ceo.glyph = run.status === "awaiting_approval" ? { text: "?", color: "#ffc94d" } : null;
    if (ceoMode === "board" && run.status === "awaiting_approval") ceo.bubble.show("Plan ready: approve it in HQ", { sticky: true });
    else if (ceo.bubble.sticky) { ceo.bubble.sticky = false; ceo.bubble.linger(); }
    monitors.set("ceo", ceoMode === "desk" ? "on" : "off");

    let waitIdx = 0;
    workers.forEach((w, i) => {
      const seat = m.seats[i];
      const p = this.person(w.id, w.name, w.role, m.entry);
      p.context = w.context;
      p.seatIndex = i;
      if (!w.alive || w.status === "stopped" || w.status === "failed") {
        if (p.mode !== "gone") { p.mode = "gone"; p.glyph = null; p.bubble.hide(); p.goTo(m.entry, () => { p.leaving = true; }); }
        monitors.set(i, "off");
        return;
      }
      const needs = w.needs_human || w.needs_input || w.parked || blockedBy.has(w.id);
      const mode = needs ? "wait" : w.status === "working" ? "work" : w.status === "starting" ? "arrive" : "idle";
      if (mode === "work" && !p.busySince) p.busySince = now;
      if (mode !== "work" && mode !== "idle") p.busySince = 0;
      p.mood = needs ? "blocked" : mode === "work" ? "working" : "ok";
      p.glyph = needs ? { text: "!", color: w.needs_human || w.needs_input ? "#ff4d5e" : "#ffc94d" } : null;
      if (needs) {
        const spot = m.waitSpots[waitIdx++ % m.waitSpots.length];
        if (p.mode !== "wait" || p.waitSpot !== spot) { p.mode = "wait"; p.waitSpot = spot; p.goTo(spot, () => { p.dir = "down"; }); }
        const why = w.needs_input?.reason || w.needs_human || (blockedBy.has(w.id) ? `Blocked: ${tasks.find((t) => t.worker_id === w.id && t.status === "blocked")?.note || ""}` : "Idle with open work");
        p.bubble.show(why, { sticky: true });
        monitors.set(i, "alert");
        return;
      }
      if (p.bubble.sticky) { p.bubble.sticky = false; p.bubble.linger(); }
      if (mode === "work" || mode === "arrive") {
        if (p.mode !== "work") { p.mode = "work"; p.goTo(seat, () => p.sit(seat, 0)); }
        monitors.set(i, mode === "work" && p.sitting ? "on" : "off");
        if (mode === "work") {
          typing.add(i);
          const act = w.activity;
          if (act?.at && act.at !== p.lastActivity) {
            p.lastActivity = act.at;
            if (now - act.at < 10000) p.bubble.show(`${toolIcon(act.tool || String(act.text).split(":")[0])} ${String(act.text || "").replace(/^[\w.-]+:\s*/, "")}`);
          }
        }
      } else {
        // A worker mid-visit (walked over to ask a question) finishes the visit first.
        if (p.mode !== "idle" && p.mode !== "visiting") { p.mode = "idle"; p.nextWander = this.t + 1 + Math.random() * 3; }
        monitors.set(i, "off");
      }
    });
    // Anyone no longer in the team walks out.
    for (const [id, p] of this.people) if (id !== "ceo" && !workers.some((w) => w.id === id) && p.mode !== "gone") { p.mode = "gone"; p.goTo(m.entry, () => { p.leaving = true; }); }

    // Messages: envelopes fly from sender to recipient; questions make idle senders walk over.
    const newest = messages.length ? messages[messages.length - 1].id : 0;
    if (this.lastMsgId === null) this.lastMsgId = newest;           // don't replay history on first load
    const fresh = messages.filter((msg) => msg.id > this.lastMsgId).slice(-6);
    this.lastMsgId = Math.max(this.lastMsgId, newest);
    for (const msg of fresh) this.onMessage(msg, workers);

    // Finished tasks: cheer, but only for real work (≥ 60s busy), as in the original.
    for (const t of tasks) {
      const prev = this.prevTasks.get(t.id);
      if (prev && prev !== "done" && t.status === "done") {
        const owner = this.people.get(t.worker_id);
        if (owner && owner.busySince && now - owner.busySince >= CHEER_MIN_BUSY_MS) owner.cheer();
        else if (owner) owner.flash = 1;
      }
      this.prevTasks.set(t.id, t.status);
    }
    this.state = { monitors, counts, typing, waiting: waitIdx > 0, humanPing: this.state.humanPing };
    this.placing = false;
    this.kick();
  }

  onMessage(msg, workers) {
    const from = msg.sender === "human" ? "human" : msg.sender;
    const targets = msg.recipient === "all" ? (msg.kind === "task" ? [] : workers.map((w) => w.id).filter((id) => id !== from).slice(0, 4)) : [msg.recipient];
    const color = msg.sender === "human" || msg.recipient === "human" || msg.kind === "interrupt" ? "#ff4d5e" : KIND_COLOR[msg.kind] || "#45e3ff";
    for (const to of targets) {
      const a = this.seatPos(from), b = this.seatPos(to);
      if (!a || !b) continue;
      if (to === "human") this.state.humanPing = 2.5;
      if (!motionOK()) { const p = this.people.get(to); if (p) p.flash = 1; continue; }
      if (this.envelopes.length < MAX_ENVELOPES) this.envelopes.push(new Envelope(a, b, color));
    }
    // A worker asking a teammate a question walks over to their desk if it is free to.
    const sender = this.people.get(from), target = this.people.get(msg.recipient);
    if (msg.kind === "chat" && sender && target && sender.mode === "idle" && /\?\s*$/.test(msg.body) && motionOK()) {
      const spot = { x: target.tile.x + 1, y: target.tile.y };
      if (this.map.isWalkable(spot.x, spot.y)) {
        sender.mode = "visiting";
        sender.bubble.show(`→ ${target.name}: ${msg.body}`);
        sender.goTo(spot, () => { sender.dir = "left"; setTimeout(() => { if (sender.mode === "visiting") sender.mode = null; }, 5000); });
      }
    }
  }

  // Idle people drift between the cafeteria, the meeting table, and open floor.
  wander(p) {
    if (p.mode !== "idle" || p.walking || this.t < p.nextWander) return;
    const m = this.map, r = Math.random();
    const spot = r < 0.4 ? m.cafeSeats[Math.floor(Math.random() * m.cafeSeats.length)] : r < 0.55 ? m.meetingSeats[Math.floor(Math.random() * m.meetingSeats.length)] : m.wander[Math.floor(Math.random() * m.wander.length)];
    p.goTo(spot, () => { if (spot.dir) p.dir = spot.dir; });
    p.nextWander = this.t + 12 + Math.random() * 18;
  }

  frame(ts) {
    this.raf = null;
    if (!this.active || document.hidden) return;           // paused while hidden: no background cost
    const dt = Math.min(0.05, (ts - this.last) / 1000); this.last = ts; this.t += dt;
    if (this.map) {
      if (this.theme !== this.currentTheme()) this.ensureMap(this.data?.workers.length || 0);
      for (const p of this.people.values()) {
        this.wander(p); p.update(dt);
        // Screens and "thinking" follow the live pose: lit only while actually seated at work.
        if (p.mode === "work" && p.seatIndex !== undefined) {
          this.state.monitors.set(p.seatIndex, p.sitting ? "on" : "off");
          if (p.sitting && p.bubble.state === "hidden" && Date.now() - (p.lastActivity || 0) > 8000) p.bubble.show("", { thinking: true });
        }
      }
      for (const [id, p] of this.people) if (p.gone) this.people.delete(id);
      for (const e of this.envelopes) e.update(dt);
      this.envelopes = this.envelopes.filter((e) => !e.done);
      if (this.state.humanPing > 0) this.state.humanPing -= dt;
      this.camera.update();
      this.draw();
    }
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  draw() {
    const { ctx, map, pal } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme === "light" ? "#dfe8e1" : "#050b08";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { ox, oy } = this.camera.offset();
    const z = this.camera.zoom * this.dpr;
    ctx.setTransform(z, 0, 0, z, ox * this.dpr, oy * this.dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.staticLayer, 0, 0);
    drawDynamic(ctx, map, pal, this.t, this.state);
    // Depth-sort furniture and people by their bottom edge so people sit behind desks.
    const s = { ...this.state, typing: false };
    const list = [];
    for (const it of map.items) if (SORTED.has(it.type)) list.push({ z: (it.y + it.h) * TILE, draw: () => drawItem(ctx, pal, it, this.t, { ...s, typing: this.state.typing.has(it.owner) }) });
    for (const p of this.people.values()) list.push({ z: p.feet().y - (p.sitting ? 1 : 0), draw: () => p.draw(ctx) });
    list.sort((a, b) => a.z - b.z);
    for (const d of list) d.draw();
    for (const p of this.people.values()) p.drawOverlay(ctx, this.t, p.id === this.selected);
    for (const e of this.envelopes) e.draw(ctx);
  }
}
