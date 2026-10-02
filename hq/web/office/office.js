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
import { buildMap, department, TILE } from "./map.js";
import { drawDynamic, drawItem, drawLabels, paintStatic, palette, SORTED } from "./tiles.js";
import { sceneFrames, SCENE_H, SCENE_W } from "./people.js";
import { findPath } from "./pathfinding.js";

const SPEED = 64;                 // px/sec (the original uses 48 on a smaller map)
const RUN = 1.9;                  // errands for work are run, not walked
const CHEER_MIN_BUSY_MS = 60_000; // no confetti for trivial work
const MAX_ENVELOPES = 16;
const SEAT_CROP = 9;              // legs hidden behind the desk while seated
const SIT_DROP = 6;
const motionOK = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
const TOOL_ICONS = { read: "<", edit: ">", write: ">", bash: "$", grep: "?", find: "?", ls: "?", glob: "?", redpi_browser: "@", web: "@" };
const STATUS_DOT = { work: "#3ddc84", board: "#3ddc84", desk: "#3ddc84", wait: "#ff4d5e", idle: "#ffc94d", rest: "#8fa2ff", gone: "#9aa1ad" };
const KIND_COLOR = { aside: "#f0a6ff", chat: "#45e3ff", brief: "#b995ff", decision: "#ffc94d", system: "#ffc94d", task: "#3dff8f", command: "#ff4d5e", interrupt: "#ff4d5e" };

// Where work happens: looking things up sends a person to the files room, builds and
// tests to the servers, writing code back to their desk.
const RESEARCH_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "redpi_jevgrep"]);
const SERVER_CMD = /\b(test|tests|build|install|npm|npx|pnpm|yarn|bun|make|docker|compose|cargo|pytest|tsc|deploy|kubectl|terraform|ssh|migrate|go (build|test|run)|git push)\b/;
const RESEARCH_CMD = /^\s*(cd|ls|tree|find|fd|grep|rg|ag|jg|cat|head|tail|less|wc|git (log|show|grep|blame|diff|status))\b/;
export function activityKind(act) {
  const tool = String(act?.tool || String(act?.text || "").split(":")[0]).toLowerCase();
  if (RESEARCH_TOOLS.has(tool)) return "research";
  if (tool === "edit" || tool === "write") return "code";
  if (tool === "bash") {
    const cmd = String(act?.text || "").replace(/^bash:\s*/i, "");
    if (SERVER_CMD.test(cmd)) return "server";
    if (RESEARCH_CMD.test(cmd)) return "research";
  }
  return "other";
}

// A tool call still running after this long means the person is waiting on it (a build,
// docker, a test suite, a background job): they wait in the cafeteria with a coffee.
const WAIT_AFTER_MS = 20_000;
export function isWaiting(act, now = Date.now()) {
  if (!act?.at || act.endedAt || now - act.at < WAIT_AFTER_MS || now - act.at > 6 * 3600_000) return false;
  const tool = String(act.tool || String(act.text || "").split(":")[0]).toLowerCase();
  return tool === "bash" || tool === "redpi_job" || /^waiting on/i.test(String(act.text || ""));
}

function toolIcon(tool) {
  const t = String(tool || "").toLowerCase();
  if (t.startsWith("redplan_")) return "✉";
  return TOOL_ICONS[t] || "*";
}

