#!/usr/bin/env bash
# End-to-end RedPlan test: a CEO Pi runs /redplan against a scripted fake model, the plan is
# approved through HQ, the CEO spawns two real worker Pi sessions in tmux (one shared, one in a
# git worktree), and the workers update the board and message each other and the CEO.
# Everything is private: temp agent dir, temp HQ dir + random port, private tmux socket.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v tmux >/dev/null || { echo "tmux not installed; skipping RedPlan smoke test"; exit 0; }
python3 - "$ROOT" <<'PY'
import json, os, pty, re, select, signal, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

root = sys.argv[1]
requests = []  # (identity, last user text, system prompt)

PLAN = {
  "title": "Tiny todo API", "summary": "A small todo REST API with a CLI client.",
  "intake": {"mode": "direct", "notes": "Request was specific."},
  "techStack": [{"name": "FastAPI", "package": "fastapi", "ecosystem": "PyPI", "usedFor": "REST API", "uses": "FastAPI, APIRouter",
                 "source": "https://fastapi.tiangolo.com/", "verified": True, "verifiedFact": "FastAPI class exists"}],
  "architecture": {"components": [{"id": "api", "name": "Todo API", "kind": "service"}, {"id": "cli", "name": "CLI", "kind": "ui"}],
                   "links": [{"from": "cli", "to": "api", "label": "HTTP"}]},
  "stories": [
    {"id": "S1", "title": "Manage todos", "userStory": "As a user, I want to add todos, so that I remember things.", "acceptance": ["POST works"],
     "tasks": [{"id": "T1", "title": "Todo endpoints", "description": "FastAPI CRUD endpoints for todos.", "estimateHours": 3}]},
    {"id": "S2", "title": "CLI", "userStory": "As a user, I want a CLI, so that I use it from a terminal.", "acceptance": ["add/list"],
     "tasks": [{"id": "T2", "title": "CLI client", "description": "A small CLI that calls the API.", "estimateHours": 2}]},
  ],
}

def identity(system):
    m = re.search(r"RedPlan worker\. You are (\w+)", system)
    if m: return m.group(1)
    return "CEO" if "RedPlan mode is ON" in system else "other"

# Each identity has scripts keyed by a trigger in the latest user message; step N runs after N tool results.
SCRIPTS = {
  "CEO": [
    ("[RedPlan] New request", [("redplan_submit_plan", {"plan": PLAN})]),
    ("APPROVED", [
      ("redplan_spawn_worker", {"role": "backend developer", "name": "Alex", "taskIds": ["T1"], "workspace": "shared", "brief": "Build T1. Tell Peter the endpoint shape."}),
      ("redplan_spawn_worker", {"role": "full-stack developer", "name": "Peter", "taskIds": ["T2"], "workspace": "worktree", "brief": "Build T2. Wait for Alex's endpoint shape."}),
    ]),
  ],
  "Alex": [
    ("[RedPlan brief", [
      ("redplan_update_task", {"taskId": "T1", "status": "in_progress"}),
      ("redplan_send", {"to": "Peter", "message": "Endpoints: GET/POST /todos returning {id, text}."}),
      ("redplan_update_task", {"taskId": "T1", "status": "done", "note": "3 tests pass"}),
    ]),
  ],
  "Peter": [
    ("message from Alex", [("redplan_send", {"to": "ceo", "message": "Peter here: got the API shape from Alex, building the CLI."})]),
  ],
}

