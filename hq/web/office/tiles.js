// RedPi Office tileset: original pixel art, painted in code (no image assets).
// A bright, cosy top-down style: cream corridors, coloured room floors, white desks, warm wood,
// a park around the building. The light theme is daytime; the dark theme is the same office at
// night (lit windows, glowing lamps, stars). paintStatic() bakes floors, walls, flat furniture
// and the park once into an offscreen canvas; drawDynamic() and drawItem() paint what moves.
import { TILE } from "./map.js";

const T = TILE;

const DAY = {
  night: false,
  grass: ["#94cf70", "#8fcb6b", "#7cb95c"], bladeHi: "#b2e08f", flower: ["#ffd75e", "#ff8fa6", "#ffffff", "#b9a2ff"], flowerMid: "#f29b38",
  apron: ["#e1dacb", "#d3cbba"], plaza: ["#e9dfcd", "#dacdb6"], path: ["#e5d6b8", "#d6c5a2"], walk: ["#dadcdf", "#c9ccd1"],
  road: "#626973", roadHi: "#6d747e", roadLine: "#f4e59e", curb: "#a3a9b1", parking: "#6e7580", parkLine: "#eef0f2",
  water: ["#66c2e7", "#5bb5dc"], waterHi: "#cdf0fc", shore: "#e7d7a5", lily: "#5aa95c",
  trunk: "#8a5a3b", trunkSh: "#6b4229", canopy: [["#3f8a45", "#52a653", "#6cc062", "#8fd77a"], ["#457f3a", "#5b9c45", "#78b856", "#9bd172"], ["#3c8457", "#4e9f69", "#68b97f", "#8ad39a"]],
  pine: [["#25603f", "#2f7a4f", "#3f9562", "#5bb07a"], ["#2a5e48", "#367a5c", "#469470", "#62ae88"]], bush: ["#3f8a45", "#58aa55", "#79c56a"], rock: ["#8f969f", "#aeb4bb", "#cdd2d7"],
  car: ["#e45b5b", "#4a8fe0", "#f2c14e", "#f4f4f4", "#454c59", "#59b88a"], carGlass: "#bfe3f5", tire: "#2b2d33",
  lampPole: "#4a505c", lampHead: "#fff6d2", bench: "#b07a4f", benchDark: "#7d5434",
  hall: ["#f3e8d5", "#efe3cd"], hallLine: "#e3d4b9",
  wood: ["#cc9a6c", "#c08d60", "#a97752"], meet: ["#aeaadd", "#a5a1d6"], library: ["#c39872", "#b88d66", "#a57c57"],
  server: ["#6f778a", "#676f82"], serverDot: "#5b6376",
  lobby: ["#f8f5f0", "#f0eae0"], lobbyVein: "#e3dbce", cafe: ["#f5f8fb", "#e8eff6"], cafeDot: "#a7c2df",
  lounge: ["#9690d2", "#8c86c9"], gym: ["#6c7481", "#646c79"], gymDot: "#7e8794",
  rug: "#f2cb8a", rugEdge: "#e0b26c", rugLounge: "#f3a194", rugLoungeEdge: "#de8677",
  huddle: ["#a2d5ca", "#98cdc1"], focus: ["#cfc9ba", "#c6c0af"], wellness: ["#d2e8c3", "#c8e1b7"], studio: ["#f2d9ba", "#eacdab"],
  zone: { eng: ["#c6ccd8", "#bcc3d0"], design: ["#efd3d6", "#e8c9cd"], data: ["#c8e1db", "#bdd9d2"], qa: ["#efe0bb", "#e8d6ad"], ops: ["#d1dec1", "#c7d6b5"], security: ["#d6cee9", "#ccc3e3"], docs: ["#eadccc", "#e2d2c0"] },
  door: "#dcd1be", mat: "#fbe1e4", matStripe: "#f6ccd2", matEdge: "#e2475a",
  wallCap: "#4d5567", wallCapHi: "#5f687c", wallFace: "#e1e4ec", wallFaceSh: "#c8ccd7", wallBase: "#a0a7b5",
  facade: "#eadfce", facadeSh: "#d5c8b3", facadeBase: "#b9ab94",
  glassPane: "rgba(176,224,246,0.5)", glassFrame: "#f7f9fb", glassEdge: "#8db6ca",
  winFrame: "#f6f6f4", sky: ["#8fd0f2", "#b9e3f8"], cloud: "#ffffff", winLit: "#bfe3f5",
  desk: "#f6f7f9", deskHi: "#ffffff", deskEdge: "#d4d9e1", deskLeg: "#a6aebb", bezel: "#2e3341", screenOff: "#3d4556", screenOn: "#2f6fd6", screenLine: "#c4e2ff", screenAlert: "#c9303f",
  keyboard: "#d0d5dd", keyHi: "#e9ecf0", mug: ["#ffffff", "#f2b33d", "#e35d8c", "#4f8fe0"],
  chair: "#3b404c", chairHi: "#565d6c", stool: "#e7a65b", stoolHi: "#f2c07f",
  pot: "#f3f3f1", potSh: "#d4d4d0", clay: "#d9845e", claySh: "#b96a48", leaf: "#3f9a4b", leafMid: "#52b05a", leafHi: "#7fd06f",
  rack: "#2b303b", rackFace: "#3b4251", ledG: "#3ddc84", ledR: "#ff4d5e", ledA: "#ffc94d",
  table: "#c79a6b", tableTop: "#dcb183", tableEdge: "#a77b51", cafeTop: "#ffffff", cafeEdge: "#d7dde5",
  counter: "#8f6b4f", counterTop: "#f2eee7", machine: "#3d424d", fridge: "#e9eef3", fridgeSh: "#c9d1da",
  shelf: "#a9764f", shelfIn: "#6f4b33", books: ["#d65f50", "#4f8fd0", "#e8b64a", "#5cb072", "#9a6bc4", "#f4efe2", "#3fb6b2"],
  board: "#ffffff", boardFrame: "#9ba4b3", ink: "#2b3040", cork: "#c99b67", note: ["#ffe27a", "#ffb3c1", "#9fe0ff", "#b8f2a0"],
  couch: "#e48f5a", couchHi: "#f2a978", sofa: "#6f9fd8", sofaHi: "#8db6e6", cushion: "#f0aa52", cushionHi: "#f7c57b",
  beanbag: ["#4f8fe0", "#e35d8c", "#f2b33d", "#5bbf8a"], yoga: ["#7ac7b5", "#c79ae0", "#f2a07b"],
  gymMetal: "#a0a9b3", gymDark: "#3c424d", pongTable: "#2f8f68", pongLine: "#ffffff",
  terminal: "#2e3341", reception: "#f5f6f8", receptionFront: "#e05a6a", receptionFrontSh: "#c34555",
  skin: "#f0c9a0", text: "#2b3040", shadow: "rgba(30,35,60,0.16)",
  labelBg: "rgba(255,255,255,0.85)", labelText: "#5b6174", signBg: "#2e3341", signText: "#ffffff",
  glow: "rgba(255,214,140,0.0)",
};

// Night: the same office, dimmed toward a deep blue, with the lights left as they are.
const KEEP = new Set(["screenOn", "screenLine", "screenAlert", "ledG", "ledR", "ledA", "lampHead", "labelBg", "labelText", "signBg", "signText", "matEdge", "night", "glow", "winLit", "note", "mug"]);
function dim(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16), tint = [22, 28, 58];
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x, i) => Math.round(x * 0.5 + tint[i] * 0.5));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function derive(o, key) {
  if (KEEP.has(key)) return o;
  if (Array.isArray(o)) return o.map((x) => derive(x));
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, derive(v, k)]));
  return typeof o === "string" ? dim(o) : o;
}
const NIGHT = {
  ...derive(DAY),
  night: true, shadow: "rgba(0,0,0,0.3)", glassPane: "rgba(90,130,190,0.35)", sky: ["#141c3f", "#1d2752"], cloud: "#e8ecff", winLit: "#ffd98a",
  labelBg: "rgba(18,22,38,0.78)", labelText: "#dfe3ef", glow: "rgba(255,206,120,0.30)", screenOff: "#1e2433",
};

