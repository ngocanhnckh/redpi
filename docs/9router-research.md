# 9Router research notes

Source reviewed: `decolua/9router` GitHub repo and README. Repo: <https://github.com/decolua/9router>. License: MIT. Stars when checked: ~26.8k.

## What 9Router is

9Router is a local AI routing gateway and dashboard. It exposes an OpenAI-compatible endpoint, usually:

```text
http://localhost:20128/v1
```

Coding tools connect to this endpoint with an API key copied from the 9Router dashboard. 9Router then routes requests across upstream providers.

## Good ideas from 9Router

- **One local OpenAI-compatible endpoint** for many coding tools.
- **Provider fallback**: subscription providers, cheap providers, then free providers.
- **Account fallback / round-robin** across multiple accounts.
- **RTK token saver** that compresses tool-result content to reduce token usage.
- **Quota and cost tracking** so subscriptions do not go unused and rate limits are visible.
- **Dashboard-first provider setup** for OAuth/API-key providers.
- **Format translation** between OpenAI/Claude-style APIs.
- **Works with many coding clients**, not one harness only.

## What RedPi should copy

RedPi should not copy the whole 9Router dashboard or credential vault. Instead, RedPi should support 9Router natively as a Pi provider:

- Provider ID: `9router`
- Default base URL: `http://127.0.0.1:20128/v1`
- Env overrides:
  - `NINE_ROUTER_BASE_URL`
  - `ROUTER9_BASE_URL`
  - `NINE_ROUTER_API_KEY`
  - `ROUTER9_API_KEY`
  - `NINEROUTER_API_KEY`
- Config model IDs like:
  - `9router/kr/claude-sonnet-4.5`
  - any other ID returned by `GET /v1/models`

This lets RedPi users run 9Router separately, then use its routed models inside our role/tier config.

## Recommended setup

```bash
npm install -g 9router
9router
```

Open the dashboard, connect providers, copy an API key, then:

```bash
export NINE_ROUTER_API_KEY="your-9router-dashboard-key"
pi
```

Example RedPi role config:

```json
{
  "roles": {
    "planner": { "models": ["9router/kr/claude-sonnet-4.5:high"], "thinking": "high" },
    "executor": { "models": ["9router/opencode/free:low"], "thinking": "low" },
    "reviewer": { "models": ["9router/kr/claude-sonnet-4.5:medium"], "thinking": "medium" }
  }
}
```

## Caveats

- 9Router is a separate local service. RedPi should not silently install/start it for users.
- Model IDs are dynamic and depend on what 9Router providers are connected.
- The static fallback model `9router/kr/claude-sonnet-4.5` is a convenience; users should run `/yitec-9router` or inspect 9Router `/v1/models` for their actual IDs.
- Credentials must stay outside git.
