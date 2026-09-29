---
name: redpi-browser
description: Drive a real Chromium browser with Playwright through the redpi_browser tool. Use when a task needs a live web page - checking a running dev server, reproducing a UI bug, reading page text, clicking or typing through a flow, capturing console errors or failed network requests, or taking screenshots for visual review.
---

# RedPi browser (Playwright)

RedPi exposes Playwright as one compact tool, `redpi_browser`, instead of an MCP server. One real browser stays open between calls, so the page keeps its state: navigate once, then inspect or interact, and a dialog a click opened is still open for the next `text` or `screenshot`.

**It knows when the page is loaded.** `goto`, `click`, `type`, `text`, `screenshot` and the waits first wait until the page is really ready (the load event, no requests in flight, fonts and visible images loaded, no visible spinner or skeleton, the DOM no longer changing) and say so on the first line:

- `ready: page fully loaded (1.2s)`: what you read or capture is the finished page. Trust it; do not sleep, reload or take another screenshot to "make sure".
- `NOT READY after 15s: 1 request still loading (GET /api/items); loading indicator visible (div.spinner)`: the page did not finish. Act on the reason: `ready --timeout 30000` to wait longer, `errors` for a failing request, or check the backend.

## Commands

| Goal | Command |
| --- | --- |
| Open a page | `goto http://localhost:3000 --max 2000` |
| Read visible text | `text --max 3000` |
| Read HTML (use sparingly) | `html --max 4000` |
| Page title | `title` |
| Click | `click text=Sign in` or `click role=button[name="Save"]` |
| Type (optionally submit) | `type input[name=email] me@example.com --submit` |
| Run JavaScript | `eval document.querySelectorAll('li').length` |
| Wait for an element | `wait-for [role=dialog]` |
| Wait for content | `wait-for-text Dashboard` |
| Wait until fully loaded | `ready` or `ready --timeout 30000` |
| Reload / go back | `reload`, `back` |
| Window size | `viewport phone` (390×844), `viewport tablet`, `viewport desktop` (1280×900), `viewport 1440x900` |
| Console output | `console --max 2000` |
| Page errors and failed requests | `errors --max 2500` |
| Network log | `network --max 2500` |
| Screenshot (visible area) | `screenshot /tmp/page.png` |
| Screenshot (whole page) | `screenshot /tmp/page.png --full` |
| Close the browser (keeps logins) | `close` |
| Start fresh (logged out, empty storage) | `reset` |

Selectors use Playwright syntax: `text=...`, `role=...[name="..."]`, or CSS.

## Workflow

1. `goto` the URL, then `text --max 3000` to see what rendered. Prefer text over HTML: it costs far fewer tokens.
2. Interact with `click` / `type`; they wait for the page to settle and show the result. If the change you expect comes later (a toast, a list after a slow search), `wait-for <selector>` or `wait-for-text`.
3. For bugs, always check `errors` and `console` before guessing at a cause.
4. Take a `screenshot` only when layout or visuals matter, then inspect the image file. Set the width first (`viewport phone` / `viewport desktop`); the size stays until you change it.
5. `reset` when a flow needs a clean session (logged out, empty storage). The browser closes itself after 30 minutes unused.

For a one-shot health check of a frontend, the user can run `/redpi-frontend-check <url>`.

## If the browser is missing

If a command reports that Playwright or Chromium is not installed, the tool offers to install it. Otherwise ask the user to run `/redpi-browser-install`.
