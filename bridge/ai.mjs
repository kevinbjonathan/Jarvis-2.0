/**
 * The JARVIS AI gateway.
 *
 * A provider-independent seam between "the user said something the fast
 * command router could not answer" and "a model answers it". Everything above
 * this file (the WebSocket turn, the HUD, the perf ledger) stays provider
 * agnostic; everything below it (HTTP, SSE, keys, free-tier rules) stays out of
 * the server.
 *
 * The four kinds of request it sorts, in the order policy demands:
 *
 *   safety   — STOP / CANCEL. Never reaches here; the router and the frontend
 *              handle them before any provider is considered.
 *   local    — direct commands (open Gmail, next tab, time, weather). The
 *              fast command router answers them with zero model calls. This
 *              module classifies the leftovers only.
 *   tools    — anything that needs Gmail, Calendar, memory, the HUD or the
 *              browser beyond what the router handles. Goes to the local
 *              opencode brain, because that is the integration that owns the
 *              tool loop. It is the safe default: a false "tools" costs speed,
 *              a false "simple" costs correctness.
 *   simple / reasoning — plain conversation. Sent to the configured cloud
 *              provider, streaming, with a short system prompt.
 *
 * Free-first: AI_BILLING_MODE=free_only (the default) refuses any model that
 * is not explicitly declared free, never silently swaps in a paid model, never
 * buys credits, and reports exhaustion instead of routing around it.
 */

import './env.mjs'
import {
  GEMINI_BASE_URL,
  NVIDIA_BASE_URL_DEFAULT,
  OPENROUTER_BASE_URL,
  ProviderError,
  providerRequest,
  streamChat,
} from './providers.mjs'

/* ------------------------------------------------------------------ config */

