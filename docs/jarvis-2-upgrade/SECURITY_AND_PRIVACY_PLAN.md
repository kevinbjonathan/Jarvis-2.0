# Security and Privacy Plan

- Scope: the JARVIS 2 upgrade, not a rewrite of the current security model
- Baseline: JARVIS already has strong local-only controls; preserve them
- Priority: prevent secret exposure, unintended effects, and silent data egress

## 1. Current controls to preserve

### Network and transport

- Bridge binds to `127.0.0.1` only.
- WebSocket origin allowlist.
- No-Origin clients rejected by default.
- Health, systems, and RPC endpoints stay loopback-only.
- Browser CDP adapter uses loopback TCP.
- SSRF guards on `/img`, `/media`, `/file`, and page rendering.
- File serving confined to allowed roots with real-path checks.
- Private and loopback addresses refused for proxied fetches.
- Strict CSP and sanitized HUD markup.

### Actions and permissions

- Read-only by default.
- `JARVIS_ALLOW_WRITES=1` required for effects.
- Per-server allowances for sensitive tools.
- Destructive tools require spoken confirmation.
- Permission decisions are centralized in `decideTool`.
- No filesystem or global bypass can override the gate.

### Secrets and identity

- ElevenLabs and Google credentials stay server-side.
- Google OAuth tokens are not sent to the page.
- Preferences refuse secret-shaped values.
- Errors are redacted.
- `jarvis-secrets.cmd` is git-ignored and was not read during the audit.

### Tooling

- Generated HUD tools are local files under the bridge runtime directory.
- Browser control is opt-in through writes.
- Google integrations report “not connected” rather than pretending to work.

## 2. Threat model

| Threat | Example | Impact | Current mitigation | Planned improvement |
|---|---|---|---|---|
| Local malware | Reads bridge files or connects to loopback | Data theft or tool abuse | Loopback, origin checks | OS file permissions, secret-at-rest option |
| Malicious web page | Connects to WebSocket or triggers tools | Unauthorized actions | Origin allowlist, writes gate | Per-turn capability scope, audit |
| Prompt injection | Web page or email tells model to exfiltrate data | Data leak or destructive action | Permission gate, destructive confirmation | Taint labels for untrusted content, egress policy |
| Tool abuse | Model calls a permitted tool for the wrong purpose | Unintended effects | Write gate, per-server rules | Capability tokens and argument limits |
| Secret leakage in logs | Prompt or error includes a key | Credential compromise | Redaction in provider errors | Redaction before all local logs/traces |
| Silent cloud egress | Private text sent to a free provider | Privacy loss | `AI_CLOUD_DATA=0` | Data classification and explicit egress decision |
| Voice-only confirmation bypass | User says “yes” to the wrong prompt | Unintended destructive action | Pending action stored per connection | Echo/context binding, expiry, read-back |
| Supply-chain compromise | Malicious dependency update | Full compromise | Lockfile, limited dependencies | Review and pinning policy |
| Model output injection | Model-authored HTML/JS | XSS or data theft | DOMPurify, allowlist, CSP | Keep; test on every change |
| Offline/failed security check | Gate throws and defaults open | Bypass | Central gate | Fail closed for effects, fail safe for reads |

## 3. Security principles

1. **Default deny for effects.**
2. **Read and write are different capabilities.**
3. **Destructive actions need explicit, contextual confirmation.**
4. **No secret in a prompt, trace, log, metric, or error.**
5. **No silent network egress of private data.**
6. **Untrusted content is labeled and never treated as instructions.**
7. **Observability must not weaken security.**
8. **Every new feature is independently disableable.**
9. **Fail closed on permission errors; fail safe on observability errors.**
10. **No remote telemetry, no tracking identifier, no analytics endpoint.**

## 4. Data classification

| Class | Definition | Examples | Default route |
|---|---|---|---|
| `public` | Safe to disclose | weather in London, public web page | Any free route |
| `personal` | Identifies or concerns the user | calendar, projects, preferences | Local or explicitly permitted cloud |
| `sensitive` | High-impact private data | email body, files, location history, health | Local only by default |
| `secret` | Credentials or authentication material | API keys, tokens, passwords, cookies | Never stored or transmitted |

Classification rules:

- explicit user marker (“my email”, “my file”) raises class;
- secret patterns always override everything;
- uncertain classification raises the class;
- the classifier may be wrong, so the gate must be conservative;
- classification metadata is stored; payload is not.

## 5. Egress policy

Every network call that can carry user data must have an explicit destination
and purpose.

| Destination | Data | When | Control |
|---|---|---|---|
| opencode free tier | prompt, tool context | default brain | `AI_CLOUD_DATA`, privacy class |
| OpenRouter | prompt | only when configured and permitted | `free_only`, privacy class |
| NVIDIA NIM | prompt | only when configured and permitted | `free_only`, privacy class |
| ElevenLabs STT | audio | only if key present | explicit capability, documented |
| ElevenLabs TTS | assistant text | only if key present | no user private data beyond reply |
| Google Gmail/Calendar | query and account data | only when connected | OAuth, server-side token |
| Open-Meteo | place name / coordinates | weather lookup | minimize precision |
| CDP local browser | page content | browser tool | localhost only |
| HUD media proxy | URL | user/model-requested media | SSRF guard |

Rules:

