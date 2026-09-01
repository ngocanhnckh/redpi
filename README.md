<div align="center">

```text
██████╗ ███████╗██████╗ ██████╗ ██╗
██╔══██╗██╔════╝██╔══██╗██╔══██╗██║
██████╔╝█████╗  ██║  ██║██████╔╝██║
██╔══██╗██╔══╝  ██║  ██║██╔═══╝ ██║
██║  ██║███████╗██████╔╝██║     ██║
╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝     ╚═╝
              powered by YITEC
```

### A public, batteries-included harness for [Pi Coding Agent](https://pi.dev)

**Model roles · 9Router gateway support · Matt Pocock skills · subagent defaults · memory-lite · advisor-lite · automatic updates**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Pi Package](https://img.shields.io/badge/Pi-package-purple)](https://pi.dev)
[![9Router Ready](https://img.shields.io/badge/9Router-ready-red)](https://github.com/decolua/9router)
[![Repo](https://img.shields.io/badge/GitHub-ngocanhnckh%2Fredpi-black?logo=github)](https://github.com/ngocanhnckh/redpi)

</div>

---

## Why RedPi?

RedPi is a team-friendly Pi setup that makes a normal `pi` session feel preconfigured, routed, and ready for real coding work.

Instead of asking every teammate to manually install skills, configure model fallbacks, wire subagents, remember project lessons, and choose the right model every turn, RedPi gives you one install command and then gets out of the way.

After install, users simply run:

```bash
pi
```

RedPi loads automatically.

---

## What RedPi adds

| Area | What you get |
| --- | --- |
| **Model roles** | Semantic roles like `planner`, `executor`, `subagent`, `reviewer`, `vision`, `commit`, and `tiny`. |
| **9Router support** | Native Pi provider registration for a local or hosted 9Router endpoint. |
| **Fallbacks** | Rate-limit/quota/session-limit failover with per-prompt failed-model tracking and cooldowns. |
| **Skills** | Matt Pocock's skill library plus a liquid-glass frontend skill are installed and auto-discoverable by Pi. |
| **Subagents** | Installs `pi-subagents` and configures cheap/default worker models. |
| **Magic keywords** | `ultrathink`, `orchestrate`, `cheap`, and `lowcost` adjust turn behavior. |
| **TUI config** | `/redpi-config` lets you choose a 9Router model/combo for each role inside Pi. |
| **Advisor-lite** | `/yitec-review` runs a reviewer-role pass using optional `WATCHDOG.md` guidance. |
| **Browser CLI** | Token-efficient Playwright automation through one compact `redpi_browser` tool; no MCP context bloat. |
| **Memory-lite** | Project/global `memory.md` and `lessons.md`, plus a `yitec_remember` tool. |
| **Auto-update** | RedPi can pull the latest harness and skill repos on session start, and exposes `/redpi-update`. |

---

## Quick start

### 1. Install RedPi once

```bash
curl -fsSL https://raw.githubusercontent.com/ngocanhnckh/redpi/main/install.sh | bash
```

The installer is per machine/user account. It writes to your Pi agent config under:

```text
~/.pi/agent/
```

### 2. Configure credentials

Use either Pi-native provider login:

```text
/login openai
/login anthropic
/login google
```

or use 9Router:

```bash
export NINE_ROUTER_BASE_URL=https://9router.yitec.dev/v1
export NINE_ROUTER_API_KEY=sk-...
```

For a local 9Router install, the default endpoint is already:

```text
http://127.0.0.1:20128/v1
```

### 3. Start Pi normally

```bash
pi
```

That is the normal daily workflow.

---

## 9Router setup

RedPi does **not** ship a credential vault or proxy. It integrates with 9Router as a native Pi provider named:

```text
9router
```

### Local 9Router

```bash
npm install -g 9router
9router
```

Open the 9Router dashboard:

```text
http://localhost:20128
```

Connect providers/accounts, copy a dashboard API key, then export it:

```bash
export NINE_ROUTER_API_KEY=your-9router-key
```

### Hosted 9Router

```bash
export NINE_ROUTER_BASE_URL=https://your-9router.example.com/v1
export NINE_ROUTER_API_KEY=sk-...
```

Yitec-hosted example:

```bash
export NINE_ROUTER_BASE_URL=https://9router.yitec.dev/v1
export NINE_ROUTER_API_KEY=sk-...
```

### Check 9Router from inside Pi

```text
/yitec-9router
```

This reports:

- whether the `9router` provider is registered
- current base URL
- whether an API key is visible
- live models returned by `/v1/models`

### Use 9Router models or combos

Any model/combo exposed by 9Router `/v1/models` can be used as:

```text
9router/<model-or-combo-id>
```

Examples:

```text
9router/cx/gpt-5.6-terra
9router/cx/gpt-5.6-terra-review
9router/kr/auto
9router/kr/claude-sonnet-4.5
```

---

## TUI role configuration

Inside Pi, run:

```text
/redpi-config
```

or the legacy alias:

```text
/yitec-config
```

The TUI flow lets you:

1. Pick a role:
   - `planner`
   - `executor`
   - `subagent`
   - `reviewer`
   - `vision`
   - `commit`
   - `tiny`
   - `default`
2. Choose where to save:
   - global config
   - trusted project config
3. Fetch live 9Router models/combos from `/v1/models`.
4. Select a model/combo or enter one manually.
5. Choose thinking level.
6. Save the updated `model-tiers.json`.

After changing config, run:

```text
/reload
```

or restart Pi.

---

## Configuration files

### Global config

```text
~/.pi/agent/yitec/model-tiers.json
```

### Project config

```text
.pi/yitec/model-tiers.json
```

Project config is only loaded after Pi trusts the project.

### Example config

```json
{
  "roles": {
    "planner": {
      "models": ["9router/cx/gpt-5.6-terra:medium"],
      "thinking": "medium"
    },
    "executor": {
      "models": ["9router/cx/gpt-5.6-terra:low"],
      "thinking": "low"
    },
    "subagent": {
      "models": ["9router/cx/gpt-5.6-terra:low"],
      "thinking": "low"
    },
    "reviewer": {
      "models": ["9router/cx/gpt-5.6-terra-review:medium"],
      "thinking": "medium"
    },
    "vision": {
      "models": ["9router/cx/gpt-5.6-terra:medium"],
      "thinking": "medium"
    },
    "commit": {
      "models": ["9router/cx/gpt-5.6-terra:low"],
      "thinking": "low"
    },
    "tiny": {
      "models": ["9router/cx/gpt-5.6-terra:off"],
      "thinking": "off"
    }
  },
  "tiers": {
    "high": [
      {
        "model": "9router/cx/gpt-5.6-terra",
        "vision": true,
        "thinking": "medium",
        "rate": { "input": 0, "output": 0 }
      }
    ],
    "low": [
      {
        "model": "9router/cx/gpt-5.6-terra",
        "vision": true,
        "thinking": "low",
        "rate": { "input": 0, "output": 0 }
      }
    ],
    "uncapable": []
  },
  "retry": {
    "enabled": true,
    "maxPerUserPrompt": 2,
    "cooldownMs": 300000,
    "fallbackChains": {
      "planner": ["9router/kr/auto:high"],
      "executor": ["9router/kr/auto:low"],
      "reviewer": ["9router/cx/gpt-5.6-terra-review:medium"]
    },
    "errorPatterns": [
      "rate limit",
      "429",
      "quota",
      "insufficient_quota",
      "weekly limit",
      "session limit",
      "credits",
      "tokens exhausted",
      "overloaded"
    ]
  },
  "magicKeywords": {
    "enabled": true,
    "ultrathink": true,
    "orchestrate": true,
    "cheap": true
  },
  "advisor": {
    "enabled": false,
    "modelRole": "reviewer",
    "autoReview": false,
    "tools": ["read", "grep"]
  },
  "memory": {
    "enabled": true,
    "injectionCharLimit": 5000
  },
  "autoUpdate": {
    "enabled": true,
    "intervalHours": 24,
    "updateHarness": true,
    "updateSkills": true
  }
}
```

---

## Commands

| Command | Purpose |
| --- | --- |
| `/redpi-config` | TUI picker for assigning 9Router models/combos to roles. |
| `/yitec-config` | Alias for `/redpi-config`. |
| `/redpi-update` | Force-update RedPi and vendored skills. |
| `/yitec-update` | Alias for `/redpi-update`. |
| `/yitec-9router` | Check 9Router provider registration and live model discovery. |
| `/yitec-tiers` | Print active role/tier config. |
| `/yitec-doctor` | Validate config, providers, roles, and trust status. |
| `/yitec-agents` | Show subagent/reviewer role model policy. |
| `/yitec-memory` | View RedPi memory/lessons. |
| `/yitec-review <context>` | Run advisor-lite review using reviewer role and WATCHDOG guidance. |

---

## Magic keywords

RedPi recognizes these as standalone prose words, not inside code blocks, inline code, paths, or identifiers.

| Keyword | Effect |
| --- | --- |
| `ultrathink` | Raises thinking effort for the turn. |
| `orchestrate` | Nudges Pi to delegate independent work to low-cost subagents and synthesize. |
| `cheap` | Routes the turn through the executor role. |
| `lowcost` | Same as `cheap`. |

Examples:

```text
ultrathink design the migration plan before editing
```

```text
orchestrate review this PR and ask subagents to inspect independent areas
```

```text
cheap summarize these files without deep architecture work
```

---

## Browser automation without MCP

RedPi includes a small Playwright CLI and exposes it to Pi as one compact tool:

```text
redpi_browser
```

This is intentionally **not MCP**. MCP tools can add a lot of tool-schema/context overhead. RedPi instead translates browser actions into a single CLI-style command string.

Install Chromium browser assets once from a RedPi checkout if needed:

```bash
npm install
npm run browser:install
```

Examples the agent can call through `redpi_browser`:

```text
goto https://example.com --max 2000
text --max 3000
click text=Login
type input[name=q] "redpi 9router" --submit
screenshot /tmp/redpi-page.png
reset
```

Token efficiency rules:

- Prefer `text --max 3000` over HTML.
- Use `html --max N` only when selectors/markup matter.
- Use `screenshot` only when visual layout matters.
- Browser state is stored under `~/.pi/agent/yitec/browser/` by default.

You can also run the CLI directly:

```bash
node scripts/redpi-browser.js goto https://example.com --max 2000
node scripts/redpi-browser.js text --max 3000
```

## Skills

The installer adds two skill sources to Pi settings:

```text
~/.pi/agent/vendor/mattpocock-skills/.agents/skills
~/.pi/agent/vendor/liquid-glass-frontend-skill
```

Pi can auto-select skills when their descriptions match the task. You can also force a skill manually:

```text
/skill:tdd implement this parser with tests
/skill:code-review review my current diff
/skill:domain-modeling model this business flow
```

---

## Memory-lite

RedPi can inject a capped memory block into the system prompt.

Project memory files:

```text
.pi/yitec/memory.md
.pi/yitec/lessons.md
```

Global memory files:

```text
~/.pi/agent/yitec/memory.md
~/.pi/agent/yitec/lessons.md
```

Use:

```text
/yitec-memory
```

The model can also call the tool:

```text
yitec_remember
```

to append a durable lesson.

Memory is heuristic guidance. RedPi instructs the agent to verify it against the current repository before acting.

---

## Advisor-lite and WATCHDOG.md

Advisor-lite is a lightweight reviewer pass. It uses the `reviewer` model role and optional watchdog guidance.

Watchdog locations:

```text
~/.pi/agent/WATCHDOG.md
.pi/WATCHDOG.md
.pi/yitec/WATCHDOG.md
```

Run manually:

```text
/yitec-review check the auth changes for security regressions
```

Enable automatic review follow-ups by setting:

```json
{
  "advisor": {
    "enabled": true,
    "autoReview": true,
    "modelRole": "reviewer"
  }
}
```

---

## Updates

RedPi checks for updates when a new Pi session starts. By default it checks once every 24 hours.

```json
{
  "autoUpdate": {
    "enabled": true,
    "intervalHours": 24,
    "updateHarness": true,
    "updateSkills": true
  }
}
```

Force update inside Pi:

```text
/redpi-update
```

After an update, restart Pi or run:

```text
/reload
```

If your install was not a git checkout, re-run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/ngocanhnckh/redpi/main/install.sh | bash
```

---

## Smoke test

From a RedPi checkout:

```bash
npm run smoke
```

This launches a real Pi TUI session through a PTY and verifies:

- extension loading
- 9Router provider registration
- trusted project config
- role config
- memory command
- command rendering

---

## Security model

RedPi is intentionally public-safe:

- No RedPi-hosted credential vault.
- No bundled secrets.
- No committed `.env` file.
- Credentials should live in environment variables, Pi native `/login`, 9Router dashboard storage, or local uncommitted Pi config.

Never commit:

```text
.env
models.json
API keys
OAuth tokens
```

If a key is pasted into chat, logs, or a public issue, rotate it.

---

## Repository

```text
https://github.com/ngocanhnckh/redpi
```

## License

MIT
