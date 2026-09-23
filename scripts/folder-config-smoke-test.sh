#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$ROOT" <<'PY'
import json, os, pty, re, select, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

root = sys.argv[1]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith('/models'):
            # Real 9Router marks combos with owned_by "combo"; raw provider routes must stay hidden.
            body = json.dumps({'data': [{'id': 'team/MainAgent', 'owned_by': 'combo'}, {'id': 'team/SubAgent', 'owned_by': 'combo'},
                                        {'id': 'team/Other', 'owned_by': 'combo'}, {'id': 'kr/raw-provider-model', 'owned_by': 'kr'}]}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()
    def log_message(self, *args):
        pass

server = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
agent_dir = tempfile.mkdtemp(prefix='redpi-agent-')
folder = tempfile.mkdtemp(prefix='redpi-folder-')
os.makedirs(os.path.join(folder, 'sub'))
os.makedirs(os.path.join(agent_dir, 'yitec'))
def write(path, value):
    with open(path, 'w') as f:
        json.dump(value, f)
write(os.path.join(agent_dir, 'yitec', 'onboarding.json'), {'completed': True, 'provider': 'router'})
write(os.path.join(agent_dir, 'yitec', '9router.local.json'), {'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'apiKey': 'test-key'})
write(os.path.join(agent_dir, 'yitec', 'model-tiers.json'), {'roles': {
    'planner': {'models': ['9router/team/MainAgent:high'], 'thinking': 'high'},
    'executor': {'models': ['9router/team/SubAgent:low'], 'thinking': 'low'},
    'subagent': {'models': ['9router/team/SubAgent:low'], 'thinking': 'low'},
}})
write(os.path.join(agent_dir, 'settings.json'), {'defaultProvider': '9router', 'defaultModel': 'team/MainAgent'})

env = os.environ.copy()
env.update({'PI_NO_TITLE': '1', 'TERM': 'xterm-256color', 'COLUMNS': '140', 'LINES': '50',
            'PI_CODING_AGENT_DIR': agent_dir, 'REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS': '1000'})
for k in ('NINE_ROUTER_API_KEY', 'ROUTER9_API_KEY', 'NINEROUTER_API_KEY', 'NINE_ROUTER_BASE_URL', 'ROUTER9_BASE_URL'):
    env.pop(k, None)

def session(cwd, keys):
    master, slave = pty.openpty()
    proc = subprocess.Popen(['pi', '-ne', '-e', f'{root}/extensions/yitec-model-router.ts'], cwd=cwd, env=env,
                            stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    out = b''
    def clean():
        t = out.decode('utf-8', 'ignore')
        t = re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)', '', t)
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', t)
    def drain(seconds, until=None):
        # Stop early once `until` appears after the output seen so far, so keys are
        # only typed when the matching screen is up (fixed sleeps flake under load).
        nonlocal out
        start = len(clean())
        end = time.time() + seconds
        while time.time() < end:
            if until and until in clean()[start:]:
                drain(0.3)
                return
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                out += chunk
    try:
        drain(15, 'RedPi high:')
        for text, until in keys:
            os.write(master, text.encode())
            drain(15 if until else 4, until)
        os.write(master, b'\x04')
        drain(0.5)
    finally:
        try:
            proc.terminate(); proc.wait(timeout=2)
        except Exception:
            proc.kill()
    text = out.decode('utf-8', 'ignore')
    text = re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

DOWN = '\x1b[B'
# /redpi-config -> This folder -> planner -> manual entry -> team/Other -> keep thinking -> Save (after 8 roles)
first = session(folder, [
    ('/redpi-config\r', 'This folder: strict'),
    ('\r', 'pick a role to change'),
    ('\r', 'Model for planner'),
    (DOWN + '\r', 'provider/model'),
    ('9router/team/Other\r', 'Thinking level for planner'),
    ('\r', 'pick a role to change'),
    (DOWN * 8 + '\r', 'Current session now on'),
])
configs = [os.path.join(agent_dir, 'yitec', 'folders', f) for f in os.listdir(os.path.join(agent_dir, 'yitec', 'folders'))] if os.path.isdir(os.path.join(agent_dir, 'yitec', 'folders')) else []
if len(configs) != 1:
    print(first[-4000:]); raise SystemExit(f'expected one folder config, found {configs}')
cfg = json.load(open(configs[0]))
if cfg.get('folder') != os.path.realpath(folder) and cfg.get('folder') != folder:
    raise SystemExit(f'folder config bound to wrong folder: {cfg.get("folder")}')
if cfg.get('routing', {}).get('mode') != 'strict':
    raise SystemExit(f'folder config is not strict: {cfg.get("routing")}')
planner = cfg['roles']['planner']['models'][0]
if planner != '9router/team/Other:high':
    raise SystemExit(f'planner not saved: {planner}')
if cfg['roles']['executor']['models'][0] != '9router/team/SubAgent:low':
    raise SystemExit(f'unchanged roles were not snapshotted: {cfg["roles"]}')
proj = json.load(open(os.path.join(folder, '.pi', 'settings.json')))
if proj.get('subagents', {}).get('agentOverrides', {}).get('oracle', {}).get('model') != '9router/team/Other':
    raise SystemExit(f'folder subagent settings not written: {proj}')
glob = json.load(open(os.path.join(agent_dir, 'yitec', 'model-tiers.json')))
if glob['roles']['planner']['models'][0] != '9router/team/MainAgent:high':
    raise SystemExit('global config was modified by a folder save')
if 'kr/raw-provider-model' in first:
    print(first[-4000:]); raise SystemExit('non-combo 9Router model was listed in the model picker')
if 'Current session now on 9router/team/Other' not in first:
    print(first[-4000:]); raise SystemExit('saved folder config was not applied to the live session')

# A brand-new session in a subfolder must start on the folder planner, not the global MainAgent default.
second = session(os.path.join(folder, 'sub'), [])
if 'folder config · planner on 9router/team/Other' not in second:
    print(second[-4000:]); raise SystemExit('new session did not start on the folder planner model')

# A manual /model pick must survive the next turn instead of snapping back to the planner model.
third = session(os.path.join(folder, 'sub'), [('/model 9router/team/SubAgent\r', 'pinned 9router/team/SubAgent'), ('hello\r', None)])
if 'pinned 9router/team/SubAgent' not in third:
    print(third[-4000:]); raise SystemExit('manual /model choice was not pinned')
after_prompt = third.split('hello', 1)[-1]
if 'planner on 9router/team/Other' in after_prompt:
    print(third[-4000:]); raise SystemExit('role routing overrode the pinned model')

print('RedPi folder config smoke passed: strict per-folder roles saved, subagents scoped, global untouched, new sessions start on the folder planner, manual /model picks stay pinned, picker lists combos only.')
PY
