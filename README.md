# RedPi

Public Pi harness with one-command bootstrap, Matt Pocock skills, subagents, role-based model routing, native 9Router gateway support, memory-lite, advisor-lite, and failover.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ngocanhnckh/redpi/main/install.sh | bash
```

Then start Pi normally from any repo:

```bash
pi
```

The installer:

1. Installs Pi if missing.
2. Installs this RedPi package.
3. Installs `npm:pi-subagents`.
4. Clones `https://github.com/mattpocock/skills` and adds `.agents/skills` to Pi settings.
5. Clones `https://github.com/ngocanhnckh/liquid-glass-frontend-skill` and adds it to Pi settings.
6. Creates `~/.pi/agent/yitec/model-tiers.json`.
7. Configures subagents to default to low-tier models and reviewer/planning roles to high-tier fallbacks.

## 9Router support

RedPi does not run its own vault. It registers 9Router as a native Pi provider and expects 9Router to run separately.

Install/start 9Router:

```bash
npm install -g 9router
9router
```

Open the 9Router dashboard at `http://localhost:20128`, connect providers, copy a dashboard API key, then:

```bash
export NINE_ROUTER_API_KEY=your-9router-key
pi
```

Default RedPi 9Router endpoint:

```text
http://127.0.0.1:20128/v1
```

Override it with:

```bash
export NINE_ROUTER_BASE_URL=http://127.0.0.1:20128/v1
```

Use 9Router model IDs in your tier config, for example:

```json
{
  "roles": {
    "planner": { "models": ["9router/kr/claude-sonnet-4.5:high"], "thinking": "high" },
    "executor": { "models": ["9router/opencode/free:low"], "thinking": "low" },
    "reviewer": { "models": ["9router/kr/claude-sonnet-4.5:medium"], "thinking": "medium" }
  }
}
```

Run `/yitec-9router` in Pi to check provider registration and live `/v1/models` discovery.

You can also use any Pi-native provider model ID such as `openai/...`, `anthropic/...`, `google/...`, `deepseek/...`, `openrouter/...`, or local providers.

## Configure roles and tiers

Global config:

```text
~/.pi/agent/yitec/model-tiers.json
```

Project override, loaded only after project trust:

```text
.pi/yitec/model-tiers.json
```

Each model can be a plain provider-qualified string or a profile object:

```json
{
  "roles": {
    "planner": { "tier": "high", "thinking": "high" },
    "executor": { "tier": "low", "thinking": "low" },
    "subagent": { "tier": "low", "thinking": "low" },
    "reviewer": { "tier": "high", "thinking": "high" },
    "vision": { "tier": "high", "thinking": "off" },
    "commit": { "tier": "low", "thinking": "low" },
    "tiny": { "tier": "low", "thinking": "off" }
  },
  "tiers": {
    "high": [
      { "model": "9router/kr/claude-sonnet-4.5", "vision": true, "thinking": "high", "rate": { "input": 0, "output": 0 } }
    ],
    "low": [
      { "model": "9router/opencode/free", "vision": false, "thinking": "low", "rate": { "input": 0, "output": 0 } }
    ],
    "uncapable": []
  }
}
```

Useful commands:

- `/yitec-tiers` — inspect active config.
- `/redpi-update` — force-update the RedPi harness checkout and vendored skill repos.
- `/yitec-update` — alias for `/redpi-update`.
- `/yitec-9router` — check native 9Router provider registration and live models.
- `/yitec-doctor` — validate roles, tiers, provider/model IDs, and trust.
- `/yitec-agents` — inspect subagent/reviewer role policy.
- `/yitec-memory` — view local memory/lessons.
- `/yitec-review <context>` — run advisor-lite review through the reviewer role.

## Behavior

- RedPi auto-checks for updates on session start, by default once every 24 hours. It pulls the RedPi git checkout and vendored Matt Pocock/liquid-glass skill repos when available. Restart Pi or run `/reload` after an update to use newly pulled extension code.
- RedPi switches turns through semantic roles: planner, executor, reviewer, vision, commit, tiny, and subagent.
- On rate-limit/quota/session-limit errors, it marks the failed model, applies cooldown, switches to the next fallback candidate, and retries.
- Magic keywords are recognized in prose, not code/path text:
  - `ultrathink` raises thinking for the turn.
  - `orchestrate` nudges parallel low-cost subagent delegation.
  - `cheap` or `lowcost` routes through the executor role.
- Image turns route to configured vision models; `yitec_vision_task` is available for one-off image analysis.
- Memory-lite reads/writes `memory.md` and `lessons.md` under trusted project `.pi/yitec/` or global `~/.pi/agent/yitec/`.
- Advisor-lite reads `WATCHDOG.md` from `~/.pi/agent/WATCHDOG.md`, `.pi/WATCHDOG.md`, or `.pi/yitec/WATCHDOG.md`.
- Matt Pocock skills are available automatically and can also be forced with `/skill:name`.

## Updates

Manual update inside Pi:

```text
/redpi-update
```

Global auto-update settings live in `~/.pi/agent/yitec/model-tiers.json`:

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

The installer itself can be re-run any time if you want to reconcile the package, skills, and settings from scratch.

## Smoke test

```bash
npm run smoke
```

## Security

RedPi has no server-side vault. Keep credentials in environment variables, Pi native `/login`, or your local Pi config. Never commit `.env`, `models.json`, API keys, or OAuth tokens.
