# OpenJarvis Feature Study

- Reference clone: `D:\Github\openjarvis-reference` (read-only)
- Upstream: `https://github.com/open-jarvis/OpenJarvis`
- License: Apache 2.0 (Python core, Rust components, desktop application)
- Study date: 2026-11-03
- Rule: adapt ideas and schemas, do not copy the runtime or add its dependencies

## 1. What OpenJarvis is

OpenJarvis is a full assistant framework built around five primitives:

1. **Intelligence** — model catalog, discovery, capability descriptions.
2. **Engine** — inference backend abstraction (`InferenceEngine`).
3. **Agents** — tool-using loops and agent types.
4. **Memory** — pluggable `MemoryBackend` interface and backends.
5. **Learning** — trace-driven routing and policy improvement.

Everything else in the framework exists to connect those primitives: an event
bus, traces, telemetry, a scheduler, security scanners, channels, workflows,
operators, and an MCP surface.

This is valuable as a **design vocabulary**. It is not a good runtime fit for an
8 GB Windows laptop, and it is not a replacement for JARVIS’s working voice and
bridge design.

## 2. Observed architecture

### 2.1 Five primitives

OpenJarvis’s architecture documents make each primitive replaceable:

- model selection is separated from inference execution;
- inference execution is separated from the agent loop;
- memory is behind an interface rather than baked into prompts;
- learning consumes traces rather than hard-coding routing decisions;
- agents are compositions of the above, not the center of the system.

JARVIS already has partial equivalents: the AI gateway is an intelligence layer,
`runner.mjs` is an engine, the HUD tool loop is an agent, `memory.mjs` is a
memory implementation, and `perf.mjs` is a primitive performance record. The
missing piece is the connective tissue: events, traces, and a policy that reads
them.

### 2.2 Event bus

`src/openjarvis/core/events.py` defines a thread-safe synchronous pub/sub bus.
Events carry a type, timestamp, and dictionary payload. The taxonomy covers:

- inference start/end;
- tool call start/end;
- memory store/retrieve;
- chat exchange completion;
- agent turn start/end;
- trace step/complete;
- channel messages;
- security scan/alert/block;
- scheduler task start/end;
- workflow/skill/session events;
- timeouts, loop guards, capability denials, taint violations, rate limits;
- feedback received.

Subscribers are observers. A broken subscriber is logged and does not interrupt
the publisher. History recording is optional.

**Lesson for JARVIS:** a small in-process event emitter is enough. There is no
need for a message broker or a new process. Events should be emitted from the
existing turn path and consumed by trace and telemetry writers.

### 2.3 Trace store

`src/openjarvis/traces/store.py` uses SQLite with three structures:

- `traces`: query, agent, model, engine, result, outcome, feedback, start/end
  timestamps, token totals, latency, metadata, messages;
- `trace_steps`: ordered steps with type, timestamp, duration, input, output, and
  metadata;
- `traces_fts`: an FTS5 external-content index over query, result, and agent,
  synchronized by triggers.

Trace search tokenizes punctuation away and builds an OR query of quoted terms,
ordered by FTS5 `rank`. Feedback is a numeric score on the trace.

**Lesson for JARVIS:** this is directly adaptable. JARVIS already writes a
performance row per turn. It can add a trace id, a trace row, and step rows
without replacing `performance_logs`. FTS5 is built into SQLite and costs no
new dependency.

### 2.4 Telemetry store

`src/openjarvis/telemetry/store.py` is a detailed inference telemetry ledger:

- prompt, completion, and total tokens;
- latency, time-to-first-token, prefill and decode latency;
- throughput, inter-token latency percentiles;
- cost, energy, power, GPU utilization, memory, temperature;
- energy by CPU/GPU/DRAM/ANE/SoC and derived per-token efficiency;
- batching, warmup, token-counting version, and metadata.

Writes are batched in memory and flushed by size, time, read, or close, with a
background flusher. This is high-quality engineering for benchmarking a model
fleet.

**Lesson for JARVIS:** copy the *discipline*, not the schema. JARVIS needs a
small local telemetry table for route, model, latency, tokens (when available),
tool count, success, and privacy class. Energy and GPU metrics are not useful on
an i3 with Intel UHD graphics. Cloud analytics and an installation UUID are not
acceptable defaults for this project.

