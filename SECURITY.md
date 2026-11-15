# Security Policy

JARVIS is a local-first, single-user assistant. It runs a trusted Node bridge on
loopback, drives a browser, and can read mail and calendar data with the user's
consent. That makes security and privacy part of the product, not an afterthought.

This document describes the supported surface, the threat model, how to report a
problem, and the limitations users should understand before enabling writes.

---

## Supported versions

| Version | Supported |
|---|---|
| `main` / current development | Yes |
| `0.0.x` snapshots | Best effort |
| Older forks or modified deployments | No |

This is a personal project, maintained on a best-effort basis. There is no
commercial SLA.

---

## Reporting a vulnerability

Please report privately. Do **not** open a public issue containing:

- an API key, OAuth token, client secret, or `.env` value;
- an email, calendar event, preference, memory row, or database excerpt;
- a working exploit against a real user's machine;
- personal data from `data/jarvis.db` or `bridge/.oc/auth/`.

Preferred channel: GitHub's **private vulnerability reporting** for this
repository, if it is enabled. If it is not, open a minimal public issue asking
for a private channel, with no vulnerability details, and the maintainer will
follow up.

A useful report includes:

- affected file or component, and the version or commit;
- a minimal reproduction with synthetic data;
- the security impact and who can trigger it;
- whether writes were enabled;
- any suggested fix or mitigation.

Do not test against systems or accounts you do not own. Do not access, modify,
or exfiltrate another person's data.

---

## Threat model

### In scope

- The bridge's WebSocket and HTTP endpoints on `127.0.0.1`.
- Origin checks, file serving, URL fetching, and SSRF defenses.
- The permission gate and destructive-action confirmation.
- OAuth token storage and use.
- Secret handling in logs, traces, errors, and status responses.
- HUD HTML sanitization and CSP.
- Trace and telemetry content policy.
- Browser automation through the CDP adapter.

### Out of scope

- An attacker who already has the user's OS account, browser profile, or
  physical access. Such an attacker can read `data/jarvis.db`, the OAuth token
  file, and the `.env` file directly.
- Malware, a compromised browser, or a compromised opencode binary.
- Vulnerabilities in Google, Open-Meteo, OpenRouter, Gemini, NVIDIA, Chrome,
  Node.js, or other upstream services.
- Prompt content produced by a model, unless it crosses a concrete security
  boundary such as unsanitized HTML or an ungated tool call.
- Denial of service against a machine the attacker already controls.
- Multi-user or internet-facing deployments. JARVIS is not designed for them.

### Trust assumptions

- The local machine and the user's browser profile are trusted.
- The bridge is single-user.
- The Google account and the user's own OAuth client are controlled by the user.
- When writes are disabled, effectful tools are denied even if the model asks.
- When writes are enabled, the model may act within the user's browser and
  Google scopes. Enabling writes is a deliberate reduction in safety.

---

## Security properties

### Local-only transport

The bridge binds to `127.0.0.1`. The WebSocket origin check and the optional
no-origin rejection are browser-convention controls, not authentication. The
network boundary is the real control. Do not bind the bridge to a LAN interface,
a container network, or the public internet.

### Default-deny actions

Read-only tools run without the write flag. Sends, mutations, browser actions,
and file effects require `JARVIS_ALLOW_WRITES=1`. Destructive tools also require
a spoken confirmation:

- `calendar_remove`
- `preferences_remove`
- `chrome_close_tab`
- `memory_delete`
- `project_delete`
- `task_delete`

The gate is centralized so a new tool cannot quietly bypass it by living in a
different module.

### File and URL handling

`/file`, `/img`, and `/media` validate schemes, confine paths to allowed roots,
resolve real paths, and refuse private or loopback addresses. Outbound fetches go
through an SSRF guard. Path traversal and `file://` access are not intended to
work.

### Sanitized model output

Model-authored HUD HTML is sanitized with DOMPurify, a class allowlist, and a
strict Content Security Policy. The model can request panels and effects; it
cannot inject arbitrary scripts into the page.

### Server-side secrets

