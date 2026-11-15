import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-privacy-'))
process.env.JARVIS_DB_PATH = join(dir, 'jarvis.db')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' - ' + detail : ''}`)
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

let db
try {
  const database = await import('../bridge/db.mjs')
  const perf = await import('../bridge/perf.mjs')
  const omni = await import('../bridge/omniroute.mjs')
  db = database.db

  const secrets = [
    'my private phrase SSN 123-45-6789',
    'delete all the evidence please',
    'weather in a place I would rather not name',
    'send the private report',
  ]

  perf.recordPerf({
    command: secrets[0],
    intent: 'router',
    routingMs: 12,
    mcpMs: 3,
    success: true,
  })
  perf.recordPerf({
    command: secrets[1],
    intent: 'brain',
    aiMs: 900,
    success: false,
  })
  perf.recordPerf({
    command: secrets[2],
    intent: 'router',
    routingMs: 8,
    speechMs: 120,
    askId: 'ask-1',
    success: true,
  })
  perf.recordPerf({
    command: secrets[3],
    intent: 'confirm:send',
    mcpMs: 4,
    success: true,
  })

  const history = database.many(
    'SELECT raw_command, normalized_command, intent, success FROM command_history ORDER BY id',
  )
  const logs = database.many(
    'SELECT command, intent, total_ms, success, ask_id FROM performance_logs ORDER BY id',
  )
  const historyDump = JSON.stringify(history)
  const logsDump = JSON.stringify(logs)

  eq('history: four rows', history.length, 4)
  eq('logs: four rows', logs.length, 4)
  check('history: raw command is empty', history.every((r) => r.raw_command === ''))
  check('history: normalized command is empty', history.every((r) => r.normalized_command === ''))
  check('history: intent survives',
    history.map((r) => r.intent).join(',') === 'router,brain,router,confirm:send')
  check('history: outcome survives', history.map((r) => r.success).join(',') === '1,0,1,1')
  check('logs: command is only a safe label',
    logs.every((r) => ['router', 'brain', 'confirm:send', 'weather'].includes(r.command)))
  check('logs: weather metric label preserved', logs[2].command === 'weather')
  check('logs: non-weather falls back to intent', logs[3].command === 'confirm:send')
  check('logs: ask id survives', logs[2].ask_id === 'ask-1')
  check('logs: timing survives', logs[1].total_ms >= 900)
  check('history: no test phrase persisted', secrets.every((s) => !historyDump.includes(s)))
  check('logs: no test phrase persisted', secrets.every((s) => !logsDump.includes(s)))
  check('recent perf: no test phrase persisted',
    secrets.every((s) => !JSON.stringify(perf.recentPerf(10)).includes(s)))

  const defaults = omni.omniRouteConfig({})
  eq('omniroute: disabled by default', defaults.enabled, false)
  eq('omniroute: disabled state', omni.describeOmniRoute(defaults).state, 'disabled')
  eq('omniroute: disabled descriptor', omni.omniRouteDescriptor(defaults), null)
  check('omniroute: no API key in status', !JSON.stringify(omni.omniRouteStatus(defaults)).includes('sk-test'))

  const canary = await import('../bridge/omniroute-canary.mjs')
  eq('canary: disabled by default', canary.describeOmniRouteCanary({}).state, 'disabled')
  const canaryEnv = {
    JARVIS_OMNIROUTE_ENABLED: '1',
    JARVIS_OMNIROUTE_CANARY: '1',
    JARVIS_OMNIROUTE_BASE_URL: 'http://127.0.0.1:20128/v1',
    JARVIS_OMNIROUTE_API_KEY: 'sk-test-canary',
    JARVIS_OMNIROUTE_MODEL: canary.CANARY_MODEL,
    JARVIS_OMNIROUTE_ALLOWED_MODELS: canary.CANARY_MODEL,
  }
  eq('canary: ready only when explicitly enabled',
    canary.describeOmniRouteCanary(canaryEnv).state, 'ready')
  check('canary: status never exposes the key',
    !JSON.stringify(canary.describeOmniRouteCanary(canaryEnv)).includes('sk-test-canary'))
  eq('canary: exact model only',
    canary.describeOmniRouteCanary({
      ...canaryEnv,
      JARVIS_OMNIROUTE_MODEL: 'zai/glm-5.2',
    }).state, 'unapproved')

  const configured = omni.omniRouteConfig({
    JARVIS_OMNIROUTE_ENABLED: '1',
    JARVIS_OMNIROUTE_BASE_URL: 'http://127.0.0.1:20128/v1',
    JARVIS_OMNIROUTE_API_KEY: 'sk-test-omniroute',
    JARVIS_OMNIROUTE_MODEL: 'vendor/explicit-model',
    JARVIS_OMNIROUTE_ALLOWED_MODELS: 'vendor/explicit-model',
  })
  eq('omniroute: ready when explicitly configured', omni.describeOmniRoute(configured).state, 'ready')
  check('omniroute: descriptor exists when ready', omni.omniRouteDescriptor(configured)?.model === 'vendor/explicit-model')
  check('omniroute: status never exposes the key',
    !JSON.stringify(omni.omniRouteStatus(configured)).includes('sk-test-omniroute'))

  eq('omniroute: rejects non-loopback host',
    omni.describeOmniRoute({ ...configured, baseUrl: 'http://192.168.1.20:20128/v1' }).state,
    'misconfigured')
  eq('omniroute: rejects wrong port',
    omni.describeOmniRoute({ ...configured, baseUrl: 'http://127.0.0.1:9999/v1' }).state,
    'misconfigured')
  eq('omniroute: rejects wrong path',
    omni.describeOmniRoute({ ...configured, baseUrl: 'http://127.0.0.1:20128' }).state,
    'misconfigured')
  eq('omniroute: rejects auto combo',
    omni.describeOmniRoute({ ...configured, model: 'auto/best-coding' }).state,
    'no-model')
  eq('omniroute: rejects wildcard model',
    omni.describeOmniRoute({ ...configured, model: 'vendor/*' }).state,
    'no-model')
  eq('omniroute: requires an allowlist',
    omni.describeOmniRoute({ ...configured, allowedModels: [] }).state,
    'no-allowlist')
  eq('omniroute: rejects an unapproved model',
    omni.describeOmniRoute({ ...configured, model: 'vendor/not-approved' }).state,
    'unapproved')
  eq('omniroute: missing key', omni.describeOmniRoute({ ...configured, apiKey: '' }).state, 'not-configured')
  eq('omniroute: missing model', omni.describeOmniRoute({ ...configured, model: '' }).state, 'no-model')
  check('omniroute: localhost allowed', omni.isLoopbackOmniRouteUrl('http://localhost:20128/v1'))
  check('omniroute: ipv6 loopback allowed', omni.isLoopbackOmniRouteUrl('http://[::1]:20128/v1/'))
  check('omniroute: query string rejected', !omni.isLoopbackOmniRouteUrl('http://127.0.0.1:20128/v1?x=1'))
  check('omniroute: remote host rejected', !omni.isLoopbackOmniRouteUrl('https://omniroute.example.com:20128/v1'))

  const saved = {
    enabled: process.env.JARVIS_OMNIROUTE_ENABLED,
    baseUrl: process.env.JARVIS_OMNIROUTE_BASE_URL,
    apiKey: process.env.JARVIS_OMNIROUTE_API_KEY,
    model: process.env.JARVIS_OMNIROUTE_MODEL,
  }
  process.env.JARVIS_OMNIROUTE_ENABLED = '1'
  process.env.JARVIS_OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
  process.env.JARVIS_OMNIROUTE_API_KEY = 'sk-test-omniroute'
  process.env.JARVIS_OMNIROUTE_MODEL = 'vendor/explicit-model'
  const { cloudChain } = await import('../bridge/ai.mjs')
  check('active routing: omniroute stays out of the cloud chain',
    !cloudChain('simple').some((p) => p.id === 'omniroute'))
  for (const [key, value] of Object.entries(saved)) {
    const name = {
      enabled: 'JARVIS_OMNIROUTE_ENABLED',
      baseUrl: 'JARVIS_OMNIROUTE_BASE_URL',
      apiKey: 'JARVIS_OMNIROUTE_API_KEY',
      model: 'JARVIS_OMNIROUTE_MODEL',
    }[key]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
} finally {
  try {
    db?.close()
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {}
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
