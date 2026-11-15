# JARVIS MCP architecture

The bridge (`bridge/server.mjs`) is the brain's hands. Everything below is
free, local and deliverable-shaped: no SDK is required, no API key is shipped,
and a failing service is a sentence, never a crash.

## The four levels

Every request lands in the WebSocket `ask` handler and descends in order:

1. **Level 1 — direct browser + weather, instant.** The fast command router
   (`bridge/router.mjs`) answers exact commands without the brain:
   `open <site>`, `new tab`, `back`, `refresh`, `go to <url>`,
   `take me to <site>`, and weather (`what's the weather`, `weather in X`,
   `set my weather location to X`, units). Response time is rounds-trips, not
   model boots. Whole-phrase matching: "open gmail and check my mail" falls
   through on purpose.
2. **Level 2 — direct service.** The same router answers
   `remind me to/about X in N minutes`, `remind me to X at HH:MM [am/pm]`,
   `call me at HH:MM (to|about) X`, `remember that X` / `note that X`,
   `prefer [to use|using|to] X`, tab management (`next tab`, `previous tab`,
   `go to tab N`) and project memory (`my main project is X` is saved as a
   project, `do you remember my projects` reads it back). Reminders fire as
   Windows notifications; remembered and preferred things become standing
   preferences. The brain is never booted for any of this.
3. **Level 3 — brain + MCP.** Anything else boots `opencode` and lets it use
   the eleven HUD tools below.
4. **Level 4 — brain alone.** Unrecognised small talk is pure model, no tools.

## The eleven HUD servers (model-visible tools)

Generated at boot into `<config>/tools/*.js` by `bridge/hudtools.mjs`, each a
plain custom tool that POSTs back to the bridge's `/rpc/hud`. The generated
`args` field is a per-field map (one JSON schema per argument) — a
`{type:'object', properties, required}` container gets mangled by opencode and
arguments arrive as `{properties:{…}}`, so the generator flattens it.

| Server | File | Tools | Notes |
| --- | --- | --- | --- |
| `jarvis` | `panels.mjs` | `display`, `blade` | the on-screen HUD |
| `jarvis_ui` | `ui.mjs` | `ui_theme`, `ui_screen`, `ui_effect`, `ui_orbit`, `ui_reactor`, `ui_chrome`, `ui_reset` | theme + visuals |
| `jarvis_chrome` | `chrome.mjs` | `chrome_status`, `chrome_navigate`, `chrome_new_tab`, `chrome_tabs`, `chrome_switch_tab`, `chrome_next_tab`, `chrome_previous_tab`, `chrome_close_tab`, `chrome_page_text`, `chrome_read_page`, `chrome_find`, `chrome_screenshot`, `chrome_click`, `chrome_type`, `chrome_form_input`, `chrome_scroll`, `chrome_key`, `chrome_console`, `chrome_network` | free CDP adapter (`tcp 9333` → Chrome `:9222`) |
| `jarvis_eyes` | `vision.mjs` | `look`, `watch` | the webcam |
| `jarvis_weather` | `weather.mjs` | `weather_forecast` | free HTTPS lookup (Open-Meteo), 10-min cache |
| `jarvis_prefs` | `preferences.mjs` | `preferences_list`, `preferences_get`, `preferences_set`, `preferences_remove` | SQLite (`data/jarvis.db`) |
| `jarvis_notify` | `notifications.mjs` | `notify_now`, `notify_schedule`, `notify_list`, `notify_cancel` | SQLite queue, 5 s tick |
| `jarvis_gmail` | `gmail.mjs` | `gmail_status`, `gmail_list`, `gmail_search`, `gmail_read`, `gmail_send`, `gmail_connect` | free Google REST, your own account |
| `jarvis_calendar` | `calendar.mjs` | `calendar_status`, `calendar_list`, `calendar_add`, `calendar_remove` | free Google REST |
| `jarvis_memory` | `memory.mjs` | `memory_save`, `memory_search`, `memory_get`, `memory_list`, `memory_update`, `memory_delete`, `project_save`, `project_get`, `project_search`, `project_update`, `project_delete`, `task_create`, `task_list`, `task_update`, `task_delete` | SQLite facts + projects + tasks |
| `jarvis_systems` | `systems.mjs` | `services_status` | one health picture; same shape as `/systems` |

## Storage

- One SQLite database, `data/jarvis.db` (`bridge/db.mjs`, WAL, fresh schema with
  migrations): `preferences`, `notes`, `memory`, `projects`, `project_tasks`,
  `notifications`, `command_history`, `performance_logs`, `browser_tabs`,
  `google_tokens`. Safe to stop and restart the bridge at any time.
- Legacy JSON stores (`bridge/.oc/preferences.json`, `notifications.json`) were
  imported once on first boot and are now dormant.

## Preferences

- Stored in SQLite. Values up to 16 KB of JSON, names up to 120 chars.
  `setPref(name, value, category)` upserts; `preferences_set` and the router's
  `set my weather location to X` share it.
- **Secrets are refused outright** — password/token/PIN/API-key shaped values
  bounce with an explanation.
- `remember that X` appends to `notes` (head 100); `prefer X` appends to
  `preferred` (deduped). `notes` never enters the model context.
- Every turn's prompt is built as: standing system instructions, then
  "Honour these standing preferences unless the user says otherwise this
  turn: …", then the router note, then the user's words — so the newest,
  most specific instruction wins. `opencode run` has no `--system` flag, so
  the context rides in the prompt (`buildTurnPrompt` in `server.mjs`).

## Memory, projects, tasks

