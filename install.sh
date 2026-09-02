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

if [ "${REDPI_SKIP_BROWSER_INSTALL:-0}" != "1" ]; then
  echo "Installing Playwright Chromium runtime for RedPi browser automation..."
  npx -y playwright@1.57.0 install chromium || echo "Playwright browser install failed; you can retry inside Pi with /redpi-setup."
fi

echo "Installing most-starred subagent extension: pi-subagents (nicobailon/pi-subagents, 3189 GitHub stars at bootstrap authoring time)"
pi install npm:pi-subagents

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

if [ ! -f "$YITEC_DIR/model-tiers.json" ]; then
  curl -fsSL "https://raw.githubusercontent.com/${TEAM_PI_PACKAGE#git:github.com/}/main/scripts/default-model-tiers.json" -o "$YITEC_DIR/model-tiers.json" || cat > "$YITEC_DIR/model-tiers.json" <<'JSON'
{
  "roles": {
    "default": { "tier": "high", "thinking": "medium" },
    "planner": { "tier": "high", "thinking": "high" },
    "executor": { "tier": "low", "thinking": "low" },
    "subagent": { "tier": "low", "thinking": "low" },
    "reviewer": { "tier": "high", "thinking": "high" },
    "vision": { "tier": "high", "thinking": "off" },
    "commit": { "tier": "low", "thinking": "low" },
    "tiny": { "tier": "low", "thinking": "off" }
  },
  "planner": { "tier": "high", "thinking": "high" },
  "executor": { "tier": "low", "thinking": "low" },
  "vision": { "models": ["openai/gpt-4o", "google/gemini-2.5-pro"] },
  "tiers": { "high": [], "low": [], "uncapable": [] },
  "retry": { "enabled": true, "maxPerUserPrompt": 2, "cooldownMs": 300000, "fallbackChains": {}, "errorPatterns": ["rate limit", "429", "quota", "weekly limit", "session limit", "credits", "overloaded"] },
  "magicKeywords": { "enabled": true, "ultrathink": true, "orchestrate": true, "cheap": true },
  "advisor": { "enabled": false, "modelRole": "reviewer", "autoReview": false, "tools": ["read", "grep"] },
  "memory": { "enabled": true, "injectionCharLimit": 5000 },
  "autoUpdate": { "enabled": true, "intervalHours": 24, "updateHarness": true, "updateSkills": true }
}
JSON
fi

SETTINGS="$AGENT_DIR/settings.json"
node - "$SETTINGS" "$MATT_DIR/.agents/skills" "$LIQUID_DIR" <<'NODE'
const fs = require('fs');
const [settingsPath, mattSkills, liquidSkill] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
s.skills = Array.from(new Set([...(s.skills || []), mattSkills, liquidSkill]));
s.enableSkillCommands = true;
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
s.subagents = {
  ...(s.subagents || {}),
  defaultModel: (s.subagents && s.subagents.defaultModel) || "deepseek/deepseek-chat",
  defaultThinking: (s.subagents && s.subagents.defaultThinking) || "low",
  agentOverrides: {
    ...((s.subagents && s.subagents.agentOverrides) || {}),
    oracle: { ...(((s.subagents||{}).agentOverrides||{}).oracle || {}), model: "anthropic/claude-opus-4-5", thinking: "high", fallbackModels: ["openai/gpt-5.1:high", "google/gemini-2.5-pro:high"] },
    reviewer: { ...(((s.subagents||{}).agentOverrides||{}).reviewer || {}), model: "deepseek/deepseek-chat", thinking: "low", fallbackModels: ["openai/gpt-5.1-mini:low"] },
    scout: { ...(((s.subagents||{}).agentOverrides||{}).scout || {}), model: "deepseek/deepseek-chat", thinking: "off" },
    worker: { ...(((s.subagents||{}).agentOverrides||{}).worker || {}), model: "deepseek/deepseek-chat", thinking: "low" }
  }
};
fs.mkdirSync(require('path').dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
NODE

echo "Done. Start Pi with: pi"
echo "Then run /redpi-setup for the friendly TUI wizard: 9Router login, browser install/check, and role model config."
