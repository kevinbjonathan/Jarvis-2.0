# JARVIS 2 Upgrade Architecture

- Status: proposed
- Scope: additive upgrade to the existing JARVIS, not a replacement
- Runtime constraint: two Node/browser processes, no Docker, 8 GB RAM, no GPU
- Cost constraint: zero spend; free/local routes only
- Compatibility constraint: existing UI, protocol, tools, database, voice, and
  permissions remain valid

## 1. Goals

1. Make every turn observable: route, model, tools, memory, latency, outcome.
2. Make memory retrieval meaningfully better without a vector database.
3. Make routing evidence-driven while retaining the deterministic router as the
   permanent fallback.
4. Make data egress explicit and privacy-aware.
5. Keep the current assistant fully usable if every new module is disabled.
6. Add no paid service, no Docker container, no heavy dependency, and no
   mandatory model download.

## 2. Non-goals

- Replacing the React/Three.js interface.
- Replacing the voice pipeline or bridge protocol.
- Replacing the deterministic router.
- Replacing opencode as the default brain.
- Introducing multi-agent autonomy, workflows, A2A, or operators.
- Training or fine-tuning a model.
- Adding a remote analytics service.
- Adding a vector database or GPU dependency.
- Migrating existing user data by destructive rewrite.

## 3. Design principles

### 3.1 Preserve the working system

The existing path remains the product. New code observes or wraps it. A feature
flag must be able to return the system to today’s behavior without a database
rollback.

### 3.2 Local-first, not cloud-first

“Local-first” means local control, local storage, and local fallback. The current
default brain (opencode free tier) is a network service; the architecture must
state that plainly and must not send private data to it by default.

### 3.3 Additive data, reversible migrations

New tables and indexes are added through the existing ordered migration system.
Existing columns are not removed or rewritten in the first phases. A database
copy is taken before any migration.

### 3.4 Observer isolation

Trace, telemetry, and learning code must never be able to break a turn. Failures
are logged locally and the assistant continues.

### 3.5 Deterministic fallback everywhere

The fast router and the existing AI gateway remain the safe path. The learned
policy can only rank permitted options, and only after minimum evidence.

### 3.6 Small data, small memory

FTS5 and metadata ranking first. Optional embeddings only if a future benchmark
shows a real benefit on this hardware. No resident vector service.

### 3.7 Explain the decision

Every turn stores a short route reason: exact rule, classifier category, policy
choice, fallback reason, privacy block, or permission denial.

## 4. Target architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│ Browser (existing)                                                 │
│ voice loop · TTS · HUD · diagnostics · WebSocket client            │
└───────────────────────────────┬────────────────────────────────────┘
                                │ existing WS/HTTP protocol
