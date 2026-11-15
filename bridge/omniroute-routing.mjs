import { ProviderError, providerRequest, streamChat } from './providers.mjs'
import { describeOmniRoute, omniRouteConfig, omniRouteDescriptor } from './omniroute.mjs'

const POLICY_CODES = {
  disabled: 'disabled',
  misconfigured: 'misconfigured',
  'not-configured': 'unconfigured',
  'no-model': 'unapproved',
  'no-allowlist': 'unapproved',
  unapproved: 'unapproved',
}

export function omniRoutePolicyError(config = omniRouteConfig()) {
  const status = describeOmniRoute(config)
  if (status.state === 'ready') return null
  return new ProviderError(`OmniRoute is not usable (${status.state}).`, {
    code: POLICY_CODES[status.state] ?? 'unavailable',
    provider: 'omniroute',
  })
}

export async function omniRouteTurn({
  prompt,
  system = '',
  context = '',
  signal,
  onDelta,
  config = omniRouteConfig(),
  fetchImpl,
} = {}) {
  const policyError = omniRoutePolicyError(config)
  if (policyError) throw policyError

  const descriptor = omniRouteDescriptor(config)
  if (!descriptor) {
    throw new ProviderError('OmniRoute is not usable.', {
      code: 'unavailable',
      provider: 'omniroute',
    })
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  if (context) messages.push({ role: 'system', content: context })
  messages.push({ role: 'user', content: String(prompt ?? '') })

  const result = await streamChat({
    ...providerRequest(descriptor),
    messages,
    signal,
    onDelta,
    fetchImpl,
  })

  return {
    provider: 'omniroute',
    model: descriptor.model,
    text: result.text,
    firstTokenMs: result.firstTokenMs,
    totalMs: result.totalMs,
    partial: result.partial === true,
    usage: result.usage,
  }
}
