// Procedural pixel people for the RedPi Office (original RedPi art, drawn in code): small
// "chibi" characters with round heads, simple dark eyes, rosy cheeks, arms and a soft dark
// outline. Walking scene sprites are 18×32 (front and back, 3 walk phases); portraits are the
// top 18×28 of the front sprite. Every look is derived from the worker's name and role, so a
// person always looks the same and their clothes hint at what they do (no likeness of any real
// or fictional person).

export const PORTRAIT_W = 18, PORTRAIT_H = 28, SCENE_W = 18, SCENE_H = 32;
const OUTLINE = [35, 31, 46];

let buf = null;
const W = SCENE_W, H = SCENE_H;
const set = (x, y, c, a = 255) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
};
const alpha = (x, y) => (x < 0 || x >= W || y < 0 || y >= H ? 0 : buf[(y * W + x) * 4 + 3]);
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
// Rows given as [y, x0, x1].
const rows = (list, c) => { for (const [y, a, b] of list) rect(a, y, b, y, c); };
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const tone = (c, k) => c.map((v) => clamp(v * k));
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

const SKINS = ["#ffe0c7", "#f7cba4", "#e9b48a", "#c98d62", "#a86f4a", "#7d4f33"].map(hex);
const HAIR_COLORS = ["#2b2230", "#4a3226", "#6e4630", "#9a5a33", "#c98a3e", "#e6c06a", "#b9b4ad", "#3b3f5c", "#a8433f", "#5b3a6e"].map(hex);
const STYLES = ["short", "fringe", "bob", "long", "bun", "ponytail", "curly", "spiky", "buzz", "afro", "short", "bob", "bald"];
const PANTS = ["#3b4258", "#2f3443", "#56607a", "#6b5a48", "#3e5a4f"].map(hex);
const SHOES = ["#2b2730", "#6a4430", "#f2f2f2", "#3b5bdb"].map(hex);
const WHITE = [246, 246, 244], EYE = [40, 33, 48], BLUSH = [240, 140, 140], MOUTH = [150, 70, 70];

// ---- head and face ----
const HEAD = [[4, 5, 12], [5, 4, 13], [6, 3, 14], [7, 3, 14], [8, 3, 14], [9, 3, 14], [10, 3, 14], [11, 3, 14], [12, 3, 14], [13, 3, 14], [14, 4, 13], [15, 5, 12]];
function head(r) {
  const s = r.skin, sh = tone(s, 0.86);
  rows(HEAD, s);
  for (let y = 7; y <= 13; y++) set(14, y, sh);
  rect(5, 15, 12, 15, sh); set(13, 14, sh);
  set(2, 10, s); set(2, 11, sh); set(15, 10, s); set(15, 11, sh);   // ears
  rect(7, 16, 10, 16, sh);                                        // neck
}
function face(r) {
  const m = r.mood;
  for (const ex of [5, 10]) {
    if (m === "done") { set(ex, 11, EYE); set(ex + 1, 10, EYE); set(ex + 2, 11, EYE); continue; }   // happy ^^ eyes
    rect(ex + (ex === 5 ? 1 : 0), 10, ex + (ex === 5 ? 2 : 1), 12, EYE);
    set(ex + (ex === 5 ? 1 : 0), 10, WHITE);
  }
  if (m === "blocked") { set(5, 8, EYE); set(6, 9, EYE); set(12, 8, EYE); set(11, 9, EYE); }
  else if (m === "working") { rect(6, 9, 7, 9, tone(r.hairc, 0.9)); rect(10, 9, 11, 9, tone(r.hairc, 0.9)); }
  if (r.blush) { set(4, 13, BLUSH, 200); set(5, 13, BLUSH, 150); set(13, 13, BLUSH, 200); set(12, 13, BLUSH, 150); }
  if (m === "blocked") { rect(8, 14, 9, 14, MOUTH); set(7, 15, MOUTH); set(10, 15, MOUTH); }
  else if (m === "working") rect(8, 14, 9, 14, MOUTH);
  else if (m === "done") { rect(7, 13, 10, 13, MOUTH); rect(8, 14, 9, 14, [235, 110, 110]); }
  else { set(7, 13, MOUTH); rect(8, 14, 9, 14, MOUTH); set(10, 13, MOUTH); }
  if (r.facial === "beard") { const b = tone(r.hairc, 1); rows([[13, 3, 4], [13, 13, 14], [14, 4, 6], [14, 11, 13], [15, 5, 12]], b); set(7, 14, b); set(10, 14, b); }
  else if (r.facial === "stubble") for (const [x, y] of [[5, 14], [7, 15], [9, 15], [11, 15], [12, 14], [6, 15], [10, 15]]) set(x, y, tone(r.skin, 0.72), 180);
  if (r.glasses) {
    const g = [70, 64, 86], lens = [214, 232, 246];
    for (const gx of [4, 9]) { rect(gx, 9, gx + 3, 9, g); rect(gx, 10, gx, 12, g); rect(gx + 3, 10, gx + 3, 12, g); rect(gx + 1, 13, gx + 2, 13, g); set(gx + (gx === 4 ? 2 : 1), 10, lens, 160); }
    set(8, 10, g); set(3, 10, g); set(14, 10, g);
  }
}

