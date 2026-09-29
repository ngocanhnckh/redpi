// Image guard: large images in a conversation are recompressed before each model request, the
// oldest are left out past the count and size budget, the session's own messages are never changed,
// and redpi_image_compress writes a smaller copy. Uses Pi's own image resizer.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

const dir = mkdtempSync(join(tmpdir(), "redpi-images-test-"));
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); rmSync(dir, { recursive: true, force: true }); process.exit(1); };

// A noisy RGB PNG (noise barely compresses, so it is big like a real photo or busy screenshot).
function png(w, h, seed) {
  const chunk = (t, d) => { const b = Buffer.alloc(8 + d.length + 4); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(t), d])) >>> 0, 8 + d.length); return b; };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i++) { if (i % (w * 3 + 1) === 0) { raw[i] = 0; continue; } x ^= x << 13; x ^= x >>> 17; x ^= x << 5; raw[i] = x & 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

const handlers = {}, tools = {};
const status = [];
const pi = { on: (e, f) => { handlers[e] = f; }, registerTool: (d) => { tools[d.name] = d; } };
const mod = await import("../extensions/redpi-images.ts");
mod.default(pi);
if (!handlers.context || !tools.redpi_image_compress) fail("context hook and redpi_image_compress should be registered");
const { LIMITS } = mod;
const ctx = { cwd: dir, ui: { setStatus: (k, v) => status.push(v) } };

// 1. Twelve big screenshots across tool results and a user message: every kept image is within the
// per-image budget, at most 8 are kept (the newest), the rest become a note, and the total fits.
const big = png(2400, 1600, 1).toString("base64");
if (big.length < 5 * 1024 * 1024) fail("test image should be large", big.length);
const messages = [{ role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", data: big, mimeType: "image/png" }] }];
for (let i = 0; i < 11; i++) messages.push({ role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: `Read image ${i}` }, { type: "image", data: png(2400, 1600, i + 2).toString("base64"), mimeType: "image/png" }] });
messages.push({ role: "user", content: "what do you see?" });
const snapshot = JSON.stringify(messages).length;
const t0 = Date.now();
const r = await handlers.context({ type: "context", messages }, ctx);
const took = Date.now() - t0;
const out = r?.messages;
if (!out || out.length !== messages.length) fail("context hook should return the same messages, adjusted", r);
const imgs = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "image"));
const notes = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "text" && /left out of this request/.test(c.text)));
const total = imgs.reduce((n, i) => n + i.data.length, 0);
if (imgs.length < 2 || imgs.length > LIMITS.maxCount || imgs.length + notes.length !== 12) fail("should keep the newest images within budget and leave out the rest", { imgs: imgs.length, notes: notes.length });
const requestSize = JSON.stringify(out).length;
if (requestSize > LIMITS.requestBytes) fail("the whole request should fit under the request limit", requestSize);
if (imgs.some((i) => i.data.length > LIMITS.maxBytes) || total > LIMITS.totalBytes) fail("images over budget", imgs.map((i) => i.data.length));
if (!Array.isArray(out[0].content) || out[0].content[1].type !== "text" || out.at(-2).content[1].type !== "image") fail("the oldest image should go and the newest stay");
if (JSON.stringify(messages).length !== snapshot || messages[0].content[1].data !== big) fail("the session's own messages must not be changed");
if (!status.some((s) => /compressed/.test(s) && /left out/.test(s))) fail("status should say what happened", status);
// 2. Same request again: cached, fast.
const t1 = Date.now();
await handlers.context({ type: "context", messages }, ctx);
if (Date.now() - t1 > Math.max(500, took / 4)) fail("repeat requests should reuse the compressed images", { first: took, again: Date.now() - t1 });
// 2b. A long text history leaves less room: images are cut further so the whole request still fits.
const longText = [{ role: "user", content: "x".repeat(3.5 * 1024 * 1024) }, ...messages];
const r2 = await handlers.context({ type: "context", messages: longText }, ctx);
if (JSON.stringify(r2.messages).length > LIMITS.requestBytes) fail("text plus images should stay under the request limit", JSON.stringify(r2.messages).length);
// 3. Small images and text-only requests pass through untouched.
const small = png(200, 100, 3).toString("base64");
const plain = [{ role: "user", content: [{ type: "image", data: small, mimeType: "image/png" }] }, { role: "user", content: "hi" }];
if (await handlers.context({ type: "context", messages: plain }, ctx)) fail("small images should pass through unchanged");

// 4. redpi_image_compress writes a smaller copy.
writeFileSync(join(dir, "shot.png"), png(3000, 2000, 9));
const res = await tools.redpi_image_compress.execute("x", { path: "shot.png", maxKB: 400 }, undefined, undefined, ctx);
const d = res.details;
if (!/Wrote .*shot\.small\.(png|jpg)/.test(res.content[0].text) || d.bytes > 400 * 1024 || Math.max(d.width, d.height) > LIMITS.maxPx || statSync(d.path).size !== d.bytes) fail("compress tool", res.content[0].text);
if (readFileSync(join(dir, "shot.png")).length < 10 * 1024 * 1024) fail("the original should be left as it was");
let err = "";
try { await tools.redpi_image_compress.execute("x", { path: "notes.txt" }, undefined, undefined, ctx); } catch (e) { err = e.message; }
if (!/not a png/.test(err)) fail("non-images should be refused", err);

rmSync(dir, { recursive: true, force: true });
console.log(`RedPi images test passed: big images recompressed before each request (${(took / 1000).toFixed(1)}s for 12, cached after), only the newest kept (${imgs.length} of 12 here) so the whole request stays under ${LIMITS.requestBytes / 1024 / 1024} MB, the session untouched, small images passed through, redpi_image_compress writes a smaller copy.`);