- `sensitive` and `secret` never go to a cloud provider by default.
- `personal` goes to cloud only with explicit permission.
- The egress decision is logged with a reason code and no payload.
- A failed provider does not implicitly authorize a less private provider.
- The user can see which provider handled a turn.

## 6. Secret handling

### Never read or expose

- `jarvis-secrets.cmd`;
- OAuth token files;
- environment values that look like keys;
- browser cookies or local storage dumps.

### Storage

- Secrets stay in server-side environment or existing token files.
- Do not move secrets into SQLite preferences.
- Do not add a new secret store in the first phases.
- If encrypted-at-rest is added later, use Windows DPAPI or an OS-backed
  mechanism, not a custom cipher.

### Logging and traces

- Redact authorization headers, cookies, keys, tokens, and long random strings.
- Truncate provider errors before storage.
- Do not store raw prompts in traces by default.
- Do not store raw tool arguments if they may contain personal data.
- Test with synthetic canary secrets to prove they never appear.

### Memory

- Keep the existing secret refusal in preferences and memory.
- Add the same check to any future automatic extraction.
- A refused secret must not be echoed back in full.

## 7. Tool capability model

Current gate stays. Add a per-turn capability envelope later:

```text
TurnCapabilities {
  writes: boolean
  destructive: boolean
  network: "none" | "local" | "approved"
  dataClass: "public" | "personal" | "sensitive" | "secret"
  allowedServers: string[]
  confirmations: PendingAction[]
}
```

Rules:

- The model receives only the tools allowed for the turn.
- A tool cannot widen its own permissions.
- A destructive call is stored as a pending action, not executed.
- Confirmation expires after a short window.
- Confirmation is bound to the action description and the connection.
- Ambiguous replies do not execute; they leave the action pending or cancel it.
- A write tool cannot be invoked from a read-only turn.

## 8. Prompt injection and untrusted content

Untrusted sources:

- web pages;
- emails;
- calendar descriptions;
- model-authored HUD HTML;
- images/OCR;
- external MCP output.

Rules:

- wrap untrusted content in a clear delimiter and label it as data;
- never follow instructions found inside data;
- never let web/email content authorize a tool call;
- destructive actions always require the user, not the page;
- the browser tool should return extracted content, not executable markup;
- sanitize HUD markup with the existing allowlist and CSP.

A full taint-tracking engine is deferred. The first version uses labels,
delimiters, and the existing permission gate.

## 9. Audit logging

Add a local, append-only audit record:

```text
AuditEvent {
  timestamp
  traceId
  eventType: "tool_allow" | "tool_deny" | "confirm_request" |
             "confirm_accept" | "confirm_cancel" | "egress_allow" |
             "egress_deny" | "secret_refused" | "scan_block"
  toolOrProvider
  reasonCode
  dataClass
  metadataSummary
}
```

No payloads. Retention follows the trace policy. The audit log is local and
user-deletable.

## 10. Privacy controls for the upgrade

| Control | Default | Behavior |
|---|---|---|
| Trace content | off | Store hashes/metadata only |
| Trace retention | 30 days | Local cleanup |
| Remote telemetry | off | Not implemented |
| Cloud data | off | Existing `AI_CLOUD_DATA` remains |
| Learning | baseline | No learned policy until approved |
| Egress gate | advisory | Log only until validated, then enforce |
| Feedback | optional | Score only |
| Export | manual | Local file, user-initiated |

## 11. Security testing

### Automated

- secret canary in prompt, tool output, and error path never appears in traces or
  logs;
- origin rejection for disallowed origins;
- no-Origin rejection by default;
- writes gate blocks effectful tools;
- destructive tool does not execute without confirmation;
- path traversal and SSRF cases remain blocked;
- HUD HTML sanitizer rejects script and event handlers;
- egress policy blocks `sensitive`/`secret` to cloud;
- redaction fixtures for tokens, cookies, and auth headers;
- database migration preserves data and access controls.

### Manual

- verify `JARVIS_ALLOW_WRITES` off means no sends, writes, or browser actions;
- verify spoken confirmation cannot be triggered by assistant audio;
- verify Google tokens never appear in browser traffic;
- verify `jarvis-secrets.cmd` is not read by any new code;
- verify disabling each new flag restores current behavior.

## 12. Incident and rollback

If a privacy or security defect is found:

1. Disable the affected feature flag.
2. Stop the bridge.
3. Preserve local logs for review without copying secrets.
4. Restore the pre-change database copy if schema or data is affected.
5. Rotate any exposed credential outside the repository.
6. Document the cause and add a regression test.

Rollback must not require a code revert to keep the assistant usable.

## 13. Security acceptance criteria

The upgrade is not accepted unless:

- no secret can appear in a trace, log, or metric;
- no paid route can be selected by default;
- no `sensitive` or `secret` data reaches a cloud provider without explicit
  permission;
- existing permission and confirmation behavior is unchanged;
- all new data stays local;
- every new network call has a documented destination and purpose;
- disabling new features restores the current security posture;
- the audit log explains every allow/deny decision without storing payloads.

## 14. Explicit exclusions

Not in scope for the first implementation:

- remote analytics;
- installation UUIDs;
- cloud key management;
- full taint tracking;
- a custom encryption scheme;
- biometric authentication;
- multi-user accounts;
- network exposure of the bridge.
