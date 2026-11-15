const truthy = new Set(['1', 'true', 'yes', 'on'])
const falsy = new Set(['0', 'false', 'no', 'off'])

const flag = (name, fallback) => {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = raw.trim().toLowerCase()
  if (truthy.has(value)) return true
  if (falsy.has(value)) return false
  return fallback
}

const retention = Number(process.env.JARVIS_TRACE_RETENTION_DAYS ?? 30)

export const OBSERVABILITY_ENABLED = flag('JARVIS_OBSERVABILITY', false)
export const TRACE_CONTENT_ENABLED = flag('JARVIS_TRACE_CONTENT', false)
export const LOCAL_TELEMETRY_ENABLED = flag('JARVIS_LOCAL_TELEMETRY', true)
export const TRACE_RETENTION_DAYS = Number.isFinite(retention)
  ? Math.min(3650, Math.max(1, Math.floor(retention)))
  : 30

export const observabilityConfig = () => ({
  enabled: OBSERVABILITY_ENABLED,
  traceContent: TRACE_CONTENT_ENABLED,
  localTelemetry: LOCAL_TELEMETRY_ENABLED,
  traceRetentionDays: TRACE_RETENTION_DAYS,
})
