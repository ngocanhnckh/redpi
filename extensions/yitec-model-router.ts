import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  autoUpdate?: { enabled?: boolean; intervalHours?: number; updateHarness?: boolean; updateSkills?: boolean };
  // strict: use only each role's own models (no tiers, fallback chains, failover, or MainAgent default).
  routing?: { mode?: "auto" | "strict" };
  folder?: string;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const USER_YITEC_DIR = join(AGENT_DIR, "yitec");
const NINE_ROUTER_LOCAL_PATH = join(USER_YITEC_DIR, "9router.local.json");
const CLAUDE_BRIDGE_CONFIG_PATH = join(AGENT_DIR, "claude-bridge.json");
const PROVIDER_PROFILES_PATH = join(USER_YITEC_DIR, "provider-profiles.json");
const ONBOARDING_MARKER_PATH = join(USER_YITEC_DIR, "onboarding.json");
// Per-folder role configs live in the user dir (keyed by folder path), so they
// need no project trust and never end up in the repository.
const FOLDER_CONFIG_DIR = join(USER_YITEC_DIR, "folders");
const ROLE_NAMES = ["planner", "executor", "subagent", "reviewer", "vision", "commit", "tiny", "default"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;
// Preset role profiles for /redpi-config. They reference 9Router combos by exact name, so
// they only work on a gateway that defines combos with these names (see README).
const ROLE_PROFILES: Record<string, { label: string; summary: string; roles: Record<string, [string, string]> }> = {
  cybersecurity: {
    label: "🛡 Cybersecurity",
    summary: "Security research and pentest work: OpenMed plans, reviews and reads screenshots; norail executes and runs subagents; SubAgent writes commits; OpenSmall handles tiny tasks.",
    roles: {
      planner: ["OpenMed", "high"],
      executor: ["norail", "high"],
      subagent: ["norail", "xhigh"],
      reviewer: ["OpenMed", "high"],
      vision: ["OpenMed", "medium"],
      commit: ["SubAgent", "low"],
      tiny: ["OpenSmall", "off"],
      default: ["norail", "medium"],
    },
  },
};

function profileRoles(key: string): Record<string, RoleConfig> {
  return Object.fromEntries(Object.entries(ROLE_PROFILES[key].roles).map(([role, [combo, thinking]]) => [role, { models: [`9router/${combo}:${thinking}`], thinking }]));
}

// Role config chosen with "This session only"; cleared when a new session starts.
let sessionOverride: Config | undefined;
// True while RedPi itself switches models, so model_select can tell user picks apart.
let redpiSwitching = false;
const DEFAULT_CONFIG: Required<Omit<Config, "routing" | "folder">> & Config = {
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
  autoUpdate: { enabled: true, intervalHours: 24, updateHarness: true, updateSkills: true },
};

type LoadedConfig = Config & { __path?: string; __projectTrusted?: boolean };

type TurnMagic = { ultrathink?: boolean; orchestrate?: boolean; cheap?: boolean; pixelperfect?: boolean; responsive?: boolean; a11y?: boolean; screenshot?: boolean };

const REDPI_BANNER_FULL = [
  "██████╗ ███████╗██████╗ ██████╗ ██╗",
  "██╔══██╗██╔════╝██╔══██╗██╔══██╗██║",
  "██████╔╝█████╗  ██║  ██║██████╔╝██║",
  "██╔══██╗██╔══╝  ██║  ██║██╔═══╝ ██║",
  "██║  ██║███████╗██████╔╝██║     ██║",
  "╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝     ╚═╝",
  "powered by YITEC",
];
// Matrix-terminal palette: phosphor green, cyan signal, and restrained dim text.
const MATRIX = "\x1b[38;5;46m";
const MATRIX_BRIGHT = "\x1b[38;5;82m";
const CYAN = "\x1b[38;5;51m";
const RED_SIGNAL = "\x1b[38;5;196m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const REDPI_BANNER_COMPACT = [`${MATRIX_BRIGHT}◢ ${RED_SIGNAL}Red${MATRIX_BRIGHT}Pi${RESET} ${DIM}//${RESET} ${CYAN}YITEC SYSTEMS ONLINE${RESET}`];
function redpiBanner() {
  if (process.env.REDPI_COLOR === "0") return process.env.REDPI_FULL_BANNER === "1" ? REDPI_BANNER_FULL : ["RedPi // YITEC SYSTEMS ONLINE"];
  return process.env.REDPI_FULL_BANNER === "1"
    ? REDPI_BANNER_FULL.map((line, i) => i < 6 ? `${RED_SIGNAL}${line.slice(0, 25)}${MATRIX_BRIGHT}${line.slice(25)}${RESET}` : `${CYAN}${line}${RESET}`)
    : REDPI_BANNER_COMPACT;
}
function contextBar(used: number, total?: number) {
  if (!total || total <= 0) return `${used.toLocaleString()} tok`;
  const pct = Math.min(1, used / total);
  const width = 18;
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return `${bar} ${used.toLocaleString()}/${Math.round(total / 1000)}k ${Math.round(pct * 100)}%`;
}

function readJson(path: string, fallback: any) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function folderConfigPath(dir: string): string {
  return join(FOLDER_CONFIG_DIR, `${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16)}.json`);
}

function findFolderConfig(cwd: string): string | undefined {
  // The nearest configured ancestor wins, so subfolders share their project's setup.
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const p = folderConfigPath(dir);
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) return undefined;
  }
}

function configPaths(cwd: string, projectTrusted = false): string[] {
  const folder = findFolderConfig(cwd);
  return [
    ...(folder ? [folder] : []),
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "yitec", "model-tiers.json")] : []),
    join(USER_YITEC_DIR, "model-tiers.json"),
  ];
}

function loadConfig(cwd: string, projectTrusted = false): LoadedConfig {
  if (sessionOverride) return deepMerge(DEFAULT_CONFIG, sessionOverride, { __path: "(this session only)", __projectTrusted: projectTrusted });
  for (const path of configPaths(cwd, projectTrusted)) {
    if (existsSync(path)) return deepMerge(DEFAULT_CONFIG, readJson(path, {}), { __path: path, __projectTrusted: projectTrusted });
  }
  return { ...DEFAULT_CONFIG, __projectTrusted: projectTrusted };
}

function configWritePath(cwd: string, projectTrusted = false, scope: "global" | "project" = "global"): string {
  if (scope === "project" && projectTrusted) return join(cwd, CONFIG_DIR_NAME, "yitec", "model-tiers.json");
  return join(USER_YITEC_DIR, "model-tiers.json");
}

function writeJson(path: string, value: any) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function patchPiSettings(defaultModel?: string, thinking = "low") {
  const p = join(AGENT_DIR, "settings.json");
  const s = readJson(p, {});
  if (defaultModel) {
    const full = defaultModel.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    const slash = full.indexOf("/");
    s.defaultProvider = slash > 0 ? full.slice(0, slash) : "9router";
    s.defaultModel = slash > 0 ? full.slice(slash + 1) : full;
    s.defaultThinkingLevel = thinking;
  }
  // RedPi owns this named theme unless the user explicitly disables automatic theming.
  if (process.env.REDPI_THEME !== "0") s.theme = process.env.REDPI_THEME || "redpi-matrix";
  s.retry = { ...(s.retry || {}), provider: { ...((s.retry || {}).provider || {}), timeoutMs: Math.max(Number((s.retry || {}).provider?.timeoutMs || 0), 900000), maxRetries: 0, maxRetryDelayMs: 60000 } };
  s.httpIdleTimeoutMs = Math.max(Number(s.httpIdleTimeoutMs || 0), 900000);
  s.skills = repairSkillPaths(s.skills || []);
  // Subagent models follow the active global RedPi profile (9Router combos or Claude bridge).
  s.subagents = subagentSettings(s.subagents, readJson(join(USER_YITEC_DIR, "model-tiers.json"), {}));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

function repairSkillPaths(skills: string[]): string[] {
  // Matt Pocock moved skills from .agents/skills to skills/<bucket>; older installs
  // point at the removed folder and silently load nothing.
  const mattDir = join(AGENT_DIR, "vendor", "mattpocock-skills");
  const liquidDir = join(AGENT_DIR, "vendor", "liquid-glass-frontend-skill");
  const mattSkills = ["engineering", "productivity"].map((bucket) => join(mattDir, "skills", bucket)).filter((p) => existsSync(p));
  const kept = skills.filter((p) => !String(p).startsWith(mattDir));
  return [...new Set([...kept, ...mattSkills, ...(existsSync(join(liquidDir, "SKILL.md")) ? [liquidDir] : [])])];
}

function subagentSettings(existing: any, cfg: any): any {
  // pi-subagents rejects the removed fallbackModels field at load, so always strip it.
  const withoutRemovedFallbacks = (value: any) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { fallbackModels: _removed, ...rest } = value;
    return rest;
  };
  const overrides = Object.fromEntries(Object.entries(existing?.agentOverrides || {}).map(([name, value]) => [name, withoutRemovedFallbacks(value)])) as Record<string, any>;
  const { main, fast, review } = subagentModelsFromConfig(cfg);
  if (!main || !fast) return { ...(existing || {}), agentOverrides: overrides };
  return {
    ...(existing || {}),
    defaultModel: fast,
    defaultThinking: "low",
    agentOverrides: {
      ...overrides,
      oracle: { ...(overrides.oracle || {}), model: main, thinking: "high" },
      reviewer: { ...(overrides.reviewer || {}), model: review || main, thinking: "high" },
      scout: { ...(overrides.scout || {}), model: fast, thinking: "off" },
      worker: { ...(overrides.worker || {}), model: fast, thinking: "low" },
    },
  };
}

