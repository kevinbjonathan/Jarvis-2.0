# Intelligence and Routing Design

- Purpose: make JARVIS choose the cheapest safe route that can answer correctly
- Principle: deterministic first, evidence second, always explainable
- Constraint: no paid model, no mandatory download, no opaque routing

## 1. Current behavior

JARVIS already has a layered route:

1. **Exact fast router** in `bridge/router.mjs`.
   - Level 1: open/close/navigate tabs, weather, time-like browser commands.
   - Level 2: reminders, memory, preferences, projects, tab management.
   - Strict whole-phrase matching; uncertainty falls through.
2. **AI gateway classification** in `bridge/ai.mjs`.
   - Coarse categories such as safety, local, tools, simple, and reasoning.
   - `AI_BILLING_MODE=free_only` by default.
   - Local opencode is the default brain for tool work.
3. **Local brain** through `bridge/runner.mjs`.
   - `opencode run --format json`.
   - Session continuation.
4. **Free cloud gateway** through OpenRouter/NVIDIA when configured and allowed.

This is a good baseline. Its weaknesses are:

- no confidence or route explanation stored;
- no measured model quality or latency;
- no learned preference among safe routes;
- no explicit privacy classification before egress;
- classification features are coarse.

## 2. Proposed route ladder

Every turn descends in this order. A later stage runs only if an earlier stage
does not produce a safe, confident answer.

### Stage 0 — hard safety

- secret-shaped input;
- destructive action intent;
- permission violation;
- disallowed origin or write mode;
- explicit user stop/cancel.

Hard safety never falls through to a model.

### Stage 1 — exact deterministic router

- unchanged matching rules;
- no model boot;
- record a route reason and latency;
- if matched, execute and return.

This stage remains first forever. Learning never overrides an exact command.

### Stage 2 — local intent analysis

Cheap, deterministic features:

- token count;
- question form (`what`, `how`, `why`, `when`, `where`, `who`);
- imperative/tool verbs (`open`, `search`, `send`, `remind`, `remember`, `click`,
  `play`, `summarize`);
- private markers (`my`, `email`, `calendar`, `file`, `password`, `account`,
  `project`, `home`, `location`);
- reasoning markers (`compare`, `explain`, `plan`, `analyze`, `tradeoff`,
  `step by step`);
- time sensitivity (`now`, `today`, `tomorrow`, `latest`);
- ambiguity markers (`it`, `that`, `the one`, `again`, `more`);
- language and script hints;
- conversation context: pending confirmation, active project, current tab.

Output is a structured `QueryProfile`, not a model call.

### Stage 3 — capability and privacy filtering

Build the set of routes that are allowed *before* ranking:

- provider enabled and free;
- provider healthy;
- route supports required tools;
- writes permitted if the route implies effects;
- privacy class permits the provider;
- context length fits;
- user has not disabled the route.

A route that is not permitted is never a candidate, even if it has the best score.

### Stage 4 — route ranking

Baseline mode:

- use the existing classifier and a fixed preference order;
- deterministic tie-break by locality, then latency, then provider order.

Learned mode (optional):

- score each allowed route from aggregate traces;
- require minimum samples per route/profile;
- apply recency decay;
- cap exploration;
- compare against baseline with a holdout or shadow decision.

The policy never invents a route. It only orders candidates.

### Stage 5 — execution and fallback

- execute the chosen route;
- on timeout, provider error, or empty result, use the next permitted route;
- never silently fall back from a privacy-constrained route to a cloud route;
- record every fallback reason.

## 3. Route taxonomy

| Route id | Description | Locality | Free | Tools | Private data allowed |
|---|---|---|---|---|---|
| `fast.exact` | Deterministic router | Local | Yes | Local/UI/weather | Yes |
| `fast.memory` | Direct memory/project read | Local | Yes | SQLite | Yes |
| `brain.opencode` | Headless opencode turn | Network (free tier) | Yes | HUD tools | Policy-controlled |
| `brain.cloud.simple` | Free cloud conversation | Network | Yes, verified | Usually none | Off by default |
| `brain.cloud.reasoning` | Free reasoning model | Network | Yes, verified | Usually none | Off by default |
| `local.ollama` | Future opt-in local model | Local | Yes | Limited | Yes |
| `safety.refuse` | No model; explain refusal | Local | Yes | None | N/A |
| `confirm.destructive` | Spoken confirmation gate | Local | Yes | Deferred | N/A |

A route id is stored on every trace. Model and provider are separate fields.

## 4. QueryProfile contract

```text
QueryProfile {
  textHash: string            // no raw text by default
  lengthBucket: "short" | "medium" | "long"
  questionType: string
  intentHints: string[]
  toolHints: string[]
  privateMarkers: string[]
  reasoning: boolean
  timeSensitive: boolean
  ambiguous: boolean
  language: string
  contextFlags: string[]
  sensitivity: "public" | "personal" | "sensitive" | "secret"
}
```

Rules:

- `secret` is never routed to a network provider.
- `sensitive` requires explicit cloud-data permission.
- `personal` is allowed only on routes whose privacy class permits it.
- `public` may use any permitted free route.
- Classification is conservative: when uncertain, raise sensitivity, not lower
  it.

## 5. Model registry

