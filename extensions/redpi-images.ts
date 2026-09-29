/**
 * RedPi images: keep every model request within image size limits (original RedPi code).
 *
 * Pi shrinks each image it reads, but screenshots pile up in a conversation until one request is
 * larger than the provider accepts, and from then on every request fails because the images are
 * still in context. Before each model call this extension (1) recompresses any image over the
 * per-image budget and (2) keeps only the newest images within a count and total-size budget,
 * replacing older ones with a note. Only the request changes; the saved session keeps the originals.
 * redpi_image_compress also writes a smaller copy of an image file on request.
 */
import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
// Anthropic recommends at most ~1568 px on the long side; a few hundred KB each keeps requests small.
// Some gateways refuse request bodies over ~4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE), so the whole
// request (text and images) is kept under REDPI_REQUEST_MAX_MB.
export const LIMITS = {
  maxPx: num(process.env.REDPI_IMAGE_MAX_PX, 1568),
  maxBytes: num(process.env.REDPI_IMAGE_MAX_KB, 700) * 1024,    // per image, encoded (base64)
  maxCount: num(process.env.REDPI_IMAGE_MAX_COUNT, 8),          // newest images kept per request
  totalBytes: num(process.env.REDPI_IMAGE_TOTAL_MB, 3) * 1024 * 1024,
  requestBytes: num(process.env.REDPI_REQUEST_MAX_MB, 4) * 1024 * 1024,
};
const OMITTED = "[An earlier image was left out of this request to keep it within the model's size limit. Read the file again if you still need to see it.]";

type Img = { type: "image"; data: string; mimeType: string };
const isImg = (c: any): c is Img => c && c.type === "image" && typeof c.data === "string";
const cache = new Map<string, Img | null>();
const keyOf = (i: Img) => createHash("sha1").update(i.data.length + ":" + i.data.slice(0, 4096) + i.data.slice(-4096)).digest("hex");

/** A copy of the image within the per-image budget (cached), or null if it cannot be made small enough. */
async function fit(i: Img): Promise<Img | null> {
  if (i.data.length <= LIMITS.maxBytes && !/svg/i.test(i.mimeType)) return i;
  const k = keyOf(i);
  if (cache.has(k)) return cache.get(k)!;
  let out: Img | null = null;
  try {
    const r = await resizeImage(Buffer.from(i.data, "base64"), i.mimeType, { maxWidth: LIMITS.maxPx, maxHeight: LIMITS.maxPx, maxBytes: LIMITS.maxBytes, jpegQuality: 80 });
    if (r && r.data.length <= LIMITS.maxBytes) out = { type: "image", data: r.data, mimeType: r.mimeType };
  } catch {}
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(k, out);
  return out;
}

