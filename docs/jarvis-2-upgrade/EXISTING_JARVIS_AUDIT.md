# Existing JARVIS Audit

- Date: 2026-11-03
- Repository: `D:\Github\jarvis`
- HEAD: `eb75fab` — “Windows support, loopback-only bridge, and a voice dismissal”
- Worktree state at audit: 51 uncommitted entries — 23 modified tracked files, 28 untracked entries
- Phase: 0 (audit and design only)
- Change policy: no code, dependency, model, database, port, or configuration changes were made

## 1. Executive summary

JARVIS is already a working, unusually complete local voice-assistant shell. Its
strongest parts are the browser interface, the always-open voice loop, the
deterministic fast-command router, the permission-gated tool bridge, and the
provider-independent AI gateway. These are real assets and should not be
replaced.

The main weakness is not capability. It is **intelligence infrastructure**:

- memory retrieval is explicit and `LIKE`-based, with no FTS5, BM25, vector, or
  hybrid ranking;
- there is a performance ledger, but no per-turn trace with steps, outcomes, and
  feedback;
- routing is rule-based and static, with no evidence-driven policy;
- there is no general scheduler, learning loop, or privacy-aware data-egress
  control beyond the current cloud-data switch;
- the bridge is a 2,115-line central module that is becoming the place where
  every concern meets.

The safest next step is therefore **not** a rewrite and **not** a new agent
framework. It is an additive observability and retrieval foundation behind
feature flags, with the existing deterministic paths remaining the fallback.

## 2. What is known to work

The following are confirmed from source code and project documentation. They
were not exercised end-to-end during this audit because JARVIS was not running.

### Interface and voice

- React 19 + Vite 8 + Three.js holographic interface with boot sequence, HUD,
  panels, orbit, reactor controls, and diagnostics.
- Single continuous voice loop with wake, command, guard, and deaf modes.
- Local energy-based VAD for barge-in on the ElevenLabs path.
- Browser `SpeechRecognition` fallback with heartbeat, backoff, offline hold,
  language roll, and reconnect behavior.
- Echo rejection by transcript comparison rather than acoustic cancellation.
- Utterance assembly that treats pauses as part of a thought rather than a
  sentence boundary.
- Sentence-streamed speech output with system voice, Kokoro, and ElevenLabs
  tiers; cancellation and fallback are explicitly handled.
- Boot-time capability probe through `GET /health`.

### Bridge and orchestration

- Node ESM bridge bound to `127.0.0.1`, default port `8787`.
- WebSocket plus HTTP endpoints for health, systems, speech, media, files, and
  Google OAuth.
- Origin allowlist and a deliberate no-Origin policy.
- Four-level request path:
  1. exact browser/weather commands;
  2. direct reminders, memory, preferences, tabs, and project reads;
  3. local brain plus generated HUD tools;
  4. brain-only conversation.
- `opencode run --format json` as the default local/free brain runner, with the
  prompt sent over stdin and session continuation.
- Provider-independent AI gateway with `free_only` billing mode by default,
  OpenRouter and NVIDIA OpenAI-compatible adapters, redacted errors, timeout
  cancellation, and local fallback.
- Tool gate: read-only built-ins, `JARVIS_ALLOW_WRITES=1` requirement for effects,
  per-server allowances, and a spoken-confirmation backstop for destructive
  tools.
- Browser control through a local CDP adapter, with tab persistence and a
  loopback TCP bridge.
- Google Gmail/Calendar through server-side OAuth; tokens are not sent to the
  page.
- Weather fast path through Open-Meteo with a ten-minute cache.
- Windows notifications, launchers, detached start, and process ownership.

### Persistence and diagnostics

- SQLite through `node:sqlite`, WAL mode, ordered migrations tracked by
  `PRAGMA user_version`.
- Existing tables include `preferences`, `projects`, `project_tasks`, `memory`,
  `command_history`, `notifications`, `app_shortcuts`, `performance_logs`, and
  `browser_tabs`; related modules also use `notes` and `google_tokens`.
- Every handled command records timings and success in `command_history` and
  `performance_logs`.
- `/systems` and `services_status` expose a live health picture.
- Voice and TTS publish live diagnostic state on `window.__voice` and
  `window.__tts`.

## 3. What is broken, weak, or unverified

### Runtime verification gaps

