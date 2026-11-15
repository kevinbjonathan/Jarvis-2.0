/**
 * AI gateway regression check — fully offline, no credentials required.
 *
 *   node scripts/check-ai.mjs
 *
 * Two halves:
 *   1. pure logic — the intent classifier, the free-model rule, the config
 *      defaults and the provider-chain states. No network, no keys.
 *   2. the streaming adapter — exercised against a throwaway HTTP server that
 *      speaks SSE by hand, so framing, usage, partials, aborts and every error
 *      classification are proven without a single outbound request.
 *
 * Exit code 0 = the gateway behaves. Anything else = the routing or the
 * streaming parser changed shape.
 */

import { createServer } from 'node:http'

// Pin the environment BEFORE importing anything that reads it. env.mjs never
// overrides a variable that is already present, so defining them here (even as
// empty) keeps a developer's real .env from changing the result of this test.
process.env.OPENROUTER_API_KEY = ''
process.env.OPENROUTER_MODEL = ''
process.env.NVIDIA_API_KEY = ''
process.env.NVIDIA_MODEL = ''
process.env.GEMINI_API_KEY = ''
process.env.GEMINI_MODEL = ''
process.env.AI_BILLING_MODE = 'free_only'
process.env.AI_PROVIDER = 'auto'
delete process.env.AI_FREE_MODELS
delete process.env.NVIDIA_FREE

const { aiConfig, aiStatus, aiTurn, classify, cloudChain, isFreeModel } = await import('../bridge/ai.mjs')
const { GEMINI_BASE_URL, providerRequest, redact, streamChat } = await import('../bridge/providers.mjs')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/* ------------------------------------------------------------------ 1. logic */

check('classify: "open gmail" → tools', classify('open gmail') === 'tools')
check('classify: "what time is it" → simple', classify('what time is it') === 'simple')
check('classify: long question → reasoning', classify(
  'compare the trade offs of running a local model against a hosted one for a small always on assistant'
) === 'reasoning')
check('classify: "why is the sky blue" → reasoning', classify('why is the sky blue') === 'reasoning')
check('classify: two sources → gather',
  classify('summarize my schedule and unread emails for today') === 'gather')
check('classify: write request stays tools',
  classify('email my schedule to james') === 'tools')
check('classify: empty → tools', classify('   ') === 'tools')

check('isFreeModel: ":free" suffix', isFreeModel('meta-llama/llama-3.1-8b-instruct:free') === true)
check('isFreeModel: paid id is not free', isFreeModel('openai/gpt-4o') === false)
check('isFreeModel: openrouter/free', isFreeModel('openrouter/free') === true)
check('isFreeModel: AI_FREE_MODELS entry', (() => {
  process.env.AI_FREE_MODELS = 'vendor/some-model'
  const ok = isFreeModel('vendor/some-model')
  delete process.env.AI_FREE_MODELS
  return ok === true
})())

check('redact: bearer token', !redact('Bearer sk-or-v1-abcdefghijklmnop').includes('abcdefghijklmnop'))
check('redact: nvapi key', !redact('key nvapi-1234567890abcdef').includes('1234567890abcdef'))
check('redact: long run redacted', redact('x'.repeat(40)).includes('[redacted]'))
check('redact: short words survive', redact('the model said hello') === 'the model said hello')

const cfg = aiConfig()
eq('config: default billing mode', cfg.billingMode, 'free_only')
check('config: free only is on by default', cfg.freeOnly === true)
eq('config: default provider', cfg.provider, 'auto')
eq('config: default fallback', cfg.fallback, 'opencode')
check('config: timeout failover enabled by default', cfg.fallbackOnTimeout === true)
eq('config: simple timeout is bounded', cfg.timeoutMs, 10_000)
eq('config: reasoning timeout is bounded', cfg.reasoningTimeoutMs, 20_000)

check('chain: empty with no keys', cloudChain('simple').length === 0)

