const listeners = new Map()
const MAX_LISTENERS = 50

export const EVENTS = Object.freeze({
  TURN_START: 'turn.start',
  TURN_END: 'turn.end',
  STEP_START: 'step.start',
  STEP_END: 'step.end',
})

export function subscribe(type, listener) {
  if (typeof listener !== 'function') return () => {}
  const set = listeners.get(type) ?? new Set()
  if (set.size >= MAX_LISTENERS) return () => {}
  set.add(listener)
  listeners.set(type, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(type)
  }
}

export function publish(type, data = {}) {
  const set = listeners.get(type)
  if (!set || set.size === 0) return
  for (const listener of [...set]) {
    try {
      listener(data)
    } catch (err) {
      console.warn('[observability] event listener failed:', err?.message ?? err)
    }
  }
}

export function listenerCount(type) {
  return listeners.get(type)?.size ?? 0
}
