import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type TierName = "high" | "low" | "uncapable" | string;
type ModelProfile = {
  model: string;
  vision?: boolean;
  thinking?: string;
  rate?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  notes?: string;
};
type ModelEntry = string | ModelProfile;
type RoleConfig = { tier?: TierName; model?: string; models?: ModelEntry[]; thinking?: string; fallbacks?: ModelEntry[] } | string;
type Config = {
  planner?: { tier?: TierName; thinking?: string };
  executor?: { tier?: TierName; thinking?: string };
  roles?: Record<string, RoleConfig>;
  vision?: { models?: ModelEntry[] };
  tiers?: Record<string, ModelEntry[]>;
  retry?: { enabled?: boolean; maxPerUserPrompt?: number; errorPatterns?: string[]; cooldownMs?: number; fallbackChains?: Record<string, ModelEntry[]> };
  magicKeywords?: { enabled?: boolean; ultrathink?: boolean; orchestrate?: boolean; cheap?: boolean };
  advisor?: { enabled?: boolean; modelRole?: string; autoReview?: boolean; tools?: string[] };
  memory?: { enabled?: boolean; injectionCharLimit?: number };
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const USER_YITEC_DIR = join(AGENT_DIR, "yitec");
const DEFAULT_CONFIG: Required<Config> = {
  planner: { tier: "high", thinking: "high" },
  executor: { tier: "low", thinking: "low" },
  roles: {
    default: { tier: "high", thinking: "medium" },
    planner: { tier: "high", thinking: "high" },
    executor: { tier: "low", thinking: "low" },
    subagent: { tier: "low", thinking: "low" },
    reviewer: { tier: "high", thinking: "high" },
    vision: { tier: "high", thinking: "off" },
    commit: { tier: "low", thinking: "low" },
    tiny: { tier: "low", thinking: "off" },
  },
  vision: { models: ["openai/gpt-4o", "google/gemini-2.5-pro"] },
  tiers: { high: [], low: [], uncapable: [] },
  retry: {
    enabled: true,
    maxPerUserPrompt: 2,
    cooldownMs: 5 * 60 * 1000,
    fallbackChains: {},
    errorPatterns: ["rate limit", "429", "quota", "insufficient_quota", "weekly limit", "session limit", "credits", "tokens exhausted", "overloaded"],
  },
  magicKeywords: { enabled: true, ultrathink: true, orchestrate: true, cheap: true },
  advisor: { enabled: false, modelRole: "reviewer", autoReview: false, tools: ["read", "grep"] },
  memory: { enabled: true, injectionCharLimit: 5000 },
};

type LoadedConfig = Config & { __path?: string; __projectTrusted?: boolean };

type TurnMagic = { ultrathink?: boolean; orchestrate?: boolean; cheap?: boolean };

function readJson(path: string, fallback: any) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function configPaths(cwd: string, projectTrusted = false): string[] {
  return [
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "yitec", "model-tiers.json")] : []),
    join(USER_YITEC_DIR, "model-tiers.json"),
  ];
}

function loadConfig(cwd: string, projectTrusted = false): LoadedConfig {
  for (const path of configPaths(cwd, projectTrusted)) {
    if (existsSync(path)) return deepMerge(DEFAULT_CONFIG, readJson(path, {}), { __path: path, __projectTrusted: projectTrusted });
  }
  return { ...DEFAULT_CONFIG, __projectTrusted: projectTrusted };
}

function deepMerge<T>(base: T, override: any, extra?: any): T & any {
  if (!override || typeof override !== "object" || Array.isArray(override)) return { ...(base as any), ...(extra || {}) };
  const out: any = { ...(base as any) };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return { ...out, ...(extra || {}) };
}