process.env.OPENROUTER_API_KEY = 'sk-test'
process.env.OPENROUTER_MODEL = 'meta-llama/llama-3.1-8b-instruct:free'
eq('chain: one ready provider', cloudChain('simple').length, 1)
eq('chain: uses the configured model', cloudChain('simple')[0].model, 'meta-llama/llama-3.1-8b-instruct:free')

process.env.GEMINI_API_KEY = 'AIzaSyTestOnlyNotARealCredential000000000'
process.env.GEMINI_MODEL = 'gemini-3.8-flash'
process.env.AI_FREE_MODELS = 'gemini-3.8-flash'
const hybridChain = cloudChain('simple')
eq('chain: Gemini follows OpenRouter', hybridChain.map((p) => p.id).join(','), 'openrouter,gemini')
eq('Gemini: OpenAI-compatible endpoint', hybridChain[1].baseUrl, GEMINI_BASE_URL)
eq('Gemini: explicit model retained', hybridChain[1].model, 'gemini-3.8-flash')
check('Gemini: provider request keeps its provider and endpoint', (() => {
  const request = providerRequest(hybridChain[1])
  return request.provider === 'gemini' && request.baseUrl === GEMINI_BASE_URL
})())
check('Gemini: key omitted from status', !JSON.stringify(aiStatus()).includes(process.env.GEMINI_API_KEY))
process.env.AI_PROVIDER = 'gemini'
eq('Gemini: can be selected directly', cloudChain('simple').map((p) => p.id).join(','), 'gemini')
process.env.AI_PROVIDER = 'auto'
process.env.GEMINI_API_KEY = ''
process.env.GEMINI_MODEL = ''
delete process.env.AI_FREE_MODELS

process.env.OPENROUTER_MODEL = 'openai/gpt-4o'
check('chain: paid model refused in free_only', cloudChain('simple').length === 0)

process.env.AI_BILLING_MODE = 'standard'
eq('chain: paid model allowed in standard', cloudChain('simple').length, 1)
process.env.AI_BILLING_MODE = 'free_only'
process.env.OPENROUTER_MODEL = 'meta-llama/llama-3.1-8b-instruct:free'

// Reasoning tier must never silently upgrade to an unverified paid model.
process.env.OPENROUTER_REASONING_MODEL = 'openai/o3'
eq('chain: reasoning falls back to the free primary', cloudChain('reasoning')[0].model,
  'meta-llama/llama-3.1-8b-instruct:free')
delete process.env.OPENROUTER_REASONING_MODEL

const status = aiStatus()
eq('status: reports active provider', status.providers.openrouter.state, 'ready')
check('status: exposes timeout failover settings', status.fallbackOnTimeout === true && status.timeoutMs === 10_000 && status.reasoningTimeoutMs === 20_000)
eq('status: nvidia not configured', status.providers.nvidia.state, 'not-configured')
eq('status: Gemini not configured', status.providers.gemini.state, 'not-configured')

// A transient empty stream must cool down briefly, then rejoin the provider
// chain. It must not strand the assistant on OpenCode until the next restart.
{
  process.env.AI_PROVIDER = 'openrouter'
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.OPENROUTER_MODEL = 'openrouter/free'
  const realNow = Date.now
  let fakeNow = realNow()
  Date.now = () => fakeNow
  try {
    try {
      await aiTurn({
        prompt: 'Say OK.',
        fetchImpl: async () => new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      })
    } catch {
      // The empty reply is the simulated upstream failure under test.
    }
    eq('provider: empty reply enters temporary cooldown', aiStatus().providers.openrouter.state, 'cooldown')
    eq('provider: cooldown avoids immediate retry', cloudChain('simple').length, 0)
    fakeNow += 16_000
    eq('provider: transient provider rejoins after cooldown', cloudChain('simple').length, 1)
  } finally {
    Date.now = realNow
    process.env.AI_PROVIDER = 'auto'
    process.env.OPENROUTER_API_KEY = ''
    process.env.OPENROUTER_MODEL = ''
  }
}

/* ------------------------------------------------- 2. the streaming adapter */

