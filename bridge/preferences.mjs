/**
 * Preferences MCP — a local store for stated preferences.
 *
 * "Remember that I prefer chess over checkers", "from now on use Celsius",
 * "I like my briefings in the evening". These are the user's standing choices,
 * and they should act on every turn, not just the one they were said in. They
 * are stored here, injected into the brain's context, and answerable through
 * the same HUD-tool path as everything else.
 *
 * Backed by the SQLite database (bridge/db.mjs, <repo>/data/jarvis.db) so the
 * whole memory — preferences, projects, history — is one file that can be
 * copied to back up. Reads are prepared-statement fetches; writes are upserts.
 *
 * Deliberately NOT a dumping ground:
 * - Refuses anything that looks like a secret — passwords, keys, PINs, tokens,
 *   credentials. Preferences are for settings, not secrets.
 *
 * Tools: preferences_list (read), preferences_get (read), preferences_set
 * (write), preferences_remove (write).
 */

import { db, many, one, nowMs, insert, plain } from './db.mjs'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LEGACY_FILE = join(HERE, '.oc', 'preferences.json')

/**
 * One-time migration from the old JSON store (bridge/.oc/preferences.json).
 * Runs only when the SQLite store is empty and a legacy file exists, then
 * retires the file so this never runs twice.
 */
;(() => {
  const count = one('SELECT COUNT(*) AS n FROM preferences')?.n ?? 0
  if (count > 0 || !existsSync(LEGACY_FILE)) return
  let legacy = {}
  try {
    legacy = JSON.parse(readFileSync(LEGACY_FILE, 'utf8')) ?? {}
  } catch {
    return
  }
  if (typeof legacy !== 'object' || Array.isArray(legacy)) return
  const at = nowMs()
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO preferences (key, value, category, updated_at) VALUES (?, ?, ?, ?)',
  )
  for (const [key, value] of Object.entries(legacy)) {
    try {
      stmt.run(key, JSON.stringify(value), 'general', at)
    } catch {
      /* a key that broke the clean rules stays out */
    }
  }
  try {
    renameSync(LEGACY_FILE, `${LEGACY_FILE}.imported`)
  } catch {
    /* non-fatal */
  }
  console.log(`[jarvis] imported ${Object.keys(legacy).length} legacy preferences into SQLite`)
})()

/** Keys a user would never give us as a preference name. */
const SECRET_KEY_RE =
  /(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|auth|credential|cookie|ssn|pin\b|access[-_]?key)/i

/** Values that ARE secrets, wherever they were meant to go. */
const SECRET_VALUE_RE = /\b(password|passwd|secret|p-i-n|pin number)\b/i

const MAX_NAME = 120
const MAX_VALUE_JSON = 16 * 1024

function cleanName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) {
    throw new Error(`"${name}" is not a usable preference name`)
  }
  if (SECRET_KEY_RE.test(name)) {
    throw new Error(
      `"${name}" reads like a credential. Preferences hold settings, not secrets; ` +
        `use the plain word for settings.`,
    )
  }
  return name.trim()
}

function assertNotSecret(value) {
  if (typeof value === 'string' && SECRET_VALUE_RE.test(value) && value.length < 512) {
    throw new Error(
      'That looks like a secret. I keep preferences, not passwords, keys or PINs — say it once in a chat and do not ask me to store it.',
    )
  }
  const serialised = JSON.stringify(value)
  if (serialised.length > MAX_VALUE_JSON) {
    throw new Error('That value is too large for a preference.')
  }
}

function checkWriteAllowed() {
  if (process.env.JARVIS_ALLOW_WRITES !== '1') {
    throw new Error('Preference changes need writes enabled (start JARVIS with --writes).')
  }
}