┌───────────────────────────────▼────────────────────────────────────┐
│ Bridge (existing, same process)                                    │
│                                                                    │
│  Transport / turn lifecycle                                        │
│      │                                                             │
│      ├── Safety + privacy gate                                     │
│      │       ├── writes / destructive confirmation (existing)      │
│      │       └── egress classification (new, advisory first)       │
│      │                                                             │
│      ├── Route orchestrator (new, thin)                            │
│      │       ├── exact fast router (existing, first)               │
│      │       ├── intelligence classifier (existing + new features) │
│      │       ├── policy ranker (new, optional)                     │
│      │       └── fallback ladder                                   │
│      │                                                             │
│      ├── Brain / engine                                            │
│      │       ├── opencode runner (existing)                        │
│      │       ├── free cloud gateway (existing)                     │
│      │       └── disabled/local options (future, opt-in)           │
│      │                                                             │
│      ├── Tools (existing HUD + browser + Google + weather)         │
│      │                                                             │
│      ├── Memory service (existing tools, new retrieval backend)    │
│      │       ├── preferences / notes / projects / tasks (existing) │
│      │       └── FTS5 + BM25 + metadata ranking (new)              │
│      │                                                             │
│      └── Observability (new)                                       │
│              ├── event bus                                         │
│              ├── trace writer                                      │
│              ├── local telemetry                                   │
│              └── learning aggregates                               │
│                                                                    │
│  SQLite: existing tables + additive trace/memory/policy tables      │
└────────────────────────────────────────────────────────────────────┘
```

No new process. No new port. No second database.

## 5. Layers and responsibilities

### 5.1 Interface layer (unchanged)

`src/App.tsx`, `src/ui/*`, `src/lib/voice.ts`, `src/lib/tts.ts`,
`src/lib/bridge.ts`, and `src/store.ts` keep their contracts. The interface may
later display a route explanation or feedback control, but that is not required
for Phase 1.

### 5.2 Transport and turn lifecycle

`bridge/server.mjs` remains the WebSocket owner. The first implementation should
wrap the existing turn path with a trace context rather than split the file.
Extraction of modules is a later refactor, not a prerequisite.

### 5.3 Safety and privacy gate

Order of checks:

1. Existing origin and loopback checks.
2. Existing write and destructive-tool checks.
3. New: classify data sensitivity.
4. New: decide whether the chosen provider is allowed to receive it.
5. If not allowed, choose a local/redacted route or refuse with a clear message.

The first version of the privacy gate is advisory and logged, not silently
blocking, until its classifications are validated. Explicit blocks apply only to
obvious secret material.

### 5.4 Route orchestrator

A thin function, not a new agent:

```text
handleTurn(text, context):
  if safety rule matches -> safety response
  if exact router matches -> execute router result
  classify(text)
  candidateRoutes = allowedRoutes(classification, privacy, writes, health)
  route = policy.choose(candidates) or baseline(candidates)
  execute(route)
  trace(route, result)
```

The orchestrator must be callable from the existing `ask` handler without
changing the WebSocket protocol.

### 5.5 Intelligence and policy

- The existing classifier supplies coarse categories.
- New lexical features improve classification without a model download.
- A model registry records provider, locality, free status, context, capabilities,
  privacy class, and measured performance.
- A policy ranker uses trace aggregates only after minimum sample counts.
- The baseline route is always the deterministic choice.

### 5.6 Brain and engines

- Default: existing `opencode run` runner.
- Existing free cloud gateway remains available for simple conversation under
  `free_only`.
- No paid provider is added.
- Ollama remains optional and out of scope until the user explicitly approves a
  model download and memory budget.
- The runner contract does not change: stdin prompt, JSON output, session id.

### 5.7 Tools

The eleven HUD servers keep their names and schemas. New trace events wrap tool
calls but do not alter their arguments or results. The permission gate remains
the single authority.

### 5.8 Memory service

Expose one internal interface:

```text
MemoryStore {
  save(record)
  get(id)
  update(id, patch)
  delete(id)
  search(query, options) -> ranked records with scores and snippets
  list(options)
  health()
}
```

Backends:

- `SqliteMemoryStore` — existing tables plus FTS5.
- Future `HybridMemoryStore` — FTS5 plus optional local embeddings.
- No vector backend in the first implementation.

Callers (tools and router) keep their public tool names.

### 5.9 Observability

- In-process event emitter with a bounded event set.
- Trace writer with a trace row and ordered steps.
- Local telemetry aggregates: route, model, latency, tokens when available,
  tool calls, outcome, privacy class.
- No remote endpoint.
- No chat content in telemetry by default.

### 5.10 Learning

- Aggregates from traces.
- Reward from explicit feedback, tool success, retry count, and latency.
- Policy updates only within permitted routes.
- Minimum samples, decay, and reset.
- Deterministic fallback if data is stale or insufficient.

## 6. Data architecture

All additions go into the existing `data/jarvis.db` through ordered migrations.

### 6.1 Proposed tables

| Table | Purpose | Content policy |
|---|---|---|
| `traces` | One row per turn | Query text optional; metadata redacted |
| `trace_steps` | Ordered route/tool/memory/speech steps | Inputs/outputs summarized, not raw secrets |
| `traces_fts` | FTS5 index for trace search | Derived from traces |
| `memory_fts` | FTS5 index over memory content | Derived from memory |
| `projects_fts` | FTS5 index over project text | Derived from projects |
| `model_stats` | Aggregate route/model performance | Counts and timings only |
| `routing_decisions` | Explainability record per turn | Reason codes, no private content |
| `feedback` | Optional user/tool outcome signal | Score and source |
| `privacy_events` | Egress decisions and blocks | Classification, no payload |

### 6.2 Retention

- Traces: default 30 days, configurable locally.
- Telemetry: default 90 days.
- Feedback: retained until user deletes it.
- Raw content: off by default; if enabled, local only and deletable.
- No automatic upload.

### 6.3 Migration rules

- Take a copy of `data/jarvis.db` before the first additive migration.
- Use the existing `PRAGMA user_version` mechanism.
- Migrations are idempotent and forward-only.
- New indexes are created after data backfill.
- A failed migration leaves the old schema usable.
- Existing tables are not renamed in the first phase.

## 7. Runtime flows

### 7.1 Fast command

```text
speech -> bridge ask -> exact router -> local action -> trace step -> response
```

Budget: no additional noticeable latency. Trace write is asynchronous or deferred
to turn end.

### 7.2 Brain turn

```text
speech -> bridge ask -> safety/privacy -> classifier -> allowed routes
       -> opencode or free cloud -> tool calls -> trace -> response
```

Every tool call emits start/end steps. A failed tool does not fail the turn
unless the model chooses to report failure.

### 7.3 Memory retrieval

```text
query -> normalize -> FTS5/BM25 + type/recency/importance boosts
      -> optional alias expansion -> top-k with snippets
      -> prompt context or tool response -> trace memory step
```

### 7.4 Learning update

```text
turn end -> trace stored -> feedback/outcome attached
         -> aggregate updated -> policy refreshed if enough samples
         -> next turn may use policy, with fallback
```

## 8. Configuration surface (proposed, not yet added)

All new settings must default to safe values and be optional.

| Setting | Default | Meaning |
|---|---|---|
| `JARVIS_TRACES` | `1` | Write local traces |
| `JARVIS_TRACE_CONTENT` | `0` | Store query/result text |
| `JARVIS_TRACE_RETENTION_DAYS` | `30` | Local retention |
| `JARVIS_MEMORY_FTS` | `0` | Use FTS5 retrieval when enabled |
| `JARVIS_MEMORY_HYBRID` | `0` | Enable later hybrid ranking |
| `JARVIS_ROUTING_POLICY` | `baseline` | `baseline` or `learned` |
| `JARVIS_PRIVACY_GATE` | `advisory` | `off`, `advisory`, `enforce` |
| `JARVIS_TELEMETRY` | `local` | `off` or `local`; no remote value |

No environment file is changed in Phase 0.

## 9. Failure isolation

| Failure | Behavior |
|---|---|
| Trace database locked | Log locally; answer normally |
| FTS index missing | Fall back to existing `LIKE` search |
| Policy has too few samples | Use deterministic baseline |
| Policy suggests disabled route | Filtered out before ranking |
| Privacy classifier uncertain | Use existing behavior; log advisory |
| New module throws | Catch at boundary; no turn failure |
| Migration fails | Keep old schema; require manual review |
| opencode unavailable | Existing honest error or free-cloud fallback |

## 10. Performance budgets

| Area | Budget |
|---|---|
| Fast router added overhead | < 5 ms |
| Trace write at turn end | < 10 ms typical |
| FTS5 memory query | < 25 ms for 10k records |
| Memory RAM increase | < 50 MB over baseline |
| Trace storage | < 5 MB per 1,000 turns with content off |
| New dependency count | 0 for Phase 1 and 2 |

These are targets to validate, not claims.

## 11. Security architecture

- Existing loopback, origin, SSRF, file-root, and CSP controls remain.
- New trace and telemetry stores are local files with the same data-directory
  protections as the database.
- Redaction runs before any trace/telemetry write.
- Cloud egress receives a privacy classification and a reason code.
- Secret-shaped values are refused by memory/preferences as they are today.
- No secrets in traces, logs, metrics, or model prompts.
- No new remote endpoint.

## 12. Compatibility contract

The upgrade is compatible only if all of these remain true:

- existing WebSocket frames and question ids work unchanged;
- existing tools keep their names and argument schemas;
- existing database rows remain readable;
- existing voice modes and barge-in behavior are unchanged;
- existing launchers and ports work;
- `JARVIS_ALLOW_WRITES` still gates effects;
- destructive tools still require spoken confirmation;
- `free_only` still prevents silent paid routing;
- disabling all new flags returns the system to today’s behavior.

## 13. Recommended first phase

**Phase 1 — observability foundation, no behavior change.**

- Add event emitter and trace context.
- Add additive trace tables and local telemetry aggregates.
- Wrap existing router, brain, tools, and memory calls with trace steps.
- Keep content logging off by default.
- Add benchmark scripts that read the new tables.
- No retrieval change, no routing change, no UI change.

This produces the data needed to justify every later change and is fully
reversible.