// ---- hair ----
function hairFront(r) {
  const c = r.hairc, hi = tone(c, 1.35), sh = tone(c, 0.72), st = r.hair;
  if (st === "bald") { const s = r.skin; set(6, 5, tone(s, 1.08)); set(7, 5, tone(s, 1.08)); rect(3, 8, 3, 11, c); rect(14, 8, 14, 11, c); return; }
  if (st === "buzz") { rows([[3, 5, 12], [4, 4, 13], [5, 3, 14], [6, 3, 14]], tone(c, 0.9)); rect(3, 7, 3, 8, c); rect(14, 7, 14, 8, c); return; }
  if (st === "afro") {
    rows([[0, 5, 12], [1, 3, 14], [2, 2, 15], [3, 1, 16], [4, 1, 16], [5, 1, 16], [6, 1, 16], [7, 1, 4], [7, 13, 16], [8, 1, 3], [8, 14, 16], [9, 1, 3], [9, 14, 16], [10, 2, 2], [10, 15, 15]], c);
    for (const [x, y] of [[4, 1], [8, 0], [12, 1], [2, 4], [15, 4]]) set(x, y, hi);
    rect(5, 7, 12, 7, c); return;
  }
  // A rounded cap of hair over the top of the head.
  rows([[2, 5, 12], [3, 4, 13], [4, 3, 14], [5, 2, 15], [6, 2, 15], [7, 2, 15]], c);
  if (st === "curly") { for (const x of [3, 6, 9, 12]) { set(x, 1, c); set(x + 1, 1, c); } rect(2, 8, 3, 12, c); rect(14, 8, 15, 12, c); for (const x of [4, 8, 12]) set(x, 2, hi); }
  if (st === "spiky") { for (const x of [4, 7, 10, 13]) { set(x, 1, c); set(x, 0, c); set(x + 1, 1, c); } }
  if (st === "bun") { rows([[0, 7, 10], [1, 6, 11]], c); set(7, 0, hi); }
  // Bangs and sides.
  if (st === "fringe" || st === "bob" || st === "long") rect(3, 8, 14, 8, c);
  else { rect(3, 8, 6, 8, c); set(7, 8, c); }
  if (st === "bob" || st === "long") { rect(2, 8, 3, 15, c); rect(14, 8, 15, 15, c); set(2, 16, c); set(15, 16, c); }
  else if (st !== "curly") { rect(2, 8, 3, 10, c); rect(14, 8, 15, 10, c); }
  // Shine and shade.
  rect(5, 3, 8, 3, hi); set(4, 4, hi);
  for (let y = 4; y <= 7; y++) set(15, y, sh);
  if (st === "fringe" || st === "bob" || st === "long") for (const x of [5, 9, 12]) set(x, 8, sh);
}
// Hair that falls behind the shoulders (drawn before the body).
function hairBehind(r) {
  const c = tone(r.hairc, 0.85), st = r.hair;
  if (st === "long") rect(2, 9, 15, 21, c);
  if (st === "ponytail") { rect(15, 6, 16, 15, c); set(16, 16, c); }
  if (st === "afro") rect(1, 8, 16, 12, c);
}
function hairBack(r) {
  const c = r.hairc, hi = tone(c, 1.3), sh = tone(c, 0.75), st = r.hair, s = r.skin;
  if (st === "bald" || st === "buzz") {
    rows(HEAD, st === "buzz" ? tone(c, 0.9) : s);
    rect(3, 11, 14, 13, st === "bald" ? c : tone(c, 0.9)); set(6, 5, tone(s, 1.1));
    rect(7, 16, 10, 16, tone(s, 0.86));
    return;
  }
  rows(HEAD, c);
  rows([[2, 5, 12], [3, 4, 13], [4, 3, 14], [5, 2, 15], [6, 2, 15], [7, 2, 15], [8, 2, 15], [9, 2, 15], [10, 2, 15]], c);
  if (st === "afro") rows([[0, 5, 12], [1, 3, 14], [2, 2, 15], [3, 1, 16], [4, 1, 16], [5, 1, 16], [6, 1, 16], [7, 1, 16], [8, 1, 16], [9, 1, 16], [10, 1, 16], [11, 2, 15], [12, 2, 15]], c);
  if (st === "curly") for (const x of [3, 6, 9, 12]) { set(x, 1, c); set(x + 1, 1, c); }
  if (st === "spiky") for (const x of [4, 7, 10, 13]) { set(x, 1, c); set(x, 0, c); }
  if (st === "bun") rows([[0, 7, 10], [1, 6, 11], [2, 6, 11]], c);
  if (st === "long" || st === "bob") rect(2, 11, 15, st === "long" ? 21 : 16, c);
  if (st === "ponytail") { rect(7, 13, 10, 20, c); rect(8, 21, 9, 22, c); }
  rect(5, 3, 9, 3, hi); rect(4, 4, 6, 5, hi);
  for (let y = 5; y <= 14; y++) set(14, y, sh);
  if (st !== "long" && st !== "ponytail" && st !== "afro") rect(7, 16, 10, 16, tone(s, 0.86));
}
function headphones(r) {
  const d = [58, 62, 74], d2 = [90, 96, 112];
  rows([[1, 5, 12], [2, 4, 4], [2, 13, 13], [3, 3, 3], [3, 14, 14]], d);
  rect(3, 4, 3, 8, d); rect(14, 4, 14, 8, d);
  rect(1, 9, 3, 12, d); rect(14, 9, 16, 12, d); set(2, 10, d2); set(15, 10, d2);
}