API keys and OAuth tokens stay in the bridge. They are never sent to the browser
through the agent socket or the status endpoint. `VITE_*` values are different:
they are public to the page by design. Do not put a privileged key in a `VITE_`
variable.

### Metadata-only observability

Traces and telemetry store route, model, provider, status, duration, and
aggregate counts. Prompts, replies, tool payloads, and secrets are not stored by
default. Redaction runs before insertion. `JARVIS_TRACE_CONTENT` is reserved for
a future opt-in and is not a content archive in Phase 1.

### Cloud data boundary

Cloud conversation is optional and free-first. Preferences and retrieved
mail/calendar text are excluded from cloud turns unless `AI_CLOUD_DATA=1`. A
cloud provider still receives the user's conversational prompt; that is inherent
to using a cloud model. Local tools and local memory remain local.

---

## Known limitations

These are design limits, not hidden behavior:

1. **No authentication on the local socket.** Any local process or page that can
   reach the allowed origin and port may attempt a connection. The origin check
   raises the bar; it is not a login.
2. **The database and OAuth token are not encrypted at rest.** They rely on OS
   account and disk protections.
3. **Writes are powerful.** When enabled, the model can click, type, send, and
   mutate data within the granted scopes. There is no per-action approval dialog
   for ordinary writes; only the listed destructive tools require confirmation.
4. **Browser automation is full browser control.** The CDP adapter can navigate
   and read pages. A malicious page can still contain hostile content; retrieved
   content is treated as untrusted data, but browser bugs remain browser bugs.
5. **No sandbox for opencode.** The local brain runs as the user's process. Its
   file access is bounded by the gate for JARVIS tools, not by an OS sandbox.
6. **No multi-user isolation.** Do not expose this to other people.
7. **No auto-update.** Dependencies are updated by the maintainer; users are
   responsible for pulling and reinstalling.
8. **Upstream trust.** Google, Open-Meteo, OpenRouter, Gemini, NVIDIA, Chrome,
   Node.js, and model providers are trusted to the extent the user configures
   them.

---

## Safe deployment guidance

- Keep the default loopback bind.
- Do not put the bridge behind a public reverse proxy, even with HTTP basic auth.
- For remote access, use an SSH tunnel or a VPN that terminates on the local
  machine, and keep the bridge bound to loopback.
- Run with writes disabled unless you are actively using an action.
- Use a dedicated Chrome profile for the hidden launcher. It intentionally
  grants the microphone and denies the camera.
- Keep `.env`, `jarvis-secrets.cmd`, `bridge/.oc/auth/`, and `data/` out of Git
  and out of backups you do not control.
- Rotate a key immediately if it appears in a log, a screenshot, a terminal
  transcript, or a public issue.
- Review `decideTool()` before enabling writes, and review the tool list when you
  update.

---

## Data inventory

| Path | Contents | Protection |
|---|---|---|
| `data/jarvis.db` | Preferences, memory, projects, tasks, notifications, tabs, traces, telemetry | Git-ignored; OS file permissions |
| `data/jarvis.db-wal`, `-shm` | SQLite WAL state | Same as the database |
| `bridge/.oc/auth/google.json` | Google access and refresh tokens | Git-ignored; server-side only |
| `.env` | API keys and local configuration | Git-ignored; never sent to the page |
| `jarvis-secrets.cmd` | Launcher secrets | Git-ignored; parsed by the bridge |
| `%TEMP%\jarvis-logs\` | Detached bridge/face logs | Local logs; may contain operational metadata |
| `bridge/.oc/tools/` | Generated tool clients | Derived artifacts; git-ignored |

If you share a bug report, redact tokens, account identifiers, email subjects,
calendar titles, and absolute paths that reveal a username.

---

## Disclosure

Good-faith research is welcome. Please allow time for a fix before public
disclosure, and avoid accessing data that is not yours. The maintainer will
acknowledge a complete report on a best-effort basis, investigate, and credit the
reporter if desired.

For ordinary bugs and feature requests, use the public issue tracker. For
anything that could expose credentials, personal data, or effectful actions, use
the private channel described above.
