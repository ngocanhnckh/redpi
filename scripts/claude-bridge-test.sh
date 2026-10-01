#!/usr/bin/env bash
# Claude subscription bridge (pi-claude-bridge): RedPi's instructions must reach Claude Code.
# The bridge rebuilds Claude Code's system prompt from Pi's structured parts and drops text
# added through before_agent_start; RedPi adds its text at request time instead. This runs real
# Pi with the installed bridge and all RedPi extensions against a FAKE `claude` executable that
# only records what it is given (no Anthropic call, no subscription use), then checks that the
# RedPi policy text arrived and Pi's own harness text did not.
# Skips when pi-claude-bridge is not installed. Never touches the real ~/.pi/agent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE="${REDPI_TEST_BRIDGE:-$HOME/.pi/agent/npm/node_modules/pi-claude-bridge}"
if [ ! -f "$BRIDGE/src/index.ts" ]; then echo "Claude bridge test skipped: pi-claude-bridge is not installed."; exit 0; fi
WORK="$(mktemp -d -t redpi-bridge-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
AGENT="$WORK/agent"; PROJECT="$WORK/project"; OUT="$WORK/calls"
mkdir -p "$AGENT/yitec" "$PROJECT" "$OUT"
echo '{ "completed": true, "provider": "claude" }' > "$AGENT/yitec/onboarding.json"
M=claude-bridge/claude-opus-5; F=claude-bridge/claude-sonnet-5
cat > "$AGENT/yitec/model-tiers.json" <<JSON
{ "roles": { "default": {"models":["$M:medium"]}, "planner": {"models":["$M:high"]}, "executor": {"models":["$F:low"]}, "subagent": {"models":["$F:low"]}, "reviewer": {"models":["$M:high"]}, "vision": {"models":["$M:medium"]}, "commit": {"models":["$F:low"]}, "tiny": {"models":["$F:off"]} } }
JSON
cat > "$WORK/claude" <<'SH'
#!/usr/bin/env bash
n=$(date +%s%N); printf '%s\0' "$@" > "$FAKE_CLAUDE_OUT/$n.argv"; timeout 4 head -c 400000 > "$FAKE_CLAUDE_OUT/$n.stdin" || true; exit 1
SH
chmod +x "$WORK/claude"
printf '{"provider":{"pathToClaudeCodeExecutable":"%s"},"startupNoticeShown":true}\n' "$WORK/claude" > "$AGENT/claude-bridge.json"
E="$ROOT/extensions"
(cd "$PROJECT" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN FAKE_CLAUDE_OUT="$OUT" PI_CODING_AGENT_DIR="$AGENT" REDPI_AUTO_UPDATE=0 \
  timeout 120 pi -ne -e "$BRIDGE/src/index.ts" -e "$E/yitec-model-router.ts" -e "$E/redplan.ts" -e "$E/redpi-jobs.ts" -e "$E/redpi-knowledge.ts" -e "$E/redpi-images.ts" -e "$E/redpi-decisions.ts" \
  --model "$M" -p "say hi" < /dev/null > "$WORK/pi.log" 2>&1) || true
node - "$OUT" "$WORK/pi.log" <<'JS'
const fs = require("fs");
const [dir, log] = process.argv.slice(2);
const fail = (m) => { console.error("FAIL:", m, "\n", fs.readFileSync(log, "utf8").slice(-2000)); process.exit(1); };
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".stdin")).sort();
if (!files.length) fail("the bridge never started Claude Code");
let init;
for (const line of fs.readFileSync(`${dir}/${files.at(-1)}`, "utf8").split("\n")) { try { const j = JSON.parse(line); if (j.request?.subtype === "initialize") init = j.request; } catch {} }
if (!init) fail("no initialize request sent to Claude Code");
const text = String(init.appendSystemPrompt ?? "");
for (const want of ["Yitec model policy", "RedPi way of working", "Running services: unless", "Decisions and lessons (RedPi)"]) if (!text.includes(want)) fail(`RedPi text missing from Claude Code's prompt: ${want}`);
if (text.includes("You are an expert coding assistant operating inside pi")) fail("Pi's harness preamble leaked into Claude Code's prompt");
const argv = fs.readFileSync(`${dir}/${files.at(-1).replace(/\.stdin$/, ".argv")}`, "utf8").split("\0");
if (!/claude-opus-5/.test(argv[argv.indexOf("--model") + 1] || "")) fail(`unexpected model ${argv[argv.indexOf("--model") + 1]}`);
console.log(`Claude bridge test passed: RedPi's rules, Docker policy and decisions policy reach Claude Code through the bridge (${text.length} chars), Pi's harness text does not, model ${argv[argv.indexOf("--model") + 1]}.`);
JS
