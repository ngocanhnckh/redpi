// Plan review annotations: highlight text or pin a comment bubble on a diagram.
// Text comments are re-found by their quote (whitespace-insensitive) inside the element they
// were made in ([data-anchor]); diagram pins are stored as fractions of the diagram's size, so
// both survive re-renders and new screen sizes.
import { esc } from "/static/hq.js";

const WS = /\s/;

// Text of `root` with runs of whitespace collapsed to one space, mapped back to DOM positions.
function textIndex(root) {
  const chars = [], map = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("svg, .anno-badge, .pin, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let space = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (let i = 0; i < n.data.length; i++) {
      const c = n.data[i];
      if (WS.test(c)) { if (!space) { chars.push(" "); map.push([n, i]); } space = true; }
      else { chars.push(c); map.push([n, i]); space = false; }
    }
  }
  return { text: chars.join(""), map };
}

export const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Find `quote` inside `root` (preferring the occurrence after `prefix`) and wrap it in <mark>s.
export function highlight(root, quote, prefix, attrs) {
  const q = normalize(quote);
  if (!q) return [];
  const { text, map } = textIndex(root);
  let at = -1, best = -1;
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
    if (best < 0) best = i;
    if (prefix && text.slice(Math.max(0, i - prefix.length - 1), i).trimEnd().endsWith(normalize(prefix))) { at = i; break; }
  }
  if (at < 0) at = best;
  if (at < 0) return [];
  const [sn, so] = map[at], [en, eo] = map[at + q.length - 1];
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo + 1);
  return wrapRange(range, attrs);
}

function wrapRange(range, attrs) {
  const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
  const segs = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n) || n.parentElement?.closest("svg")) continue;
    const start = n === range.startContainer ? range.startOffset : 0;
    const end = n === range.endContainer ? range.endOffset : n.data.length;
    if (end > start && n.data.slice(start, end).trim()) segs.push([n, start, end]);
  }
  return segs.map(([n, start, end]) => {
    let t = n;
    if (start > 0) t = t.splitText(start);
    if (end - start < t.data.length) t.splitText(end - start);
    const mark = document.createElement("mark");
    for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v);
    t.parentNode.insertBefore(mark, t);
    mark.appendChild(t);
    return mark;
  });
}

// What the reader selected, where it is, and the text just before it (to tell repeats apart).
export function readSelection(scope) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const quote = sel.toString();
  if (!normalize(quote)) return null;
  const node = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
  if (!node || !scope.contains(node) || node.closest("svg, .no-annotate, .composer-pop")) return null;
  const el = node.closest("[data-anchor]");
  if (!el) return null;
  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return { el, quote: quote.slice(0, 1000), prefix: normalize(before.toString()).slice(-40), rect: range.getBoundingClientRect() };
}

// The diagram element under a click, or the nearest one, to say in words where a pin points.
export function pinTarget(svg, event) {
  const hit = event.target.closest?.("[data-anchor]");
  if (hit && svg.contains(hit)) return { target: hit.dataset.anchor, label: hit.dataset.label || hit.dataset.anchor, near: false };
  let best = null, dist = Infinity;
  for (const el of svg.querySelectorAll("[data-anchor]")) {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - event.clientX, r.top + r.height / 2 - event.clientY);
    if (d < dist) { dist = d; best = el; }
  }
  return best ? { target: best.dataset.anchor, label: best.dataset.label || best.dataset.anchor, near: true } : { target: "", label: "", near: true };
}

// One floating editor at a time: new comment or edit. Resolves with the text, or null on cancel.
let open = null;
export const composerOpen = () => !!open;

export function compose({ rect, where, quote, value = "", readOnly = false, onDelete }) {
  closeComposer();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "composer-pop panel";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Comment");
    pop.innerHTML = `
      <div class="cp-where">${esc(where)}</div>
      ${quote ? `<blockquote class="cp-quote">${esc(normalize(quote).slice(0, 280))}</blockquote>` : ""}
      ${readOnly ? `<div class="cp-body">${esc(value)}</div>` : `<textarea class="cp-text" rows="3" placeholder="Your comment for the CEO…" aria-label="Comment">${esc(value)}</textarea>`}
      <div class="cp-row">
        ${onDelete && !readOnly ? `<button class="btn danger" data-act="delete" type="button">Delete</button>` : ""}
        <span style="flex:1"></span>
        <button class="btn" data-act="cancel" type="button">${readOnly ? "Close" : "Cancel"}</button>
        ${readOnly ? "" : `<button class="btn primary" data-act="save" type="button">${value ? "Save" : "Add comment"}</button>`}
      </div>
      ${readOnly ? "" : `<div class="faint cp-hint">Ctrl+Enter to save · Esc to cancel</div>`}`;
    document.body.appendChild(pop);
    // Next to what was commented on, kept on screen (a bottom sheet on phones, via CSS).
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const r = rect || { left: innerWidth / 2 - w / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3 };
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
    pop.style.top = `${r.bottom + 8 + h < innerHeight ? r.bottom + 8 : Math.max(8, r.top - h - 8)}px`;
    const text = pop.querySelector(".cp-text");
    const done = (v) => closeComposer(v);
    open = { pop, resolve };
    pop.querySelector("[data-act=cancel]").onclick = () => done(null);
    pop.querySelector("[data-act=save]")?.addEventListener("click", () => { const v = text.value.trim(); if (v) done(v); else text.focus(); });
    pop.querySelector("[data-act=delete]")?.addEventListener("click", () => { closeComposer(null); onDelete(); });
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text) { e.preventDefault(); const v = text.value.trim(); if (v) done(v); }
    });
    (text || pop.querySelector("[data-act=cancel]")).focus();
    if (text) text.setSelectionRange(text.value.length, text.value.length);
  });
}

export function closeComposer(result = null) {
  if (!open) return;
  const o = open;
  open = null;
  o.pop.remove();
  o.resolve(result);
  closeHooks.forEach((f) => f());
}
const closeHooks = new Set();
export const onComposerClose = (f) => closeHooks.add(f);