// ---------- camera (port of Camera.ts: fit, clamp, lerp, focus, manual pan) ----------
// As in WorkAdventure's camera, the view is bounded by the world and can never zoom out past
// the point where the world fills it, so there is never empty space around the map. "Fit"
// frames the building (the park around it fills the rest of the view).
class Camera {
  constructor() { this.x = 0; this.y = 0; this.zoom = 1; this.tx = 0; this.ty = 0; this.tz = 1; this.vw = 800; this.vh = 500; this.mw = 640; this.mh = 480; this.home = null; this.manual = false; }
  setMap(w, h, home) { this.mw = w; this.mh = h; this.home = home || { x: 0, y: 0, w, h }; if (!this.manual) this.fit(true); else this.clampZoom(); }
  setView(w, h) { this.vw = w; this.vh = h; if (!this.manual) this.fit(true); else this.clampZoom(); }
  minZoom() { return Math.max(this.vw / this.mw, this.vh / this.mh); }
  fitZoom() {
    const h = this.home || { w: this.mw, h: this.mh };
    return Math.max(this.minZoom(), Math.min(4, Math.min(this.vw / (h.w + TILE), this.vh / (h.h + TILE))));
  }
  clampZoom() { const lo = this.minZoom(); if (this.tz < lo) this.tz = lo; if (this.zoom < lo) this.zoom = lo; }
  fit(snap) {
    const h = this.home || { x: 0, y: 0, w: this.mw, h: this.mh };
    this.manual = false; this.tx = h.x + h.w / 2; this.ty = h.y + h.h / 2; this.tz = this.fitZoom();
    if (snap) { this.x = this.tx; this.y = this.ty; this.zoom = this.tz; }
  }
  focus(wx, wy, zoom) { this.manual = true; this.tx = wx; this.ty = wy; this.tz = Math.max(this.minZoom(), Math.min(6, zoom ?? Math.max(this.zoom, this.fitZoom() * 1.8))); }
  pan(dx, dy) { this.manual = true; this.tx -= dx / this.zoom; this.ty -= dy / this.zoom; this.x = this.tx; this.y = this.ty; }
  zoomAt(factor, sx, sy) {
    this.manual = true;
    const { ox, oy } = this.offset();
    const wx = (sx - ox) / this.zoom, wy = (sy - oy) / this.zoom;
    this.tz = this.zoom = Math.max(this.minZoom(), Math.min(6, this.zoom * factor));
    this.tx = this.x = wx - (sx - this.vw / 2) / this.zoom; this.ty = this.y = wy - (sy - this.vh / 2) / this.zoom;
  }
  update() {
    const k = motionOK() ? 0.1 : 1;
    this.x += (this.tx - this.x) * k; this.y += (this.ty - this.y) * k; this.zoom = Math.max(this.minZoom(), this.zoom + (this.tz - this.zoom) * k);
  }
  // Screen offset of the world origin, clamped so the view never leaves the world.
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
  constructor() { this.text = ""; this.state = "hidden"; this.t = 0; this.alpha = 0; this.thinking = false; this.talk = false; this.sticky = false; }
  show(text, { thinking = false, talk = false, sticky = false } = {}) {
    this.thinking = thinking; this.talk = talk; this.sticky = sticky;
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
    const label = this.thinking || this.talk ? ".".repeat(1 + (Math.floor(t / (this.talk ? 0.3 : 0.5)) % 3)) : this.text;
    ctx.font = "600 5px system-ui, sans-serif";
    const lines = wrap(ctx, label, 90);
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 8, h = lines.length * 6 + 5;
    // Keep the bubble inside the room so it never clips at the edges.
    const bx = Math.round(Math.max(2, Math.min(maxX - w - 2, x - w / 2))), by = Math.round(Math.max(2, y - h));
    // Speech is a white bubble; tool activity and thinking are dark, so made-up small talk
    // (dots only) never looks like real text.
    const speech = this.talk || /^[“→]/.test(this.text);
    const bg = speech ? "#ffffff" : "#262b38";
    ctx.globalAlpha = this.alpha * 0.96;
    ctx.fillStyle = "rgba(20,24,40,0.18)"; roundRect(ctx, bx, by + 1, w, h, 3); ctx.fill();
    ctx.fillStyle = bg; roundRect(ctx, bx, by, w, h, 3); ctx.fill();
    ctx.beginPath(); ctx.moveTo(Math.round(x) - 2, by + h - 0.5); ctx.lineTo(Math.round(x) + 2, by + h - 0.5); ctx.lineTo(Math.round(x), by + h + 2.5); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = speech ? "#2b3040" : "#f1f3f8"; ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, bx + 4, by + 7.5 + i * 6));
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
    this.running = false; this.errand = null; this.claim = null; this.restlessAt = 0; this.dust = []; this.dustT = 0;
    this.pose = null;   // { prop: "coffee" | "book" | "controller" | "dumbbell", treadmill, game } while at a spot
  }
  goTo(tile, then, { run = false } = {}) {
    this.onArrive = then || null; this.running = run;
    // On the first view people are already where they belong; later changes animate.
    if (!motionOK() || this.office.placing) { this.teleport(tile); return; }
    if (this.tile.x === tile.x && this.tile.y === tile.y) { this.arrive(); return; }
    const path = findPath(this.office.map, this.tile, tile);
    if (!path) { this.teleport(tile); return; }
    this.sitting = false; this.path = path; this.walking = true;
  }
  teleport(tile) { this.tile = { ...tile }; this.px = tile.x * TILE + 8; this.py = tile.y * TILE + 16; this.path = []; this.walking = false; this.arrive(); }
  arrive() { const cb = this.onArrive; this.onArrive = null; this.walking = false; this.running = false; if (cb) cb(); }
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
      const dx = tx - this.px, dy = ty - this.py, dist = Math.hypot(dx, dy), step = SPEED * (this.running ? RUN : 1) * dt;
      this.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy < 0 ? "up" : "down";
      if (dist <= step) { this.px = tx; this.py = ty; this.tile = { ...next }; this.path.shift(); if (!this.path.length) this.arrive(); }
      else { this.px += (dx / dist) * step; this.py += (dy / dist) * step; }
    }
    // Running kicks up little puffs behind the feet.
    if (this.walking && this.running) {
      this.dustT += dt;
      if (this.dustT > 0.09) { this.dustT = 0; this.dust.push({ x: this.px + (Math.random() - 0.5) * 4, y: this.py - 1, life: 0.35 }); }
    }
    for (const d of this.dust) { d.life -= dt; d.y -= dt * 6; }
    if (this.dust.length) this.dust = this.dust.filter((d) => d.life > 0);
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
    const step = Math.floor(this.frameT * (this.running ? 14 : 8)) % 4;
    const onTreadmill = this.pose?.treadmill && !this.walking && motionOK();
    const f = this.walking || onTreadmill ? [0, 1, 2, 1][onTreadmill ? Math.floor(this.frameT * 7) % 4 : step] : 0;
    const hop = this.cheerT >= 0 ? -Math.abs(Math.sin(this.cheerT * 9)) * 5 : this.walking && this.running && step % 2 ? -1 : 0;
    const { x, y } = this.feet();
    const cropH = this.sitting ? SCENE_H - SEAT_CROP : SCENE_H;
    for (const d of this.dust) { ctx.globalAlpha = this.alpha * (d.life / 0.35) * 0.6; ctx.fillStyle = "#b9c9bf"; ctx.fillRect(Math.round(d.x - 1), Math.round(d.y - 1), 2, 2); }
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(Math.round(x - 6), Math.round(y - 1), 12, 2);
    ctx.save();
    if (this.dir === "left") { ctx.translate(Math.round(x), 0); ctx.scale(-1, 1); ctx.translate(-Math.round(x), 0); }
    ctx.drawImage(set[f], 0, 0, SCENE_W, cropH, Math.round(x - SCENE_W / 2), Math.round(y - SCENE_H + hop), SCENE_W, cropH);
    ctx.restore();
    if (this.pose?.prop && !this.walking && this.dir !== "up") this.drawProp(ctx, Math.round(x), Math.round(y));
    ctx.globalAlpha = 1;
  }
  // What they hold: a coffee (sipped now and then), a book (pages turn), a game
  // controller (thumbs busy), or dumbbells (curled up and down).
  drawProp(ctx, x, y) {
    const t = this.frameT, move = motionOK();
    const P = (c, px, py, w = 1, h = 1) => { ctx.fillStyle = c; ctx.fillRect(px, py, w, h); };
    const prop = this.pose.prop;
    if (prop === "coffee") {
      const sip = move && (t % 5) > 4.1;
      const cx = sip ? x + 1 : x + 5, cy = sip ? y - 21 : y - 13;
      P("#f2ede2", cx, cy, 4, 4); P("#6b3f22", cx, cy, 4, 1); P("#f2ede2", cx + 4, cy + 1, 1, 2);
      if (!sip && move) { const ph = (t * 0.7) % 1; ctx.globalAlpha *= 0.6 * (1 - ph); P("#d7e2dc", cx + 1 + Math.round(Math.sin(t * 3)), cy - 2 - ph * 5, 1, 2); ctx.globalAlpha = this.alpha; }
    } else if (prop === "book") {
      const flip = move && (t % 6) > 5.6;
      P("#3e7cb8", x - 5, y - 15, 10, 6); P("#f2ede2", x - 4, y - 15, 4, 5); P("#e6dfcf", x, y - 15, 4, 5);
      P("#9aa39d", x - 3, y - 13, 2, 1); P("#9aa39d", x + 1, y - 13, 2, 1);
      if (flip) P("#ffffff", x - 1, y - 17, 2, 6);
    } else if (prop === "controller") {
      const b = move ? Math.round(Math.sin(t * 9)) : 0;
      P("#1c1f24", x - 4, y - 13 + b, 8, 3); P("#ff4d5e", x + 2, y - 13 + b, 1, 1); P("#45e3ff", x - 3, y - 12 + b, 1, 1);
    } else if (prop === "paddle") {
      const swing = move ? Math.round(Math.sin(t * 5.03) * 2) : 0;
      P("#d6453f", x + 4, y - 15 + swing, 4, 4); P("#7a4a2a", x + 5, y - 11 + swing, 2, 2);
    } else if (prop === "dumbbell") {
      const up = move ? Math.round((Math.sin(t * 3) + 1) * 4) : 0;
      for (const sx of [-8, 6]) { P("#8a979e", x + sx, y - 12 - up, 3, 1); P("#111", x + sx - 1, y - 13 - up, 1, 3); P("#111", x + sx + 3, y - 13 - up, 1, 3); }
    }
  }
  // Name tag, context gauge, status glyph, bubble, confetti: always on top.
  drawOverlay(ctx, t, selected) {
    if (this.alpha <= 0) return;
    const { x, y } = this.feet();
    const head = y - SCENE_H - 2;
    ctx.globalAlpha = this.alpha;
    // Name tag (a dark pill with a status dot), as in Gather and WorkAdventure.
    ctx.font = "600 5px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const w = Math.ceil(ctx.measureText(this.name).width) + 11, tx = Math.round(x - w / 2), ty = Math.round(y + 1);
    ctx.fillStyle = selected ? "#2f6fd6" : "rgba(32,36,48,0.86)"; roundRect(ctx, tx, ty, w, 7, 3.5); ctx.fill();
    ctx.fillStyle = STATUS_DOT[this.mode] || STATUS_DOT.idle; ctx.beginPath(); ctx.arc(tx + 4, ty + 3.5, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.fillText(this.name, Math.round(x + 2.5), ty + 3.8);
    ctx.textBaseline = "alphabetic";
    if (this.context && this.context.percent != null) {
      const pct = Math.max(0, Math.min(1, this.context.percent / 100));
      ctx.fillStyle = "rgba(32,36,48,0.6)"; ctx.fillRect(Math.round(x - 8), Math.round(y + 9), 16, 2);
      ctx.fillStyle = pct > 0.8 ? "#ff4d5e" : pct > 0.5 ? "#ffc94d" : "#3dff8f"; ctx.fillRect(Math.round(x - 8), Math.round(y + 9), Math.max(1, Math.round(16 * pct)), 2);
    }
    if (this.glyph) {
      const bob = motionOK() ? Math.round(Math.sin(t * 5) * 1.5) : 0;
      ctx.fillStyle = this.glyph.color; ctx.fillRect(Math.round(x - 4), Math.round(head - 10 + bob), 8, 9);
      ctx.fillStyle = "#1d2130"; ctx.font = "800 7px system-ui, sans-serif"; ctx.fillText(this.glyph.text, Math.round(x), Math.round(head - 3 + bob));
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
    root.office = this;                       // tests read positions from the host element
    this.ctx = this.canvas.getContext("2d");
    this.camera = new Camera();
    this.people = new Map(); this.envelopes = []; this.selected = null;
    this.map = null; this.staticLayer = null; this.theme = null; this.t = 0; this.last = 0;
    this.active = true; this.lastMsgId = null; this.prevTasks = new Map(); this.data = null; this.humanPing = 0;
    this.claims = new Map(); this.meetings = []; this.nextSocial = 10;
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

  ensureMap(workers) {
    const roles = workers.map((w) => w.role || "");
    const key = roles.map((r) => department(r)).join(",");
    const theme = this.currentTheme();
    if (this.map && this.layoutKey === key && this.theme === theme) return;
    const relayout = this.layoutKey !== key;
    this.layoutKey = key; this.theme = theme;
    if (relayout || !this.map) this.map = buildMap(roles);
    this.pal = palette(theme);
    this.staticLayer = paintStatic(this.map, this.pal);
    const b = this.map.building;
    this.camera.setMap(this.map.W * TILE, this.map.H * TILE, { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE });
    if (!relayout) return;
    // Existing people keep walking on the new map from where they stand.
    this.claims.clear(); this.meetings = [];
    for (const p of this.people.values()) {
      p.errand = null; p.claim = null; p.path = []; p.walking = false;
      if (!this.map.isWalkable(p.tile.x, p.tile.y)) p.teleport(this.map.entry);
      if (p.mode && p.mode !== "gone") this.goHome(p);
    }
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

  // ---------- errands: short trips away from home (files, servers, coffee, meetings) ----------
  claimKey(spot) { return `${spot.x},${spot.y}`; }
  release(p) { if (p.claim && this.claims.get(p.claim) === p.id) this.claims.delete(p.claim); p.claim = null; }
  // A random spot from the list that nobody else is using or heading to.
  pick(list, p) {
    const free = (list || []).filter((sp) => { const o = this.claims.get(this.claimKey(sp)); return !o || o === p.id; });
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }
  errand(p, kind, spot, stay, extra = {}) {
    if (!spot || !motionOK() || this.placing || p.leaving) return false;
    if (p.errand) this.endErrand(p, false);
    this.release(p);
    p.claim = this.claimKey(spot); this.claims.set(p.claim, p.id);
    const e = p.errand = { kind, spot, stay, arrived: false, until: this.t + 40, ...extra };
    p.sitting = false; p.pose = null;
    p.goTo(spot, () => {
      if (p.errand !== e) return;
      e.arrived = true; e.until = this.t + e.stay;
      if (spot.dir) p.dir = spot.dir;
      if (e.sit) p.sit(spot, 0);
      if (e.pose) p.pose = e.pose;
      e.onArrive?.();
    }, { run: true });
    return true;
  }
  endErrand(p, goHome = true) {
    const e = p.errand;
    if (!e) return;
    p.errand = null; this.release(p); p.pose = null;
    if (e.meeting) e.meeting.members.delete(p.id);
    if (e.partner?.errand?.social && e.partner.errand.social === e.social) this.endErrand(e.partner);
    if (goHome) this.goHome(p);
  }
  // Hold a spot without an errand (placing people on first load, or with reduced motion),
  // so nobody else is sent to the same seat.
  hold(p, spot) {
    this.release(p);
    p.claim = this.claimKey(spot); this.claims.set(p.claim, p.id);
  }
  // Nothing left to do: the recreation room, a free spot at random (games, gym or a book),
  // moving on to another now and then. Falls back to the lounge when every spot is taken.
  goRest(p, fresh = false) {
    const m = this.map, sp = this.pick(m.recSpots, p);
    if (!sp) { p.nextWander = this.t + 2 + Math.random() * 4; return; }
    const pose = { prop: sp.prop, treadmill: !!sp.treadmill, game: !!sp.game };
    if (this.errand(p, "rec", sp, 25 + Math.random() * 30, { sit: !!sp.sit, pose, onArrive: () => { if (fresh) p.cheer(); } })) return;
    this.hold(p, sp);
    p.goTo(sp, () => { p.dir = sp.dir; if (sp.sit) p.sit(sp, 0); p.pose = pose; });
  }
  // Where a person belongs when not on an errand.
  goHome(p, fresh = false) {
    const m = this.map;
    if (p.mode !== "rest" && p.claim && !p.errand) this.release(p);
    if (p.id === "ceo") {
      if (p.mode === "board") p.goTo(m.whiteboardSpot, () => { p.dir = "up"; });
      else if (p.mode === "rest") this.goRest(p, fresh);
      else p.goTo(m.ceoSeat, () => { p.sit(m.ceoSeat, 0); p.restlessAt = this.t + 30 + Math.random() * 40; });
      return;
    }
    if (p.mode === "work") {
      const seat = m.seats[p.seatIndex];
      p.goTo(seat, () => { p.sit(seat, 0); p.restlessAt = this.t + 18 + Math.random() * 27; }, { run: !fresh });
    } else if (p.mode === "wait") p.goTo(p.waitSpot, () => { p.dir = "down"; }, { run: true });
    else if (p.mode === "rest") this.goRest(p, fresh);
    else if (p.mode === "idle") p.nextWander = this.t + 1 + Math.random() * 3;
  }
  // Waiting on a long command: a seat in the cafeteria with a coffee until it finishes.
  goBrew(p) {
    const sp = this.pick(this.map.cafeSeats, p);
    if (!sp) return false;
    const act = p.act;
    return this.errand(p, "brew", sp, 6 * 3600, { sit: true, pose: { prop: "coffee" }, onArrive: () => p.bubble.show(`☕ waiting on ${String(act?.text || "a command").replace(/^[\w.-]+:\s*/, "").slice(0, 60)}`) });
  }
  // Live tool activity decides where a working person is: the files room while looking
  // things up, the servers while building or testing, their desk while writing code.
  onActivity(p, act) {
    if (p.errand?.kind === "meeting" || p.errand?.kind === "terminal" || p.errand?.kind === "brew") return;
    const kind = activityKind(act), m = this.map;
    if (kind === "research" || kind === "server") {
      const k = kind === "research" ? "files" : "servers", stay = kind === "research" ? 9 : 8;
      if (p.errand?.kind === k) { p.errand.stay = stay; if (p.errand.arrived) p.errand.until = this.t + stay; return; }
      // Builds and tests only sometimes take a trip; the rest run from the desk.
      if (k === "servers" && Math.random() < 0.35) return;
      this.errand(p, k, this.pick(k === "files" ? m.fileSpots : m.serverSpots, p), stay);
    } else if (kind === "code" && p.errand) this.endErrand(p);   // back to the desk to type
  }
  // Talking happens in the meeting room: the speaker and listeners walk there and sit
  // facing each other, and the speaker's bubble shows the real message.
  meet(sender, listeners, text) {
    const avail = (p) => p && !p.leaving && ["work", "idle", "rest", "desk", "board"].includes(p.mode) && !["terminal", "brew"].includes(p.errand?.kind);
    if (!avail(sender)) return false;
    const current = sender.errand?.meeting;
    if (current && listeners.every((l) => current.members.has(l.id))) {
      current.until = Math.max(current.until, this.t + 8);
      sender.bubble.show(text);
      return true;
    }
    if (current) return false;
    const people = [sender, ...listeners.filter((l) => avail(l) && !l.errand?.meeting)].slice(0, 8);
    if (people.length < 2) return false;
    // Facing pairs come first in meetingSeats, so a two-person talk sits across the table.
    const seats = [], all = this.map.meetingSeats;
    for (let i = 0; i + 1 < all.length && seats.length < people.length; i += 2) {
      const pair = [all[i], all[i + 1]].filter((sp) => !this.claims.get(this.claimKey(sp)));
      if (pair.length === 2 || people.length - seats.length === 1) seats.push(...pair);
    }
    if (seats.length < people.length) return false;
    const meeting = { members: new Set(people.map((p) => p.id)), until: this.t + 40, arrived: 0 };
    this.meetings.push(meeting);
    people.forEach((p, i) => this.errand(p, "meeting", seats[i], 8, {
      meeting, sit: true,
      onArrive: () => {
        meeting.arrived++;
        if (p === sender) p.bubble.show(text);
        // Everyone seated: the talk runs a few seconds, longer for longer messages.
        if (meeting.arrived >= meeting.members.size) meeting.until = this.t + Math.min(14, 7 + text.length / 30);
      },
    }));
    return true;
  }
  // Idle teammates chat over coffee now and then (a dots bubble, never made-up text).
  social() {
    if (this.t < this.nextSocial) return;
    this.nextSocial = this.t + 14 + Math.random() * 20;
    const idle = [...this.people.values()].filter((p) => p.mode === "idle" && !p.errand && !p.walking && !p.leaving);
    if (idle.length < 2) return;
    const [a, b] = idle.sort(() => Math.random() - 0.5);
    const c = this.map.cafeSeats;
    const pair = [[c[0], c[2]], [c[4], c[5]]].find((pr) => pr.every((sp) => !this.claims.get(this.claimKey(sp))));
    if (!pair) return;
    const social = {}, stay = 8 + Math.random() * 6;
    this.errand(a, "chat", pair[0], stay, { social, partner: b, onArrive: () => a.bubble.show("", { talk: true }) });
    this.errand(b, "chat", pair[1], stay, { social, partner: a, onArrive: () => b.bubble.show("", { talk: true }) });
  }
  // Per frame: finish errands, and don't let anyone sit in one place for too long.
  think(p) {
    const e = p.errand;
    // Waiting on a long command: off to the cafeteria; back to the desk when it is done.
    if (p.mode === "work" && p.id !== "ceo") {
      const waiting = isWaiting(p.act);
      if (waiting && e?.kind !== "brew" && !["meeting", "terminal"].includes(e?.kind) && !p.walking && motionOK() && !this.placing) { if (this.goBrew(p)) return; }
      if (!waiting && e?.kind === "brew") { if (p.bubble.state !== "hidden") p.bubble.linger(); this.endErrand(p); return; }
    }
    if (e) {
      if (this.t >= (e.meeting ? e.meeting.until : e.until)) {
        if (p.bubble.talk) p.bubble.linger();
        this.endErrand(p);
      }
      return;
    }
    if (p.walking || !motionOK()) return;
    const m = this.map;
    if ((p.mode === "idle" || (p.mode === "rest" && !p.claim)) && this.t >= p.nextWander) {
      if (p.mode === "rest") { this.goRest(p); if (p.errand) return; }
      const r = Math.random();
      const [list, sit] = r < 0.35 ? [m.cafeSeats, true] : r < 0.45 ? [[m.coffeeSpot], false] : r < 0.55 ? [m.windowSpots, false] : [m.wander, false];
      const spot = this.pick(list, p);
      if (spot) this.errand(p, "lounge", spot, 8 + Math.random() * 12, { sit });
      p.nextWander = this.t + 8 + Math.random() * 12;
    }
    // Restless at the desk: a quick trip to the servers, the coffee machine, the
    // window, the files, or a working teammate's desk, then back to typing.
    const atDesk = p.sitting && ((p.mode === "work" && p.seatIndex !== undefined) || (p.id === "ceo" && p.mode === "desk"));
    if (atDesk && this.t >= p.restlessAt) {
      p.restlessAt = this.t + 8;
      const r = Math.random();
      if (r < 0.15) {
        const mate = [...this.people.values()].find((o) => o !== p && o.mode === "work" && o.sitting && !o.errand && o.seatIndex !== undefined);
        const seat = mate && m.seats[mate.seatIndex];
        const spot = seat && { x: seat.x + 1, y: seat.y, dir: "left" };
        if (spot && m.isWalkable(spot.x, spot.y) && this.errand(p, "visit", spot, 5, { onArrive: () => { p.bubble.show("", { talk: true }); mate.bubble.show("", { talk: true }); } })) return;
      }
      const [kind, list, stay] = r < 0.5 ? ["servers", m.serverSpots, 4 + Math.random() * 3] : r < 0.72 ? ["coffee", [m.coffeeSpot], 4] : r < 0.87 ? ["window", m.windowSpots, 3 + Math.random() * 2] : ["files", m.fileSpots, 4];
      this.errand(p, kind, this.pick(list, p), stay);
    }
  }

  /** Feed the latest run state from HQ. */
  update(data) {
    this.data = data;
    this.placing = !this.placedOnce;
    this.placedOnce = true;
    const { run, workers, tasks, messages } = data;
    this.ensureMap(workers);
    const m = this.map;
    const now = Date.now();
    this.seatOwner = new Map(workers.map((w, i) => [i, w.id]));
    const monitors = new Map(), typing = new Set();
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    // Only people blocked on you queue at the "needs you" mat; blocks on teammates are the team's to clear.
    const blockedBy = new Set(tasks.filter((t) => t.status === "blocked" && (t.blocked_on === "human" || t.blocked_on === undefined)).map((t) => t.worker_id));

    // CEO: whiteboard while planning, desk while leading, the recreation room once the run is done.
    const ceo = this.person("ceo", "CEO", "ceo", m.ceoSeat);
    const ceoMode = ["planning", "awaiting_approval"].includes(run.status) ? "board" : run.status === "done" ? "rest" : "desk";
    if (ceo.mode !== ceoMode) {
      const was = ceo.mode;
      ceo.mode = ceoMode;
      if (ceo.errand?.kind !== "meeting") { this.endErrand(ceo, false); this.goHome(ceo, was !== null && ceoMode === "rest"); }
    }
    ceo.glyph = run.status === "awaiting_approval" ? { text: "?", color: "#ffc94d" } : null;
    if (ceoMode === "board" && run.status === "awaiting_approval") ceo.bubble.show("Plan ready: approve it in HQ", { sticky: true });
    else if (ceo.bubble.sticky) { ceo.bubble.sticky = false; ceo.bubble.linger(); }
    monitors.set("ceo", ceoMode === "desk" ? "on" : "off");

    let waitIdx = 0;
    workers.forEach((w, i) => {
      const p = this.person(w.id, w.name, w.role, m.entry);
      p.context = w.context;
      p.seatIndex = i;
      if (!w.alive || w.status === "stopped" || w.status === "failed") {
        if (p.mode !== "gone") { this.endErrand(p, false); p.mode = "gone"; p.glyph = null; p.bubble.hide(); p.goTo(m.exit || m.entry, () => { p.leaving = true; }); }
        monitors.set(i, "off");
        return;
      }
      const needs = w.needs_human || w.needs_input || w.parked || blockedBy.has(w.id);
      // Idle with nothing left on the board: the recreation room. Idle with work still open: the lounge.
      const open = tasks.some((t) => t.worker_id === w.id && t.status !== "done");
      const rest = run.status === "done" || (tasks.length > 0 && !open);
      const mode = needs ? "wait" : w.status === "working" || w.status === "starting" ? "work" : rest ? "rest" : "idle";
      p.act = mode === "work" && w.status === "working" ? w.activity : null;
      if (mode === "work" && w.status === "working" && !p.busySince) p.busySince = now;
      if (mode !== "work" && mode !== "idle") p.busySince = 0;
      p.mood = needs ? "blocked" : mode === "work" ? "working" : "ok";
      p.glyph = needs ? { text: "!", color: w.needs_human || w.needs_input ? "#ff4d5e" : "#ffc94d" } : null;
      if (needs) {
        const spot = m.waitSpots[waitIdx++ % m.waitSpots.length];
        if (p.mode !== "wait" || p.waitSpot !== spot) { this.endErrand(p, false); p.mode = "wait"; p.waitSpot = spot; this.goHome(p); }
        const why = w.needs_input?.reason || w.needs_human || (blockedBy.has(w.id) ? `Blocked: ${tasks.find((t) => t.worker_id === w.id && t.status === "blocked")?.note || ""}` : "Idle with open work");
        p.bubble.show(why, { sticky: true });
        monitors.set(i, "alert");
        return;
      }
      if (p.bubble.sticky) { p.bubble.sticky = false; p.bubble.linger(); }
      if (p.mode !== mode) {
        const was = p.mode;
        p.mode = mode;
        // A meeting in progress finishes first; afterwards they head wherever the new mode says.
        if (p.errand?.kind === "meeting") { /* keep talking */ }
        else if (mode === "work") { this.endErrand(p, false); this.goHome(p, was === null); }
        else if (mode === "rest") { this.endErrand(p, false); this.goRest(p); }
        else {
          this.endErrand(p, false); p.nextWander = this.t + 4 + Math.random() * 6;
          // Someone already idle when the page opens is found in the lounge, not at the door.
          if (was === null) { const sp = this.pick(m.cafeSeats, p); if (sp) { this.hold(p, sp); p.goTo(sp, () => { p.dir = sp.dir; p.sit(sp, 0); }); } }
        }
      }
      monitors.set(i, mode === "work" && p.sitting && !p.errand ? "on" : "off");
      if (mode === "work" && w.status === "working") {
        typing.add(i);
        const act = w.activity;
        if (act?.at && act.at !== p.lastActivity) {
          p.lastActivity = act.at;
          if (now - act.at < 10000) {
            p.bubble.show(`${toolIcon(act.tool || String(act.text).split(":")[0])} ${String(act.text || "").replace(/^[\w.-]+:\s*/, "")}`);
            this.onActivity(p, act);
          }
        }
      }
    });
    // What people say about their work shows as their speech bubble (on first load, only the latest line).
    for (const e of data.events || []) {
      if (e.kind !== "say") continue;
      const p = this.people.get(e.worker_id);
      if (!p || p.mode === "gone" || p.mode === "wait" || e.id <= (p.lastSay || 0)) continue;
      p.lastSay = e.id;
      if (!this.placing && now - e.created < 60_000) p.bubble.show(`“${String(e.text).split("\n")[0]}”`);
    }
    // Anyone no longer in the team walks out.
    for (const [id, p] of this.people) if (id !== "ceo" && !workers.some((w) => w.id === id) && p.mode !== "gone") { this.endErrand(p, false); p.mode = "gone"; p.goTo(m.exit || m.entry, () => { p.leaving = true; }); }

    // Messages: envelopes fly from sender to recipient, and the people talking meet.
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
    this.state = { ...this.state, monitors, counts, typing, waiting: waitIdx > 0 };
    this.placing = false;
    this.kick();
  }

  onMessage(msg, workers) {
    const from = msg.sender === "human" ? "human" : msg.sender;
    const targets = msg.recipient === "all" ? (msg.kind === "task" ? [] : workers.map((w) => w.id).filter((id) => id !== from).slice(0, 7)) : [msg.recipient];
    // Side questions keep their own colour; other traffic to or from you is red.
    const color = msg.kind === "aside" ? KIND_COLOR.aside : msg.sender === "human" || msg.recipient === "human" || msg.kind === "interrupt" ? "#ff4d5e" : KIND_COLOR[msg.kind] || "#45e3ff";
    for (const to of targets) {
      const a = this.seatPos(from), b = this.seatPos(to);
      if (!a || !b) continue;
      if (to === "human") this.state.humanPing = 2.5;
      if (!motionOK()) { const p = this.people.get(to); if (p) p.flash = 1; continue; }
      if (this.envelopes.length < MAX_ENVELOPES) this.envelopes.push(new Envelope(a, b, color));
    }
    const sender = this.people.get(from);
    if (!sender || !["chat", "brief", "decision", "aside", "reply"].includes(msg.kind)) return;
    const body = String(msg.body || "").replace(/\s+/g, " ").trim();
    // Messages for you: the sender walks to the YOU terminal to post them.
    if (msg.recipient === "human") {
      if (sender.mode !== "wait") this.errand(sender, "terminal", this.map.youSpot, 4, { onArrive: () => sender.bubble.show(`→ You: ${body}`) });
      return;
    }
    // Teammates talking go to the meeting room.
    const listeners = targets.map((id) => this.people.get(id)).filter(Boolean);
    const label = listeners.length > 1 ? "Team" : listeners[0]?.name;
    if (label) this.meet(sender, listeners, `→ ${label}: ${body}`);
  }

  frame(ts) {
    this.raf = null;
    if (!this.active || document.hidden) return;           // paused while hidden: no background cost
    const dt = Math.min(0.05, (ts - this.last) / 1000); this.last = ts; this.t += dt;
    if (this.map) {
      if (this.theme !== this.currentTheme()) this.ensureMap(this.data?.workers || []);
      if (motionOK()) this.social();
      for (const p of this.people.values()) {
        this.think(p); p.update(dt);
        // Screens and "thinking" follow the live pose: lit only while actually seated at the desk.
        if (p.mode === "work" && p.seatIndex !== undefined) {
          const atDesk = p.sitting && !p.errand;
          this.state.monitors.set(p.seatIndex, atDesk ? "on" : "off");
          if (atDesk && p.bubble.state === "hidden" && Date.now() - (p.lastActivity || 0) > 8000) p.bubble.show("", { thinking: true });
        }
      }
      // The TV plays while someone holds a controller; a treadmill runs while someone is on it.
      const here = [...this.people.values()].filter((p) => p.pose && !p.walking);
      this.state.gaming = here.some((p) => p.pose.game);
      this.state.treadmills = new Set(here.filter((p) => p.pose.treadmill).map((p) => `${p.tile.x},${p.tile.y}`));
      this.state.pong = here.filter((p) => p.pose.prop === "paddle").length;
      this.meetings = this.meetings.filter((mt) => mt.members.size);
      this.state.meetingOn = this.meetings.some((mt) => mt.arrived > 0);
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
    ctx.fillStyle = pal.grass[0];
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const { ox, oy } = this.camera.offset();
    const z = this.camera.zoom * this.dpr;
    ctx.setTransform(z, 0, 0, z, ox * this.dpr, oy * this.dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.staticLayer, 0, 0);
    drawDynamic(ctx, map, pal, this.t, this.state);
    drawLabels(ctx, map, pal);
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
