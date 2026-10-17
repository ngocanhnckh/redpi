// Shared helpers for RedPi HQ pages. Everything agents write is untrusted: render text with esc() only.
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function api(method, path, body) {
  // A stuck request should fail loudly, not hang a button forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(path, {
      method, credentials: "same-origin", signal: ctrl.signal,
      headers: { "x-redpi-hq": "1", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e?.name === "AbortError" ? "The request timed out. Check your connection and try again." : "Could not reach HQ. Is it still running?");
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  // Signed out (or the password changed): back to the sign-in page, then here again.
  if (res.status === 401 && !path.startsWith("/api/login")) location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

export function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function hours(h) {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h <= 40) return `${+h.toFixed(1)}h`;
  return `${+(h / 8).toFixed(1)}d (8h days)`;
}

// A small "reconnecting to HQ" pill, shown while the live stream is down.
export function connBanner(show) {
  const el = document.getElementById("conn-banner");
  if (show && !el) { const b = document.createElement("div"); b.id = "conn-banner"; b.className = "conn-banner"; b.innerHTML = `<span class="dot"></span> Reconnecting to HQ…`; document.body.appendChild(b); }
  else if (!show && el) el.remove();
}

// Live updates: call onChange (debounced) whenever the hub reports a change for this run. The stream
// drops whenever HQ restarts or the network blips; we reconnect with a growing backoff and, on every
// reconnect, kick one refresh so the page catches up on anything it missed while it was down. The stream
// is HQ's heartbeat (it pings every 25 s), so if it stays down past a short grace we warn the user with a
// reconnecting banner and one toast — having let it retry quietly first — and clear them when it is back.
export function live(runId, onChange) {
  let timer, backoff = 1000, opened = false, graceTimer = null, down = false, warned = false;
  // Coalesce bursts: many workers posting at once would otherwise each trigger a full run refetch
  // (multi-MB). One refresh per ~600ms keeps the UI lively without flooding the connection pool.
  const kick = () => { clearTimeout(timer); timer = setTimeout(onChange, 600); };
  const up = () => {
    backoff = 1000; down = false;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (warned) { warned = false; connBanner(false); toast("Reconnected to HQ"); }
    if (opened) kick();
    opened = true;
  };
  const dropped = () => {
    if (down) return;
    down = true;
    graceTimer = setTimeout(() => { graceTimer = null; if (down) { warned = true; connBanner(true); toast("Lost connection to HQ — retrying…"); } }, 5000);
  };
  const connect = () => {
    const es = new EventSource(`/api/events${runId ? `?run=${encodeURIComponent(runId)}` : ""}`);
    es.onopen = up;
    es.onmessage = kick;
    es.onerror = () => { es.close(); dropped(); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); };
  };
  connect();
}

// Run an async click handler with immediate feedback: the button is disabled and shows a spinner until it
// settles, so no action ever feels dead. Returns the handler's result; errors are toasted unless told not to.
export async function busy(btn, fn, { quiet = false } = {}) {
  if (!btn) return fn();
  if (btn.dataset.busy === "1") return;   // no double-submit
  btn.dataset.busy = "1"; btn.setAttribute("aria-busy", "true");
  const wasDisabled = btn.disabled; btn.disabled = true;
  try { return await fn(); }
  catch (e) { if (!quiet) toast(e?.message || "Something went wrong"); throw e; }
  finally { delete btn.dataset.busy; btn.removeAttribute("aria-busy"); btn.disabled = wasDisabled; }
}

export function toast(msg) {
  // One at a time: a newer message replaces the one still showing instead of stacking on it.
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export const STATUS_LABEL = {
  planning: ["Planning", "cyan"], awaiting_approval: ["Awaiting approval", "amber"], approved: ["Approved", "green"],
  executing: ["Executing", "green"], done: ["Done", "green"], cancelled: ["Cancelled", "red"],
  pending: ["Awaiting approval", "amber"], changes_requested: ["Changes requested", "red"], superseded: ["Superseded", ""],
};
export const pill = (status) => { const [label, tone] = STATUS_LABEL[status] || [status, ""]; return `<span class="pill ${tone}">${esc(label)}</span>`; };

// Header: who is signed in, with a sign-out button (only when HQ has a password).
export async function signedInAs() {
  const el = document.getElementById("account");
  if (!el) return;
  const s = await api("GET", "/api/session").catch(() => null);
  if (!s?.user) return;
  el.innerHTML = `<span class="faint">${esc(s.user)}</span> <button class="btn" type="button">Sign out</button>`;
  el.querySelector("button").addEventListener("click", async () => { await api("POST", "/api/logout").catch(() => {}); location.assign("/login"); });
}
