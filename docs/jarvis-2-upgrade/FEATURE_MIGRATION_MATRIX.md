# Feature Migration Matrix

- Purpose: decide which OpenJarvis ideas enter JARVIS, in what form, and in what
  order
- Decision vocabulary:
  - **Adopt** — implement with small, JARVIS-native changes
  - **Adapt** — borrow the idea but change the design for this hardware and app
  - **Defer** — valuable, but not before the foundation exists
  - **Reject** — incompatible with cost, privacy, hardware, or architecture

## 1. Summary

| Decision | Count | Themes |
|---|---:|---|
| Adopt | 7 | traces, FTS5, events, feedback, audit, local metrics, memory interface |
| Adapt | 6 | routing policy, hybrid retrieval, scanners, model registry, scheduler prep, hardware-aware selection |
| Defer | 6 | scheduler, multi-agent, workflows, A2A, vector embeddings, taint tracking |
| Reject | 8 | remote telemetry, UUID tracking, energy metrics, Docker, Python runtime, paid routes, mining, autonomous loops |

## 2. Detailed matrix

| # | OpenJarvis feature | Observed value | JARVIS gap | Decision | JARVIS-native design | Phase | Risk | Success measure |
|---|---|---|---|---|---|---|---|---|
| 1 | Five-primitive architecture | Clear separation of intelligence, engine, agents, memory, learning | Layers implicit inside bridge modules | Adopt as vocabulary | Document and name layers; no new process | 0 | Low | Design docs use consistent terms |
| 2 | Event bus | Decouples producers from observers | No shared event stream | Adopt, minimal | In-process emitter; bounded event set; observer isolation | 1 | Low | A failing subscriber cannot fail a turn |
| 3 | Trace store | Explains a whole interaction | Only performance rows | Adopt, reduced | `traces` + `trace_steps`; same DB; additive migration | 1 | Low | Every turn has a trace id and route reason |
| 4 | Trace FTS5 | Fast search over past interactions | No trace search | Adopt | External-content FTS5 with triggers | 1 | Low | Query returns ranked traces under 25 ms |
| 5 | Trace feedback | Learning signal | No user/tool outcome attachment | Adopt | Optional explicit score and automatic tool outcome | 1–3 | Medium | Feedback stored without content by default |
| 6 | Local telemetry ledger | Measured behavior over time | Timings only | Adapt | Route/model/latency/tokens/tool/outcome; no GPU or energy | 1 | Low | Aggregates answer “which route works” |
| 7 | Batched writes | Avoids write amplification | Per-command writes | Adopt where useful | Batch trace steps; flush on turn end | 1 | Low | No measurable turn slowdown |
| 8 | Memory backend interface | Replaceable retrieval | Memory logic tied to module | Adopt | Internal `MemoryStore` contract; SQLite first | 2 | Low | Callers unchanged when backend changes |
| 9 | FTS5 memory search | Better than `LIKE` | `LIKE` only | Adopt | `memory_fts` and `projects_fts` with BM25 | 2 | Low | Relevant-result rate improves in benchmark |
| 10 | Metadata boosts | Importance and recency matter | Ordering is crude | Adopt | Combine BM25 with type, importance, recency, project status | 2 | Low | Top-k judged better than baseline |
| 11 | Hybrid retrieval | FTS + semantics | No semantic layer | Adapt, staged | FTS5 + aliases/boosts first; optional embeddings later | 2–4 | Medium | No regression; optional gain measured |
| 12 | Vector database | Semantic recall | None | Defer | Only if FTS5 proves insufficient; local brute-force first | 4+ | High | Must fit <50 MB and no GPU |
| 13 | Router policy | Learns from traces | Static classifier | Adapt | Rank only permitted routes; min samples; deterministic fallback | 3 | Medium | Route success or latency improves without privacy regressions |
| 14 | Query analyzer | Structured routing features | Coarse classifier | Adapt | Lexical features, privacy markers, tool verbs, length, time sensitivity | 3 | Low | Classifier accuracy improves on fixed set |
| 15 | Learning registry | Tracks policy variants | None | Defer | Start with `model_stats` and `routing_decisions` | 3–4 | Medium | Only after enough traces exist |
| 16 | Model registry | Explainable model choice | Provider config is implicit | Adapt | Local metadata table or config: locality, free, context, capability, privacy | 3 | Low | Every chosen model has a registry entry |
| 17 | Hardware-aware selection | Fits model to machine | Manual model setting | Adapt, later | Probe RAM/CPU; never auto-download; user-approved models only | 4+ | Medium | No model exceeds memory budget |
| 18 | Scheduler | Recurring assistant tasks | Notification-only queue | Defer | Reuse turn path; needs background-call permission model | 4+ | High | No unattended spend or surprise actions |
| 19 | Security scanners | Input/output filtering | Permission gate only | Adapt, lightweight | Redaction, secret detection, egress classification, audit | 3 | Medium | Zero secrets in traces/logs |
| 20 | Audit logger | Tool decision history | Performance logs only | Adopt | Append-only local decision events with reason codes | 1–3 | Low | Every denied/allowed effect is explainable |
| 21 | Redaction modes | Prevent sensitive logging | Redaction in errors only | Adopt | Redact before trace/telemetry; content off by default | 1 | Low | Fixture secrets never appear in output |
| 22 | Taint tracking | Track untrusted data flow | None | Defer | Revisit after tool audit and egress policy exist | 4+ | High | Not before a clear threat model |
| 23 | Multi-agent / operators | Parallel autonomous work | Single brain + tools | Reject for now | Existing loop is sufficient | — | High | No token multiplication |
| 24 | Workflows / skills | Reusable automation | None | Defer | Only after a concrete repeated use case | 4+ | Medium | Demonstrated need |
| 25 | A2A protocol | Agent interoperability | None | Reject for now | No external agents in personal assistant | — | High | Reduced attack surface |
| 26 | Remote telemetry / PostHog | Fleet analytics | None | Reject | Local-only metrics | — | Critical privacy | No network analytics |
| 27 | Installation UUID | Correlation | None | Reject | No tracking identifier | — | High privacy | No persistent UUID |
| 28 | Energy / GPU / FLOPS metrics | Model-fleet efficiency | Irrelevant hardware | Reject | Do not implement | — | Low | Less code and noise |
| 29 | Docker/services topology | Isolation | None | Reject | Keep two-process Node design | — | Medium | No Docker dependency |
| 30 | Python / Rust runtime | Framework parity | Node only | Reject | Write JS modules | — | High | No second runtime |
| 31 | Paid model routing | Quality ceiling | `free_only` already blocks | Reject | Keep zero-spend policy | — | Critical cost | No paid call possible by default |
| 32 | Mining subsystem | Unrelated | None | Reject | Not applicable | — | High | Not present |

