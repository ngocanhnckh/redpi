import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  autoUpdate?: { enabled?: boolean; intervalHours?: number; updateHarness?: boolean; updateSkills?: boolean };
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const USER_YITEC_DIR = join(AGENT_DIR, "yitec");
const NINE_ROUTER_LOCAL_PATH = join(USER_YITEC_DIR, "9router.local.json");
const CLAUDE_BRIDGE_CONFIG_PATH = join(AGENT_DIR, "claude-bridge.json");
const PROVIDER_PROFILES_PATH = join(USER_YITEC_DIR, "provider-profiles.json");
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
function collectStrings(v: any, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out);
  return out;
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
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
}

function patchPiDefaults(modelId: string, thinking = "low") {
  patchPiSettings(modelId, thinking);
}

function modelOptionMap(models: string[], max = 60) {
  const map = new Map<string, string>();
  const labels = models.map((m, i) => {
    const label = m.length > max ? `${m.slice(0, Math.max(20, max - 14))}…${m.slice(-10)}` : m;
    const display = `${String(i + 1).padStart(2, "0")}. ${label}`;
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
  const main = exact("MainAgent", "main-agent", "main_agent") || contains("redstone-gpt", "gpt-5.6-terra", "terra") || avoidInactive(contains("opus", "sonnet", "gpt", "auto")) || ids[0] || "kr/auto";
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
  const { labels, map } = modelOptionMap(options.filter(o => !/mainagent|main-agent|main_agent|subagent|sub-agent|sub_agent/i.test(o)).slice(0, 35));
  for (const r of roles) {
    const recommended = String(r.recommended).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    const choice = await ctx.ui.select(`Model for ${r.label}`, [
      `✅ use recommended: ${recommended.length > 52 ? recommended.slice(0, 52) + "…" : recommended}`,
      "manual entry",
      ...labels,
      "skip remaining roles / save now",
    ]);
    if (!choice) return undefined;
    if (choice === "skip remaining roles / save now") break;
    const model = choice === "manual entry" ? await ctx.ui.input(`Model for ${r.role}`, recommended) : choice.startsWith("✅ use recommended:") ? recommended : map.get(choice);
    if (!model) return undefined;
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
function runPiPrint(cwd: string, model: string, prompt: string): string {
  const args = ["-p", "--model", model, prompt];
  const result = spawnSync("pi", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
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

function installBrowserRuntime(): string {
  const root = packageRoot();
  const lines: string[] = [];
  lines.push(run("npm", ["install"], root));
  lines.push(run("npx", ["playwright", "install", "chromium"], root));
  try { chmodSync(join(root, "scripts", "redpi-browser.js"), 0o755); } catch {}
  return lines.join("\n\n");
}

function claudeAuthStatus(): { installed: boolean; loggedIn: boolean; summary: string } {
  const result = spawnSync("claude", ["auth", "status"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
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

async function fetchNineRouterModels(signal?: AbortSignal): Promise<any[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS || 2500));
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${nineRouterBaseUrl().replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${nineRouterApiKey()}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    const ids = Array.isArray(json?.data) ? json.data.map((m: any) => m?.id).filter(Boolean) : [];
    return ids.map((id: string) => ({ id, name: `9Router ${id}`, reasoning: true, input: ["text", "image"], contextWindow: nineRouterContextWindow(id), maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

function packageRoot(): string {
  const here = typeof __dirname === "string" ? __dirname : process.cwd();
  return resolve(here, "..");
}

function run(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 3 });
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

function updateRedPi(cfg: Config, force = false): string {
  const lines = [`RedPi update ${force ? "forced" : "auto"}`];
  if (!force && !shouldAutoUpdate(cfg)) return "RedPi auto-update skipped: interval has not elapsed.";
  if (cfg.autoUpdate?.updateHarness !== false) {
    const root = packageRoot();
    if (existsSync(join(root, ".git"))) lines.push(run("git", ["pull", "--ff-only"], root));
    else lines.push(`Harness package root is not a git checkout: ${root}. Run: pi update --extensions`);
  }
  if (cfg.autoUpdate?.updateSkills !== false) {
    for (const dir of [join(AGENT_DIR, "vendor", "mattpocock-skills"), join(AGENT_DIR, "vendor", "liquid-glass-frontend-skill")]) {
      if (existsSync(join(dir, ".git"))) lines.push(run("git", ["pull", "--ff-only"], dir));
      else lines.push(`Skill repo not found, skipping: ${dir}`);
    }
  }
  return lines.join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("9router", {
    baseUrl: nineRouterBaseUrl(),
    apiKey: nineRouterApiKeyCommand(),
    api: "openai-completions",
    models: [
      { id: "kr/claude-sonnet-4.5", name: "9Router Kiro Claude Sonnet 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "opencode/free", name: "9Router OpenCode Free", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "MainAgent", name: "9Router MainAgent (1M context)", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "SubAgent", name: "9Router SubAgent (1M context)", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 64000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
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

  pi.registerCommand("redpi-claude", { description: "Switch RedPi between Claude Code subscription and 9Router MainAgent/SubAgent profiles", handler: async (_args, ctx) => {
    const status = claudeAuthStatus();
    const active = profileModeFromConfig(loadConfig(ctx.cwd, ctx.isProjectTrusted()));
    if (!ctx.hasUI) return ctx.ui.notify(`${status.summary}\n\nActive RedPi profile: ${active}.\n\nUse /redpi-claude in the interactive TUI to switch profiles.`, status.loggedIn ? "info" : "warn");
    const choice = await ctx.ui.select(`RedPi provider profile (active: ${active})`, [
      "Use 9Router: MainAgent + SubAgent (1M context)",
      "Use Claude subscription: Opus + Sonnet",
      "Check Claude Code sign-in",
      "Enable AskClaude delegation tool",
      "Show sign-in instructions",
      "Done",
    ]);
    if (!choice || choice === "Done") return;
    if (choice === "Check Claude Code sign-in") return ctx.ui.notify(status.summary, status.loggedIn ? "info" : "warn");
    if (choice === "Show sign-in instructions") return ctx.ui.notify("In a normal terminal, run:\n\nclaude auth login --claudeai\n\nFinish the browser login, restart Pi, then run /redpi-claude again. RedPi never stores your Claude credentials; pi-claude-bridge uses the Claude Code CLI session.", "info");
    if (choice === "Use 9Router: MainAgent + SubAgent (1M context)") return ctx.ui.notify(switchProviderProfile(ctx.cwd, ctx.isProjectTrusted(), "router"), "info");
    if (!status.loggedIn) return ctx.ui.notify(`${status.summary}\n\nFirst sign in in a normal terminal:\nclaude auth login --claudeai`, "warn");
    if (choice === "Use Claude subscription: Opus + Sonnet") return ctx.ui.notify(switchProviderProfile(ctx.cwd, ctx.isProjectTrusted(), "claude"), "info");
    const bridge = readJson(CLAUDE_BRIDGE_CONFIG_PATH, {});
    writeJson(CLAUDE_BRIDGE_CONFIG_PATH, deepMerge(bridge, { askClaude: { enabled: true, allowFullMode: true } }));
    return ctx.ui.notify(`Enabled AskClaude in ${CLAUDE_BRIDGE_CONFIG_PATH}. Restart Pi or run /reload. AskClaude uses your Claude Code session; use read mode for advice and full mode only when you want Claude to edit/run commands.`, "info");
  } });
  pi.registerCommand("yitec-claude", { description: "Alias for /redpi-claude", handler: async (_args, _ctx) => pi.sendUserMessage("/redpi-claude", { deliverAs: "followUp", expandPromptTemplates: true }) });
  pi.registerCommand("redpi-update", { description: "Force-update RedPi harness and vendored skill repositories", handler: async (_args, ctx) => ctx.ui.notify(updateRedPi(loadConfig(ctx.cwd, ctx.isProjectTrusted()), true), "info") });
  pi.registerCommand("yitec-update", { description: "Alias for /redpi-update", handler: async (_args, ctx) => ctx.ui.notify(updateRedPi(loadConfig(ctx.cwd, ctx.isProjectTrusted()), true), "info") });
  pi.registerCommand("redpi-browser-install", { description: "Install Playwright Chromium runtime for RedPi browser automation", handler: async (_args, ctx) => {
    const ok = !ctx.hasUI || await ctx.ui.confirm("Install RedPi browser runtime?", "This downloads Playwright Chromium. It can take a few minutes but only needs to run once.");
    if (ok) ctx.ui.notify(installBrowserRuntime() || "Browser install completed.", "info");
  } });
  pi.registerCommand("redpi-frontend-check", { description: "Run a compact browser frontend check: page text, console/errors, network failures, optional screenshot", handler: async (args, ctx) => {
    const url = (args || await (ctx.hasUI ? ctx.ui.input("Frontend URL", "http://localhost:3000") : undefined) || "").trim();
    if (!url) return ctx.ui.notify("Usage: /redpi-frontend-check http://localhost:3000", "error");
    const script = join(packageRoot(), "scripts", "redpi-browser.js");
    const runBrowser = (cmd: string[]) => spawnSync("node", [script, ...cmd], { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 4, env: process.env });
    let goto = runBrowser(["goto", url, "--max", "1800"]);
    let out = (goto.stdout || goto.stderr || "").trim();
    if (goto.status !== 0 && /Playwright is not installed|Executable doesn't exist|playwright install/i.test(out) && ctx.hasUI) {
      const ok = await ctx.ui.confirm("RedPi browser runtime is missing", "Install Playwright Chromium now? This can take a few minutes and only needs to run once.");
      if (ok) { installBrowserRuntime(); goto = runBrowser(["goto", url, "--max", "1800"]); out = (goto.stdout || goto.stderr || "").trim(); }
    }
    const errors = (runBrowser(["errors", "--max", "2500"]).stdout || "").trim();
    const shotPath = join(ctx.cwd, CONFIG_DIR_NAME, "yitec", `frontend-${Date.now()}.png`);
    mkdirSync(dirname(shotPath), { recursive: true });
    const shot = (runBrowser(["screenshot", shotPath]).stdout || "").trim();
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
        const msg = live.length ? `Connected. ${live.length} models/combos found.` : `Could not fetch /models from ${nineRouterBaseUrl()}.`;
        ctx.ui.notify(msg, live.length ? "info" : "warn");
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
        if (ok) ctx.ui.notify(installBrowserRuntime() || "Browser install completed.", "info");
        return;
      }
      if (choice === "Configure role models") {
        pi.sendUserMessage("/redpi-config", { deliverAs: "followUp", expandPromptTemplates: true });
        return;
      }
      if (choice === "Check status") {
        const browserOk = spawnSync("node", [join(packageRoot(), "scripts", "redpi-browser.js"), "--help"], { encoding: "utf8", maxBuffer: 1024 * 128 }).status === 0;
        const claude = claudeAuthStatus();
        ctx.ui.notify(`9Router: ${await pingNineRouter(ctx.signal)}\n\nClaude bridge: ${claude.summary}\n\nBrowser CLI: ${browserOk ? "installed" : "missing dependencies; choose Install Playwright + Chromium"}\nConfig file: ${NINE_ROUTER_LOCAL_PATH}`, "info");
        return;
      }
  } });
  pi.registerCommand("yitec-setup", { description: "Alias for /redpi-setup", handler: async (_args, _ctx) => pi.sendUserMessage("/redpi-setup", { deliverAs: "followUp", expandPromptTemplates: true }) });
  pi.registerCommand("redpi-config", { description: "Interactive RedPi role/model configurator for 9Router and native providers", handler: async (_args, ctx) => {
    if (!ctx.hasUI) return ctx.ui.notify("/redpi-config needs an interactive UI. Edit ~/.pi/agent/yitec/model-tiers.json in print/headless mode.", "error");
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const role = await ctx.ui.select("Configure which role?", ["planner", "executor", "subagent", "reviewer", "vision", "commit", "tiny", "default"]);
    if (!role) return;
    const scopeChoice = await ctx.ui.select("Save where?", ctx.isProjectTrusted() ? ["project", "global"] : ["global"]);
    if (!scopeChoice) return;
    const live = await fetchNineRouterModels(ctx.signal);
    const liveIds = live.map((m: any) => `9router/${m.id}`);
    const current = roleCandidates(cfg, role).map(entryModel);
    const recommended = current[0] || autoConfigFromNineRouter(live.map((m: any) => m.id).filter(Boolean)).roles?.[role]?.models?.[0]?.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    const compactModels = dedupeEntries([...current, ...liveIds].filter(Boolean)).map(entryModel).slice(0, 45);
    const { labels, map } = modelOptionMap(compactModels);
    const recLabel = recommended ? `✅ use recommended/current: ${recommended.length > 48 ? recommended.slice(0, 48) + "…" : recommended}` : undefined;
    const choice = await ctx.ui.select("Select model/combo", [recLabel, "manual entry", ...labels].filter(Boolean) as string[]);
    if (!choice) return;
    const model = choice === "manual entry" ? await ctx.ui.input("Model id", "Example: 9router/kr/auto or 9router/<combo-id>") : choice.startsWith("✅ use recommended/current:") ? recommended : map.get(choice);
    if (!model) return;
    const thinking = await ctx.ui.select("Thinking level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!thinking) return;
    const path = configWritePath(ctx.cwd, ctx.isProjectTrusted(), scopeChoice as "global" | "project");
    const raw = readJson(path, {});
    const next = deepMerge(DEFAULT_CONFIG, raw);
    next.roles ||= {};
    next.roles[role] = { models: [`${model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")}:${thinking}`], thinking };
    writeJson(path, next);
    if (model.startsWith("9router/")) patchPiDefaults(model, thinking as string);
    ctx.ui.notify(`Saved ${role} -> ${next.roles[role].models[0]} in ${path}${model.startsWith("9router/") ? "\nPi default model also set to 9router." : ""}\n\nIf you just changed the 9Router base URL, run /reload or restart Pi once. After that, normal chat should not ask for login again.`, "info");
  } });
  pi.registerCommand("yitec-config", { description: "Alias for /redpi-config", handler: async (_args, ctx) => pi.sendUserMessage("/redpi-config", { deliverAs: "followUp", expandPromptTemplates: true }) });
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
    patchPiSettings();
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const low = cfg.tiers?.[cfg.executor?.tier ?? "low"] ?? [];
    const high = cfg.tiers?.[cfg.planner?.tier ?? "high"] ?? [];
    ctx.ui.setStatus("redpi", `RedPi high:${high.length} low:${low.length}`);
    ctx.ui.setStatus("redpi-ctx", "ctx waiting");
    if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget("redpi-banner", redpiBanner());
    const updateResult = updateRedPi(cfg, false);
    if (!updateResult.includes("skipped")) ctx.ui.notify(`${updateResult}\n\nRestart Pi or run /reload to use updated extension code.`, "info");
  });

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const strings = collectStrings(event.payload || {});
    const approxTokens = Math.ceil(strings.reduce((n, s) => n + s.length, 0) / 4);
    const total = ctx.model?.contextWindow || ctx.model?.context_window || ctx.model?.context || undefined;
    const label = contextBar(approxTokens, total);
    const color = total && approxTokens / total > 0.8 ? "\x1b[38;5;196m" : total && approxTokens / total > 0.5 ? "\x1b[38;5;226m" : MATRIX_BRIGHT;
    ctx.ui.setStatus("redpi-ctx", `ctx ${label}`);
    if (ctx.hasUI && ctx.mode === "tui" && process.env.REDPI_CONTEXT_WIDGET === "1") {
      ctx.ui.setWidget("redpi-context", [`${color}Context${RESET} ${label}`, `${DIM}${ctx.model?.provider || ""}/${ctx.model?.id || ""}${RESET}`]);
    }
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
    name: "redpi_browser",
    label: "RedPi Browser CLI",
    description: "Token-efficient Playwright browser automation through the RedPi CLI. Use compact commands like: goto <url>, text --max 3000, click <selector>, type <selector> <text> --submit, console, errors, network, wait-for-text <text>, screenshot <path>, reset.",
    promptSnippet: "Run compact Playwright browser commands without MCP context bloat",
    promptGuidelines: ["Use redpi_browser for web browsing only when the task needs live browser interaction. Prefer `text --max 3000` after navigation to keep context small. Use screenshots only when visual layout matters."],
    parameters: Type.Object({ command: Type.String({ description: "CLI command, e.g. `goto https://example.com --max 2000`, `text --max 4000`, `click text=Login`, `type input[name=q] search --submit`, `screenshot /tmp/page.png`, or `reset`." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const script = join(packageRoot(), "scripts", "redpi-browser.js");
      const args = String(params.command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
      let result = spawnSync("node", [script, ...args], { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 4, env: process.env });
      let text = (result.stdout || result.stderr || "").trim();
      const missingBrowser = result.status !== 0 && /Playwright is not installed|Executable doesn't exist|playwright install/i.test(text);
      if (missingBrowser && ctx.hasUI) {
        const ok = await ctx.ui.confirm("RedPi browser runtime is missing", "Install Playwright Chromium now? This can take a few minutes and only needs to run once.");
        if (ok) {
          const install = installBrowserRuntime();
          result = spawnSync("node", [script, ...args], { cwd: ctx.cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 4, env: process.env });
          text = `${install}\n\n--- retry result ---\n${(result.stdout || result.stderr || "").trim()}`.trim();
        }
      } else if (missingBrowser) {
        text += "\n\nBrowser runtime is optional. Run /redpi-browser-install in Pi, or reinstall with REDPI_FULL_INSTALL=1.";
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