### 2.5 Learning and routing

OpenJarvis separates routing from intelligence:

- `RouterPolicy` and `QueryAnalyzer` decide how a query is handled;
- rewards come from traces, outcomes, and feedback;
- a registry tracks policy variants and their measured performance;
- routing moves from static rules toward evidence.

**Lesson for JARVIS:** the existing classifier should remain the safe baseline.
A trace-driven policy can rank only among already-allowed options, with minimum
sample counts, bounded exploration, and immediate fallback to the deterministic
path. This is preference learning, not model training.

### 2.6 Scheduler

`src/openjarvis/scheduler/scheduler.py` supports:

- `cron`, `interval`, and one-shot schedules;
- active/paused/cancelled states;
- next-run computation and due-task polling;
- isolated context by default;
- start/end events and run logs;
- execution through the same assistant `ask` path;
- pause, resume, cancel, and list operations.

**Lesson for JARVIS:** JARVIS already has a notification queue, but not a general
scheduler. A scheduler is a useful later feature, especially for “every morning
summarize my calendar.” It should not be part of the first implementation phase,
because it introduces background model calls and new permission questions.

### 2.7 Security

OpenJarvis documents:

- input/output scanners;
- redaction modes;
- audit logging;
- capability and taint concepts;
- loop and timeout guards;
- security events on the bus.

**Lesson for JARVIS:** JARVIS’s permission gate is already strong. The valuable
additions are redaction before logging, a privacy classification before cloud
egress, an audit record for tool decisions, and explicit scanner hooks for
untrusted web/mail content. Taint tracking and a full policy engine are too
heavy for the first phase.

### 2.8 Agents and engine abstraction

OpenJarvis defines agent types and an `InferenceEngine` interface with multiple
backends. This enables model/engine swapping, batch execution, and managed agent
lifecycles.

**Lesson for JARVIS:** keep the provider abstraction JARVIS already has. Do not
introduce a second agent framework. The existing “brain plus tools” loop is the
agent. A model registry can describe engines without changing the runner.

### 2.9 Telemetry consent

OpenJarvis’s telemetry documentation describes opt-in analytics, an installation
UUID, no chat content, a PostHog endpoint, and 365-day retention.

**Decision for JARVIS:** reject remote telemetry entirely. All metrics stay in
the local SQLite database. There is no installation UUID, no PostHog, no silent
upload, and no analytics endpoint. Any future export must be explicit and
user-initiated.

## 3. Adoption classification

| OpenJarvis idea | Decision | JARVIS adaptation | Why |
|---|---|---|---|
| Five-primitive vocabulary | Adopt as design language | Name layers, not processes | Clarifies boundaries without a rewrite |
| Event bus | Adopt, minimal | In-process emitter with a small event set | Decouples trace/telemetry from turn code |
| Trace + trace_steps schema | Adopt, reduced | Additive SQLite tables and FTS5 | Directly fills the observability gap |
| FTS5 trace search | Adopt | External-content FTS5 with triggers | Built-in, fast, no dependency |
| Trace feedback score | Adopt | Optional explicit feedback and tool outcome | Enables safe routing experiments |
| Telemetry ledger | Adapt, local only | Small local turn metrics; no energy/GPU/cloud | Hardware and privacy constraints |
| Batched telemetry writes | Adopt where useful | Batch trace steps, flush on turn end | Avoids write amplification |
| RouterPolicy / QueryAnalyzer | Adapt | Trace-driven ranking among allowed routes | Deterministic fallback required |
| Learning registry | Defer | Start with aggregate model stats | Too much machinery before data exists |
| MemoryBackend interface | Adapt | JS interface with SQLite/FTS5 first backend | Keeps future vector backend possible |
| Hybrid retrieval | Adapt, staged | FTS5 + BM25 + metadata boosts first; embeddings later | 8 GB RAM and no GPU |
| Scheduler | Defer | Existing notification queue stays | Background model calls need separate approval |
| Multi-agent / operators | Reject for now | Existing single brain + tools is enough | Complexity and cost outweigh value |
| Workflows/skills/A2A | Defer | Not needed for personal assistant v1 | No demonstrated use case yet |
| Security scanners | Adapt, lightweight | Redaction, audit, egress classification | High value, low dependency |
| Taint tracking / policy engine | Defer | Revisit after tool audit exists | Too heavy for first phase |
| Engine abstraction | Preserve existing | Keep AI gateway and runner | Do not add a second abstraction |
| Hardware-aware model selection | Adapt | Local capability probe plus measured stats | Useful but not first |
| Remote telemetry/PostHog | Reject | Local-only metrics | Privacy and zero-spend policy |
| Installation UUID | Reject | No persistent tracking identifier | Not needed locally |
| Energy/GPU/FLOPS metrics | Reject | Not meaningful on target hardware | Noise, not signal |
| Docker/services topology | Reject | Keep two-process Node design | No Docker, limited RAM |
| Python/Rust runtime | Reject | JavaScript modules in the existing bridge | Avoid a second runtime |

