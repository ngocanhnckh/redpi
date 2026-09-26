// BFS pathfinding on a tile walkability grid.
// Ported from munder-difflin (scene/office/pathfinding.ts, MIT, Copyright (c) 2026
// Chaitanya Giri), which ported it verbatim from shahar061/the-office
// (office/engine/pathfinding.ts, ISC License).

const DIRECTIONS = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];

export function findPath(map, start, goal) {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!map.isWalkable(goal.x, goal.y)) return null;
  const key = (p) => `${p.x},${p.y}`;
  const visited = new Set([key(start)]);
  const parent = new Map();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dir of DIRECTIONS) {
      const next = { x: current.x + dir.x, y: current.y + dir.y };
      const k = key(next);
      if (visited.has(k) || !map.isWalkable(next.x, next.y)) continue;
      visited.add(k);
      parent.set(k, current);
      if (next.x === goal.x && next.y === goal.y) {
        const path = [];
        let cur = goal;
        while (!(cur.x === start.x && cur.y === start.y)) { path.unshift(cur); cur = parent.get(key(cur)); }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}
