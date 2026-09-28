// RedPi Office tileset: original pixel art, painted in code (no image assets).
// paintStatic() bakes the room once into an offscreen canvas; drawDynamic() paints
// the moving parts each frame (window rain, desk monitors, rack LEDs, coffee
// steam, the live whiteboard, the "needs you" mat).
import { TILE } from "./map.js";

const PALETTES = {
  dark: {
    wood: ["#18281e", "#1b2d22", "#132019"], carpet: ["#10201a", "#142820"], cafe: ["#1c2a24", "#16221d"],
    archive: ["#141c22", "#10171c"], meet: ["#1a1830", "#1f1c38"], sign: "#45e3ff",
    shelf: "#3b2c20", shelfIn: "#1a130d", books: ["#b84a3e", "#3e7cb8", "#c9a13b", "#4c9a61", "#8e5bb0", "#d7d0bf"],
    wall: "#08110c", wallFace: "#0d1a13", trim: "#1f8f52", sill: "#1a3325",
    glassWin: "#041009", rain: "#3dff8f", rainDim: "#1b6b3e",
    desk: "#5a4330", deskTop: "#6b513a", deskEdge: "#3a2a1c", bezel: "#0f1713", screenOff: "#0a120e", screenOn: "#0b3a22", screenLine: "#3dff8f",
    chair: "#22342a", chairSeat: "#2e4a3a",
    glass: "rgba(69,227,255,0.14)", glassFrame: "#2b8fa3",
    pot: "#7a5236", leaf: "#2f8f55", leafHi: "#48c46f",
    rack: "#0c1410", rackFace: "#16221c", ledG: "#3dff8f", ledR: "#ff4d5e", ledA: "#ffc94d",
    table: "#4a3626", tableTop: "#5c4330", counter: "#26312c", counterTop: "#33413a", machine: "#2a2f33",
    board: "#dfe9e2", boardFrame: "#6f8a78", ink: "#0e1f15",
    terminal: "#0f1813", mat: "#3a1116", matEdge: "#ff4d5e", text: "#d9f7e3", shadow: "rgba(0,0,0,0.35)",
  },
  light: {
    wood: ["#e7ddcb", "#e1d5c0", "#d6c8b0"], carpet: ["#dfe8e1", "#d6e1d9"], cafe: ["#eef1ec", "#e3e8e1"],
    archive: ["#d9dfe4", "#cfd6dc"], meet: ["#e3e0f2", "#d9d5ec"], sign: "#0a7f9c",
    shelf: "#8a6645", shelfIn: "#5b4330", books: ["#c0584c", "#4b87c0", "#d2a943", "#56a36b", "#9565b8", "#f4efe2"],
    wall: "#9fb3a6", wallFace: "#c7d6cc", trim: "#0f9d58", sill: "#aac1b3",
    glassWin: "#0d2a1b", rain: "#46ff99", rainDim: "#1f7a47",
    desk: "#a07a55", deskTop: "#b88e64", deskEdge: "#7a5a3c", bezel: "#2a332e", screenOff: "#1a221e", screenOn: "#0d4a2b", screenLine: "#5dffa1",
    chair: "#5f7568", chairSeat: "#78907f",
    glass: "rgba(10,138,176,0.10)", glassFrame: "#5aa9bd",
    pot: "#a06a44", leaf: "#2f9a5c", leafHi: "#5fd38a",
    rack: "#2a3430", rackFace: "#3a4640", ledG: "#1fd46e", ledR: "#e0303f", ledA: "#e2a52a",
    table: "#9b7650", tableTop: "#b08860", counter: "#8fa397", counterTop: "#a9bcb0", machine: "#4a5258",
    board: "#ffffff", boardFrame: "#8aa596", ink: "#102218",
    terminal: "#26302b", mat: "#f3d4d7", matEdge: "#d9303f", text: "#102218", shadow: "rgba(0,0,0,0.18)",
  },
};

export function palette(theme) { return PALETTES[theme] || PALETTES.dark; }

const px = (ctx, color, x, y, w = 1, h = 1) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };

