process.env.OPENROUTER_API_KEY = ''
process.env.OPENROUTER_MODEL = ''
process.env.NVIDIA_API_KEY = ''
process.env.NVIDIA_MODEL = ''
process.env.AI_BILLING_MODE = 'free_only'
process.env.AI_PROVIDER = 'auto'
delete process.env.AI_FREE_MODELS
delete process.env.NVIDIA_FREE
delete process.env.JARVIS_OMNIROUTE_ENABLED
delete process.env.JARVIS_OMNIROUTE_ALLOWED_MODELS

const { aiStatus, cloudChain } = await import('../bridge/ai.mjs')
const { omniRouteConfig, describeOmniRoute, omniRouteStatus } = await import('../bridge/omniroute.mjs')
const { omniRouteTurn } = await import('../bridge/omniroute-routing.mjs')
const {
  CANARY_EXPECTED,
  CANARY_MODEL,
  CANARY_PROMPT,
  canaryReplyMatches,
  describeOmniRouteCanary,
  runOmniRouteCanary,
  safeCanaryReport,
} = await import('../bridge/omniroute-canary.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`)
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

const encoder = new TextEncoder()
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const content = (text) => frame({ choices: [{ delta: { content: text } }] })
const sse = (chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const mock = (handler) => {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        init,
        body: init?.body ? JSON.parse(init.body) : null,
      })
      return handler(url, init, calls.length)
    },
  }
}

const base = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKey: 'sk-test-omniroute-key',
  model: 'vendor/explicit-model',
  allowedModels: ['vendor/explicit-model'],
  maxTokens: 32,
  timeoutMs: 5000,
}

const providerError = async (name, config, handler, options = {}) => {
  const m = mock(handler)
  let err = null
  try {
    await omniRouteTurn({ prompt: 'private prompt', config, fetchImpl: m.fetchImpl, ...options })
  } catch (caught) {
    err = caught
  }
  eq(`${name}: code`, err?.code, options.want)
  eq(`${name}: no fallback request`, m.calls.length, options.calls ?? 0)
  return { err, calls: m.calls }
}

{
  const ready = mock(() =>
    sse([content('Controlled '), content('reply.'), 'data: [DONE]\n\n']),
  )
  const out = await omniRouteTurn({
    prompt: 'private prompt',
    system: 'system prompt',
    config: base,
    fetchImpl: ready.fetchImpl,
  })
  eq('success: provider', out.provider, 'omniroute')
  eq('success: model', out.model, base.model)
  eq('success: text', out.text, 'Controlled reply.')
  eq('success: partial', out.partial, false)
  check('success: exactly one request', ready.calls.length === 1)
  eq('success: loopback endpoint',
    ready.calls[0].url, 'http://127.0.0.1:20128/v1/chat/completions')
  eq('success: explicit model sent', ready.calls[0].body.model, base.model)
  eq('success: system message included', ready.calls[0].body.messages[0].role, 'system')
  eq('success: user message last', ready.calls[0].body.messages.at(-1).role, 'user')
  check('success: key sent only in auth header',
    ready.calls[0].init.headers.authorization === `Bearer ${base.apiKey}`)
}

{
  let called = 0
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: omniRouteConfig({}),
      fetchImpl: async () => { called += 1; return sse([]) },
    })
  } catch (caught) {
    err = caught
  }
  eq('disabled: code', err?.code, 'disabled')
  eq('disabled: no request', called, 0)
  eq('disabled: state', describeOmniRoute(omniRouteConfig({})).state, 'disabled')
}

await providerError('missing-key', { ...base, apiKey: '' }, () => sse([]), {
  want: 'unconfigured',
})
await providerError('invalid-key-401', base, () =>
  json(401, { error: { message: `bad key ${base.apiKey}` } }), {
  want: 'auth',
  calls: 1,
})
await providerError('invalid-key-403', base, () =>
  json(403, { error: { message: 'forbidden' } }), {
  want: 'auth',
  calls: 1,
})
await providerError('rate-limit-429', base, () =>
  json(429, { error: { message: 'slow down' } }), {
  want: 'rate',
  calls: 1,
})
await providerError('quota-429', base, () =>
  json(429, { error: { message: 'insufficient credit on free tier' } }), {
  want: 'quota',
  calls: 1,
})
await providerError('provider-500', base, () =>
  json(500, { error: { message: 'upstream failed' } }), {
  want: 'unavailable',
  calls: 1,
})
await providerError('model-unavailable-404', base, () =>
  json(404, { error: { message: 'model not found' } }), {
  want: 'unavailable',
  calls: 1,
})

