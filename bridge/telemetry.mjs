import { db, many } from './db.mjs'
import { LOCAL_TELEMETRY_ENABLED } from './observability-config.mjs'
import { EVENTS, subscribe } from './events.mjs'

const MAX_LABEL = 80
const MAX_DURATION_MS = 86_400_000
let started = false

const label = (value, fallback = 'unknown') => {
  const text = String(value ?? '')
    .replace(/[^a-zA-Z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_LABEL)
  return text || fallback
}

const duration = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(MAX_DURATION_MS, Math.round(number)))
}

const dayKey = (value) => {
  const text = String(value ?? '')
  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? text
    : new Date().toISOString().slice(0, 10)
}

export function telemetryEnabled() {
  return LOCAL_TELEMETRY_ENABLED
}

export function recordMetric({
  day = dayKey(),
  component = 'unknown',
  operation = 'unknown',
  route = '',
  status = 'ok',
  errorCategory = '',
  durationMs = 0,
  count = 1,
} = {}) {
  if (!telemetryEnabled()) return false

  const events = Math.max(1, Math.min(100_000, Math.round(Number(count) || 1)))
  const ms = duration(durationMs)
  const at = Date.now()
  try {
    db.prepare(
      `INSERT INTO telemetry_counters
        (day, component, operation, route, status, error_category,
         events_count, total_ms, min_ms, max_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, component, operation, route, status, error_category)
       DO UPDATE SET
         events_count = telemetry_counters.events_count + excluded.events_count,
         total_ms = telemetry_counters.total_ms + excluded.total_ms,
         min_ms = CASE
           WHEN telemetry_counters.min_ms IS NULL OR excluded.min_ms < telemetry_counters.min_ms
             THEN excluded.min_ms
           ELSE telemetry_counters.min_ms
         END,
         max_ms = CASE
           WHEN telemetry_counters.max_ms IS NULL OR excluded.max_ms > telemetry_counters.max_ms
             THEN excluded.max_ms
           ELSE telemetry_counters.max_ms
         END,
         updated_at = excluded.updated_at`,
    ).run(
      dayKey(day),
      label(component),
      label(operation),
      route ? label(route, '') : '',
      label(status, 'unknown'),
      errorCategory ? label(errorCategory, '') : '',
      events,
      ms * events,
      ms,
      ms,
      at,
    )
    return true
  } catch (err) {
    console.warn('[telemetry] could not record:', err?.message ?? err)
    return false
  }
}

export function recordRequestMetric({ intent, success = true, durationMs = 0 }) {
  const prefix = String(intent ?? '').split(':')[0]
  return recordMetric({
    component: 'request',
    operation: 'command',
    route: label(prefix || 'unknown'),
    status: success ? 'ok' : 'error',
    errorCategory: success ? '' : 'command_failed',
    durationMs,
  })
}

export function recordToolMetric({ name, status = 'ok', durationMs = 0, errorCategory = '' }) {
  return recordMetric({
    component: 'tool',
    operation: label(name),
    status,
    errorCategory,
    durationMs,
  })
}

export function initTelemetry() {
  if (started) return () => {}
  started = true
  const offTurn = subscribe(EVENTS.TURN_END, (data) => {
    recordMetric({
      component: 'turn',
      operation: 'turn',
      route: data.route,
      status: data.status,
      errorCategory: data.errorCategory,
      durationMs: data.durationMs,
    })
  })
  const offStep = subscribe(EVENTS.STEP_END, (data) => {
    recordMetric({
      component: data.component,
      operation: data.operation,
      status: data.status,
      errorCategory: data.errorCategory,
      durationMs: data.durationMs,
    })
  })
  return () => {
    offTurn()
    offStep()
    started = false
  }
}

export function telemetrySnapshot({ day, limit = 100 } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit) || 100))
  if (day) {
    return many(
      `SELECT day, component, operation, route, status, error_category,
              events_count, total_ms, min_ms, max_ms, updated_at
         FROM telemetry_counters
        WHERE day = ?
        ORDER BY component, operation, route, status
        LIMIT ${max}`,
      dayKey(day),
    )
  }
  return many(
    `SELECT day, component, operation, route, status, error_category,
            events_count, total_ms, min_ms, max_ms, updated_at
       FROM telemetry_counters
      ORDER BY day DESC, component, operation, route, status
      LIMIT ${max}`,
  )
}