// ---- body ----
function body(r, back, phase) {
  const c = r.c1, sh = tone(c, 0.8), hi = tone(c, 1.15), s = r.skin;
  // Arms swing a pixel while walking.
  const la = phase === 1 ? 1 : phase === 2 ? -1 : 0, ra = -la;
  const sleeve = r.cloth === "tee" ? 20 : 23;
  for (const [ax, dy] of [[2, la], [14, ra]]) {
    rect(ax, 18 + dy, ax + 1, Math.min(sleeve, 23) + dy, ax === 2 ? c : sh);
    if (sleeve < 23) rect(ax, sleeve + 1 + dy, ax + 1, 23 + dy, s);
    rect(ax, 24 + dy, ax + 1, 25 + dy, s);
  }
  rows([[17, 5, 12], [18, 4, 13], [19, 4, 13], [20, 4, 13], [21, 4, 13], [22, 4, 13], [23, 4, 13], [24, 4, 13], [25, 4, 13]], c);
  rect(12, 18, 13, 25, sh); rect(4, 18, 4, 25, hi);
  if (back) {
    if (r.cloth === "hoodie") rows([[17, 6, 11], [18, 6, 11], [19, 7, 10]], sh);
    else rect(6, 17, 11, 17, sh);
    return;
  }
  const white = [244, 244, 242];
  switch (r.cloth) {
    case "tee": rect(7, 17, 10, 17, s); set(8, 18, s); set(9, 18, s); break;
    case "hoodie": rows([[16, 5, 6], [16, 11, 12], [17, 5, 12]], sh); rect(7, 17, 10, 17, s); set(7, 18, white); set(7, 19, white); set(10, 18, white); set(10, 19, white); rect(6, 22, 11, 23, sh); break;
    case "shirt": rect(7, 17, 10, 17, white); set(6, 17, white); set(11, 17, white); for (let y = 19; y <= 25; y += 2) set(8, y, sh); if (r.tie) rect(8, 18, 9, 23, r.tie); break;
    case "suit": rows([[17, 7, 10], [18, 7, 10], [19, 8, 9]], white); rect(8, 18, 9, 23, r.tie || [200, 50, 60]); set(6, 18, sh); set(6, 19, sh); set(11, 18, sh); set(11, 19, sh); set(7, 20, sh); set(10, 20, sh); break;
    case "cardigan": rect(7, 17, 10, 25, r.c2 || white); set(6, 20, sh); set(6, 23, sh); set(11, 20, sh); set(11, 23, sh); break;
    case "sweater": rect(6, 17, 11, 17, sh); rect(4, 25, 13, 25, sh); for (const x of [6, 9, 12]) set(x, 21, hi); break;
    case "polo": rect(6, 17, 11, 17, r.c2 || hi); rect(8, 18, 9, 19, r.c2 || sh); break;
    default:
  }
}
function legs(r, phase) {
  const p = r.pants, psh = tone(p, 0.8), shoe = r.shoes;
  const L = phase === 1 ? 1 : 0, Rr = phase === 2 ? 1 : 0;   // the lifted leg is a pixel shorter
  rect(5, 26, 8, 29 - L, p); rect(9, 26, 12, 29 - Rr, psh);
  set(8, 26, psh);
  rect(4, 30 - L, 8, 31 - L, shoe); rect(9, 30 - Rr, 13, 31 - Rr, shoe);
  set(4, 30 - L, tone(shoe, 1.3)); set(9, 30 - Rr, tone(shoe, 1.3));
}