function writeFolderSubagents(folder: string, cfg: any): string {
  // pi-subagents only reads per-project models from the project's .pi/settings.json.
  const p = join(folder, CONFIG_DIR_NAME, "settings.json");
  const s = readJson(p, {});
  s.subagents = subagentSettings(s.subagents, cfg);
  writeJson(p, s);
  return p;
}

function snapshotConfig(cfg: LoadedConfig): Config {
  // Resolve every role to one concrete model so a strict config is self-contained.
  const { __path: _p, __projectTrusted: _t, ...rest } = cfg as any;
  const roles: Record<string, RoleConfig> = {};
  for (const role of ROLE_NAMES) {
    const entry = roleCandidates(cfg, role)[0];
    if (!entry) continue;
    const parsed = splitModel(entryModel(entry));
    if (!parsed.provider) continue;
    const thinking = parsed.thinking ?? entryThinking(entry) ?? roleThinking(cfg, role) ?? "medium";
    roles[role] = { models: [`${parsed.provider}/${parsed.id}:${thinking}`], thinking };
  }
  return { ...rest, roles };
}

function roleModelLabel(cfg: Config, role: string): string | undefined {
  const entry = roleCandidates(cfg, role)[0];
  return entry ? entryModel(entry) : undefined;
}

function subagentModelsFromConfig(cfg: any): { main?: string; fast?: string; review?: string } {
  const first = (role: string) => {
    const rc = cfg?.roles?.[role];
    const entry = typeof rc === "string" ? (rc.includes("/") ? rc : undefined) : rc?.model || rc?.models?.[0];
    const model = entry && entryModel(entry).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    return model && model.includes("/") ? model : undefined;
  };
  const main = first("planner") || first("default");
  const fast = first("subagent") || first("executor") || main;
  return { main, fast, review: first("reviewer") || main };
}

function patchPiDefaults(modelId: string, thinking = "low") {
  patchPiSettings(modelId, thinking);
}

function modelOptionMap(models: string[], max = 60) {
  const map = new Map<string, string>();
  const labels = models.map((m, i) => {
    const label = m.length > max ? `${m.slice(0, Math.max(20, max - 14))}…${m.slice(-10)}` : m;
    const display = `${String(i + 1).padStart(Math.max(2, String(models.length).length), "0")}. ${label}`;
    map.set(display, m);
    return display;
  });
  return { labels, map };
}

function autoConfigFromNineRouter(ids: string[]) {
  const lower = (s: string) => s.toLowerCase();
  const exact = (...names: string[]) => ids.find(id => names.some(n => lower(id) === lower(n) || lower(id).endsWith(`/${lower(n)}`)));
  const contains = (...hints: string[]) => ids.find(id => hints.some(h => lower(id).includes(lower(h))));
  const avoidInactive = (id?: string) => id && !/^(ClaudeOpus|ClaudeSubAgent)$/i.test(id) ? id : undefined;
  // 9Router teams often publish named combos. Prefer exact MainAgent/SubAgent,
  // then tested low-friction Terra/redstone routes. Avoid legacy ClaudeOpus /
  // ClaudeSubAgent auto-picks because those often depend on user OAuth that may
  // list but fail at chat time.
  const main = exact("MainAgent", "main-agent", "main_agent") || contains("redstone-gpt", "gpt-5.6-terra", "terra") || avoidInactive(contains("opus", "sonnet", "gpt", "auto")) || ids[0] || "MainAgent";
  const sub = exact("SubAgent", "sub-agent", "sub_agent") || contains("lightweight", "fast", "mini", "haiku", "free", "redstone-gpt") || main;
  const review = contains("review", "reviewer", "critic") || main;
  const high = main;
  const low = sub;
  return {
    ...DEFAULT_CONFIG,
    roles: {
      default: { models: [`9router/${high}:medium`], thinking: "medium" },
      planner: { models: [`9router/${high}:high`], thinking: "high" },
      executor: { models: [`9router/${low}:low`], thinking: "low" },
      subagent: { models: [`9router/${low}:low`], thinking: "low" },
      reviewer: { models: [`9router/${review}:medium`], thinking: "medium" },
      vision: { models: [`9router/${high}:medium`], thinking: "medium" },
      commit: { models: [`9router/${low}:low`], thinking: "low" },
      tiny: { models: [`9router/${low}:off`], thinking: "off" },
    },
    tiers: {
      high: [{ model: `9router/${high}`, vision: true, thinking: "high", rate: { input: 0, output: 0 } }],
      low: [{ model: `9router/${low}`, vision: true, thinking: "low", rate: { input: 0, output: 0 } }],
      uncapable: []
    },
    retry: { ...DEFAULT_CONFIG.retry, fallbackChains: { planner: [`9router/${high}:high`], executor: [`9router/${low}:low`], reviewer: [`9router/${review}:medium`] } }
  };
}

// Model picker for large catalogs: MainAgent/SubAgent first, every model listed (no cut-off),
// plus word search. Choosing one of `extras` returns that extra's text.
async function pickModel(ctx: any, title: string, models: string[], current?: string, opts: { keepLabel?: string; extras?: string[] } = {}): Promise<string | undefined> {
  const keep = current ? `${opts.keepLabel || "✅ keep"}: ${current}` : undefined;
  const search = `🔍 Search ${models.length} models…`;
  const manual = "✍️ manual entry";
  const ordered = [...new Set([...models.filter(m => /(^|\/)(MainAgent|SubAgent)$/i.test(m)), ...models])];
  const { labels, map } = modelOptionMap(ordered);
  for (;;) {
    // Search only earns its place on long lists (e.g. REDPI_9ROUTER_ALL_MODELS=1).
    const choice = await ctx.ui.select(title, [...(keep ? [keep] : []), ...(ordered.length > 20 ? [search] : []), manual, ...(opts.extras || []), ...labels]);
    if (!choice) return undefined;
    if (choice === keep) return current;
    if (opts.extras?.includes(choice)) return choice;
    if (choice === manual) return (await ctx.ui.input(`${title} (provider/model)`, current || "9router/MainAgent"))?.trim() || undefined;
    if (choice !== search) return map.get(choice);
    const query = (await ctx.ui.input("Search models (words in any order)", "e.g. opus thinking"))?.trim().toLowerCase();
    if (!query) continue;
    const words = query.split(/\s+/);
    const hits = ordered.filter(m => words.every(w => m.toLowerCase().includes(w)));
    if (!hits.length) { ctx.ui.notify(`No models match "${query}".`, "warning"); continue; }
    const found = modelOptionMap(hits);
    const pick = await ctx.ui.select(`${title}: ${hits.length} match "${query}"`, [...found.labels, "↩ back"]);
    if (pick && pick !== "↩ back") return found.map.get(pick);
  }
}