## 4. Ideas worth borrowing in detail

### 4.1 Trace as the unit of truth

A turn should have one trace id. The trace should record:

- the original query (content optional, controlled by policy);
- route chosen and why;
- model/provider actually used;
- start/end and latency;
- tool calls and their outcomes;
- memory reads and writes;
- speech timing when relevant;
- success/failure and optional feedback.

This is more useful than a performance row because it explains *what happened*,
not only *how long it took*.

### 4.2 Observer isolation

Trace and telemetry writers must never break a turn. If the database is locked or
a subscriber throws, the assistant still answers. This is the most important
lesson from the OpenJarvis event bus.

### 4.3 Ranking with a safe fallback

The learning layer should never be allowed to choose an unaffordable, private, or
disabled route. It ranks within a permitted set. With too few samples, it returns
the deterministic baseline. The baseline is always available.

### 4.4 External-content FTS5

SQLite FTS5 avoids duplicating the full memory table. Triggers keep the index in
sync. BM25 ranking, `snippet()`, and `highlight()` are available without a
server. This fits the target hardware far better than a vector database.

### 4.5 Memory as a typed system

OpenJarvis treats memory as a backend, not a table. JARVIS should expose a stable
`MemoryStore` contract even if the first implementation is SQLite + FTS5. That
allows a future local embedding backend without changing callers.

## 5. Ideas to reject

- **Python/Rust/desktop stack.** JARVIS is a Node + browser application. Adding a
  second runtime increases install size, memory, and failure modes.
- **Remote telemetry.** No analytics endpoint, no installation UUID, no silent
  upload, no 365-day cloud retention.
- **Cloud-first routing.** JARVIS must remain free-only and local-control-first.
- **Mining and energy accounting.** Irrelevant to a personal assistant on this
  hardware.
- **Autonomous multi-agent loops.** They multiply token spend and make behavior
  harder to explain.
- **Workflow/A2A/operator surfaces.** No current user need; high surface area.
- **A vector database.** A 100 MB+ service for a personal memory set is the wrong
  trade on 8 GB RAM.
- **Copying source code.** The licenses permit reuse, but the runtime and
  conventions do not fit. Borrow schemas and ideas, write JARVIS-native code.

## 6. What this study changes

It confirms that JARVIS does not need a new framework. It needs three small,
well-bounded additions:

1. **Traces and local telemetry** to make behavior observable.
2. **FTS5/hybrid memory retrieval** behind the existing memory tool contract.
3. **A policy layer** that learns from traces but always falls back to the
   deterministic router.

Everything else in OpenJarvis is either already present in a simpler form,
premature for this hardware, or contrary to the project’s privacy and zero-spend
rules.

## 7. References read

- `docs/architecture/overview.md`
- `docs/architecture/intelligence.md`
- `docs/architecture/memory.md`
- `docs/architecture/learning.md`
- `docs/architecture/security.md`
- `docs/architecture/query-flow.md`
- `docs/architecture/design-principles.md`
- `docs/architecture/agents.md`
- `docs/architecture/engine.md`
- `docs/telemetry.md`
- `src/openjarvis/core/events.py`
- `src/openjarvis/traces/store.py`
- `src/openjarvis/telemetry/store.py`
- `src/openjarvis/learning/routing/`
- `src/openjarvis/scheduler/scheduler.py`