function outline() {
  const pts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (alpha(x, y) !== 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (alpha(x + dx, y + dy) === 255) { pts.push([x, y]); break; }
  }
  for (const [x, y] of pts) set(x, y, OUTLINE);
}

// ---------------- deterministic looks from name + role ----------------
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
// Role → clothing cut and colours, so a glance at the floor tells who does what.
function roleLook(role) {
  const r = String(role || "").toLowerCase();
  if (r === "ceo") return { cloth: "suit", c1: hex("#2d3346"), tie: hex("#d6304a") };
  if (/secur|pentest|red.?team|cyber/.test(r)) return { cloth: "hoodie", c1: hex("#2f3240") };
  if (/review|qa|test|audit/.test(r)) return { cloth: "cardigan", c1: hex("#d9a441"), c2: hex("#f3eee2") };
  if (/\bai\b|ml|agent|llm|data|research|analy/.test(r)) return { cloth: "sweater", c1: hex("#8a6ad6") };
  if (/design|\bui\b|\bux\b|brand/.test(r)) return { cloth: "tee", c1: hex("#ef7b8f") };
  if (/front/.test(r)) return { cloth: "hoodie", c1: hex("#3fb6d9") };
  if (/full.?stack/.test(r)) return { cloth: "polo", c1: hex("#3fae7d"), c2: hex("#2e8a61") };
  if (/devops|infra|sre|platform|ops/.test(r)) return { cloth: "polo", c1: hex("#ee8a4a"), c2: hex("#c96a2e") };
  if (/writ|docs|content|market/.test(r)) return { cloth: "cardigan", c1: hex("#5f8f6e"), c2: hex("#efe7d6") };
  if (/back|api|server/.test(r)) return { cloth: "shirt", c1: hex("#5b8fd9") };
  return { cloth: "shirt", c1: hex("#7d93ad") };
}

