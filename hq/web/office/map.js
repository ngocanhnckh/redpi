// RedPi Office layout generator (original RedPi code, no third-party map data).
//
// The office is a building in a small park. Outside: lawns and trees, a path from the front
// door to the street, a car park and a pond, so the floor always fills the screen (the camera
// never shows past the edge of the world). Inside, three bands around cream-tiled corridors:
//   - top: the CEO's glass office (with the live whiteboard), a glass boardroom where teammates
//     talk, the library (files: where research happens) and the server room (where builds and
//     tests run) — all compact for a small team and wider as it grows — and, once the team is
//     large, a huddle room, focus room, wellness room and studio, one of each as thresholds pass;
//   - middle: one open-plan zone per department (Engineering, Design, Research & Data,
//     Review & QA, Platform & Ops, Security, Docs & Content), picked from each worker's role,
//     sized to the people actually in it (a one-person team is a one-desk pod), with breakout
//     nooks in whatever space is left over;
//   - bottom: the lobby with the front door, the "needs you" mat and the YOU terminal, the café
//     (people waiting on a build sit here with a coffee), and the lounge (games, and a gym,
//     ping-pong and more once the team is big) for anyone with nothing left to do.
// The whole building is sized to the team: small and tightly filled for a few agents, growing in
// steps as members join. Returns the furniture list, floor and wall grids for the painter, a
// walkability grid for pathfinding, labels, and named spots.

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

// A department zone, sized to its people: one desk per member in a tight grid (a desk cell is
// 3 wide — a 2-wide desk and an aisle — and 3 tall — the chair, the desk, and a walkway).
function zoneShapes(roles) {
  const groups = new Map();
  roles.forEach((r, i) => { const d = department(r); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(i); });
  return DEPARTMENTS.filter((d) => groups.has(d.key)).map((d) => {
    const members = groups.get(d.key), m = members.length;
    // Each department is a pod of at least five desks, so even a one- or two-person team reads as a
    // real department rather than a lone desk; it grows past five as the team does. Grids are
    // landscape (wider than tall): a small pod is a single wide row, bigger ones a wide block.
    const slots = Math.max(5, m);
    const cols = slots <= 6 ? slots : Math.min(10, Math.ceil(Math.sqrt(slots * 2.5)));
    const rows = Math.ceil(slots / cols);
    return { key: d.key, name: d.name, members, slots, cols, rows, w: cols * 3, h: rows * 3 };
  });
}

const ZONE_Y = 12;   // below the top rooms (y 2..8), their front wall (9) and a corridor (10..11)
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