- JARVIS was not running during the audit.
- Ports `8787` and `5173` were not listening.
- The Ollama daemon was not running.
- Chrome and Edge executables were not found on `PATH`; the CDP path is
  therefore unverified on this machine.
- No `.env` is present; only `.env.example`. Some behavior may depend on
  environment state outside the repository.
- `jarvis-secrets.cmd` exists and may contain credentials. It was not read and
  must not be inspected or committed.

### Worktree and delivery risk

- The repository has 51 uncommitted entries, including core new bridge modules
  and generated `bridge/.oc/` files.
- There is no clean checkpoint. Any implementation work must begin with an
  approved backup or branch, not with edits on top of this state.
- Untracked smoke scripts (`scripts/_repro.mjs`, `_smoke_prefs.mjs`,
  `_ws_chain.mjs`, `_ws_test.mjs`) are not a formal regression suite.

### Memory and learning gaps

- `memory_search` is `LIKE` matching against content/category, ordered by
  importance and update time.
- Project search is `LIKE` matching against name, description, and
  technologies.
- There is no FTS5 index, BM25 score, synonym/alias expansion, vector search, or
  hybrid rank fusion.
- Preferences, notes, memory, and projects overlap conceptually and have
  different retrieval paths.
- Memory is explicit-write only. There is no controlled extraction, dedupe,
  decay, or consolidation.
- There is no trace store, no step-level outcome capture, and no feedback-driven
  routing policy.

### Routing and intelligence gaps

- The fast router is strict and deterministic, which is good, but it is
  manually maintained.
- The AI gateway classifies requests into safety/local/tools/simple/reasoning,
  but model selection is not evidence-driven.
- There is no model registry with measured latency, success rate, privacy class,
  and capability metadata.
- There is no confidence score or explanation stored for routing decisions.
- Cloud routing is governed by `free_only` and `AI_CLOUD_DATA`, but there is no
  per-turn privacy classification or egress explanation.

### Architecture and operations gaps

- `bridge/server.mjs` is 2,115 lines and owns transport, turns, permissions,
  tools, speech, OAuth, and media.
- There is no general scheduler; notifications only cover their specific queue.
- There is no event bus linking inference, tool, memory, and trace events.
- There is no local telemetry aggregate beyond the performance ledger.
- There is no formal benchmark harness or baseline record for this hardware.
- The default brain calls opencode’s free cloud tier. “Local-first” currently
  means local control and local data ownership, not guaranteed local inference.
- The original project description and some comments still mention Claude in
  places where the implementation has moved to opencode.

## 4. What must be preserved

These are compatibility contracts. Changing them requires a separate approved
phase and a migration plan.

| Area | Contract to preserve |
|---|---|
| UI | Existing React/Three.js interface, HUD markup contract, diagnostics shortcuts |
| Protocol | WebSocket frame types, per-question IDs, reconnect behavior |
| Ports | Default bridge `8787`, dev UI `5173`; no port changes in the first phase |
| Database | `data/jarvis.db`, existing table names, ordered migrations |
| Voice | Wake/command/guard/deaf modes, barge-in, echo rejection, fallback tiers |
| TTS | Sentence streaming, cancellation, cache, system/Kokoro/ElevenLabs tiers |
| Router | Exact Level 1/2 commands and strict whole-phrase behavior |
| Brain | `opencode run` stdin prompt flow, session continuation, model override |
| Tools | Eleven HUD servers and existing tool names |
| Permissions | Read/write split, `JARVIS_ALLOW_WRITES`, destructive confirmation |
| AI policy | `free_only` default, no silent paid fallback, local fallback |
| Security | Loopback bind, origin checks, SSRF guards, file-root confinement, CSP |
| Secrets | Server-side only; never shipped to the browser; never written to logs |
| Launchers | Existing Windows start/show/stop scripts and process ownership |
| Data | Existing user preferences, memory, projects, tasks, and tabs are not migrated or reset without a backup |

## 5. Component inventory

