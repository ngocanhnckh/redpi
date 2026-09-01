#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const localPath = path.join(agentDir, 'yitec', '9router.local.json');
function readLocal() {
  try { return JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch { return {}; }
}
const local = readLocal();
process.stdout.write(process.env.NINE_ROUTER_API_KEY || process.env.ROUTER9_API_KEY || process.env.NINEROUTER_API_KEY || local.apiKey || 'dummy');