async function customizeRolesWithUi(ctx: any, ids: string[], cfgPath: string) {
  const options = ids.map(id => `9router/${id}`);
  if (!options.length) return undefined;
  const cfg: any = autoConfigFromNineRouter(ids);
  const roles = [
    { role: "planner", label: "planner / main session / heavy thinking", thinking: "high", recommended: cfg.roles.planner.models[0] },
    { role: "executor", label: "executor / normal edits", thinking: "low", recommended: cfg.roles.executor.models[0] },
    { role: "subagent", label: "subagent / fast delegated work", thinking: "low", recommended: cfg.roles.subagent.models[0] },
    { role: "reviewer", label: "reviewer / critique", thinking: "medium", recommended: cfg.roles.reviewer.models[0] },
    { role: "vision", label: "vision / screenshots", thinking: "medium", recommended: cfg.roles.vision.models[0] },
    { role: "commit", label: "commit / summaries", thinking: "low", recommended: cfg.roles.commit.models[0] },
    { role: "tiny", label: "tiny / cheapest tasks", thinking: "off", recommended: cfg.roles.tiny.models[0] },
  ];
  const SKIP = "⏭ skip remaining roles / save now";
  for (const r of roles) {
    const recommended = String(r.recommended).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    const model = await pickModel(ctx, `Model for ${r.label}`, options, recommended, { keepLabel: "✅ use recommended", extras: [SKIP] });
    if (!model) return undefined;
    if (model === SKIP) break;
    cfg.roles[r.role] = { models: [`${model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")}:${r.thinking}`], thinking: r.thinking };
  }
  writeJson(cfgPath, cfg);
  patchPiDefaults(String(cfg.roles.planner.models[0]).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""), "high");
  return cfg;
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
  if (cfg.routing?.mode === "strict") return roleCandidates(cfg, "vision");
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
  const rc: RoleConfig | undefined = cfg.roles?.[role] ?? (role === "planner" ? cfg.planner : role === "executor" ? cfg.executor : undefined);
  if (!rc) return [];
  if (typeof rc === "string") return rc.includes("/") ? [rc] : (cfg.tiers?.[rc] ?? []);
  const direct = [...(rc.model ? [rc.model] : []), ...(rc.models ?? [])];
  if (cfg.routing?.mode === "strict") return dedupeEntries(direct);
  const tier = rc.tier ? (cfg.tiers?.[rc.tier] ?? []) : [];
  return dedupeEntries([...direct, ...tier, ...(rc.fallbacks ?? []), ...(cfg.retry?.fallbackChains?.[role] ?? [])]);
}
function roleThinking(cfg: Config, role: string): string | undefined {
  const rc: RoleConfig | undefined = cfg.roles?.[role] ?? (role === "planner" ? cfg.planner : role === "executor" ? cfg.executor : undefined);
  return typeof rc === "object" ? rc.thinking : undefined;
}
async function selectFirstAvailable(pi: ExtensionAPI, ctx: ExtensionContext, entries: ModelEntry[], thinking?: string, skip = new Set<string>()): Promise<string | undefined> {
  for (const entry of entries) {
    if (skip.has(entryKey(entry))) continue;
    const parsed = splitModel(entryModel(entry));
    if (!parsed.provider) continue;
    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) continue;
    redpiSwitching = true;
    let ok = false;
    try { ok = await pi.setModel(model); } finally { redpiSwitching = false; }
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
  if (m.pixelperfect) lines.push("- pixelperfect: use browser screenshots/text/console when available; verify visual spacing, alignment, overflow, and before/after behavior.");
  if (m.responsive) lines.push("- responsive: verify mobile/tablet/desktop layout concerns and avoid desktop-only fixes.");
  if (m.a11y) lines.push("- a11y: check labels, keyboard flow, contrast, semantic roles, focus states, and error messaging.");
  if (m.screenshot) lines.push("- screenshot: use redpi_browser screenshot or frontend-check when a live URL/dev server is available.");
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
function designText(cwd: string, projectTrusted = false): string {
  return readCapped([
    join(USER_YITEC_DIR, "design.md"),
    ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, "yitec", "design.md")] : []),
  ], 5000);
}
function looksFrontendTask(text: string): boolean {
  return /\b(ui|ux|frontend|front-end|css|tailwind|responsive|mobile|layout|component|landing|dashboard|pixel|screenshot|browser|a11y|accessibility|storybook|shadcn|react|nextjs|next\.js|vite)\b/i.test(text);
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
type RunResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

// Never use spawnSync for anything slow: it blocks Pi's event loop, so the TUI stops
// taking keystrokes until the child exits. This runs the child in its own process group
// and kills the whole group (e.g. Chromium) on timeout or when the user aborts.
function runAsync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const maxBytes = opts.maxBytes ?? 1024 * 1024 * 4;
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killTree = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs) : undefined;
    const onAbort = () => killTree();
    opts.signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => { if (stdout.length < maxBytes) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < maxBytes) stderr += d; });
    const finish = (status: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      if (error) stderr += `${stderr ? "\n" : ""}${error.message}`;
      if (timedOut) stderr += `${stderr ? "\n" : ""}Timed out after ${Math.round((opts.timeoutMs || 0) / 1000)}s and was stopped.`;
      resolvePromise({ status, stdout, stderr, timedOut });
    };
    // "exit" (not "close"): a leftover grandchild holding the pipes must not keep us waiting.
    child.on("exit", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}

async function runPiPrint(cwd: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const result = await runAsync("pi", ["-p", "--model", model, prompt], { cwd, signal, timeoutMs: 10 * 60 * 1000, maxBytes: 1024 * 1024 * 10 });
  return result.stdout || result.stderr || `pi exited with status ${result.status}`;
}

function localNineRouter(): { baseUrl?: string; apiKey?: string } {
  return readJson(NINE_ROUTER_LOCAL_PATH, {});
}

function normalizeNineRouterBaseUrl(input: string): string {
  let url = String(input || "").trim();
  if (!url) return "http://127.0.0.1:20128/v1";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  return url;
}

function nineRouterBaseUrl(): string {
  const local = localNineRouter();
  return normalizeNineRouterBaseUrl(process.env.NINE_ROUTER_BASE_URL || process.env.ROUTER9_BASE_URL || local.baseUrl || "http://127.0.0.1:20128/v1");
}

function nineRouterApiKey(): string {
  const local = localNineRouter();
  return process.env.NINE_ROUTER_API_KEY || process.env.ROUTER9_API_KEY || process.env.NINEROUTER_API_KEY || local.apiKey || "dummy";
}

function nineRouterApiKeyCommand(): string {
  return `!${process.execPath} ${join(packageRoot(), "scripts", "redpi-9router-key.js")}`;
}

function nineRouterContextWindow(id: string): number {
  // 9Router's OpenAI-compatible /models response currently exposes only model IDs.
  // Keep metadata for its named 1M agent combinations so Pi does not compact them
  // at the generic discovery fallback (200k) before the router receives a request.
  return /^(MainAgent|SubAgent)$/i.test(id) ? 1_000_000 : 200_000;
}

// One browser command at a time: every command reopens the same persistent Chromium
// profile, and parallel launches on one profile fail or stall.
const BROWSER_TIMEOUT_MS = Number(process.env.REDPI_BROWSER_TOOL_TIMEOUT_MS || 60000);
let browserQueue: Promise<unknown> = Promise.resolve();
function serializeBrowser<T>(task: () => Promise<T>): Promise<T> {
  const next = browserQueue.then(task, task);
  browserQueue = next.catch(() => {});
  return next;
}

async function installBrowserRuntime(): Promise<string> {
  const root = packageRoot();
  const lines: string[] = [];
  lines.push(await run("npm", ["install", "--no-audit", "--no-fund"], root, 10 * 60 * 1000));
  lines.push(await run("npx", ["playwright", "install", "chromium"], root, 10 * 60 * 1000));
  try { chmodSync(join(root, "scripts", "redpi-browser.js"), 0o755); } catch {}
  return lines.join("\n\n");
}

function claudeAuthStatus(): { installed: boolean; loggedIn: boolean; summary: string } {
  // Bounded: a hung `claude` CLI must not freeze onboarding or the Claude menu.
  const result = spawnSync("claude", ["auth", "status"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 8000 });
  if (result.error && (result.error as any).code === "ENOENT") return { installed: false, loggedIn: false, summary: "Claude Code CLI is not installed. Install it first: https://docs.anthropic.com/en/docs/claude-code" };
  const raw = `${result.stdout || ""}${result.stderr || ""}`.trim();
  try {
    const auth = JSON.parse(raw);
    if (auth?.loggedIn) return { installed: true, loggedIn: true, summary: `Signed in to Claude Code as ${auth.email || "your account"}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ""}.` };
  } catch {}
  return { installed: true, loggedIn: false, summary: raw || "Claude Code is installed but is not signed in. Run `claude auth login --claudeai` in a normal terminal." };
}

function claudeBridgeRoleConfig(): any {
  const main = "claude-bridge/claude-opus-5";
  const fast = "claude-bridge/claude-sonnet-5";
  return deepMerge(DEFAULT_CONFIG, { roles: {
    default: { models: [`${main}:medium`], thinking: "medium" },
    planner: { models: [`${main}:high`], thinking: "high" },
    reviewer: { models: [`${main}:high`], thinking: "high" },
    vision: { models: [`${main}:medium`], thinking: "medium" },
    executor: { models: [`${fast}:low`], thinking: "low" },
    subagent: { models: [`${fast}:low`], thinking: "low" },
    commit: { models: [`${fast}:low`], thinking: "low" },
    tiny: { models: [`${fast}:off`], thinking: "off" },
  }});
}

