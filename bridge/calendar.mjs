/**
 * Calendar MCP — the user's Google Calendar over the free REST API.
 *
 * Same footing as Gmail: OAuth token from bridge/auth.mjs, plain HTTPS fetch
 * against googleapis.com, nothing paid, nothing leaving localhost except what
 * the user asked for. "Not connected" is a message, never a crash.
 *
 * Tools: calendar_status (read), calendar_list (read), calendar_add (write),
 * calendar_remove (destructive — confirmation-gated upstream).
 */

import { googleFetch, googleAuthStatus } from './auth.mjs'

function when(event) {
  return event.start?.dateTime ?? event.start?.date ?? 'no time'
}

/* ---------------------------------------------------------------------------
 * Fast-path helpers for the command router.
 *
 * The MCP tools let the model act on the calendar. These are the same read
 * framed for the router, so "what's on today" answers in milliseconds without
 * booting the brain. Plain strings, ready to be spoken; the auth guard returns
 * a sentence rather than throwing, exactly as the tools do.
 * ------------------------------------------------------------------------- */

/** Today's events, GMT-localised, newest last. */
export async function calendarToday() {
  const h = googleAuthStatus()
  if (!h.configured) {
    return 'Calendar is not set up — no Google client id is configured.'
  }
  if (!h.connected) {
    return 'Your calendar is not connected. Say "connect google" and complete the consent page.'
  }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const q = new URLSearchParams({
    maxResults: '20',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
  })
  const page = await googleFetch(`/calendar/v3/calendars/primary/events?${q}`)
  const events = page.items ?? []
  if (!events.length) return 'Nothing on your calendar today, sir.'
  return events
    .map((e) => `${when(e)} — ${e.summary ?? '(untitled)'}${e.location ? ` at ${e.location}` : ''}`)
    .join('. ')
}

/** Events over the next few days, for "what's next" / "upcoming events". */
export async function calendarUpcoming(days = 7) {
  const h = googleAuthStatus()
  if (!h.configured) {
    return 'Calendar is not set up — no Google client id is configured.'
  }
  if (!h.connected) {
    return 'Your calendar is not connected. Say "connect google" and complete the consent page.'
  }
  const timeMin = new Date().toISOString()
  const timeMax = new Date(Date.now() + days * 86_400_000).toISOString()
  const q = new URLSearchParams({
    maxResults: '8',
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
  })
  const page = await googleFetch(`/calendar/v3/calendars/primary/events?${q}`)
  const events = page.items ?? []
  if (!events.length) return 'The calendar is clear for now, sir.'
  return events
    .map((e) => `${when(e)} — ${e.summary ?? '(untitled)'}${e.location ? ` at ${e.location}` : ''}`)
    .join('. ')
}

/** Make a start time the model can hand us into a usable datetime. */
function resolveStart(start, durationMinutes) {
  const s = String(start ?? '').trim()
  const iso = new Date(s)
  if (!Number.isNaN(iso.getTime())) {
    if (s.length <= 10) {
      // A bare date — treat as a 9am meeting of the given length.
      const d = new Date(iso)
      d.setHours(9, 0, 0, 0)
      return d
    }
    return iso
  }
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (hhmm) {
    const d = new Date()
    d.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0)
    return d
  }
  throw new Error(`I could not read the start time "${start}". Use an ISO datetime like "2026-09-18T15:00:00" (or a date like "2026-09-20").`)
}

export function calendarServer() {
  return {
    tools: [
      {
        name: 'calendar_status',
        description:
          'Whether Calendar is connected. Call first when acting on the calendar ' +
          'if it may not be connected, or after a Calendar call fails.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const h = googleAuthStatus()
          if (!h.configured) {
            return 'Calendar is not set up — no Google client id is configured ' +
              '(set JARVIS_GOOGLE_CLIENT_ID and JARVIS_GOOGLE_CLIENT_SECRET, then "connect google").'
          }
          if (!h.connected) {
            return 'Calendar is not connected. Say "connect google" and complete the consent in the browser.'
          }
          try {
            // Check API availability without reading any event data.
            await googleFetch('/calendar/v3/calendars/primary')
            return 'Calendar is connected and responding.'
          } catch (error) {
            return `Google sign-in is connected, but Calendar is unavailable: ${error?.message ?? error}`
          }
        },
      },
      {
        name: 'calendar_list',
        description:
          'Upcoming events on the user\'s primary calendar. Use for "what is on ' +
          'next", "do I have anything on the twentieth", or any schedule question.',
        inputSchema: {
          type: 'object',
          properties: {
            max: { type: 'number', description: 'How many events (default 6, max 20).' },
            days: { type: 'number', description: 'Only events within this many days (default 14).' },
          },
          required: [],
        },
        handler: async (args) => {
          const max = Math.min(20, Math.max(1, Number(args?.max) || 6))
          const days = Math.min(365, Math.max(1, Number(args?.days) || 14))
          const timeMin = new Date().toISOString()
          const timeMax = new Date(Date.now() + days * 86_400_000).toISOString()
          const q = new URLSearchParams({
            maxResults: String(max),
            timeMin,
            timeMax,
            singleEvents: 'true',
            orderBy: 'startTime',
          })
          const page = await googleFetch(`/calendar/v3/calendars/primary/events?${q}`)
          const events = page.items ?? []
          if (!events.length) return 'The calendar is clear for now.'
          return events
            .map((e) => `- ${when(e)} — ${e.summary ?? '(untitled)'}${e.location ? ` at ${e.location}` : ''}`)
            .join('\n')
        },
      },
      {
        name: 'calendar_add',
        description:
          'Create an event on the user\'s primary calendar. Say what you are ' +
          'about to book before you book it. Repeats and guests are passed ' +
          'through as raw details if supplied.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'The event title, e.g. "Dentist appointment".' },
            start: { type: 'string', description: 'ISO datetime "2026-09-18T15:00:00", or a date "2026-09-20" for a 9am meeting.' },
            duration_minutes: { type: 'number', description: 'Length in minutes (default 60).' },
            notes: { type: 'string', description: 'Notes for the event, if any.' },
          },
          required: ['summary', 'start'],
        },
        handler: async (args) => {
          const summary = String(args?.summary ?? '').trim()
          if (!summary) throw new Error('An event needs a title.')
          const startsAt = resolveStart(args?.start, args?.duration_minutes)
          const minutes = Math.min(1440, Math.max(5, Number(args?.duration_minutes) || 60))
          const endsAt = new Date(startsAt.getTime() + minutes * 60_000)
          const event = {
            summary,
            description: String(args?.notes ?? '').trim() || undefined,
            start: { dateTime: startsAt.toISOString() },
            end: { dateTime: endsAt.toISOString() },
          }
          const created = await googleFetch('/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(event),
          })
          return `Booked "${summary}" for ${startsAt.toLocaleString()} (${minutes} minutes).`
        },
      },
      {
        name: 'calendar_remove',
        description:
          'Delete an event from the primary calendar. DESTRUCTIVE — say what you ' +
          'are deleting and that it is permanent before doing it, and confirm the ' +
          'user wants it gone.',
        inputSchema: {
          type: 'object',
          properties: { event_id: { type: 'string', description: 'The event id from calendar_list (the part after the —).' } },
          required: ['event_id'],
        },
        handler: async (args) => {
          const id = String(args?.event_id ?? '').trim()
          if (!id) throw new Error('An event id is needed (from calendar_list).')
          await googleFetch(`/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          })
          return 'Event removed.'
        },
      },
    ],
  }
}
