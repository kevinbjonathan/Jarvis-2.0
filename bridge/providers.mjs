/**
 * Cloud chat providers for the JARVIS AI gateway.
 *
 * The cloud providers speak the same dialect — OpenAI's chat-completions
 * API with SSE streaming — so they share one adapter and differ only in base
 * URL, credential and default model. That is the entire point of this file:
 * a provider is data (endpoint + key + model), not a second implementation.
 *
 *   Provider A — OpenRouter   https://openrouter.ai/api/v1/chat/completions
 *   Provider B — Gemini       https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 *   Provider C — NVIDIA NIM   https://integrate.api.nvidia.com/v1/chat/completions
 *
 * The local OpenCode/Big Pickle brain is not here: it has its own
 * integration (bridge/runner.mjs), it is spawned rather than fetched, and it
 * carries the tool loop. It is reached as the fallback from the gateway, never
 * through this adapter.
 *
 * Rules this file obeys:
 *   - streaming, so the reply starts speaking before it is finished;
 *   - one AbortController for timeout AND for STOP, so a cancelled turn stops
 *     paying immediately;
 *   - errors are classified into codes the gateway can route on, and every
 *     message is redacted — no key, no auth header, no full request body ever
 *     leaves this module in an error string;
 *   - usage is reported when the provider sends it, and simply absent when it
 *     does not. Absent is not an error.
 */

/** Base URL of the OpenRouter chat API (documented, OpenAI-compatible). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Default endpoint for NVIDIA's API Catalog; overridable per model. */
export const NVIDIA_BASE_URL_DEFAULT = 'https://integrate.api.nvidia.com/v1'

/** Gemini's documented OpenAI-compatible endpoint. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

/**
 * A provider failure, classified.
 *
 * The `code` is what the gateway routes on; the message is what a human may
 * read, and it is already redacted by the time it gets here.
 */
export class ProviderError extends Error {
  constructor(message, { code = 'unavailable', status = 0, provider = '' } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.provider = provider
  }
}

/**
 * Strip anything credential-shaped out of a message before it is shown,
 * logged or stored. Bodies from a failing API occasionally echo the request
 * headers back, and an error string ends up in the HUD and in the perf log.
 */
export function redact(text) {
  return String(text ?? '')
    .replace(/(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]')
    .replace(/\b(sk-or-v1-|sk-|nvapi-|nvapi_|nk-|xai-)[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9._-]{32,}/g, (m) => (/[A-Za-z0-9]/.test(m) ? '[redacted]' : m))
    .slice(0, 300)
}

/** What a 4xx/5xx actually means for routing, from status + body text. */
function classifyFailure(status, bodyText, provider) {
  const body = String(bodyText ?? '')
  const lower = body.toLowerCase()

  if (status === 401 || status === 403) {
    return new ProviderError(
      `${provider} rejected the API key (HTTP ${status}).`,
      { code: 'auth', status, provider },
    )
  }
  if (status === 402) {
    return new ProviderError(
      `${provider} reports payment required (HTTP 402) — the account has no credit.`,
      { code: 'quota', status, provider },
    )
  }
  if (status === 429) {
    const exhausted =
      /insufficient|credit|quota|exceeded.*(free|limit)|no credits|billing/.test(lower)
    return new ProviderError(
      exhausted
        ? `${provider} has no capacity left on the current tier (HTTP 429).`
        : `${provider} rate-limited this request (HTTP 429).`,
      { code: exhausted ? 'quota' : 'rate', status, provider },
    )
  }
  if (status === 404) {
    return new ProviderError(
      `${provider} does not serve that model or path (HTTP 404).`,
      { code: 'unavailable', status, provider },
    )
  }
  if (status === 400 || status === 422) {
    const detail = /context[_ ]length|maximum context|too many tokens/.test(lower)
      ? 'the request was too long for that model.'
      : /model/i.test(lower)
        ? 'the model id was not accepted.'
        : 'the request was rejected.'
    return new ProviderError(`${provider}: ${detail} (HTTP ${status}).`, {
      code: 'bad_request',
      status,
      provider,
    })
  }
  if (status >= 500) {
    return new ProviderError(`${provider} is unavailable right now (HTTP ${status}).`, {
      code: 'unavailable',
      status,
      provider,
    })
  }
  return new ProviderError(`${provider} answered HTTP ${status}.`, {
    code: 'unavailable',
    status,
    provider,
  })
}

/**
 * Link an external signal (the STOP button) to this request's own timeout.
 *
 * Both arrive on one controller, because both must cancel the same fetch —
 * but they are told apart: a timeout is a provider problem the gateway may
 * route around, an abort is the user changing their mind and must never be
 * retried anywhere.
 */
function makeAbort(timeoutMs, signal) {
  const controller = new AbortController()
  const state = { timedOut: false, external: false }

  const timer = setTimeout(() => {
    state.timedOut = true
    controller.abort()
  }, Math.max(1, timeoutMs))

  const onExternal = () => {
    state.external = true
    controller.abort()
  }
  if (signal) {
    if (signal.aborted) onExternal()
    else signal.addEventListener('abort', onExternal, { once: true })
  }

  return {
    signal: controller.signal,
    state,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onExternal)
    },
  }
}

