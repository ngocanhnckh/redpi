// RedPlan plan validation and critical-path scheduling. Pure functions, no I/O,
// shared by the HQ server and tests.

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function list(v) { return Array.isArray(v) ? v : []; }
function text(v) { return typeof v === "string" ? v.trim() : ""; }

// Every task's effective dependencies: its own, plus every task of each story its story depends on.
export function taskGraph(plan) {
  const tasks = new Map();
  const storyTasks = new Map();
  for (const story of list(plan.stories)) {
    storyTasks.set(story.id, list(story.tasks).map((t) => t.id));
    for (const task of list(story.tasks)) tasks.set(task.id, { ...task, storyId: story.id });
  }
  for (const story of list(plan.stories)) {
    const inherited = list(story.dependsOn).flatMap((sid) => storyTasks.get(sid) || []);
    for (const task of list(story.tasks)) {
      const t = tasks.get(task.id);
      t.deps = [...new Set([...list(task.dependsOn), ...inherited])].filter((d) => d !== task.id);
    }
  }
  return tasks;
}

export function validatePlan(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== "object") return { errors: ["plan must be an object"], warnings };
  if (!text(plan.title)) errors.push("title is required");
  if (!text(plan.summary)) errors.push("summary is required: one paragraph a non-engineer can follow");
  const stories = list(plan.stories);
  if (!stories.length) errors.push("at least one story is required");

  const storyIds = new Set();
  const taskIds = new Set();
  for (const [si, story] of stories.entries()) {
    const where = `stories[${si}]${story?.id ? ` (${story.id})` : ""}`;
    if (!ID.test(story?.id || "")) errors.push(`${where}: id must be a short slug like S1 or auth-login`);
    else if (storyIds.has(story.id)) errors.push(`${where}: duplicate story id ${story.id}`);
    storyIds.add(story?.id);
    if (!text(story?.title)) errors.push(`${where}: title is required`);
    if (!text(story?.userStory)) errors.push(`${where}: userStory is required ("As a …, I want …, so that …")`);
    if (!list(story?.acceptance).length) warnings.push(`${where}: no acceptance criteria`);
    const tasks = list(story?.tasks);
    if (!tasks.length) errors.push(`${where}: at least one task is required`);
    for (const [ti, task] of tasks.entries()) {
      const tw = `${where}.tasks[${ti}]${task?.id ? ` (${task.id})` : ""}`;
      if (!ID.test(task?.id || "")) errors.push(`${tw}: id must be a short slug like T1 or S1.2`);
      else if (taskIds.has(task.id) || storyIds.has(task.id)) errors.push(`${tw}: duplicate id ${task.id}`);
      taskIds.add(task?.id);
      if (!text(task?.title)) errors.push(`${tw}: title is required`);
      if (!text(task?.description)) errors.push(`${tw}: description is required (what and why, readable by a human)`);
      if (!(Number(task?.estimateHours) > 0)) errors.push(`${tw}: estimateHours must be a positive number`);
    }
  }
  for (const story of stories) {
    for (const dep of list(story?.dependsOn)) if (!storyIds.has(dep)) errors.push(`story ${story.id}: dependsOn unknown story ${dep}`);
    for (const task of list(story?.tasks)) {
      for (const dep of list(task?.dependsOn)) if (!taskIds.has(dep)) errors.push(`task ${task.id}: dependsOn unknown task ${dep}`);
    }
  }

  for (const [i, tech] of list(plan.techStack).entries()) {
    const tw = `techStack[${i}]${tech?.name ? ` (${tech.name})` : ""}`;
    if (!text(tech?.name) || !text(tech?.package)) errors.push(`${tw}: name and exact package are required`);
    if (!text(tech?.uses)) warnings.push(`${tw}: say exactly what is used from it (classes, functions, services)`);
    if (tech?.verified !== true || !/^https?:\/\//.test(text(tech?.source))) warnings.push(`${tw}: not verified against a primary source`);
  }

  const comps = new Set(list(plan.architecture?.components).map((c) => c?.id));
  for (const link of list(plan.architecture?.links)) {
    if (!comps.has(link?.from) || !comps.has(link?.to)) errors.push(`architecture link ${link?.from} → ${link?.to}: unknown component`);
  }

  if (!errors.length) {
    const cycle = findCycle(taskGraph(plan));
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  }
  return { errors, warnings };
}

function findCycle(tasks) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of tasks.get(id)?.deps || []) {
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.get(dep)) { const c = visit(dep); if (c) return c; }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of tasks.keys()) if (!state.get(id)) { const c = visit(id); if (c) return c; }
  return null;
}

// Critical path method over task hours. Assumes validatePlan passed (no cycles).
export function schedulePlan(plan) {
  const tasks = taskGraph(plan);
  const order = [];
  const indeg = new Map([...tasks.keys()].map((id) => [id, tasks.get(id).deps.length]));
  const succ = new Map([...tasks.keys()].map((id) => [id, []]));
  for (const [id, t] of tasks) for (const d of t.deps) succ.get(d).push(id);
  const queue = [...tasks.keys()].filter((id) => indeg.get(id) === 0);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id)) { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) queue.push(s); }
  }

  const out = {};
  for (const id of order) {
    const t = tasks.get(id);
    const es = Math.max(0, ...t.deps.map((d) => out[d].ef));
    out[id] = { id, storyId: t.storyId, title: t.title, hours: Number(t.estimateHours), es, ef: es + Number(t.estimateHours), deps: t.deps };
  }
  const duration = Math.max(0, ...Object.values(out).map((t) => t.ef));
  for (const id of [...order].reverse()) {
    const lf = Math.min(duration, ...succ.get(id).map((s) => out[s].ls));
    out[id].lf = lf;
    out[id].ls = lf - out[id].hours;
    out[id].slack = +(out[id].ls - out[id].es).toFixed(6);
    out[id].critical = Math.abs(out[id].slack) < 1e-6;
  }

  // Longest chain of zero-slack tasks from the start to the finish.
  let criticalPath = [];
  const walk = (id, path) => {
    const next = succ.get(id).filter((s) => out[s].critical && Math.abs(out[s].es - out[id].ef) < 1e-6);
    if (!next.length) { if (out[id].ef >= duration - 1e-6 && path.length > criticalPath.length) criticalPath = path; return; }
    for (const s of next) walk(s, [...path, s]);
  };
  for (const id of order) if (out[id].critical && out[id].es === 0) walk(id, [id]);

  // How many tasks can run at once, and the work sequential execution would take.
  const edges = Object.values(out).flatMap((t) => [[t.es, 1], [t.ef, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0, maxParallel = 0;
  for (const [, delta] of edges) { running += delta; maxParallel = Math.max(maxParallel, running); }
  const totalHours = Object.values(out).reduce((n, t) => n + t.hours, 0);

  // Waves: tasks grouped by earliest start, for a readable "what runs together" view.
  const waves = [...new Set(order.map((id) => out[id].es))].sort((a, b) => a - b)
    .map((start) => ({ start, tasks: order.filter((id) => out[id].es === start) }));

  return { tasks: out, order, duration, totalHours, criticalPath, maxParallel, waves };
}