export function recipeFor(name, role, mood = "ok") {
  const h = hash(`${name}|${role}`);
  const pick = (arr, salt) => arr[(h >>> salt) % arr.length];
  const look = roleLook(role);
  const hair = pick(STYLES, 3);
  const dev = /develop|engineer|backend|frontend|full.?stack|devops|program|coder/.test(String(role).toLowerCase());
  return {
    skin: pick(SKINS, 0), hairc: pick(HAIR_COLORS, 7), hair, ...look,
    pants: look.cloth === "suit" ? tone(look.c1, 0.85) : pick(PANTS, 11), shoes: pick(SHOES, 13),
    glasses: (h >>> 17) % 3 === 0,
    facial: hair !== "long" && hair !== "bob" && (h >>> 19) % 6 === 0 ? pick(["beard", "stubble"], 21) : undefined,
    blush: (h >>> 23) % 3 !== 0,
    headphones: dev && hair !== "afro" && hair !== "bun" && (h >>> 25) % 3 === 0,
    mood: mood === "blocked" ? "blocked" : mood === "working" ? "working" : mood === "done" ? "done" : "ok",
  };
}

function compose(r, phase, back) {
  buf = new Uint8ClampedArray(W * H * 4);
  if (!back) hairBehind(r);
  body(r, back, phase);
  legs(r, phase);
  if (back) { hairBack(r); if (r.headphones) { const d = [58, 62, 74]; rows([[1, 5, 12]], d); rect(1, 9, 2, 12, d); rect(15, 9, 16, 12, d); } }
  else { head(r); face(r); hairFront(r); if (r.headphones) headphones(r); }
  outline();
  return buf;
}

function toCanvas(data, w, h, sy = 0) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H);
  img.data.set(data);
  ctx.putImageData(img, 0, -sy);
  return c;
}

const portraitCache = new Map();
const sceneCache = new Map();

/** Canvas with a person's 18×28 portrait (cached per name/role/mood). */
export function portraitCanvas(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!portraitCache.has(key)) portraitCache.set(key, toCanvas(compose(recipeFor(name, role, mood), 0, false), PORTRAIT_W, PORTRAIT_H));
  return portraitCache.get(key);
}

/** data: URL portrait for <img> in the DOM (CSP allows data: images). */
const urlCache = new Map();
export function portraitUrl(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!urlCache.has(key)) {
    const src = portraitCanvas(name, role, mood);
    const big = document.createElement("canvas");
    big.width = PORTRAIT_W * 4; big.height = PORTRAIT_H * 4;
    const ctx = big.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, big.width, big.height);
    urlCache.set(key, big.toDataURL("image/png"));
  }
  return urlCache.get(key);
}

/** Walking frames: { front: [stand, stepL, stepR], back: [...] } as canvases. */
export function sceneFrames(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!sceneCache.has(key)) {
    const r = recipeFor(name, role, mood);
    sceneCache.set(key, {
      front: [0, 1, 2].map((p) => toCanvas(compose(r, p, false), SCENE_W, SCENE_H)),
      back: [0, 1, 2].map((p) => toCanvas(compose(r, p, true), SCENE_W, SCENE_H)),
    });
  }
  return sceneCache.get(key);
}