function mainAgentRoleConfig(): any {
  const main = "9router/MainAgent";
  const fast = "9router/SubAgent";
  return deepMerge(DEFAULT_CONFIG, { roles: {
    default: { models: [`${main}:medium`], thinking: "medium" },
    planner: { models: [`${main}:high`], thinking: "high" },
    reviewer: { models: [`${main}:high`], thinking: "high" },
    vision: { models: [`${main}:medium`], thinking: "medium" },
    executor: { models: [`${fast}:low`], thinking: "low" },
    subagent: { models: [`${fast}:low`], thinking: "low" },
    commit: { models: [`${fast}:low`], thinking: "low" },
    tiny: { models: [`${fast}:off`], thinking: "off" },
  }, tiers: {
    high: [{ model: main, vision: true, thinking: "high", rate: { input: 0, output: 0 } }],
    low: [{ model: fast, vision: true, thinking: "low", rate: { input: 0, output: 0 } }],
  }, retry: { fallbackChains: { planner: [`${main}:high`], executor: [`${fast}:low`], reviewer: [`${main}:high`] } }});
}

function onboardingComplete(): boolean {
  return readJson(ONBOARDING_MARKER_PATH, {}).completed === true;
}

function finishOnboarding(provider: "router" | "claude" | "manual") {
  writeJson(ONBOARDING_MARKER_PATH, { completed: true, provider, completedAt: new Date().toISOString() });
}

function profileModeFromConfig(cfg: any): "router" | "claude" {
  const main = String(cfg?.roles?.planner?.models?.[0] || cfg?.roles?.default?.models?.[0] || "");
  return main.startsWith("claude-bridge/") ? "claude" : "router";
}

function switchProviderProfile(cwd: string, trusted: boolean, mode: "router" | "claude"): string {
  const configPath = configWritePath(cwd, trusted, "global");
  const current = readJson(configPath, {});
  const profiles = readJson(PROVIDER_PROFILES_PATH, {});
  const active = profiles.active === "claude" || profiles.active === "router" ? profiles.active : profileModeFromConfig(current);
  // Snapshot every active profile before changing it, so role customizations survive switches.
  profiles[active] = current;
  if (!profiles.router) profiles.router = mainAgentRoleConfig();
  if (!profiles.claude) profiles.claude = claudeBridgeRoleConfig();
  writeJson(configPath, profiles[mode]);
  profiles.active = mode;
  writeJson(PROVIDER_PROFILES_PATH, profiles);
  if (mode === "claude") patchPiDefaults("claude-bridge/claude-opus-5", "high");
  else patchPiDefaults("9router/MainAgent", "high");
  const label = mode === "claude" ? "Claude bridge (Opus main, Sonnet subagents)" : "9Router (MainAgent main, SubAgent subagents)";
  return `Switched RedPi to ${label}.\n\nActive roles: ${configPath}\nSaved profiles: ${PROVIDER_PROFILES_PATH}\n\nRestart Pi or run /reload to apply the provider/model default.`;
}

async function pingNineRouter(signal?: AbortSignal): Promise<string> {
  const live = await fetchNineRouterModels(signal);
  return live.length ? `Connected. ${live.length} models/combos found. Examples: ${live.map((m: any) => m.id).slice(0, 8).join(", ")}` : `Could not fetch /models from ${nineRouterBaseUrl()}. Check URL, key, or whether 9Router is running.`;
}

const NINE_ROUTER_MODELS_CACHE_PATH = join(USER_YITEC_DIR, "9router-models.json");