await providerError('malformed-200', base, () => new Response('not an sse stream', {
  status: 200,
  headers: { 'content-type': 'text/plain' },
}), { want: 'unavailable', calls: 1 })

await providerError('timeout', { ...base, timeoutMs: 80 }, (_url, init) => new Promise((resolve, reject) => {
  const signal = init?.signal
  const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  if (signal?.aborted) fail()
  else signal?.addEventListener('abort', fail, { once: true })
}), { want: 'timeout', calls: 1 })

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: { ...base, model: 'auto/best-coding', allowedModels: ['auto/best-coding'] },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('auto model: code', err?.code, 'unapproved')
  eq('auto model: no request', m.calls.length, 0)
  eq('auto model: state', describeOmniRoute({
    ...base,
    model: 'auto/best-coding',
    allowedModels: ['auto/best-coding'],
  }).state, 'no-model')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: { ...base, model: 'vendor/*', allowedModels: ['vendor/*'] },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('wildcard model: code', err?.code, 'unapproved')
  eq('wildcard model: no request', m.calls.length, 0)
  eq('wildcard model: state', describeOmniRoute({
    ...base,
    model: 'vendor/*',
    allowedModels: ['vendor/*'],
  }).state, 'no-model')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: { ...base, baseUrl: 'http://192.168.1.20:20128/v1' },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('non-loopback: code', err?.code, 'misconfigured')
  eq('non-loopback: no request', m.calls.length, 0)
  eq('non-loopback: state', describeOmniRoute({
    ...base,
    baseUrl: 'http://192.168.1.20:20128/v1',
  }).state, 'misconfigured')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: { ...base, allowedModels: ['vendor/other-model'] },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('unapproved model: code', err?.code, 'unapproved')
  eq('unapproved model: no request', m.calls.length, 0)
  eq('unapproved model: state', describeOmniRoute({
    ...base,
    allowedModels: ['vendor/other-model'],
  }).state, 'unapproved')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'hello',
      config: { ...base, allowedModels: [] },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('empty allowlist: code', err?.code, 'unapproved')
  eq('empty allowlist: no request', m.calls.length, 0)
  eq('empty allowlist: state', describeOmniRoute({ ...base, allowedModels: [] }).state, 'no-allowlist')
}

eq('invalid allowlist entry: state', describeOmniRoute({
  ...base,
  allowedModels: ['vendor/explicit-model', 'auto/*'],
}).state, 'misconfigured')

