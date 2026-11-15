/**
 * Stage E canary for the isolated OmniRoute boundary.
 *
 * This is deliberately not part of the active routing chain. It exists so one
 * operator can prove, on demand, that the loopback OmniRoute endpoint and the
 * restricted key still accept exactly one approved model. Voice, browser,
 * mail, calendar and normal chat never call this module.
 *
 * The canary is off unless BOTH JARVIS_OMNIROUTE_CANARY=1 and
 * JARVIS_OMNIROUTE_ENABLED=1 are set, the endpoint is loopback, and the
 * configured model plus allowlist are exactly the one approved id. It sends a
 * fixed synthetic prompt, makes one request, has no fallback, and returns safe
 * metadata. The dedicated HTTP path may hand the bounded fixed reply back to its
 * caller, but no prompt, reply or key is logged, telemetered or persisted.
 */

import { ProviderError } from './providers.mjs'
import {
  describeOmniRoute,
  isLoopbackOmniRouteUrl,
  omniRouteConfig,
} from './omniroute.mjs'
import { omniRouteTurn } from './omniroute-routing.mjs'

export const CANARY_MODEL = 'zai-org/glm-5.2'
export const CANARY_EXPECTED = 'JARVIS OMNIROUTE CANARY OK'
export const CANARY_PROMPT = `Reply with exactly: ${CANARY_EXPECTED}`
const CANARY_SYSTEM =
  `You are a connectivity canary. Do not call tools. Reply with exactly: ${CANARY_EXPECTED}`

export function canaryReplyMatches(text) {
  const normalized = String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
  return normalized === CANARY_EXPECTED
}

const POLICY_CODES = {
  disabled: 'disabled',
  misconfigured: 'misconfigured',
  'not-configured': 'unconfigured',
  unapproved: 'unapproved',
}

export function omniRouteCanaryEnabled(env = process.env) {
  return String(env.JARVIS_OMNIROUTE_CANARY ?? '').trim() === '1'
}

export function describeOmniRouteCanary(env = process.env) {
  const config = omniRouteConfig(env)
  const status = {
    id: 'omniroute-canary',
    label: 'OmniRoute canary',
    state: 'disabled',
    detail: '',
    model: CANARY_MODEL,
    loopback: isLoopbackOmniRouteUrl(config.baseUrl),
  }

  if (!omniRouteCanaryEnabled(env)) {
    return {
      ...status,
      detail: 'JARVIS_OMNIROUTE_CANARY is not 1; the canary path is off.',
    }
  }
  if (!config.enabled) {
    return {
      ...status,
      detail: 'JARVIS_OMNIROUTE_ENABLED is not 1; the canary cannot override it.',
    }
  }
  if (!status.loopback) {
    return {
      ...status,
      state: 'misconfigured',
      detail: 'the canary requires the loopback OmniRoute endpoint on port 20128 at /v1.',
    }
  }
  if (!config.apiKey) {
    return {
      ...status,
      state: 'not-configured',
      detail: 'JARVIS_OMNIROUTE_API_KEY is not set.',
    }
  }
  if (config.model !== CANARY_MODEL) {
    return {
      ...status,
      state: 'unapproved',
      detail: `the canary only permits ${CANARY_MODEL}.`,
    }
  }
  const allowlist = Array.isArray(config.allowedModels) ? config.allowedModels : []
  if (allowlist.length !== 1 || allowlist[0] !== CANARY_MODEL) {
    return {
      ...status,
      state: 'unapproved',
      detail: `the canary requires the allowlist to contain only ${CANARY_MODEL}.`,
    }
  }
  if (describeOmniRoute(config).state !== 'ready') {
    return {
      ...status,
      state: 'misconfigured',
      detail: 'the underlying OmniRoute boundary is not ready.',
    }
  }
  return {
    ...status,
    state: 'ready',
    detail: 'the canary is explicitly enabled for the one approved model.',
  }
}

export function omniRouteCanaryPolicyError(env = process.env) {
  const status = describeOmniRouteCanary(env)
  if (status.state === 'ready') return null
  return new ProviderError(`OmniRoute canary is not usable (${status.state}).`, {
    code: POLICY_CODES[status.state] ?? 'unavailable',
    provider: 'omniroute',
  })
}

export async function runOmniRouteCanary({ env = process.env, fetchImpl } = {}) {
  const policyError = omniRouteCanaryPolicyError(env)
  if (policyError) throw policyError

  const base = omniRouteConfig(env)
  const config = {
    ...base,
    model: CANARY_MODEL,
    allowedModels: [CANARY_MODEL],
    maxTokens: Math.min(base.maxTokens, 256),
    timeoutMs: Math.min(base.timeoutMs, 30_000),
  }

  let result
  try {
    result = await omniRouteTurn({
      prompt: CANARY_PROMPT,
      system: CANARY_SYSTEM,
      config,
      fetchImpl,
    })
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'unavailable'
    const status = Number.isFinite(err?.status) ? err.status : 0
    throw new ProviderError(`OmniRoute canary failed (${code}).`, {
      code,
      status,
      provider: 'omniroute',
    })
  }

  const matchedExpected =
    result.partial !== true && canaryReplyMatches(result.text)

  return {
    ok: true,
    provider: 'omniroute',
    model: CANARY_MODEL,
    partial: result.partial === true,
    verified: matchedExpected,
    matchedExpected,
    firstTokenMs: result.firstTokenMs,
    totalMs: result.totalMs,
    text: result.text,
    textLength: result.text.length,
    usage: result.usage,
  }
}

const tokenCount = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function safeCanaryReport(report) {
  const usage = report.usage && typeof report.usage === 'object' ? report.usage : {}
  const promptTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens)
  const completionTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens)
  const totalTokens = tokenCount(usage.total_tokens) || promptTokens + completionTokens
  const verified = report.verified === true

  return {
    ok: report.ok === true && verified,
    provider: 'omniroute',
    model: CANARY_MODEL,
    verified,
    matchedExpected: report.matchedExpected === true,
    partial: report.partial === true,
    firstTokenMs: Number(report.firstTokenMs) || 0,
    totalMs: Number(report.totalMs) || 0,
    textLength: Number(report.textLength) || 0,
    promptTokens,
    completionTokens,
    totalTokens,
  }
}