function decode(row) {
  if (!row) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

function upsert(name, value, category = 'general') {
  db.prepare(
    `INSERT INTO preferences (key, value, category, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       category = excluded.category, updated_at = excluded.updated_at`,
  ).run(name, JSON.stringify(value), category, nowMs())
}

function deleteRow(name) {
  db.prepare('DELETE FROM preferences WHERE key = ?').run(name)
}

/** Raw store access for the router and system-context injection. */
export function readAllPrefs() {
  const out = {}
  for (const row of many('SELECT key, value FROM preferences')) {
    const value = decode(row)
    if (value !== undefined) out[row.key] = value
  }
  return out
}

/** One value, for the router and context, or undefined. */
export function readPref(name) {
  return decode(one('SELECT value FROM preferences WHERE key = ?', name))
}

/** Programmatic write for the router (weather location, units…). Same guards. */
export function setPref(name, value, category = 'general') {
  const clean = cleanName(name)
  assertNotSecret(value)
  checkWriteAllowed()
  upsert(clean, value, category)
  return clean
}

/** Is a preference stored at all? */
export function hasPref(name) {
  return Boolean(one('SELECT 1 AS x FROM preferences WHERE key = ?', name))
}

export function preferencesServer() {
  return {
    tools: [
      {
        name: 'preferences_list',
        description:
          'List every stored preference (name and value). Call this before assuming ' +
          'what the user prefers, or when they ask "what do you know about me" or ' +
          '"check my preferences". Fast and local.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const rows = many('SELECT key, value FROM preferences ORDER BY key')
          if (!rows.length) return 'No preferences are stored yet.'
          return rows.map((r) => `${r.key} = ${decode(r) === undefined ? '' : JSON.stringify(decode(r))}`).join('\n')
        },
      },
      {
        name: 'preferences_get',
        description:
          'Read one stored preference by name. Use when the user asks whether a ' +
          'specific preference is set, or before acting on a preference.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The preference name, e.g. "temperature_unit".' },
          },
          required: ['name'],
        },
        handler: async (args) => {
          const name = cleanName(args?.name)
          const value = readPref(name)
          return value === undefined
            ? `No preference named "${name}" is stored.`
            : `${name} = ${JSON.stringify(value)}`
        },
      },
      {
        name: 'preferences_set',
        description:
          'Store or update one preference — the user statement becomes a standing ' +
          'setting that applies to every later turn. Prefer this over remembering ' +
          'things only in the conversation: put the durable fact here. Accepts a ' +
          'string, number, boolean, array or object. Never stores secrets.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'A short snake_case name for the preference, e.g. "temperature_unit" ' +
                'or "briefing_time".',
            },
            value: {
              description:
                'The value to remember: a string ("celsius"), a number (8), a ' +
                'boolean, or a small array/object.',
            },
          },
          required: ['name', 'value'],
        },
        handler: async (args) => {
          checkWriteAllowed()
          const name = cleanName(args?.name)
          if (args?.value === undefined || args?.value === null) {
            throw new Error('A preference needs a value.')
          }
          assertNotSecret(args.value)
          upsert(name, args.value)
          return `Stored: ${name} = ${JSON.stringify(args.value)}`
        },
      },
      {
        name: 'preferences_remove',
        description:
          'Delete a stored preference by name. Use when the user says they no ' +
          'longer want something remembered, or want it changed and then removed.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        handler: async (args) => {
          checkWriteAllowed()
          const name = cleanName(args?.name)
          if (!hasPref(name)) {
            return `No preference named "${name}" was stored, so nothing to remove.`
          }
          deleteRow(name)
          return `Removed the "${name}" preference.`
        },
      },
    ],
  }
}

/** Preference summary for the system context — compact, never the conversation. */
export function preferenceContext() {
  const rows = many("SELECT key, value FROM preferences WHERE key != 'notes' ORDER BY key")
  if (!rows.length) return ''
  return (
    'Known user preferences:\n' +
    rows.map((r) => `- ${r.key}: ${JSON.stringify(decode(r))}`).join('\n')
  )
}

/** Append a "remember that <fact>" note. Returns the note count. */
export function rememberNote(text) {
  assertNotSecret(text)
  checkWriteAllowed()
  const notes = Array.isArray(readPref('notes')) ? readPref('notes') : []
  notes.push({ at: new Date().toISOString(), text: String(text).trim() })
  upsert('notes', notes.slice(-100))
  return notes.length
}

/** Add a "prefer <thing>" statement to the standing preferences. */
export function preferItem(text) {
  assertNotSecret(text)
  checkWriteAllowed()
  const preferred = Array.isArray(readPref('preferred')) ? readPref('preferred') : []
  if (!preferred.includes(text)) {
    preferred.push(text)
    upsert('preferred', preferred)
  }
  return preferred.length
}