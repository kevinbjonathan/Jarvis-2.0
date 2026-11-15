# Implementation Roadmap

- Strategy: preserve the working assistant, add capability in small reversible
  increments
- Rule: no phase starts without explicit approval and a clean backup checkpoint
- Cost policy: zero spend; no paid API, no paid model, no mandatory download
- Hardware policy: 8 GB RAM, no GPU, limited `C:` space; work stays on `D:`

## 1. Phase 0 — audit and design (complete when approved)

### Deliverables

- `EXISTING_JARVIS_AUDIT.md`
- `OPENJARVIS_FEATURE_STUDY.md`
- `JARVIS_2_UPGRADE_ARCHITECTURE.md`
- `FEATURE_MIGRATION_MATRIX.md`
- `INTELLIGENCE_ROUTING_DESIGN.md`
- `MEMORY_AND_LEARNING_DESIGN.md`
- `SECURITY_AND_PRIVACY_PLAN.md`
- `IMPLEMENTATION_ROADMAP.md`
- `PERFORMANCE_BENCHMARK_PLAN.md`

### Exit criteria

- design reviewed and approved;
- no code, dependency, database, port, or configuration change;
- next phase explicitly authorized.

## 2. Phase 1 — observability foundation

### Goal

Make every turn observable without changing behavior.

### Scope

- in-process event emitter with a bounded event set;
- trace id per user turn;
- additive SQLite tables: `traces`, `trace_steps`, `traces_fts`,
  `routing_decisions`, `privacy_events`;
- local telemetry aggregate table;
- wrap the existing router, brain, tool, memory, and speech paths with trace
  steps;
- redaction before write;
- content logging off by default;
- benchmark scripts that read the new tables;
- retention job.

### Explicit non-goals

- no memory retrieval change;
- no routing policy change;
- no UI redesign;
- no new model;
- no new dependency;
- no scheduler.

### Files likely touched

- `bridge/db.mjs` (additive migration);
- `bridge/server.mjs` (trace hooks);
- new `bridge/events.mjs`;
- new `bridge/traces.mjs`;
- new `bridge/telemetry.mjs`;
- `bridge/perf.mjs` (link trace id, do not replace);
- `scripts/` (benchmark and migration verification);
- `docs/jarvis-2-upgrade/` (results).

### Entry criteria

- user approves Phase 1;
- worktree is backed up;
- `data/jarvis.db` is copied;
- a baseline benchmark is recorded on the target machine.

### Exit criteria

- every turn has a trace id;
- route, model, tool, memory, and latency steps are recorded;
- no secret canary appears in traces or logs;
- no behavior change when the feature flag is off;
- p95 latency regression is under 5%;
- database restore is tested.

### Rollback

- disable `JARVIS_TRACES`;
- leave additive tables unused;
- restore the database copy only if migration verification fails.

### Risk

Low. The highest risk is write overhead and accidental content capture. Both are
controlled by batching, async writes, and content-off defaults.

## 3. Phase 2 — memory retrieval

### Goal

Replace `LIKE` ranking with FTS5 + BM25 + transparent metadata boosts, behind a
flag.

### Scope

- external-content FTS5 for memory and projects;
- triggers and backfill;
- `MemoryStore` interface;
- query normalization and snippet output;
- rank fusion with importance, recency, type, and access;
- dedupe pass;
- context budget enforcement;
- benchmark against the existing `LIKE` path.

### Non-goals

- no embeddings;
- no vector database;
- no automatic fact extraction;
- no change to public tool names.

### Files likely touched

- `bridge/db.mjs`;
- new `bridge/memory-store.mjs`;
- `bridge/memory.mjs` (delegate search; keep tools);
- `bridge/router.mjs` (only if direct project reads need the new ranker);
- `scripts/` (retrieval benchmark).

### Entry criteria

- Phase 1 accepted;
- pre-migration database copy;
- fixed retrieval dataset and query set.

### Exit criteria

- precision@5 improves over baseline;
- p95 query under 25 ms on the test set;
- `LIKE` fallback works with FTS disabled;
- public tools unchanged;
- no secret stored or returned;
- no content leaves the machine.

### Rollback

- disable `JARVIS_MEMORY_FTS`;
- old `LIKE` path remains.

### Risk

Medium. Ranking changes can subtly alter answers. Feature flag, fixed benchmark,
and fallback are mandatory.

## 4. Phase 3 — routing intelligence

### Goal

Use traces to improve route selection among already-permitted options.

### Scope

- `QueryProfile` extraction;
- model registry;
- explainable `RoutingDecision` record;
- baseline vs shadow policy;
- feedback capture;
- aggregate `model_stats`;
- bounded exploration;
- privacy filtering before ranking.

### Non-goals

- no paid model;
- no automatic model download;
- no multi-agent dispatch;
- no fine-tuning;
- no scheduler.

### Entry criteria

- enough traces from Phase 1;
- privacy gate validated in advisory mode;
- fixed routing evaluation set.

