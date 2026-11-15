# Memory and Learning Design

- Goal: make JARVIS remember the right things and improve from experience
- Constraint: local SQLite, 8 GB RAM, no vector service, no remote analytics
- Principle: explicit memory first; retrieval quality before memory volume

## 1. Current state

JARVIS already stores:

- standing preferences in `preferences`;
- notes from “remember that …” in the same preference system;
- semantic facts in `memory`;
- projects in `projects`;
- project tasks in `project_tasks`;
- command timings in `command_history` and `performance_logs`;
- browser tabs and notification state.

It exposes memory, project, and task tools with stable names. Secrets are
refused. Memory is explicit-write only.

The weaknesses are:

- retrieval is `LIKE` matching, ordered by importance and update time;
- no BM25, phrase handling, stemming, snippets, or rank explanation;
- no unified notion of memory type or lifecycle;
- no dedupe or consolidation;
- no feedback loop from outcomes;
- no trace-level memory read/write record.

## 2. Memory model

Use five types. They may share storage, but they must be distinguishable.

| Type | Examples | Write path | Lifetime |
|---|---|---|---|
| Profile | name, preferences, units, location | explicit | long |
| Semantic | facts, decisions, definitions | explicit or confirmed | long, decaying |
| Episodic | “what we did”, past turns, summaries | trace-derived, opt-in | bounded retention |
| Project | projects, tasks, status, technologies | explicit | until closed/deleted |
| Procedural | route/model performance, tool reliability | automatic aggregate | decaying |

Working memory remains the current conversation/session. It is not a database
table in this design.

## 3. Ownership and boundaries

| Data | Owner | Retrieval |
|---|---|---|
| Preferences | `preferences` | direct key/value and FTS |
| Notes | `preferences` under `notes` or a dedicated view | FTS with low weight |
| Facts | `memory` | FTS + importance + recency |
| Projects | `projects` | FTS + status |
| Tasks | `project_tasks` | project-scoped query |
| Episodes | `traces` | trace FTS, not injected by default |
| Procedural | `model_stats` | aggregate only |

Rules:

- Do not duplicate a fact into multiple tables.
- Notes remain available to direct reads but do not automatically enter model
  context.
- Episodes never enter the prompt automatically until the user enables it.
- Procedural data never contains user text.

## 4. Storage design

All changes are additive to `data/jarvis.db`.

### 4.1 FTS5 indexes

Use external-content FTS5 tables so the original rows are not duplicated.