export function palette(theme) { return theme === "light" ? DAY : NIGHT; }

const tone2 = (hexc) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hexc.slice(i, i + 2), 16) * 0.78).toString(16).padStart(2, "0")).join("")}`;
const P = (ctx, color, x, y, w = 1, h = 1) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
// A crisp pixel disc (no anti-aliasing).
function disc(ctx, color, cx, cy, r) {
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) { const w = Math.floor(Math.sqrt(r * r - dy * dy + r * 0.8)); ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1); }
}
function ellipse(ctx, color, cx, cy, rx, ry) {
  ctx.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) { const w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry + 0.5)))); ctx.fillRect(cx - w, cy + dy, 2 * w + 1, 1); }
}
const hash2 = (x, y) => { let h = (x * 374761393 + y * 668265263) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return (h ^ (h >>> 16)) >>> 0; };
function checker(ctx, cols, x, y, size) {
  for (let j = 0; j < T; j += size) for (let i = 0; i < T; i += size) P(ctx, cols[((x + i) / size + (y + j) / size) % 2], x + i, y + j, size, size);
}

function floorTile(ctx, pal, kind, tx, ty, map) {
  const x = tx * T, y = ty * T, h = hash2(tx, ty);
  if (kind.startsWith("zone:")) return checker(ctx, pal.zone[kind.slice(5)] || pal.zone.eng, x, y, 8);
  switch (kind) {
    case "grass": {
      const patch = Math.sin(tx * 0.21 + Math.cos(ty * 0.17) * 2) + Math.cos(ty * 0.23 - tx * 0.07) > 0.7 ? 1 : 0;
      P(ctx, pal.grass[patch], x, y, T, T);
      for (let i = 0; i < 3; i++) P(ctx, pal.grass[2], x + ((h >>> (i * 5)) % 15), y + ((h >>> (i * 5 + 3)) % 14), 1, 2);
      if (h % 7 === 0) P(ctx, pal.bladeHi, x + ((h >>> 7) % 14), y + ((h >>> 11) % 14), 2, 1);
      if (h % 29 === 0) { const fx = x + 4 + ((h >>> 4) % 8), fy = y + 4 + ((h >>> 9) % 8), c = pal.flower[(h >>> 13) % pal.flower.length]; P(ctx, c, fx - 1, fy, 3, 1); P(ctx, c, fx, fy - 1, 1, 3); P(ctx, pal.flowerMid, fx, fy); }
      return;
    }
    case "apron": case "plaza": case "path": {
      const c = pal[kind];
      P(ctx, c[0], x, y, T, T);
      const off = ty % 2 ? 4 : 0;
      for (let i = 0; i < T; i += 8) P(ctx, c[1], x + ((i + off) % T), y, 1, T);
      P(ctx, c[1], x, y + 7, T, 1); P(ctx, c[1], x, y + 15, T, 1);
      return;
    }
    case "walk": P(ctx, pal.walk[0], x, y, T, T); P(ctx, pal.walk[1], x, y + 15, T, 1); P(ctx, pal.walk[1], x + 15, y, 1, T); return;
    case "road": {
      P(ctx, pal.road, x, y, T, T);
      if (h % 5 === 0) P(ctx, pal.roadHi, x + (h % 13), y + ((h >>> 5) % 13), 2, 1);
      const r = map.road;
      if (ty === r.y) P(ctx, pal.curb, x, y, T, 1);
      if (ty === r.y + r.h - 1) P(ctx, pal.curb, x, y + 15, T, 1);
      if (ty === r.y + 1 && tx % 2 === 0) P(ctx, pal.roadLine, x + 2, y + 7, 12, 2);
      return;
    }
    case "parking": P(ctx, pal.parking, x, y, T, T); if (h % 6 === 0) P(ctx, pal.roadHi, x + (h % 13), y + ((h >>> 5) % 13), 2, 1); return;
    case "water": return floorTile(ctx, pal, "grass", tx, ty, map);   // the pond is drawn whole, below
    case "hall": {
      P(ctx, pal.hall[(tx + ty) % 2], x, y, T, T);
      P(ctx, pal.hallLine, x, y + 15, T, 1); P(ctx, pal.hallLine, x + 15, y, 1, T);
      return;
    }
    case "wood": {
      P(ctx, pal.wood[0], x, y, T, T);
      for (let i = 0; i < 4; i++) { P(ctx, pal.wood[i % 2 ? 1 : 0], x, y + i * 4, T, 4); P(ctx, pal.wood[2], x, y + i * 4 + 3, T, 1); P(ctx, pal.wood[2], x + ((tx * 7 + ty * 3 + i * 5) % T), y + i * 4, 1, 3); }
      return;
    }
    case "library": {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const bx = x + i * 8, by = y + j * 8, vert = (i + j + tx + ty) % 2 === 0;
        P(ctx, pal.library[(i + j) % 2], bx, by, 8, 8);
        for (let k = 2; k < 8; k += 3) vert ? P(ctx, pal.library[2], bx + k, by, 1, 8) : P(ctx, pal.library[2], bx, by + k, 8, 1);
      }
      return;
    }
    case "server": {
      P(ctx, pal.server[(tx + ty) % 2], x, y, T, T);
      for (let j = 2; j < T; j += 4) for (let i = 2; i < T; i += 4) P(ctx, pal.serverDot, x + i, y + j);
      P(ctx, pal.serverDot, x, y, T, 1); P(ctx, pal.serverDot, x, y, 1, T);
      return;
    }
    case "lobby": {
      P(ctx, pal.lobby[(tx + ty) % 2], x, y, T, T);
      if (h % 3 === 0) for (let i = 0; i < 6; i++) P(ctx, pal.lobbyVein, x + 3 + i + ((h >>> 3) % 4), y + 4 + i + ((i * h) % 2), 1, 1);
      P(ctx, pal.lobbyVein, x, y + 15, T, 1); P(ctx, pal.lobbyVein, x + 15, y, 1, T);
      return;
    }
    case "cafe": {
      checker(ctx, pal.cafe, x, y, 8);
      P(ctx, pal.cafeDot, x + 7, y + 7, 2, 2);
      return;
    }
    case "lounge": for (let i = 0; i < T; i += 4) P(ctx, pal.lounge[(i / 4) % 2], x + i, y, 4, T); return;
    case "gym": P(ctx, pal.gym[(tx + ty) % 2], x, y, T, T); for (let i = 0; i < 4; i++) P(ctx, pal.gymDot, x + ((h >>> (i * 4)) % 15), y + ((h >>> (i * 4 + 2)) % 15)); return;
    case "rug": case "rugLounge": {
      const base = kind === "rug" ? pal.rug : pal.rugLounge, edge = kind === "rug" ? pal.rugEdge : pal.rugLoungeEdge;
      P(ctx, base, x, y, T, T);
      const same = (a, b) => map.floor[b]?.[a] === kind;
      if (!same(tx, ty - 1)) P(ctx, edge, x, y + 1, T, 2);
      if (!same(tx, ty + 1)) P(ctx, edge, x, y + 13, T, 2);
      if (!same(tx - 1, ty)) P(ctx, edge, x + 1, y, 2, T);
      if (!same(tx + 1, ty)) P(ctx, edge, x + 13, y, 2, T);
      if ((tx + ty) % 2 === 0) P(ctx, edge, x + 7, y + 7, 2, 2);
      return;
    }
    case "door": P(ctx, pal.door, x, y, T, T); P(ctx, pal.wallBase, x, y + 14, T, 2); return;
    default: {
      const c = pal[kind];
      if (Array.isArray(c)) checker(ctx, c, x, y, 8); else P(ctx, pal.hall[0], x, y, T, T);
    }
  }
}

const isWall = (map, x, y) => { const k = map.wall[y]?.[x]; return !!k && k !== "glass"; };

function paintWalls(ctx, map, pal) {
  const b = map.building, top0 = b.y, top1 = b.y + 1;
  for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
    const k = map.wall[ty][tx];
    if (!k) continue;
    const x = tx * T, y = ty * T;
    if (k === "glass") {
      P(ctx, pal.glassPane, x, y + 4, T, 7);
      P(ctx, pal.glassFrame, x, y + 4, T, 1); P(ctx, pal.glassEdge, x, y + 11, T, 1);
      P(ctx, pal.glassFrame, x, y + 4, 1, 8);
      P(ctx, pal.glassFrame, x + 4 + (tx % 3) * 2, y + 6, 3, 1);
      continue;
    }
    const side = tx === b.x || tx === b.x + b.w - 1;
    if (!side && k === "outer" && (ty === top0 || ty === top1)) {
      if (ty === top0) { P(ctx, pal.wallCap, x, y, T, 6); P(ctx, pal.wallCapHi, x, y, T, 1); P(ctx, pal.wallFace, x, y + 6, T, 10); }
      else { P(ctx, pal.wallFace, x, y, T, T); P(ctx, pal.wallFaceSh, x, y + 12, T, 1); P(ctx, pal.wallBase, x, y + 13, T, 3); }
      continue;
    }
    const below = isWall(map, tx, ty + 1) || map.wall[ty + 1]?.[tx] === "glass";
    if (!below) {
      const front = k === "outer";   // the facade, seen from the park
      P(ctx, pal.wallCap, x, y, T, 5); P(ctx, pal.wallCapHi, x, y, T, 1);
      P(ctx, front ? pal.facade : pal.wallFace, x, y + 5, T, 11);
      P(ctx, front ? pal.facadeSh : pal.wallFaceSh, x, y + 12, T, 1);
      P(ctx, front ? pal.facadeBase : pal.wallBase, x, y + 13, T, 3);
    } else if (k === "outer") {
      P(ctx, pal.wallCap, x, y, T, T); P(ctx, pal.wallCapHi, side && tx === b.x ? x + T - 1 : x, y, 1, T);
    } else {
      P(ctx, pal.wallCap, x + 4, y, 8, T); P(ctx, pal.wallCapHi, x + 4, y, 1, T);
    }
  }
  // Windows on the top wall (the sky is painted live), down the sides and along the facade.
  for (const w of map.windows) {
    const x = w.x * T + 3, y = w.y * T + 8, ww = w.w * T - 6, hh = 19;
    P(ctx, pal.winFrame, x - 2, y - 2, ww + 4, hh + 4); P(ctx, pal.wallFaceSh, x - 2, y + hh + 1, ww + 4, 1);
    P(ctx, pal.sky[0], x, y, ww, hh);
  }
  for (const w of map.sideWindows) {
    const x = w.x * T + 5, y = w.y * T + 3;
    P(ctx, pal.winFrame, x - 1, y - 1, 8, w.h * T - 4); P(ctx, pal.winLit, x, y, 6, w.h * T - 6);
    P(ctx, pal.winFrame, x, y + (w.h * T - 6) / 2, 6, 1);
  }
  for (const w of map.facade) {
    const x = w.x * T + 3, y = w.y * T + 6, ww = w.w * T - 6;
    P(ctx, pal.winFrame, x - 1, y - 1, ww + 2, 8); P(ctx, pal.night ? pal.winLit : pal.carGlass, x, y, ww, 6);
    P(ctx, pal.winFrame, x + ww / 2, y, 1, 6);
    if (!pal.night) P(ctx, pal.winFrame, x + 2, y + 1, 3, 1);
  }
  // Pictures and clocks on bare stretches of interior wall.
  const busy = new Set();
  for (const w of [...map.windows]) for (let i = 0; i < w.w; i++) busy.add(`${w.x + i}`);
  for (const it of map.items) if (it.y <= b.y + 2) for (let i = 0; i < it.w; i++) busy.add(`${it.x + i}`);
  const under = new Set(map.items.map((it) => `${it.x},${it.y}`));
  for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
    if (!isWall(map, tx, ty) || map.wall[ty][tx] === "outer" && ty !== top1) continue;
    if (ty === top1 ? busy.has(`${tx}`) : isWall(map, tx, ty + 1) || under.has(`${tx},${ty + 1}`)) continue;
    if (ty !== top1 && map.wall[ty][tx] !== "inner") continue;
    if (!isWall(map, tx - 1, ty) || !isWall(map, tx + 1, ty)) continue;
    const hh = hash2(tx, ty) % 9;
    if (hh > 1) continue;
    const x = tx * T, y = ty === top1 ? ty * T - 4 : ty * T + 5;
    if (hh === 0) {
      P(ctx, pal.winFrame, x + 3, y + 1, 10, 8); P(ctx, pal.sky[1], x + 4, y + 2, 8, 6);
      P(ctx, pal.canopy[0][2], x + 4, y + 5, 8, 3); P(ctx, pal.flower[0], x + 9, y + 3, 2, 2);
    } else {
      disc(ctx, pal.bezel, x + 8, y + 5, 4); disc(ctx, pal.winFrame, x + 8, y + 5, 3);
      P(ctx, pal.bezel, x + 8, y + 3, 1, 3); P(ctx, pal.bezel, x + 8, y + 5, 2, 1);
    }
  }
}

// Furniture people sit on or walk over (drawn flat into the static layer).
function paintFlat(ctx, pal, it) {
  const x = it.x * T, y = it.y * T, w = it.w * T;
  switch (it.type) {
    case "chair":
      if (it.back) { P(ctx, pal.chairHi, x + 4, y + 3, 8, 3); P(ctx, pal.chair, x + 3, y + 6, 10, 7); P(ctx, pal.chairHi, x + 4, y + 6, 8, 1); P(ctx, pal.chair, x + 7, y + 13, 2, 2); }
      else { P(ctx, pal.chair, x + 3, y + 1, 10, 8); P(ctx, pal.chairHi, x + 4, y + 2, 8, 2); P(ctx, pal.chairHi, x + 3, y + 9, 10, 4); P(ctx, pal.chair, x + 7, y + 13, 2, 2); P(ctx, pal.chair, x + 4, y + 15, 8, 1); }
      return;
    case "stool": disc(ctx, pal.stool, x + 8, y + 9, 4); P(ctx, pal.stoolHi, x + 6, y + 6, 4, 2); return;
    case "couch":   // seen from behind: people sit on it facing the TV
      P(ctx, pal.shadow, x + 1, y + 14, w - 2, 2);
      P(ctx, pal.couchHi, x + 1, y + 3, w - 2, 5);
      for (let i = 1; i < it.w; i++) P(ctx, pal.couch, x + i * T, y + 3, 1, 5);
      P(ctx, pal.couch, x, y + 7, w, 7); P(ctx, pal.couchHi, x, y + 7, w, 1);
      P(ctx, pal.couch, x - 1, y + 2, 3, 12); P(ctx, pal.couch, x + w - 2, y + 2, 3, 12);
      return;
    case "sofa":    // seen from the front
      P(ctx, pal.shadow, x + 1, y + 14, w - 2, 2);
      P(ctx, pal.sofa, x, y, w, 8); P(ctx, pal.sofaHi, x + 1, y + 1, w - 2, 1);
      P(ctx, pal.sofaHi, x + 2, y + 8, w - 4, 5);
      for (let i = 1; i < it.w; i++) P(ctx, pal.sofa, x + i * T, y + 8, 1, 5);
      P(ctx, pal.sofa, x - 1, y + 4, 3, 10); P(ctx, pal.sofa, x + w - 2, y + 4, 3, 10);
      return;
    case "armchair":
      P(ctx, pal.shadow, x + 2, y + 13, 12, 3);
      P(ctx, pal.cushion, x + 2, y, 12, 9); P(ctx, pal.cushionHi, x + 3, y + 1, 10, 2);
      P(ctx, pal.cushionHi, x + 3, y + 9, 10, 4);
      P(ctx, pal.cushion, x + 1, y + 5, 3, 9); P(ctx, pal.cushion, x + 12, y + 5, 3, 9);
      return;
    case "beanbag": {
      const c = pal.beanbag[(it.x * 3 + it.y) % pal.beanbag.length];
      P(ctx, pal.shadow, x + 2, y + 12, 12, 3);
      ellipse(ctx, c, x + 8, y + 9, 7, 5); disc(ctx, c, x + 8, y + 5, 5);
      P(ctx, "rgba(255,255,255,0.35)", x + 5, y + 3, 3, 2);
      return;
    }
    case "bench":
      P(ctx, pal.shadow, x + 2, y + 13, 12, 3);
      P(ctx, pal.gymDark, x + 2, y + 7, 12, 4); P(ctx, pal.gymMetal, x + 2, y + 7, 12, 1);
      P(ctx, pal.gymMetal, x + 4, y + 11, 1, 3); P(ctx, pal.gymMetal, x + 11, y + 11, 1, 3);
      return;
    case "yoga": { const c = pal.yoga[(it.x + it.y) % pal.yoga.length]; P(ctx, c, x + 1, y + 3, w - 2, 10); P(ctx, "rgba(255,255,255,0.3)", x + 2, y + 4, w - 4, 1); return; }
    case "whiteboard": P(ctx, pal.boardFrame, x - 1, y + 7, w + 2, 22); P(ctx, pal.board, x, y + 8, w, 19); P(ctx, pal.boardFrame, x + 2, y + 27, w - 4, 2); return;
    default:
  }
}

// ---- The park (baked) ----
function canopy(ctx, cols, cx, cy, r) {
  const blobs = [[-r * 0.45, r * 0.2, r * 0.62], [r * 0.45, r * 0.2, r * 0.62], [0, -r * 0.3, r * 0.7], [0, r * 0.25, r * 0.6]];
  for (const [dx, dy, rr] of blobs) disc(ctx, cols[0], Math.round(cx + dx), Math.round(cy + dy), Math.round(rr) + 1);
  for (const [dx, dy, rr] of blobs) disc(ctx, cols[1], Math.round(cx + dx), Math.round(cy + dy), Math.round(rr));
  disc(ctx, cols[2], Math.round(cx - r * 0.2), Math.round(cy - r * 0.3), Math.round(r * 0.5));
  disc(ctx, cols[3], Math.round(cx - r * 0.3), Math.round(cy - r * 0.45), Math.round(r * 0.22));
  P(ctx, cols[3], Math.round(cx + r * 0.3), Math.round(cy - r * 0.05), 2, 2);
}
function paintOutdoor(ctx, pal, it) {
  const x = it.x * T, y = it.y * T;
  switch (it.type) {
    case "tree": {
      const r = [13, 15, 11][it.v || 0];
      ellipse(ctx, pal.shadow, x + 9, y + 14, r - 2, 3);
      P(ctx, pal.trunkSh, x + 6, y + 3, 5, 12); P(ctx, pal.trunk, x + 6, y + 3, 3, 12);
      canopy(ctx, pal.canopy[it.v || 0], x + 8, y - 8, r);
      return;
    }
    case "pine": {
      const c = pal.pine[it.v || 0], cx = x + 8;
      ellipse(ctx, pal.shadow, cx + 1, y + 14, 8, 3);
      P(ctx, pal.trunkSh, cx - 2, y + 8, 4, 7); P(ctx, pal.trunk, cx - 2, y + 8, 2, 7);
      for (let layer = 0; layer < 3; layer++) {
        const by = y + 8 - layer * 9, hh = 13, half = 11 - layer * 2;
        for (let j = 0; j < hh; j++) {
          const ww = Math.round((half * (j + 1)) / hh);
          P(ctx, c[0], cx - ww - 1, by - hh + j, 2 * ww + 3, 1);
          P(ctx, c[1], cx - ww, by - hh + j, 2 * ww + 1, 1);
          if (ww > 1) P(ctx, c[2], cx - ww, by - hh + j, Math.max(1, ww - 1), 1);
        }
      }
      P(ctx, c[3], cx - 2, y - 26, 2, 2);
      return;
    }
    case "bush": ellipse(ctx, pal.shadow, x + 8, y + 14, 7, 2); disc(ctx, pal.bush[0], x + 5, y + 9, 5); disc(ctx, pal.bush[0], x + 11, y + 9, 5); disc(ctx, pal.bush[1], x + 5, y + 8, 4); disc(ctx, pal.bush[1], x + 11, y + 8, 4); P(ctx, pal.bush[2], x + 4, y + 5, 2, 2); P(ctx, pal.bush[2], x + 10, y + 6, 2, 1); return;
    case "flowers": {
      const c = pal.flower[it.hue || 0];
      for (const [dx, dy] of [[3, 4], [9, 3], [6, 9], [12, 10], [2, 12]]) { P(ctx, pal.bush[0], x + dx, y + dy + 2, 1, 2); P(ctx, c, x + dx - 1, y + dy, 3, 2); P(ctx, pal.flowerMid, x + dx, y + dy); }
      return;
    }
    case "rock": ellipse(ctx, pal.rock[0], x + 8, y + 11, 6, 4); ellipse(ctx, pal.rock[1], x + 7, y + 10, 5, 3); P(ctx, pal.rock[2], x + 5, y + 8, 3, 1); return;
    case "car": {
      const c = pal.car[it.color % pal.car.length], cx = x + 16, top = y + 3, up = it.dir === "up";
      P(ctx, pal.shadow, cx - 9, top + 2, 20, 28);
      P(ctx, pal.tire, cx - 10, top + 5, 2, 6); P(ctx, pal.tire, cx + 8, top + 5, 2, 6); P(ctx, pal.tire, cx - 10, top + 18, 2, 6); P(ctx, pal.tire, cx + 8, top + 18, 2, 6);
      P(ctx, c, cx - 8, top, 16, 27); P(ctx, "rgba(255,255,255,0.25)", cx - 7, top + 1, 2, 25);
      const wy = up ? top + 4 : top + 15;
      P(ctx, pal.carGlass, cx - 6, wy, 12, 5); P(ctx, c, cx - 6, up ? top + 9 : top + 9, 12, 6); P(ctx, pal.carGlass, cx - 6, up ? top + 15 : top + 4, 12, 4);
      P(ctx, pal.lampHead, cx - 7, up ? top : top + 25, 3, 2); P(ctx, pal.lampHead, cx + 4, up ? top : top + 25, 3, 2);
      return;
    }
    case "parkBench": {
      const w = it.w * T;
      P(ctx, pal.shadow, x + 1, y + 13, w - 2, 3);
      P(ctx, pal.benchDark, x + 2, y + 3, w - 4, 2); P(ctx, pal.bench, x + 2, y + 2, w - 4, 1);
      P(ctx, pal.bench, x + 1, y + 7, w - 2, 2); P(ctx, pal.bench, x + 1, y + 10, w - 2, 2);
      P(ctx, pal.benchDark, x + 3, y + 12, 2, 3); P(ctx, pal.benchDark, x + w - 5, y + 12, 2, 3);
      return;
    }
    case "lampPost": P(ctx, pal.shadow, x + 5, y + 13, 7, 2); P(ctx, pal.lampPole, x + 7, y - 14, 2, 28); P(ctx, pal.lampPole, x + 5, y + 12, 6, 2); P(ctx, pal.lampPole, x + 5, y - 17, 6, 3); P(ctx, pal.lampHead, x + 6, y - 14, 4, 2); return;
    default:
  }
}

export function paintStatic(map, pal) {
  const c = document.createElement("canvas");
  c.width = map.W * T; c.height = map.H * T;
  const ctx = c.getContext("2d");
  for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) floorTile(ctx, pal, map.floor[ty][tx], tx, ty, map);
  // The pond: a smooth oval with a sandy shore, lily pads and a highlight.
  const pd = map.pond, pcx = Math.round(pd.cx * T), pcy = Math.round(pd.cy * T), rx = Math.round(pd.rx * T), ry = Math.round(pd.ry * T);
  ellipse(ctx, pal.shadow, pcx, pcy + 2, rx + 4, ry + 4); ellipse(ctx, pal.shore, pcx, pcy, rx + 3, ry + 3);
  ellipse(ctx, pal.water[1], pcx, pcy, rx, ry); ellipse(ctx, pal.water[0], pcx, pcy + 3, rx - 5, ry - 5);
  P(ctx, pal.waterHi, pcx - rx + 10, pcy - ry + 6, Math.round(rx * 0.5), 1); P(ctx, pal.waterHi, pcx - rx + 16, pcy - ry + 9, Math.round(rx * 0.3), 1);
  for (const [fx, fy] of [[-0.45, 0.2], [0.35, -0.25], [0.55, 0.35], [-0.1, 0.45]]) {
    const lx = pcx + Math.round(fx * rx), ly = pcy + Math.round(fy * ry);
    disc(ctx, pal.lily, lx, ly, 4); P(ctx, pal.water[1], lx, ly - 4, 1, 4);
  }
  P(ctx, pal.flower[1], pcx + Math.round(0.35 * rx) + 1, pcy - Math.round(0.25 * ry) - 1, 2, 2);
  // Car park stalls.
  const pk = map.parking;
  if (pk) for (let i = 0; i <= pk.w / 2; i++) for (const sy of [pk.y, pk.y + 3]) P(ctx, pal.parkLine, (pk.x + i * 2) * T, sy * T + 1, 1, 2 * T - 2);
  // The "needs you" mat by the entrance.
  const m = map.mat;
  P(ctx, pal.mat, m.x * T + 1, m.y * T + 1, m.w * T - 2, m.h * T - 2);
  for (let yy = m.y * T + 5; yy < (m.y + m.h) * T - 3; yy += 6) P(ctx, pal.matStripe, m.x * T + 3, yy, m.w * T - 6, 1);
  ctx.strokeStyle = pal.matEdge; ctx.lineWidth = 1; ctx.strokeRect(m.x * T + 1.5, m.y * T + 1.5, m.w * T - 3, m.h * T - 3);
  paintWalls(ctx, map, pal);
  for (const it of map.items) paintFlat(ctx, pal, it);
  for (const it of map.outdoor) paintOutdoor(ctx, pal, it);
  return c;
}

// ---- Live parts ----
const CLOUDS = Array.from({ length: 6 }, (_, i) => ({ off: (i * 53) % 97, speed: 2 + (i % 3), y: 2 + ((i * 7) % 11), w: 8 + ((i * 5) % 7) }));
const STARS = Array.from({ length: 40 }, (_, i) => ({ x: (i * 37) % 101, y: (i * 23) % 17, ph: (i * 1.7) % 6.28 }));
const DRIVE = [{ lane: 0, speed: 38, off: 0, color: 1 }, { lane: 1, speed: -46, off: 400, color: 0 }, { lane: 0, speed: 30, off: 900, color: 2 }, { lane: 1, speed: -34, off: 1500, color: 3 }];

export function drawDynamic(ctx, map, pal, t, s) {
  // The sky in the top-wall windows: drifting clouds by day, twinkling stars by night.
  for (const w of map.windows) {
    const x = w.x * T + 3, y = w.y * T + 8, ww = w.w * T - 6, hh = 19;
    P(ctx, pal.sky[0], x, y, ww, hh); P(ctx, pal.sky[1], x, y + hh - 6, ww, 6);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, ww, hh); ctx.clip();
    if (pal.night) {
      for (const st of STARS) if ((st.x * 7 + w.x * 13) % 5 < 2) { const a = 0.4 + 0.6 * Math.max(0, Math.sin(t * 1.5 + st.ph + w.x)); ctx.globalAlpha = a; P(ctx, "#ffffff", x + ((st.x + w.x * 11) % ww), y + st.y % (hh - 3)); }
      ctx.globalAlpha = 1;
      if (w.x % 3 === 0) { disc(ctx, "#f4f1d6", x + ww - 7, y + 5, 3); disc(ctx, pal.sky[0], x + ww - 6, y + 4, 2); }
    } else {
      for (const cl of CLOUDS) {
        const cx = x + ((((t * cl.speed + cl.off + w.x * 17) % (ww + 30)) + ww + 30) % (ww + 30)) - 15;
        P(ctx, pal.cloud, cx, y + cl.y, cl.w, 3); P(ctx, pal.cloud, cx + 2, y + cl.y - 2, cl.w - 5, 2);
      }
    }
    ctx.restore();
    P(ctx, pal.winFrame, x + Math.floor(ww / 2), y, 1, hh); P(ctx, pal.winFrame, x, y + 8, ww, 1);
  }
  // Live whiteboard: the board columns as coloured sticky notes.
  const b = map.whiteboard;
  const cols = [["todo", pal.boardFrame], ["in_progress", "#45b8ff"], ["review", "#ffc94d"], ["blocked", "#ff4d5e"], ["done", "#3ddc84"]];
  const colW = Math.floor((b.w * T - 4) / cols.length), top = b.y * T + 10;
  cols.forEach(([k, color], i) => {
    const n = s.counts[k] || 0, cx = b.x * T + 2 + i * colW;
    if (i) P(ctx, pal.boardFrame, cx - 1, top, 1, 15);
    for (let j = 0; j < Math.min(n, 9); j++) P(ctx, color, cx + 1 + (j % 3) * 4, top + 1 + Math.floor(j / 3) * 5, 3, 3);
  });
  // Pulse the "needs you" mat while someone waits there.
  if (s.waiting) {
    const m = map.mat;
    ctx.globalAlpha = 0.18 + 0.15 * Math.sin(t * 4);
    P(ctx, pal.matEdge, m.x * T, m.y * T, m.w * T, m.h * T);
    ctx.globalAlpha = 1;
  }
  // Sparkles on the pond.
  const pd = map.pond;
  for (let i = 0; i < 4; i++) {
    const ph = (t * 0.6 + i * 0.37) % 1;
    const sx = Math.round((pd.cx + Math.sin(i * 2.1) * pd.rx * 0.5) * T), sy = Math.round((pd.cy + Math.cos(i * 1.3) * pd.ry * 0.4) * T);
    ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.9; P(ctx, pal.waterHi, sx, sy, 3, 1); P(ctx, pal.waterHi, sx + 1, sy - 1); ctx.globalAlpha = 1;
  }
  // Traffic on the street.
  const road = map.road, span = map.W * T + 80;
  for (const d of DRIVE) {
    const cx = ((((d.off + t * d.speed) % span) + span) % span) - 40;
    const cy = road.y * T + (d.lane ? 2 * T + 2 : 2), c = pal.car[d.color];
    P(ctx, pal.shadow, cx + 1, cy + 3, 30, 12);
    P(ctx, pal.tire, cx + 4, cy - 1, 6, 2); P(ctx, pal.tire, cx + 20, cy - 1, 6, 2); P(ctx, pal.tire, cx + 4, cy + 12, 6, 2); P(ctx, pal.tire, cx + 20, cy + 12, 6, 2);
    P(ctx, c, cx, cy, 30, 13); P(ctx, "rgba(255,255,255,0.25)", cx + 1, cy + 1, 28, 2);
    const front = d.speed > 0;
    P(ctx, pal.carGlass, front ? cx + 18 : cx + 7, cy + 2, 5, 9); P(ctx, pal.carGlass, front ? cx + 5 : cx + 21, cy + 2, 4, 9);
    P(ctx, pal.lampHead, front ? cx + 28 : cx, cy + 1, 2, 3); P(ctx, pal.lampHead, front ? cx + 28 : cx, cy + 9, 2, 3);
  }
  // Night: pools of light under the lamps.
  if (pal.night) {
    for (const l of map.lamps) glow(ctx, l.x * T + 8, l.y * T - 4, 34);
    for (const it of map.items) if (it.type === "lamp") glow(ctx, it.x * T + 8, it.y * T - 6, 22);
  }
}

function glow(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x, y, 1, x, y, r);
  g.addColorStop(0, "rgba(255,214,140,0.42)"); g.addColorStop(1, "rgba(255,214,140,0)");
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function pill(ctx, x, y, w, h) { const r = h / 2; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/** Department and room names, the sign over the door and the mat's label (vector text, crisp at any zoom). */
export function drawLabels(ctx, map, pal) {
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const l of map.labels) {
    const x = l.x * T, y = l.y * T;
    if (l.kind === "mat") { ctx.font = "700 5px system-ui, sans-serif"; ctx.fillStyle = pal.matEdge; ctx.fillText(l.text, x, y); continue; }
    const size = l.kind === "zone" ? 7 : l.kind === "sign" ? 5 : 5.5;
    ctx.font = `${l.kind === "room" ? 600 : 700} ${size}px system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(l.text).width) + size * 1.6, h = size + 4;
    ctx.fillStyle = l.kind === "sign" ? pal.signBg : pal.labelBg;
    if (l.kind === "sign") ctx.fillRect(x - w / 2, y - h / 2, w, h); else { pill(ctx, x - w / 2, y - h / 2, w, h); ctx.fill(); }
    ctx.fillStyle = l.kind === "sign" ? pal.signText : pal.labelText;
    ctx.fillText(l.text, x, y + 0.5);
  }
  ctx.textBaseline = "alphabetic";
}

