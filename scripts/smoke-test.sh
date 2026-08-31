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
python3 - "$ROOT" "$PROJECT" <<'PY'
import os, pty, subprocess, time, select, re, sys
root, cwd = sys.argv[1], sys.argv[2]
env=os.environ.copy(); env.update({'PI_NO_TITLE':'1','TERM':'xterm-256color','COLUMNS':'120','LINES':'40'})
master, slave = pty.openpty()
p=subprocess.Popen(['pi','-e',f'{root}/extensions/yitec-model-router.ts'],cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave); out=b''
def drain(sec):
 global out
 end=time.time()+sec
 while time.time()<end:
  r,_,_=select.select([master],[],[],0.1)
  if r:
   try: d=os.read(master,8192)
   except OSError: break
   if not d: break
   out += d
drain(4)
for line in ['/yitec-doctor\r','/yitec-agents\r','/yitec-memory\r']:
 os.write(master,line.encode()); drain(2)
os.write(master,b'\x04'); drain(1)
try: p.terminate(); p.wait(timeout=3)
except Exception: p.kill()
s=out.decode('utf-8','ignore')
s=re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)','',s); s=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',s)
checks=['Problems: none','Project config trusted: yes','subagent: openai-codex/gpt-5.6-terra','Project memory','Keep tests small']
missing=[c for c in checks if c not in s]
if missing:
 print(s[-5000:]); raise SystemExit('Missing smoke checks: '+', '.join(missing))
print('Yitec smoke passed: real Pi TUI loaded extension, commands, roles, trusted project config, and memory.')
PY