/** The messages for one request, with images recompressed and the oldest dropped past the budget. */
export async function guardImages(messages: any[]): Promise<{ messages: any[]; changed: boolean; kept: number; dropped: number; shrunk: number }> {
  // Walk newest first so the budget keeps the latest images.
  const slots: { mi: number; ci: number }[] = [];
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const c = messages[mi]?.content;
    if (!Array.isArray(c)) continue;
    for (let ci = c.length - 1; ci >= 0; ci--) if (isImg(c[ci])) slots.push({ mi, ci });
  }
  if (!slots.length) return { messages, changed: false, kept: 0, dropped: 0, shrunk: 0 };
  // What the rest of the request takes (text, tool calls), so images get only what is left.
  let textBytes = 0;
  try { textBytes = JSON.stringify(messages, (k, v) => (k === "data" && typeof v === "string" && v.length > 1000 ? "" : v)).length; } catch {}
  const budget = Math.max(0, Math.min(LIMITS.totalBytes, LIMITS.requestBytes - textBytes - 64 * 1024));
  const replace = new Map<string, any>();
  let total = 0, kept = 0, dropped = 0, shrunk = 0;
  // The newest images that can be kept are compressed in parallel (Pi's resizer runs in workers).
  const fitted = await Promise.all(slots.slice(0, LIMITS.maxCount).map((s) => fit(messages[s.mi].content[s.ci] as Img)));
  for (const [i, s] of slots.entries()) {
    const orig = messages[s.mi].content[s.ci] as Img;
    const small = i < fitted.length ? fitted[i] : null;
    if (small && total + small.data.length <= budget) {
      total += small.data.length; kept++;
      if (small !== orig) { replace.set(`${s.mi}:${s.ci}`, small); shrunk++; }
    } else { replace.set(`${s.mi}:${s.ci}`, { type: "text", text: OMITTED }); dropped++; }
  }
  if (!replace.size) return { messages, changed: false, kept, dropped, shrunk };
  // Copy only the messages that change; the session's own messages are never mutated.
  const out = messages.map((m, mi) => {
    if (!Array.isArray(m?.content) || !m.content.some((_: any, ci: number) => replace.has(`${mi}:${ci}`))) return m;
    return { ...m, content: m.content.map((c: any, ci: number) => replace.get(`${mi}:${ci}`) ?? c) };
  });
  return { messages: out, changed: true, kept, dropped, shrunk };
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export default function (pi: ExtensionAPI) {
  if (process.env.REDPI_IMAGES === "0") return;
  let lastNote = "";

  pi.on("context", async (event: any, ctx: any) => {
    const r = await guardImages(event.messages || []);
    if (!r.changed) return undefined;
    const note = `${r.shrunk ? `${r.shrunk} image${r.shrunk === 1 ? "" : "s"} compressed` : ""}${r.shrunk && r.dropped ? ", " : ""}${r.dropped ? `${r.dropped} older image${r.dropped === 1 ? "" : "s"} left out` : ""} to fit the model's request limit`;
    if (note !== lastNote) { lastNote = note; ctx?.ui?.setStatus?.("redpi-images", `🖼 ${note}`); }
    return { messages: r.messages };
  });

  pi.registerTool({
    name: "redpi_image_compress", label: "Compress image",
    description: `Write a smaller copy of an image file (resized to at most ${LIMITS.maxPx}px on each side and ${Math.round(LIMITS.maxBytes / 1024)} KB by default, as PNG or JPEG, whichever is smaller). Use it before attaching or sharing a large screenshot or photo, or when an image is too big to read. Images you read are already kept within the model's limits automatically.`,
    promptSnippet: "Compress a large image file to a model-friendly size",
    parameters: Type.Object({
      path: Type.String({ description: "Image file (png, jpg, webp, gif)" }),
      maxPx: Type.Optional(Type.Number({ description: `Longest side in pixels (default ${LIMITS.maxPx})` })),
      maxKB: Type.Optional(Type.Number({ description: `Target size in KB (default ${Math.round(LIMITS.maxBytes / 1024)})` })),
      output: Type.Optional(Type.String({ description: "Where to write it (default: next to the original, with .small before the extension)" })),
    }),
    async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
      const src = isAbsolute(p.path) ? p.path : resolve(ctx.cwd, p.path);
      const mime = MIME[extname(src).toLowerCase()];
      if (!mime) throw new Error(`${p.path} is not a png, jpg, webp or gif image`);
      const before = statSync(src).size;
      const maxBytes = Math.round((p.maxKB > 0 ? p.maxKB : LIMITS.maxBytes / 1024) * 1024 * 4 / 3);   // base64 budget for that many raw bytes
      const r = await resizeImage(readFileSync(src), mime, { maxWidth: p.maxPx > 0 ? p.maxPx : LIMITS.maxPx, maxHeight: p.maxPx > 0 ? p.maxPx : LIMITS.maxPx, maxBytes, jpegQuality: 80 });
      if (!r) throw new Error("could not compress that image (unreadable, or it cannot get that small)");
      const out = p.output ? (isAbsolute(p.output) ? p.output : resolve(ctx.cwd, p.output)) : join(dirname(src), `${basename(src, extname(src))}.small${EXT[r.mimeType] || ".png"}`);
      const bytes = Buffer.from(r.data, "base64");
      writeFileSync(out, bytes);
      return { content: [{ type: "text", text: `Wrote ${out}: ${r.width}×${r.height} ${r.mimeType}, ${Math.round(bytes.length / 1024)} KB (was ${r.originalWidth}×${r.originalHeight}, ${Math.round(before / 1024)} KB).` }], details: { path: out, bytes: bytes.length, width: r.width, height: r.height } };
    },
  } as any);
}