/** Furniture people can stand behind: drawn depth-sorted with the people. */
export const SORTED = new Set(["pool", "cooler", "arcade", "desk", "table", "cafeTable", "roundTable", "sideTable", "plant", "rack", "terminal", "coffee", "fridge", "counter", "reception", "shelf", "screen", "wallTv", "easel", "tv", "treadmill", "weights", "pingpong", "lamp"]);

export function drawItem(ctx, pal, it, t, s) {
  const x = it.x * T, y = it.y * T, w = it.w * T, h = it.h * T;
  switch (it.type) {
    case "desk": {
      const exec = it.owner === "ceo";
      const top = exec ? pal.wood[0] : pal.desk, edge = exec ? pal.wood[2] : pal.deskEdge;
      P(ctx, pal.shadow, x + 1, y + 13, w - 1, 3);
      P(ctx, edge, x, y + 2, w, 11);
      P(ctx, top, x, y, w, 9); P(ctx, exec ? pal.wood[1] : pal.deskHi, x, y, w, 1);
      P(ctx, pal.deskLeg, x + 1, y + 12, 2, 3); P(ctx, pal.deskLeg, x + w - 3, y + 12, 2, 3);
      if (!exec && it.w === 2) P(ctx, pal.deskEdge, x + w - 1, y + 2, 1, 7);
      // Monitor on the desk's right tile, so the seated worker (on the left tile) stays in view.
      const on = it.owner == null ? "off" : s.monitors.get(it.owner) || "off";
      const mx = x + w - 15, my = y - 8;
      P(ctx, pal.bezel, mx, my, 14, 10); P(ctx, pal.bezel, mx + 6, my + 10, 2, 2); P(ctx, pal.bezel, mx + 4, my + 11, 6, 1);
      P(ctx, on === "alert" ? pal.screenAlert : on === "off" ? pal.screenOff : pal.screenOn, mx + 1, my + 1, 12, 8);
      if (on === "on") {
        for (let i = 0; i < 3; i++) P(ctx, pal.screenLine, mx + 2 + (i % 2) * 2, my + 2 + ((Math.floor(t * 4) + i * 2) % 6), 3 + ((i * 5 + Math.floor(t)) % 6), 1);
        if (Math.floor(t / 0.5) % 2 === 0) P(ctx, "#ffffff", mx + 2, my + 7, 1, 1);
      } else if (on === "alert" && Math.floor(t / 0.4) % 2 === 0) { P(ctx, "#ffffff", mx + 6, my + 2, 2, 3); P(ctx, "#ffffff", mx + 6, my + 6, 2, 1); }
      else P(ctx, "rgba(255,255,255,0.12)", mx + 2, my + 2, 3, 1);
      // Keyboard in front of the seat, and the owner's hands tapping while they work.
      const kx = x + (exec ? T + 3 : 3);
      P(ctx, pal.keyboard, kx, y + 3, 10, 3); P(ctx, pal.keyHi, kx + 1, y + 4, 8, 1);
      if (on === "on" && s.typing) { const k = Math.floor(t * 8) % 2; P(ctx, pal.skin, kx + 1 + k * 5, y + 2, 2, 2); }
      const hh = (it.x * 31 + it.y * 17) % 4;
      if (hh === 0) { P(ctx, pal.mug[(it.x + it.y) % 4], x + w - 5, y + 3, 3, 3); P(ctx, pal.mug[(it.x + it.y) % 4], x + w - 2, y + 4, 1, 1); }
      else if (hh === 1) { P(ctx, pal.clay, x + w - 5, y + 4, 3, 3); P(ctx, pal.leafMid, x + w - 6, y + 1, 5, 3); }
      else if (hh === 2) { P(ctx, "#ffffff", x + w - 6, y + 2, 4, 5); P(ctx, pal.deskEdge, x + w - 5, y + 3, 2, 1); }
      return;
    }
    case "table": case "roundTable": case "cafeTable": case "sideTable": {
      const cafe = it.type === "cafeTable", round = it.type !== "table";
      const topC = cafe ? pal.cafeTop : pal.tableTop, edgeC = cafe ? pal.cafeEdge : pal.tableEdge;
      P(ctx, pal.shadow, x + 2, y + h - 3, w - 3, 3);
      if (round) { ellipse(ctx, edgeC, x + w / 2, y + h / 2 + 1, w / 2 - 1, h / 2 - 2); ellipse(ctx, topC, x + w / 2, y + h / 2 - 1, w / 2 - 1, h / 2 - 3); }
      else { P(ctx, edgeC, x + 1, y + 3, w - 2, h - 4); P(ctx, topC, x + 1, y + 1, w - 2, h - 6); P(ctx, pal.table, x + 1, y + h - 5, w - 2, 1); }
      if (cafe) { P(ctx, pal.mug[1], x + 6, y + 4, 3, 3); P(ctx, pal.mug[0], x + w - 9, y + 5, 3, 3); }
      else if (it.type === "table") for (let i = 0; i < it.w; i += 2) P(ctx, "#ffffff", x + i * T + 10, y + 6, 6, 4);
      else if (it.type === "sideTable") P(ctx, pal.mug[2], x + 7, y + 5, 3, 3);
      return;
    }
    case "plant": {
      const tall = it.tall, sway = Math.round(Math.sin(t * 1.3 + it.x) * 0.6);
      P(ctx, pal.shadow, x + 3, y + 13, 10, 3);
      const potC = (it.x + it.y) % 2 ? pal.pot : pal.clay, potS = (it.x + it.y) % 2 ? pal.potSh : pal.claySh;
      P(ctx, potC, x + 4, y + 8, 8, 7); P(ctx, potS, x + 10, y + 8, 2, 7); P(ctx, potS, x + 4, y + 8, 8, 1);
      if (tall) {
        P(ctx, pal.trunk, x + 7, y - 8, 2, 16);
        for (const [lx, ly, c] of [[2, -14, 0], [8, -18, 1], [10, -11, 0], [3, -7, 1], [9, -4, 2], [5, -11, 2], [6, -16, 2], [1, -2, 0]]) { P(ctx, [pal.leaf, pal.leafMid, pal.leafHi][c], x + lx + sway, y + ly, 5, 4); }
      } else {
        for (const [lx, ly, c] of [[5, 2, 0], [8, 0, 1], [10, 3, 0], [2, 4, 1], [11, 6, 1], [7, 4, 2], [4, 6, 0], [9, 6, 2], [6, -1, 2]]) P(ctx, [pal.leaf, pal.leafMid, pal.leafHi][c], x + lx + (ly < 4 ? sway : 0), y + ly, 4, 4);
      }
      return;
    }
    case "rack": {
      P(ctx, pal.shadow, x + 1, y + h - 2, w, 3);
      P(ctx, pal.rack, x + 1, y - 4, w - 2, h + 4); P(ctx, pal.rackFace, x + 1, y - 4, w - 2, 1);
      for (let i = 0; i < 6; i++) {
        P(ctx, pal.rackFace, x + 2, y - 1 + i * 5, w - 4, 3);
        for (let j = 0; j < 3; j++) if (Math.sin(t * (2 + i + j) + i * 7 + j) > 0.2) P(ctx, j === 2 && i === 3 ? pal.ledA : pal.ledG, x + 3 + j * 3, y + i * 5, 1, 1);
      }
      return;
    }
    case "shelf": {
      // A tall bookcase; it rises above its tile so people stand in front of it.
      const top = y - 14, hh = h + 14;
      P(ctx, pal.shadow, x + 1, y + h - 2, w, 3);
      P(ctx, pal.shelf, x, top, w, hh); P(ctx, pal.tableTop, x, top, w, 1);
      for (let r = 0; r < 3; r++) {
        const ry = top + 2 + r * 9;
        P(ctx, pal.shelfIn, x + 2, ry, w - 4, 7);
        for (let bx = x + 3, k = 0; bx < x + w - 4; k++) {
          const bw = 2 + ((it.x * 7 + r * 5 + k * 3) % 2), bh = 5 + ((it.x + r + k) % 3 === 0 ? 0 : 1);
          P(ctx, pal.books[(it.x * 3 + it.y + r * 2 + k) % pal.books.length], bx, ry + 7 - bh, bw, bh);
          bx += bw + (k % 5 === 4 ? 2 : 0);
        }
      }
      return;
    }
    case "screen": case "wallTv": {
      // A screen on the wall; the boardroom's shows the run's progress while a meeting is on.
      const sx = x + 1, sy = y + 8, sw = w - 2, sh = 17;
      P(ctx, pal.bezel, sx, sy, sw, sh);
      const live = it.type === "wallTv" || s.meetingOn;
      P(ctx, live ? pal.screenOn : pal.screenOff, sx + 1, sy + 1, sw - 2, sh - 3);
      if (live) {
        const done = s.counts.done || 0, total = Object.values(s.counts).reduce((a, c) => a + c, 0) || 1;
        P(ctx, pal.screenLine, sx + 3, sy + sh - 5, Math.max(1, Math.round((sw - 6) * (it.type === "screen" ? done / total : 0.6))), 1);
        for (let i = 0; i < 3; i++) P(ctx, pal.screenLine, sx + 3, sy + 3 + i * 3, 4 + ((Math.floor(t * 2) + i * 3) % 12), 1);
      }
      return;
    }
    case "easel": {
      P(ctx, pal.boardFrame, x + 1, y + 7, w - 2, 20); P(ctx, pal.cork, x + 2, y + 8, w - 4, 18);
      for (let i = 0; i < 6; i++) P(ctx, pal.note[i % 4], x + 4 + (i % 3) * 9, y + 10 + Math.floor(i / 3) * 8, 6, 5);
      return;
    }
    case "counter": {
      P(ctx, pal.counter, x, y + 3, w, h - 3); P(ctx, pal.counterTop, x, y, w, 5); P(ctx, pal.wallFaceSh, x, y + 5, w, 1);
      for (let i = 0; i < it.w; i++) { P(ctx, pal.mug[i % 4], x + i * T + 4, y + 1, 3, 3); if (i % 2) P(ctx, pal.cafeEdge, x + i * T + 9, y + 1, 5, 2); }
      return;
    }
    case "coffee": {
      P(ctx, pal.machine, x + 2, y - 6, 12, 21); P(ctx, pal.bezel, x + 4, y - 4, 8, 4); P(ctx, pal.ledR, x + 11, y - 3, 1, 1);
      P(ctx, "#111", x + 5, y + 4, 6, 5); P(ctx, "#ffffff", x + 6, y + 6, 4, 3);
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.8 + i / 3) % 1;
        ctx.globalAlpha = 0.5 * (1 - ph);
        P(ctx, "#e6ecef", x + 7 + Math.round(Math.sin((t + i) * 3)), y + 2 - ph * 10, 2, 2);
        ctx.globalAlpha = 1;
      }
      return;
    }
    case "fridge": P(ctx, pal.shadow, x + 1, y + 13, 14, 3); P(ctx, pal.fridge, x + 1, y - 12, 14, 27); P(ctx, pal.fridgeSh, x + 1, y - 3, 14, 1); P(ctx, pal.fridgeSh, x + 12, y - 10, 1, 5); P(ctx, pal.fridgeSh, x + 12, y - 1, 1, 6); P(ctx, pal.note[0], x + 4, y - 9, 4, 4); return;
    case "reception": {
      P(ctx, pal.shadow, x + 1, y + 13, w - 1, 3);
      P(ctx, pal.reception, x, y - 2, w, 6); P(ctx, pal.deskHi, x, y - 2, w, 1);
      P(ctx, pal.receptionFront, x, y + 4, w, 10); P(ctx, pal.receptionFrontSh, x, y + 12, w, 2);
      ctx.fillStyle = "#ffffff"; ctx.font = "700 5px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("REDPI", x + w / 2, y + 8.5); ctx.textBaseline = "alphabetic";
      P(ctx, pal.clay, x + 4, y - 3, 3, 3); P(ctx, pal.leafMid, x + 3, y - 6, 5, 3);
      P(ctx, pal.bezel, x + w - 14, y - 9, 10, 7); P(ctx, pal.screenOn, x + w - 13, y - 8, 8, 5);
      return;
    }
    case "pool": {
      P(ctx, pal.shadow, x + 2, y + h - 3, w - 2, 3);
      P(ctx, pal.tableEdge, x, y + 1, w, h - 4); P(ctx, "#2f8f68", x + 3, y + 4, w - 6, h - 10);
      P(ctx, pal.trunkSh, x + 1, y + h - 4, 3, 3); P(ctx, pal.trunkSh, x + w - 4, y + h - 4, 3, 3);
      for (const [px2, py2] of [[3, 4], [w / 2 - 1, 3], [w - 5, 4], [3, h - 8], [w / 2 - 1, h - 7], [w - 5, h - 8]]) P(ctx, "#1d2027", x + px2, y + py2, 2, 2);
      for (const [bx, by, c] of [[10, 9, "#ffffff"], [28, 8, "#f2b33d"], [31, 11, "#d6453f"], [26, 12, "#4f8fe0"], [33, 14, "#2b2730"]]) P(ctx, c, x + bx, y + by, 2, 2);
      return;
    }
    case "cooler":
      P(ctx, pal.shadow, x + 3, y + 13, 10, 3);
      P(ctx, pal.fridge, x + 4, y, 8, 14); P(ctx, pal.fridgeSh, x + 10, y, 2, 14); P(ctx, pal.bezel, x + 6, y + 3, 4, 2);
      P(ctx, "#8fd3f4", x + 4, y - 10, 8, 10); P(ctx, "#b9e6fa", x + 5, y - 9, 2, 7); P(ctx, "#5fb6e0", x + 6, y - 12, 4, 2);
      return;
    case "arcade": {
      P(ctx, pal.shadow, x + 1, y + 13, 14, 3);
      const body = ["#e35d8c", "#4f8fe0", "#f2b33d"][it.x % 3];
      P(ctx, body, x + 1, y - 14, 14, 28); P(ctx, tone2(body), x + 12, y - 14, 3, 28);
      P(ctx, pal.bezel, x + 3, y - 11, 10, 9);
      const f = Math.floor(t * 4 + it.x);
      P(ctx, "#162a52", x + 4, y - 10, 8, 7); P(ctx, ["#3ddc84", "#ffc94d", "#ff4d5e"][f % 3], x + 5 + (f % 5), y - 8 + (f % 3), 2, 2);
      P(ctx, pal.bezel, x + 2, y, 12, 4); P(ctx, "#ff4d5e", x + 4, y + 1, 2, 2); P(ctx, "#ffc94d", x + 9, y + 1, 2, 2);
      return;
    }
    case "lamp": P(ctx, pal.shadow, x + 4, y + 13, 8, 2); P(ctx, pal.lampPole, x + 7, y - 6, 2, 19); P(ctx, pal.lampPole, x + 5, y + 12, 6, 2); P(ctx, pal.night ? pal.lampHead : pal.cushionHi, x + 3, y - 12, 10, 7); P(ctx, pal.cushion, x + 3, y - 6, 10, 1); return;
    case "tv": {
      // A TV on a low stand with a console; a game plays while someone holds a controller.
      P(ctx, pal.shadow, x + 1, y + 13, w - 2, 3);
      P(ctx, pal.tableEdge, x + 2, y + 9, w - 4, 5); P(ctx, pal.bezel, x + 10, y + 10, 8, 3); P(ctx, pal.ledG, x + 16, y + 11, 1, 1);
      P(ctx, pal.bezel, x, y - 8, w, 16);
      const on = s.gaming;
      P(ctx, on ? "#162a52" : pal.screenOff, x + 1, y - 7, w - 2, 13);
      if (on) {
        const f = Math.floor(t * 6);
        P(ctx, "#3ddc84", x + 3, y + 2, w - 6, 1);
        P(ctx, "#ffc94d", x + 4 + (f % 18), y - 1 - (f % 6 < 3 ? f % 3 : 3 - (f % 3)), 3, 3);
        P(ctx, "#ff4d5e", x + w - 6 - ((f * 2) % 20), y - 1, 2, 3);
        for (let i = 0; i < 3; i++) P(ctx, "#9fd8ff", x + 3 + ((i * 11 + f) % (w - 6)), y - 5 + i, 1, 1);
      }
      return;
    }
    case "pingpong": {
      P(ctx, pal.shadow, x + 2, y + h - 3, w - 2, 3);
      P(ctx, pal.gymDark, x + 3, y + h - 4, 2, 3); P(ctx, pal.gymDark, x + w - 5, y + h - 4, 2, 3);
      P(ctx, pal.pongTable, x + 1, y + 2, w - 2, h - 7); P(ctx, pal.pongLine, x + 1, y + 2, w - 2, 1); P(ctx, pal.pongLine, x + 1, y + h - 6, w - 2, 1);
      P(ctx, pal.pongLine, x + 1, y + Math.floor(h / 2) - 2, w - 2, 1);
      P(ctx, pal.gymMetal, x + Math.floor(w / 2), y, 1, h - 5); P(ctx, "#ffffff", x + Math.floor(w / 2) - 1, y, 3, 1);
      if (s.pong >= 2) {
        const ph = (t * 1.6) % 2, k = ph < 1 ? ph : 2 - ph;
        const bx = x + 4 + k * (w - 8), by = y + 6 + k * (h - 14) - Math.sin(k * Math.PI) * 6;
        P(ctx, "#ffffff", Math.round(bx), Math.round(by), 2, 2);
      }
      return;
    }
    case "treadmill": {
      P(ctx, pal.shadow, x + 1, y + 13, 14, 3);
      P(ctx, pal.gymDark, x + 2, y + 2, 12, 12); P(ctx, "#1d2027", x + 3, y + 3, 10, 10);
      const run = s.treadmills?.has(`${it.x},${it.y}`);
      for (let i = 0; i < 3; i++) P(ctx, pal.gymMetal, x + 3, y + 3 + ((i * 4 + (run ? Math.floor(t * 12) : 0)) % 10), 10, 1);
      P(ctx, pal.gymMetal, x + 2, y - 8, 1, 11); P(ctx, pal.gymMetal, x + 13, y - 8, 1, 11);
      P(ctx, pal.gymDark, x + 3, y - 10, 10, 4); P(ctx, run ? pal.ledG : pal.screenOff, x + 6, y - 9, 4, 2);
      return;
    }
    case "weights":
      P(ctx, pal.shadow, x + 1, y + 13, 14, 3); P(ctx, pal.gymDark, x + 2, y - 6, 12, 20);
      for (let i = 0; i < 3; i++) { P(ctx, pal.gymMetal, x + 3, y - 3 + i * 6, 10, 1); P(ctx, "#1d2027", x + 3, y - 5 + i * 6, 3, 3); P(ctx, "#1d2027", x + 10, y - 5 + i * 6, 3, 3); }
      return;
    case "terminal": {
      P(ctx, pal.shadow, x + 2, y + 13, 12, 3);
      P(ctx, pal.terminal, x + 6, y + 6, 4, 8); P(ctx, pal.terminal, x + 4, y + 13, 8, 2);
      P(ctx, pal.terminal, x + 1, y - 6, 14, 13);
      P(ctx, s.humanPing > 0 ? "#ffc94d" : pal.matEdge, x + 2, y - 5, 12, 10);
      ctx.fillStyle = s.humanPing > 0 ? "#2b3040" : "#ffffff"; ctx.font = "700 5px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("YOU", x + 8, y + 0.5); ctx.textBaseline = "alphabetic";
      return;
    }
    default:
  }
}