const num = (raw, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const blank = (v) => v === undefined || v === null || String(v).trim() === ''

/**
 * Resolved gateway configuration, read fresh each call so a test (or a future
 * settings screen) can change the environment without restarting the bridge.
 */
export function aiConfig() {
  const env = process.env

  const requestedMode = String(env.AI_BILLING_MODE ?? 'free_only').trim().toLowerCase()
  const billingMode = requestedMode === 'standard' ? 'standard' : 'free_only'
  const billingModeWarned = requestedMode !== 'standard' && requestedMode !== 'free_only'

  const requestedProvider = String(env.AI_PROVIDER ?? 'auto').trim().toLowerCase()
  const provider = ['auto', 'openrouter', 'gemini', 'nvidia', 'none'].includes(requestedProvider)
    ? requestedProvider
    : 'auto'

  const freeModels = new Set(
    String(env.AI_FREE_MODELS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

  return {
    billingMode,
    billingModeWarned,
    provider,
    freeOnly: billingMode === 'free_only',
    // Local brain stays the fallback until cloud providers are proven. Setting
    // AI_FALLBACK=none makes cloud failure a visible error instead.
    fallback: String(env.AI_FALLBACK ?? 'opencode').trim().toLowerCase() === 'none' ? 'none' : 'opencode',
    // Move to the next configured provider after a no-output timeout by
    // default. Set AI_FALLBACK_ON_TIMEOUT=0 to prefer one bounded attempt.
    fallbackOnTimeout: env.AI_FALLBACK_ON_TIMEOUT !== '0',
    cloudData: env.AI_CLOUD_DATA === '1',
    freeModels,
    nvidiaFreeDeclared: env.NVIDIA_FREE === '1',
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY?.trim() ?? '',
      model: env.OPENROUTER_MODEL?.trim() ?? '',
      reasoningModel: env.OPENROUTER_REASONING_MODEL?.trim() ?? '',
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY?.trim() ?? '',
      model: env.GEMINI_MODEL?.trim() ?? '',
      reasoningModel: env.GEMINI_REASONING_MODEL?.trim() ?? '',
    },
    nvidia: {
      apiKey: env.NVIDIA_API_KEY?.trim() ?? '',
      model: env.NVIDIA_MODEL?.trim() ?? '',
      reasoningModel: env.NVIDIA_REASONING_MODEL?.trim() ?? '',
      baseUrl: (env.NVIDIA_BASE_URL?.trim() || NVIDIA_BASE_URL_DEFAULT),
    },
    maxTokens: num(env.AI_MAX_TOKENS, 220),
    reasoningMaxTokens: num(env.AI_REASONING_MAX_TOKENS, 700),
    timeoutMs: num(env.AI_TIMEOUT_MS, 15_000),
    reasoningTimeoutMs: num(env.AI_REASONING_TIMEOUT_MS, 30_000),
  }
}

/**
 * Is this model id allowed under free-only rules?
 *
 * Only two things count as verification, and neither is a guess:
 *   1. the OpenRouter `:free` catalog variant (pricing zero by definition) and
 *      the `openrouter/free` router, which only selects free models;
 *   2. an id the user themselves listed in AI_FREE_MODELS.
 *
 * Nothing else is described as free, because free availability, rate limits
 * and quotas change without notice.
 */
export function isFreeModel(modelId, cfg = aiConfig()) {
  const id = String(modelId ?? '').trim()
  if (!id) return false
  if (id.endsWith(':free')) return true
  if (id === 'openrouter/free') return true
  if (cfg.freeModels.has(id)) return true
  return false
}

/* ------------------------------------------------------------- descriptors */

/**
 * One provider's usable state:
 *   ready | not-configured | not-free | no-model | exhausted | error | cooldown
 */
function describeOpenRouter(cfg) {
  const base = {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: cfg.openrouter.apiKey,
    model: cfg.openrouter.model,
    reasoningModel: cfg.openrouter.reasoningModel,
    maxTokens: cfg.maxTokens,
    reasoningMaxTokens: cfg.reasoningMaxTokens,
    timeoutMs: cfg.timeoutMs,
    reasoningTimeoutMs: cfg.reasoningTimeoutMs,
  }
  if (blank(cfg.openrouter.apiKey)) {
    return { ...base, state: 'not-configured', detail: 'OPENROUTER_API_KEY is not set.' }
  }
  if (blank(cfg.openrouter.model)) {
    return { ...base, state: 'no-model', detail: 'OPENROUTER_MODEL is not set.' }
  }
  if (cfg.freeOnly && !isFreeModel(cfg.openrouter.model, cfg)) {
    return {
      ...base,
      state: 'not-free',
      detail: `${cfg.openrouter.model} is not verified free — use a ":free" model id, list it in AI_FREE_MODELS, or set AI_BILLING_MODE=standard.`,
    }
  }
  if (state.exhausted.has('openrouter')) {
    return { ...base, state: 'exhausted', detail: 'free capacity reported exhausted this session.' }
  }
  const failure = providerFailureStatus('openrouter')
  if (failure) return { ...base, ...failure }
  return { ...base, state: 'ready', detail: cfg.freeOnly ? 'free-tier model configured.' : 'configured.' }
}

function describeNvidia(cfg) {
  const base = {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: cfg.nvidia.baseUrl,
    apiKey: cfg.nvidia.apiKey,
    model: cfg.nvidia.model,
    reasoningModel: cfg.nvidia.reasoningModel,
    maxTokens: cfg.maxTokens,
    reasoningMaxTokens: cfg.reasoningMaxTokens,
    timeoutMs: cfg.timeoutMs,
    reasoningTimeoutMs: cfg.reasoningTimeoutMs,
  }
  // Optional by design: a missing NVIDIA key is NOT CONFIGURED, never an error
  // raised on every request.
  if (blank(cfg.nvidia.apiKey)) {
    return { ...base, state: 'not-configured', detail: 'NVIDIA_API_KEY is not set (optional).' }
  }
  if (blank(cfg.nvidia.model)) {
    return { ...base, state: 'no-model', detail: 'NVIDIA_MODEL is not set (optional).' }
  }
  if (cfg.freeOnly && !isFreeModel(cfg.nvidia.model, cfg) && !cfg.nvidiaFreeDeclared) {
    return {
      ...base,
      state: 'not-free',
      detail: 'NVIDIA does not label models free in the API — declare it with NVIDIA_FREE=1, list it in AI_FREE_MODELS, or set AI_BILLING_MODE=standard.',
    }
  }
  if (state.exhausted.has('nvidia')) {
    return { ...base, state: 'exhausted', detail: 'capacity reported exhausted this session.' }
  }
  const failure = providerFailureStatus('nvidia')
  if (failure) return { ...base, ...failure }
  return { ...base, state: 'ready', detail: cfg.freeOnly ? 'user-declared free tier.' : 'configured.' }
}

function describeGemini(cfg) {
  const base = {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: GEMINI_BASE_URL,
    apiKey: cfg.gemini.apiKey,
    model: cfg.gemini.model,
    reasoningModel: cfg.gemini.reasoningModel,
    maxTokens: cfg.maxTokens,
    reasoningMaxTokens: cfg.reasoningMaxTokens,
    timeoutMs: cfg.timeoutMs,
    reasoningTimeoutMs: cfg.reasoningTimeoutMs,
  }
  if (blank(cfg.gemini.apiKey)) {
    return { ...base, state: 'not-configured', detail: 'GEMINI_API_KEY is not set (optional).' }
  }
  if (blank(cfg.gemini.model)) {
    return { ...base, state: 'no-model', detail: 'GEMINI_MODEL is not set (optional).' }
  }
  if (cfg.freeOnly && !isFreeModel(cfg.gemini.model, cfg)) {
    return {
      ...base,
      state: 'not-free',
      detail: 'Gemini model is not verified free — list it in AI_FREE_MODELS or set AI_BILLING_MODE=standard.',
    }
  }
  if (state.exhausted.has('gemini')) {
    return { ...base, state: 'exhausted', detail: 'free capacity reported exhausted this session.' }
  }
  const failure = providerFailureStatus('gemini')
  if (failure) return { ...base, ...failure }
  return { ...base, state: 'ready', detail: cfg.freeOnly ? 'free-tier model declared.' : 'configured.' }
}

function describeLocal() {
  return {
    id: 'opencode',
    label: 'Local brain (opencode / Big Pickle)',
    state: 'ready',
    detail: 'spawned per turn; owns the tool loop.',
    timeoutMs: 0,
  }
}

/* ---------------------------------------------------------------- metrics */

/** Session-scoped state: provider health, counters, last-turn measurements. */
const state = {
  exhausted: new Set(),
  errors: new Map(),
  metrics: {
    completed: 0,
    failures: 0,
    fallbacks: 0,
    last: {
      provider: null,
      model: null,
      kind: null,
      firstTokenMs: 0,
      totalMs: 0,
      routingMs: 0,
      at: 0,
      error: null,
    },
    // Whether the last command answered without any model call at all.
    bypassed: false,
    lastIntent: null,
  },
}

const TRANSIENT_RETRY_MS = 15_000
const RATE_RETRY_MS = 60_000

/**
 * A timeout, network hiccup, rate limit, or empty upstream reply must not
 * remove a provider from the chain for the rest of the process lifetime.
 * Briefly cool it down, then allow the next user turn to try it again. Auth
 * errors remain blocked until its credential is fixed and JARVIS restarts.
 */
function providerFailureStatus(id) {
  const failure = state.errors.get(id)
  if (!failure) return null
  if (!failure.retryAt) return { state: 'error', detail: failure.message }
  const remaining = failure.retryAt - Date.now()
  if (remaining <= 0) {
    state.errors.delete(id)
    return null
  }
  return {
    state: 'cooldown',
    detail: `${failure.message} Retry in ${Math.max(1, Math.ceil(remaining / 1000))}s.`,
  }
}

/** Called when the fast command router answered — AI bypassed. */
export function noteRouting(routingMs) {
  state.metrics.bypassed = true
  state.metrics.lastIntent = 'router'
  state.metrics.last.routingMs = Math.round(routingMs)
  state.metrics.last.at = Date.now()
}

/** Called when a turn goes to the local brain instead of a cloud provider. */
export function noteLocalTurn(kind) {
  state.metrics.bypassed = false
  state.metrics.lastIntent = kind ?? 'tools'
  state.metrics.last.provider = 'opencode'
  state.metrics.last.at = Date.now()
}

/** Mark a provider unhealthy so status reports it honestly. */
function noteProviderFailure(descriptor, err) {
  const code = err?.code ?? 'unavailable'
  if (code === 'quota') state.exhausted.add(descriptor.id)
  else if (code === 'auth') {
    state.errors.set(descriptor.id, {
      code,
      message: err?.message ?? 'authentication failed',
      retryAt: 0,
    })
  } else if (code === 'unavailable' || code === 'network' || code === 'timeout' || code === 'rate') {
    state.errors.set(descriptor.id, {
      code,
      message: err?.message ?? 'unavailable',
      retryAt: Date.now() + (code === 'rate' ? RATE_RETRY_MS : TRANSIENT_RETRY_MS),
    })
  }
}

/** Clear a stale error mark after a later success. */
function noteProviderSuccess(descriptor) {
  state.exhausted.delete(descriptor.id)
  state.errors.delete(descriptor.id)
}

/* ------------------------------------------------------------ classification */

const compact = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Asking for two data sources at once — the parallel-gather case. */
const GATHER_VERB =
  /\b(summarise|summarize|sum up|recap|catch me up|brief me|overview|run me through|what is my day|whats my day|how is my day|hows my day|give me the rundown)\b/
const SCHEDULE_HINT = /\b(schedule|calendar|meetings?|appointments?|agenda|events?)\b/
const MAIL_HINT = /\b(emails?|e mails?|mail|inbox|gmail|messages in my inbox)\b/

/**
 * Signals that the request needs a tool the cloud providers do not have.
 *
 * Deliberately broad and deliberately the safe direction: a phrase that
 * matches here goes to the local brain, which has Gmail, Calendar, memory, the
 * HUD, the shell and Chrome. A miss would send a tool request to a plain chat
 * model that would answer confidently without doing anything.
 */
const TOOL_HINTS = [
  /\b(gmail|email|e mail|inbox|mailbox|unread)\b/,
  /\b(calendar|meeting|appointment|schedule|agenda)\b/,
  /\b(remember|memory|my projects?|project i am working on|preference|note that|what did i say)\b/,
  /\b(screenshot|camera|look at me|watch me|take (?:a )?(?:photo|picture))\b/,
  /\b(blade|panel|theme|reactor|orbit|interface|hud)\b/,
  /\b(search the web|google (?:it|this|for)|look (?:it|this) up|the news|latest news|current events|headlines)\b/,
  /\b(send|delete|remove|install|uninstall|launch|deploy|post|publish|create a file|run (?:the )?(?:command|script)|shell|terminal|bash)\b/,
  /\b(click|type into|fill in|log me in|sign me in|scroll to)\b/,
  /\b(this page|the page|the tab|the browser|open (?:the )?article|read (?:the )?(?:page|article|site))\b/,
  /\b(music|play (?:a )?(?:song|track)|remind me|set a reminder|tasks?|to do)\b/,
]

/** Long or explicitly analytical phrasing wants the reasoning model. */
const REASONING_HINTS =
  /\b(why|how do(es| i| you| it)|how would|explain|compare|difference between|analy[sz]e|break down|step by step|pros and cons|trade offs?|design|architect|plan|strategy|recommend|advise|should i|would you|if i (?:were|had)|imagine|walk me through|debug|root cause|cause of|summarise|summarize|outline|draft|write (?:me )?(?:an? )?(?:essay|article|email|letter|story|poem|list)|translate|derive|prove|calculate)\b/

/**
 * What kind of turn is this?
 *
 * Returns 'gather' | 'tools' | 'reasoning' | 'simple'. Deterministic, no
 * model call, no network: routing must be free and must never be the reason a
 * command is slow.
 */
export function classify(text) {
  const c = compact(text)
  if (!c) return 'tools'

  // Both a schedule and mail in one breath, with a summarising verb: retrieve
  // them concurrently and hand only the result to the model (see gatherReply
  // in server.mjs). Effectful verbs disqualify it — "email my schedule to…"
  // is a write, not a summary.
  if (GATHER_VERB.test(c) && SCHEDULE_HINT.test(c) && MAIL_HINT.test(c)) {
    if (!/\b(send|post|reply|forward|delete|cancel|reschedule|decline)\b/.test(c)) return 'gather'
  }

  for (const re of TOOL_HINTS) if (re.test(c)) return 'tools'

  const words = c.split(' ').length
  if (words >= 16) return 'reasoning'
  if (REASONING_HINTS.test(c)) return 'reasoning'
  return 'simple'
}

/* -------------------------------------------------------------- orchestration */

/** Provider descriptors for the configured chain, best first. */
export function cloudChain(kind = 'simple', cfg = aiConfig()) {
  const wantReasoning = kind === 'reasoning'
  const order = cfg.provider === 'openrouter'
    ? ['openrouter']
    : cfg.provider === 'gemini'
      ? ['gemini']
      : cfg.provider === 'nvidia'
      ? ['nvidia']
      : cfg.provider === 'none'
        ? []
        : ['openrouter', 'gemini', 'nvidia']

  const chain = []
  for (const id of order) {
    const descriptor = id === 'openrouter'
      ? describeOpenRouter(cfg)
      : id === 'gemini'
        ? describeGemini(cfg)
        : describeNvidia(cfg)
    if (descriptor.state !== 'ready') continue
    const model = (wantReasoning ? descriptor.reasoningModel : '') || descriptor.model
    if (cfg.freeOnly && wantReasoning && descriptor.reasoningModel && !isFreeModel(descriptor.reasoningModel, cfg)) {
      // A reasoning model that is not verified free must not be used for the
      // reasoning tier — fall back to the (verified) primary model instead of
      // to a paid one.
      chain.push({ ...descriptor, model: descriptor.model })
      continue
    }
    chain.push({
      ...descriptor,
      model,
      maxTokens: wantReasoning ? descriptor.reasoningMaxTokens : descriptor.maxTokens,
      timeoutMs: wantReasoning ? descriptor.reasoningTimeoutMs : descriptor.timeoutMs,
    })
  }
  return chain
}

/** Whether any cloud provider can take this kind of turn right now. */
export function cloudAvailable(kind = 'simple') {
  return cloudChain(kind).length > 0
}

/** The whole picture for /systems, /health and the diagnostics panel. */
export function aiStatus() {
  const cfg = aiConfig()
  const openrouter = describeOpenRouter(cfg)
  const gemini = describeGemini(cfg)
  const nvidia = describeNvidia(cfg)
  const local = describeLocal()
  const chain = cloudChain('simple')
  const m = state.metrics

  return {
    configured: cfg.provider,
    active: m.last.provider ?? chain[0]?.id ?? 'opencode',
    model: m.last.model ?? chain[0]?.model ?? null,
    billingMode: cfg.billingMode,
    freeOnly: cfg.freeOnly,
    cloudData: cfg.cloudData,
    fallback: cfg.fallback,
    fallbackOnTimeout: cfg.fallbackOnTimeout,
    timeoutMs: cfg.timeoutMs,
    reasoningTimeoutMs: cfg.reasoningTimeoutMs,
    providers: {
      openrouter: { state: openrouter.state, model: openrouter.model || null, detail: openrouter.detail },
      gemini: { state: gemini.state, model: gemini.model || null, detail: gemini.detail },
      nvidia: { state: nvidia.state, model: nvidia.model || null, detail: nvidia.detail },
      opencode: { state: local.state, detail: local.detail },
    },
    firstTokenMs: m.last.firstTokenMs,
    totalMs: m.last.totalMs,
    routingMs: m.last.routingMs,
    intent: m.lastIntent,
    bypassed: m.bypassed,
    completed: m.completed,
    failures: m.failures,
    fallbacks: m.fallbacks,
    lastError: m.last.error,
    lastAt: m.last.at || null,
  }
}

/** One-line boot banner for the bridge console. */
export function aiBanner() {
  const s = aiStatus()
  const parts = s.providers.openrouter.state === 'ready'
    ? [`openrouter=${s.providers.openrouter.model}`]
    : [`openrouter=${s.providers.openrouter.state}`]
  parts.push(
    s.providers.gemini.state === 'ready'
      ? `gemini=${s.providers.gemini.model}`
      : `gemini=${s.providers.gemini.state}`,
  )
  parts.push(
    s.providers.nvidia.state === 'ready'
      ? `nvidia=${s.providers.nvidia.model}`
      : `nvidia=${s.providers.nvidia.state}`,
  )
  return (
    `[jarvis] ai gateway — primary ${s.configured} · active ${s.active}` +
    (s.model ? ` · model ${s.model}` : '') +
    ` · ${s.billingMode} · ${parts.join(' · ')}` +
    ` · fallback ${s.fallback}`
  )
}

/**
 * Run one conversational turn through the cloud chain.
 *
 * Sequential, never racing: providers are tried in order and only when the
 * previous one actually failed. A slow-but-working response is never retried
 * elsewhere — that would spend quota twice for one answer. And once a single
 * delta has been emitted, no fallback happens either: the user is already
 * hearing that reply, and starting a second one would read as a stutter.
 *
 * @param {object} opts
 * @param {string} opts.prompt    the user's words
 * @param {string} opts.system    the short JARVIS persona for cloud turns
 * @param {'simple'|'reasoning'|'gather'} opts.kind
 * @param {string} [opts.context] retrieved data (only when cloud data is allowed)
 * @param {AbortSignal} [opts.signal] STOP
 * @param {(delta: string) => void} [opts.onDelta]
 * @returns {Promise<{provider: string, model: string, text: string, firstTokenMs: number, totalMs: number}>}
 */
export async function aiTurn({ prompt, system, kind = 'simple', context, signal, onDelta, fetchImpl = fetch }) {
  const cfg = aiConfig()
  const chain = cloudChain(kind, cfg)
  if (!chain.length) {
    const err = new ProviderError('No cloud provider is configured.', {
      code: 'unconfigured',
      provider: 'none',
    })
    state.metrics.failures += 1
    state.metrics.last.error = err.message
    throw err
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  if (context) messages.push({ role: 'system', content: context })
  messages.push({ role: 'user', content: prompt })

  const startedAt = Date.now()
  let lastErr = null
  let fallbacksUsed = 0

  for (let i = 0; i < chain.length; i++) {
    const descriptor = chain[i]
    let emitted = 0
    try {
      const result = await streamChat({
        ...providerRequest(descriptor),
        messages,
        signal,
        fetchImpl,
        onDelta: (delta) => {
          emitted += delta.length
          onDelta?.(delta)
        },
      })

      noteProviderSuccess(descriptor)
      state.metrics.completed += 1
      state.metrics.bypassed = false
      state.metrics.lastIntent = kind
      state.metrics.last.provider = descriptor.id
      state.metrics.last.model = descriptor.model
      state.metrics.last.kind = kind
      state.metrics.last.firstTokenMs = result.firstTokenMs
      state.metrics.last.totalMs = result.totalMs
      state.metrics.last.error = result.partial ? 'partial reply (stream ended early)' : null
      state.metrics.last.at = Date.now()
      state.metrics.fallbacks += fallbacksUsed

      return {
        provider: descriptor.id,
        model: descriptor.model,
        text: result.text,
        firstTokenMs: result.firstTokenMs,
        totalMs: Date.now() - startedAt,
        partial: result.partial === true,
        usage: result.usage,
        fallbacks: fallbacksUsed,
      }
    } catch (err) {
      // STOP is the user's decision, not a provider failure. Never retried.
      if (err?.code === 'aborted' || signal?.aborted) {
        state.metrics.bypassed = false
        state.metrics.lastIntent = kind
        state.metrics.last.at = Date.now()
        const stopped = new ProviderError('stopped', { code: 'aborted', provider: descriptor.id })
        stopped.emitted = emitted
        throw stopped
      }

      lastErr = err
      noteProviderFailure(descriptor, err)

      // Text already reached the user through onDelta: falling back now would
      // replay the answer from the top.
      if (emitted > 0) {
        state.metrics.completed += 1
        state.metrics.bypassed = false
        state.metrics.last.provider = descriptor.id
        state.metrics.last.model = descriptor.model
        state.metrics.last.kind = kind
        state.metrics.last.error = `stream ended early: ${err?.message ?? err}`
        state.metrics.last.at = Date.now()
        const partialErr = new ProviderError(String(err?.message ?? err), {
          code: 'partial',
          provider: descriptor.id,
        })
        partialErr.emitted = emitted
        throw partialErr
      }

      // Slow is not a failure. Unless the policy explicitly permits it
      // (AI_FALLBACK_ON_TIMEOUT=1), a timeout ends the cloud attempt rather
      // than quietly spending a second provider's quota on the same question.
      if (err?.code === 'timeout' && !cfg.fallbackOnTimeout) break

      if (i < chain.length - 1) {
        fallbacksUsed += 1
        state.metrics.fallbacks += 1
        console.warn(`[ai] ${descriptor.id} failed (${err?.code ?? 'error'}) — trying next: ${err?.message ?? err}`)
        continue
      }
    }
  }

  state.metrics.failures += 1
  state.metrics.bypassed = false
  state.metrics.lastIntent = kind
  state.metrics.last.error = String(lastErr?.message ?? lastErr ?? 'no provider answered')
  state.metrics.last.at = Date.now()
  throw lastErr ?? new ProviderError('No provider answered.', { code: 'unavailable', provider: 'none' })
}