function entryModel(entry: ModelEntry): string { return typeof entry === "string" ? entry : entry.model; }
function entryThinking(entry: ModelEntry): string | undefined { return typeof entry === "string" ? undefined : entry.thinking; }
function entryHasVision(entry: ModelEntry): boolean { return typeof entry !== "string" && entry.vision === true; }
function entryKey(entry: ModelEntry): string {
  const parsed = splitModel(entryModel(entry));
  return parsed.provider ? `${parsed.provider}/${parsed.id}` : parsed.id;
}
function splitModel(pattern: string): { provider?: string; id: string; thinking?: string } {
  const [modelPart, thinking] = pattern.split(":");
  const slash = modelPart.indexOf("/");
  return slash >= 0 ? { provider: modelPart.slice(0, slash), id: modelPart.slice(slash + 1), thinking } : { id: modelPart, thinking };
}
function visionCandidates(cfg: Config): ModelEntry[] {
  const explicit = cfg.vision?.models ?? [];
  const roleEntries = roleCandidates(cfg, "vision");
  const fromTiers = Object.values(cfg.tiers ?? {}).flat().filter(entryHasVision);
  return dedupeEntries([...explicit, ...roleEntries, ...fromTiers]);
}
function dedupeEntries(entries: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => { const k = entryKey(e); if (seen.has(k)) return false; seen.add(k); return true; });
}
function roleCandidates(cfg: Config, role: string): ModelEntry[] {
  const rc = cfg.roles?.[role] ?? (role === "planner" ? cfg.planner : role === "executor" ? cfg.executor : undefined);
  if (!rc) return [];
  if (typeof rc === "string") return rc.includes("/") ? [rc] : (cfg.tiers?.[rc] ?? []);
  const direct = [...(rc.model ? [rc.model] : []), ...(rc.models ?? [])];
  const tier = rc.tier ? (cfg.tiers?.[rc.tier] ?? []) : [];
  return dedupeEntries([...direct, ...tier, ...(rc.fallbacks ?? []), ...(cfg.retry?.fallbackChains?.[role] ?? [])]);
}
function roleThinking(cfg: Config, role: string): string | undefined {
  const rc = cfg.roles?.[role] ?? (role === "planner" ? cfg.planner : role === "executor" ? cfg.executor : undefined);
  return typeof rc === "object" ? rc.thinking : undefined;
}
async function selectFirstAvailable(pi: ExtensionAPI, ctx: ExtensionContext, entries: ModelEntry[], thinking?: string, skip = new Set<string>()): Promise<string | undefined> {
  for (const entry of entries) {
    if (skip.has(entryKey(entry))) continue;
    const parsed = splitModel(entryModel(entry));
    if (!parsed.provider) continue;
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) continue;
    const ok = await pi.setModel(model);
    if (!ok) continue;
    const selectedThinking = parsed.thinking ?? entryThinking(entry) ?? thinking ?? "off";
    pi.setThinkingLevel(selectedThinking as any);
    return `${model.provider}/${model.id}${selectedThinking ? `:${selectedThinking}` : ""}`;
  }
  return undefined;
}
function errorMatches(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}
function stripNonProse(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ").replace(/`[^`]*`/g, " ").replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/<[^>]*>/g, " ");
}
function hasKeyword(text: string, word: string): boolean {
  const prose = stripNonProse(text);
  const re = new RegExp(`(^|[^A-Za-z0-9_./\\\\:-])${word}($|[^A-Za-z0-9_./\\\\:-])`);
  return re.test(prose);
}
function magicInstruction(m: TurnMagic): string {
  const lines = [];
  if (m.ultrathink) lines.push("- ultrathink: reason carefully, enumerate failure modes, and use the highest useful thinking effort for this turn.");
  if (m.orchestrate) lines.push("- orchestrate: split independent research/review/execution across available low-cost subagents where useful, then synthesize and verify.");
  if (m.cheap) lines.push("- cheap/lowcost: prefer the low-tier executor/subagent role unless the task clearly needs high-tier planning.");
  return lines.length ? `\n\nYitec magic keyword policy for this turn:\n${lines.join("\n")}` : "";
}
function memoryPaths(cwd: string, projectTrusted = false): string[] {
  return [
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "yitec", "memory.md"), join(cwd, CONFIG_DIR_NAME, "yitec", "lessons.md")] : []),
    join(USER_YITEC_DIR, "memory.md"), join(USER_YITEC_DIR, "lessons.md"),
  ];
}
function readCapped(paths: string[], max: number): string {
  const chunks: string[] = [];
  for (const p of paths) if (existsSync(p)) chunks.push(`## ${p}\n${readFileSync(p, "utf8")}`);
  const txt = chunks.join("\n\n").trim();
  return txt.length > max ? txt.slice(0, max) + "\n…(capped)" : txt;
}
function projectMemoryPath(cwd: string, projectTrusted = false): string {
  return projectTrusted ? join(cwd, CONFIG_DIR_NAME, "yitec", "lessons.md") : join(USER_YITEC_DIR, "lessons.md");
}
function watchdogText(cwd: string, projectTrusted = false): string {
  return readCapped([
    join(AGENT_DIR, "WATCHDOG.md"),
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "WATCHDOG.md"), join(cwd, CONFIG_DIR_NAME, "yitec", "WATCHDOG.md")] : []),
  ], 6000);
}
function doctor(cfg: LoadedConfig, ctx: ExtensionContext): string {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!cfg.__path) problems.push("No model-tiers.json found; using defaults only.");
  for (const [tier, entries] of Object.entries(cfg.tiers ?? {})) {
    for (const e of entries) {
      const p = splitModel(entryModel(e));
      if (!p.provider) problems.push(`Tier ${tier}: ${entryModel(e)} is missing provider/ prefix.`);
      else if (!ctx.modelRegistry.find(p.provider, p.id)) problems.push(`Tier ${tier}: ${p.provider}/${p.id} is not in Pi model registry.`);
    }
  }
  for (const role of ["planner", "executor", "subagent", "reviewer", "vision", "commit", "tiny"]) {
    if (!roleCandidates(cfg, role).length) notes.push(`Role ${role} has no direct candidates; it may rely on an empty tier.`);
  }
  notes.push(`Config: ${cfg.__path ?? "defaults"}`);
  notes.push(`Project config trusted: ${cfg.__projectTrusted ? "yes" : "no"}`);
  return [`Yitec doctor`, problems.length ? `Problems:\n- ${problems.join("\n- ")}` : "Problems: none", `Notes:\n- ${notes.join("\n- ")}`].join("\n\n");
}
function runPiPrint(cwd: string, model: string, prompt: string): string {
  const args = ["-p", "--model", model, prompt];
  const result = spawnSync("pi", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  return result.stdout || result.stderr || `pi exited with status ${result.status}`;
}

function nineRouterBaseUrl(): string {
  return process.env.NINE_ROUTER_BASE_URL || process.env.ROUTER9_BASE_URL || "http://127.0.0.1:20128/v1";
}

function nineRouterApiKey(): string {
  return process.env.NINE_ROUTER_API_KEY || process.env.ROUTER9_API_KEY || process.env.NINEROUTER_API_KEY || "dummy";
}

async function fetchNineRouterModels(signal?: AbortSignal): Promise<any[]> {
  try {
    const res = await fetch(`${nineRouterBaseUrl().replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${nineRouterApiKey()}` },
      signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const ids = Array.isArray(json?.data) ? json.data.map((m: any) => m?.id).filter(Boolean) : [];
    return ids.map((id: string) => ({ id, name: `9Router ${id}`, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("9router", {
    baseUrl: nineRouterBaseUrl(),
    apiKey: nineRouterApiKey(),
    api: "openai-completions",
    models: [
      { id: "kr/claude-sonnet-4.5", name: "9Router Kiro Claude Sonnet 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "opencode/free", name: "9Router OpenCode Free", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
    async refreshModels(context: any) {
      const models = await fetchNineRouterModels(context?.signal);
      return models.length ? models : undefined;
    },
  } as any);

  let currentUserPrompt = "";
  let retriesForPrompt = 0;
  let failedModelsForPrompt = new Set<string>();
  let cooldownUntil = new Map<string, number>();
  let turnMagic: TurnMagic = {};

  pi.registerCommand("yitec-tiers", { description: "Show Yitec model tier routing configuration", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(loadConfig(ctx.cwd, ctx.isProjectTrusted()), null, 2), "info") });
  pi.registerCommand("yitec-9router", { description: "Check RedPi native 9Router gateway integration", handler: async (_args, ctx) => {
    const found = ctx.modelRegistry.find("9router", "kr/claude-sonnet-4.5");
    const live = await fetchNineRouterModels(ctx.signal).catch(() => []);
    ctx.ui.notify(`9Router provider: ${found ? "registered" : "missing"}\nBase URL: ${nineRouterBaseUrl()}\nAPI key env: ${nineRouterApiKey() === "dummy" ? "not set (using dummy)" : "set"}\nLive /models: ${live.length ? live.map((m: any) => m.id).slice(0, 20).join(", ") : "not reachable or no models returned"}\nUse model IDs like 9router/kr/claude-sonnet-4.5.`, "info");
  } });
  pi.registerCommand("yitec-doctor", { description: "Validate Yitec roles, tiers, providers, and trust", handler: async (_args, ctx) => ctx.ui.notify(doctor(loadConfig(ctx.cwd, ctx.isProjectTrusted()), ctx), "info") });
  pi.registerCommand("yitec-agents", { description: "Show Yitec subagent/reviewer role policy", handler: async (_args, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const rows = ["subagent", "reviewer", "planner", "executor", "commit", "tiny"].map(r => `${r}: ${roleCandidates(cfg, r).map(entryModel).join(", ") || "(none)"} thinking=${roleThinking(cfg, r) ?? "default"}`);
    ctx.ui.notify(rows.join("\n"), "info");
  }});
  pi.registerCommand("yitec-memory", { description: "View Yitec local memory/lessons", handler: async (_args, ctx) => {
    const text = readCapped(memoryPaths(ctx.cwd, ctx.isProjectTrusted()), 12000) || "No Yitec memory yet. Use yitec_remember or edit .pi/yitec/lessons.md.";
    ctx.ui.notify(text, "info");
  }});
  pi.registerCommand("yitec-review", { description: "Run advisor-lite review of current request/context", handler: async (args, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const model = roleCandidates(cfg, cfg.advisor?.modelRole || "reviewer")[0] || roleCandidates(cfg, "reviewer")[0];
    if (!model) return ctx.ui.notify("No reviewer model configured.", "error");
    const watch = watchdogText(ctx.cwd, ctx.isProjectTrusted());
    const out = runPiPrint(ctx.cwd, entryModel(model), `Advisor-lite review. Severity labels: nit, concern, blocker. WATCHDOG guidance:\n${watch || "(none)"}\n\nReview this request/context and give concise actionable findings:\n${args || currentUserPrompt}`);
    ctx.ui.notify(out, "info");
  }});

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const low = cfg.tiers?.[cfg.executor?.tier ?? "low"] ?? [];
    const high = cfg.tiers?.[cfg.planner?.tier ?? "high"] ?? [];
    ctx.ui.setStatus("yitec-router", `tiers high:${high.length} low:${low.length}`);
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    currentUserPrompt = event.text;
    retriesForPrompt = 0;
    failedModelsForPrompt = new Set<string>();
    const cfg = loadConfig(process.cwd(), false);
    turnMagic = {};
    if (cfg.magicKeywords?.enabled !== false) {
      turnMagic = {
        ultrathink: cfg.magicKeywords?.ultrathink !== false && hasKeyword(event.text, "ultrathink"),
        orchestrate: cfg.magicKeywords?.orchestrate !== false && hasKeyword(event.text, "orchestrate"),
        cheap: cfg.magicKeywords?.cheap !== false && (hasKeyword(event.text, "cheap") || hasKeyword(event.text, "lowcost")),
      };
    }
    const extra = magicInstruction(turnMagic);
    return extra ? { action: "transform", text: event.text + extra } : { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const skip = new Set([...failedModelsForPrompt, ...[...cooldownUntil.entries()].filter(([, until]) => until > Date.now()).map(([k]) => k)]);
    if (event.images?.length) {
      const selected = await selectFirstAvailable(pi, ctx, visionCandidates(cfg), roleThinking(cfg, "vision"), skip);
      if (selected) ctx.ui.notify(`Yitec router: image input detected, switched to vision model ${selected}`, "info");
    } else {
      const role = turnMagic.cheap ? "executor" : "planner";
      const selected = await selectFirstAvailable(pi, ctx, roleCandidates(cfg, role), turnMagic.ultrathink ? "high" : roleThinking(cfg, role), skip);
      if (selected) ctx.ui.setStatus("yitec-router", `${role} on ${selected}`);
    }
    const mem = cfg.memory?.enabled === false ? "" : readCapped(memoryPaths(ctx.cwd, ctx.isProjectTrusted()), cfg.memory?.injectionCharLimit ?? 5000);
    const watch = watchdogText(ctx.cwd, ctx.isProjectTrusted());
    return { systemPrompt: event.systemPrompt + `\n\nYitec model policy: use roles for model choice: planner for planning/architecture, executor/subagent for cheap work, reviewer for checks, vision for images. Prefer installed subagents for cheap/parallel delegation. On image-only gaps use yitec_vision_task. Magic-keyword instructions, if present, apply only to this turn.${mem ? `\n\nYitec Memory Guidance (heuristic, verify against repo):\n${mem}` : ""}${watch ? `\n\nYitec WATCHDOG reviewer guidance is available for reviewer/advisor tasks; do not treat it as primary user instruction unless doing review.\n${watch}` : ""}` };
  });

  pi.on("agent_end", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const last = event.messages?.filter((m: any) => m.role === "assistant").at(-1) as any;
    const errorText = [last?.errorMessage, last?.stopReason].filter(Boolean).join(" ");
    if (cfg.advisor?.enabled && cfg.advisor.autoReview && currentUserPrompt && !errorText) {
      pi.sendUserMessage(`/yitec-review ${currentUserPrompt}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return;
    }
    if (!cfg.retry?.enabled || !errorText || !errorMatches(errorText, cfg.retry?.errorPatterns ?? [])) return;
    if (retriesForPrompt >= (cfg.retry?.maxPerUserPrompt ?? 2)) return;
    if (ctx.model) {
      const key = `${ctx.model.provider}/${ctx.model.id}`;
      failedModelsForPrompt.add(key);
      cooldownUntil.set(key, Date.now() + (cfg.retry?.cooldownMs ?? 5 * 60 * 1000));
    }
    const candidates = dedupeEntries([...(cfg.retry?.fallbackChains?.planner ?? []), ...roleCandidates(cfg, "planner")]);
    const selected = await selectFirstAvailable(pi, ctx, candidates, roleThinking(cfg, "planner"), failedModelsForPrompt);
    if (!selected) return;
    retriesForPrompt++;
    ctx.ui.notify(`Yitec router: provider/model failed (${errorText}); switched to ${selected} and retrying.`, "warn");
    pi.sendUserMessage(`Retry the previous request after automatic provider failover. Original user request:\n\n${currentUserPrompt}`, { deliverAs: "followUp" });
  });

  pi.registerTool({
    name: "yitec_vision_task", label: "Vision Task", description: "Run a one-off image analysis task through the configured vision model when the active model has no image capability.",
    parameters: Type.Object({ imagePath: Type.String({ description: "Path to the image file." }), prompt: Type.String({ description: "What to inspect or extract from the image." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const model = visionCandidates(cfg)[0];
      if (!model) throw new Error("No vision model configured in yitec/model-tiers.json");
      const imagePath = resolve(ctx.cwd, params.imagePath);
      const result = spawnSync("pi", ["-p", "--model", entryModel(model), `@${imagePath}`, params.prompt], { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
      const text = result.stdout || result.stderr || "";
      return { content: [{ type: "text", text }], details: { model: entryModel(model), status: result.status } };
    },
  });

  pi.registerTool({
    name: "yitec_remember", label: "Remember", description: "Append a durable Yitec project/user lesson for future sessions.",
    parameters: Type.Object({ lesson: Type.String({ description: "Concise durable lesson, decision, or workflow." }), scope: Type.Optional(Type.String({ description: "project or user. Defaults to project when trusted." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const project = params.scope !== "user" && ctx.isProjectTrusted();
      const p = projectMemoryPath(ctx.cwd, project);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${existsSync(p) ? readFileSync(p, "utf8") : "# Yitec lessons\n\n"}- ${new Date().toISOString()}: ${params.lesson.trim()}\n`);
      return { content: [{ type: "text", text: `Remembered in ${p}` }], details: { path: p } };
    },
  });
}