A small local registry, not a remote catalog.

| Field | Meaning |
|---|---|
| `id` | Stable model id |
| `provider` | `opencode`, `openrouter`, `nvidia`, `ollama` |
| `locality` | `local` or `network` |
| `free` | Verified free under current policy |
| `context` | Approximate context window |
| `capabilities` | `chat`, `tools`, `reasoning`, `vision`, `json` |
| `privacyClass` | Maximum data class allowed |
| `enabled` | User-controlled |
| `p50LatencyMs` | Measured locally |
| `p95LatencyMs` | Measured locally |
| `successRate` | Measured locally |
| `sampleCount` | Evidence count |

Source of truth for enabled/free state remains configuration. The registry adds
measured behavior and capability metadata.

## 6. Reward model

The policy learns from outcomes, not from raw text.

```text
reward =
    success
  + feedbackScore
  - latencyPenalty
  - retryPenalty
  - privacyPenalty
  - costPenalty        // always zero under free_only
```

Suggested values:

| Signal | Value |
|---|---|
| Successful answer | +1.0 |
| User positive feedback | +1.0 |
| User negative feedback | -1.5 |
| Tool success | +0.2 |
| Tool failure | -0.3 |
| Timeout | -0.8 |
| Retry required | -0.5 |
| Privacy violation | disqualifying |
| Paid route | disqualifying |

These weights are provisional and must be tuned against the benchmark set.

## 7. Learning policy

Use a simple contextual multi-armed bandit, not a neural model.

- Context bucket: intent category + length bucket + privacy class + tool need.
- Arms: allowed route ids.
- Algorithm: Thompson sampling or epsilon-greedy over bounded arms.
- Minimum samples: do not learn a context until each candidate has enough
  evidence; otherwise use baseline.
- Exploration cap: small fixed percentage, and never on `sensitive` or `secret`.
- Decay: older outcomes lose weight.
- Reset: user can clear learning data.
- Shadow mode: first run the learned choice in parallel with baseline, compare,
  and only then promote.

## 8. Explanation record

Every turn stores:

```text
RoutingDecision {
  traceId
  routeId
  baselineRouteId
  policyMode: "baseline" | "learned" | "shadow"
  reasonCode
  candidateRoutes
  privacyClass
  fallbackFrom
  fallbackReason
  latencyMs
}
```

Reason codes:

- `exact_match`
- `safety_rule`
- `tool_required`
- `reasoning_required`
- `private_local_only`
- `cloud_not_permitted`
- `provider_unhealthy`
- `insufficient_samples`
- `policy_choice`
- `fallback_timeout`
- `fallback_error`

This is enough to explain a decision without storing the user’s content.

## 9. Privacy rules

| Data class | Local routes | opencode free tier | Free cloud provider | ElevenLabs |
|---|---|---|---|---|
| `public` | Yes | Yes | Yes | Yes |
| `personal` | Yes | Only with cloud-data permission | Only with cloud-data permission | Only if speech requires it |
| `sensitive` | Yes | No by default | No by default | No |
| `secret` | Local only | No | No | No |

Important:

- Speech transcription through ElevenLabs is an egress event and must be
  documented as such.
- Google Gmail/Calendar calls go to Google by definition; the privacy gate must
  not pretend they are local.
- Weather and geocoding are network calls; they should carry no private content
  beyond the requested place.
- The privacy gate must never silently rewrite a user’s request to make it
  cloud-safe. It may redact, ask, or refuse, with a visible reason.

## 10. Failure and fallback ladder

```text
exact router
  -> brain.opencode
      -> free cloud (only if privacy allows)
          -> honest failure

brain.cloud.simple
  -> brain.opencode (if provider fails and privacy allows)
      -> honest failure
```

Rules:

- A timeout is not a privacy permission.
- A failed local route may fall back to cloud only if the data class allows it.
- A failed cloud route may fall back to the local brain if the prompt fits.
- No route may fall back to a paid provider.
- The user sees one concise failure sentence, not a provider stack trace.

## 11. Evaluation

### Offline set

Build a fixed set of at least 60 prompts covering:

- exact commands;
- reminders/memory;
- weather;
- tool actions;
- private data questions;
- reasoning questions;
- ambiguous follow-ups;
- prompt-injection attempts;
- secret-shaped input;
- unsupported/offline cases.

### Metrics

- route accuracy against a human label;
- false-fast-route rate (answered by exact router but wrong);
- unnecessary model boot rate;
- tool success rate;
- p50/p95 end-to-end latency;
- fallback rate;
- privacy violations (must be zero);
- paid-route attempts (must be zero).

### Promotion rule

A learned policy is promoted only if:

- no privacy violations;
- no paid-route attempts;
- no increase in false-fast-route errors;
- route success is not worse than baseline;
- p95 latency is not worse by more than 10%;
- at least the minimum sample count is met.

Otherwise it stays in shadow mode or is disabled.

## 12. First implementation boundary

Phase 3 implements:

- QueryProfile extraction;
- model registry;
- routing decision records;
- baseline explanation;
- shadow-mode policy.

It does **not** implement:

- autonomous model downloads;
- multi-agent dispatch;
- paid routes;
- scheduler-driven routing;
- vector-based intent classification.

The deterministic router remains first and unchanged.