| Component | Path | Role | Audit note |
|---|---|---|---|
| Bridge entry | `bridge/server.mjs` | WebSocket/HTTP, turns, permissions, speech | Working but monolithic; preserve |
| Router | `bridge/router.mjs` | Deterministic Level 1/2 commands | Strong asset; extend carefully |
| AI gateway | `bridge/ai.mjs` | Classification and provider policy | Good base for intelligence layer |
| Providers | `bridge/providers.mjs` | OpenRouter/NVIDIA streaming adapters | Preserve |
| Brain runner | `bridge/runner.mjs` | Headless opencode turn | Preserve |
| Database | `bridge/db.mjs` | SQLite, WAL, migrations | Preserve; additive migrations only |
| Memory | `bridge/memory.mjs` | Facts, projects, tasks | Replace retrieval behind an interface |
| Preferences | `bridge/preferences.mjs` | Standing preferences and notes | Preserve; clarify ownership |
| Performance | `bridge/perf.mjs` | Command timing ledger | Extend into traces, do not replace |
| HUD tools | `bridge/hudtools.mjs` | Generated MCP tools | Preserve names and schemas |
| Browser | `bridge/chrome.mjs`, `chrome-cdp.mjs` | CDP control and tabs | Verify on this machine |
| Google | `auth.mjs`, `gmail.mjs`, `calendar.mjs` | OAuth, mail, calendar | Preserve server-side token handling |
| Notifications | `bridge/notifications.mjs` | SQLite queue and Windows balloons | Preserve; scheduler is separate |
| Weather | `weather.mjs`, `weather-core.mjs` | Open-Meteo fast path | Preserve |
| Media proxy | `net.mjs`, `page.mjs` | SSRF-guarded fetch and reading | Preserve |
| UI | `src/App.tsx`, `src/ui/` | Interface and diagnostics | Preserve |
| Voice | `src/lib/voice.ts` | Wake, VAD, barge-in, fallback | Preserve; do not rewrite |
| TTS | `src/lib/tts.ts` | Streaming speech and fallbacks | Preserve |
| Protocol | `src/lib/bridge.ts` | WebSocket client | Preserve |
| Config | `src/config.ts` | Frontend environment | Preserve |
| MCP docs | `mcp/README.md` | Tool and permission reference | Treat as current contract |

## 6. Environment constraints

- Target machine: Dell Inspiron 3501, Intel i3-1005G1, 8 GB RAM, Intel UHD
  graphics, no dedicated GPU.
- Limited space on `C:`; all project work belongs on `D:`.
- Node `v24.14.0`, npm `11.9.0`, opencode CLI `1.19.4`, Ollama client `0.32.14`
  with daemon not running.
- `rg` is not available in this PowerShell environment.
- `D:\Github\openjarvis-reference` is a read-only study clone.
- `D:\AI\colibri` does not exist; the colibri comparison cannot be completed.
- No Docker, no paid API, no heavy install, no model download without approval.

## 7. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Implementation overwrites uncommitted work | High | High | Backup/branch first; no edits before approval |
| New retrieval changes answers subtly | Medium | Medium | Feature flag, A/B compare, deterministic fallback |
| Trace logging captures private content | Medium | High | Content off by default; redaction and retention limits |
| Cloud routing leaks private data | Medium | High | Privacy class gate, explicit consent, no-content telemetry |
| Memory schema migration corrupts data | Low | High | Copy DB, additive migration, rollback test |
| Router learning makes bad choices | Medium | Medium | Minimum samples, bounded exploration, deterministic fallback |
| More modules slow the 8 GB machine | Medium | Medium | Small SQLite/FTS5 design; no local embedding model by default |
| Chrome path remains unverified | High | Medium | Resolve executable path before browser benchmarks |
| opencode free tier changes | Medium | High | Keep provider-independent gateway; degrade to honest error |
| Secret exposure during debugging | Low | Critical | Never read `jarvis-secrets.cmd`; scan logs; redact errors |

## 8. Audit exit criteria

Phase 0 is complete when:

- all nine design documents exist under `docs/jarvis-2-upgrade/`;
- the current behavior and compatibility contracts are recorded;
- OpenJarvis features are classified as adopt/adapt/defer/reject;
- the first implementation phase is observability-only and reversible;
- no runtime, dependency, database, or configuration change has been made;
- the user has approved the next phase.

## 9. Explicit non-actions

This audit did not:

- start or stop JARVIS;
- install or upgrade a dependency;
- download a model;
- migrate or modify `data/jarvis.db`;
- change ports, environment files, or configuration;
- read `jarvis-secrets.cmd`;
- commit, revert, or stage any file;
- copy code from OpenJarvis.
