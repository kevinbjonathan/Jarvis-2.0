#!/usr/bin/env node
// JARVIS preflight - a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the commands that start JARVIS.
// Every check degrades to a single friendly line. The script always exits 0 -
// it is advice, not a gate.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const tick = '  ok  '
const warn = ' note '
const info = '  ->  '

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`)
}

console.log('')
console.log('JARVIS preflight - checking your machine (nothing is changed)')
console.log('------------------------------------------------------------')

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (20+ required).`)
  } else {
    line(warn, `Node.js ${process.versions.node} is below 20. Upgrade before starting the bridge.`)
  }
} catch {
  line(warn, 'Could not read the Node.js version. JARVIS needs Node 20 or newer.')
}

// --- opencode CLI on PATH ------------------------------------------------
let opencodeFound = false
try {
  const res = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    shell: process.platform === 'win32',
  })
  if (res.status === 0) {
    opencodeFound = true
    const version = String(res.stdout ?? '').trim().split(/\r?\n/)[0]
    line(tick, `opencode CLI found${version ? `: ${version}` : ''}.`)
  }
} catch {
  // handled below
}
if (!opencodeFound) {
  line(warn, 'opencode CLI not found on your PATH. It is the default local brain.')
  line(info, 'Install it from https://opencode.ai, then run `opencode auth login`.')
  line(info, 'JARVIS uses the free opencode Zen tier by default - no paid key needed.')
}

// --- local key files -----------------------------------------------------
const secretsPath = join(import.meta.dirname, '..', 'jarvis-secrets.cmd')

function readSecrets() {
  const out = {}
  if (!existsSync(secretsPath)) return out
  try {
    for (const raw of readFileSync(secretsPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/i.exec(raw)
      if (match) out[match[1]] = match[2]
    }
  } catch {
    // advisory only
  }
  return out
}

const secrets = readSecrets()
const hasEnv = (name) => Boolean(process.env[name] && String(process.env[name]).trim())
const hasSecret = (name) => Boolean(secrets[name] && String(secrets[name]).trim())
const hasValue = (name) => hasEnv(name) || hasSecret(name)

if (hasValue('ELEVENLABS_API_KEY')) {
  line(tick, 'ElevenLabs key found - premium voice and Scribe transcription are available.')
} else {
  line(info, 'No ElevenLabs key - JARVIS will use browser speech, which is fine.')
  line(info, 'Optional: add ELEVENLABS_API_KEY to .env or jarvis-secrets.cmd.')
}

if (hasValue('JARVIS_GOOGLE_CLIENT_ID') && hasValue('JARVIS_GOOGLE_CLIENT_SECRET')) {
  line(tick, 'Google OAuth client found - Gmail and Calendar can be connected.')
} else {
  line(info, 'Google OAuth client not configured - Gmail and Calendar stay disconnected.')
  line(info, 'Optional: see docs/installation.md for the Desktop-app OAuth flow.')
}

// --- browser -------------------------------------------------------------
const browserCandidates = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]
const browser = browserCandidates.find((candidate) => candidate && existsSync(candidate))
if (browser) {
  line(tick, `Browser found: ${browser}`)
} else {
  line(warn, 'Chrome or Edge was not found in the usual locations. Use a real browser window for the microphone and browser tools.')
}

// --- how to run ----------------------------------------------------------
console.log('')
console.log('To run JARVIS:')
console.log('  npm start                    # bridge + interface, read-only tools')
console.log('  npm start -- --writes        # also allow sends, clicks, and mutations')
console.log('  npm run start:detached -- --writes   # background, returns when healthy')
console.log('')
console.log('Then open http://localhost:5173 in Chrome or Edge, click INITIALISE,')
console.log('and say "Hey Jarvis". Keep the tab in a real browser window: embedded')
console.log('preview panes block microphone access.')
console.log('')

process.exit(0)
