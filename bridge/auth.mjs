/**
 * Local OAuth for the free Google APIs (Gmail, Calendar).
 *
 * The user authorises JARVIS in their own browser with their own Google
 * account; the token is exchanged and kept on THIS machine, server-side, and
 * never sent to the page. Nothing is paid for: these are Google's free REST
 * APIs called with a personal OAuth token — no SDK, no billing project
 * required beyond a free Cloud project for the client id.
 *
 * Setup (once, by the user):
 *   Google Cloud Console → create a project → "OAuth consent screen" (External,
 *   or Internal if they have Workspace) → "Credentials" → create an OAuth
 *   client of type "Desktop app" → copy the client id and secret into:
 *     JARVIS_GOOGLE_CLIENT_ID and JARVIS_GOOGLE_CLIENT_SECRET
 *   Google accepts the loopback redirect below for Desktop-app clients; no
 *   redirect URI needs to be registered by hand.
 *
 * Flow: /auth/google opens Google's consent page; the user completes it; the
 * redirect lands on /auth/google/callback here; the code is exchanged for a
 * refresh token, stored in bridge/.oc/auth/google.json, and the access token
 * is refreshed on demand forever after. Nothing leaves localhost.
 *
 * Missing credentials are not an error: every consumer is told "not
 * connected" and carries on, so the rest of JARVIS is unaffected.
 */

import './env.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = join(HERE, '.oc', 'auth')
const TOKEN_FILE = join(AUTH_DIR, 'google.json')

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FETCH_TIMEOUT_MS = 10_000

const CLIENT_ID = process.env.JARVIS_GOOGLE_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.JARVIS_GOOGLE_CLIENT_SECRET ?? ''
const REDIRECT_URI = 'http://127.0.0.1:8787/auth/google/callback'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ')

/** The in-flight consent state, so the callback cannot be forged cross-site. */
let pendingState = null
let tokens = null

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET)
}

function loadTokens() {
  if (tokens) return tokens
  try {
    tokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    tokens = null
  }
  return tokens
}

function saveTokens() {
  if (!tokens) return
  mkdirSync(AUTH_DIR, { recursive: true })
  const tmp = `${TOKEN_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(tokens, null, 2))
  renameSync(tmp, TOKEN_FILE)
}

/** The consent URL the user should open. */
export function googleAuthUrl() {
  if (!configured()) return null
  pendingState = randomUUID()
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: pendingState,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

/** Handle the callback redirect. Returns { ok, error? }. */
export async function handleGoogleCallback(state, code) {
  if (!configured()) return { ok: false, error: 'Google auth is not configured.' }
  if (!pendingState || state !== pendingState) return { ok: false, error: 'Auth state did not match — retry the connect.' }
  pendingState = null
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = await res.json()
    if (!res.ok || !data.refresh_token) {
      return { ok: false, error: `Google rejected the exchange: ${data.error ?? res.status}` }
    }
    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry: Date.now() + (data.expires_in ?? 3600) * 1000,
      scope: data.scope ?? SCOPES,
      at: new Date().toISOString(),
    }
    saveTokens()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Could not finish Google auth: ${String(err?.message ?? err)}` }
  }
}

/** A valid access token, refreshed lazily from the stored refresh token. */
async function accessToken() {
  const stored = loadTokens()
  if (!stored?.refresh_token) return null
  if (stored.access_token && stored.expiry && Date.now() < stored.expiry - 60_000) {
    return stored.access_token
  }
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const data = await res.json()
    if (!res.ok || !data.access_token) {
      tokens = null
      return null
    }
    stored.access_token = data.access_token
    stored.expiry = Date.now() + (data.expires_in ?? 3600) * 1000
    saveTokens()
    return stored.access_token
  } catch {
    return null
  }
}

/** Fetch a Google API path with the live token. Throws on failure. */
export async function googleFetch(path, init = {}) {
  const token = await accessToken()
  if (!token) throw new Error('Gmail and Calendar are not connected. The user must authorise Google first.')
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const j = await res.json()
      detail = j?.error?.message ?? detail
    } catch {
      /* non-JSON error body */
    }
    if (/has not been used in project|is disabled/i.test(detail)) {
      const gmail = path.startsWith('/gmail/')
      const apiName = gmail ? 'Gmail API' : 'Google Calendar API'
      const apiId = gmail ? 'gmail.googleapis.com' : 'calendar-json.googleapis.com'
      const project = /\bproject\s+(\d+)/i.exec(detail)?.[1]
      const query = project ? `?project=${project}` : ''
      throw new Error(
        `${apiName} is disabled for JARVIS's Google Cloud project. Enable it here: ` +
          `https://console.cloud.google.com/apis/library/${apiId}${query}`,
      )
    }
    throw new Error(detail)
  }
  return res.json()
}

/** Human-facing status for tools and /systems. */
export function googleAuthStatus() {
  const stored = loadTokens()
  return {
    configured: configured(),
    connected: Boolean(stored?.refresh_token),
    scopes: stored?.scope ? stored.scope.split(' ') : [],
    connectedAt: stored?.at ?? null,
  }
}

/** Forget the stored token (used by gmail_disconnect-esque flows if needed). */
export function googleLogout() {
  tokens = null
  try {
    renameSync(TOKEN_FILE, `${TOKEN_FILE}.old`)
  } catch {
    try {
      writeFileSync(TOKEN_FILE, '')
    } catch {
      /* nothing to clean */
    }
  }
}
