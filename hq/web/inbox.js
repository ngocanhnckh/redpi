// The human's inbox: everything that waits on you (a blocker, a question, a yes/no, a plan to approve, an
// alert the CEO did not fix) as tickets with a status and a thread. Used on /inbox (every project) and as
// the Inbox tab of a run. Live updates re-render the list and the open ticket in place; what you are
// typing (per ticket) is never lost.
import { ago, api, esc, toast } from "/static/hq.js";
import { md } from "/static/md.js";
import { portraitUrl } from "/static/office/people.js";

const KIND = { question: ["Question", "cyan"], approval: ["Approval", "violet"], blocker: ["Blocker", "red"], alert: ["Alert", "amber"] };
const CLOSED = ["approved", "declined", "resolved"];
const FILTERS = [["open", "Waiting on you"], ["waiting", "Waiting on the team"], ["closed", "Closed"], ["all", "All"]];

export function statusOf(it) {
  if (it.status === "open") return ["Waiting on you", "red"];
  if (it.status === "waiting") return [`Waiting on ${it.targetName}`, "amber"];
  if (it.status === "approved") return ["Approved", "green"];
  if (it.status === "declined") return ["Declined", ""];
  return ["Resolved", ""];
}

function face(id, name, roleOf) {
  if (id === "human") return `<span class="avatar you sm" aria-hidden="true">You</span>`;
  if (id === "hq") return `<span class="avatar you hq sm" aria-hidden="true">HQ</span>`;
  return `<img class="avatar sm" alt="" src="${portraitUrl(name, roleOf?.(id) || (id === "ceo" ? "ceo" : ""))}">`;
}

// The buttons a ticket offers, primary first. Closed tickets can be reopened or commented on (which reopens them).
function actionsFor(it) {
  if (CLOSED.includes(it.status)) return [["comment", "Comment and reopen", "primary"], ["reopen", "Reopen", ""]];
  const plan = String(it.key || "").startsWith("plan:");
  switch (it.kind) {
    case "approval": return [["approve", "Approve", "primary"], ["decline", plan ? "Request changes" : "Decline", "danger"], ...(plan ? [] : [["comment", "Comment", ""]])];
    case "blocker": return [["unblock", "Unblock", "primary"], ["comment", "Reply", ""], ["resolve", "Close", ""]];
    case "alert": return [["comment", `Tell ${it.targetName}`, "primary"], ["resolve", "Close", ""]];
    default: return [["comment", "Reply", "primary"], ["resolve", "Close", ""]];
  }
}
function placeholder(it) {
  if (CLOSED.includes(it.status)) return "Add a comment (it reopens the ticket and goes to the team)";
  if (it.kind === "blocker") return `Your answer: Unblock sends it to ${it.targetName} and puts ${it.task?.id || "the task"} back to work; Reply only answers`;
  if (it.kind === "approval") return String(it.key || "").startsWith("plan:") ? "Optional for Approve; for Request changes, say what should change" : "Optional: a condition or a reason";
  if (it.kind === "alert") return `What should ${it.targetName} do?`;
  return `Your answer to ${it.askedByName}`;
}

