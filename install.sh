#!/usr/bin/env bash
set -euo pipefail

# One-command installer for the Yitec Pi harness.
# Usage after hosting this repo:
#   curl -fsSL https://raw.githubusercontent.com/ngocanhnckh/redpi/main/install.sh | bash
# Optional override:
#   TEAM_PI_PACKAGE=git:github.com/your-org/redpi curl -fsSL .../install.sh | bash

TEAM_PI_PACKAGE="${TEAM_PI_PACKAGE:-git:github.com/ngocanhnckh/redpi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
YITEC_DIR="$AGENT_DIR/yitec"
MATT_DIR="$AGENT_DIR/vendor/mattpocock-skills"
LIQUID_DIR="$AGENT_DIR/vendor/liquid-glass-frontend-skill"
SUPERPOWERS_DIR="$AGENT_DIR/vendor/superpowers"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need_cmd npm
need_cmd git
need_cmd curl

PI_NPM_PREFIX=""
if command -v pi >/dev/null 2>&1; then
  PI_BIN="$(command -v pi)"
  if [ "${PI_BIN#"$HOME/.local/bin/"}" != "$PI_BIN" ]; then PI_NPM_PREFIX="--prefix=$HOME/.local"; fi
fi

echo "Installing/updating Pi coding agent to avoid mixed dependency versions..."
# A partial Pi upgrade can leave @earendil-works/pi-ai files out of sync and cause
# ESM errors like: simple-options.js does not provide clampThinkingBudgetToAnswerRoom.
# Force reinstall Pi as a matched package set before installing RedPi.
npm install -g $PI_NPM_PREFIX --force --ignore-scripts @earendil-works/pi-coding-agent@latest
hash -r

mkdir -p "$YITEC_DIR" "$AGENT_DIR/vendor"

echo "Installing RedPi package: $TEAM_PI_PACKAGE"
pi install "$TEAM_PI_PACKAGE"

# pi install places git packages under $AGENT_DIR/git/<host>/<owner>/<repo>.
REDPI_ROOT="$AGENT_DIR/git/${TEAM_PI_PACKAGE#git:}"
if [ "${REDPI_SKIP_BROWSER:-0}" = "1" ]; then
  echo "Skipping Playwright Chromium (REDPI_SKIP_BROWSER=1). Install later with /redpi-browser-install."
else
  echo "Installing Playwright Chromium runtime for RedPi browser automation..."
  # Use the package's own Playwright: each Playwright version expects its own Chromium build.
  if [ -f "$REDPI_ROOT/node_modules/playwright/cli.js" ]; then
    (cd "$REDPI_ROOT" && node node_modules/playwright/cli.js install chromium) || echo "Playwright browser install failed; you can retry inside Pi with /redpi-browser-install."
  else
    (cd "$REDPI_ROOT" && npm install --no-audit --no-fund && npx playwright install chromium) || echo "Playwright browser install failed; you can retry inside Pi with /redpi-browser-install."
  fi
fi

echo "Installing most-starred subagent extension: pi-subagents (nicobailon/pi-subagents, 3189 GitHub stars at bootstrap authoring time)"
pi install npm:pi-subagents

echo "Installing Claude Code bridge (optional Claude subscription provider and AskClaude delegation)..."
pi install npm:pi-claude-bridge

echo "Installing Matt Pocock skills..."
if [ -d "$MATT_DIR/.git" ]; then
  git -C "$MATT_DIR" pull --ff-only
else
  rm -rf "$MATT_DIR"
  git clone --depth 1 https://github.com/mattpocock/skills "$MATT_DIR"
fi

echo "Installing liquid-glass frontend skill..."
if [ -d "$LIQUID_DIR/.git" ]; then
  git -C "$LIQUID_DIR" pull --ff-only
else
  rm -rf "$LIQUID_DIR"
  git clone --depth 1 https://github.com/ngocanhnckh/liquid-glass-frontend-skill "$LIQUID_DIR"
fi

echo "Installing superpowers subagent workflow skills (obra/superpowers, MIT)..."
if [ -d "$SUPERPOWERS_DIR/.git" ]; then
  git -C "$SUPERPOWERS_DIR" pull --ff-only
else
  rm -rf "$SUPERPOWERS_DIR"
  git clone --depth 1 https://github.com/obra/superpowers "$SUPERPOWERS_DIR"
fi

