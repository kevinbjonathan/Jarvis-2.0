/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 *
 * Pass --detach (with or without --writes) to start the same two processes in
 * the background, detached, and have this command RETURN once both are up and
 * answering, so an automated runner never blocks on a long-running server:
 * `npm start -- --detach --writes`. Healthy services already running are
 * reused, never restarted. Logs go to %TEMP%/jarvis-logs/{bridge,face}.log.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')
const detach = process.argv.includes('--detach')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitFor(probe, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return true
    await sleep(Math.min(2000, Math.max(250, deadline - Date.now())))
  }
  return false
}

/**
 * Detached mode: start the bridge and the face in the background, confirm both
 * answer, then return. This is the mode for an automated runner — the long-lived
 * processes outlive the launcher and never block the command itself.
 */
async function startDetached({ port, writes }) {
  const logsDir = join(tmpdir(), 'jarvis-logs')
  mkdirSync(logsDir, { recursive: true })
  const bridgePort = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
  const facePort = Number(port ?? 5173)

  // Reuse what is already healthy; start only what is missing.
  const bridgeAlready = await httpOk(`http://127.0.0.1:${bridgePort}/health`)
  const faceAlready = await httpOk(`http://localhost:${facePort}/`)

  // A log file opened at spawn time: a lazy WriteStream has no fd until it has
  // written, and spawn needs a real descriptor to hand the child.
  let bridgeFd = null
  let faceFd = null

  if (bridgeAlready && faceAlready) {
    console.log(
      `\nJ.A.R.V.I.S. is already running (bridge on 127.0.0.1:${bridgePort}, face on :${facePort}).\n`,
    )
    return
  }

  console.log('\nJ.A.R.V.I.S. starting — detached, so this command returns once it is up.\n')

  if (!bridgeAlready) {
    const env = { ...process.env, JARVIS_ALLOW_WRITES: writes ? '1' : '0' }
    if (port) {
      env.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
    }
    bridgeFd = openSync(join(logsDir, 'bridge.log'), 'a')
    const child = spawn(process.execPath, ['bridge/server.mjs'], {
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', bridgeFd, bridgeFd],
    })
    child.on('error', (err) =>
      console.error(`  could not start the bridge: ${err.message}`),
    )
    child.unref()
    closeSync(bridgeFd)
    console.log(`  bridge   starting on ${bridgePort} → logs: ${join(logsDir, 'bridge.log')}`)
  } else {
    console.log(`  bridge   already running on 127.0.0.1:${bridgePort}`)
  }

  if (!faceAlready) {
    faceFd = openSync(join(logsDir, 'face.log'), 'a')
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', faceFd, faceFd],
    })
    child.on('error', (err) => console.error(`  could not start the face: ${err.message}`))
    child.unref()
    closeSync(faceFd)
    console.log(`  face     starting Vite on :${facePort} → logs: ${join(logsDir, 'face.log')}`)
  } else {
    console.log(`  face     already running on :${facePort}`)
  }

  const bridgeUp = await waitFor(() => httpOk(`http://127.0.0.1:${bridgePort}/health`), 45_000)
  const faceUp = await waitFor(() => httpOk(`http://localhost:${facePort}/`), 60_000)

  if (!bridgeUp) {
    console.error(
      `\x1b[31m  the bridge did not answer ${bridgePort} within 45s. See ${join(logsDir, 'bridge.log')}\x1b[0m`,
    )
    process.exit(1)
  }
  if (!faceUp) {
    console.error(
      `\x1b[31m  the face did not answer :${facePort} within 60s. See ${join(logsDir, 'face.log')}\x1b[0m`,
    )
    process.exit(1)
  }

  console.log('\x1b[32m  everything is up.\x1b[0m')
  console.log(
    `  open http://localhost:${facePort} in Chrome, click INITIALISE, say "Hey Jarvis".`,
  )
  console.log(
    '  to stop later: stop-jarvis.vbs, or taskkill /IM node.exe for the ones JARVIS started.',
  )
}

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
if (port) {
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

// Hand-tracking runtime first, in every mode: detached mode never called
// vendorWasm(), so gesture control silently died the moment the app was
// started with --detach. It is idempotent, so the always-running reuse path
// pays nothing once the files exist.
vendorWasm()

if (detach) {
  await startDetached({ port, writes })
} else {
  const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
  if (port) {
    bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  }

  console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
  run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
  // npm is a shell script on most systems; call the vite binary directly so we do
  // not need shell:true (which would break the argument handling above).
  run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

  console.log(
    '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
      'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
  )
}
