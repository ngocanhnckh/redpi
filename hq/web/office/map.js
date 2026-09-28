// RedPi Office layout generator (original RedPi code, no third-party map data).
// Builds a room sized for the team: a glass CEO office with a whiteboard, desk pods
// of four, a files & servers room (where research and builds happen), a glass
// meeting room (where people talk), a cafeteria, and the entrance with a
// "needs you" waiting area and the YOU terminal. Returns the furniture list, a
// walkability grid for pathfinding, and named spots characters walk to.

export const TILE = 16;

export function buildMap(workerCount) {
  const pods = Math.max(1, Math.ceil(workerCount / 4));
  const cols = Math.min(3, pods);
  const rows = Math.ceil(pods / 3);
  const x0 = 11, y0 = 2;
  const workBottom = y0 + rows * 6;
  const y1 = Math.max(workBottom + 1, 10);        // lounge (meeting + cafeteria + entrance) starts here
  const W = Math.max(11 + cols * 8 + 10, 29);     // pods, then the files & servers room on the right
  const H = y1 + 8;

  const solid = Array.from({ length: H }, () => new Array(W).fill(false));
  const items = [];
  const block = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (solid[yy]) solid[yy][xx] = true; };
  const add = (type, x, y, w = 1, h = 1, extra = {}) => { items.push({ type, x, y, w, h, ...extra }); if (!extra.walkable) block(x, y, w, h); };

  // Outer walls: two-tile-tall top wall (windows + whiteboard), sides, bottom with the entrance.
  block(0, 0, W, 2); block(0, 0, 1, H); block(W - 1, 0, 1, H); block(0, H - 1, W, 1);
  const door = { x: 3, y: H - 1, w: 2 };
  for (let x = door.x; x < door.x + door.w; x++) solid[H - 1][x] = false;

  // CEO office (glass) in the top-left, with a whiteboard on its wall.
  const ceo = { x: 1, y: 2, w: 9, h: 7 };
  const glass = (type, x, y, len, gaps) => {
    add(type, x, y, type === "glassV" ? 1 : len, type === "glassV" ? len : 1, { gaps });
    for (const g of gaps) if (type === "glassV") solid[g][x] = false; else solid[y][g] = false;
  };
  glass("glassV", 10, 2, 7, [5]);                    // gap = the office door
  glass("glassH", 1, 9, 9, [5]);
  add("whiteboard", 2, 0, 7, 2, { walkable: true }); // on the wall (already solid)
  add("desk", 4, 5, 3, 1, { owner: "ceo" });
  add("chair", 5, 4, 1, 1, { walkable: true });
  add("plant", 1, 2); add("plant", 8, 7);
  const ceoSeat = { x: 5, y: 4, dir: "down" };

  // Desk pods: 2×2 desks per 8×6 block, seats behind the desks facing the viewer.
  const seats = [];
  for (let p = 0; p < pods; p++) {
    const bx = x0 + (p % 3) * 8, by = y0 + Math.floor(p / 3) * 6;
    for (const [dx, dy] of [[1, 1], [5, 1], [1, 4], [5, 4]]) {
      const i = seats.length;
      add("desk", bx + dx, by + dy + 1, 2, 1, { owner: i });
      add("chair", bx + dx, by + dy, 1, 1, { walkable: true });
      seats.push({ x: bx + dx, y: by + dy, dir: "down", desk: { x: bx + dx, y: by + dy + 1 } });
    }
  }

  // Files & servers room on the right: bookshelves of files on the left, server racks
  // on the right, a glass wall with two doors toward the desks and an open bottom.
  const files = { x: W - 8, y: 2, w: 7, h: y1 - 2 };
  glass("glassV", W - 9, 2, y1 - 2, [4, y1 - 2]);
  const fileSpots = [], serverSpots = [];
  for (let sy = 2; sy + 1 < y1 - 1; sy += 3) {
    add("shelf", W - 8, sy, 3, 1);
    for (let i = 0; i < 3; i++) fileSpots.push({ x: W - 8 + i, y: sy + 1, dir: "up" });
  }
  for (let ry = 2; ry + 2 < y1 - 1; ry += 4) {
    add("rack", W - 3, ry, 1, 2); add("rack", W - 2, ry, 1, 2);
    serverSpots.push({ x: W - 3, y: ry + 2, dir: "up" }, { x: W - 2, y: ry + 2, dir: "up" });
  }

  // Lounge: glass meeting room in the middle, cafeteria on the right, entrance on the left.
  const mx = Math.floor(W / 2) - 2, my = y1 + 2;
  // The room leaves the row above the bottom wall open as the corridor to the entrance.
  const meeting = { x: mx - 1, y: y1 + 1, w: 6, h: 4 };
  glass("glassH", mx - 2, y1, 8, [mx + 1, mx + 2]);   // double door facing the desks
  glass("glassV", mx - 2, y1 + 1, 4, []);
  glass("glassV", mx + 5, y1 + 1, 4, []);
  glass("glassH", mx - 2, y1 + 5, 8, []);
  add("table", mx, my, 4, 2);
  add("screen", mx + 4, y1 + 1, 1, 1);
  // Seats in facing pairs (top i, bottom i) so two people talking face each other.
  const meetingSeats = [];
  for (const i of [1, 2, 0, 3]) {
    meetingSeats.push({ x: mx + i, y: my - 1, dir: "down" }, { x: mx + i, y: my + 2, dir: "up" });
    add("chair", mx + i, my - 1, 1, 1, { walkable: true }); add("chair", mx + i, my + 2, 1, 1, { walkable: true, back: true });
  }
  const cx = W - 9;
  add("counter", cx, y1, 6, 1);
  add("coffee", cx + 6, y1, 1, 1);
  add("cafeTable", cx + 1, y1 + 3, 2, 1);
  add("cafeTable", cx + 4, y1 + 5, 2, 1);
  const cafeSeats = [
    { x: cx + 1, y: y1 + 2, dir: "down" }, { x: cx + 2, y: y1 + 2, dir: "down" }, { x: cx + 1, y: y1 + 4, dir: "up" },
    { x: cx + 4, y: y1 + 4, dir: "down" }, { x: cx + 5, y: y1 + 4, dir: "down" }, { x: cx + 5, y: y1 + 6, dir: "up" },
  ];
  add("plant", 1, y1); add("plant", W - 2, H - 2);
  // The YOU terminal: where messages to the human land, next to the entrance.
  add("terminal", 7, H - 3, 1, 1);
  const you = { x: 7, y: H - 3 };
  const youSpot = { x: 7, y: H - 2, dir: "up" };
  // "Needs you" mat in front of the door: blocked / parked / waiting workers queue here.
  const waitSpots = [];
  for (let i = 0; i < 8; i++) waitSpots.push({ x: 1 + (i % 4), y: i < 4 ? H - 2 : H - 3, dir: "down" });
  const mat = { x: 1, y: H - 3, w: 5, h: 2 };

  const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !solid[y][x];
  const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  // Wander targets: open floor in the lounge and aisles, away from seats and out of the
  // meeting room, the files room and the "needs you" mat (people go there for a reason).
  const seatKeys = new Set([...seats, ceoSeat, ...meetingSeats, ...cafeSeats, youSpot].map((s) => `${s.x},${s.y}`));
  const wander = [];
  for (let y = 2; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (walkable(x, y) && !seatKeys.has(`${x},${y}`) && (y >= y1 || x >= x0) && !inside(meeting, x, y) && !inside(files, x, y) && !inside(mat, x, y) && x !== W - 9) wander.push({ x, y });
  }
  // Somewhere to stretch the legs near the windows: the aisle row under the top wall.
  const windowSpots = wander.filter((s) => s.y === 2 && s.x < W - 9).map((s) => ({ ...s, dir: "up" }));

  return {
    W, H, TILE, items, seats, ceoSeat, meetingSeats, cafeSeats, waitSpots, wander, you, youSpot, door, mat, ceo,
    files, fileSpots, serverSpots, meeting, windowSpots,
    coffeeSpot: { x: cx + 6, y: y1 + 1, dir: "up" },
    whiteboard: { x: 2, y: 0, w: 7, h: 2 }, whiteboardSpot: { x: 5, y: 2, dir: "up" },
    entry: { x: door.x, y: H - 2 },
    lounge: { y: y1 },
    width: W, height: H,
    isWalkable: walkable,
  };
}
