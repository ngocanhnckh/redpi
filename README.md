# RedPi / Yitec Pi Harness

Team Pi setup with one-command bootstrap, Matt Pocock skills, subagents, model roles, memory-lite, advisor-lite, and model tier routing/failover.

## One-command install

After this repo is pushed to GitHub, edit `install.sh` and replace `YOUR_ORG/redpi`, then teammates run:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/redpi/main/install.sh | bash
```

Until then:

```bash
TEAM_PI_PACKAGE=git:github.com/your-org/redpi curl -fsSL https://raw.githubusercontent.com/your-org/redpi/main/install.sh | bash
```

The installer:

1. Installs Pi if missing.
2. Installs this Pi package.
3. Installs `npm:pi-subagents` — selected from npm/GitHub subagent packages as the current most-starred option (`nicobailon/pi-subagents`, 3189 stars when checked).
4. Clones `https://github.com/mattpocock/skills` and adds `.agents/skills` to Pi settings.
5. Clones `https://github.com/ngocanhnckh/liquid-glass-frontend-skill` and adds it to Pi settings.
6. Creates `~/.pi/agent/yitec/model-tiers.json`.
7. Configures subagents to default to low-tier models and important oracle/planning roles to high-tier fallbacks.

## Configure model tiers

Edit:

```text
~/.pi/agent/yitec/model-tiers.json
```

or for one project:

```text
.pi/yitec/model-tiers.json
```

Use provider-qualified model ids. Each model can be a plain string or a profile object with a vision checkbox equivalent, thinking level, and rates. Roles are semantic aliases over direct models or backing tiers:

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
  "planner": { "tier": "high", "thinking": "high" },
  "executor": { "tier": "low", "thinking": "low" },
  "tiers": {
    "high": [
      { "model": "anthropic/claude-opus-4-5", "vision": true, "thinking": "high", "rate": { "input": 15, "output": 75 } }
    ],
    "low": [
      { "model": "deepseek/deepseek-chat", "vision": false, "thinking": "off", "rate": { "input": 0.27, "output": 1.1 } }
    ],
    "uncapable": []
  }
}
```

Useful commands:

- `/yitec-tiers` — inspect active config.
- `/yitec-doctor` — validate roles, tiers, provider/model IDs, and trust.
- `/yitec-agents` — inspect subagent/reviewer role policy.
- `/yitec-memory` — view local memory/lessons.
- `/yitec-review <context>` — run advisor-lite review through the reviewer role.

## Model Vault UI

A local web UI is included for editing model profiles. I used the `liquid-glass-frontend` skill direction: frosted glass panels, atmospheric gradient mesh, editorial hero type, and non-generic dashboard composition.

```bash
node vault/server.js
```

Default port is `7979`. Open the printed `http://127.0.0.1:7979/?token=...` URL. The UI lets you add/edit:

- model id
- high/low/uncapable tier
- semantic roles and fallback chains
- magic keyword, memory, and advisor toggles
- vision capability checkbox
- thinking level
- input/output rates and sample cost estimate
- config doctor output
- OpenAI provider API key or environment reference in `models.json`

Personal vault note: this is designed for your local machine/server. You may store your own raw API key if you want, but keep the service private behind Cloudflare Access/Tunnel, protect the token URL, and never commit `~/.pi/agent/models.json`. For ChatGPT/OpenAI subscription OAuth, use Pi's native `/login openai`; this vault handles model/provider config and API-key style credentials.

### Docker

```bash
docker compose up -d --build
```

The compose file binds the vault to localhost only:

```text
127.0.0.1:7979 -> container:7979
```

Point Cloudflare Tunnel to:

```text
http://127.0.0.1:7979
```

## Behavior

- At each user turn, the router switches the parent harness through semantic roles: planner, executor, reviewer, vision, commit, tiny, and subagent.
- `pi-subagents` is configured in `settings.json` so subagents use low-tier models by default.
- On rate-limit/quota/session-limit style errors, the router marks the failed model, applies a cooldown, switches to the next role fallback/high-tier candidate, and queues an automatic retry.
- Magic keywords are recognized in prose, not code/path text:
  - `ultrathink` raises thinking for the turn.
  - `orchestrate` nudges parallel low-cost subagent delegation.
  - `cheap` or `lowcost` routes the turn through the executor role.
- If an image is attached, the router switches to a configured vision model. If a text-only model needs a one-off image task, it can call `yitec_vision_task`.
- Memory-lite reads/writes `memory.md` and `lessons.md` under trusted project `.pi/yitec/` or global `~/.pi/agent/yitec/`. The `yitec_remember` tool appends durable lessons.
- Advisor-lite uses `WATCHDOG.md` from `~/.pi/agent/WATCHDOG.md`, `.pi/WATCHDOG.md`, or `.pi/yitec/WATCHDOG.md` for reviewer-only guidance. Run `/yitec-review` manually, or set `advisor.autoReview` for automatic follow-up review.
- Matt Pocock skills are visible in Pi's skill list and can be forced with `/skill:name`; their descriptions also let Pi auto-select them when relevant.
