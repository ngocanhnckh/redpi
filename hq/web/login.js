// RedPi HQ sign-in. The password is set in RedPi (/hq asks the first time; /hq-password changes it).
import { api, esc } from "/static/hq.js";

const next = new URLSearchParams(location.search).get("next") || "/";
const form = document.getElementById("form"), err = document.getElementById("err"), go = document.getElementById("go");

const session = await api("GET", "/api/session").catch(() => ({}));
if (session.signedIn) location.replace(next);
else if (!session.passwordSet) {
  document.getElementById("lead").innerHTML = `HQ has no password yet. In RedPi on this machine, run <code>/hq</code>: it asks you to choose a username and password.`;
} else {
  form.classList.remove("hide");
  document.getElementById("user").focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  go.disabled = true;
  try {
    const r = await api("POST", "/api/login", { user: document.getElementById("user").value.trim(), password: document.getElementById("password").value, next });
    location.replace(r.next || "/");
  } catch (e) {
    err.innerHTML = esc(e.message);
    document.getElementById("password").select();
  } finally { go.disabled = false; }
});
