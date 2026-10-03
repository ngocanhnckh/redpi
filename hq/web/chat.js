// Chat: a Slack-like view of a run's conversations. Channels on the left (#team: messages to everyone;
// #agents: the team talking to each other; #hq-notes: HQ's notes and alerts), a direct message with the
// CEO and with each teammate, unread counts, messages grouped by sender with day dividers, and a composer
// with @mentions. Live updates patch the open conversation in place: your place and your draft are kept.
import { ago, api, esc, toast } from "/static/hq.js";
import { md } from "/static/md.js";

const GROUP_MS = 5 * 60_000;
const TAG = { aside: "btw", interrupt: "interrupt", decision: "plan decision", reply: "full answer", quick: "quick answer", ticket: "ticket", brief: "brief" };
const LONG = 900;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
const isHqNote = (m) => m.kind === "system" || m.sender === "hq";

export class Chat {
  // ctx: runId, avatar(name, id, size), presence(id) → {dot, label}, pendingText(id, name, msgs), onPerson(id), reload()
  constructor(root, ctx) {
    this.root = root; this.ctx = ctx;
    this.extra = new Map(); this.exhausted = false;
    this.drafts = new Map(); this.active = false; this.listSig = "";
    this.seenKey = `redpi-chat-seen-${ctx.runId}`;
    try { this.seen = JSON.parse(localStorage.getItem(this.seenKey) || "{}"); } catch { this.seen = {}; }
    try { this.conv = localStorage.getItem(`redpi-chat-conv-${ctx.runId}`) || "dm:ceo"; } catch { this.conv = "dm:ceo"; }
    root.innerHTML = `<div class="cx">
      <nav class="cx-side" aria-label="Conversations"></nav>
      <section class="cx-main">
        <header class="cx-head"></header>
        <div class="cx-list-wrap"><div class="cx-list" tabindex="0" aria-live="polite"></div><button class="cx-new" type="button" hidden></button></div>
        <div class="cx-foot"></div>
      </section>
    </div>`;
    this.side = root.querySelector(".cx-side");
    this.head = root.querySelector(".cx-head");
    this.list = root.querySelector(".cx-list");
    this.foot = root.querySelector(".cx-foot");
    this.newBtn = root.querySelector(".cx-new");
    this.side.addEventListener("click", (e) => { const b = e.target.closest("[data-conv]"); if (b) this.open(b.dataset.conv); });
    this.head.addEventListener("click", (e) => {
      if (e.target.closest(".cx-back")) { this.root.querySelector(".cx").classList.remove("in-conv"); return; }
      if (e.target.closest(".cx-full")) { this.toggleFull(); return; }
      const p = e.target.closest("[data-profile]"); if (p) this.ctx.onPerson(p.dataset.profile);
    });
    this.list.addEventListener("click", (e) => {
      const more = e.target.closest(".cx-more"); if (more) { more.closest(".cx-m").classList.add("open"); more.remove(); return; }
      if (e.target.closest(".cx-earlier")) { this.loadEarlier(); return; }
      const who = e.target.closest("[data-person]"); if (who) this.ctx.onPerson(who.dataset.person);
    });
    this.list.addEventListener("scroll", () => { if (this.atEnd()) { this.newBtn.hidden = true; this.markSeen(); } });
    this.newBtn.onclick = () => { this.list.scrollTop = this.list.scrollHeight; };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("chat-full") && !this.mentionOpen()) this.toggleFull(false); });
  }

  setActive(on) { this.active = on; if (!on) this.toggleFull(false); else this.markSeen(); }
  toggleFull(force) {
    const on = document.body.classList.toggle("chat-full", force);
    this.head.querySelector(".cx-full")?.setAttribute("aria-pressed", String(on));
  }

  messages() {
    const byId = new Map(this.extra);
    for (const m of this.state.messages || []) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  // The conversations: channels, then a direct message with the CEO and each teammate (people who left fold away).
  convs() {
    const s = this.state, w = s.workers || [];
    const dm = (id, name, role, past) => ({ key: `dm:${id}`, id, name, role, past, dm: true,
      filter: (m) => (m.sender === "human" && m.recipient === id && m.kind !== "system") || (m.sender === id && m.recipient === "human") });
    return [
      { key: "team", name: "team", about: "Messages to everyone. What you post here reaches the whole team.", to: "all",
        filter: (m) => m.recipient === "all" && m.kind !== "task" && !isHqNote(m) },
      { key: "agents", name: "agents", about: "The team talking to each other. Read-only: message someone directly to join in.", readOnly: true,
        filter: (m) => m.sender !== "human" && m.recipient !== "human" && m.recipient !== "all" && m.kind !== "task" && !isHqNote(m) },
      { key: "hq", name: "hq-notes", about: "HQ's notes: watch alerts, check-ins, reviews ready, and what it told the CEO. Read-only.", readOnly: true, muted: true,
        filter: (m) => isHqNote(m) && m.recipient !== "all" && !(m.sender !== "human" && m.sender !== "hq" && m.recipient === "human") },
      dm("ceo", "CEO", "lead Pi session", false),
      ...w.map((x) => dm(x.id, x.name, x.role, !x.alive && this.ctx.presence(x.id).dot !== "lost")),
    ];
  }

  open(key, { focus = true } = {}) {
    if (!this.convs().some((c) => c.key === key)) key = "dm:ceo";
    this.saveDraft();
    this.conv = key; this.listSig = ""; this.footKey = "";
    try { localStorage.setItem(`redpi-chat-conv-${this.ctx.runId}`, key); } catch {}
    this.root.querySelector(".cx").classList.add("in-conv");
    this.render(true);
    if (focus) this.foot.querySelector("textarea")?.focus({ preventScroll: true });
  }

  update(state) { this.state = state; this.render(false); }

  render(jump) {
    const all = this.messages(), convs = this.convs();
    let c = convs.find((x) => x.key === this.conv);
    if (!c) { this.conv = "dm:ceo"; c = convs.find((x) => x.key === this.conv); }
    // First sight of a conversation: everything in it counts as read (no wall of old unread).
    for (const x of convs) if (this.seen[x.key] == null) this.seen[x.key] = Math.max(0, ...all.filter(x.filter).map((m) => m.id));
    this.renderSide(convs, all);
    this.renderHead(c);
    this.renderList(c, all.filter(c.filter), jump);
    this.renderFoot(c);
  }

  unread(c, all) { return all.filter((m) => c.filter(m) && m.id > (this.seen[c.key] || 0) && m.sender !== "human").length; }

  renderSide(convs, all) {
    const item = (c) => {
      const n = c.key === this.conv && this.active ? 0 : this.unread(c, all);
      const pres = c.dm && c.id !== "ceo" ? this.ctx.presence(c.id) : c.dm ? this.ctx.presence("ceo") : null;
      const lead = c.dm ? `<span class="cx-face">${this.ctx.avatar(c.name, c.id, "sm")}<span class="dot ${pres.dot}"></span></span>` : `<span class="cx-hash">#</span>`;
      return `<button class="cx-item${c.key === this.conv ? " on" : ""}${n ? " unread" : ""}${c.past ? " past" : ""}" data-conv="${esc(c.key)}" aria-current="${c.key === this.conv}" title="${esc(c.dm ? `${c.name} · ${c.role}${pres ? ` · ${pres.label}` : ""}` : c.about)}">
        ${lead}<span class="cx-name">${esc(c.name)}</span>${n && !c.muted ? `<span class="cx-badge">${n}</span>` : ""}</button>`;
    };
    const chans = convs.filter((c) => !c.dm), dms = convs.filter((c) => c.dm && !c.past), past = convs.filter((c) => c.past);
    const html = `<div class="cx-run">${esc(this.state.run.title)}</div>
      <div class="cx-sec">Channels</div>${chans.map(item).join("")}
      <div class="cx-sec">Direct messages</div>${dms.map(item).join("")}
      ${past.length ? `<details class="cx-past"${this.pastOpen || past.some((c) => c.key === this.conv) ? " open" : ""}><summary>Left the team (${past.length})</summary>${past.map(item).join("")}</details>` : ""}`;
    if (html !== this.sideHtml) {
      this.side.innerHTML = html; this.sideHtml = html;
      this.side.querySelector(".cx-past")?.addEventListener("toggle", (e) => { this.pastOpen = e.target.open; });
    }
  }

  renderHead(c) {
    let html;
    if (c.dm) {
      const p = this.ctx.presence(c.id);
      html = `<button class="btn cx-back" type="button" aria-label="Back to conversations">←</button>
        <span class="cx-face lg">${this.ctx.avatar(c.name, c.id)}<span class="dot ${p.dot}"></span></span>
        <div class="cx-title"><b>${esc(c.name)}</b> <span class="faint">${esc(c.role)}</span><div class="cx-about">${esc(p.label)}</div></div>
        <button class="btn" type="button" data-profile="${esc(c.id)}">Profile</button>`;
    } else {
      html = `<button class="btn cx-back" type="button" aria-label="Back to conversations">←</button>
        <div class="cx-title"><b># ${esc(c.name)}</b><div class="cx-about">${esc(c.about)}</div></div>`;
    }
    html += `<button class="btn cx-full" type="button" aria-pressed="${document.body.classList.contains("chat-full")}" title="Full screen (Esc to leave)">⤢</button>`;
    if (html !== this.headHtml) { this.head.innerHTML = html; this.headHtml = html; }
  }

  renderList(c, msgs, jump) {
    const pending = c.dm ? this.ctx.pendingText(c.id, c.name, msgs) : "";
    const canEarlier = !this.exhausted && (this.state.messages || []).length >= 300;
    const sig = `${c.key}|${msgs.map((m) => m.id).join(",")}|${pending}|${canEarlier}`;
    const atEnd = this.atEnd();
    if (sig === this.listSig) { this.list.querySelectorAll("time[data-t]").forEach((t) => { t.title = ago(Number(t.dataset.t)); }); return; }
    const fromBottom = this.list.scrollHeight - this.list.scrollTop;
    const lastSeen = this.seen[c.key] || 0;
    const oldLast = this.lastId || 0;
    this.listSig = sig;
    let html = canEarlier ? `<button class="btn cx-earlier" type="button">Load earlier messages</button>` : "";
    if (!msgs.length) html += `<div class="cx-empty">${c.dm ? `This is the start of your conversation with ${esc(c.name)}. ${c.id === "ceo" ? "Ask for a status, give direction, or add work." : "Ask what they are doing, or give an instruction."}` : c.readOnly ? "Nothing here yet." : "Nothing posted to everyone yet."}</div>`;
    let prev = null, day = "", newLine = false;
    for (const m of msgs) {
      const d = dayLabel(m.created);
      if (d !== day) { html += `${prev ? "</div></div>" : ""}<div class="cx-day"><span>${esc(d)}</span></div>`; day = d; prev = null; }
      if (!newLine && jump && m.id > lastSeen && m.sender !== "human") {
        html += `${prev ? "</div></div>" : ""}<div class="cx-unread-line"><span>New</span></div>`; newLine = true; prev = null;
      }
      const from = m.kind === "system" && m.sender === "human" ? "hq" : m.sender;
      const fromName = from === "hq" ? "HQ" : m.senderName;
      const sameGroup = prev && prev.from === from && prev.to === m.recipient && m.created - prev.t < GROUP_MS;
      if (!sameGroup) {
        if (prev) html += "</div></div>";
        const to = c.key === "agents" || c.key === "hq" ? ` <span class="cx-to">→ ${from === "hq" || m.recipient === "human" || m.recipient === "all" ? esc(m.recipientName) : `<button class="linkish" data-person="${esc(m.recipient)}">${esc(m.recipientName)}</button>`}</span>` : "";
        const name = from === "human" || from === "hq" ? `<b>${esc(fromName)}</b>` : `<button class="linkish cx-from" data-person="${esc(from)}">${esc(fromName)}</button>`;
        html += `<div class="cx-g${from === "human" ? " me" : ""}">${this.ctx.avatar(fromName, from)}<div class="cx-gb"><div class="cx-gh">${name}${to}<time data-t="${m.created}" title="${esc(ago(m.created))}">${clock(m.created)}</time></div>`;
      }
      prev = { from, to: m.recipient, t: m.created };
      const tag = TAG[m.kind] || (m.kind === "system" ? "" : "");
      const long = m.body.length > LONG;
      html += `<div class="cx-m${long ? " long" : ""} k-${esc(m.kind)}" data-id="${m.id}">${sameGroup ? `<time class="cx-hover" data-t="${m.created}">${clock(m.created)}</time>` : ""}${tag ? `<span class="cx-tag t-${esc(m.kind)}">${esc(tag)}</span>` : ""}<div class="md">${md(m.body.length > 20000 ? m.body.slice(0, 20000) + "…" : m.body)}</div>${long ? `<button class="linkish cx-more" type="button">Show more</button>` : ""}</div>`;
    }
    if (prev) html += "</div></div>";
    if (pending) html += `<div class="cx-pending"><span class="cx-typing" aria-hidden="true"><i></i><i></i><i></i></span>${esc(pending)}</div>`;
    const opened = new Set([...this.list.querySelectorAll(".cx-m.open")].map((el) => el.dataset.id));
    this.list.innerHTML = html;
    opened.forEach((id) => this.list.querySelector(`.cx-m[data-id="${id}"]`)?.classList.add("open"));
    this.list.querySelectorAll(".cx-m.open .cx-more").forEach((b) => b.remove());
    const last = msgs.at(-1)?.id || 0;
    if (jump) {
      const line = this.list.querySelector(".cx-unread-line");
      this.list.scrollTop = line ? line.offsetTop - 60 : this.list.scrollHeight;
    } else if (this.prepending) this.list.scrollTop = this.list.scrollHeight - fromBottom;
    else if (atEnd) this.list.scrollTop = this.list.scrollHeight;
    else if (last > oldLast && msgs.some((m) => m.id > oldLast && m.sender !== "human")) {
      const n = msgs.filter((m) => m.id > lastSeen && m.sender !== "human").length;
      this.newBtn.hidden = !n; this.newBtn.textContent = `↓ ${n} new`;
    }
    this.prepending = false;
    this.lastId = last;
    this.markSeen();
  }

  renderFoot(c) {
    const key = `${c.key}|${c.readOnly ? 1 : 0}`;
    if (key === this.footKey) return;
    this.footKey = key;
    if (c.readOnly) { this.foot.innerHTML = `<div class="cx-ro faint">${esc(c.about)}</div>`; return; }
    const name = c.dm ? c.name : "#team";
    this.foot.innerHTML = `<div class="cx-compose">
        <div class="cx-mention" role="listbox" hidden></div>
        <textarea rows="1" placeholder="Message ${esc(name)}${c.dm ? "" : " (everyone)"}" aria-label="Message ${esc(name)}"></textarea>
        <div class="cx-acts"><span class="faint cx-hint">Enter sends · Shift+Enter new line · @ to mention</span>
          ${c.dm && c.id !== "ceo" ? `<button class="btn" type="button" data-send="aside" title="${esc(c.name)} answers from a copy of their session without stopping their work">Ask on the side</button>` : ""}
          ${c.dm ? `<button class="btn danger" type="button" data-send="interrupt" title="Stops what ${esc(c.name)} is doing now, then delivers your message">Interrupt + send</button>` : ""}
          <button class="btn primary" type="button" data-send="command">Send</button></div>
      </div>`;
    const ta = this.foot.querySelector("textarea");
    ta.value = this.drafts.get(c.key) || "";
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(220, ta.scrollHeight)}px`; };
    grow();
    ta.addEventListener("input", () => { this.drafts.set(this.conv, ta.value); grow(); this.mention(ta); });
    ta.addEventListener("keydown", (e) => {
      if (this.mentionOpen() && this.mentionKey(e, ta)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send("command"); }
    });
    ta.addEventListener("blur", () => setTimeout(() => this.closeMention(), 150));
    this.foot.querySelector(".cx-acts").addEventListener("click", (e) => { const b = e.target.closest("[data-send]"); if (b) this.send(b.dataset.send); });
    this.foot.querySelector(".cx-mention").addEventListener("mousedown", (e) => { const o = e.target.closest("[data-name]"); if (o) { e.preventDefault(); this.pickMention(ta, o.dataset.name); } });
  }

  async send(kind) {
    const c = this.convs().find((x) => x.key === this.conv);
    const ta = this.foot.querySelector("textarea");
    if (!c || c.readOnly || !ta) return;
    const body = ta.value.trim() || (kind === "interrupt" ? "Stop what you are doing and wait for instructions." : "");
    if (!body) return;
    try {
      await api("POST", `/api/runs/${this.ctx.runId}/messages`, { from: "human", to: c.dm ? c.id : "all", kind, body });
      ta.value = ""; ta.style.height = "auto"; this.drafts.delete(c.key);
      this.list.scrollTop = this.list.scrollHeight;
      this.ctx.reload();
    } catch (e) { toast(e.message); }
  }

  saveDraft() { const ta = this.foot.querySelector("textarea"); if (ta) this.drafts.set(this.conv, ta.value); }

  // @mentions: type @ and pick a teammate.
  mentionOpen() { const m = this.foot.querySelector(".cx-mention"); return m && !m.hidden; }
  closeMention() { const m = this.foot.querySelector(".cx-mention"); if (m) m.hidden = true; }
  mention(ta) {
    const box = this.foot.querySelector(".cx-mention");
    const q = ta.value.slice(0, ta.selectionStart).match(/(?:^|\s)@([\w-]*)$/);
    if (!q) { box.hidden = true; return; }
    const names = ["CEO", ...(this.state.workers || []).filter((w) => w.alive).map((w) => w.name)].filter((n) => n.toLowerCase().startsWith(q[1].toLowerCase()));
    if (!names.length) { box.hidden = true; return; }
    this.mentionIdx = 0;
    box.innerHTML = names.slice(0, 8).map((n, i) => `<div class="cx-opt${i ? "" : " on"}" role="option" data-name="${esc(n)}">${this.ctx.avatar(n, n === "CEO" ? "ceo" : (this.state.workers.find((w) => w.name === n)?.id || ""), "sm")}<span>${esc(n)}</span></div>`).join("");
    box.hidden = false;
  }
  mentionKey(e, ta) {
    const opts = [...this.foot.querySelectorAll(".cx-opt")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.mentionIdx = (this.mentionIdx + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      opts.forEach((o, i) => o.classList.toggle("on", i === this.mentionIdx));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this.pickMention(ta, opts[this.mentionIdx].dataset.name); return true; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.closeMention(); return true; }
    return false;
  }
  pickMention(ta, name) {
    const before = ta.value.slice(0, ta.selectionStart).replace(/@([\w-]*)$/, `@${name} `);
    ta.value = before + ta.value.slice(ta.selectionStart);
    ta.setSelectionRange(before.length, before.length);
    this.drafts.set(this.conv, ta.value);
    this.closeMention();
    ta.focus();
  }

  atEnd() { return this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 40; }
  markSeen() {
    if (!this.active || !this.state || document.visibilityState !== "visible" || !this.atEnd()) return;
    const c = this.convs().find((x) => x.key === this.conv);
    if (!c) return;
    const max = Math.max(0, ...this.messages().filter(c.filter).map((m) => m.id));
    if (max > (this.seen[c.key] || 0)) {
      this.seen[c.key] = max;
      try { localStorage.setItem(this.seenKey, JSON.stringify(this.seen)); } catch {}
      this.renderSide(this.convs(), this.messages());
    }
    this.ctx.onUnread?.();
  }

  async loadEarlier() {
    const min = Math.min(...this.messages().map((m) => m.id));
    try {
      const older = await api("GET", `/api/runs/${this.ctx.runId}/messages?before=${min}&limit=300`);
      older.forEach((m) => this.extra.set(m.id, m));
      if (older.length < 300) this.exhausted = true;
      this.prepending = true;
      this.render(false);
    } catch (e) { toast(e.message); }
  }

  // Unread messages across every conversation (for the tab's badge).
  unreadTotal() {
    if (!this.state) return 0;
    const all = this.messages();
    return this.convs().filter((c) => !c.muted && !c.readOnly && !(c.key === this.conv && this.active)).reduce((n, c) => n + this.unread(c, all), 0);
  }
}
