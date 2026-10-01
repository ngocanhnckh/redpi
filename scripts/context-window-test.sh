#!/usr/bin/env bash
# Context windows from 9Router: a real reported window is used as is (MainAgent 272k), 9Router's
# 200k "don't know" default is flagged as unknown with a hint, /redpi-context 1m sets the true
# size at once and it persists across sessions, and /redpi-context reset undoes it.
# Real Pi TUI against a fake 9Router; never touches the real ~/.pi/agent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$(mktemp -d -t redpi-ctx-agent-XXXXXX)"
PROJECT="$(mktemp -d -t redpi-ctx-project-XXXXXX)"
trap 'rm -rf "$AGENT_DIR" "$PROJECT"' EXIT
mkdir -p "$AGENT_DIR/yitec"
echo '{ "completed": true, "provider": "manual" }' > "$AGENT_DIR/yitec/onboarding.json"
python3 - "$ROOT" "$PROJECT" "$AGENT_DIR" <<'PY'
import json, os, pty, re, select, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
root, cwd, agent_dir = sys.argv[1:4]

MODELS = [
  {"id": "MainAgent", "owned_by": "combo", "capabilities": {"contextWindow": 272000, "maxOutput": 128000, "vision": True, "reasoning": True}},
  {"id": "OpenMed", "owned_by": "combo", "capabilities": {"contextWindow": 200000, "maxOutput": 131072, "vision": True, "reasoning": False}},
  {"id": "BigCombo", "owned_by": "combo", "capabilities": {"contextWindow": 1048576, "maxOutput": 131072, "vision": True, "reasoning": True}},
]
class H(BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    body = json.dumps({"object": "list", "data": MODELS}).encode()
    self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/v1"

def session(model, steps):
  env = os.environ.copy()
  env.update({"PI_NO_TITLE": "1", "TERM": "xterm-256color", "COLUMNS": "160", "LINES": "45", "PI_CODING_AGENT_DIR": agent_dir,
              "REDPI_AUTO_UPDATE": "0", "NINE_ROUTER_BASE_URL": base, "NINE_ROUTER_API_KEY": "test-key"})
  master, slave = pty.openpty()
  p = subprocess.Popen(["pi", "-ne", "-e", f"{root}/extensions/yitec-model-router.ts", "--model", f"9router/{model}"], cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
  os.close(slave)
  out = b""
  def clean():
    t = out.decode("utf-8", "ignore"); t = re.sub(r"\x1b\][^\a]*(?:\a|\x1b\\)", "", t); return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", t)
  def drain(sec, until=None):
    nonlocal out
    start = len(clean()); end = time.time() + sec
    while time.time() < end:
      r, _, _ = select.select([master], [], [], 0.2)
      if r:
        try: out += os.read(master, 65536)
        except OSError: break
      if until and re.search(until, clean()[start:]): return True
    return not until
  def send(text, until, sec=20):
    os.write(master, text.encode()); time.sleep(0.3); os.write(master, b"\r")
    if not drain(sec, until): fail(f"{model}: after {text!r} expected /{until}/", clean()[-3000:])
  def fail(msg, extra=""):
    p.kill(); print("FAIL:", msg, "\n", extra); sys.exit(1)
  drain(40, r"9router|MainAgent|OpenMed|BigCombo")
  drain(3)
  try:
    steps(send, clean, fail, drain)
  finally:
    p.kill()

def flat(t): return re.sub(r"\s+", " ", t)

# 1. A combo on 9Router's 200k default: flagged unknown, hint shown, then set to 1M.
def openmed(send, clean, fail, drain):
  if "does not report the real" not in flat(clean()) and not drain(15, r"does not report the real"): fail("unknown window should be flagged on start", clean()[-3000:])
  send("/redpi-context", r"200,000 tokens \(unknown")
  if not re.search(r"/200k", clean()): fail("Pi's footer should show the 200k window first", clean()[-2000:])
  send("/redpi-context 1m", r"set to 1,048,576 tokens")
  send("/redpi-context", r"1,048,576 tokens \(set with /redpi-context\)")
  if not re.search(r"/1(\.\d+)?M", clean()[-4000:]): fail("Pi's own footer (and auto-compaction) should use the new window", clean()[-2000:])
  saved = json.load(open(os.path.join(agent_dir, "yitec", "context-windows.json")))
  if saved.get("9router/OpenMed") != 1048576: fail("override should be saved", saved)
  send("/redpi-context abc", r"Not a size")
session("OpenMed", openmed)

# 2. The override persists in a new session, with no unknown hint; reset brings back 200k.
def again(send, clean, fail, drain):
  if "does not report the real context window" in flat(clean()): fail("no hint once the size is set")
  send("/redpi-context", r"1,048,576 tokens \(set with /redpi-context\)")
  send("/redpi-context reset", r"back to 200k \(unknown")
  if "9router/OpenMed" in json.load(open(os.path.join(agent_dir, "yitec", "context-windows.json"))): fail("reset should remove the override")
session("OpenMed", again)

# 3. A window 9Router really reports is used as is, even for MainAgent (no blanket 1M).
session("MainAgent", lambda send, clean, fail, drain: send("/redpi-context", r"272,000 tokens \(reported by 9Router\)"))
session("BigCombo", lambda send, clean, fail, drain: send("/redpi-context", r"1,048,576 tokens \(reported by 9Router\)"))
srv.shutdown()
print("Context window test passed: real 9Router windows used as is (MainAgent 272k, BigCombo 1M), the 200k default flagged as unknown with a hint, /redpi-context 1m applies at once and persists, reset undoes it, bad sizes refused.")
PY
