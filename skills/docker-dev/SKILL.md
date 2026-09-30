---
name: docker-dev
description: Default way to run anything that listens on a port while developing (web or API servers, dev servers, workers with an HTTP endpoint, databases, queues). Runs it in Docker with the code bind-mounted for hot reload and memory/CPU/process limits sized to the service, so it is started, watched, restarted and stopped with one command instead of hunting host PIDs or killing whatever holds a port. Use it unless the human asked to run things another way. Not for desktop/GUI apps, CLIs, one-off scripts, builds or unit tests.
---

# Docker dev (RedPi)

Unless the human says otherwise, every service that takes a port runs in a container:

- The code folder is bind-mounted, so edits hot-reload exactly as they would on the host.
- Everything the service starts (node child processes, watchers, workers, browsers) lives inside that container, under its limits: `mem_limit`, `cpus`, `pids_limit`.
- `init: true` reaps child processes, so nothing turns into a zombie.
- Stopping it is `redpi-dev down`. Never `kill` host processes or `fuser -k` a port to free it.

Desktop/GUI apps, CLIs, one-off scripts, builds and unit tests run normally on the host (tests may call the containerised service over its port).

## The helper

`redpi-dev` is on PATH in RedPi sessions. Otherwise run it as `node <this skill's folder>/dev.mjs`.

| Command | What it does |
| --- | --- |
| `redpi-dev init [--port N] [--mem 1g] [--cpus 2] [--cmd "..."] [--image IMG] [--public]` | Writes `compose.dev.yaml` for the stack it finds (Node/Next/Vite/Astro/Nuxt/Angular, FastAPI/Django/Flask, Go) |
| `redpi-dev up [service]` | Starts or updates, and waits until the port accepts connections. Prints `ready:` with the URL, memory and CPU against the limits; on failure prints the error and the last logs |
| `redpi-dev status` | State, health, URL, memory/CPU use against the limit, restarts, and any OOM kill with the fix |
| `redpi-dev logs [service] [--tail 150] [--since 10m]` | Recent logs; no endless follow |
| `redpi-dev restart [service]` | Restart after config or dependency changes; code edits reload by themselves |
| `redpi-dev exec <service> -- <cmd...>` | Run something inside, e.g. migrations or `npm install <pkg>` |
| `redpi-dev down [-v]` | Stop and remove the stack (`-v` also drops dependency volumes) |
| `redpi-dev ls` | Every RedPi dev stack on the machine |
| `redpi-dev down --project <name>` | Stop a stack from `ls` |

- **Host port.** A service publishes `${DEV_PORT:-<port>}`. `up` keeps the port the stack already has, else the default if free, else any free port, and prints the URL it chose. Use that URL.
- **Bind address.** Ports bind to 127.0.0.1 unless you `init --public` (use it when the human opens the app from another machine).
- **Parallel stacks.** Each folder, and each RedPlan worker, gets its own stack name (`redpi-<folder>[-<worker>]`), so parallel stacks never collide.

## Size the limits to the service

1 GB is a starting point, not a rule. `init` picks a default per stack; after the first real run, check `redpi-dev status` and set each service's `mem_limit` (and `memswap_limit` to the same value) to about 1.5× its working peak, rounded up. Keep a limit on every service.

Rough starting points:

| Service | Memory |
| --- | --- |
| Redis | 128–256m |
| Postgres / MySQL | 256–512m |
| Node or Python API | 512m–1g |
| Vite/Astro dev | 1g |
| Next.js/Nuxt/Angular dev | 1.5–2g |
| Go build and run | 1g |
| JVM or Keycloak | 1–2g |
| Headless browser workers | 1–2g, plus `shm_size: 512m` |

Use 1–2 CPUs for app servers and 0.5–1 for databases.

When a service is killed for memory (`status` says OUT OF MEMORY, or exit code 137), raise its limit deliberately and say so. Don't remove the limit. When `status` shows a service using far less than its limit, lower the limit.

## Rules of thumb

- **Respect the project's own setup.** If it already has a dev compose file or a documented Docker dev command, use it: `redpi-dev up --file compose.yaml`, or its own command. Only `init` when there is none.
  - A file with a fixed `container_name` or fixed host ports cannot run twice side by side. For parallel RedPlan work, copy the dev services into `compose.dev.yaml` without those.
- **Listen on 0.0.0.0 inside the container.** Otherwise the published port answers nothing. `init` adds `--host`/`--hostname`/`HOST`.
- **Hot reload.** On Linux, file events cross bind mounts. If a watcher still misses edits (Docker Desktop, network drives), set `CHOKIDAR_USEPOLLING=1` / `WATCHPACK_POLLING=true` for that service.
- **Dependencies live in a named volume** (`node_modules`, `/venv`) and install on start only when the lock file changed. After adding a package, run `redpi-dev exec app -- npm install <pkg>` (or edit the manifest and `redpi-dev restart`).
- **File ownership.** Containers run as your user, so files they write in the repo (migrations, generated code) stay editable.
- **Adding a database or other service:** put it in the same file with its own limits, and reach it by service name (`postgres:5432`) from the app:

```yaml
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: app }
    mem_limit: 512m
    memswap_limit: 512m
    cpus: 1
    init: true
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["127.0.0.1:${DEV_PORT_DB:-5432}:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 10 }
```

  Declare `pgdata:` under the top-level `volumes:`, and add `depends_on: { postgres: { condition: service_healthy } }` to the app.
- **Browsers in the app** (Playwright, Puppeteer, scrapers, PDF renderers):
  - Close them in `finally` / `async with` / `using`, and reuse one browser instead of launching one per request.
  - Give the container `init: true`, or Chromium's exited helpers pile up as zombies.
- **When the work is done,** `redpi-dev down` unless the human wants the service left running. Say which URL is still up if you leave it.
- **No Docker?** (`redpi-dev` exits 3 and says why.) Run the service directly, say so in one line, and stop it by its own PID when done.