/** A scripted provider: whatever `handler` does is what the client sees. */
function mockProvider(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

const sse = (res) => res.writeHead(200, { 'content-type': 'text/event-stream' })

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const content = (t) => frame({ choices: [{ delta: { content: t } }] })

// 2a. A normal stream: two deltas, a usage frame, then [DONE].
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    sse(res)
    res.write(content('Good '))
    res.write(content('evening, sir.'))
    res.write(frame({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 4 } }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  const deltas = []
  const out = await streamChat({
    provider: 'openrouter', baseUrl, apiKey: 'sk-test', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => deltas.push(d),
    timeoutMs: 5000,
  })
  eq('stream: text assembled', out.text, 'Good evening, sir.')
  eq('stream: two deltas observed', deltas.length, 2)
  eq('stream: usage captured', out.usage?.completion_tokens, 4)
  eq('stream: not partial', out.partial, false)
  check('stream: first token measured', out.firstTokenMs >= 0)
  server.close()
}

// 2b. The body stops without [DONE] — a truncated reply, not a completed one.
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    sse(res)
    res.write(content('The answer is'))
    res.end()
  })
  const out = await streamChat({
    provider: 'openrouter', baseUrl, apiKey: 'sk-test', model: 'm',
    messages: [], timeoutMs: 5000,
  })
  eq('stream: partial kept', out.text, 'The answer is')
  eq('stream: marked partial', out.partial, true)
  server.close()
}

// 2c. Every HTTP error the gateway routes on.
for (const [status, match] of [
  [401, 'auth'], [402, 'quota'], [500, 'unavailable'], [404, 'unavailable'],
]) {
  const { server, baseUrl } = await mockProvider((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `http ${status}` } }))
  })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 5000 })
  } catch (err) {
    got = err.code
  }
  eq(`error: HTTP ${status} → ${match}`, got, match)
  server.close()
}

// 2d. 429 splits into rate-limit and exhausted-capacity.
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'slow down' } }))
  })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 5000 })
  } catch (err) { got = err.code }
  eq('error: HTTP 429 plain → rate', got, 'rate')
  server.close()
}
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'insufficient credit on your free tier' } }))
  })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 5000 })
  } catch (err) { got = err.code }
  eq('error: HTTP 429 exhausted → quota', got, 'quota')
  server.close()
}

// 2e. STOP: an external abort mid-stream is 'aborted', never a retryable error.
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    sse(res)
    res.write(content('Starting'))
    // Never end — the client's abort must be what finishes this.
  })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 120)
  let got = null
  try {
    await streamChat({
      provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm',
      messages: [], timeoutMs: 30_000, signal: ac.signal,
    })
  } catch (err) { got = err.code }
  eq('error: external abort → aborted', got, 'aborted')
  server.close()
}

// 2f. A timeout is its own code, distinct from an abort.
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    res.write('data: {"choices":[{"delta":{"content":"thinking"}}]}\n\n')
    // Stall forever.
  })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 150 })
  } catch (err) { got = err.code }
  // It emitted text before stalling, so a partial is returned instead.
  check('timeout with text returns a partial, not a throw', got === null)
  server.close()
}
{
  const { server, baseUrl } = await mockProvider(() => { /* accept, reply nothing, stall */ })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 150 })
  } catch (err) { got = err.code }
  eq('error: timeout with no text → timeout', got, 'timeout')
  server.close()
}

// 2g. A frame carrying an error object mid-stream is classified, not swallowed.
{
  const { server, baseUrl } = await mockProvider((req, res) => {
    sse(res)
    res.write(content('partial '))
    res.write(frame({ error: { code: 429, message: 'rate limited by provider' } }))
    res.end()
  })
  let got = null
  try {
    await streamChat({ provider: 'openrouter', baseUrl, apiKey: 'k', model: 'm', messages: [], timeoutMs: 5000 })
  } catch (err) { got = err.code }
  eq('error: in-stream error frame → rate', got, 'rate')
  server.close()
}

/* ------------------------------------------------------------------ verdict */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n${passed} passed, ${failed} failed.`)
if (failed) console.log('\nThe gateway logic or its stream parser changed shape — see the FAIL lines above.')
process.exitCode = failed ? 1 : 0
