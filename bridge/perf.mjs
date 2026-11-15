/**
 * Performance ledger — one row per intercepted command.
 *
 * Every command that reaches the bridge is measured on its way through and
 * written twice: command_history (the intent and how it went) and
 * performance_logs (the timing columns the dashboard draws). SQLite WAL keeps
 * the writes cheap enough that they never show up in the numbers they are
 * recording.
 *
 * Privacy: the words themselves are never persisted for new rows. The raw and
 * normalized command columns are written empty, and performance_logs stores
 * only the coarse intent label. Existing historical rows are left untouched.
 *
 * Deliberately small. The interesting story is the split between the fast
 * command router (milliseconds, no brain) and a full model turn (seconds, most
 * of it one opencode boot); everything else worth knowing is carved out of
 * those two columns.
 */

import { db, insert, many, nowMs } from './db.mjs'
import { recordRequestMetric } from './telemetry.mjs'

/**
 * Record one handled command.
 *
 * `command` is read in memory only to derive a coarse topic (currently just
 * 'weather', which keeps the HUD metric alive). No user words are written to
 * the ledger; the intent label and the fixed topic are the only descriptors.
 *
 * @param {object} p
 * @param {string} [p.command] read for coarse topic only; never persisted
 * @param {string} [p.topic]   caller-supplied coarse label, e.g. 'weather'
 * @param {string} p.intent   'router', 'brain', or 'confirm:<tool>'
 * @param {number} p.routingMs router/browser work (the fast path)
 * @param {number} p.aiMs     model turn wall time (the slow path)
 * @param {number} p.mcpMs    accumulated HUD tool time this turn
 * @param {number} p.browserMs accumulated chrome_* tool time this turn
 * @param {number} p.speechMs frontend-measured speech capture latency
 * @param {number} p.ttsMs    frontend-measured spoken-line duration
 * @param {string|null} p.askId browser's id for this turn, for late tts reports
 * @param {boolean} p.success whether the command produced an answer
 */
export function recordPerf({
  command = '',
  topic = '',
  intent = '',
  routingMs = 0,
  aiMs = 0,
  mcpMs = 0,
  browserMs = 0,
  speechMs = 0,
  ttsMs = 0,
  askId = null,
  success = true,
}) {
  const total = Math.max(1, Math.round(routingMs + aiMs + mcpMs + browserMs))
  const at = nowMs()
  const resultText = success ? 'ok' : 'failed'
  const intentLabel = String(intent || 'unclassified').slice(0, 60)
  const coarseTopic = String(topic || '').trim()
  const metricLabel = (
    coarseTopic || (/\bweather\b/i.test(String(command)) ? 'weather' : '') || intentLabel
  ).slice(0, 60)
  try {
    insert(
      `INSERT INTO command_history
         (raw_command, normalized_command, intent, result, success, execution_time_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      '',
      '',
      intentLabel,
      resultText,
      success ? 1 : 0,
      total,
      at,
    )
    insert(
      `INSERT INTO performance_logs
         (command, intent, speech_ms, routing_ms, mcp_ms, browser_ms, ai_ms, tts_ms, total_ms, success, created_at, ask_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      metricLabel,
      intentLabel,
      Math.round(speechMs),
      Math.round(routingMs),
      Math.round(mcpMs),
      Math.round(browserMs),
      Math.round(aiMs),
      Math.round(ttsMs),
      total,
      success ? 1 : 0,
      at,
      askId ? String(askId).slice(0, 80) : null,
    )
    recordRequestMetric({ intent, success, durationMs: total })
  } catch (err) {
    // Measurement must never take a command down with it.
    console.warn('[perf] could not record:', err?.message ?? err)
  }
}

/**
 * The browser reports tts_ms separately, some seconds after the turn: speech
 * ends only after the whole line has played. Keyed by the ask id the frontend
 * sent with the request, so the number lands on the right row and never
 * overwrites a value that was already recorded.
 */
export function recordPerfTts(askId, ttsMs) {
  if (!askId) return
  try {
    db.prepare(
      `UPDATE performance_logs SET tts_ms = ? WHERE ask_id = ? AND tts_ms = 0`,
    ).run(Math.max(0, Math.round(ttsMs)), String(askId).slice(0, 80))
  } catch (err) {
    // Measurement must never take a command down with it.
    console.warn('[perf] could not store tts_ms:', err?.message ?? err)
  }
}

/** Recent rows for /systems and the dashboard, newest first. */
export function recentPerf(limit = 30) {
  return many(
    `SELECT command, intent, speech_ms, routing_ms, mcp_ms, browser_ms, ai_ms, tts_ms, total_ms, success, ask_id, created_at
     FROM performance_logs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  ).map((r) => ({ ...r }))
}