- `memory.mjs` is a full fact store: `memory_save` takes a content string plus
  an optional importance/category, refuses secrets, saves with a searchable
  `LIKE` index; `memory_search` also surfaces matching saved projects and
  their open tasks.
- Projects carry status/technologies/priority and an owner; tasks belong to a
  project with a status (`todo | doing | done | blocked`) and priority. The
  router fast-paths "my main project is X" into `project_save` and "what are
  my projects" into a direct SQL read.

## Weather fast path

- `bridge/weather.mjs` + a pure `bridge/weather-core.mjs` (geocoding, forecast,
  WMO→words). Location comes from the `weather_location` preference, falling
  back to an IP geolocation (no key) and finally London. Forecasts cache for
  10 minutes; "refresh" bypasses the cache.
- `what's the weather`/`weather in X` never boot the model — Level 1 answers
  in under a second.

## Performance ledger

- Every handled command is logged to `command_history` + `performance_logs`
  via `bridge/perf.mjs`: command, intent (router / brain / confirm), timings
  (routing, model, MCP, browser, total) and success. `/systems` and the
  `services_status` tool surface the last few entries under `recent`.

## Tabs

- The Chrome registry (`bridge/chrome-cdp.mjs`) persists the last known tab
  list to `browser_tabs` and can switch tabs through Chrome's DevTools
  (`Target.activateTarget` over the browser WebSocket). The router answers
  `next tab`, `previous tab`, `go to tab N` without the model.
- Closing a tab is never a fast path: it rides the model → `chrome_close_tab`
  → the spoken-confirmation gate.

## Browser

- `GET` exact commands are Level 1 (router). Anything reading or acting on a
  page ("what's on the screen", "click the button") goes model → `chrome_*`
  tools → the free CDP adapter.

## Notifications

- `notifications.mjs` keeps a SQLite queue, ticks every 5 s, and catches up
  missed items on boot.
- Windows balloons via PowerShell `NotifyIcon` (detached, fire-and-forget);
  non-Windows falls back to a console line.
- `parseDateTime` accepts 24-hour `HH:MM` (tomorrow if already past) or ISO.

## Google (Gmail + Calendar)

Free REST APIs called with a personal OAuth token — no SDK, no billing:

- `bridge/auth.mjs` owns the exchange. `GET /auth/google` → Google consent;
  the code comes back to `GET /auth/google/callback`, and only then is it
  exchanged. Tokens live in `bridge/.oc/auth/google.json`, server-side, and
  are **never sent to the page**. Access tokens refresh lazily off the stored
  refresh token. Loopback redirect — no redirect URI registration needed.
- One consent grants the combined Gmail + Calendar scopes.
- Until the user sets `JARVIS_GOOGLE_CLIENT_ID` / `JARVIS_GOOGLE_CLIENT_SECRET`
  and completes a connection, every tool answers "not connected" and the rest
  of JARVIS carries on regardless. `/systems` reports Google separately and
  never claims it is online.

## Permissions taxonomy

`decideTool(name)` in `server.mjs`, layered:

- **READ** — runs freely: `services_status`, `calendar_list`, `gmail_list`,
  `preferences_get`, `memory_search`, `project_get`, `task_list`, the browser
  status, weather, camera, HUD, UI.
- **WRITE** — gated on `JARVIS_ALLOW_WRITES=1`: sends, calendar adds,
  preference changes, memory/project/task writes, shell/file effects, browser
  acting tools (the chrome server simply doesn't construct them until writes
  are on).
- **DESTRUCTIVE** — `calendar_remove`, `preferences_remove`,
  `chrome_close_tab`, `memory_delete`, `project_delete`, `task_delete` — gets
  the write gate **and** a spoken confirmation backstop. The call is not
  executed; the intent is stored on the connection and the next user words
  decide: "yes, go ahead" runs it, "no" forgets it, anything else leaves it
  waiting. This exists because a voice interface has no dialog box to click.

## Health

- `GET /health` — the boot summary the frontend reads (model, writes,
  browser, mediapipe, google, server list).
- `GET /systems` — full JSON snapshot: pid, uptime, model, writes, browser,
  gesture runtime, `hud` (the eleven in-process servers), `mcp` (external MCP
  config, never claimed online), `tabs` (SQLite tab registry), Google status
  and `recent` (live performance ledger). The same picture feeds the
  `services_status` tool, built by `bridge/systems.mjs`.

## Live verification

- Direct router: `open gmail` → "Opening Gmail." < 10 ms.
- Weather fast path: `what's the weather?` → forecast text in < 1 s, without
  booting the model.
- Projects: `my main project is Jarvis` → project saved; `do you remember my
  projects?` → "Jarvis (0 open)" instantly.
- Model turn with tool use: `are your services healthy?` → calls
  `services_status`, answers with per-service state.
- Memory via the brain: `add a task to my project Jarvis: …` → calls
  `task_create` over `/rpc/hud`, the row lands in `data/jarvis.db` and the
  reply names the saved task.
- Destructive gate: forced `calendar_remove` is held; `no` cancels with
  "nothing was changed"; `yes, go ahead` executes and fails cleanly against
  the (intentionally unconnected) API.

## Notes for the operator

- Never edit `~/.config/opencode/opencode.jsonc` — the free Zen tier 403s
  unless it is exactly the default. The bridge's generated config lives in
  `bridge/.oc/` instead.
- The driver for the whole model layer is `bridge/runner.mjs`, which sends
  the prompt over **stdin**, not argv: on Windows a composed turn in the
  command line dies with "the command line is too long" (the prompt is
  several KB once system + preferences are inlined).
- Writes are off by default: start the bridge with `node scripts/start.mjs
  --detach --writes` to let the model change files, send mail and edit
  memory. Everything read-only still works without the flag.