/**
 * Local environment file loading for the bridge.
 *
 * The bridge has always read credentials from the process environment (the
 * shell that runs `npm run bridge`, or jarvis-secrets.cmd). AI gateway keys
 * are the first ones a user is likely to want in a file instead: an API key is
 * a long random string that should not live in a command prompt's history and
 * should not be committed.
 *
 * So this reads the repository's `.env` — the file `.env.example` documents —
 * into process.env BEFORE anything else is evaluated, with one rule that
 * matters: an already-exported variable is never overwritten. Shell and
 * launcher configuration therefore still win, and a developer who exports a
 * throwaway key does not have it silently replaced by a stale file.
 *
 * Deliberately dependency-free (Node has no built-in dotenv) and deliberately
 * quiet: no values are ever logged, and a malformed line is skipped rather
 * than failing the boot of a server that must stay up.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** KEY=value lines; `#` comments; optional surrounding quotes. */
function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const ENV_FILE = join(import.meta.dirname, '..', '.env')
const SECRETS_FILE = join(import.meta.dirname, '..', 'jarvis-secrets.cmd')

/**
 * The Windows launchers keep private keys in jarvis-secrets.cmd. Parse the
 * `set "KEY=value"` lines instead of executing the file, so starting the
 * bridge directly (`npm run bridge`, not the .cmd launcher) sees the same
 * Google and voice credentials. The file is git-ignored.
 */
function parseSecretsFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/i.exec(rawLine)
    if (!match) continue
    out[match[1]] = match[2]
  }
  return out
}

function applyEnvFile(file, parser, label) {
  if (!existsSync(file)) return 0
  try {
    const parsed = parser(readFileSync(file, 'utf8'))
    let added = 0
    for (const [key, value] of Object.entries(parsed)) {
      if (value === '' || process.env[key] !== undefined) continue
      process.env[key] = value
      added += 1
    }
    return added
  } catch (err) {
    console.warn(`[env] could not read ${label}: ${err?.message ?? err}`)
    return 0
  }
}

/** Idempotent — safe to import from several modules. */
export function loadEnvFile() {
  return applyEnvFile(ENV_FILE, parseEnvFile, '.env') +
    applyEnvFile(SECRETS_FILE, parseSecretsFile, 'jarvis-secrets.cmd')
}

loadEnvFile()