{
  const original = { log: console.log, warn: console.warn, error: console.error }
  const captured = []
  console.log = console.warn = console.error = (...args) => captured.push(args.join(' '))
  let err = null
  try {
    await omniRouteTurn({
      prompt: 'private prompt body',
      config: base,
      fetchImpl: async () => json(401, {
        error: { message: `bad key ${base.apiKey} private prompt body` },
      }),
    })
  } catch (caught) {
    err = caught
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  check('privacy: no console output leaked the key or prompt',
    captured.every((line) =>
      !line.includes(base.apiKey) && !line.includes('private prompt body')))
  check('privacy: error text stays redacted',
    !String(err?.message).includes(base.apiKey) &&
      !String(err?.message).includes('private prompt body'))
  check('privacy: status never exposes the key',
    !JSON.stringify(omniRouteStatus(base)).includes(base.apiKey))
  check('privacy: status exposes only the allowlist',
    JSON.stringify(omniRouteStatus(base).allowedModels) === JSON.stringify(base.allowedModels))
}

/* ------------------------------------------------------------ Stage E canary */

const canaryEnv = {
  JARVIS_OMNIROUTE_ENABLED: '1',
  JARVIS_OMNIROUTE_CANARY: '1',
  JARVIS_OMNIROUTE_BASE_URL: base.baseUrl,
  JARVIS_OMNIROUTE_API_KEY: base.apiKey,
  JARVIS_OMNIROUTE_MODEL: CANARY_MODEL,
  JARVIS_OMNIROUTE_ALLOWED_MODELS: CANARY_MODEL,
  JARVIS_OMNIROUTE_MAX_TOKENS: '512',
  JARVIS_OMNIROUTE_TIMEOUT_MS: '5000',
}

const canaryError = async (name, env, handler, want) => {
  const m = mock(handler)
  let err = null
  try {
    await runOmniRouteCanary({ env, fetchImpl: m.fetchImpl })
  } catch (caught) {
    err = caught
  }
  eq(`${name}: code`, err?.code, want)
  eq(`${name}: requests`, m.calls.length, want === 'disabled' ? 0 : 1)
  check(`${name}: message carries no key or prompt`,
    !String(err?.message).includes(base.apiKey) && !String(err?.message).includes(CANARY_PROMPT))
  return m.calls
}

{
  const m = mock(() => sse([
    content(CANARY_EXPECTED),
    frame({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }),
    'data: [DONE]\n\n',
  ]))
  const out = await runOmniRouteCanary({ env: canaryEnv, fetchImpl: m.fetchImpl })
  const safe = safeCanaryReport(out)
  eq('canary: provider', out.provider, 'omniroute')
  eq('canary: model', out.model, CANARY_MODEL)
  eq('canary: reply', out.text, CANARY_EXPECTED)
  eq('canary: verified', out.verified, true)
  eq('canary: expected match flagged', out.matchedExpected, true)
  eq('canary: not partial', out.partial, false)
  check('canary: exactly one request', m.calls.length === 1)
  eq('canary: loopback endpoint', m.calls[0].url, 'http://127.0.0.1:20128/v1/chat/completions')
  eq('canary: approved model sent', m.calls[0].body.model, CANARY_MODEL)
  eq('canary: fixed prompt sent', m.calls[0].body.messages.at(-1).content, CANARY_PROMPT)
  eq('canary: token cap is bounded', m.calls[0].body.max_tokens, 256)
  check('canary: key stays in the auth header',
    m.calls[0].init.headers.authorization === `Bearer ${base.apiKey}`)
  check('canary: normalized expected reply accepted',
    canaryReplyMatches(`"${CANARY_EXPECTED}."`))
  check('canary: short reply rejected', !canaryReplyMatches('OK'))
  eq('canary: safe report keeps the model', safe.model, CANARY_MODEL)
  eq('canary: safe report marks the expected match', safe.matchedExpected, true)
  eq('canary: safe report prompt tokens', safe.promptTokens, 11)
  eq('canary: safe report completion tokens', safe.completionTokens, 7)
  eq('canary: safe report total tokens', safe.totalTokens, 18)
  check('canary: safe report omits raw text and prompt',
    !Object.prototype.hasOwnProperty.call(safe, 'text') &&
      !JSON.stringify(safe).includes(base.apiKey) &&
      !JSON.stringify(safe).includes(CANARY_PROMPT))
}

{
  const m = mock(() => sse([content('OK'), 'data: [DONE]\n\n']))
  const out = await runOmniRouteCanary({ env: canaryEnv, fetchImpl: m.fetchImpl })
  eq('canary: unexpected reply is not verified', out.verified, false)
  eq('canary: unexpected reply is flagged', out.matchedExpected, false)
  eq('canary: unexpected reply still makes one request', m.calls.length, 1)
  eq('canary: unexpected reply report is not ok', safeCanaryReport(out).ok, false)
}

{
  let called = 0
  let err = null
  try {
    await runOmniRouteCanary({
      env: {},
      fetchImpl: async () => { called += 1; return sse([]) },
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: disabled by default', err?.code, 'disabled')
  eq('canary: disabled makes no request', called, 0)
  eq('canary: default state', describeOmniRouteCanary({}).state, 'disabled')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await runOmniRouteCanary({
      env: { ...canaryEnv, JARVIS_OMNIROUTE_ENABLED: '' },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: cannot override the main switch', err?.code, 'disabled')
  eq('canary: main switch off makes no request', m.calls.length, 0)
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await runOmniRouteCanary({
      env: { ...canaryEnv, JARVIS_OMNIROUTE_MODEL: 'zai/glm-5.2' },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: unapproved model', err?.code, 'unapproved')
  eq('canary: unapproved model makes no request', m.calls.length, 0)
  eq('canary: unapproved model state',
    describeOmniRouteCanary({ ...canaryEnv, JARVIS_OMNIROUTE_MODEL: 'zai/glm-5.2' }).state,
    'unapproved')
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await runOmniRouteCanary({
      env: { ...canaryEnv, JARVIS_OMNIROUTE_ALLOWED_MODELS: `${CANARY_MODEL},zai/other` },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: extra allowlist entry rejected', err?.code, 'unapproved')
  eq('canary: extra allowlist makes no request', m.calls.length, 0)
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await runOmniRouteCanary({
      env: { ...canaryEnv, JARVIS_OMNIROUTE_API_KEY: '' },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: missing key', err?.code, 'unconfigured')
  eq('canary: missing key makes no request', m.calls.length, 0)
}

{
  const m = mock(() => sse([]))
  let err = null
  try {
    await runOmniRouteCanary({
      env: { ...canaryEnv, JARVIS_OMNIROUTE_BASE_URL: 'http://192.168.1.20:20128/v1' },
      fetchImpl: m.fetchImpl,
    })
  } catch (caught) {
    err = caught
  }
  eq('canary: non-loopback rejected', err?.code, 'misconfigured')
  eq('canary: non-loopback makes no request', m.calls.length, 0)
}

await canaryError('canary-401', canaryEnv,
  () => json(401, { error: { message: `bad key ${base.apiKey} ${CANARY_PROMPT}` } }),
  'auth')
await canaryError('canary-403', canaryEnv,
  () => json(403, { error: { message: 'forbidden' } }), 'auth')
await canaryError('canary-429', canaryEnv,
  () => json(429, { error: { message: 'slow down' } }), 'rate')
await canaryError('canary-quota', canaryEnv,
  () => json(429, { error: { message: 'insufficient credit' } }), 'quota')
await canaryError('canary-500', canaryEnv,
  () => json(500, { error: { message: `upstream failed ${base.apiKey}` } }), 'unavailable')
await canaryError('canary-malformed', canaryEnv,
  () => new Response('not an sse stream', { status: 200, headers: { 'content-type': 'text/plain' } }),
  'unavailable')
await canaryError('canary-empty', canaryEnv, () => sse([]), 'unavailable')
await canaryError('canary-timeout', { ...canaryEnv, JARVIS_OMNIROUTE_TIMEOUT_MS: '80' },
  (_url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail, { once: true })
  }), 'timeout')

{
  const m = mock(() => sse([content(CANARY_EXPECTED)]))
  const out = await runOmniRouteCanary({ env: canaryEnv, fetchImpl: m.fetchImpl })
  eq('canary: partial is marked', out.partial, true)
  eq('canary: partial is not verified', out.verified, false)
  eq('canary: partial expected match is flagged false', out.matchedExpected, false)
  eq('canary: partial still makes one request', m.calls.length, 1)
}

{
  const m = mock(() => sse([
    content('partial '),
    frame({ error: { code: '500', message: `bad ${base.apiKey} ${CANARY_PROMPT}` } }),
  ]))
  let err = null
  try {
    await runOmniRouteCanary({ env: canaryEnv, fetchImpl: m.fetchImpl })
  } catch (caught) {
    err = caught
  }
  eq('canary: in-stream error', err?.code, 'unavailable')
  eq('canary: in-stream error makes one request', m.calls.length, 1)
  check('canary: in-stream error stays redacted',
    !String(err?.message).includes(base.apiKey) && !String(err?.message).includes(CANARY_PROMPT))
}

const saved = {
  enabled: process.env.JARVIS_OMNIROUTE_ENABLED,
  baseUrl: process.env.JARVIS_OMNIROUTE_BASE_URL,
  apiKey: process.env.JARVIS_OMNIROUTE_API_KEY,
  model: process.env.JARVIS_OMNIROUTE_MODEL,
  allowedModels: process.env.JARVIS_OMNIROUTE_ALLOWED_MODELS,
}
process.env.JARVIS_OMNIROUTE_ENABLED = '1'
process.env.JARVIS_OMNIROUTE_BASE_URL = base.baseUrl
process.env.JARVIS_OMNIROUTE_API_KEY = base.apiKey
process.env.JARVIS_OMNIROUTE_MODEL = base.model
process.env.JARVIS_OMNIROUTE_ALLOWED_MODELS = base.allowedModels.join(',')
eq('routing: env configuration can become ready', describeOmniRoute(omniRouteConfig()).state, 'ready')
check('routing: omniroute stays out of cloudChain',
  !cloudChain('simple').some((p) => p.id === 'omniroute'))
check('routing: aiStatus providers still exclude omniroute',
  !Object.prototype.hasOwnProperty.call(aiStatus().providers, 'omniroute'))
for (const [key, value] of Object.entries(saved)) {
  const name = {
    enabled: 'JARVIS_OMNIROUTE_ENABLED',
    baseUrl: 'JARVIS_OMNIROUTE_BASE_URL',
    apiKey: 'JARVIS_OMNIROUTE_API_KEY',
    model: 'JARVIS_OMNIROUTE_MODEL',
    allowedModels: 'JARVIS_OMNIROUTE_ALLOWED_MODELS',
  }[key]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
