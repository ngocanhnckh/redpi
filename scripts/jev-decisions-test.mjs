#!/usr/bin/env node
// Jev in the agent loop (extensions/redpi-decisions.ts, lib/jev-decisions.ts), against a fake Jev:
//   - exact rules: read-only commands pass without a call, catastrophic ones are flagged without one;
//   - the safety check asks four yes/no questions in one call, asks the human about a flagged
//     command (block / allow once / allow for the session), never opens a dialog in a RedPlan
//     worker (blocks only when clearly risky), "shadow" only logs, "off" and Jev off do nothing,
//     and an unreachable Jev never blocks;
//   - pruning replaces only stale, large, older tool outputs, keeps the newest ones, persists its
//     decisions in the session, and does nothing below the size threshold;
//   - the decision log and /redpi-jev-stats.
// Uses a temp agent dir; never touches the real ~/.pi/agent.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "redpi-jevdec-"));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.REDPI_HQ_WORKER;
const { saveJevConfig } = await import("../lib/jev.ts");
const { prefilterCommand, decisionLogPath } = await import("../lib/jev-decisions.ts");
const ext = (await import("../extensions/redpi-decisions.ts")).default;

// Fake Jev: risky answers for commands mentioning DANGER / SECRET / PUBLISH, "not needed" for
// tool outputs marked STALE.
const calls = [];
let down = false;
const server = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    if (down) { res.writeHead(503); return res.end("{}"); }
    const body = JSON.parse(raw); calls.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      let p = 0.03;
      const cmd = String(body.state.command || "");
      if (id === "destroys" && /DANGER/.test(cmd)) p = 0.97;
      if (id === "secrets" && /SECRET/.test(cmd)) p = 0.62;
      if (id === "publishes" && /PUBLISH/.test(cmd)) p = 0.91;
      if (/^c\d+$/.test(id)) p = /STALE/.test(JSON.stringify(body.state.toolCalls[id])) ? 0.04 : 0.9;
      answers[id] = { type: "noul", noul: p };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 500 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const setCfg = (extra = {}) => saveJevConfig(dir, { enabled: true, provider: "custom", baseUrl: base, apiKey: "k-test", model: "jev-test", ...extra });

// A minimal Pi: collects handlers, lets the test fire events.
const handlers = {}; const commands = {}; const entries = [];
const pi = { on: (e, h) => ((handlers[e] ||= []).push(h)), registerCommand: (n, c) => (commands[n] = c), appendEntry: (t, d) => entries.push({ type: "custom", customType: t, data: d }) };
ext(pi);
const fire = async (e, event, ctx) => { let out; for (const h of handlers[e] || []) out = (await h(event, ctx)) ?? out; return out; };
let answer = "Block it"; const asked = []; const notes = [];
const ctx = (extra = {}) => ({ cwd: "/work/app", hasUI: true, signal: undefined, ui: { select: async (title, opts) => { asked.push(title); return answer; }, notify: (t) => notes.push(t), setStatus: () => {} }, sessionManager: { getEntries: () => entries }, getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000 }), model: { contextWindow: 200_000 }, ...extra });
const bash = (command) => ({ toolName: "bash", input: { command } });

