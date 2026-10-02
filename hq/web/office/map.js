// RedPi Office layout generator (original RedPi code, no third-party map data).
//
// The office is a building in a small park. Outside: lawns and trees, a path from the front
// door to the street, a car park and a pond, so the floor always fills the screen (the camera
// never shows past the edge of the world). Inside, three bands around cream-tiled corridors:
//   - top: the CEO's glass office (with the live whiteboard), a glass boardroom where teammates
//     talk, the library (files: where research happens), the server room (where builds and
//     tests run), and, on wider floors, a huddle room, focus room, wellness room and studio;
//   - middle: one open-plan zone per department (Engineering, Design, Research & Data,
//     Review & QA, Platform & Ops, Security, Docs & Content), picked from each worker's role,
//     with benches of two desks, and breakout nooks in the space left over;
//   - bottom: the lobby with the front door, the "needs you" mat and the YOU terminal, the café
//     (people waiting on a build sit here with a coffee), and the lounge (games, ping-pong,
//     gym and a reading corner) for anyone with nothing left to do.
// Every shared area grows with the team. Returns the furniture list, floor and wall grids for
// the painter, a walkability grid for pathfinding, labels, and named spots.

export const TILE = 16;

// Display order. `re` picks a department from a role; Engineering takes everything else.
export const DEPARTMENTS = [
  { key: "eng", name: "Engineering" },
  { key: "design", name: "Design", re: /design|\bui\b|\bux\b|brand|illustrat|visual/ },
  { key: "data", name: "Research & Data", re: /data|research|analy|\bai\b|\bml\b|machine learning|scien|llm/ },
  { key: "qa", name: "Review & QA", re: /review|\bqa\b|test|audit|verif/ },
  { key: "ops", name: "Platform & Ops", re: /devops|infra|\bsre\b|platform|\bops\b|cloud|deploy|release/ },
  { key: "security", name: "Security", re: /secur|pentest|red.?team|cyber/ },
  { key: "docs", name: "Docs & Content", re: /writ|\bdocs?\b|document|content|market|copy/ },
];
const MATCH_ORDER = ["security", "qa", "ops", "data", "design", "docs"];

export function department(role) {
  const r = String(role || "").toLowerCase();
  for (const key of MATCH_ORDER) if (DEPARTMENTS.find((d) => d.key === key).re.test(r)) return key;
  return "eng";
}

// A department zone: benches of two desks (seat row, desk row, aisle row), up to three across.
function zoneShapes(roles) {
  const groups = new Map();
  roles.forEach((r, i) => { const d = department(r); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(i); });
  return DEPARTMENTS.filter((d) => groups.has(d.key)).map((d) => {
    const members = groups.get(d.key);
    const benches = Math.max(2, Math.ceil(members.length / 2));
    const c = benches <= 2 ? benches : benches <= 4 ? 2 : 3;
    const r = Math.ceil(benches / c);
    return { key: d.key, name: d.name, members, c, r, w: c * 6, h: 1 + r * 3 };
  });
}

const ZONE_Y = 13;   // below the top rooms (y 2..8), their front wall (9) and a corridor (10..12)
function packZones(zones, IW) {
  const out = [], rows = [];
  let x = 3, y = ZONE_Y, rowH = 0, row = [];
  for (const z of zones) {
    if (row.length && x + z.w > IW - 1) { rows.push({ y, h: rowH, end: x - 3 }); y += rowH + 2; x = 3; rowH = 0; row = []; }
    out.push({ ...z, x, y }); row.push(z);
    x += z.w + 3; rowH = Math.max(rowH, z.h);
  }
  rows.push({ y, h: rowH, end: x - 3 });
  return { zones: out, rows, bottom: y + rowH };
}

