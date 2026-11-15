/**
 * Systems health for the bridge.
 *
 * /systems (a browser- and script-friendly JSON snapshot) and
 * services_status (the same picture as a model-facing tool) share one builder
 * so they cannot drift apart. Per-server state comes from a function injected
 * by server.mjs, which holds the live servers; the bits that live here — pid,
 * uptime, the gesture runtime on disk — are computed in this module.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MEDIAPIPE_WASM = join(HERE, '..', 'public', 'mediapipe', 'vision_wasm_internal.wasm')

/** Static facts every status consumer needs, computed here once per read. */
function localFacts() {
  return {
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    mediapipe: existsSync(MEDIAPIPE_WASM),
  }
}

export function systemsServer(bridgeStatus) {
  return {
    tools: [
      {
        name: 'services_status',
        description:
          'A quick health picture of every JARVIS service: the bridge, the model ' +
          'mode (writes on or off), the browser bridge, gesture support, the ' +
          'MCP servers and whether Google (Gmail/Calendar) is connected. Use ' +
          'when the user asks "are you all right", "is everything working", or ' +
          'after something failed and you want to say what is actually down.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const s = bridgeStatus()
          const l = localFacts()
          const lines = [
            `Bridge: up for ${l.uptime_s}s (pid ${l.pid}) with ${s.mcp?.length ?? 0} MCP servers: ${(s.mcp ?? []).join(', ') || 'none'}`,
            `Model: ${s.model ?? 'unknown'} — writes ${s.writes ? 'ENABLED' : 'disabled'}`,
            `Browser: ${s.browser ? 'reachable' : 'not reachable right now'}`,
            `Gestures: ${l.mediapipe ? 'tracking runtime present' : 'TRACKING RUNTIME MISSING — press G to retry'}`,
            `Google: ${s.google?.configured ? (s.google.connected ? `connected (${s.google.scopes?.length ?? 0} scopes)` : 'configured but NOT connected') : 'not configured'}`,
          ]
          return lines.join('\n')
        },
      },
    ],
  }
}