function abortError(state, provider, timeoutMs) {
  if (state.external) {
    const err = new ProviderError('stopped', { code: 'aborted', provider })
    return err
  }
  return new ProviderError(
    `${provider} did not respond within ${Math.round(timeoutMs / 1000)}s.`,
    { code: 'timeout', provider },
  )
}

/**
 * One streaming chat completion.
 *
 * @param {object} opts
 * @param {string} opts.provider  provider id (for messages only)
 * @param {string} opts.baseUrl   e.g. https://openrouter.ai/api/v1
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]  STOP / barge-in
 * @param {Record<string,string>} [opts.headers] provider-specific extras
 * @param {typeof fetch} [opts.fetchImpl] transport override for deterministic tests
 * @param {(text: string) => void} [opts.onDelta] called for each text chunk
 * @returns {Promise<{ text: string, firstTokenMs: number, totalMs: number, usage: object|null }>}
 */
export async function streamChat(opts) {
  const {
    provider,
    baseUrl,
    apiKey,
    model,
    messages,
    maxTokens = 300,
    timeoutMs = 25_000,
    signal,
    headers = {},
    fetchImpl = fetch,
    onDelta,
  } = opts

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  const abort = makeAbort(timeoutMs, signal)
  const startedAt = Date.now()
  let firstTokenMs = 0
  let text = ''
  let usage = null

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'http-referer': 'http://localhost:5173',
        'x-title': 'JARVIS',
        ...headers,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: abort.signal,
    })
  } catch (err) {
    abort.dispose()
    if (abort.state.external) throw abortError(abort.state, provider, timeoutMs)
    if (abort.state.timedOut) throw abortError(abort.state, provider, timeoutMs)
    throw new ProviderError(`${provider} could not be reached: ${redact(err?.message ?? err)}`, {
      code: 'network',
      provider,
    })
  }

  if (!res.ok) {
    abort.dispose()
    const bodyText = await res.text().catch(() => '')
    throw classifyFailure(res.status, bodyText, provider)
  }

  // The error classification above already covered the HTTP layer; what is
  // left is a 200 whose body may still be an error object (OpenRouter sends
  // those inside the stream after a partial response).
  const reader = res.body?.getReader?.()
  if (!reader) {
    abort.dispose()
    throw new ProviderError(`${provider} returned no readable stream.`, {
      code: 'unavailable',
      provider,
    })
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  try {
    while (!done) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      if (value) buffer += decoder.decode(value, { stream: true })

      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const line = rawLine.trim()
        if (!line) continue
        // SSE comments (": keep-alive") are not data.
        if (line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          done = true
          break
        }

        let frame
        try {
          frame = JSON.parse(data)
        } catch {
          continue
        }

        if (frame.error) {
          const message = redact(frame.error.message ?? JSON.stringify(frame.error))
          const code = /rate|429/.test(String(frame.error.code ?? '')) ? 'rate' : 'unavailable'
          throw new ProviderError(`${provider}: ${message}`, { code, provider })
        }

        const choice = frame.choices?.[0]
        const delta = choice?.delta?.content ?? choice?.message?.content
        if (typeof delta === 'string' && delta) {
          if (!firstTokenMs) firstTokenMs = Date.now() - startedAt
          text += delta
          onDelta?.(delta)
        }
        if (frame.usage && typeof frame.usage === 'object') usage = frame.usage
      }
    }
  } catch (err) {
    abort.dispose()
    await reader.cancel?.().catch?.(() => {})
    if (err instanceof ProviderError) throw err
    // A deliberate STOP outranks everything: the user said stop, so this is an
    // abort even if a sentence was half-spoken. It must never be mistaken for a
    // truncated-but-usable reply, or the gateway would send a 'done' for a turn
    // the user just cancelled.
    if (abort.state.external) throw abortError(abort.state, provider, timeoutMs)
    if (abort.state.timedOut) {
      // A timeout that already produced words is a partial reply — hand back
      // what arrived rather than discarding a sentence the user has heard.
      if (text) return { text, firstTokenMs, totalMs: Date.now() - startedAt, usage, partial: true }
      throw abortError(abort.state, provider, timeoutMs)
    }
    if (text) return { text, firstTokenMs, totalMs: Date.now() - startedAt, usage, partial: true }
    throw new ProviderError(`${provider} stream failed: ${redact(err?.message ?? err)}`, {
      code: 'network',
      provider,
    })
  }

  abort.dispose()
  if (!text) {
    throw new ProviderError(`${provider} returned an empty reply.`, {
      code: 'unavailable',
      provider,
    })
  }
  // Both providers close a finished stream with an explicit [DONE]. Reaching
  // EOF without one means the body stopped early, so the reply is truncated
  // even though fetch saw no error.
  return { text, firstTokenMs, totalMs: Date.now() - startedAt, usage, partial: !done }
}

/** Build a request for one provider from the gateway's resolved descriptor. */
export function providerRequest(descriptor) {
  const headers = {}
  if (descriptor.id === 'openrouter') {
    // Optional, for OpenRouter's rankings; never carries a credential.
    headers['http-referer'] = 'http://localhost:5173'
    headers['x-title'] = 'JARVIS'
  }
  return {
    provider: descriptor.id,
    baseUrl: descriptor.baseUrl,
    apiKey: descriptor.apiKey,
    model: descriptor.model,
    maxTokens: descriptor.maxTokens,
    timeoutMs: descriptor.timeoutMs,
    headers,
  }
}