if [ ! -f "$YITEC_DIR/model-tiers.json" ]; then
  # A fresh RedPi install starts with its stable named routes. The first-run
  # wizard will replace these with the exact live IDs returned by 9Router.
  cat > "$YITEC_DIR/model-tiers.json" <<'JSON'
{
  "roles": {
    "default": { "models": ["9router/MainAgent:medium"], "thinking": "medium" },
    "planner": { "models": ["9router/MainAgent:high"], "thinking": "high" },
    "executor": { "models": ["9router/SubAgent:low"], "thinking": "low" },
    "subagent": { "models": ["9router/SubAgent:low"], "thinking": "low" },
    "reviewer": { "models": ["9router/MainAgent:high"], "thinking": "high" },
    "vision": { "models": ["9router/MainAgent:medium"], "thinking": "medium" },
    "commit": { "models": ["9router/SubAgent:low"], "thinking": "low" },
    "tiny": { "models": ["9router/SubAgent:off"], "thinking": "off" }
  },
  "tiers": {
    "high": [{ "model": "9router/MainAgent", "vision": true, "thinking": "high", "rate": { "input": 0, "output": 0 } }],
    "low": [{ "model": "9router/SubAgent", "vision": true, "thinking": "low", "rate": { "input": 0, "output": 0 } }],
    "uncapable": []
  },
  "retry": { "enabled": true, "maxPerUserPrompt": 2, "cooldownMs": 300000, "fallbackChains": { "planner": ["9router/MainAgent:high"], "executor": ["9router/SubAgent:low"], "reviewer": ["9router/MainAgent:high"] }, "errorPatterns": ["rate limit", "429", "quota", "weekly limit", "session limit", "credits", "overloaded"] },
  "magicKeywords": { "enabled": true, "ultrathink": true, "orchestrate": true, "cheap": true },
  "advisor": { "enabled": false, "modelRole": "reviewer", "autoReview": false, "tools": ["read", "grep"] },
  "memory": { "enabled": true, "injectionCharLimit": 5000 },
  "autoUpdate": { "enabled": true, "intervalHours": 24, "updateHarness": true, "updateSkills": true }
}
JSON
fi

SETTINGS="$AGENT_DIR/settings.json"
# Matt Pocock's promoted skills live under skills/engineering and skills/productivity;
# Pi discovers SKILL.md directories recursively below each listed path.
node - "$SETTINGS" "$MATT_DIR" "$LIQUID_DIR" "$SUPERPOWERS_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [settingsPath, mattDir, liquidSkill, superpowersDir] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
const mattSkills = ['engineering', 'productivity'].map((bucket) => path.join(mattDir, 'skills', bucket));
// Drop the old .agents/skills path: that folder no longer exists upstream.
const kept = (s.skills || []).filter((p) => !String(p).startsWith(mattDir));
// Only superpowers' plan-and-subagent workflow; keep in sync with SUPERPOWERS_SKILLS in the extension.
const superpowersSkills = ['subagent-driven-development', 'dispatching-parallel-agents', 'writing-plans', 'executing-plans',
  'using-git-worktrees', 'requesting-code-review', 'finishing-a-development-branch', 'verification-before-completion']
  .map((name) => path.join(superpowersDir, 'skills', name));
s.skills = Array.from(new Set([...kept, ...mattSkills, liquidSkill, ...superpowersSkills]));
s.enableSkillCommands = true;
if (process.env.REDPI_THEME !== '0') s.theme = process.env.REDPI_THEME || 'redpi-matrix';
s.retry = {
  ...(s.retry || {}),
  provider: {
    ...((s.retry || {}).provider || {}),
    timeoutMs: Math.max(Number(((s.retry || {}).provider || {}).timeoutMs || 0), 900000),
    maxRetries: 0,
    maxRetryDelayMs: 60000
  }
};
s.httpIdleTimeoutMs = Math.max(Number(s.httpIdleTimeoutMs || 0), 900000);
const previousOverrides = ((s.subagents && s.subagents.agentOverrides) || {});
const cleanOverride = (name) => {
  const { fallbackModels, ...rest } = previousOverrides[name] || {};
  return rest;
};
s.defaultProvider = s.defaultProvider || "9router";
s.defaultModel = s.defaultModel || "MainAgent";
s.defaultThinkingLevel = s.defaultThinkingLevel || "high";
s.subagents = {
  ...(s.subagents || {}),
  defaultModel: "9router/SubAgent",
  defaultThinking: "low",
  agentOverrides: {
    ...previousOverrides,
    oracle: { ...cleanOverride("oracle"), model: "9router/MainAgent", thinking: "high" },
    reviewer: { ...cleanOverride("reviewer"), model: "9router/MainAgent", thinking: "high" },
    scout: { ...cleanOverride("scout"), model: "9router/SubAgent", thinking: "off" },
    worker: { ...cleanOverride("worker"), model: "9router/SubAgent", thinking: "low" }
  }
};
fs.mkdirSync(require('path').dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
NODE

echo "RedPi Matrix theme enabled (set REDPI_THEME=0 during install to preserve another theme)."
echo "Done. Start Pi with: pi"
echo "Then run /redpi-setup for 9Router/browser/models, or /redpi-claude to connect an existing Claude Code subscription."
