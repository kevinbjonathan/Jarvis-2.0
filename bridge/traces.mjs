import { randomUUID } from 'node:crypto'
import { db, one } from './db.mjs'
import {
  OBSERVABILITY_ENABLED,
  TRACE_RETENTION_DAYS,
} from './observability-config.mjs'
import { EVENTS, publish } from './events.mjs'

const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|content|text|message|prompt|response|email|calendar|file|transcript|audio|video|image|body)/i
const MAX_STRING = 160
const MAX_KEYS = 30
const MAX_ARRAY = 20
const MAX_METADATA_JSON = 2000

const cleanString = (value) => {
  const flattened = value.replace(/\p{Cc}+/gu, ' ').trim()
  if (/^(bearer\s+|sk-|ghp_|xox[baprs]-)/i.test(flattened)) return '[redacted]'
  return flattened.slice(0, MAX_STRING)
}

function redactValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') return cleanString(value)
  if (depth >= 3) return '[truncated]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(key)) continue
      result[key] = redactValue(item, depth + 1)
    }
    return result
  }
  return '[redacted]'
}

export function redactMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return redactValue(input)
}

function metadataJson(input) {
  try {
    const json = JSON.stringify(redactMetadata(input))
    if (json.length <= MAX_METADATA_JSON) return json
    return JSON.stringify({ truncated: true })
  } catch {
    return '{}'
  }
}

export const newTraceId = () => randomUUID()

export function startTrace({
  component = 'turn',
  route = '',
  model = '',
  provider = '',
  metadata = {},
} = {}) {
  const startedAt = Date.now()
  const trace = {
    id: null,
    startedAt,
    stepIndex: 0,
    status: 'running',
    ended: false,
    enabled: false,
    component,
    route,
    model,
    provider,
    startMetadata: redactMetadata(metadata),
  }

  if (!OBSERVABILITY_ENABLED) return trace

  const id = newTraceId()
  try {
    db.prepare(
      `INSERT INTO traces
        (trace_id, started_at, status, component, route, model, provider, metadata)
       VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      startedAt,
      component,
      route,
      model,
      provider,
      metadataJson(trace.startMetadata),
    )
    trace.id = id
    trace.enabled = true
    publish(EVENTS.TURN_START, {
      traceId: id,
      component,
      route,
      startedAt,
    })
  } catch (err) {
    console.warn('[observability] trace start failed:', err?.message ?? err)
  }
  return trace
}

const noopStep = () => {}

export function beginStep(
  trace,
  { component = 'turn', operation = 'step', metadata = {} } = {},
) {
  if (!trace?.enabled || trace.ended) return noopStep

  const stepIndex = trace.stepIndex++
  const startedAt = Date.now()
  try {
    db.prepare(
      `INSERT INTO trace_steps
        (trace_id, step_index, component, operation, started_at, status, metadata)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      trace.id,
      stepIndex,
      component,
      operation,
      startedAt,
      metadataJson(metadata),
    )
  } catch (err) {
    console.warn('[observability] step start failed:', err?.message ?? err)
    return noopStep
  }

  publish(EVENTS.STEP_START, {
    traceId: trace.id,
    stepIndex,
    component,
    operation,
    startedAt,
  })

  let finished = false
  return function finishStep({
    status = 'ok',
    errorCategory = '',
    metadata: endMetadata = {},
  } = {}) {
    if (finished) return
    finished = true
    const endedAt = Date.now()
    const durationMs = Math.max(0, endedAt - startedAt)
    try {
      db.prepare(
        `UPDATE trace_steps
            SET ended_at = ?, duration_ms = ?, status = ?, error_category = ?, metadata = ?
          WHERE trace_id = ? AND step_index = ?`,
      ).run(
        endedAt,
        durationMs,
        status,
        errorCategory,
        metadataJson(endMetadata),
        trace.id,
        stepIndex,
      )
      publish(EVENTS.STEP_END, {
        traceId: trace.id,
        stepIndex,
        component,
        operation,
        durationMs,
        status,
        errorCategory,
      })
    } catch (err) {
      console.warn('[observability] step end failed:', err?.message ?? err)
    }
  }
}

export function endTrace(
  trace,
  {
    status = 'ok',
    route,
    model,
    provider,
    errorCategory = '',
    metadata = {},
  } = {},
) {
  if (!trace?.enabled || trace.ended) return
  trace.ended = true
  trace.status = status

  const endedAt = Date.now()
  const durationMs = Math.max(0, endedAt - trace.startedAt)
  const finalRoute = route ?? trace.route
  const finalModel = model ?? trace.model
  const finalProvider = provider ?? trace.provider
  const mergedMetadata = {
    ...trace.startMetadata,
    ...redactMetadata(metadata),
  }

  try {
    db.prepare(
      `UPDATE trace_steps
          SET ended_at = ?, duration_ms = MAX(0, ? - started_at),
              status = 'cancelled', error_category = 'trace_ended'
        WHERE trace_id = ? AND ended_at IS NULL`,
    ).run(endedAt, endedAt, trace.id)
    db.prepare(
      `UPDATE traces
          SET ended_at = ?, duration_ms = ?, status = ?, route = ?, model = ?,
              provider = ?, error_category = ?, metadata = ?
        WHERE trace_id = ?`,
    ).run(
      endedAt,
      durationMs,
      status,
      finalRoute,
      finalModel,
      finalProvider,
      errorCategory,
      metadataJson(mergedMetadata),
      trace.id,
    )
    publish(EVENTS.TURN_END, {
      traceId: trace.id,
      component: trace.component,
      route: finalRoute,
      model: finalModel,
      provider: finalProvider,
      durationMs,
      status,
      errorCategory,
    })
  } catch (err) {
    console.warn('[observability] trace end failed:', err?.message ?? err)
  }
}

export function setTraceFields(trace, fields = {}) {
  if (!trace) return
  if (fields.route != null) trace.route = fields.route
  if (fields.model != null) trace.model = fields.model
  if (fields.provider != null) trace.provider = fields.provider
}

export function getTrace(traceId) {
  return one('SELECT * FROM traces WHERE trace_id = ?', traceId)
}

export function pruneTraces(days = TRACE_RETENTION_DAYS) {
  if (!OBSERVABILITY_ENABLED) return 0
  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000
  try {
    db.exec('BEGIN')
    db.prepare('DELETE FROM trace_steps WHERE trace_id IN (SELECT trace_id FROM traces WHERE started_at < ?)').run(cutoff)
    const removed = Number(
      db.prepare('DELETE FROM traces WHERE started_at < ?').run(cutoff).changes,
    )
    db.exec('COMMIT')
    return removed
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    console.warn('[observability] trace prune failed:', err?.message ?? err)
    return 0
  }
}