## 3. Existing JARVIS features: preserve or change

| Existing feature | Decision | Reason | Required guard |
|---|---|---|---|
| React/Three.js interface | Preserve | Works and is the product identity | No protocol-breaking changes |
| Voice loop and barge-in | Preserve | Strong, hard-won behavior | No rewrite; only trace hooks |
| TTS tiers and fallbacks | Preserve | Reliable degradation | No new mandatory engine |
| Deterministic router | Preserve and extend | Lowest latency, predictable | New policy cannot bypass it |
| AI gateway | Preserve | Provider-independent, free-only | No paid provider |
| opencode runner | Preserve | Default brain | No runner contract change |
| HUD tools | Preserve | Stable tool surface | Names and schemas unchanged |
| Permission gate | Preserve and audit | Security core | No bypass path |
| Destructive confirmation | Preserve | Voice-safe safety | No auto-confirm |
| SQLite schema | Preserve | User data | Additive migrations only |
| Memory tools | Preserve names | Compatibility | Retrieval backend swaps internally |
| Preferences/notes | Preserve | User data | Clarify ownership later |
| Notifications | Preserve | Works | Scheduler is separate |
| Google OAuth | Preserve | Server-side secret handling | No token exposure |
| Browser CDP | Preserve | Free local control | Verify executable path |
| Weather fast path | Preserve | Sub-second response | No change |
| Performance ledger | Preserve and extend | Baseline metrics | Traces supplement, not replace |
| Windows launchers | Preserve | Operational usability | No port/process change |
| Diagnostics panel | Preserve and extend | Debuggability | Add trace/route fields later |

## 4. Migration order

### Stage A — observe

- events;
- trace tables and FTS;
- local metrics;
- audit/redaction.

No user-visible behavior change. This is the first approved implementation.

### Stage B — retrieve

- memory/project FTS5;
- BM25 plus metadata boosts;
- snippet output;
- optional alias expansion;
- benchmark against `LIKE`.

Fallback: existing `LIKE` search remains available behind a flag.

### Stage C — decide

- richer query features;
- model registry;
- policy ranker over permitted routes;
- feedback capture;
- explainability record.

Fallback: deterministic baseline whenever evidence is insufficient.

### Stage D — protect and automate

- privacy gate enforcement;
- scanner hooks for web/mail content;
- scheduler only if separately approved;
- optional embeddings only if Stage B benchmarks justify them.

## 5. Entry and exit criteria

| Stage | Entry criteria | Exit criteria | Rollback |
|---|---|---|---|
| A | User approves Phase 1; DB backup exists | Every turn traced; no latency regression >5%; no content by default | Disable `JARVIS_TRACES`; new tables remain unused |
| B | Stage A data collected; benchmark set fixed | FTS5 relevance beats `LIKE`; query <25 ms; no answer regressions | Disable `JARVIS_MEMORY_FTS`; old path runs |
| C | Enough traces for min samples; privacy gate validated | Better route success/latency; no private-data regressions; explanations present | Set `JARVIS_ROUTING_POLICY=baseline` |
| D | Separate explicit approval | Security tests pass; no unattended spend; user control present | Disable each feature independently |

## 6. Features explicitly not migrating

- OpenJarvis remote telemetry and analytics.
- Installation identifiers.
- Cloud model fleet management.
- Mining.
- Energy accounting.
- Multi-agent operators.
- A2A.
- Docker topology.
- Python/Rust runtime.
- Any paid model.

## 7. Dependency policy

| Phase | New runtime dependencies | New model downloads | New services |
|---|---|---|---|
| 1 | None | None | None |
| 2 | None (SQLite FTS5 built in) | None | None |
| 3 | None | None | None |
| 4 | Only with explicit approval | Only with explicit approval | Only with explicit approval |

If a feature cannot be built under this policy, it does not enter the roadmap.
