/**
 * RedPi knowledge: architecture decision records and lessons learned (original RedPi code).
 *
 * Agents record significant decisions as ADRs (docs/adr/NNNN-title.md, with an index) and what
 * cost them time as lessons (docs/lessons-learned.md). Every session in a trusted project is
 * told the lessons and the list of decisions, so each run starts from what the last one learned.
 */
import { Type } from "typebox";
import { addLesson, knowledgeText, listAdrs, projectRoot, writeAdr, ADR_DIR, LESSONS_FILE } from "../lib/knowledge.mjs";
import { systemTextChannel } from "../lib/claude-bridge.ts";

const text = (t: string, details?: any) => ({ content: [{ type: "text", text: t }], details });
const who = () => process.env.REDPI_HQ_NAME || "";

const POLICY = `Decisions and lessons (RedPi): when you make a significant technical decision (choosing a library or service, an architecture or data model, an API contract, or a trade-off someone could later question), record it with redpi_adr: the context, the decision, the alternatives, the consequences. When something cost real time or went wrong and the fix is worth remembering (a wrong assumption, a misleading error, a flaky tool, a slow build and what sped it up), add it with redpi_lesson before you finish. Skip trivia: one good record beats five obvious ones.`;

export default function (pi: any) {
  pi.registerTool({
    name: "redpi_adr", label: "Record decision",
    description: `Record an architecture decision record (ADR) in ${ADR_DIR}/ of this project: next number, the standard sections, and the index updated. Use it for significant decisions only.`,
    promptSnippet: "Record a significant technical decision as an ADR",
    parameters: Type.Object({
      title: Type.String({ description: "The decision in a few words, e.g. \"Use Postgres row-level security for tenancy\"" }),
      context: Type.String({ description: "The problem and forces: what needed deciding and why, constraints, facts checked" }),
      decision: Type.String({ description: "What was decided, concretely (packages, APIs, boundaries)" }),
      alternatives: Type.Optional(Type.String({ description: "Options considered and why not" })),
      consequences: Type.String({ description: "What follows: benefits, costs, risks, follow-ups" }),
      status: Type.Optional(Type.String({ description: "accepted (default) or proposed" })),
      supersedes: Type.Optional(Type.Number({ description: "Number of an earlier ADR this one replaces" })),
      task: Type.Optional(Type.String({ description: "Task or ticket id this came from, e.g. T2.1 or TK-3" })),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const root = projectRoot(ctx.cwd);
      const r = writeAdr(root, { ...p, by: who() || undefined });
      return text(`Recorded ADR ${String(r.number).padStart(4, "0")}: ${r.path} (index: ${ADR_DIR}/README.md). Commit it with the change it explains.`, r);
    },
  });

  pi.registerTool({
    name: "redpi_lesson", label: "Record lesson",
    description: `Add a lesson learned to ${LESSONS_FILE} (newest first, duplicates skipped). Every later agent session in this project reads it.`,
    promptSnippet: "Record a lesson learned so the next run avoids the same trouble",
    parameters: Type.Object({
      what: Type.String({ description: "What happened, briefly (the symptom and the cost)" }),
      lesson: Type.String({ description: "The general lesson, in one sentence" }),
      nextTime: Type.String({ description: "What to do next time, concretely (a command, a check, an order of steps)" }),
      area: Type.Optional(Type.String({ description: "Area it applies to, e.g. docker build, auth, tests" })),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const r = addLesson(projectRoot(ctx.cwd), { ...p, by: who() || undefined });
      return text(r.added ? `Lesson added to ${r.path}. Commit it with your work.` : `That lesson is already in ${r.path}.`, r);
    },
  });

  pi.registerCommand("decisions", { description: "List this project's architecture decision records and where the lessons are", handler: async (_a: string, ctx: any) => {
    const root = projectRoot(ctx.cwd);
    const adrs = listAdrs(root);
    ctx.ui.notify(`${adrs.length ? adrs.map((a) => `${String(a.number).padStart(4, "0")} ${a.title} [${a.status}]`).join("\n") : "No ADRs yet."}\n\nADRs: ${root}/${ADR_DIR}\nLessons: ${root}/${LESSONS_FILE}`, "info");
  } });

  const policyText = systemTextChannel(pi, "knowledge");
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    let known = "";
    // Project files go into the prompt only for projects the human trusts.
    try { if (ctx.isProjectTrusted?.()) known = knowledgeText(projectRoot(ctx.cwd)); } catch {}
    return policyText.deliver(event, ctx, `${POLICY}${known ? `\n\n${known}` : ""}`);
  });
}
