// Markdown for agents' messages and updates (original RedPi code). Safe by construction: the text
// is HTML-escaped first and only a fixed set of tags is produced; links must be http(s), mailto,
// or site-relative. Supports headings, bold/italic/strike, inline and fenced code, lists (nested
// by indentation, task boxes), quotes, tables, rules, and bare URLs.
import { esc } from "/static/hq.js";

const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/))/i;

function inline(s) {
  // s is already escaped. Code spans first, kept out of every other rule.
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => hold(`<code>${code.trim()}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, "&");
    return SAFE_URL.test(raw) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_m, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[i]);
}

const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => inline(c.trim()));

/** Markdown text → safe HTML. */
export function md(text) {
  const lines = esc(String(text ?? "")).replace(/\r\n?/g, "\n").split("\n");
  let out = "", para = [], i = 0;
  const flush = () => { if (para.length) { out += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code (an unclosed fence runs to the end).
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out += `<pre><code${fence[2] ? ` data-lang="${fence[2]}"` : ""}>${body.join("\n")}</code></pre>`;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out += `<div class="md-h md-h${h[1].length}">${inline(h[2])}</div>`; i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out += "<hr>"; i++; continue; }
    if (/^\s{0,3}&gt;/.test(line)) {
      flush();
      const q = [];
      for (; i < lines.length && /^\s{0,3}&gt;/.test(lines[i]); i++) q.push(lines[i].replace(/^\s{0,3}&gt;\s?/, ""));
      out += `<blockquote>${md(q.join("\n").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"))}</blockquote>`;
      continue;
    }
    // Table: a header row, a |---| separator, then rows.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      let rows = "";
      for (; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      out += `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }
    // Lists, nested by indentation.
    if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(line)) {
      flush();
      const stack = [];
      const open = (indent, ordered, start) => { stack.push({ indent, ordered }); out += ordered ? `<ol${start > 1 ? ` start="${start}"` : ""}>` : "<ul>"; };
      const close = () => { const l = stack.pop(); out += `</li>${l.ordered ? "</ol>" : "</ul>"}`; };
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|(\d{1,3})[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // A wrapped line belongs to the item above; a blank line or other block ends the list.
          if (lines[i].trim() && /^\s+\S/.test(lines[i]) && stack.length) { out += `<br>${inline(lines[i].trim())}`; continue; }
          break;
        }
        const indent = m[1].length, ordered = !!m[3];
        while (stack.length && indent < stack.at(-1).indent) close();
        if (!stack.length || indent > stack.at(-1).indent) open(indent, ordered, Number(m[3] || 1));
        else if (stack.at(-1).ordered !== ordered) { close(); open(indent, ordered, Number(m[3] || 1)); }
        else out += "</li>";
        const box = /^\[([ xX])\]\s+(.*)$/.exec(m[4]);
        out += box ? `<li class="task-item"><span class="md-box${box[1] === " " ? "" : " on"}" aria-hidden="true"></span>${inline(box[2])}` : `<li>${inline(m[4])}`;
      }
      while (stack.length) close();
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

/** Plain one-line text from markdown (for titles, tooltips, and short previews). */
export function plain(text) {
  return String(text ?? "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "").replace(/(\*\*|__|~~)/g, "").replace(/\s+/g, " ").trim();
}
