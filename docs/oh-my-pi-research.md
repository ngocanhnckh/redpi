# Oh My Pi research notes

Source reviewed: `can1357/oh-my-pi` GitHub repo, shallow clone on 2026-08-31. License: MIT.

## What Oh My Pi does well

1. **Batteries-included default experience**
   - Ships many tools in one agent surface: files/search, shell/eval, LSP, debugger, subagents, web/browser/desktop, GitHub, image/audio, memory.
   - Users do not need to assemble a harness from many independent extensions.

2. **Role-based model routing**
   - Uses semantic roles like `default`, `smol`, `slow`, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, and `tiny`.
   - Launch flags and config can override each role.
   - Fallback chains and credential rotation are core concepts.

3. **Strong provider/config story**
   - 60+ providers, local models, OAuth/API key support, `.env` precedence, custom OpenAI-compatible providers.
   - Project-scoped provider/model controls.
   - Usage/quota awareness and round-robin credentials.

4. **First-class subagents**
   - Task agents have typed definitions, tool grants, spawn permissions, model/thinking config, output schemas, and optional isolated worktrees.
   - Agent Hub gives visibility into live workers: status, transcript, usage, steering, revive/kill.

5. **Advisor/watchdog reviewer**
   - A second model reviews primary-agent turns in parallel.
   - Advisor gets restricted tools by default and injects severity-coded notes: nit, concern, blocker.
   - Project/user `WATCHDOG.md` / `WATCHDOG.yml` captures reviewer-specific guidance without polluting the main agent prompt.

6. **Magic keywords for intent routing**
   - Lowercase prose words such as `ultrathink`, `orchestrate`, and `workflowz` trigger hidden turn-scoped instructions.
   - Matching avoids code blocks, inline code, paths, identifiers, etc.

7. **Time-travel stream rules (TTSR)**
   - Rules watch assistant text/thinking/tool args while streaming.
   - A match can abort generation, inject a reminder, and retry, or prepend a non-interrupting reminder to tool results.
   - This gives just-in-time policy enforcement without paying prompt tokens every turn.

8. **Memory and auto-learn**
   - Project-scoped session memory, learned lessons, generated reusable skills, and optional external backends.
   - Memory is injected as heuristic guidance with explicit stale-memory handling instructions.

9. **Unified path/URL abstraction**
   - `read`/`grep` handle local files plus internal schemes like `skill://`, `memory://`, `pr://`, `issue://`, etc.
   - The model learns fewer tool APIs.

10. **Ergonomic operations**
    - Shell completions generated from live CLI metadata.
    - Session export/share/fork/resume, `/fresh`, stats dashboard, one-shot/RPC/ACP modes.
    - `omp commit` splits unrelated changes into atomic commits.

11. **Safer high-impact edits**
    - Hashline edits, AST edit preview/accept flow, LSP-aware renames, and conflict URLs.
    - These reduce string-match failures and accidental broad rewrites.

12. **Observability**
    - Usage dashboard, per-subagent cost/duration, advisor status, benchmark tooling.

## What we can copy into Yitec Pi Harness

### Phase 1 — high leverage, easy to add

1. **Move from tier names only to model roles**
   - Add roles: `default`, `planner`, `executor`, `subagent`, `reviewer`, `vision`, `commit`, `tiny`.
   - Keep existing `high`/`low`/`uncapable` tiers as backing pools.
   - Allow role entries to be model IDs or tier references.

2. **Magic keywords extension**
   - Add `ultrathink`, `orchestrate`, and `cheap`/`lowcost` turn markers.
   - On input, inject hidden/extra instructions and set thinking/model appropriately.
   - Implement conservative matching so code/path mentions do not trigger.

3. **WATCHDOG.md guidance for reviewer subagents**
   - Discover `~/.pi/agent/WATCHDOG.md` and project `.pi/WATCHDOG.md` when trusted.
   - Inject it only into reviewer/advisor style prompts, not every main-agent turn.

4. **Vault upgrades**
   - Add role editor, fallback chain editor, provider credential/env-var hints, import/export config.
   - Add a usage/rate column and rough cost calculator from our existing profile rates.

5. **Safer config loading**
   - Support project-scoped model config only after trust; already started in `yitec-model-router.ts`.
   - Add schema validation and friendly `/yitec-tiers doctor` output.

### Phase 2 — moderate effort

6. **Advisor-lite**
   - Implement a passive reviewer extension that runs after agent turns or before final answer.
   - Default tools: read/grep only.
   - Output severities: nit/concern/blocker.
   - Avoid auto-steering initially; show visible notes or queue a follow-up only for blockers.

7. **Subagent registry layer**
   - Add `agents/*.md` definitions in this package.
   - Generate pi-subagents settings from our role/tier config.
   - Add `/yitec-agents` command to inspect configured workers and model choices.

8. **Memory-lite**
   - Project-local `memory.md`/`lessons.md` files under `.pi/yitec/` plus global fallback.
   - Add tools/commands: `yitec_remember`, `/yitec-memory view`, `/yitec-memory add`.
   - Inject only a capped summary at session start.

9. **Fallback-chain improvements**
   - Track failed model identities and cooldowns.
   - Skip failed candidates for the current prompt; restore later.
   - Add per-role fallback chains instead of only per-tier lists.

10. **Shell completions / install polish**
    - Add generated shell snippets for `yitec-pi-vault` and helper scripts.
    - Make `install.sh` verify Pi version, package installed resources, and config health.

### Phase 3 — larger bets

11. **Agent Hub-like web view**
    - Extend the Vault into a small control deck: sessions, model config, subagent status, prompt templates.
    - This copies the idea, not OMP internals.

12. **Rule-triggered steering (TTSR-lite)**
    - Add rules file: `.pi/yitec/rules.json` or markdown frontmatter.
    - Watch assistant messages/tool calls via Pi events.
    - Start non-interrupting first: inject reminders into next turn; later add abort/retry if Pi APIs permit robustly.

13. **Unified internal URLs**
    - Add tools that read `skill://`, `yitec-memory://`, or `model://roles` style resources.
    - Keep tool API surface small by making `read`-like access paths do more.

14. **Commit helper**
    - Add `/yitec-commit-plan` prompt/template: inspect diff, group atomic commits, write commands for user approval.
    - Later automate via a guarded tool/command.

## Suggested immediate implementation order

1. Add role-based config schema and migrate existing `model-tiers.json` compatibility.
2. Upgrade Vault UI to edit roles and fallback chains.
3. Add magic keywords in the router extension.
4. Add `WATCHDOG.md` discovery and reviewer prompt template.
5. Add `/yitec-doctor` to validate models/providers/config/trust.
6. Implement advisor-lite once the above config is stable.

## Things not worth copying directly yet

- Native Rust search/shell/LSP/DAP stack: excellent, but too large for this harness; rely on Pi built-ins and external extensions.
- Full collaborative relay/browser client: useful later, but more infrastructure than current harness needs.
- Full memory backend system: start with simple local lessons before adding SQLite/vector memory.
- Exact hashline/AST edit runtime: Pi already has edit tooling; copying this would be a separate tool project.
