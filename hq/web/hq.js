// Shared helpers for RedPi HQ pages. Everything agents write is untrusted: render text with esc() only.
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: { "x-redpi-hq": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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

// Live updates: call onChange (debounced) whenever the hub reports a change for this run.
export function live(runId, onChange) {
  let timer;
  const kick = () => { clearTimeout(timer); timer = setTimeout(onChange, 150); };
  const connect = () => {
    const es = new EventSource(`/api/events${runId ? `?run=${encodeURIComponent(runId)}` : ""}`);
    es.onmessage = kick;
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  };
  connect();
}

export function toast(msg) {
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
