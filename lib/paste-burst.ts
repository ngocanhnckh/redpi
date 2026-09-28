// Multi-line paste without bracketed-paste markers.
//
// Pi asks the terminal for bracketed paste (ESC[200~ … ESC[201~), but some terminals never send
// the markers: many mobile SSH apps, web terminals, and some tmux or Windows setups. There,
// each line break of a paste arrives as a bare Enter ("\r"), which submits. One paste
// turns into several prompts.
//
// A paste arrives as one burst from the terminal. A read that has a line break followed by
// more text is not typing, so the whole read is handed to Pi as a real bracketed paste.
// The next read, if it comes within a few milliseconds, is treated the same way: a large
// paste can arrive in several reads. A read that only ends in Enter (typed text sent in one
// go) passes through untouched and submits at once.
//
// Some clients "type" a paste one character per read. For those, an Enter that arrives on
// its own within `recentMs` of text is held back for `settleMs`:
//   - more text follows: it was a paste, delivered the same way;
//   - nothing follows: it was a real Enter, and it is replayed.
// No person types text, Enter, and more text that fast, and an ordinary Enter is never delayed.

export type PasteBurstOptions = {
  // Deliver data to Pi as if the terminal had sent it.
  inject: (data: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  // Runs after Pi has finished handling the current read (default queueMicrotask).
  defer?: (fn: () => void) => void;
  recentMs?: number;
  settleMs?: number;
  continueMs?: number;
};

const ENTER = "\r";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function createPasteBurstGuard(opts: PasteBurstOptions) {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as any));
  const defer = opts.defer ?? ((fn) => queueMicrotask(fn));
  const recentMs = opts.recentMs ?? 15;
  const settleMs = opts.settleMs ?? 25;
  const continueMs = opts.continueMs ?? 30;
  let lastTextAt = -Infinity;
  let lastPasteAt = -Infinity;
  let reinjecting = false;
  // Key sequences of the current read are swallowed (Pi gets the paste instead).
  let swallow = false;
  let pending = "";
  let held: string | undefined;
  let timer: unknown;

  function replay(data: string) {
    reinjecting = true;
    try { opts.inject(data); } finally { reinjecting = false; }
  }
  function paste(text: string) {
    lastPasteAt = now();
    replay(PASTE_START + text.replace(/\r\n?/g, "\n") + PASTE_END);
  }

  function endOfRead() {
    swallow = false;
    if (!pending) return;
    const text = pending;
    pending = "";
    paste(text);
  }

  function settle() {
    timer = undefined;
    const text = held ?? "";
    held = undefined;
    if (/[^\r\n]/.test(text)) paste(text);
    else if (text) replay(text);
  }

  // Called with every raw read from the terminal, before Pi parses it.
  function onChunk(raw: string) {
    if (reinjecting || typeof raw !== "string" || !raw) return;
    const t = now();
    if (raw.includes("\x1b")) {
      // Escape sequences (arrows, bracketed pastes, terminal replies) are never part of a burst.
      if (held !== undefined) { clearTimer(timer); settle(); }
      lastTextAt = -Infinity;
      return;
    }
    if (held !== undefined) {
      held += raw;
      clearTimer(timer);
      timer = setTimer(settle, settleMs);
      swallow = true;
      defer(endOfRead);
      return;
    }
    const cr = raw.indexOf(ENTER);
    const continuing = t - lastPasteAt <= continueMs;
    if (continuing || (cr >= 0 && /[^\r\n]/.test(raw.slice(cr)))) {
      pending += raw;
      swallow = true;
      defer(endOfRead);
      return;
    }
    if (raw === ENTER && t - lastTextAt <= recentMs) {
      held = raw;
      timer = setTimer(settle, settleMs);
      swallow = true;
      defer(endOfRead);
      return;
    }
    lastTextAt = cr >= 0 ? -Infinity : t;
  }

  // Pi's raw input listener (ctx.ui.onTerminalInput): drops the key sequences of a read
  // that is being delivered as a paste instead.
  function handle(_seq: string): { consume?: boolean } | undefined {
    if (reinjecting || !swallow) return undefined;
    return { consume: true };
  }

  return { onChunk, handle, get holding() { return held !== undefined; } };
}