export class Inbox {
  // opts: showRun (list every project's tickets with their run), roleOf(id), onChanged() after an action.
  constructor(root, opts = {}) {
    this.root = root; this.opts = opts; this.items = [];
    this.filter = "open"; this.selected = null; this.drafts = new Map(); this.sig = "";
    root.innerHTML = `<div class="ib">
      <div class="ib-side">
        <div class="viewtabs ib-tabs" role="tablist" aria-label="Which tickets">${FILTERS.map(([k, l]) => `<button role="tab" data-ibf="${k}">${l} <span class="faint" data-ibn="${k}"></span></button>`).join("")}</div>
        <div class="ib-list" role="list"></div>
      </div>
      <section class="ib-detail" aria-label="Ticket"></section>
    </div>`;
    this.list = root.querySelector(".ib-list");
    this.detail = root.querySelector(".ib-detail");
    root.querySelector(".ib-tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ibf]");
      if (b) { this.filter = b.dataset.ibf; this.paint(); }
    });
    this.list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-ib]");
      if (row) this.select(Number(row.dataset.ib));
    });
  }

  update(items) {
    this.items = items || [];
    // A ticket opened from elsewhere (Needs you, a link) is shown whatever the filter.
    if (this.selected && !this.items.some((i) => i.id === this.selected)) this.selected = null;
    if (!this.selected && this.filter === "open" && !this.items.some((i) => i.status === "open") && this.items.some((i) => i.status === "waiting")) this.filter = "waiting";
    this.paint();
  }

  select(id, { reveal = false } = {}) {
    this.selected = id;
    const it = this.items.find((i) => i.id === id);
    if (reveal && it && !this.matches(it)) this.filter = "all";
    this.paint();
    this.detail.querySelector("textarea")?.focus({ preventScroll: true });
  }

  matches(it) {
    return this.filter === "all" || (this.filter === "closed" ? CLOSED.includes(it.status) : it.status === this.filter);
  }

  paint() {
    const counts = { open: 0, waiting: 0, closed: 0, all: this.items.length };
    for (const it of this.items) counts[CLOSED.includes(it.status) ? "closed" : it.status]++;
    this.root.querySelectorAll("[data-ibf]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.ibf === this.filter)));
    this.root.querySelectorAll("[data-ibn]").forEach((s) => { s.textContent = counts[s.dataset.ibn] || ""; });
    const shown = this.items.filter((it) => this.matches(it));
    if (!this.selected && shown.length && matchMedia("(min-width: 900px)").matches) this.selected = shown[0].id;
    const empty = { open: "Nothing is waiting on you.", waiting: "Nothing is waiting on the team.", closed: "No closed tickets yet.", all: "No tickets yet. Blockers on you, questions, approvals and alerts the CEO could not fix land here." }[this.filter];
    this.list.innerHTML = shown.length ? `<div class="ib-row ib-headrow" aria-hidden="true"><span>Status</span><span>Ticket</span><span>From</span><span>Updated</span></div>` + shown.map((it) => {
      const [kl, kt] = KIND[it.kind] || [it.kind, ""];
      const [sl, st] = statusOf(it);
      return `<button class="ib-row${it.id === this.selected ? " on" : ""}${it.status === "open" ? " open" : ""}" role="listitem" data-ib="${it.id}" aria-current="${it.id === this.selected}">
        <span><span class="pill ${st} ib-status">${esc(sl)}</span></span>
        <span class="ib-title"><span class="ib-tline"><span class="pill ${kt} ib-kind">${kl}</span><b>${esc(it.title)}</b></span>
          <span class="faint ib-sub">#${it.id}${it.task ? ` · ${esc(it.task.id)}` : ""}${this.opts.showRun ? ` · ${esc(it.project || "")} / ${esc(it.runTitle || "")}` : ""}${it.comments ? ` · ${it.comments} comment${it.comments === 1 ? "" : "s"}` : ""}</span></span>
        <span class="ib-from">${face(it.asked_by, it.askedByName, this.opts.roleOf)}<span>${esc(it.askedByName)}</span></span>
        <span class="faint ib-when">${ago(it.updated)}</span>
      </button>`;
    }).join("") : `<div class="empty ib-none">${empty}</div>`;
    this.paintDetail();
  }

  paintDetail() {
    const it = this.items.find((i) => i.id === this.selected);
    if (!it) { this.sig = ""; this.detail.innerHTML = `<div class="ib-pick faint">Pick a ticket to read it and answer.</div>`; this.detail.classList.remove("has"); return; }
    this.detail.classList.add("has");
    const sig = `${it.id}|${it.updated}|${it.status}|${it.comments}|${(it.thread || []).length}`;
    if (sig === this.sig) return;
    const sameTicket = this.sig.startsWith(`${it.id}|`);
    this.sig = sig;
    const [kl, kt] = KIND[it.kind] || [it.kind, ""];
    const [sl, st] = statusOf(it);
    const planId = String(it.key || "").startsWith("plan:") ? it.key.slice(5) : null;
    const thread = (it.thread || []).map((c) => `<div class="ib-c${c.author === "human" ? " me" : ""}">${face(c.author, c.authorName, this.opts.roleOf)}
      <div class="ib-cb"><div class="ib-cm"><b>${esc(c.authorName)}</b> <span class="faint">${ago(c.created)}</span></div><div class="md">${md(c.body)}</div></div></div>`).join("");
    const head = `<div class="ib-dh">
        <button class="btn ib-back" type="button" aria-label="Back to the list">←</button>
        <span class="pill ${kt}">${kl}</span><span class="pill ${st}">${esc(sl)}</span><span class="faint">#${it.id}</span>
      </div>
      <h2 class="ib-dt">${esc(it.title)}</h2>
      <div class="faint ib-meta">${face(it.asked_by, it.askedByName, this.opts.roleOf)} ${esc(it.askedByName)} · ${ago(it.created)}
        ${it.task ? ` · task <b>${esc(it.task.id)}</b> ${esc(it.task.title)} (${esc(it.task.status.replace("_", " "))})` : ""}
        ${this.opts.showRun ? ` · <a href="/runs/${esc(it.run_id)}">${esc(it.project || "")} / ${esc(it.runTitle || "")}</a>` : ""}
        ${planId ? ` · <a href="/plans/${esc(planId)}">Open the plan</a>` : ""}</div>
      ${it.body ? `<div class="ib-body md">${md(it.body)}</div>` : ""}
      ${thread ? `<div class="ib-thread">${thread}</div>` : ""}
      ${CLOSED.includes(it.status) ? `<div class="ib-res faint">${esc(sl)}${it.closedByName ? ` by ${esc(it.closedByName)}` : ""}${it.closed ? ` ${ago(it.closed)}` : ""}${it.resolution ? `: ${esc(it.resolution)}` : ""}</div>` : ""}`;
    // The composer survives re-renders of the same ticket; switching tickets keeps each one's draft.
    let box = this.detail.querySelector(".ib-compose");
    const keepFocus = sameTicket && document.activeElement?.closest?.(".ib-compose");
    if (!sameTicket || !box) {
      this.detail.innerHTML = `<div class="ib-scroll"></div><div class="ib-compose"><textarea rows="3" aria-label="Your answer"></textarea><div class="ib-acts"></div></div>`;
      box = this.detail.querySelector(".ib-compose");
      const ta = box.querySelector("textarea");
      ta.value = this.drafts.get(it.id) || "";
      ta.addEventListener("input", () => this.drafts.set(this.selected, ta.value));
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); box.querySelector(".ib-acts .primary")?.click(); } });
      box.querySelector(".ib-acts").addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); if (b) this.act(b.dataset.act, b); });
      this.detail.querySelector(".ib-scroll").addEventListener("click", (e) => { if (e.target.closest(".ib-back")) { this.selected = null; this.paint(); } });
    }
    const scroll = this.detail.querySelector(".ib-scroll");
    const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 30;
    scroll.innerHTML = head;
    if (!sameTicket || atEnd) scroll.scrollTop = scroll.scrollHeight;
    box.querySelector("textarea").placeholder = placeholder(it);
    box.querySelector(".ib-acts").innerHTML = actionsFor(it).map(([a, l, cls]) => `<button class="btn ${cls}" type="button" data-act="${a}">${esc(l)}</button>`).join("")
      + `<span class="faint ib-hint">Ctrl+Enter: ${esc(actionsFor(it)[0][1])}</span>`;
    if (keepFocus) box.querySelector("textarea").focus({ preventScroll: true });
  }

  async act(action, btn) {
    const it = this.items.find((i) => i.id === this.selected);
    if (!it) return;
    const ta = this.detail.querySelector(".ib-compose textarea");
    const body = ta.value.trim();
    if (action === "comment" && !body) { toast("Write your answer first."); ta.focus(); return; }
    btn.disabled = true;
    try {
      const view = await api("POST", `/api/inbox/${it.id}`, { action, body });
      ta.value = ""; this.drafts.delete(it.id);
      const idx = this.items.findIndex((i) => i.id === it.id);
      if (idx >= 0) this.items[idx] = view;
      if (!this.matches(view)) this.filter = "all";
      toast({ comment: `Sent to ${view.targetName}.`, approve: "Approved.", decline: String(it.key || "").startsWith("plan:") ? "Changes requested: the CEO revises the plan." : "Declined.", unblock: `Unblocked: ${view.targetName} carries on.`, resolve: "Closed.", reopen: "Reopened." }[action] || "Done.");
      this.paint();
      this.opts.onChanged?.();
    } catch (e) { toast(e.message); } finally { btn.disabled = false; }
  }
}

// The header's Inbox link shows how many tickets wait on you.
export async function inboxBadge() {
  const el = document.getElementById("inbox-count");
  if (!el) return;
  try {
    const { open } = await api("GET", "/api/inbox?count=1");
    el.textContent = open ? String(open) : "";
    el.hidden = !open;
    el.closest("a")?.setAttribute("aria-label", open ? `Inbox: ${open} waiting on you` : "Inbox");
  } catch {}
}
