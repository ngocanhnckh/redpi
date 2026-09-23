---
name: redpi-browser
description: Drive a real Chromium browser with Playwright through the redpi_browser tool. Use when a task needs a live web page - checking a running dev server, reproducing a UI bug, reading page text, clicking or typing through a flow, capturing console errors or failed network requests, or taking screenshots for visual review.
---

# RedPi browser (Playwright)

RedPi exposes Playwright as one compact tool, `redpi_browser`, instead of an MCP server. The browser session persists between calls, so navigate once and then inspect or interact.

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
| Wait for content | `wait-for-text Dashboard` |
| Console output | `console --max 2000` |
| Page errors and failed requests | `errors --max 2500` |
| Network log | `network --max 2500` |
| Screenshot | `screenshot /tmp/page.png` |
| Start fresh | `reset` |

Selectors use Playwright syntax: `text=...`, `role=...[name="..."]`, or CSS.

## Workflow

1. `goto` the URL, then `text --max 3000` to see what rendered. Prefer text over HTML: it costs far fewer tokens.
2. Interact with `click` / `type`, then `wait-for-text` before reading again.
3. For bugs, always check `errors` and `console` before guessing at a cause.
4. Take a `screenshot` only when layout or visuals matter, then inspect the image file.
5. `reset` when a flow needs a clean session (logged out, empty storage).

For a one-shot health check of a frontend, the user can run `/redpi-frontend-check <url>`.

## If the browser is missing

If a command reports that Playwright or Chromium is not installed, the tool offers to install it. Otherwise ask the user to run `/redpi-browser-install`.
