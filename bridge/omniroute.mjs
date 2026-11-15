const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1'

const num = (raw, fallback) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

const list = (raw) => [
  ...new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
]

export function isLoopbackOmniRouteUrl(raw) {
  try {
    const url = new URL(String(raw ?? ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    if (url.search || url.hash) return false
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!LOOPBACK_HOSTS.has(host)) return false
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    if (port !== '20128') return false
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return path === '/v1'
  } catch {
    return false
  }
}

export function isExplicitOmniRouteModel(model) {
  const id = String(model ?? '').trim()
  if (!id) return false
  if (id === 'auto' || id.startsWith('auto/')) return false
  if (id.includes('*') || id.includes(',')) return false
  return true
}

export function omniRouteConfig(env = process.env) {
  return {
    enabled: String(env.JARVIS_OMNIROUTE_ENABLED ?? '').trim() === '1',
    baseUrl: String(env.JARVIS_OMNIROUTE_BASE_URL ?? '').trim() || DEFAULT_BASE_URL,
    apiKey: String(env.JARVIS_OMNIROUTE_API_KEY ?? '').trim(),
    model: String(env.JARVIS_OMNIROUTE_MODEL ?? '').trim(),
    allowedModels: list(env.JARVIS_OMNIROUTE_ALLOWED_MODELS),
    maxTokens: num(env.JARVIS_OMNIROUTE_MAX_TOKENS, 220),
    timeoutMs: num(env.JARVIS_OMNIROUTE_TIMEOUT_MS, 25_000),
  }
}

export function describeOmniRoute(config = omniRouteConfig()) {
  const base = {
    id: 'omniroute',
    label: 'OmniRoute (local)',
    baseUrl: config.baseUrl,
    model: config.model || null,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  }
  if (!config.enabled) {
    return {
      ...base,
      state: 'disabled',
      detail: 'JARVIS_OMNIROUTE_ENABLED is not 1; this boundary is inactive.',
    }
  }
  if (!isLoopbackOmniRouteUrl(config.baseUrl)) {
    return {
      ...base,
      state: 'misconfigured',
      detail: 'base URL must be loopback port 20128 at /v1.',
    }
  }
  if (!config.apiKey) {
    return {
      ...base,
      state: 'not-configured',
      detail: 'JARVIS_OMNIROUTE_API_KEY is not set.',
    }
  }
  if (!isExplicitOmniRouteModel(config.model)) {
    return {
      ...base,
      state: 'no-model',
      detail: 'JARVIS_OMNIROUTE_MODEL must be one explicit model id; auto/* is not allowed.',
    }
  }
  const allowedModels = Array.isArray(config.allowedModels) ? config.allowedModels : []
  if (!allowedModels.length) {
    return {
      ...base,
      state: 'no-allowlist',
      detail: 'JARVIS_OMNIROUTE_ALLOWED_MODELS must list the exact model id.',
    }
  }
  if (!allowedModels.every(isExplicitOmniRouteModel)) {
    return {
      ...base,
      state: 'misconfigured',
      detail: 'JARVIS_OMNIROUTE_ALLOWED_MODELS contains an invalid model id.',
    }
  }
  if (!allowedModels.includes(config.model)) {
    return {
      ...base,
      state: 'unapproved',
      detail: 'the configured model is not in the JARVIS allowlist.',
    }
  }
  return {
    ...base,
    state: 'ready',
    detail: 'explicit local model allowlisted by JARVIS; the OmniRoute key must approve the same id.',
  }
}

export function omniRouteDescriptor(config = omniRouteConfig()) {
  if (describeOmniRoute(config).state !== 'ready') return null
  return {
    id: 'omniroute',
    label: 'OmniRoute (local)',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  }
}

export function omniRouteStatus(config = omniRouteConfig()) {
  const descriptor = describeOmniRoute(config)
  return {
    id: descriptor.id,
    state: descriptor.state,
    detail: descriptor.detail,
    baseUrl: descriptor.baseUrl,
    model: descriptor.model,
    allowedModels: Array.isArray(config.allowedModels) ? [...config.allowedModels] : [],
    loopback: isLoopbackOmniRouteUrl(config.baseUrl),
  }
}