function floorTile(ctx, pal, kind, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  if (kind === "wood") {
    px(ctx, pal.wood[(tx + ty) % 2], x, y, TILE, TILE);
    for (let i = 0; i < 4; i++) px(ctx, pal.wood[2], x, y + i * 4 + 3, TILE, 1);          // plank seams
    px(ctx, pal.wood[2], x + ((ty * 5) % TILE), y, 1, 4); px(ctx, pal.wood[2], x + ((ty * 11 + 7) % TILE), y + 8, 1, 4);
  } else if (kind === "carpet") {
    px(ctx, pal.carpet[0], x, y, TILE, TILE);
    for (let i = 0; i < TILE; i += 4) for (let j = (i / 4) % 2 ? 2 : 0; j < TILE; j += 4) px(ctx, pal.carpet[1], x + j, y + i, 1, 1);
  } else if (kind === "archive") {
    px(ctx, pal.archive[0], x, y, TILE, TILE);
    px(ctx, pal.archive[1], x, y, TILE, 1); px(ctx, pal.archive[1], x, y, 1, TILE);
    px(ctx, pal.archive[1], x + 8, y + 8, 1, 1);
  } else if (kind === "meet") {
    px(ctx, pal.meet[0], x, y, TILE, TILE);
    for (let i = 0; i < TILE; i += 4) px(ctx, pal.meet[1], x + ((i / 4) % 2 ? 2 : 0), y + i, TILE - 2, 1);
  } else {
    px(ctx, pal.cafe[(tx + ty) % 2], x, y, TILE, TILE);
    px(ctx, pal.wood[2], x, y, TILE, 1); px(ctx, pal.wood[2], x, y, 1, TILE);
  }
}

export function paintStatic(map, pal) {
  const c = document.createElement("canvas");
  c.width = map.W * TILE; c.height = map.H * TILE;
  const ctx = c.getContext("2d");
  // Floors by zone: carpet in the work area, wood in the CEO office and lounge, tiles in
  // the cafeteria, plain tiles in the files room, patterned carpet in the meeting room.
  const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  for (let ty = 0; ty < map.H; ty++) for (let tx = 0; tx < map.W; tx++) {
    const cafe = ty >= map.lounge.y && tx >= map.W - 10;
    const work = ty < map.lounge.y && tx >= 11;
    const kind = inside(map.files, tx, ty) ? "archive" : inside(map.meeting, tx, ty) ? "meet" : cafe ? "cafe" : work ? "carpet" : "wood";
    floorTile(ctx, pal, kind, tx, ty);
  }
  // "Needs you" mat by the entrance.
  const m = map.mat;
  px(ctx, pal.mat, m.x * TILE, m.y * TILE, m.w * TILE, m.h * TILE);
  for (let i = 0; i < m.w * TILE; i += 6) px(ctx, pal.matEdge, m.x * TILE + i, m.y * TILE + 2, 3, 1);
  ctx.strokeStyle = pal.matEdge; ctx.lineWidth = 1; ctx.strokeRect(m.x * TILE + 0.5, m.y * TILE + 0.5, m.w * TILE - 1, m.h * TILE - 1);
  ctx.fillStyle = pal.matEdge; ctx.font = "bold 6px monospace"; ctx.textAlign = "center";
  ctx.fillText("NEEDS YOU", (m.x + m.w / 2) * TILE, (m.y + m.h) * TILE - 4);

  // Walls: top wall face with trim; windows in the work area; side/bottom walls.
  px(ctx, pal.wall, 0, 0, map.W * TILE, TILE / 2);
  px(ctx, pal.wallFace, 0, TILE / 2, map.W * TILE, TILE * 1.5);
  px(ctx, pal.trim, 0, 2 * TILE - 2, map.W * TILE, 1);
  px(ctx, pal.wall, 0, 0, TILE / 2, map.H * TILE);
  px(ctx, pal.wall, map.W * TILE - TILE / 2, 0, TILE / 2, map.H * TILE);
  px(ctx, pal.wall, 0, (map.H - 1) * TILE + TILE / 2, map.W * TILE, TILE / 2);
  px(ctx, pal.wallFace, 0, (map.H - 1) * TILE, map.W * TILE, TILE / 2);
  // Entrance: a gap in the bottom wall with a threshold.
  const d = map.door;
  px(ctx, pal.wood[2], d.x * TILE, (map.H - 1) * TILE, d.w * TILE, TILE);
  px(ctx, pal.matEdge, d.x * TILE, (map.H - 1) * TILE, d.w * TILE, 1);
  for (const w of windows(map)) {
    px(ctx, pal.sill, w.x - 1, w.y - 1, w.w + 2, w.h + 3);
    px(ctx, pal.glassWin, w.x, w.y, w.w, w.h);
    px(ctx, pal.sill, w.x + Math.floor(w.w / 2), w.y, 1, w.h);
  }
  // Room signs: high on the wall above the files room (clear of the tall shelves), and
  // on the meeting room's bottom glass wall.
  ctx.font = "bold 6px monospace"; ctx.textAlign = "center"; ctx.fillStyle = pal.sign;
  ctx.fillText("FILES · SERVERS", (map.files.x + map.files.w / 2) * TILE, 15);
  ctx.fillText("MEETING", (map.meeting.x + map.meeting.w / 2) * TILE, (map.meeting.y + map.meeting.h) * TILE + 15);

  // Flat things characters never walk behind: chairs, glass walls, whiteboard frame.
  for (const it of map.items) {
    const x = it.x * TILE, y = it.y * TILE, w = it.w * TILE, h = it.h * TILE;
    if (it.type === "chair" && it.back) {
      // Seen from behind: the backrest faces the viewer.
      px(ctx, pal.chairSeat, x + 4, y + 4, 8, 4);
      px(ctx, pal.chair, x + 4, y + 8, 8, 6);
      px(ctx, pal.chair, x + 5, y + 14, 1, 2); px(ctx, pal.chair, x + 10, y + 14, 1, 2);
    } else if (it.type === "chair") {
      px(ctx, pal.chair, x + 4, y + 2, 8, 9);
      px(ctx, pal.chairSeat, x + 4, y + 9, 8, 4);
      px(ctx, pal.chair, x + 5, y + 13, 1, 2); px(ctx, pal.chair, x + 10, y + 13, 1, 2);
    } else if (it.type === "glassV" || it.type === "glassH") {
      const v = it.type === "glassV";
      for (let i = 0; i < Math.max(it.w, it.h); i++) {
        if ((it.gaps || []).includes(v ? it.y + i : it.x + i)) continue;
        const gx = v ? x + 6 : x + i * TILE, gy = v ? y + i * TILE : y + 6;
        ctx.fillStyle = pal.glass; ctx.fillRect(gx, gy, v ? 4 : TILE, v ? TILE : 4);
        px(ctx, pal.glassFrame, gx, gy, v ? 1 : TILE, v ? TILE : 1);
      }
    } else if (it.type === "whiteboard") {
      px(ctx, pal.boardFrame, x - 1, y + 3, w + 2, h - 3);
      px(ctx, pal.board, x, y + 4, w, h - 6);
    }
  }
  return c;
}