// Bottom band: lobby (x 1..13), café (from x 15, 3k+1 wide), lounge (the rest, at least 22 wide).
function bottomBand(n, IW) {
  const matRows = Math.max(2, Math.ceil(n / 4));
  const needCafe = Math.max(8, Math.ceil(n * 0.6) + 2);
  let BHb = Math.max(9, matRows + 5);
  for (let i = 0; i < 8; i++) {
    const cafeRows = Math.floor((BHb - 5) / 3) + 1;
    const k = Math.max(3, Math.ceil(needCafe / (4 * cafeRows)));
    const CW = 3 * k + 1, cx0 = 15, lx = cx0 + CW + 1, LWd = IW - lx + 1;
    if (LWd < 22) return null;
    let base = 12;
    for (let ex = 22; ex + 2 <= LWd - 1; ex += 4) base++;
    const perRow = Math.floor((LWd - 3) / 2) + 1;
    const recRows = Math.max(0, Math.ceil((n + 1 - base) / perRow));
    const need = Math.max(9, matRows + 5, 7 + 2 * recRows);
    if (need <= BHb) return { BHb, matRows, cafeRows, k, CW, cx0, lx, LWd, recRows };
    BHb = need;
  }
  return null;
}

// Small deterministic random numbers, so the park looks the same on every load.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** buildMap(roles) with the workers' roles in worker order (seat i is worker i), or buildMap(count). */
export function buildMap(arg) {
  const roles = Array.isArray(arg) ? arg.map((r) => (typeof r === "string" ? r : r?.role || "")) : Array.from({ length: Math.max(0, Number(arg) || 0) }, () => "");
  if (!roles.length) roles.push("");
  const n = roles.length;
  const shapes = zoneShapes(roles);

  // Pick the floor width whose building is closest to a wide screen's shape.
  const minIW = Math.max(47, ...shapes.map((z) => z.w + 4));
  let best = null;
  for (let IW = minIW; IW <= minIW + 50; IW++) {
    const bb = bottomBand(n, IW);
    if (!bb) continue;
    const pk = packZones(shapes, IW);
    const Yb = pk.bottom + 2, BH = Yb + bb.BHb + 2, BW = IW + 2;
    const score = Math.abs(Math.log(BW / BH / 1.6));
    if (!best || score < best.score - 0.02) best = { IW, bb, pk, Yb, BH, BW, score };
  }
  const { IW, bb, pk, Yb, BH, BW } = best;

  // The park around it: wide enough on every side that a wide or tall view of the whole
  // building still lands on scenery, with room in front for the path, car park and street.
  const MX = Math.min(48, Math.max(14, Math.ceil((2.3 * BH - BW) / 2)));
  const MYt = Math.min(30, Math.max(9, Math.ceil((BW / 1.3 - BH) / 2)));
  const MYb = Math.max(MYt, 15);
  const W = BW + 2 * MX, H = BH + MYt + MYb, OX = MX, OY = MYt;

  const solid = Array.from({ length: H }, () => new Array(W).fill(true));
  const floor = Array.from({ length: H }, () => new Array(W).fill("grass"));
  const wall = Array.from({ length: H }, () => new Array(W).fill(null));
  const items = [], labels = [];
  // Building-local helpers (x, y relative to the building's top-left corner).
  const cell = (x, y, f) => { const X = x + OX, Y = y + OY; if (X >= 0 && Y >= 0 && X < W && Y < H) f(X, Y); };
  const area = (x, y, w, h, f) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) cell(xx, yy, f); };
  const setFloor = (kind, x, y, w = 1, h = 1) => area(x, y, w, h, (X, Y) => { floor[Y][X] = kind; });
  const setWall = (kind, x, y, w = 1, h = 1) => area(x, y, w, h, (X, Y) => { wall[Y][X] = kind; solid[Y][X] = true; });
  const gap = (x, y, w = 1, h = 1) => area(x, y, w, h, (X, Y) => { wall[Y][X] = null; solid[Y][X] = false; });
  const add = (type, x, y, w = 1, h = 1, extra = {}) => {
    items.push({ type, x: x + OX, y: y + OY, w, h, ...extra });
    if (!extra.walkable) area(x, y, w, h, (X, Y) => { solid[Y][X] = true; });
  };
  const S = (x, y, dir, extra = {}) => ({ x: x + OX, y: y + OY, ...(dir ? { dir } : {}), ...extra });
  const R = (x, y, w, h) => ({ x: x + OX, y: y + OY, w, h });
  const label = (text, x, y, kind = "room") => labels.push({ text, x: x + OX, y: y + OY, kind });

  // Shell: open floor inside, outer walls (the top wall two rows tall, for windows and the
  // whiteboard), and the front door in the bottom wall.
  area(0, 0, BW, BH, (X, Y) => { solid[Y][X] = false; floor[Y][X] = "hall"; });
  setWall("outer", 0, 0, BW, 2); setWall("outer", 0, 0, 1, BH); setWall("outer", BW - 1, 0, 1, BH); setWall("outer", 0, BH - 1, BW, 1);
  const door = { x: 6 + OX, y: BH - 1 + OY, w: 3 };
  gap(6, BH - 1, 3, 1); setFloor("door", 6, BH - 1, 3, 1);
  const windows = [];   // on the top wall's face (sky by day, stars by night)

  // ---- Top band: rooms along the top wall, each with a door onto the corridor ----
  setWall("inner", 1, 9, IW, 1);
  // CEO office (glass front) with the live whiteboard.
  setFloor("wood", 1, 2, 10, 7); setWall("inner", 11, 2, 1, 7);
  setWall("glass", 1, 9, 10, 1); gap(5, 9, 2, 1);
  add("whiteboard", 2, 0, 5, 2, { walkable: true });
  windows.push(R(8, 0, 2, 2));
  add("desk", 3, 5, 3, 1, { owner: "ceo" });
  add("chair", 4, 4, 1, 1, { walkable: true });
  add("plant", 1, 2); add("plant", 10, 2, 1, 1, { tall: true });
  add("sofa", 8, 6, 2, 1, { walkable: true }); add("plant", 10, 8);
  const ceoSeat = S(4, 4, "down");
  const ceo = R(1, 2, 10, 7);
  label("CEO", 3, 8.5);
  // Boardroom (glass front): a long table with facing seats and a screen on the wall.
  setFloor("meet", 12, 2, 12, 7); setWall("inner", 24, 2, 1, 7);
  setWall("glass", 12, 9, 12, 1); gap(17, 9, 2, 1);
  add("screen", 17, 0, 2, 2, { walkable: true });
  windows.push(R(13, 0, 2, 2), R(21, 0, 2, 2));
  add("table", 15, 5, 6, 2);
  const meetingSeats = [];
  for (const i of [2, 3, 1, 4, 0, 5]) {
    meetingSeats.push(S(15 + i, 4, "down"), S(15 + i, 7, "up"));
    add("chair", 15 + i, 4, 1, 1, { walkable: true }); add("chair", 15 + i, 7, 1, 1, { walkable: true, back: true });
  }
  add("plant", 12, 2); add("plant", 23, 2);
  const meeting = R(12, 2, 12, 7);
  label("Boardroom", 14.5, 8.5);
  // Library: tall bookcases of files; people look things up standing in front of them.
  setFloor("library", 25, 2, 8, 7); setWall("inner", 33, 2, 1, 7);
  gap(28, 9, 2, 1);
  const fileSpots = [];
  for (const [sx, sy] of [[25, 2], [29, 2], [25, 5], [29, 5]]) {
    add("shelf", sx, sy, 3, 1);
    for (let i = 0; i < 3; i++) fileSpots.push(S(sx + i, sy + 1, "up"));
  }
  add("plant", 32, 8);
  const files = R(25, 2, 8, 7);
  label("Library", 26.5, 8.5);
  // Server room: two rows of racks.
  setFloor("server", 34, 2, 6, 7);
  gap(36, 9, 2, 1);
  const serverSpots = [];
  for (const ry of [2, 5]) for (const rx of [35, 36, 38, 39]) { add("rack", rx, ry, 1, 2); serverSpots.push(S(rx, ry + 2, "up")); }
  label("Servers", 37, 8.5);
  // Wider floors get more rooms to the right.
  const extras = [];
  const KINDS = [["huddle", "Huddle"], ["focus", "Focus room"], ["wellness", "Wellness"], ["studio", "Studio"]];
  let ex0 = 41, ki = 0;
  while (IW - ex0 + 1 >= 5) {
    const left = IW - ex0 + 1, w = left <= 13 ? left : Math.min(10, left - 6);
    extras.push({ kind: KINDS[ki % 4][0], name: KINDS[ki % 4][1], x: ex0, w }); ki++;
    ex0 += w + 1;
  }
  for (const ex of extras) {
    const { x: x0, w, kind } = ex, cx = x0 + Math.floor(w / 2);
    setWall("inner", x0 - 1, 2, 1, 7); setFloor(kind, x0, 2, w, 7);
    if (kind === "huddle") setWall("glass", x0, 9, w, 1);
    gap(cx - 1, 9, 2, 1);
    const tv = kind === "huddle" || kind === "studio";
    for (let wx = x0 + 1; wx + 1 <= x0 + w - 2; wx += 4) if (!tv || wx + 1 < cx - 1 || wx > cx) windows.push(R(wx, 0, 2, 2));
    if (kind === "huddle") {
      add("wallTv", cx - 1, 0, 2, 2, { walkable: true });
      add("roundTable", cx - 1, 4, 2, 2);
      for (const dx of [-1, 0]) { add("chair", cx + dx, 3, 1, 1, { walkable: true }); add("chair", cx + dx, 6, 1, 1, { walkable: true, back: true }); }
      add("plant", x0, 2); add("plant", x0 + w - 1, 2, 1, 1, { tall: true });
    } else if (kind === "focus") {
      for (let fx = x0 + 1; fx + 1 <= x0 + w - 2; fx += 3) { add("desk", fx, 4, 2, 1, { owner: null }); add("chair", fx, 3, 1, 1, { walkable: true }); add("lamp", fx + 1, 6); }
      add("plant", x0, 8); add("plant", x0 + w - 1, 8);
    } else if (kind === "wellness") {
      for (let yx = x0 + 1; yx + 1 <= x0 + w - 2; yx += 3) add("yoga", yx, 4, 2, 1, { walkable: true });
      add("plant", x0, 2, 1, 1, { tall: true }); add("plant", x0 + w - 1, 2, 1, 1, { tall: true });
      add("beanbag", x0 + 1, 7, 1, 1, { walkable: true }); if (w > 4) add("beanbag", x0 + w - 2, 7, 1, 1, { walkable: true });
    } else {
      add("easel", cx - 1, 0, 2, 2, { walkable: true });
      add("table", cx - 1, 4, 3, 2);
      add("shelf", x0, 2, 2, 1); add("plant", x0 + w - 1, 2);
    }
    label(ex.name, x0 + w / 2, 8.5);
  }

  // ---- Middle band: a zone per department ----
  const seats = new Array(n);
  const depts = [];
  for (const z of pk.zones) {
    setFloor(`zone:${z.key}`, z.x, z.y, z.w, z.h);
    label(z.name, z.x + z.w / 2, z.y - 0.45, "zone");
    let m = 0;
    for (let br = 0; br < z.r; br++) for (let bc = 0; bc < z.c; bc++) {
      const bx = z.x + bc * 6, by = z.y + 1 + br * 3;
      for (const dx of [1, 3]) {
        const who = z.members[m++];
        add("desk", bx + dx, by + 1, 2, 1, { owner: who ?? null });
        add("chair", bx + dx, by, 1, 1, { walkable: true });
        if (who !== undefined) seats[who] = { ...S(bx + dx, by, "down"), desk: { x: bx + dx + OX, y: by + 1 + OY } };
      }
    }
    depts.push({ key: z.key, name: z.name, members: z.members, ...R(z.x, z.y, z.w, z.h) });
  }
  // Breakout nooks in the space a zone row leaves free: a sofa corner, then a standing table
  // by the water cooler, alternating.
  for (const row of pk.rows) {
    let nx = row.end + 3, v = 0;
    while (IW - 1 - nx >= 7 && row.h >= 4) {
      const nw = Math.min(IW - 1 - nx, 10), ny = row.y + 1;
      if (v++ % 2 === 0) {
        setFloor("rug", nx, ny, nw, 3);
        add("sofa", nx + 1, ny, 3, 1, { walkable: true }); add("sideTable", nx + 2, ny + 1);
        add("beanbag", nx + 1, ny + 2, 1, 1, { walkable: true }); add("beanbag", nx + 3, ny + 2, 1, 1, { walkable: true });
        add("plant", nx + nw - 1, ny, 1, 1, { tall: true }); add("lamp", nx, ny);
        if (nw >= 8) add("shelf", nx + 5, ny, 2, 1);
      } else {
        add("roundTable", nx + 1, ny, 2, 2);
        add("stool", nx, ny + 1, 1, 1, { walkable: true }); add("stool", nx + 3, ny, 1, 1, { walkable: true });
        add("cooler", nx + nw - 2, ny); add("plant", nx + nw - 1, ny + 2, 1, 1, { tall: true });
        if (nw >= 8) add("plant", nx + 5, ny);
      }
      nx += nw + 2;
    }
  }
  // Corridor plants, and side windows to look out of.
  for (const [x, y] of [[1, 10], [IW, 10], [1, Yb - 1], [IW, Yb - 1]]) add("plant", x, y, 1, 1, { tall: (x + y) % 2 === 0 });
  const windowSpots = [], sideWindows = [];
  for (let y = 12; y <= Yb - 3; y += 4) {
    windowSpots.push(S(1, y, "left"), S(IW, y, "right"));
    sideWindows.push(R(0, y - 1, 1, 2), R(BW - 1, y - 1, 1, 2));
  }

  // ---- Bottom band ----
  const { BHb, matRows, cafeRows, k, CW, cx0, lx, LWd, recRows } = bb;
  const ly = Yb + 1, bottomRow = Yb + BHb;
  setWall("inner", 14, Yb, IW - 13, 1);
  // Lobby: open to the corridor, with the front door, reception, the mat and the YOU terminal.
  setFloor("lobby", 1, Yb, 13, BHb + 1);
  setWall("inner", 14, Yb, 1, BHb + 1); gap(14, Yb + 2, 1, 2);
  add("reception", 6, Yb + 1, 4, 1);
  add("plant", 1, Yb + 1, 1, 1, { tall: true }); add("plant", 13, Yb + 1);
  add("sofa", 10, Yb + 3, 3, 1, { walkable: true });
  add("terminal", 11, bottomRow - 1, 1, 1);
  setFloor("rug", 5, bottomRow - 1, 5, 2);
  add("cooler", 13, Yb + 6); add("plant", 13, bottomRow, 1, 1, { tall: true });
  const you = S(11, bottomRow - 1);
  const youSpot = S(11, bottomRow, "up");
  // "Needs you" mat by the door: blocked / parked / waiting workers queue here, one spot each,
  // filled from the door outward.
  const waitSpots = [];
  for (let i = 0; i < matRows * 4; i++) waitSpots.push(S(1 + (i % 4), bottomRow - Math.floor(i / 4), "down"));
  const mat = R(1, bottomRow + 1 - matRows, 4, matRows);
  label("Lobby", 7.5, Yb + 0.5);
  // Café: counter and coffee machine along the wall, tables of four in rows.
  setFloor("cafe", cx0, ly, CW, BHb);
  setWall("inner", lx - 1, ly, 1, BHb); gap(lx - 1, bottomRow - 1, 1, 2);
  gap(cx0 + CW - 3, Yb, 2, 1);
  add("counter", cx0, ly, 4, 1); add("coffee", cx0 + 4, ly); add("fridge", cx0 + 5, ly);
  if (CW >= 10) add("plant", cx0 + CW - 1, ly + 1);
  const coffeeSpot = S(cx0 + 4, ly + 1, "up");
  const cafeSeats = [];
  for (let j = 0; j < cafeRows; j++) {
    const ty = ly + 3 + j * 3;
    for (let i = 0; i < k; i++) {
      const tx = cx0 + 1 + i * 3;
      add("cafeTable", tx, ty, 2, 1);
      cafeSeats.push(S(tx, ty - 1, "down"), S(tx + 1, ty - 1, "down"), S(tx, ty + 1, "up"), S(tx + 1, ty + 1, "up"));
      add("stool", tx, ty - 1, 1, 1, { walkable: true }); add("stool", tx + 1, ty - 1, 1, 1, { walkable: true });
      add("stool", tx, ty + 1, 1, 1, { walkable: true }); add("stool", tx + 1, ty + 1, 1, 1, { walkable: true });
    }
  }
  const cafe = R(cx0, ly, CW, BHb);
  label("Café", cx0 + CW / 2, bottomRow + 0.5);
  // Lounge: games, ping-pong, a gym and a reading corner; everyone with nothing left to do
  // comes here, one person per spot.
  setFloor("lounge", lx, ly, LWd, BHb);
  for (const dx of [4, 9, 20]) gap(lx + dx, Yb, 2, 1);
  const gameSpots = [], gymSpots = [], readSpots = [];
  setFloor("rugLounge", lx, ly + 1, 4, 4);
  add("tv", lx + 1, ly, 2, 1);
  add("couch", lx, ly + 3, 3, 1, { walkable: true });
  for (let i = 0; i < 3; i++) gameSpots.push(S(lx + i, ly + 3, "up", { sit: true, prop: "controller", game: true }));
  add("pingpong", lx + 6, ly + 1, 3, 2);
  gameSpots.push(S(lx + 5, ly + 1, "right", { prop: "paddle", game: true }), S(lx + 9, ly + 2, "left", { prop: "paddle", game: true }));
  setFloor("gym", lx + 10, ly, 6, 5);
  for (const tx of [lx + 11, lx + 13]) { add("treadmill", tx, ly, 1, 1, { walkable: true }); gymSpots.push(S(tx, ly, "down", { treadmill: true })); }
  add("weights", lx + 15, ly);
  for (const tx of [lx + 11, lx + 13]) { add("bench", tx, ly + 3, 1, 1, { walkable: true }); gymSpots.push(S(tx, ly + 3, "down", { sit: true, prop: "dumbbell" })); }
  add("shelf", lx + 17, ly, 3, 1);
  for (const [dx, dy] of [[17, 2], [19, 2], [18, 4]]) { add("armchair", lx + dx, ly + dy, 1, 1, { walkable: true }); readSpots.push(S(lx + dx, ly + dy, "down", { sit: true, prop: "book" })); }
  for (let ex = 22; ex + 2 <= LWd - 1; ex += 4) {
    add("beanbag", lx + ex + 1, ly + 2, 1, 1, { walkable: true }); readSpots.push(S(lx + ex + 1, ly + 2, "down", { sit: true, prop: "book" }));
    add("plant", lx + ex + 2, ly, 1, 1, { tall: ex % 8 === 2 });
  }
  for (let b = 0; b < recRows; b++) {
    for (let ax = 1; ax <= LWd - 2; ax += 2) {
      const type = (ax + b) % 4 === 1 ? "beanbag" : "armchair";
      add(type, lx + ax, ly + 6 + b * 2, 1, 1, { walkable: true }); readSpots.push(S(lx + ax, ly + 6 + b * 2, "down", { sit: true, prop: "book" }));
    }
  }
  // Below the seats: a second sitting area, arcade cabinets and a pool table, where there is room.
  const dy0 = ly + 5 + 2 * recRows + (recRows ? 1 : 0);
  if (dy0 + 2 <= bottomRow - 1) {
    setFloor("rugLounge", lx + 1, dy0, 7, 3);
    add("sofa", lx + 2, dy0, 3, 1, { walkable: true });
    for (let i = 0; i < 3; i++) readSpots.push(S(lx + 2 + i, dy0, "down", { sit: true, prop: "book" }));
    add("sideTable", lx + 3, dy0 + 1); add("plant", lx + 7, dy0, 1, 1, { tall: true });
    for (let ax = lx + 10; ax <= lx + 14; ax += 2) add("arcade", ax, dy0 + 1);
    if (LWd >= 24) add("pool", lx + 17, dy0, 3, 2);
    else add("plant", lx + 16, dy0 + 2);
  }
  add("plant", lx + LWd - 1, bottomRow);
  const recSpots = [...gameSpots, ...gymSpots, ...readSpots];
  const rec = R(lx, ly, LWd, BHb);
  label("Lounge", lx + LWd / 2, bottomRow + 0.5);
  label("RedPi HQ", 7.5, BH - 1 + 0.35, "sign");
  label("NEEDS YOU", 3, bottomRow + 0.6, "mat");

  // Front of the building: windows along the facade.
  const facade = [];
  for (let fx = 1; fx + 1 < BW - 1; fx += 4) if (fx + 1 < 5 || fx > 9) facade.push(R(fx, BH - 1, 2, 1));

  // ---- Outdoors (world coordinates) ----
  const rand = rng(BW * 7919 + BH * 104729 + n);
  const bx0 = OX, by0 = OY, bx1 = OX + BW - 1, by1 = OY + BH - 1;
  const fillW = (kind, x, y, w, h, walk = false) => {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
      floor[yy][xx] = kind; if (walk) solid[yy][xx] = false;
    }
  };
  const roadY = H - 7;
  fillW("apron", bx0 - 1, by0 - 1, BW + 2, 1); fillW("apron", bx0 - 1, by1 + 1, BW + 2, 1);
  fillW("apron", bx0 - 1, by0, 1, BH); fillW("apron", bx1 + 1, by0, 1, BH);
  fillW("walk", 0, roadY - 1, W, 1); fillW("road", 0, roadY, W, 3); fillW("walk", 0, roadY + 3, W, 1);
  const doorX = door.x;
  fillW("plaza", doorX - 2, by1 + 1, 7, 2);
  fillW("path", doorX, by1 + 1, 3, roadY - 1 - (by1 + 1), true);
  const exit = { x: doorX + 1, y: by1 + 4 };
  // Car park in front, to the right of the path.
  const parkX = doorX + 6, stalls = Math.max(0, Math.min(12, Math.floor((bx1 - 2 - parkX + 1) / 2)));
  const parking = stalls >= 4 ? { x: parkX, y: by1 + 3, w: stalls * 2, h: 5 } : null;
  const outdoor = [];   // baked into the static layer: trees, cars, benches, lamps, flowers
  if (parking) {
    fillW("parking", parking.x, parking.y, parking.w, parking.h);
    fillW("parking", parking.x + parking.w - 2, parking.y + parking.h, 2, roadY - 1 - (parking.y + parking.h));
    for (let i = 0; i < stalls; i++) for (const [cy, dir] of [[parking.y, "down"], [parking.y + 3, "up"]]) {
      if (i === stalls - 1 && dir === "up") continue;   // the driveway
      if (rand() < 0.62) outdoor.push({ type: "car", x: parking.x + i * 2, y: cy, w: 2, h: 2, dir, color: Math.floor(rand() * 6) });
    }
  }
  // A pond with benches in the front garden, left of the path.
  const pond = { cx: doorX - 10, cy: by1 + 5, rx: 5.2, ry: 2.6 };
  if (pond.cx - pond.rx < 2) pond.cx = Math.ceil(pond.rx) + 2;
  for (let y = Math.floor(pond.cy - pond.ry); y <= Math.ceil(pond.cy + pond.ry); y++) for (let x = Math.floor(pond.cx - pond.rx); x <= Math.ceil(pond.cx + pond.rx); x++) {
    const dx = (x + 0.5 - pond.cx) / pond.rx, dy = (y + 0.5 - pond.cy) / pond.ry;
    if (dx * dx + dy * dy <= 1 && y >= 0 && x >= 0 && y < H && x < W) floor[y][x] = "water";
  }
  outdoor.push({ type: "parkBench", x: Math.round(pond.cx) - 1, y: Math.round(pond.cy - pond.ry) - 2, w: 2, h: 1 });
  outdoor.push({ type: "parkBench", x: Math.round(pond.cx + pond.rx) + 1, y: Math.round(pond.cy) - 1, w: 2, h: 1 });
  // Lamps along the path and the street (they glow at night).
  const lamps = [];
  for (let y = by1 + 3; y < roadY - 1; y += 4) lamps.push({ x: doorX - 1, y }, { x: doorX + 3, y });
  for (let x = 4; x < W - 2; x += 11) if (x < doorX - 2 || x > doorX + 4) lamps.push({ x, y: roadY - 1 });
  for (const l of lamps) outdoor.push({ type: "lampPost", x: l.x, y: l.y, w: 1, h: 1 });
  // Flower beds along the facade.
  for (let x = bx0; x <= bx1; x++) if ((x < doorX - 2 || x > doorX + 4) && rand() < 0.45) outdoor.push({ type: "flowers", x, y: by1 + 1, w: 1, h: 1, hue: Math.floor(rand() * 4) });
  // Trees everywhere else, denser further from the building.
  const keep = [
    { x: bx0 - 3, y: by0 - 3, w: BW + 6, h: BH + 5 },
    { x: doorX - 3, y: by1, w: 9, h: roadY - by1 },
    { x: 0, y: roadY - 2, w: W, h: 6 },
    { x: Math.floor(pond.cx - pond.rx) - 2, y: Math.floor(pond.cy - pond.ry) - 3, w: Math.ceil(pond.rx * 2) + 5, h: Math.ceil(pond.ry * 2) + 5 },
    ...(parking ? [{ x: parking.x - 1, y: parking.y - 1, w: parking.w + 2, h: roadY - parking.y + 1 }] : []),
  ];
  const kept = (x, y) => keep.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  for (let y = 2; y < H; y += 3) for (let x = 1 + ((y / 3) % 2 ? 1 : 0); x < W - 1; x += 3) {
    const tx = x + Math.floor(rand() * 2), ty = y + Math.floor(rand() * 2);
    if (ty >= H || kept(tx, ty) || kept(tx - 1, ty) || kept(tx + 1, ty)) continue;
    const near = tx > bx0 - 8 && tx < bx1 + 8 && ty > by0 - 8 && ty < by1 + 8;
    const r = rand();
    const pTree = near ? 0.3 : 0.55, pPine = near ? 0.42 : 0.75;
    if (r < pTree) outdoor.push({ type: "tree", x: tx, y: ty, w: 1, h: 1, v: Math.floor(rand() * 3) });
    else if (r < pPine) outdoor.push({ type: "pine", x: tx, y: ty, w: 1, h: 1, v: Math.floor(rand() * 2) });
    else if (r < pPine + 0.1) outdoor.push({ type: "bush", x: tx, y: ty, w: 1, h: 1 });
    else if (r < pPine + 0.16) outdoor.push({ type: "flowers", x: tx, y: ty, w: 1, h: 1, hue: Math.floor(rand() * 4) });
    else if (r < pPine + 0.18) outdoor.push({ type: "rock", x: tx, y: ty, w: 1, h: 1 });
  }
  outdoor.sort((a, b) => a.y + a.h - (b.y + b.h));

  const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !solid[y][x];
  const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  // Wander targets: open corridor and lobby floor, away from seats, the mat and doorways.
  const seatKeys = new Set([...seats, ceoSeat, ...meetingSeats, ...cafeSeats, ...recSpots, youSpot, ...waitSpots].filter(Boolean).map((s) => `${s.x},${s.y}`));
  const wander = [];
  for (let y = OY + 2; y < OY + BH - 1; y++) for (let x = OX + 1; x < OX + BW - 1; x++) {
    if ((floor[y][x] === "hall" || floor[y][x] === "lobby") && walkable(x, y) && !seatKeys.has(`${x},${y}`) && !inside(mat, x, y) && y !== OY + 9 && y !== OY + Yb) wander.push({ x, y });
  }

  return {
    W, H, TILE, items, outdoor, labels, floor, wall, windows, sideWindows, facade, lamps, pond, parking, road: { y: roadY, h: 3 },
    building: R(0, 0, BW, BH), seats, ceoSeat, meetingSeats, cafeSeats, waitSpots, wander, you, youSpot, door, mat, ceo, exit,
    files, fileSpots, serverSpots, meeting, windowSpots, rec, recSpots, gameSpots, gymSpots, readSpots, depts, cafe,
    lobby: R(1, Yb, 13, BHb + 1), coffeeSpot,
    whiteboard: R(2, 0, 5, 2), whiteboardSpot: S(4, 2, "up"),
    entry: S(7, BH - 2),
    width: W, height: H,
    isWalkable: walkable,
  };
}
