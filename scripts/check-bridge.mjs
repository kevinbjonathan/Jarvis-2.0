/**
 * Bridge connection regression check.
 *
 * Verifies the exact path the Jarvis UI depends on: the face on localhost:5173
 * opening a WebSocket to the bridge. Run it any time the UI says
 * "Cannot reach the bridge at ws://localhost:8787":
 *
 *   node scripts/check-bridge.mjs
 *
 * Exit code 0 = the bridge is healthy and the UI will connect. Anything else =
 * the port is wrong, the bridge is down, or origin handling is off.
 */

import { createRequire } from 'node:module'
const { WebSocket } = createRequire(import.meta.url)('ws')

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const BASE = `http://localhost:${PORT}`
const WS = `ws://localhost:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function httpOk(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  return res.ok ? await res.json().catch(() => null) : null
}

function wsUpgrade(href, origin, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(href, { origin })
    const timer = setTimeout(() => {
      ws.terminate()
      resolve(null)
    }, timeoutMs)
    ws.on('open', () => {
      clearTimeout(timer)
      ws.terminate()
      resolve('open')
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

console.log(`checking bridge on ${BASE} (set JARVIS_BRIDGE_PORT to change)\n`)

// 1. HTTP health over IPv4 explicitly.
const health4 = await httpOk(`http://127.0.0.1:${PORT}/health`)
check('health on 127.0.0.1', Boolean(health4?.ok), JSON.stringify(health4 ?? null))

// 2. HTTP health through the `localhost` hostname (IPv6 ::1 first, IPv4 fallback).
const healthLocal = await httpOk(`${BASE}/health`)
check('health on localhost', Boolean(healthLocal?.ok), JSON.stringify(healthLocal ?? null))

// 3. WebSocket upgrade from the documented face origins.
const ws5173 = await wsUpgrade(WS, `http://localhost:5173`)
check('WebSocket upgrade from http://localhost:5173', ws5173 === 'open', 'ws://localhost:8787')

const ws4173 = await wsUpgrade(WS, `http://127.0.0.1:4173`)
check('WebSocket upgrade from http://127.0.0.1:4173', ws4173 === 'open', 'ws://localhost:8787')

// 4. A foreign origin must still be refused — origin validation is alive, not disabled.
const foreign = await wsUpgrade(WS, 'http://evil.example:8080')
check('foreign origin is refused (403)', foreign === null, 'origin validation intact')

// 5. /health should describe the running configuration, not just say ok — the
//    frontend circuit reads this shape (model, writes, browser, servers).
const lively =
  healthLocal?.ok &&
  typeof healthLocal?.model === 'string' &&
  typeof healthLocal?.writes === 'boolean' &&
  typeof healthLocal?.browser === 'boolean' &&
  Array.isArray(healthLocal?.servers)
check(
  'health reports model/writes/browser/servers',
  lively,
  healthLocal?.model ? `model ${healthLocal.model} · browser ${healthLocal.browser}` : 'missing fields',
)

// 6. Heartbeat: an application-level ping must get a pong back. This is what
//    lets the frontend keep a socket alive and detect a half-open connection.
const pingPong = await new Promise((resolve) => {
  const ws = new WebSocket(WS, { origin: 'http://localhost:5173' })
  const timer = setTimeout(() => {
    ws.terminate()
    resolve(false)
  }, 6000)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })))
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString())
      if (m.type === 'pong') {
        clearTimeout(timer)
        ws.terminate()
        resolve(true)
      }
    } catch {
      /* not ours */
    }
  })
  ws.on('error', () => {
    clearTimeout(timer)
    resolve(false)
  })
})
check('websocket ping answered with a pong', pingPong === true, 'heartbeat round trip')

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n${passed} passed, ${failed} failed.`)

if (failed) {
  console.log(
    '\nIf every health check fails, start the bridge first:  npm run bridge:writes',
  )
}
// Let open sockets finish closing rather than hard-exiting (which trips a
// Windows uv-async assertion in older Node when a ws handle is mid-close).
process.exitCode = failed ? 1 : 0