function windows(map) {
  const out = [];
  for (let x = 12; x + 3 < map.files.x - 1; x += 5) out.push({ x: x * TILE, y: 4, w: 3 * TILE, h: 18 });
  return out;
}

// Deterministic "digital rain" columns for the windows.
const RAIN = Array.from({ length: 64 }, (_, i) => ({ col: (i * 37) % 997, speed: 10 + ((i * 13) % 17), off: (i * 53) % 29 }));

export function drawDynamic(ctx, map, pal, t, s) {
  // Window rain.
  for (const w of windows(map)) {
    for (let i = 0; i < Math.floor(w.w / 3); i++) {
      const r = RAIN[(i + w.x) % RAIN.length];
      const head = ((t * r.speed + r.off) % (w.h + 10)) - 5;
      for (let k = 0; k < 4; k++) {
        const yy = Math.floor(head - k * 2);
        if (yy < 0 || yy >= w.h) continue;
        px(ctx, k === 0 ? pal.rain : pal.rainDim, w.x + i * 3 + 1, w.y + yy, 1, 1);
      }
    }
  }
  // Live whiteboard: the board columns as coloured sticky notes.
  const b = map.whiteboard;
  const cols = [["todo", pal.boardFrame], ["in_progress", "#45e3ff"], ["review", "#ffc94d"], ["blocked", "#ff4d5e"], ["done", "#3dff8f"]];
  const colW = Math.floor((b.w * TILE - 4) / cols.length);
  cols.forEach(([k, color], i) => {
    const n = s.counts[k] || 0;
    const cx = b.x * TILE + 2 + i * colW;
    px(ctx, pal.boardFrame, cx + colW - 1, b.y * TILE + 5, 1, b.h * TILE - 8);
    for (let j = 0; j < Math.min(n, 8); j++) px(ctx, color, cx + 1 + (j % 3) * 4, b.y * TILE + 6 + Math.floor(j / 3) * 5, 3, 3);
    if (n > 8) { ctx.fillStyle = pal.ink; ctx.font = "5px monospace"; ctx.textAlign = "left"; ctx.fillText(`+${n - 8}`, cx + 1, b.y * TILE + 26); }
  });
  // Pulse the "needs you" mat while someone waits there.
  if (s.waiting) {
    const m = map.mat;
    ctx.globalAlpha = 0.25 + 0.2 * Math.sin(t * 4);
    px(ctx, pal.matEdge, m.x * TILE, m.y * TILE, m.w * TILE, m.h * TILE);
    ctx.globalAlpha = 1;
  }
}

