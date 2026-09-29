// Architecture decision records and lessons learned, kept in the project (original RedPi code).
// ADRs: docs/adr/NNNN-title.md plus an index (docs/adr/README.md).
// Lessons: docs/lessons-learned.md, newest first, read back into every agent session.
// Plain JavaScript so Pi extensions and the redpi-hq command (non-Pi workers) share it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const ADR_DIR = join("docs", "adr");
export const LESSONS_FILE = join("docs", "lessons-learned.md");
const LESSONS_HEAD = `# Lessons learned

What earlier work in this project taught us. RedPi reads this file into every agent session, so each run starts from what the last one learned. Newest first; keep entries short, merge duplicates, and delete ones that no longer apply.
`;

/** The project root for a working folder: its git top level (a worktree's own root), else the folder. */
export function projectRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "decision";
const today = () => new Date().toISOString().slice(0, 10);
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const num = (n) => String(n).padStart(4, "0");

/** The project's ADRs: number, file, title, status, date. */
export function listAdrs(root) {
  const dir = join(root, ADR_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-.+\.md$/.test(f)).sort().map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    return {
      number: Number(f.slice(0, 4)), file: f,
      title: /^#\s+(?:\d+\.\s*)?(.+)$/m.exec(text)?.[1]?.trim() || f,
      status: /^-\s*Status:\s*(.+)$/mi.exec(text)?.[1]?.trim() || "accepted",
      date: /^-\s*Date:\s*(.+)$/mi.exec(text)?.[1]?.trim() || "",
    };
  });
}

function writeIndex(root) {
  const adrs = listAdrs(root);
  writeFileSync(join(root, ADR_DIR, "README.md"), `# Architecture decision records

One file per significant decision: the context, what was decided, the alternatives, and the consequences. Before changing an area, read its decisions; to change one, write a new record that supersedes it.

| # | Decision | Status | Date |
| --- | --- | --- | --- |
${adrs.map((a) => `| ${num(a.number)} | [${a.title.replace(/\|/g, "\\|")}](${a.file}) | ${a.status} | ${a.date} |`).join("\n")}
`);
}

// A folder lock (mkdir is atomic): parallel agents take turns choosing the next number.
function withLock(dir, fn) {
  const lock = join(dir, ".redpi.lock"), until = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 15_000) rmdirSync(lock); } catch {}
      if (Date.now() > until) throw new Error(`${dir} is locked by another writer`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}

/**
 * Write the next-numbered ADR (the number is claimed atomically, so parallel agents never clash) and refresh the index.
 * a: { title, context, decision, alternatives?, consequences, status?, supersedes?, by?, task? }
 */
export function writeAdr(root, a) {
  for (const k of ["title", "context", "decision", "consequences"]) if (!oneLine(a[k])) throw new Error(`an ADR needs ${k}`);
  const dir = join(root, ADR_DIR);
  mkdirSync(dir, { recursive: true });
  const title = oneLine(a.title).slice(0, 120);
  return withLock(dir, () => {
    const n = Math.max(0, ...listAdrs(root).map((x) => x.number)) + 1;
    const path = join(dir, `${num(n)}-${slug(title)}.md`);
    const body = `# ${n}. ${title}

- Status: ${oneLine(a.status || "accepted")}${a.supersedes ? ` (supersedes ${num(a.supersedes)})` : ""}
- Date: ${today()}
${a.by ? `- Decided by: ${oneLine(a.by)}\n` : ""}${a.task ? `- Task: ${oneLine(a.task)}\n` : ""}
## Context

${String(a.context).trim()}

## Decision

${String(a.decision).trim()}
${a.alternatives && String(a.alternatives).trim() ? `\n## Alternatives considered\n\n${String(a.alternatives).trim()}\n` : ""}
## Consequences

${String(a.consequences).trim()}
`;
    writeFileSync(path, body);
    if (a.supersedes) {
      const old = listAdrs(root).find((x) => x.number === Number(a.supersedes));
      if (old && old.number !== n) {
        const p = join(dir, old.file);
        writeFileSync(p, readFileSync(p, "utf8").replace(/^-\s*Status:.*$/mi, `- Status: superseded by ${num(n)}`));
      }
    }
    writeIndex(root);
    return { number: n, path };
  });
}

/**
 * Add a lesson at the top of docs/lessons-learned.md, unless the same lesson is already there.
 * l: { what, lesson, nextTime, area?, by? }
 */
export function addLesson(root, l) {
  for (const k of ["what", "lesson", "nextTime"]) if (!oneLine(l[k])) throw new Error(`a lesson needs ${k}`);
  const path = join(root, LESSONS_FILE);
  mkdirSync(join(root, "docs"), { recursive: true });
  return withLock(join(root, "docs"), () => addLessonNow(path, l));
}
function addLessonNow(path, l) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : LESSONS_HEAD;
  const norm = (s) => oneLine(s).toLowerCase().replace(/[^a-z0-9 ]/g, "");
  if (norm(current).includes(norm(l.lesson))) return { path, added: false };
  const entry = `\n## ${today()}${l.area ? ` · ${oneLine(l.area)}` : ""}${l.by ? ` · ${oneLine(l.by)}` : ""}\n- **What happened:** ${oneLine(l.what)}\n- **Lesson:** ${oneLine(l.lesson)}\n- **Next time:** ${oneLine(l.nextTime)}\n`;
  // Newest first: right after the file's header (everything before the first "## ").
  const i = current.search(/^## /m);
  const next = i < 0 ? `${current.trimEnd()}\n${entry}` : `${current.slice(0, i).trimEnd()}\n${entry}\n${current.slice(i)}`;
  writeFileSync(path, next.replace(/\n{3,}/g, "\n\n"));
  return { path, added: true };
}

/** What every session is told: the lessons (capped, newest first) and the list of decisions. */
export function knowledgeText(root, maxLessons = 6000, maxAdrs = 2500) {
  const parts = [];
  const lp = join(root, LESSONS_FILE);
  if (existsSync(lp)) {
    const body = readFileSync(lp, "utf8");
    const from = body.search(/^## /m);
    let lessons = from < 0 ? "" : body.slice(from).trim();
    if (lessons.length > maxLessons) lessons = lessons.slice(0, maxLessons).replace(/\n[^\n]*$/, "") + "\n…(older lessons in the file)";
    if (lessons) parts.push(`Lessons learned in this project (${LESSONS_FILE}, newest first). Apply them:\n${lessons}`);
  }
  const adrs = listAdrs(root);
  if (adrs.length) {
    let list = adrs.map((a) => `- ${num(a.number)} ${a.title} [${a.status}]`).join("\n");
    if (list.length > maxAdrs) list = "…\n" + list.slice(list.length - maxAdrs).replace(/^[^\n]*\n/, "");
    parts.push(`Architecture decisions in this project (${ADR_DIR}/): read the relevant record before changing that area, follow accepted ones, and supersede one with a new ADR rather than silently going against it.\n${list}`);
  }
  return parts.join("\n\n");
}
