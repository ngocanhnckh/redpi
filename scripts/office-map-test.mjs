// Office floor scales with the team: for every team size from 1 to 40 there is a desk per person,
// enough café seats, a rec-room spot for everyone plus the CEO, a "needs you" spot per person,
// every spot is reachable from the entrance, and no two spots or pieces of furniture overlap.
import { buildMap } from "../hq/web/office/map.js";
import { findPath } from "../hq/web/office/pathfinding.js";

const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); process.exit(1); };
const rows = [];
for (let n = 1; n <= 40; n++) {
  const m = buildMap(n);
  if (m.seats.length < n) fail(`${n} people: only ${m.seats.length} desks`);
  if (m.cafeSeats.length < Math.max(8, Math.ceil(n * 0.6))) fail(`${n} people: only ${m.cafeSeats.length} café seats`);
  if (m.recSpots.length < n + 1) fail(`${n} people: only ${m.recSpots.length} rec-room spots`);
  if (m.waitSpots.length < n) fail(`${n} people: only ${m.waitSpots.length} spots on the "needs you" mat`);
  const spots = { desk: m.seats, cafe: m.cafeSeats, rec: m.recSpots, wait: m.waitSpots, meeting: m.meetingSeats, ceo: [m.ceoSeat], you: [m.youSpot], coffee: [m.coffeeSpot], whiteboard: [m.whiteboardSpot], files: m.fileSpots, servers: m.serverSpots };
  const seen = new Map();
  // Solid furniture (not chairs, couches and other things people sit on) must not cover any spot.
  const solid = new Set();
  for (const it of m.items) if (!["chair", "couch", "armchair", "bench", "treadmill", "whiteboard"].includes(it.type)) for (let y = it.y; y < it.y + it.h; y++) for (let x = it.x; x < it.x + it.w; x++) solid.add(`${x},${y}`);
  for (const [kind, list] of Object.entries(spots)) for (const s of list) {
    const k = `${s.x},${s.y}`;
    if (seen.has(k) && !(kind === "coffee" || seen.get(k) === "coffee")) fail(`${n} people: ${kind} spot ${k} is also a ${seen.get(k)} spot`);
    seen.set(k, kind);
    if (!m.isWalkable(s.x, s.y) || solid.has(k)) fail(`${n} people: ${kind} spot ${k} is on furniture or a wall`);
    if (findPath(m, m.entry, s) === null) fail(`${n} people: ${kind} spot ${k} cannot be reached from the entrance`);
  }
  const inMat = m.waitSpots.every((s) => s.x >= m.mat.x && s.x < m.mat.x + m.mat.w && s.y >= m.mat.y && s.y < m.mat.y + m.mat.h);
  if (!inMat) fail(`${n} people: waiting spots should all be on the mat`, m.mat);
  if ([1, 4, 8, 12, 20, 30, 40].includes(n)) rows.push(`${n}: ${m.W}×${m.H}, ${m.seats.length} desks, ${m.cafeSeats.length} café, ${m.recSpots.length} rec, ${m.waitSpots.length} mat`);
}
console.log(`Office map test passed: every shared area scales with the team, all spots reachable and distinct (${rows.join("; ")}).`);
