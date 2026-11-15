/**
 * Local stand-in for the parts of `@anthropic-ai/claude-agent-sdk` that the
 * HUD server modules used. The SDK built MCP server descriptors with
 * `createSdkMcpServer` and `tool`; this builds the same plain objects without
 * the SDK, so the four modules (`panels`, `ui`, `chrome`, `vision`) load and
 * work under the opencode backend with their bodies untouched.
 */

import { z } from 'zod'

export function createSdkMcpServer({ name, version, instructions, tools }) {
  return { name, version, instructions, tools }
}

/**
 * `tool(name, description, inputSchema, handler)` — same positionals as the
 * SDK's helper. `inputSchema` is a Zod schema or a raw shape of Zod schemas.
 * The JSON form is what opencode's tool files advertise; the Zod form is
 * retained so the bridge can coerce callers' arguments before a handler runs.
 */
export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema: toJsonSchema(inputSchema), schema: inputSchema, handler }
}

/** Coerce an object of raw caller arguments through the tool's schema. */
export function parseArgs(t, args) {
  if (!t || !t.schema) return args ?? {}
  try {
    const shape = t.schema instanceof z.ZodType ? t.schema : buildShape(t.schema)
    const res = shape.safeParse(args ?? {})
    if (res.success) return res.data
  } catch {
    // fall through to the raw arguments
  }
  return args ?? {}
}

/** Rebuild a nested raw shape of Zod values into one object schema. */
function buildShape(input) {
  if (input instanceof z.ZodType) return input
  if (Array.isArray(input)) return z.array(buildShape(input[0] ?? z.any()))
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return z.object(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, buildShape(v)])))
  }
  return z.any()
}

function toJsonSchema(input) {
  try {
    if (input === undefined || input === null) return { type: 'object', properties: {} }
    if (input instanceof z.ZodType) return z.toJSONSchema(input)
    if (input && typeof input === 'object') return z.toJSONSchema(buildShape(input))
  } catch {
    // A schema the converter cannot handle becomes an empty box rather than
    // a crash — the tool still lists, and callers' arguments pass untranslated.
  }
  return { type: 'object', properties: {} }
}