Proposed:

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  category,
  content='memory',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE projects_fts USING fts5(
  name,
  description,
  technologies,
  content='projects',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE traces_fts USING fts5(
  query,
  result,
  agent,
  content='traces',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
```

Each index needs insert/update/delete triggers, following the pattern used by
OpenJarvis. Triggers are created only after a successful backfill.

The exact column names must match the current schema before migration. The DDL
above is a design proposal, not an applied migration.

### 4.2 Retrieval metadata

Add only if the current tables lack it:

- `last_accessed_at` — for recency and decay;
- `access_count` — for usefulness;
- `source` — `user`, `tool`, `import`, `trace`;
- `confidence` — optional, for extracted facts;
- `expires_at` — optional, for temporary facts.

Do not rewrite existing rows in the first migration. Backfill with defaults.

## 5. Retrieval design

### 5.1 Baseline fallback

If FTS5 is unavailable or disabled, use the current `LIKE` query unchanged.

### 5.2 Query normalization

- trim and lowercase for matching;
- remove punctuation that breaks FTS syntax;
- tokenize into quoted terms;
- support quoted phrases;
- optional alias expansion for a small, local synonym map;
- do not use an LLM to rewrite the query.

### 5.3 Candidate generation

For each enabled index:

1. Build an FTS5 `MATCH` query.
2. Fetch top N candidates (for example 30).
3. Join back to the source table for metadata.
4. Apply hard filters: category, project, status, privacy, expiry.

### 5.4 Ranking

Use a transparent score:

```text
score =
    bm25Weight * normalizedBm25
  + importanceWeight * importance
  + recencyWeight * recency
  + typeWeight * typeBoost
  + accessWeight * accessFrequency
  + projectWeight * projectMatch
```

Suggested starting weights:

| Signal | Weight |
|---|---:|
| BM25 relevance | 0.55 |
| Importance | 0.20 |
| Recency | 0.10 |
| Type boost | 0.10 |
| Access frequency | 0.05 |

Type boosts:

- explicit fact: 1.0;
- project: 0.9;
- preference: 0.8;
- note: 0.5;
- old episode: 0.3 unless explicitly requested.

Recency uses a half-life, for example 90 days for facts and 14 days for
episodes.

### 5.5 Diversification

Avoid returning five near-duplicate facts:

- group by category or project;
- cap results per group;
- prefer distinct snippets;
- if two records are near-identical, keep the higher-confidence one and record a
  duplicate candidate.

### 5.6 Output

Return:

- id and type;
- content snippet;
- score and score components;
- source;
- updated time;
- project/task context when relevant.

The model sees a compact context block, not the raw database rows.

### 5.7 Context budget

- default top-k: 5 facts, 3 projects, 5 tasks;
- total memory context target: under 1,500 characters;
- never truncate a fact mid-sentence without an ellipsis;
- if the budget is exceeded, drop the lowest-ranked item first.

## 6. Write policy

### 6.1 Explicit writes

Unchanged:

- `memory_save`;
- `project_save`;
- `task_create`;
- `remember that …`;
- `prefer …`.

These are user-initiated and take precedence.

### 6.2 Automatic extraction

Deferred and opt-in.

If enabled later:

- extract candidate facts only from explicit user statements;
- never extract from assistant output, web pages, or emails without confirmation;
- require a confidence threshold;
- present a candidate for confirmation when the fact is personal or sensitive;
- dedupe against existing facts;
- store provenance.

### 6.3 Dedupe

- normalize whitespace and case;
- compare exact normalized content;
- use FTS similarity for near-duplicates;
- keep the older stable id unless the newer one is clearly more complete;
- never silently merge conflicting facts; keep both with provenance and mark the
  conflict.

### 6.4 Secrets

Keep the existing refusal behavior:

- passwords, tokens, PINs, API keys, private keys, recovery codes;
- secret-shaped strings;
- authentication cookies.

A secret must not be stored, echoed, traced, or sent to a model.

### 6.5 Decay and forgetting

- importance decays slowly unless reinforced;
- episodes expire by default;
- temporary facts can have `expires_at`;
- access reinforces a record but does not make it immortal;
- user deletion is immediate and complete for that record and its index entries.

## 7. Learning design

### 7.1 What is learned

Only four things:

1. Which permitted route works best for a context.
2. Which model performs best for a context.
3. Which tools succeed or fail.
4. Which memories are actually used and useful.

No model weights are trained. No user text is used for training.

### 7.2 Data flow

```text
turn
  -> trace row
  -> trace steps (route, tools, memory)
  -> outcome (success, retry, timeout)
  -> optional feedback
  -> aggregate by context bucket
  -> policy / retrieval weights update
```

### 7.3 Feedback sources

| Source | Signal | Weight |
|---|---|---|
| Explicit positive | “that was right”, thumbs up | high |
| Explicit negative | correction, “no”, thumbs down | high |
| Tool success | result accepted | medium |
| Tool failure | error or retry | medium |
| Timeout | no result | medium |
| Follow-up correction | user restates request | high |
| Silence | no signal | none |

Do not infer satisfaction from the user saying nothing.

### 7.4 Aggregate schema

```text
model_stats(
  context_bucket, route_id, model_id, provider,
  attempts, successes, failures, timeouts,
  p50_latency_ms, p95_latency_ms,
  avg_feedback, last_updated
)
```

No query text, result text, email content, or memory content.

### 7.5 Policy constraints

- minimum sample count per context;
- recency decay;
- bounded exploration;
- deterministic fallback;
- no learning on `sensitive` or `secret` contexts;
- user can reset all learned data;
- shadow mode before promotion.

### 7.6 Retrieval learning

Track which retrieved memories were referenced or repeated by the user or model.
Use that as a weak signal to adjust type and recency weights. Do not let this
override explicit user saves.

## 8. Privacy and retention

| Data | Default retention | Content |
|---|---|---|
| Preferences | until deleted | user-defined |
| Facts | until deleted | user-defined |
| Projects/tasks | until deleted | user-defined |
| Traces | 30 days | content off by default |
| Trace steps | 30 days | summaries, no secrets |
| Feedback | until deleted | score only |
| Procedural stats | 90 days | no content |

Rules:

- all storage local;
- no remote telemetry;
- no installation UUID;
- redaction before write;
- export and delete commands are local;
- backups inherit the same access controls as the database.

## 9. Interfaces

### 9.1 MemoryStore

```text
save(record) -> id
get(id) -> record
update(id, patch) -> record
delete(id) -> boolean
search(query, options) -> RankedResult[]
list(options) -> record[]
health() -> { backend, indexReady, recordCount, lastError }
```

### 9.2 Tool compatibility

Public tools keep their current names:

- `memory_save`, `memory_search`, `memory_get`, `memory_list`,
  `memory_update`, `memory_delete`;
- `project_*`;
- `task_*`.

Only the internals of `memory_search` and `project_search` change.

### 9.3 Trace integration

Every memory operation records:

- operation type;
- record ids (not content);
- retrieval score summary;
- latency;
- success.

## 10. Evaluation

### 10.1 Retrieval benchmark

Create a fixed local dataset:

- 200 facts;
- 30 projects;
- 100 tasks;
- 30 preference entries;
- 50 realistic queries with expected relevant ids.

Measure:

- precision@5;
- recall@5;
- mean reciprocal rank;
- p50/p95 query latency;
- index size;
- RAM impact.

### 10.2 Migration test

- copy the real database;
- run the additive migration;
- verify row counts and sample checksums;
- verify old queries still work;
- verify rollback by disabling the feature flag.

### 10.3 Learning test

- replay a synthetic trace set;
- verify deterministic fallback below the sample threshold;
- verify no route outside the allowed set is chosen;
- verify reset clears learned aggregates.

## 11. Acceptance criteria

Phase 2 is accepted only if:

- existing memory tools keep working;
- secrets remain refused;
- `LIKE` fallback works when FTS is disabled;
- precision@5 improves over baseline on the fixed set;
- p95 retrieval stays under 25 ms for the test dataset;
- no user data leaves the machine;
- the database can be restored from the pre-migration copy.