// Bottom band: lobby (x 1..13), café (from x 15), lounge (the rest). Café and lounge are packed
// tight to the team — only as many seats as the team needs — and the lounge grows just tall
// enough that everyone with nothing to do still has a spot.
function bottomBand(n, IW) {
  const matRows = Math.max(2, Math.ceil(n / 4));
  const needCafe = Math.max(4, Math.ceil(n * 0.6) + 2);
  const tables = Math.ceil(needCafe / 4);          // a café table seats four
  const k = Math.max(1, Math.min(3, tables));      // up to three tables across, more in extra rows
  const cafeRows = Math.ceil(tables / k);
  const CW = 3 * k + 1, cx0 = 15, lx = cx0 + CW + 1, LWd = IW - lx + 1;
  const loungeMin = Math.min(22, Math.max(8, 6 + Math.ceil(n / 2)));
  if (LWd < loungeMin) return null;
  const perRow = Math.floor((LWd - 3) / 2) + 1;    // armchairs every other tile across the lounge
  const recRows = Math.max(1, Math.ceil((n + 1 - 3) / perRow));   // the couch seats 3; rows seat the rest
  const BHb = Math.max(8, matRows + 5, 6 + 2 * recRows, 3 * cafeRows + 2);
  return { BHb, matRows, cafeRows, k, CW, cx0, lx, LWd, recRows };
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

  // Top-band rooms, sized to the team. The CEO office and the three work rooms (boardroom,
  // library, servers) are always there — compact for a small team, wider as it grows.
  const wCeo = n >= 8 ? 10 : 8;
  const boardCols = Math.min(6, Math.max(4, Math.ceil(n / 2)));   // facing-seat columns (2 seats each) → >= 8 seats
  const wBoard = boardCols + 6;
  const libShelves = Math.min(4, Math.max(1, Math.ceil(n / 4)));  // shelves of three files
  const libCols = Math.ceil(libShelves / 2);
  const wLib = libCols * 4 + 1;
  const srvRacks = Math.min(8, Math.max(2, 2 * Math.ceil(n / 4)));
  const srvCols = Math.ceil(srvRacks / 2);
  const wSrv = srvCols + 3;
  const ceoX = 1, boardX = ceoX + wCeo + 1, libX = boardX + wBoard + 1, srvX = libX + wLib + 1;
  const topEnd = srvX + wSrv - 1;   // last inner column the fixed top rooms use
  // Extra amenity rooms: one of each, unlocked one at a time as the team grows, never duplicated.
  const EXTRA_KINDS = [["huddle", "Huddle", 12], ["focus", "Focus room", 18], ["wellness", "Wellness", 26], ["studio", "Studio", 34]];

  // Pick the floor width that gives a landscape building (wider than tall, ~3:2) — but only as wide
  // as the department zones actually fill, so a small team stays compact (its landscape look comes
  // from the park, not from empty columns). Widening is allowed only while the zones still fill it.
  const minIW = Math.max(topEnd, 24, ...shapes.map((z) => z.w + 4));
  let best = null;
  const seenRows = new Set();
  for (let IW = minIW; IW <= minIW + 60; IW++) {
    const bb = bottomBand(n, IW);
    if (!bb) continue;
    const pk = packZones(shapes, IW);
    // Only the tightest width for each zone-row count is a real option — a wider floor with the
    // same number of desk rows is just blank floor. So a small team (its zones already fit in one
    // row at the minimum width) can only be compact, and its landscape look comes from the park;
    // a big team chooses among genuinely-filled packings (fewer, wider rows) for a 3:2 building.
    if (seenRows.has(pk.rows.length)) continue;
    seenRows.add(pk.rows.length);
    const Yb = pk.bottom + 1, BH = Yb + bb.BHb + 2, BW = IW + 2, ratio = BW / BH;
    const cost = Math.abs(Math.log(ratio / 1.55))
      + (ratio < 1.25 ? (1.25 - ratio) * 4 : 0) + (ratio > 1.95 ? (ratio - 1.95) * 3 : 0);
    if (!best || cost < best.cost) best = { IW, bb, pk, Yb, BH, BW, cost };
  }
  const { IW, bb, pk, Yb, BH, BW } = best;

  // The park frames the building in a widescreen world: modest lawn above, room for the path, road
  // and car park below, and whatever side lawn it takes to make the whole world read landscape
  // (~16:9) — a small office sits centred in a wide park, never in a tall, letter-boxed one.
  const MYt = Math.max(7, Math.round(BH * 0.15));
  const MYb = Math.max(15, Math.round(BH * 0.2));
  const Hworld = BH + MYt + MYb;
  const MX = Math.max(10, Math.min(80, Math.round((1.65 * Hworld - BW) / 2)));
  const W = BW + 2 * MX, H = Hworld, OX = MX, OY = MYt;

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
  setFloor("wood", ceoX, 2, wCeo, 7); setWall("inner", ceoX + wCeo, 2, 1, 7);
  setWall("glass", ceoX, 9, wCeo, 1); gap(ceoX + Math.floor(wCeo / 2) - 1, 9, 2, 1);
  add("whiteboard", 2, 0, 5, 2, { walkable: true });
  windows.push(R(wCeo - 1, 0, 2, 2));
  add("desk", 3, 5, 3, 1, { owner: "ceo" });
  add("chair", 4, 4, 1, 1, { walkable: true });
  add("plant", ceoX, 2); add("plant", wCeo, 2, 1, 1, { tall: true });
  add("sofa", wCeo - 2, 6, 2, 1, { walkable: true }); add("plant", wCeo, 8);
  const ceoSeat = S(4, 4, "down");
  const ceo = R(ceoX, 2, wCeo, 7);
  label("CEO", 3, 8.5);
  // Boardroom (glass front): a table with facing seats and a screen on the wall.
  setFloor("meet", boardX, 2, wBoard, 7); setWall("inner", boardX + wBoard, 2, 1, 7);
  setWall("glass", boardX, 9, wBoard, 1);
  const boardMid = boardX + Math.floor(wBoard / 2);
  gap(boardMid - 1, 9, 2, 1);
  add("screen", boardMid - 1, 0, 2, 2, { walkable: true });
  windows.push(R(boardX + 1, 0, 2, 2), R(boardX + wBoard - 2, 0, 2, 2));
  const tableX = boardX + 3;
  add("table", tableX, 5, boardCols, 2);
  const meetingSeats = [];
  const seatOrder = [...Array(boardCols).keys()].sort((a, b) => Math.abs(a - (boardCols - 1) / 2) - Math.abs(b - (boardCols - 1) / 2));
  for (const i of seatOrder) {
    meetingSeats.push(S(tableX + i, 4, "down"), S(tableX + i, 7, "up"));
    add("chair", tableX + i, 4, 1, 1, { walkable: true }); add("chair", tableX + i, 7, 1, 1, { walkable: true, back: true });
  }
  add("plant", boardX, 2); add("plant", boardX + wBoard - 1, 2);
  const meeting = R(boardX, 2, wBoard, 7);
  label("Boardroom", boardX + wBoard / 2, 8.5);
  // Library: bookcases of files; people look things up standing in front of them.
  setFloor("library", libX, 2, wLib, 7); setWall("inner", libX + wLib, 2, 1, 7);
  gap(libX + Math.floor(wLib / 2) - 1, 9, 2, 1);
  const fileSpots = [];
  let shelvesLeft = libShelves;
  for (let col = 0; col < libCols && shelvesLeft > 0; col++) for (const sy of [2, 5]) {
    if (shelvesLeft-- <= 0) break;
    const lsx = libX + 1 + col * 4;
    add("shelf", lsx, sy, 3, 1);
    for (let i = 0; i < 3; i++) fileSpots.push(S(lsx + i, sy + 1, "up"));
  }
  add("plant", libX + wLib - 1, 8);
  const files = R(libX, 2, wLib, 7);
  label("Library", libX + wLib / 2, 8.5);
  // Server room: racks of machines, with room to stand in front of each.
  setFloor("server", srvX, 2, wSrv, 7);
  gap(srvX + Math.floor(wSrv / 2) - 1, 9, 2, 1);
  const serverSpots = [];
  for (let r = 0; r < srvRacks; r++) {
    const col = r % srvCols, rowi = Math.floor(r / srvCols), rx = srvX + 1 + col, ry = rowi === 0 ? 2 : 5;
    add("rack", rx, ry, 1, 2); serverSpots.push(S(rx, ry + 2, "up"));
  }
  label("Servers", srvX + wSrv / 2, 8.5);
  // Amenity rooms fill the top-band width left of the outer wall, one kind at a time as the team grows.
  const extras = [];
  let ex0 = topEnd + 2;
  for (const [kind, name, need] of EXTRA_KINDS) {
    if (n < need) break;
    const left = IW - ex0 + 1;
    if (left < 5) break;
    const w = left <= 13 ? left : Math.min(10, left - 6);
    extras.push({ kind, name, x: ex0, w }); ex0 += w + 1;
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

  // ---- Middle band: a zone per department, one desk per member ----
  const seats = new Array(n);
  const depts = [];
  for (const z of pk.zones) {
    setFloor(`zone:${z.key}`, z.x, z.y, z.w, z.h);
    label(z.name, z.x + z.w / 2, z.y - 0.45, "zone");
    // Draw every slot (>= 5): the first members get an owned desk, the rest are empty desks ready
    // for the team to grow into.
    for (let idx = 0; idx < z.slots; idx++) {
      const col = idx % z.cols, row = Math.floor(idx / z.cols);
      const dx = z.x + col * 3, dy = z.y + 1 + row * 3, who = z.members[idx];
      add("desk", dx, dy, 2, 1, { owner: who });
      add("chair", dx, dy - 1, 1, 1, { walkable: true });
      if (who !== undefined) seats[who] = { ...S(dx, dy - 1, "down"), desk: { x: dx + OX, y: dy + OY } };
    }
    depts.push({ key: z.key, name: z.name, members: z.members, ...R(z.x, z.y, z.w, z.h) });
  }
  // Breakout nooks in the space a zone row leaves free: a sofa corner, then a standing table
  // by the water cooler, alternating.
  for (const row of pk.rows) {
    let nx = row.end + 3, v = 0;
    while (IW - 1 - nx >= 7 && row.h >= 3) {
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
  if (CW >= 10) gap(cx0 + CW - 3, Yb, 2, 1);
  add("counter", cx0, ly, CW - 2, 1); add("coffee", cx0 + CW - 2, ly); add("fridge", cx0 + CW - 1, ly);
  if (CW >= 10) add("plant", cx0 + CW - 1, ly + 1);
  const coffeeSpot = S(cx0 + CW - 2, ly + 1, "up");
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
  // Lounge: a TV couch always; ping-pong, a gym and a reading nook unlock as the team grows,
  // then dense rows of seats make sure everyone with nothing to do still has somewhere to sit.
  setFloor("lounge", lx, ly, LWd, BHb);
  gap(lx + 3, Yb, 2, 1);
  const gameSpots = [], gymSpots = [], readSpots = [];
  setFloor("rugLounge", lx, ly + 1, Math.min(4, LWd), 4);
  add("tv", lx + 1, ly, 2, 1);
  add("couch", lx, ly + 3, 3, 1, { walkable: true });
  for (let i = 0; i < 3; i++) gameSpots.push(S(lx + i, ly + 3, "up", { sit: true, prop: "controller", game: true }));
  let gx = lx + 5;
  if (n >= 10 && gx + 4 <= lx + LWd - 1) {
    add("pingpong", gx, ly + 1, 3, 2);
    gameSpots.push(S(gx - 1, ly + 1, "right", { prop: "paddle", game: true }), S(gx + 3, ly + 2, "left", { prop: "paddle", game: true }));
    gx += 5;
  }
  if (n >= 8 && gx + 6 <= lx + LWd - 1) {
    setFloor("gym", gx, ly, 6, 5);
    for (const tx of [gx + 1, gx + 3]) { add("treadmill", tx, ly, 1, 1, { walkable: true }); gymSpots.push(S(tx, ly, "down", { treadmill: true })); }
    add("weights", gx + 5, ly);
    for (const tx of [gx + 1, gx + 3]) { add("bench", tx, ly + 3, 1, 1, { walkable: true }); gymSpots.push(S(tx, ly + 3, "down", { sit: true, prop: "dumbbell" })); }
    gx += 7;
  }
  if (gx + 1 <= lx + LWd - 1) {
    add("shelf", gx, ly, Math.min(3, lx + LWd - gx), 1);
    for (const [dx, dy] of [[0, 2], [2, 2], [1, 4]]) if (gx + dx <= lx + LWd - 2) { add("armchair", gx + dx, ly + dy, 1, 1, { walkable: true }); readSpots.push(S(gx + dx, ly + dy, "down", { sit: true, prop: "book" })); }
  }
  // Dense rows of seats below, sized so everyone (plus the CEO) has a spot.
  for (let b = 0; b < recRows; b++) for (let ax = 1; ax <= LWd - 2; ax += 2) {
    const type = (ax + b) % 4 === 1 ? "beanbag" : "armchair";
    add(type, lx + ax, ly + 6 + b * 2, 1, 1, { walkable: true }); readSpots.push(S(lx + ax, ly + 6 + b * 2, "down", { sit: true, prop: "book" }));
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