/** Furniture characters can stand behind: drawn depth-sorted with the people. */
export const SORTED = new Set(["desk", "table", "cafeTable", "plant", "rack", "terminal", "coffee", "counter", "shelf", "screen"]);

export function drawItem(ctx, pal, it, t, s) {
  const x = it.x * TILE, y = it.y * TILE, w = it.w * TILE, h = it.h * TILE;
  if (it.type === "desk") {
    px(ctx, pal.shadow, x + 2, y + h - 2, w - 2, 3);
    px(ctx, pal.deskEdge, x, y + 3, w, h - 3);
    px(ctx, pal.deskTop, x, y + 1, w, h - 6);
    px(ctx, pal.desk, x, y + h - 6, w, 2);
    px(ctx, pal.deskEdge, x + 1, y + h - 3, 2, 3); px(ctx, pal.deskEdge, x + w - 3, y + h - 3, 2, 3);
    // Monitor (seen from behind the screen's edge, facing its owner): lit while they work.
    const on = s.monitors.get(it.owner) || "off";
    // Monitor on the desk's right tile, so the seated worker (on the left tile) stays in view.
    const mx = x + w - 15, my = y - 6;
    px(ctx, pal.bezel, mx, my, 14, 9);
    px(ctx, pal.bezel, mx + 6, my + 9, 2, 2);
    px(ctx, on === "alert" ? "#3a0d13" : on === "off" ? pal.screenOff : pal.screenOn, mx + 1, my + 1, 12, 7);
    if (on === "on") {
      for (let i = 0; i < 3; i++) px(ctx, pal.screenLine, mx + 2, my + 1 + ((Math.floor(t * 4) + i * 3) % 7), 3 + ((i * 5 + Math.floor(t)) % 8), 1);
      if (Math.floor(t / 0.5) % 2 === 0) px(ctx, "#ffffff", mx + 2, my + 6, 1, 1);
    } else if (on === "alert" && Math.floor(t / 0.4) % 2 === 0) {
      px(ctx, pal.ledR, mx + 6, my + 2, 2, 3); px(ctx, pal.ledR, mx + 6, my + 6, 2, 1);
    }
    // Keyboard, and the owner's hands tapping while they work.
    const kx = x + (it.owner === "ceo" ? TILE + 3 : 3);   // keyboard in front of the seat
    px(ctx, pal.bezel, kx, y + 3, 10, 2);
    if (on === "on" && s.typing) { const k = Math.floor(t * 8) % 2; px(ctx, "#e8c8a8", kx + 1 + k * 5, y + 2, 2, 1); }
  } else if (it.type === "table" || it.type === "cafeTable") {
    px(ctx, pal.shadow, x + 2, y + h - 2, w - 2, 3);
    px(ctx, pal.table, x + 1, y + 3, w - 2, h - 4);
    px(ctx, pal.tableTop, x + 1, y + 1, w - 2, h - 6);
    if (it.type === "cafeTable") px(ctx, "#f2ede2", x + w / 2 - 2, y + 2, 4, 3);
  } else if (it.type === "plant") {
    px(ctx, pal.shadow, x + 3, y + 13, 10, 3);
    px(ctx, pal.pot, x + 4, y + 9, 8, 6); px(ctx, pal.deskEdge, x + 4, y + 9, 8, 1);
    const sway = Math.round(Math.sin(t * 1.3 + it.x) * 0.6);
    for (const [lx, ly, c] of [[5, 3, 0], [8, 1, 1], [10, 4, 0], [3, 6, 1], [11, 7, 1], [7, 5, 0], [6, 7, 1], [9, 6, 0]]) px(ctx, c ? pal.leafHi : pal.leaf, x + lx + (ly < 5 ? sway : 0), y + ly, 3, 3);
  } else if (it.type === "rack") {
    px(ctx, pal.shadow, x + 1, y + h - 2, w, 3);
    px(ctx, pal.rack, x + 1, y, w - 2, h);
    for (let i = 0; i < 6; i++) {
      px(ctx, pal.rackFace, x + 2, y + 3 + i * 5, w - 4, 3);
      for (let j = 0; j < 3; j++) if (Math.sin(t * (2 + i + j) + i * 7 + j) > 0.2) px(ctx, j === 2 && i === 3 ? pal.ledA : pal.ledG, x + 3 + j * 3, y + 4 + i * 5, 1, 1);
    }
  } else if (it.type === "shelf") {
    // A tall bookcase of binders and files; it rises above its tile so people stand in front.
    const top = y - 14, hh = h + 14;
    px(ctx, pal.shadow, x + 1, y + h - 2, w, 3);
    px(ctx, pal.shelf, x, top, w, hh);
    for (let r = 0; r < 3; r++) {
      const ry = top + 2 + r * 9;
      px(ctx, pal.shelfIn, x + 2, ry, w - 4, 7);
      for (let bx = x + 3, k = 0; bx < x + w - 4; k++) {
        const bw = 2 + ((it.x * 7 + r * 5 + k * 3) % 2), bh = 5 + ((it.x + r + k) % 3 === 0 ? 0 : 1);
        px(ctx, pal.books[(it.x * 3 + it.y + r * 2 + k) % pal.books.length], bx, ry + 7 - bh, bw, bh);
        bx += bw + ((k % 5 === 4) ? 2 : 0);
      }
    }
  } else if (it.type === "screen") {
    px(ctx, pal.shadow, x + 3, y + 13, 10, 3);
    px(ctx, pal.bezel, x + 7, y + 4, 2, 10);
    px(ctx, pal.bezel, x + 2, y - 4, 12, 9);
    px(ctx, pal.screenOff, x + 3, y - 3, 10, 7);
    // Lit with the run's progress while a meeting is on.
    if (s.meetingOn) {
      const done = s.counts.done || 0, total = Object.values(s.counts).reduce((a, b) => a + b, 0) || 1;
      px(ctx, pal.screenOn, x + 3, y - 3, 10, 7);
      px(ctx, pal.screenLine, x + 4, y + 2, Math.max(1, Math.round(8 * done / total)), 1);
      for (let i = 0; i < 2; i++) px(ctx, pal.screenLine, x + 4, y - 2 + i * 2, 3 + ((Math.floor(t * 2) + i * 3) % 5), 1);
    }
  } else if (it.type === "counter") {
    px(ctx, pal.counter, x, y + 2, w, h - 2); px(ctx, pal.counterTop, x, y + 1, w, 4);
    for (let i = 0; i < it.w; i++) px(ctx, "#f2ede2", x + i * TILE + 5, y + 2, 4, 3);
  } else if (it.type === "coffee") {
    px(ctx, pal.machine, x + 2, y, 12, 15); px(ctx, "#111", x + 5, y + 8, 6, 4); px(ctx, pal.ledR, x + 11, y + 2, 1, 1);
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.8 + i / 3) % 1;
      ctx.globalAlpha = 0.5 * (1 - ph);
      px(ctx, "#d7e2dc", x + 7 + Math.round(Math.sin((t + i) * 3)), y + 6 - ph * 10, 2, 2);
      ctx.globalAlpha = 1;
    }
  } else if (it.type === "terminal") {
    px(ctx, pal.shadow, x + 2, y + 13, 12, 3);
    px(ctx, pal.terminal, x + 3, y + 1, 10, 13);
    px(ctx, s.humanPing > 0 ? "#ffc94d" : pal.matEdge, x + 4, y + 2, 8, 6);
    ctx.fillStyle = s.humanPing > 0 ? "#102218" : "#ffffff"; ctx.font = "bold 5px monospace"; ctx.textAlign = "center"; ctx.fillText("YOU", x + 8, y + 7);
  }
}