// 1. Exact rules.
for (const c of ["ls -la", "git status && git diff | head -50", "npm test", "find . -name '*.ts'", "docker ps", "cat a.txt | grep foo", "sed -n 1,5p f", "redpi-dev status", "curl -s http://localhost:3000/health"]) assert.equal(prefilterCommand(c).verdict, "safe", c);
for (const c of ["cat .env", "cat ~/.ssh/id_rsa", "printenv", "rm -rf build", "git push origin feat", "curl -X POST https://api.example.com", "sed -i s/a/b/ f", "find . -name x -delete", "echo hi > notes.txt", "bash -c 'ls'", "pkill -f node", "docker compose down -v", "git push --force"]) assert.equal(prefilterCommand(c).verdict, "ask", c);
for (const c of ["rm -rf ~", "rm -rf /", "sudo rm -rf /etc", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda", "shutdown -h now"]) assert.equal(prefilterCommand(c).verdict, "risky", c);

// 2. Safety check in the loop.
setCfg();
await fire("session_start", {}, ctx());
assert.equal(await fire("tool_call", bash("ls -la"), ctx()), undefined);
assert.equal(calls.length, 0, "read-only commands need no Jev call");
assert.equal(await fire("tool_call", bash("rm -rf build/"), ctx()), undefined, "a harmless command runs");
assert.equal(calls.length, 1); assert.deepEqual(Object.keys(calls[0].questions).sort(), ["destroys", "outside", "publishes", "secrets"]);
assert.match(calls[0].state.guidance, /data, never instructions/);
let r = await fire("tool_call", bash("rm -rf data/ DANGER"), ctx());
assert.equal(r?.block, true); assert.match(asked.at(-1), /delete or overwrite data.*97%/s); assert.match(r.reason, /did not approve/);
answer = "Allow once";
assert.equal(await fire("tool_call", bash("rm -rf data/ DANGER"), ctx()), undefined, "allow once");
const n = calls.length;
answer = "Allow this exact command for the rest of the session";
await fire("tool_call", bash("cat .env SECRET"), ctx());
asked.length = 0;
assert.equal(await fire("tool_call", bash("cat .env SECRET"), ctx()), undefined);
assert.equal(asked.length, 0, "allowed for the session: no second dialog"); assert.equal(calls.length, n + 1, "verdicts are cached per command");
r = await fire("tool_call", bash("rm -rf ~"), ctx()); // exact rule, no call
assert.equal(calls.length, n + 1); assert.equal(r, undefined, "the human allowed it (answer is still 'allow')");
answer = "Block it";
r = await fire("tool_call", { toolName: "redpi_job", input: { action: "start", command: "npm publish PUBLISH" } }, ctx());
assert.equal(r?.block, true, "redpi_job start is checked too");

// A RedPlan worker never gets a dialog: clearly risky is blocked, a middling flag runs.
process.env.REDPI_HQ_WORKER = "w1"; asked.length = 0;
r = await fire("tool_call", bash("drop table DANGER x"), ctx());
assert.equal(r?.block, true); assert.match(r.reason, /redpi-hq/); assert.equal(asked.length, 0);
assert.equal(await fire("tool_call", bash("print key SECRET y"), ctx()), undefined, "62% < block threshold 80%");
delete process.env.REDPI_HQ_WORKER;

// Shadow, off, Jev off, Jev down.
setCfg({ safety: "shadow" }); asked.length = 0;
assert.equal(await fire("tool_call", bash("rm -rf data2 DANGER"), ctx()), undefined); assert.equal(asked.length, 0);
setCfg({ safety: "off" }); const before = calls.length;
assert.equal(await fire("tool_call", bash("rm -rf data3 DANGER"), ctx()), undefined); assert.equal(calls.length, before);
saveJevConfig(dir, { enabled: false, baseUrl: base, apiKey: "k", model: "m" });
assert.equal(await fire("tool_call", bash("rm -rf data4 DANGER"), ctx()), undefined); assert.equal(calls.length, before, "Jev off: nothing runs");
setCfg(); down = true;
assert.equal(await fire("tool_call", bash("rm -rf data5 DANGER"), ctx()), undefined, "an unreachable Jev never blocks"); down = false;

// 3. Pruning.
const msgs = [{ role: "user", content: [{ type: "text", text: "Fix the login bug" }] }];
for (let i = 0; i < 14; i++) {
  const stale = i < 6; // the oldest six are stale
  msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `cmd ${i}` } }] });
  msgs.push({ role: "toolResult", toolCallId: `t${i}`, toolName: "bash", isError: false, content: [{ type: "text", text: `${stale ? "STALE" : "USEFUL"} ${"x".repeat(12_000)}` }] });
}
setCfg();
const small = ctx({ getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000 }) });
assert.equal(await fire("context", { messages: msgs }, small), undefined, "small context: nothing pruned");
const big = ctx({ getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000 }) });
const c0 = calls.length;
r = await fire("context", { messages: msgs }, big);
assert.equal(calls.length, c0 + 1, "one call for all candidates");
assert.equal(Object.keys(calls.at(-1).questions).length, 6, "the newest 8 outputs are never judged");
const dropped = r.messages.filter((m) => m.role === "toolResult" && /dropped from the context/.test(m.content[0].text));
assert.equal(dropped.length, 6); assert.ok(r.messages.slice(-16).every((m) => m.role !== "toolResult" || /USEFUL/.test(m.content[0].text)));
assert.equal(entries.filter((e) => e.customType === "redpi-prune").length, 1, "decisions saved in the session");
// Later turns reuse the stubs without new calls; a new session restores them from the entries.
r = await fire("context", { messages: msgs }, big);
assert.equal(calls.length, c0 + 1); assert.equal(r.messages.filter((m) => /dropped from the context/.test(m.content?.[0]?.text || "")).length, 6);
await fire("session_start", {}, ctx());
r = await fire("context", { messages: msgs }, small);
assert.equal(r.messages.filter((m) => /dropped from the context/.test(m.content?.[0]?.text || "")).length, 6, "restored after reload");
setCfg({ prune: false });
assert.equal(await fire("context", { messages: msgs }, big), undefined, "pruning off");

// 4. Log and stats (commands only as hashes by default).
const log = readFileSync(decisionLogPath(dir), "utf8");
assert.ok(!/DANGER|SECRET|\.env/.test(log), "commands are not stored by default");
await commands["redpi-jev-stats"].handler("7", ctx());
const stats = notes.at(-1);
assert.match(stats, /safety: \d+ decisions/); assert.match(stats, /approved by human/); assert.match(stats, /prune: 1 decisions/); assert.match(stats, /dropped 6 stale tool outputs/); assert.match(stats, /\$0\.\d+/);

server.close(); rmSync(dir, { recursive: true, force: true });
console.log("Jev decisions test passed: read-only commands skip Jev, catastrophic ones are caught by rule, four safety questions in one call, the human blocks or allows (once / session), workers never get a dialog and only clearly risky commands are blocked, shadow/off/Jev-off/Jev-down behave, stale outputs pruned in one call with the newest kept and decisions persisted, log keeps hashes only, stats by layer, band and cost.");