### Exit criteria

- learned policy never selects a disallowed route;
- no privacy or paid-route violation;
- success not worse than baseline;
- p95 latency not worse by more than 10%;
- deterministic fallback below sample threshold;
- user can reset learned data.

### Rollback

- set `JARVIS_ROUTING_POLICY=baseline`;
- keep trace data;
- optionally clear aggregates.

### Risk

Medium. Bad feedback can reinforce bad routes. Use holdout, minimum samples,
decay, and shadow mode.

## 5. Phase 4 — privacy and security hardening

### Goal

Move from advisory egress classification to enforceable, explainable controls.

### Scope

- data-classification gate;
- redaction across all new logs/traces;
- audit events for allow/deny/confirm/egress;
- untrusted-content labels for web/email;
- capability envelope per turn;
- confirmation expiry and binding;
- security regression suite.

### Non-goals

- no full taint-tracking engine;
- no custom encryption;
- no remote key management;
- no network exposure.

### Entry criteria

- Phase 1 traces available;
- false-positive/false-negative review of the advisory classifier;
- user approval for enforcement.

### Exit criteria

- `sensitive` and `secret` cannot reach cloud by default;
- every effectful decision is auditable;
- existing permission behavior is unchanged;
- disabling the gate restores current behavior;
- all security tests pass.

### Rollback

- set `JARVIS_PRIVACY_GATE=advisory` or `off`;
- retain existing permission gate.

### Risk

Medium to high. A wrong block can make legitimate requests fail; a wrong allow can
leak data. Enforce only after measured review.

## 6. Phase 5 — optional capabilities

Only after Phases 0–4 are stable. Each item needs separate approval.

| Candidate | Value | Why defer | Prerequisite |
|---|---|---|---|
| Local Ollama model | Offline inference | RAM, disk, model download | Hardware benchmark and explicit download approval |
| Scheduler | Recurring briefings | Background model calls and effects | Permission model, cost guard, user control |
| Optional embeddings | Better semantic recall | RAM and model size | Phase 2 benchmark must show a gap |
| Trace summarization | Episodic memory | Content and retention risk | Explicit opt-in and local model |
| Workflow/skills | Repeated automation | Complexity and effect surface | Demonstrated repeated use case |

## 7. Work sequence and approval gates

| Gate | After | User decision |
|---|---|---|
| G0 | Phase 0 | Approve design and Phase 1 scope |
| G1 | Phase 1 | Review trace data and latency; approve Phase 2 |
| G2 | Phase 2 | Review retrieval benchmark; approve Phase 3 |
| G3 | Phase 3 | Review routing evaluation; approve Phase 4 |
| G4 | Phase 4 | Review security tests; decide on Phase 5 |
| G5 | Any Phase 5 item | Separate explicit approval |

No gate is implied by prior approval.

## 8. Backup and checkpoint policy

Before any implementation phase:

1. Inspect `git status`, `git diff`, and the untracked file list.
2. Create a Git branch or one approved checkpoint commit.
3. Copy `data/jarvis.db` to a timestamped local backup.
4. Record the current `/health` and `/systems` output if the bridge can run.
5. Record the baseline benchmark.
6. Do not stage or commit secrets or generated runtime files.

If the worktree cannot be cleanly checkpointed, stop and ask for a decision.

## 9. Testing strategy

### Unit

- trace writer and redaction;
- retention cleanup;
- FTS query builder;
- ranking and score components;
- route filtering and fallback;
- privacy classification.

### Integration

- full turn with exact router;
- full turn with brain and tools;
- memory save/search/get/update/delete;
- destructive confirmation;
- cloud fallback;
- feature-flag off paths.

### Manual smoke

- wake word;
- direct weather;
- direct browser command;
- memory save and recall;
- project/task round trip;
- a tool-using question;
- barge-in;
- diagnostics panel;
- bridge restart and reconnect.

### Regression gates

- no secret canary in output;
- no paid provider call;
- no schema loss;
- no change when flags are off;
- latency budgets met.

## 10. Operational constraints

- All work on `D:`.
- No Docker.
- No heavy dependency without approval.
- No model download without approval.
- No port change in Phases 1–4.
- Keep the bridge loopback-only.
- Keep writes off by default.
- Do not read `jarvis-secrets.cmd`.
- Do not commit generated `bridge/.oc/` runtime files or the database.

## 11. Definition of done for JARVIS 2 foundation

The foundation is done when:

- every turn is traceable and explainable;
- memory retrieval is better and measurable;
- routing can learn but always falls back safely;
- private data egress is classified and controlled;
- all new features can be disabled independently;
- benchmark results are recorded on the target hardware;
- the existing assistant still feels and behaves like JARVIS.

## 12. Recommended immediate next action

Stop here. Present the Phase 0 findings, obtain approval for Phase 1 only, then
create the backup checkpoint and implement observability with behavior unchanged.
