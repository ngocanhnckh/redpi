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
            payload = {
                'data': [
                    {'id': 'team/MainAgent'},
                    {'id': 'team/SubAgent'},
                    {'id': 'team/OtherVeryLongModelNameThatShouldNotExplodeTheTui'},
                ]
            }
            body = json.dumps(payload).encode()
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
base_url = f'http://127.0.0.1:{server.server_port}/v1'
agent_dir = tempfile.mkdtemp(prefix='redpi-agent-')

env = os.environ.copy()
env.update({
    'PI_NO_TITLE': '1',
    'TERM': 'xterm-256color',
    'COLUMNS': '120',
    'LINES': '40',
    'PI_CODING_AGENT_DIR': agent_dir,
    'REDPI_9ROUTER_DISCOVERY_TIMEOUT_MS': '1000',
})

master, slave = pty.openpty()
proc = subprocess.Popen(
    ['pi', '-ne', '-e', f'{root}/extensions/yitec-model-router.ts'],
    cwd=root,
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
out = b''

def drain(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(master, 8192)
            except OSError:
                break
            if not chunk:
                break
            out += chunk

def send(text, wait=0.8):
    os.write(master, text.encode())
    drain(wait)

try:
    drain(3)
    send('/redpi-setup\r', 1.2)
    send('\r', 0.8)               # menu: 9Router login / connection
    send(base_url + '\r', 0.8)    # base URL
    send('test-key\r', 1.2)       # API key
    send('\r', 0.8)               # confirm auto-config
    send('\r', 2.0)               # use recommended MainAgent/SubAgent mapping
    drain(2)
    os.write(master, b'\x04')
    drain(0.5)
finally:
    try:
        proc.terminate()
        proc.wait(timeout=2)
    except Exception:
        proc.kill()

text = out.decode('utf-8', 'ignore')
text = re.sub(r'\x1b\][^\a]*(?:\a|\x1b\\)', '', text)
text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

cfg_path = os.path.join(agent_dir, 'yitec', 'model-tiers.json')
settings_path = os.path.join(agent_dir, 'settings.json')
local_path = os.path.join(agent_dir, 'yitec', '9router.local.json')
for path in (cfg_path, settings_path, local_path):
    if not os.path.exists(path):
        print(text[-5000:])
        raise SystemExit(f'missing expected file: {path}')

cfg = json.load(open(cfg_path))
settings = json.load(open(settings_path))
local = json.load(open(local_path))
checks = [
    ('planner', '9router/team/MainAgent:high'),
    ('executor', '9router/team/SubAgent:low'),
    ('subagent', '9router/team/SubAgent:low'),
    ('tiny', '9router/team/SubAgent:off'),
]
for role, expected in checks:
    got = cfg.get('roles', {}).get(role, {}).get('models', [None])[0]
    if got != expected:
        print(text[-5000:])
        raise SystemExit(f'{role} expected {expected}, got {got}')

if settings.get('defaultProvider') != '9router' or settings.get('defaultModel') != 'team/MainAgent':
    raise SystemExit(f'bad default settings: {settings}')
if settings.get('retry', {}).get('provider', {}).get('timeoutMs', 0) < 900000:
    raise SystemExit(f'timeout settings not patched: {settings}')
if local.get('baseUrl') != base_url or local.get('apiKey') != 'test-key':
    raise SystemExit(f'bad local 9router config: {local}')
if 'Auto-configured RedPi roles' not in text:
    print(text[-5000:])
    raise SystemExit('setup wizard did not reach success notification')

after_success = text.split('Auto-configured RedPi roles', 1)[-1]
if 'Role model setup' in after_success or '9Router login / connection' in after_success:
    print(text[-5000:])
    raise SystemExit('setup wizard appears to loop after success')

print('RedPi setup wizard smoke passed: one-shot setup, MainAgent/SubAgent mapping, local auth, and timeout settings verified.')
PY