def slow_reply(handler):
    # Streams one token, then stalls for 60s: only an abort ends this request early.
    handler.send_response(200); handler.send_header("content-type", "text/event-stream"); handler.send_header("connection", "close"); handler.end_headers()
    first = {"id": "x", "object": "chat.completion.chunk", "model": "MainAgent", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Working on it"}, "finish_reason": None}]}
    handler.wfile.write(f"data: {json.dumps(first)}\n\n".encode()); handler.wfile.flush()
    for _ in range(120):
        time.sleep(0.5)
        handler.wfile.write(b": still thinking\n\n"); handler.wfile.flush()
    handler.close_connection = True

def reply(handler, identity, messages, system=""):
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
    user_text = messages[last_user].get("content") if last_user >= 0 else ""
    if isinstance(user_text, list): user_text = " ".join(p.get("text", "") for p in user_text if isinstance(p, dict))
    done_steps = sum(1 for m in messages[last_user + 1:] if m.get("role") == "tool")
    steps = next((s for trig, s in SCRIPTS.get(identity, []) if trig in (user_text or "")), [])
    requests.append((identity, user_text or "", system))
    if "SLOWTASK" in (user_text or "") and "INTERRUPTED-NOW" not in (user_text or ""):
        return slow_reply(handler)
    if done_steps < len(steps):
        name, args = steps[done_steps]
        delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{identity}_{len(requests)}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
        chunks = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}]
    else:
        chunks = [{"choices": [{"index": 0, "delta": {"role": "assistant", "content": f"{identity}: ok."}, "finish_reason": None}]}, {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
    chunks.append({"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 5, "total_tokens": 105}})
    body = ("".join(f"data: {json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'model': 'MainAgent', **c})}\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
    handler.send_response(200); handler.send_header("content-type", "text/event-stream"); handler.send_header("content-length", str(len(body))); handler.end_headers(); handler.wfile.write(body)

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def handle(self):
        try: super().handle()
        except (BrokenPipeError, ConnectionResetError): pass  # Pi aborts model-list refreshes it no longer needs
    def do_GET(self):
        body = json.dumps({"data": [{"id": "MainAgent", "owned_by": "combo"}, {"id": "SubAgent", "owned_by": "combo"}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        msgs = req.get("messages", [])
        system = "\n".join((m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content"))) for m in msgs if m.get("role") in ("system", "developer"))
        reply(self, identity(system), msgs, system)
    def log_message(self, *a): pass

llm = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=llm.serve_forever, daemon=True).start()
agent = tempfile.mkdtemp(prefix="redplan-agent-")
hqdir = tempfile.mkdtemp(prefix="redplan-hq-")
project = tempfile.mkdtemp(prefix="redplan-project-")
subprocess.run(["git", "init", "-q", project], check=True)
subprocess.run(["git", "-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], check=True)
os.makedirs(f"{agent}/yitec")
json.dump({"completed": True, "provider": "router"}, open(f"{agent}/yitec/onboarding.json", "w"))
json.dump({"baseUrl": f"http://127.0.0.1:{llm.server_port}/v1", "apiKey": "k"}, open(f"{agent}/yitec/9router.local.json", "w"))
json.dump({"defaultProvider": "9router", "defaultModel": "MainAgent", "defaultThinkingLevel": "off"}, open(f"{agent}/settings.json", "w"))
port = 30000 + os.getpid() % 20000
sock = f"redplan-test-{os.getpid()}"
env = os.environ.copy()
for k in ("NINE_ROUTER_API_KEY", "ROUTER9_API_KEY", "NINEROUTER_API_KEY", "NINE_ROUTER_BASE_URL", "ROUTER9_BASE_URL", "TMUX"): env.pop(k, None)
env.update({"PI_NO_TITLE": "1", "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40", "PI_CODING_AGENT_DIR": agent, "REDPI_AUTO_UPDATE": "0",
            "REDPI_HQ_DIR": hqdir, "REDPI_HQ_PORT": str(port), "REDPI_TMUX_SOCKET": sock, "REDPI_HQ_PUBLIC_HOST": "127.0.0.1",
            "REDPI_WORKER_ARGS": f"-ne -e {root}/extensions/yitec-model-router.ts -e {root}/extensions/redplan.ts"})

def hq(method, path, body=None):
    import urllib.request
    token = open(f"{hqdir}/token").read().strip()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {token}", "x-redpi-hq": "1", "content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())

def wait(what, fn, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v: return v
        except Exception: pass
        drain(0.5)
    print(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", out.decode("utf8", "ignore"))[-2500:])
    raise SystemExit(f"timed out waiting for: {what}\nrequests seen: {[(i, u[:60]) for i, u, _ in requests][-12:]}")

master, slave = pty.openpty()
ceo = subprocess.Popen(["pi", "-ne", "-e", f"{root}/extensions/yitec-model-router.ts", "-e", f"{root}/extensions/redplan.ts"], cwd=project, env=env,
                       stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = b""
def drain(sec):
    global out
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try: out += os.read(master, 65536)
            except OSError: return
try:
    wait("CEO TUI ready", lambda: (drain(0.3), b"RedPi high:" in out)[1], 90)
    os.write(master, b"/redplan Build a tiny todo API with a CLI"); drain(0.5); os.write(master, b"\r")
    run = wait("plan submitted", lambda: next((r for r in hq("GET", "/api/runs") if r["status"] == "awaiting_approval"), None))
    state = hq("GET", f"/api/runs/{run['id']}")
    plan = state["plan"]
    if plan["schedule"]["criticalPath"] != ["T1"] or plan["schedule"]["maxParallel"] != 2:
        raise SystemExit(f"schedule wrong: {plan['schedule']}")
    ceo_sys = next(s for i, u, s in requests if i == "CEO")
    if "RedPlan mode is ON" not in ceo_sys or "Automatic subagents are ON" not in ceo_sys:
        raise SystemExit("CEO system prompt is missing the RedPlan protocol or the RedPi subagent policy (prompt chaining broken)")

    hq("POST", f"/api/plans/{plan['id']}/decision", {"decision": "approve", "comment": "ship it"})
    workers = wait("two workers spawned", lambda: (lambda s: s["workers"] if len(s["workers"]) == 2 else None)(hq("GET", f"/api/runs/{run['id']}")))
    names = {w["name"]: w for w in workers}
    sessions = subprocess.run(["tmux", "-L", sock, "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True).stdout.split()
    if len(sessions) != 2: raise SystemExit(f"expected 2 tmux worker sessions, got {sessions}")
    peter = names["Peter"]
    if not peter["branch"] or ".redpi-worktrees" not in peter["cwd"] or not os.path.isdir(peter["cwd"]):
        raise SystemExit(f"Peter's worktree missing: {peter}")
    if ".redpi-worktrees/" not in open(f"{project}/.git/info/exclude").read():
        raise SystemExit("worktree folder not excluded from git status")

    def pane(name):
        return subprocess.run(["tmux", "-L", sock, "capture-pane", "-p", "-t", f"={name}"], capture_output=True, text=True).stdout
    try: wait("Alex finished T1", lambda: next((t for t in hq("GET", f"/api/runs/{run['id']}")["tasks"] if t["id"] == "T1" and t["status"] == "done"), None), 90)
    except SystemExit: print("---- Alex pane ----"); print(pane(names["Alex"]["tmux"])[-2500:]); raise
    wait("Alex finished T1 (confirmed)", lambda: next((t for t in hq("GET", f"/api/runs/{run['id']}")["tasks"] if t["id"] == "T1" and t["status"] == "done"), None))
    wait("Peter received Alex's message", lambda: any(i == "Peter" and "message from Alex" in u for i, u, _ in requests))
    wait("CEO received Peter's report", lambda: any(i == "CEO" and "message from Peter" in u for i, u, _ in requests))
    # Peter started after Alex, so Peter's prompt must name Alex as a teammate with his task.
    peter_sys = [s for i, u, s in requests if i == "Peter"][-1]
    if "You are Peter, full-stack developer" not in peter_sys or "Alex (backend developer)" not in peter_sys or "T2 CLI client" not in peter_sys:
        i = peter_sys.find("RedPlan worker"); print(peter_sys[i:i+700]); raise SystemExit("worker system prompt lacks identity, team, or tasks")

    hq("POST", f"/api/runs/{run['id']}/messages", {"from": "human", "to": names["Alex"]["id"], "kind": "command", "body": "Please also add a /health endpoint."})
    wait("human instruction delivered to Alex", lambda: any(i == "Alex" and "instruction from the human via HQ" in u and "/health" in u for i, u, _ in requests))
    # Interrupt: Alex is stuck in a 60s model response; an HQ interrupt must abort it and deliver at once.
    hq("POST", f"/api/runs/{run['id']}/messages", {"from": "human", "to": names["Alex"]["id"], "kind": "command", "body": "SLOWTASK: write the docs."})
    wait("Alex busy on the slow task", lambda: any(i == "Alex" and "SLOWTASK" in u for i, u, _ in requests))
    time.sleep(1.5)
    t0 = time.time()
    hq("POST", f"/api/runs/{run['id']}/messages", {"from": "human", "to": names["Alex"]["id"], "kind": "interrupt", "body": "INTERRUPTED-NOW: stop and fix the failing test first."})
    try: wait("interrupt delivered to Alex", lambda: any(i == "Alex" and "INTERRUPTED-NOW" in u for i, u, _ in requests), 25)
    except SystemExit: print("---- Alex pane ----"); print(pane(names["Alex"]["tmux"])[-2000:]); raise
    if time.time() - t0 > 20: raise SystemExit("interrupt did not abort the running turn")
    detail = hq("GET", f"/api/workers/{names['Alex']['id']}")
    if not detail["events"] or not detail["worker"]["last_message"]:
        raise SystemExit(f"worker heartbeat/activity not reported: {detail['worker']}")
    msgs = hq("GET", f"/api/runs/{run['id']}")["messages"]
    if not any(m["senderName"] == "Alex" and m["recipientName"] == "Peter" for m in msgs):
        raise SystemExit("teammate chat not visible in the run feed")
    print("RedPlan smoke passed: /redplan → plan + critical path → approval → 2 tmux workers (shared + worktree) → board updates, teammate chat, CEO reports, human instructions and interrupts.")
finally:
    ceo.kill()
    subprocess.run(["tmux", "-L", sock, "kill-server"], capture_output=True)
    try: os.kill(int(open(f"{hqdir}/hq.pid").read()), signal.SIGTERM)
    except Exception: pass
PY
