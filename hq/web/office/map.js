// RedPi Office layout generator (original RedPi code, no third-party map data).
// Builds a room sized for the team: a glass CEO office with a whiteboard, desk pods
// of four, a meeting table, a cafeteria, a server rack, and the entrance with a
// "needs you" waiting area and the YOU terminal. Returns the furniture list, a
// walkability grid for pathfinding, and named spots characters walk to.

export const TILE = 16;

export function buildMap(workerCount) {
  const pods = Math.max(1, Math.ceil(workerCount / 4));
  const cols = Math.min(3, pods);
  const rows = Math.ceil(pods / 3);
  const x0 = 11, y0 = 2;
  const workBottom = y0 + rows * 6;
  const y1 = Math.max(workBottom, 10);            // lounge (meeting + cafeteria + entrance) starts here
  const W = Math.max(11 + cols * 8 + 2, 29);
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
  add("glassV", 10, 2, 1, 7, { gap: 5 });           // gap row = the office door
  solid[5][10] = false;
  add("glassH", 1, 9, 9, 1, { gap: 5 });
  solid[9][5] = false;
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
  add("rack", W - 2, 2, 1, 2);
  add("plant", W - 2, y1 - 1);

  // Lounge: meeting table in the middle, cafeteria on the right, entrance on the left.
  const mx = Math.floor(W / 2) - 2, my = y1 + 2;
  add("table", mx, my, 4, 2);
  const meetingSeats = [];
  for (let i = 0; i < 4; i++) { meetingSeats.push({ x: mx + i, y: my - 1, dir: "down" }, { x: mx + i, y: my + 2, dir: "up" }); }
  const cx = W - 9;
  add("counter", cx, y1, 6, 1);
  add("coffee", cx + 6, y1, 1, 1);
  add("cafeTable", cx + 1, y1 + 3, 2, 1);
  add("cafeTable", cx + 4, y1 + 5, 2, 1);
  const cafeSeats = [
    { x: cx + 1, y: y1 + 2, dir: "down" }, { x: cx + 2, y: y1 + 2, dir: "down" }, { x: cx + 1, y: y1 + 4, dir: "up" },
    { x: cx + 4, y: y1 + 4, dir: "down" }, { x: cx + 5, y: y1 + 4, dir: "down" }, { x: cx + 5, y: y1 + 6, dir: "up" },
  ];
  add("plant", 1, y1); add("plant", W - 2, H - 2); add("plant", mx - 2, y1);
  // The YOU terminal: where messages to the human land, next to the entrance.
  add("terminal", 7, H - 3, 1, 1);
  const you = { x: 7, y: H - 3 };
  // "Needs you" mat in front of the door: blocked / parked / waiting workers queue here.
  const waitSpots = [];
  for (let i = 0; i < 8; i++) waitSpots.push({ x: 1 + (i % 4), y: i < 4 ? H - 2 : H - 3, dir: "down" });
  const mat = { x: 1, y: H - 3, w: 5, h: 2 };

  const walkable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !solid[y][x];
  // Wander targets: open floor in the lounge and aisles, away from seats.
  const seatKeys = new Set([...seats, ceoSeat, ...meetingSeats, ...cafeSeats].map((s) => `${s.x},${s.y}`));
  const wander = [];
  for (let y = 2; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (walkable(x, y) && !seatKeys.has(`${x},${y}`) && (y >= y1 || x >= x0)) wander.push({ x, y });

  return {
    W, H, TILE, items, seats, ceoSeat, meetingSeats, cafeSeats, waitSpots, wander, you, door, mat, ceo,
    whiteboard: { x: 2, y: 0, w: 7, h: 2 }, whiteboardSpot: { x: 5, y: 2, dir: "up" },
    entry: { x: door.x, y: H - 2 },
    lounge: { y: y1 },
    width: W, height: H,
    isWalkable: walkable,
  };
}