function nineRouterModelEntry(m: any) {
  const id = typeof m === "string" ? m : m.id;
  const caps = (typeof m === "object" && m?.capabilities) || {};
  return {
    id,
    name: `9Router ${id}`,
    reasoning: caps.reasoning ?? true,
    input: caps.vision === false ? ["text"] : ["text", "image"],
    contextWindow: /^(MainAgent|SubAgent)$/i.test(id) ? nineRouterContextWindow(id) : caps.contextWindow || nineRouterContextWindow(id),
    maxTokens: caps.maxOutput || 64000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// RedPi lists only 9Router combos (owned_by "combo"): a gateway can expose hundreds of raw
// provider routes, which buries the team's curated combos. Older gateways without owned_by
// fall back to slash-free IDs; REDPI_9ROUTER_ALL_MODELS=1 lists everything.
function nineRouterCombos(data: any[]): any[] {
  const models = data.filter((m: any) => m?.id);
  if (process.env.REDPI_9ROUTER_ALL_MODELS === "1") return models;
  const combos = models.filter((m: any) => m.owned_by === "combo");
  if (combos.length) return combos;
  const unprefixed = models.filter((m: any) => !String(m.id).includes("/"));
  return unprefixed.length ? unprefixed : models;
}

function cachedNineRouterModels(maxAgeMs = Infinity): any[] {
  const cache = readJson(NINE_ROUTER_MODELS_CACHE_PATH, {});
  // The cache belongs to one gateway; a changed base URL must not show another router's models.
  if (cache.baseUrl !== nineRouterBaseUrl() || !Array.isArray(cache.models) || Date.now() - (cache.at || 0) > maxAgeMs) return [];
  return cache.models.map(nineRouterModelEntry);
}

// Live /models only, so connection checks never report a cached list as "Connected".
// Pass { cache: true } for model pickers, which fall back to the last good list.
async function fetchNineRouterModels(signal?: AbortSignal, opts: { cache?: boolean } = {}): Promise<any[]> {
  const controller = new AbortController();
  // Large 9Router catalogs (700+ models) take several seconds to list.
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS || 10000));
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${nineRouterBaseUrl().replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${nineRouterApiKey()}` },
      signal: controller.signal,
    });
    if (!res.ok) return opts.cache ? cachedNineRouterModels() : [];
    const json = (await res.json()) as any;
    const models = nineRouterCombos(Array.isArray(json?.data) ? json.data : []);
    if (models.length) {
      try { writeJson(NINE_ROUTER_MODELS_CACHE_PATH, { at: Date.now(), baseUrl: nineRouterBaseUrl(), models }); } catch {}
    }
    return models.map(nineRouterModelEntry);
  } catch {
    return opts.cache ? cachedNineRouterModels() : [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function packageRoot(): string {
  const here = typeof __dirname === "string" ? __dirname : process.cwd();
  return resolve(here, "..");
}

async function run(cmd: string, args: string[], cwd?: string, timeoutMs = 2 * 60 * 1000): Promise<string> {
  const r = await runAsync(cmd, args, { cwd, timeoutMs, maxBytes: 1024 * 1024 * 3 });
  const text = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return `${cmd} ${args.join(" ")} -> ${r.status ?? "?"}${text ? `\n${text}` : ""}`;
}

function shouldAutoUpdate(cfg: Config): boolean {
  if (cfg.autoUpdate?.enabled === false) return false;
  const marker = join(USER_YITEC_DIR, "last-update-check.json");
  const last = readJson(marker, { at: 0 }).at || 0;
  const intervalMs = Math.max(1, cfg.autoUpdate?.intervalHours ?? 24) * 60 * 60 * 1000;
  if (Date.now() - last < intervalMs) return false;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ at: Date.now() }, null, 2) + "\n");
  return true;
}

async function updateRedPi(cfg: Config, force = false): Promise<string> {
  const lines = [`RedPi update ${force ? "forced" : "auto"}`];
  if (!force && !shouldAutoUpdate(cfg)) return "RedPi auto-update skipped: interval has not elapsed.";
  if (cfg.autoUpdate?.updateHarness !== false) {
    const root = packageRoot();
    if (existsSync(join(root, ".git"))) lines.push(await run("git", ["pull", "--ff-only"], root));
    else lines.push(`Harness package root is not a git checkout: ${root}. Run: pi update --extensions`);
  }
  if (cfg.autoUpdate?.updateSkills !== false) {
    for (const dir of [join(AGENT_DIR, "vendor", "mattpocock-skills"), join(AGENT_DIR, "vendor", "liquid-glass-frontend-skill")]) {
      if (existsSync(join(dir, ".git"))) lines.push(await run("git", ["pull", "--ff-only"], dir));
      else lines.push(`Skill repo not found, skipping: ${dir}`);
    }
  }
  return lines.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  // Runs at extension load (startup and /reload) so pi-subagents never sees stale settings.
  patchPiSettings();
  pi.registerProvider("9router", {
    baseUrl: nineRouterBaseUrl(),
    apiKey: nineRouterApiKeyCommand(),
    api: "openai-completions",
    models: [
      // Combos only. MainAgent comes first: Pi falls back to the first registered model when
      // settings.json has no default, and that must never be a single upstream route.
      { id: "MainAgent", name: "9Router MainAgent (1M context)", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "SubAgent", name: "9Router SubAgent (1M context)", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
    async refreshModels(context: any) {
      // Start fast from a recent cache and refresh it in the background; otherwise list live.
      const recent = cachedNineRouterModels(6 * 60 * 60 * 1000);
      if (recent.length) void fetchNineRouterModels();
      const models = recent.length ? recent : await fetchNineRouterModels(context?.signal, { cache: true });
      const rank = (id: string) => /(^|\/)MainAgent$/i.test(id) ? 0 : /(^|\/)SubAgent$/i.test(id) ? 1 : 2;
      return models.length ? models.sort((a: any, b: any) => rank(a.id) - rank(b.id)) : undefined;
    },
  } as any);

  let currentUserPrompt = "";
  let retriesForPrompt = 0;
  let failedModelsForPrompt = new Set<string>();
  let cooldownUntil = new Map<string, number>();
  let turnMagic: TurnMagic = {};
  // Model the user picked with /model; RedPi stops switching models until it is cleared.
  let pinnedModel: string | undefined;

  pi.registerCommand("redpi-claude", { description: "Switch RedPi between Claude Code subscription and 9Router MainAgent/SubAgent profiles", handler: async (_args, ctx) => {
    const status = claudeAuthStatus();
    const active = profileModeFromConfig(loadConfig(ctx.cwd, ctx.isProjectTrusted()));
    if (!ctx.hasUI) return ctx.ui.notify(`${status.summary}\n\nActive RedPi profile: ${active}.\n\nUse /redpi-claude in the interactive TUI to switch profiles.`, status.loggedIn ? "info" : "warning");
    const choice = await ctx.ui.select(`RedPi provider profile (active: ${active})`, [
      "Use 9Router: MainAgent + SubAgent (1M context)",
      "Use Claude subscription: Opus + Sonnet",
      "Check Claude Code sign-in",
      "Enable AskClaude delegation tool",
      "Show sign-in instructions",
      "Done",
    ]);
    if (!choice || choice === "Done") return;
    if (choice === "Check Claude Code sign-in") return ctx.ui.notify(status.summary, status.loggedIn ? "info" : "warning");
    if (choice === "Show sign-in instructions") return ctx.ui.notify("In a normal terminal, run:\n\nclaude auth login --claudeai\n\nFinish the browser login, restart Pi, then run /redpi-claude again. RedPi never stores your Claude credentials; pi-claude-bridge uses the Claude Code CLI session.", "info");
    if (choice === "Use 9Router: MainAgent + SubAgent (1M context)") return ctx.ui.notify(switchProviderProfile(ctx.cwd, ctx.isProjectTrusted(), "router"), "info");
    if (!status.loggedIn) return ctx.ui.notify(`${status.summary}\n\nFirst sign in in a normal terminal:\nclaude auth login --claudeai`, "warning");
    if (choice === "Use Claude subscription: Opus + Sonnet") return ctx.ui.notify(switchProviderProfile(ctx.cwd, ctx.isProjectTrusted(), "claude"), "info");
    const bridge = readJson(CLAUDE_BRIDGE_CONFIG_PATH, {});
    writeJson(CLAUDE_BRIDGE_CONFIG_PATH, deepMerge(bridge, { askClaude: { enabled: true, allowFullMode: true } }));
    return ctx.ui.notify(`Enabled AskClaude in ${CLAUDE_BRIDGE_CONFIG_PATH}. Restart Pi or run /reload. AskClaude uses your Claude Code session; use read mode for advice and full mode only when you want Claude to edit/run commands.`, "info");
  } });
  pi.registerCommand("yitec-claude", { description: "Alias for /redpi-claude", handler: async (_args, _ctx) => pi.sendUserMessage("/redpi-claude", { deliverAs: "followUp", expandPromptTemplates: true }) });
  pi.registerCommand("redpi-update", { description: "Force-update RedPi harness and vendored skill repositories", handler: async (_args, ctx) => ctx.ui.notify(await updateRedPi(loadConfig(ctx.cwd, ctx.isProjectTrusted()), true), "info") });
  pi.registerCommand("yitec-update", { description: "Alias for /redpi-update", handler: async (_args, ctx) => ctx.ui.notify(await updateRedPi(loadConfig(ctx.cwd, ctx.isProjectTrusted()), true), "info") });
  pi.registerCommand("redpi-browser-install", { description: "Install Playwright Chromium runtime for RedPi browser automation", handler: async (_args, ctx) => {
    const ok = !ctx.hasUI || await ctx.ui.confirm("Install RedPi browser runtime?", "This downloads Playwright Chromium. It can take a few minutes but only needs to run once.");
    if (ok) { ctx.ui.notify("Installing Playwright Chromium in the background; Pi stays usable…", "info"); ctx.ui.notify((await installBrowserRuntime()) || "Browser install completed.", "info"); }
  } });
  pi.registerCommand("redpi-frontend-check", { description: "Run a compact browser frontend check: page text, console/errors, network failures, optional screenshot", handler: async (args, ctx) => {
    const url = (args || await (ctx.hasUI ? ctx.ui.input("Frontend URL", "http://localhost:3000") : undefined) || "").trim();
    if (!url) return ctx.ui.notify("Usage: /redpi-frontend-check http://localhost:3000", "error");
    const script = join(packageRoot(), "scripts", "redpi-browser.js");
    const runBrowser = (cmd: string[]) => runAsync("node", [script, ...cmd], { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: BROWSER_TIMEOUT_MS });
    let goto = await runBrowser(["goto", url, "--max", "1800"]);
    let out = (goto.stdout || goto.stderr || "").trim();
    if (goto.status !== 0 && /Playwright is not installed|Executable doesn't exist|playwright install/i.test(out) && ctx.hasUI) {
      const ok = await ctx.ui.confirm("RedPi browser runtime is missing", "Install Playwright Chromium now? This can take a few minutes and only needs to run once.");
      if (ok) { await installBrowserRuntime(); goto = await runBrowser(["goto", url, "--max", "1800"]); out = (goto.stdout || goto.stderr || "").trim(); }
    }
    const errors = ((await runBrowser(["errors", "--max", "2500"])).stdout || "").trim();
    const shotPath = join(ctx.cwd, CONFIG_DIR_NAME, "yitec", `frontend-${Date.now()}.png`);
    mkdirSync(dirname(shotPath), { recursive: true });
    const shot = ((await runBrowser(["screenshot", shotPath])).stdout || "").trim();
    ctx.ui.notify(`Frontend check: ${url}\n\nPage:\n${out}\n\nErrors/Network:\n${errors || "none"}\n\n${shot}`, "info");
  } });
  pi.registerCommand("redpi-repair-config", { description: "Repair RedPi 9Router role config from live models, avoiding stale/inactive combos", handler: async (_args, ctx) => {
    const live = await fetchNineRouterModels(ctx.signal);
    if (!live.length) return ctx.ui.notify(`Could not fetch 9Router models from ${nineRouterBaseUrl()}.`, "error");
    const ids = live.map((m: any) => m.id).filter(Boolean);
    const cfg = autoConfigFromNineRouter(ids);
    const cfgPath = configWritePath(ctx.cwd, ctx.isProjectTrusted(), "global");
    writeJson(cfgPath, cfg);
    patchPiDefaults(String((cfg as any).roles.planner.models[0]).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""), "high");
    const summary = ["planner", "executor", "subagent", "reviewer", "vision", "commit", "tiny"].map(r => `${r}: ${(cfg as any).roles[r]?.models?.[0] || "(none)"}`).join("\n");
    ctx.ui.notify(`Repaired RedPi config in ${cfgPath}\n\n${summary}\n\nRestart Pi or run /reload.`, "info");
  } });
  pi.registerCommand("redpi-setup", { description: "Friendly RedPi setup wizard: 9Router login, browser install, and role config", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return ctx.ui.notify("/redpi-setup needs the interactive TUI. In print mode, set NINE_ROUTER_API_KEY/NINE_ROUTER_BASE_URL and run npm run browser:install.", "error");
    const choice = await ctx.ui.select("RedPi setup", ["9Router login / connection", "Claude subscription / bridge", "Install Playwright + Chromium", "Configure role models", "Check status", "Done"]);
    if (!choice || choice === "Done") return;
      if (choice === "9Router login / connection") {
        const current = localNineRouter();
        const baseUrl = await ctx.ui.input("9Router base URL", current.baseUrl || process.env.NINE_ROUTER_BASE_URL || "https://9router.yitec.dev/v1");
        if (!baseUrl) return;
        const apiKey = await ctx.ui.input("9Router API key", current.apiKey ? "keep-existing" : "paste key here");
        const next = { baseUrl: normalizeNineRouterBaseUrl(baseUrl), apiKey: apiKey === "keep-existing" ? current.apiKey : apiKey };
        mkdirSync(dirname(NINE_ROUTER_LOCAL_PATH), { recursive: true });
        writeFileSync(NINE_ROUTER_LOCAL_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        try { chmodSync(NINE_ROUTER_LOCAL_PATH, 0o600); } catch {}
        const live = await fetchNineRouterModels(ctx.signal);
        if (live.length) finishOnboarding("router");
        const msg = live.length ? `Connected. ${live.length} models/combos found.` : `Could not fetch /models from ${nineRouterBaseUrl()}.`;
        ctx.ui.notify(msg, live.length ? "info" : "warning");
        if (live.length) {
          const ok = await ctx.ui.confirm("Auto-configure RedPi from 9Router?", "Recommended: RedPi will assign roles from live models. If combos named MainAgent/SubAgent exist, MainAgent is used for main/heavy roles and SubAgent for fast/delegated work.");
          if (ok) {
            const ids = live.map((m: any) => m.id).filter(Boolean);
            const cfgPath = configWritePath(ctx.cwd, ctx.isProjectTrusted(), "global");
            let generated: any = autoConfigFromNineRouter(ids);
            const mode = await ctx.ui.select("Role model setup", ["✅ Use recommended MainAgent/SubAgent mapping", "🎛 Choose model for each role", "✍️ Save recommendations and edit later"]);
            if (!mode) return;
            if (mode === "🎛 Choose model for each role") {
              const custom = await customizeRolesWithUi(ctx, ids, cfgPath);
              if (custom) generated = custom;
              else writeJson(cfgPath, generated);
            } else {
              writeJson(cfgPath, generated);
              patchPiDefaults(String(generated.roles.planner.models[0]).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, ""), "high");
            }
            const summary = ["planner", "executor", "subagent", "reviewer", "vision", "commit", "tiny"].map(r => `${r}: ${generated.roles[r]?.models?.[0] || "(none)"}`).join("\n");
            ctx.ui.notify(`Auto-configured RedPi roles in ${cfgPath}\n\n${summary}\n\nDefault Pi model set to planner/MainAgent route. Run /reload or restart Pi once to refresh provider state.`, "info");
            return;
          }
        }
        return;
      }
      if (choice === "Claude subscription / bridge") {
        pi.sendUserMessage("/redpi-claude", { deliverAs: "followUp", expandPromptTemplates: true });
        return;
      }
      if (choice === "Install Playwright + Chromium") {
        const ok = await ctx.ui.confirm("Install browser runtime?", "This runs npm install and npx playwright install chromium for the RedPi package.");
        if (ok) { ctx.ui.notify("Installing Playwright Chromium in the background; Pi stays usable…", "info"); ctx.ui.notify((await installBrowserRuntime()) || "Browser install completed.", "info"); }
        return;
      }
      if (choice === "Configure role models") {
        pi.sendUserMessage("/redpi-config", { deliverAs: "followUp", expandPromptTemplates: true });
        return;
      }
      if (choice === "Check status") {
        const browserOk = (await runAsync("node", [join(packageRoot(), "scripts", "redpi-browser.js"), "--help"], { timeoutMs: 15000 })).status === 0;
        const claude = claudeAuthStatus();
        ctx.ui.notify(`9Router: ${await pingNineRouter(ctx.signal)}\n\nClaude bridge: ${claude.summary}\n\nBrowser CLI: ${browserOk ? "installed" : "missing dependencies; choose Install Playwright + Chromium"}\nConfig file: ${NINE_ROUTER_LOCAL_PATH}`, "info");
        return;
      }
  } });
  pi.registerCommand("yitec-setup", { description: "Alias for /redpi-setup", handler: async (_args, _ctx) => pi.sendUserMessage("/redpi-setup", { deliverAs: "followUp", expandPromptTemplates: true }) });
  async function applyPlannerNow(ctx: any): Promise<string> {
    // Switch the live session to the (new) planner model so a saved config is visible at once.
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const selected = await selectFirstAvailable(pi, ctx, roleCandidates(cfg, "planner"), roleThinking(cfg, "planner"));
    if (selected) ctx.ui.setStatus("yitec-router", `planner on ${selected}${cfg.routing?.mode === "strict" ? " (strict)" : ""}`);
    return selected ? `Current session now on ${selected}.` : `Planner model ${roleModelLabel(cfg, "planner") || "(none)"} is not available in Pi's model registry.`;
  }

  async function editRoles(ctx: any, next: any, title: string): Promise<boolean> {
    ctx.ui.notify("Loading models from 9Router…", "info");
    const live = await fetchNineRouterModels(ctx.signal, { cache: true });
    const registry = ctx.modelRegistry.getAvailable().map((m: any) => `${m.provider}/${m.id}`);
    const current = ROLE_NAMES.map(r => roleModelLabel(next, r)?.replace(THINKING_SUFFIX, "")).filter(Boolean) as string[];
    const models = [...new Set([...current, ...live.map((m: any) => `9router/${m.id}`), ...registry])];
    next.roles ||= {};
    for (;;) {
      const roleLabels = ROLE_NAMES.map(r => `${r.padEnd(9)} → ${roleModelLabel(next, r) || "(unset)"}`);
      const pick = await ctx.ui.select(`${title}: pick a role to change, then save`, [...roleLabels, "💾 Save", "Cancel"]);
      if (!pick || pick === "Cancel") return false;
      if (pick === "💾 Save") return true;
      const role = ROLE_NAMES[roleLabels.indexOf(pick)];
      const now = roleModelLabel(next, role)?.replace(THINKING_SUFFIX, "");
      const model = await pickModel(ctx, `Model for ${role}`, models, now);
      if (!model || !model.includes("/")) { if (model) ctx.ui.notify("Use the provider/model form, for example 9router/MainAgent.", "warning"); continue; }
      const currentThinking = roleThinking(next, role);
      const thinking = await ctx.ui.select(`Thinking level for ${role}`, currentThinking ? [currentThinking, ...THINKING_LEVELS.filter(t => t !== currentThinking)] : THINKING_LEVELS);
      if (!thinking) continue;
      next.roles[role] = { models: [`${model.replace(THINKING_SUFFIX, "")}:${thinking}`], thinking };
    }
  }

  function routingSummary(ctx: any): string {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const rows = ROLE_NAMES.map(r => `  ${r.padEnd(9)} ${roleModelLabel(cfg, r) || "(unset)"}`);
    return [
      `Source: ${cfg.__path || "built-in defaults"}`,
      `Mode: ${cfg.routing?.mode === "strict" ? "strict (only these models, no fallbacks)" : "auto (tiers and fallbacks allowed)"}`,
      ...((cfg as any).profile && ROLE_PROFILES[(cfg as any).profile] ? [`Profile: ${ROLE_PROFILES[(cfg as any).profile].label}`] : []),
      `Manual /model pin: ${pinnedModel || "none"}`,
      "",
      ...rows,
    ].join("\n");
  }

  const SCOPE = {
    folder: "📁 This folder: strict role models for every new session here",
    session: "⏱ This session only",
    global: "🌐 Global default (folders without their own config)",
    project: "📦 Project file .pi/yitec (can be committed and shared)",
  };

  pi.registerCommand("redpi-config", { description: "Set RedPi role models for this folder (strict), this session, the project file, or globally", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return ctx.ui.notify("/redpi-config needs an interactive UI. Edit ~/.pi/agent/yitec/model-tiers.json in print/headless mode.", "error");
    const trusted = ctx.isProjectTrusted();
    const folderPath = findFolderConfig(ctx.cwd);
    const { folder: FOLDER, session: SESSION, global: GLOBAL, project: PROJECT } = SCOPE;
    const PROFILE = "🛡 Apply a preset profile (e.g. Cybersecurity)";
    const SHOW = "🔎 Show current routing";
    const UNPIN = `▶ Resume role routing (unpin ${pinnedModel})`;
    const REMOVE = "🗑 Remove this folder's config (back to global)";
    const choice = await ctx.ui.select(`RedPi role models${folderPath ? " (this folder has its own strict config)" : ""}`, [
      FOLDER, SESSION, GLOBAL, PROFILE, ...(trusted ? [PROJECT] : []), SHOW, ...(pinnedModel ? [UNPIN] : []), ...(folderPath ? [REMOVE] : []), "Done",
    ]);
    if (!choice || choice === "Done") return;
    if (choice === SHOW) return ctx.ui.notify(routingSummary(ctx), "info");
    if (choice === UNPIN) {
      pinnedModel = undefined;
      return ctx.ui.notify(`Manual pin cleared. ${await applyPlannerNow(ctx)}`, "info");
    }
    if (choice === REMOVE) {
      const folder = readJson(folderPath!, {}).folder || ctx.cwd;
      if (!(await ctx.ui.confirm("Remove this folder's RedPi config?", `New sessions in ${folder} will use the global defaults again.`))) return;
      unlinkSync(folderPath!);
      return ctx.ui.notify(`Removed ${folderPath}.\n\nSubagent models in ${join(folder, CONFIG_DIR_NAME, "settings.json")} were left as they are; delete its "subagents" block if you no longer want them.`, "info");
    }
    const effective = loadConfig(ctx.cwd, trusted);
    if (choice === PROFILE) {
      const labels = Object.values(ROLE_PROFILES).map(p => p.label);
      const picked = await ctx.ui.select("Preset profile", labels);
      const key = Object.keys(ROLE_PROFILES).find(k => ROLE_PROFILES[k].label === picked);
      if (!key) return;
      const profile = ROLE_PROFILES[key];
      const combos = [...new Set(Object.values(profile.roles).map(([combo]) => combo))];
      const live = (await fetchNineRouterModels(ctx.signal, { cache: true })).map((m: any) => m.id);
      const missing = combos.filter(c => !live.includes(c));
      const plan = Object.entries(profile.roles).map(([role, [combo, thinking]]) => `  ${role.padEnd(9)} 9router/${combo}:${thinking}`).join("\n");
      if (missing.length && !(await ctx.ui.confirm(`Your 9Router is missing combos for ${profile.label}`, `Not found: ${missing.join(", ")}.\n\nThis profile needs 9Router combos named exactly: ${combos.join(", ")}. Roles using a missing combo will fail until you create it.\n\nApply anyway?`))) return;
      ctx.ui.notify(`${profile.label} profile\n${profile.summary}\n\n${plan}`, "info");
      const where = await ctx.ui.select(`${profile.label}: apply where?`, [FOLDER, SESSION, GLOBAL, ...(trusted ? [PROJECT] : [])]);
      if (!where) return;
      const base: any = where === FOLDER ? { ...snapshotConfig(effective), folder: resolve(ctx.cwd) } : where === SESSION ? snapshotConfig(effective) : deepMerge(DEFAULT_CONFIG, readJson(configWritePath(ctx.cwd, trusted, where === PROJECT ? "project" : "global"), {}));
      if (where === FOLDER && folderPath) base.folder = readJson(folderPath, {}).folder || base.folder;
      // Profiles are strict everywhere: exactly these combos, never a MainAgent fallback.
      const next = { ...base, roles: profileRoles(key), routing: { ...(base.routing || {}), mode: "strict" }, profile: key };
      return saveRoleConfig(ctx, where, next, folderPath, `Applied ${profile.label} profile.`);
    }
    let next: any;
    if (choice === FOLDER) next = folderPath ? deepMerge(DEFAULT_CONFIG, readJson(folderPath, {})) : { ...snapshotConfig(effective), folder: resolve(ctx.cwd) };
    else if (choice === SESSION) next = sessionOverride ? deepMerge(DEFAULT_CONFIG, sessionOverride) : snapshotConfig(effective);
    else next = deepMerge(DEFAULT_CONFIG, readJson(configWritePath(ctx.cwd, trusted, choice === PROJECT ? "project" : "global"), {}));
    if (choice === FOLDER || choice === SESSION) next.routing = { ...(next.routing || {}), mode: "strict" };
    if (!(await editRoles(ctx, next, choice === FOLDER ? "This folder" : choice === SESSION ? "This session" : choice === PROJECT ? "Project file" : "Global"))) return;
    await saveRoleConfig(ctx, choice, next, folderPath);
  } });

  async function saveRoleConfig(ctx: any, where: string, next: any, folderPath: string | undefined, heading?: string) {
    const trusted = ctx.isProjectTrusted();
    // An explicit config choice replaces any earlier manual /model pin.
    pinnedModel = undefined;
    const lines: string[] = heading ? [heading] : [];
    if (where === SCOPE.folder) {
      const path = folderPath || folderConfigPath(ctx.cwd);
      writeJson(path, next);
      lines.push(`Saved strict role models for ${next.folder}.`, `Every new session in this folder uses exactly these models; no MainAgent default or fallbacks.`, `Config: ${path}`);
      lines.push(`Subagent models: ${writeFolderSubagents(next.folder, next)}`);
    } else if (where === SCOPE.session) {
      sessionOverride = next;
      lines.push("Role models set for this session only (strict). New sessions go back to the folder or global config.");
    } else {
      const project = where === SCOPE.project;
      const path = configWritePath(ctx.cwd, trusted, project ? "project" : "global");
      writeJson(path, next);
      lines.push(`Saved ${project ? "project" : "global"} role models in ${path}.`);
      if (!project) {
        const planner = roleModelLabel(next, "planner");
        if (planner) patchPiDefaults(planner.replace(THINKING_SUFFIX, ""), roleThinking(next, "planner") || "high");
        else patchPiSettings();
        lines.push("Pi's default model and global subagent models were updated to match.");
      }
      if (folderPath) lines.push(`Note: this folder has its own strict config, which still takes priority here.`);
    }
    lines.push("", await applyPlannerNow(ctx));
    ctx.ui.notify(lines.join("\n"), "info");
  }
  pi.registerCommand("yitec-config", { description: "Alias for /redpi-config", handler: async (_args, ctx) => pi.sendUserMessage("/redpi-config", { deliverAs: "followUp", expandPromptTemplates: true }) });
  pi.registerCommand("yitec-tiers", { description: "Show Yitec model tier routing configuration", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(loadConfig(ctx.cwd, ctx.isProjectTrusted()), null, 2), "info") });
  pi.registerCommand("yitec-9router", { description: "Check RedPi native 9Router gateway integration", handler: async (_args, ctx) => {
    const found = ctx.modelRegistry.find("9router", "MainAgent");
    const live = await fetchNineRouterModels(ctx.signal).catch(() => []);
    ctx.ui.notify(`9Router provider: ${found ? "registered" : "missing"}\nBase URL: ${nineRouterBaseUrl()}\nAPI key env: ${nineRouterApiKey() === "dummy" ? "not set (using dummy)" : "set"}\nLive combos: ${live.length ? live.map((m: any) => m.id).join(", ") : "not reachable or no models returned"}\nUse model IDs like 9router/MainAgent.`, "info");
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
    const out = await runPiPrint(ctx.cwd, entryModel(model), `Advisor-lite review. Severity labels: nit, concern, blocker. WATCHDOG guidance:\n${watch || "(none)"}\n\nReview this request/context and give concise actionable findings:\n${args || currentUserPrompt}`, ctx.signal);
    ctx.ui.notify(out, "info");
  }});

  pi.on("model_select", async (event: any, ctx: any) => {
    // A model picked by the user (/model or cycling) wins over role routing for this session.
    if (redpiSwitching || event.source === "restore") return;
    pinnedModel = `${event.model.provider}/${event.model.id}`;
    ctx.ui.setStatus("yitec-router", `pinned ${pinnedModel} · /redpi-config to unpin`);
  });

  pi.on("session_start", async (event: any, ctx) => {
    if (event.reason !== "reload") sessionOverride = undefined;
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const low = cfg.tiers?.[cfg.executor?.tier ?? "low"] ?? [];
    const high = cfg.tiers?.[cfg.planner?.tier ?? "high"] ?? [];
    ctx.ui.setStatus("redpi", `RedPi high:${high.length} low:${low.length}`);
    ctx.ui.setStatus("redpi-ctx", "ctx waiting");
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("redpi-banner", redpiBanner());
    if (ctx.hasUI && ctx.mode === "tui" && !onboardingComplete()) {
      const provider = await ctx.ui.select("Welcome to RedPi — choose your provider", [
        "9Router (recommended): MainAgent + SubAgent",
        "Claude Code subscription: Opus + Sonnet",
        "Other / configure later",
      ]);
      if (provider === "9Router (recommended): MainAgent + SubAgent") {
        writeJson(configWritePath(ctx.cwd, ctx.isProjectTrusted(), "global"), mainAgentRoleConfig());
        patchPiDefaults("9router/MainAgent", "high");
        // Onboarding stays open until the 9Router login succeeds, so a cancelled
        // login shows the welcome screen again instead of leaving Pi without a key.
        if (localNineRouter().apiKey) finishOnboarding("router");
        pi.sendUserMessage("/redpi-setup", { deliverAs: "followUp", expandPromptTemplates: true });
      } else if (provider === "Claude Code subscription: Opus + Sonnet") {
        const status = claudeAuthStatus();
        if (status.loggedIn) {
          writeJson(configWritePath(ctx.cwd, ctx.isProjectTrusted(), "global"), claudeBridgeRoleConfig());
          patchPiDefaults("claude-bridge/claude-opus-5", "high");
          finishOnboarding("claude");
          ctx.ui.notify("Claude profile selected: Opus for the main agent and Sonnet for subagents. Run /reload once.", "info");
        } else {
          ctx.ui.notify(`${status.summary}\n\nSign in with: claude auth login --claudeai\nThen restart Pi to continue onboarding.`, "warning");
        }
      } else if (provider === "Other / configure later") {
        finishOnboarding("manual");
        ctx.ui.notify("Onboarding saved. Use /login, /model, or /redpi-setup when ready.", "info");
      }
    }
    if (findFolderConfig(ctx.cwd) && !pinnedModel) {
      // Folder configs are strict: start the session on the folder's planner model, not Pi's global default.
      const selected = await selectFirstAvailable(pi, ctx, roleCandidates(cfg, "planner"), roleThinking(cfg, "planner"));
      if (selected) ctx.ui.setStatus("yitec-router", `folder config · planner on ${selected}`);
      else ctx.ui.notify(`RedPi folder config: planner model ${roleModelLabel(cfg, "planner") || "(unset)"} is not available. Fix it with /redpi-config.`, "warning");
    }
    // Background: a slow or stuck git pull must never hold up startup or typing.
    void updateRedPi(cfg, false).then((updateResult) => {
      if (!updateResult.includes("skipped")) ctx.ui.notify(`${updateResult}\n\nRestart Pi or run /reload to use updated extension code.`, "info");
    }).catch(() => {});
  });

  // Show Pi's own context figure (the one auto-compaction uses). Estimating from the raw
  // request payload overcounted wildly: base64 screenshots and tool schemas are not tokens.
  function updateContextStatus(ctx: any) {
    const usage = ctx.getContextUsage?.();
    const total = usage?.contextWindow || ctx.model?.contextWindow;
    if (!usage || usage.tokens == null) {
      ctx.ui.setStatus("redpi-ctx", total ? `ctx ?/${Math.round(total / 1000)}k (updates after the next reply)` : "ctx waiting");
      return;
    }
    const label = contextBar(usage.tokens, total);
    const ratio = total ? usage.tokens / total : 0;
    const color = ratio > 0.8 ? "\x1b[38;5;196m" : ratio > 0.5 ? "\x1b[38;5;226m" : MATRIX_BRIGHT;
    ctx.ui.setStatus("redpi-ctx", `ctx ${label}`);
    if (ctx.hasUI && ctx.mode === "tui" && process.env.REDPI_CONTEXT_WIDGET === "1") {
      ctx.ui.setWidget("redpi-context", [`${color}Context${RESET} ${label}`, `${DIM}${ctx.model?.provider || ""}/${ctx.model?.id || ""}${RESET}`]);
    }
  }
  pi.on("before_provider_request", async (_event: any, ctx: any) => updateContextStatus(ctx));
  pi.on("turn_end", async (_event: any, ctx: any) => updateContextStatus(ctx));
  pi.on("session_compact", async (_event: any, ctx: any) => updateContextStatus(ctx));

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
        pixelperfect: hasKeyword(event.text, "pixelperfect") || hasKeyword(event.text, "pixel-perfect"),
        responsive: hasKeyword(event.text, "responsive"),
        a11y: hasKeyword(event.text, "a11y") || hasKeyword(event.text, "accessibility"),
        screenshot: hasKeyword(event.text, "screenshot"),
      };
    }
    const extra = magicInstruction(turnMagic);
    return extra ? { action: "transform", text: event.text + extra } : { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const skip = new Set([...failedModelsForPrompt, ...[...cooldownUntil.entries()].filter(([, until]) => until > Date.now()).map(([k]) => k)]);
    const strict = cfg.routing?.mode === "strict";
    if (pinnedModel) {
      ctx.ui.setStatus("yitec-router", `pinned ${pinnedModel} · /redpi-config to unpin`);
    } else if (event.images?.length) {
      const selected = await selectFirstAvailable(pi, ctx, visionCandidates(cfg), roleThinking(cfg, "vision"), skip);
      if (selected) ctx.ui.notify(`Yitec router: image input detected, switched to vision model ${selected}`, "info");
    } else {
      const role = turnMagic.cheap ? "executor" : "planner";
      const profileDefault = strict || profileModeFromConfig(cfg) === "claude" ? [] : [role === "planner" ? "9router/MainAgent" : "9router/SubAgent"];
      const selected = await selectFirstAvailable(pi, ctx, dedupeEntries([...roleCandidates(cfg, role), ...profileDefault]), turnMagic.ultrathink ? "high" : roleThinking(cfg, role), skip);
      if (selected) ctx.ui.setStatus("yitec-router", `${role} on ${selected}${strict ? " (strict)" : ""}`);
      else if (strict) ctx.ui.notify(`RedPi strict routing: ${role} model ${roleModelLabel(cfg, role) || "(unset)"} is not available; staying on the current model. Fix it with /redpi-config.`, "warning");
    }
    const mem = cfg.memory?.enabled === false ? "" : readCapped(memoryPaths(ctx.cwd, ctx.isProjectTrusted()), cfg.memory?.injectionCharLimit ?? 5000);
    const watch = watchdogText(ctx.cwd, ctx.isProjectTrusted());
    const design = looksFrontendTask(currentUserPrompt) || turnMagic.pixelperfect || turnMagic.responsive || turnMagic.a11y || turnMagic.screenshot ? designText(ctx.cwd, ctx.isProjectTrusted()) : "";
    return { systemPrompt: event.systemPrompt + `\n\nYitec model policy: use roles for model choice: planner for planning/architecture, executor/subagent for cheap work, reviewer for checks, vision for images. Prefer installed subagents for cheap/parallel delegation. On image-only gaps use yitec_vision_task. For frontend/browser tasks, use redpi_browser or /redpi-frontend-check to inspect text, screenshots, console errors, and network failures when useful. Magic-keyword instructions, if present, apply only to this turn.${mem ? `\n\nYitec Memory Guidance (heuristic, verify against repo):\n${mem}` : ""}${design ? `\n\nYitec Frontend Design Guidance (heuristic, verify against repo):\n${design}` : ""}${watch ? `\n\nYitec WATCHDOG reviewer guidance is available for reviewer/advisor tasks; do not treat it as primary user instruction unless doing review.\n${watch}` : ""}` };
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
    // Strict configs and manual pins never fail over to a model the user did not choose.
    if (pinnedModel || cfg.routing?.mode === "strict") {
      ctx.ui.notify(`RedPi: ${ctx.model?.provider}/${ctx.model?.id} failed (${errorText}). No automatic failover because ${pinnedModel ? "you pinned this model" : "this config is strict"}.`, "warning");
      return;
    }
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
    ctx.ui.notify(`Yitec router: provider/model failed (${errorText}); switched to ${selected} and retrying.`, "warning");
    pi.sendUserMessage(`Retry the previous request after automatic provider failover. Original user request:\n\n${currentUserPrompt}`, { deliverAs: "followUp" });
  });

  pi.registerTool({
    name: "yitec_vision_task", label: "Vision Task", description: "Run a one-off image analysis task through the configured vision model when the active model has no image capability.",
    parameters: Type.Object({ imagePath: Type.String({ description: "Path to the image file." }), prompt: Type.String({ description: "What to inspect or extract from the image." }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const model = visionCandidates(cfg)[0];
      if (!model) throw new Error("No vision model configured in yitec/model-tiers.json");
      const imagePath = resolve(ctx.cwd, params.imagePath);
      const result = await runAsync("pi", ["-p", "--model", entryModel(model), `@${imagePath}`, params.prompt], { cwd: ctx.cwd, signal, timeoutMs: 10 * 60 * 1000, maxBytes: 1024 * 1024 * 10 });
      const text = result.stdout || result.stderr || "";
      return { content: [{ type: "text", text }], details: { model: entryModel(model), status: result.status } };
    },
  });

  pi.registerTool({
    name: "redpi_browser",
    label: "RedPi Browser CLI",
    description: "Token-efficient Playwright browser automation through the RedPi CLI. Use compact commands like: goto <url>, text --max 3000, click <selector>, type <selector> <text> --submit, console, errors, network, wait-for-text <text>, screenshot <path>, reset.",
    promptSnippet: "Run compact Playwright browser commands without MCP context bloat",
    promptGuidelines: ["Use redpi_browser for web browsing only when the task needs live browser interaction. Prefer `text --max 3000` after navigation to keep context small. Use screenshots only when visual layout matters."],
    parameters: Type.Object({ command: Type.String({ description: "CLI command, e.g. `goto https://example.com --max 2000`, `text --max 4000`, `click text=Login`, `type input[name=q] search --submit`, `screenshot /tmp/page.png`, or `reset`." }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const script = join(packageRoot(), "scripts", "redpi-browser.js");
      const args = String(params.command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
      const runBrowser = () => serializeBrowser(() => runAsync("node", [script, ...args], { cwd: ctx.cwd, signal, timeoutMs: BROWSER_TIMEOUT_MS }));
      let result = await runBrowser();
      let text = (result.stdout || result.stderr || "").trim();
      if (result.timedOut) text += "\n\nThe browser command was stopped after the time limit. The page may be slow or never finish loading; try `text` or `screenshot`, or check the dev server.";
      const missingBrowser = result.status !== 0 && /Playwright is not installed|Executable doesn't exist|playwright install/i.test(text);
      if (missingBrowser && ctx.hasUI) {
        const ok = await ctx.ui.confirm("RedPi browser runtime is missing", "Install Playwright Chromium now? This can take a few minutes and only needs to run once.");
        if (ok) {
          const install = await installBrowserRuntime();
          result = await runBrowser();
          text = `${install}\n\n--- retry result ---\n${(result.stdout || result.stderr || "").trim()}`.trim();
        }
      } else if (missingBrowser) {
        text += "\n\nBrowser runtime is missing. Run /redpi-browser-install in Pi, or rerun the RedPi installer.";
      }
      return { content: [{ type: "text", text }], details: { command: params.command, status: result.status } };
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
