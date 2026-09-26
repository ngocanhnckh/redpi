#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${YITEC_SMOKE_PROJECT:-/tmp/yitec-pi-project-test}"
mkdir -p "$PROJECT/.pi/yitec"
cat > "$PROJECT/.pi/yitec/model-tiers.json" <<'JSON'
{
  "roles": {
    "planner": { "models": ["openai-codex/gpt-5.6-terra:medium"], "thinking": "medium" },
    "executor": { "models": ["openai-codex/gpt-5.6-terra:low"], "thinking": "low" },
    "subagent": { "models": ["openai-codex/gpt-5.6-terra:low"], "thinking": "low" },
    "reviewer": { "models": ["openai-codex/gpt-5.6-terra:medium"], "thinking": "medium" },
    "vision": { "models": ["openai-codex/gpt-5.6-terra:medium"], "thinking": "medium" },
    "commit": { "models": ["openai-codex/gpt-5.6-terra:low"], "thinking": "low" },
    "tiny": { "models": ["openai-codex/gpt-5.6-terra:off"], "thinking": "off" }
  },
  "tiers": { "high": [{"model":"openai-codex/gpt-5.6-terra","thinking":"medium","vision":true}], "low": [{"model":"openai-codex/gpt-5.6-terra","thinking":"low","vision":true}], "uncapable": [] },
  "retry": { "enabled": true, "maxPerUserPrompt": 1, "cooldownMs": 1000, "fallbackChains": { "planner": ["openai-codex/gpt-5.6-terra:medium"] }, "errorPatterns": ["rate limit", "429", "quota"] },
  "magicKeywords": { "enabled": true, "ultrathink": true, "orchestrate": true, "cheap": true },
  "memory": { "enabled": true, "injectionCharLimit": 2000 },
  "advisor": { "enabled": false, "modelRole": "reviewer", "autoReview": false, "tools": ["read", "grep"] }
}
JSON
cat > "$PROJECT/.pi/yitec/memory.md" <<'EOF'
# Project memory
- Prefer focused validation.
EOF
cat > "$PROJECT/.pi/yitec/lessons.md" <<'EOF'
# Project lessons
- Keep tests small.
EOF
cat > "$PROJECT/.pi/WATCHDOG.md" <<'EOF'
# Watchdog
- Flag skipped validation.
EOF
# Never touch the real ~/.pi/agent: typed test commands must not land in onboarding/setup prompts.
AGENT_DIR="$(mktemp -d -t redpi-smoke-agent-XXXXXX)"
trap 'rm -rf "$AGENT_DIR"' EXIT
mkdir -p "$AGENT_DIR/yitec"
echo '{ "completed": true, "provider": "manual" }' > "$AGENT_DIR/yitec/onboarding.json"
python3 - "$ROOT" "$PROJECT" "$AGENT_DIR" <<'PY'
import os, pty, subprocess, time, select, re, sys
root, cwd, agent_dir = sys.argv[1], sys.argv[2], sys.argv[3]
env=os.environ.copy(); env.update({'PI_NO_TITLE':'1','TERM':'xterm-256color','COLUMNS':'120','LINES':'40','PI_CODING_AGENT_DIR':agent_dir,'REDPI_AUTO_UPDATE':'0'})
for k in ('NINE_ROUTER_API_KEY','ROUTER9_API_KEY','NINEROUTER_API_KEY','NINE_ROUTER_BASE_URL','ROUTER9_BASE_URL'): env.pop(k, None)
master, slave = pty.openpty()
p=subprocess.Popen(['pi','-ne','-e',f'{root}/extensions/yitec-model-router.ts'],cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave); out=b''
def clean():
 t=out.decode('utf-8','ignore'); t=re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)','',t); return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',t)
def drain(sec, until=None):
 # Wait for the expected screen text instead of fixed sleeps, which flake under load.
 global out
 start=len(clean()); end=time.time()+sec
 while time.time()<end:
  if until and until in clean()[start:]: return drain(0.3)
  r,_,_=select.select([master],[],[],0.1)
  if r:
   try: d=os.read(master,8192)
   except OSError: break
   if not d: break
   out += d
drain(15,'RedPi high:')
for line,until in [('/yitec-9router\r','9Router provider:'),('/yitec-doctor\r','Project config trusted:'),('/yitec-agents\r','subagent:'),('/yitec-memory\r','Keep tests small')]:
 os.write(master,line.encode()); drain(15,until)
os.write(master,b'\x04'); drain(1)
try: p.terminate(); p.wait(timeout=3)
except Exception: p.kill()
s=out.decode('utf-8','ignore')
s=re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)','',s); s=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',s)
checks=['9Router provider: registered','Problems: none','Project config trusted: yes','subagent: openai-codex/gpt-5.6-terra','Project memory','Keep tests small']
missing=[c for c in checks if c not in s]
if missing:
 print(s[-5000:]); raise SystemExit('Missing smoke checks: '+', '.join(missing))
print('Yitec smoke passed: real Pi TUI loaded extension, commands, roles, trusted project config, and memory.')
PY

# A settings.json RedPi cannot parse (half-written or hand-edited) must be left alone, never
# rebuilt from scratch: that once dropped the user's "packages" list and Pi stopped loading RedPi.
BROKEN_DIR="$(mktemp -d -t redpi-smoke-broken-XXXXXX)"
trap 'rm -rf "$AGENT_DIR" "$BROKEN_DIR"' EXIT
mkdir -p "$BROKEN_DIR/yitec"
echo '{ "completed": true, "provider": "manual" }' > "$BROKEN_DIR/yitec/onboarding.json"
printf '{\n  "packages": ["git:github.com/ngocanhnckh/redpi"],\n  "defaultModel": "MainAgent",\n' > "$BROKEN_DIR/settings.json"
cp "$BROKEN_DIR/settings.json" "$BROKEN_DIR/settings.expected"
python3 - "$ROOT" "$PROJECT" "$BROKEN_DIR" <<'PY'
import os, pty, subprocess, time, select, sys
root, cwd, agent_dir = sys.argv[1:4]
env = os.environ.copy(); env.update({'PI_NO_TITLE': '1', 'TERM': 'xterm-256color', 'PI_CODING_AGENT_DIR': agent_dir, 'REDPI_AUTO_UPDATE': '0'})
master, slave = pty.openpty()
p = subprocess.Popen(['pi', '-ne', '-e', f'{root}/extensions/yitec-model-router.ts'], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave); out = b''; end = time.time() + 20
while time.time() < end and b'RedPi' not in out and p.poll() is None:
    r, _, _ = select.select([master], [], [], 0.1)
    if r:
        try: out += os.read(master, 8192)
        except OSError: break
time.sleep(1)
try: p.terminate(); p.wait(timeout=3)
except Exception: p.kill()
PY
cmp -s "$BROKEN_DIR/settings.json" "$BROKEN_DIR/settings.expected" || { echo "FAIL: RedPi rewrote an unreadable settings.json:"; cat "$BROKEN_DIR/settings.json"; exit 1; }
echo "Settings safety passed: an unreadable settings.json is left untouched."
