/**
 * Notifications MCP — local Windows notifications with a persisted scheduler.
 *
 * "Remind me to take the bread out in ten minutes", "ping me at 3". JARVIS
 * answers from the bridge process, so these survive the browser being closed —
 * the reminder is written to the SQLite database and a bridge-side timer fires
 * it when due, even if the page that asked for it is long gone.
 *
 * Delivery is a native Windows balloon via PowerShell's NotifyIcon: no API key,
 * no account, no push service, nothing leaves the machine. On non-Windows
 * systems notifications degrade to a log line, so the tool never fails the turn.
 *
 * Tools: notify_now, notify_schedule, notify_list, notify_cancel.
 *
 * The scheduler is a module-level interval: pending notifications persist in
 * <repo>/data/jarvis.db and are re-armed at boot, catching up anything that came
 * due while the bridge was down.
 */

import { spawn } from 'node:child_process'
import { db, many, one, nowMs } from './db.mjs'

const MAX_TEXT = 240
const onWindows = process.platform === 'win32'

let armed = false
let timer = null

/** One OS balloon. Fire-and-forget; a failure must never crash or stall a turn. */
function balloon(title, text) {
  if (!onWindows) {
    console.log(`[notify] ${title}: ${text}`)
    return
  }
  const script =
    `Add-Type -AssemblyName System.Windows.Forms;` +
    `Add-Type -AssemblyName System.Drawing;` +
    `$n = New-Object System.Windows.Forms.NotifyIcon;` +
    `$n.Icon = [System.Drawing.SystemIcons]::Information;` +
    `$n.Visible = $true;` +
    `$n.BalloonTipTitle = '${String(title).replace(/'/g, "''")}';` +
    `$n.BalloonTipText = '${String(text).replace(/'/g, "''")}';` +
    `$n.ShowBalloonTip(8000);` +
    `Start-Sleep -Milliseconds 8500;` +
    `$n.Dispose()`
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
    { detached: true, windowsHide: true, stdio: 'ignore' },
  )
  child.on('error', () => {})
  child.unref()
}

function cleanText(text, what) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(`A ${what} needs some text.`)
  }
  const trimmed = text.trim()
  if (trimmed.length > MAX_TEXT) {
    throw new Error(`That ${what} is too long (${trimmed.length} characters; the ceiling is ${MAX_TEXT}).`)
  }
  return trimmed
}

/** When the reminder should fire, from "at" or "in_minutes". */
function dueAt(args) {
  if (Number.isFinite(args?.in_minutes) && args.in_minutes >= 1) {
    return new Date(Date.now() + args.in_minutes * 60_000)
  }
  const at = args?.at
  if (typeof at === 'string' && at.trim()) {
    const parsed = parseDateTime(at.trim())
    if (parsed) return parsed
    throw new Error(`I could not read the time "${at}". Use HH:MM (24-hour, today) or a full date-time.`)
  }
  throw new Error('Tell me when: pass in_minutes, or at as "HH:MM".')
}

/**
 * Accept a 24-hour "HH:MM" (today, or tomorrow if already past) or an
 * ISO 8601 datetime string. Loose on purpose — the model reads times out of
 * "remind me at three" badly, so it should hand numbers here.
 */
function parseDateTime(s) {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (hhmm) {
    const h = Number(hhmm[1])
    const m = Number(hhmm[2])
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    const d = new Date()
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d
  }
  const iso = Date.parse(s)
  return Number.isNaN(iso) ? null : new Date(iso)
}

/** Add a reminder programmatically (used by the fast router). Returns its id. */
export function scheduleNotification({ text, at, inMinutes }) {
  const body = cleanText(text, 'reminder')
  const when = dueAt({ at, in_minutes: inMinutes })
  const id = db
    .prepare(
      'INSERT INTO notifications (title, message, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('J.A.R.V.I.S.', body, when.getTime(), 'pending', nowMs()).lastInsertRowid
  armTimer()
  return String(id)
}

export function cancelNotification(id) {
  const res = db.prepare("DELETE FROM notifications WHERE id = ? AND status = 'pending'").run(Number(id) || 0)
  if (res.changes > 0) armTimer()
  return res.changes > 0
}

export function listNotifications() {
  return many(
    "SELECT id, message, scheduled_at, created_at FROM notifications WHERE status = 'pending' ORDER BY scheduled_at",
  ).map((n) => ({
    id: String(n.id),
    text: n.message,
    at: new Date(n.scheduled_at).toISOString(),
  }))
}

/** Fire anything due; called on the module interval. */
function tick() {
  const now = nowMs()
  const due = many('SELECT id, message FROM notifications WHERE status = ? AND scheduled_at <= ?', 'pending', now)
  if (!due.length) return
  for (const n of due) {
    db.prepare("UPDATE notifications SET status = 'sent' WHERE id = ?").run(n.id)
    balloon(
      'J.A.R.V.I.S.',
      n.message.length > 40 ? `${n.message.slice(0, 40)}…` : n.message,
    )
    console.log(`[notify] fired reminder "${n.message}"`)
  }
}

function armTimer() {
  if (timer) clearTimeout(timer)
  timer = null
  const next = Number(one("SELECT MIN(scheduled_at) AS next FROM notifications WHERE status = 'pending'")?.next)
  if (!Number.isFinite(next)) return
  const delay = Math.max(250, Math.min(60_000, next - nowMs()))
  timer = setTimeout(() => {
    timer = null
    tick()
    armTimer()
  }, delay)
  timer.unref?.()
}

function startScheduler() {
  if (armed) return
  armed = true
  tick()
  armTimer()
}

export function notificationsServer() {
  startScheduler()
  return {
    tools: [
      {
        name: 'notify_now',
        description:
          'Pop a desktop notification immediately. Use for a short "right now" ' +
          'alert — a countdown hitting zero, a file finishing, something the user ' +
          'is not looking at. Faster and less intrusive than speaking over the answer.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The one or two lines to show.' } },
          required: ['text'],
        },
        handler: async (args) => {
          const text = cleanText(args?.text, 'notification')
          const t0 = Date.now()
          balloon('J.A.R.V.I.S.', text)
          console.log(`[notify] popped "${text}" in ${Date.now() - t0} ms`)
          return `Shown on screen: ${text}`
        },
      },
      {
        name: 'notify_schedule',
        description:
          'Remind the user about something at a later time — "remind me in ten ' +
          'minutes", "ping me at 3". The reminder is stored inside the bridge and ' +
          'survives the browser being closed. Always use this for any "remind me" / ' +
          '"call me later" request instead of answering only in chat.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The reminder, e.g. "take the bread out of the oven".' },
            in_minutes: { type: 'number', description: 'Minutes from now (1 or more). Prefer this over "at".' },
            at: { type: 'string', description: 'Optional 24-hour "HH:MM" (today, or tomorrow if past) or an ISO datetime.' },
          },
          required: ['text'],
        },
        handler: async (args) => {
          if (Number.isFinite(args?.in_minutes) && args.in_minutes >= 1) {
            const id = scheduleNotification({ text: args.text, inMinutes: args.in_minutes })
            return `Reminder set for ${args.in_minutes} minute${args.in_minutes === 1 ? '' : 's'} from now.`
          }
          if (typeof args?.at === 'string' && args.at.trim()) {
            const when = parseDateTime(args.at.trim())
            if (!when) {
              throw new Error(`I could not read the time "${args.at}". Use HH:MM (24-hour) or a full date-time.`)
            }
            const id = scheduleNotification({ text: args.text, at: when.toISOString() })
            return `Reminder set for ${when.toLocaleString()}.`
          }
          const id = scheduleNotification({ text: args.text, inMinutes: 5 })
          return 'Reminder set for five minutes from now.'
        },
      },
      {
        name: 'notify_list',
        description:
          'List every pending reminder with its time and id. Use when the user ' +
          'asks what reminders are set.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          startScheduler()
          const items = listNotifications()
          if (!items.length) return 'No reminders are set.'
          return items
            .map((n) => `${new Date(n.at).toLocaleString()} — ${n.text} (${n.id.slice(0, 8)})`)
            .join('\n')
        },
      },
      {
        name: 'notify_cancel',
        description:
          'Cancel a scheduled reminder by its id (from notify_list). Use when the ' +
          'user revokes a reminder.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The reminder id from notify_list.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const id = typeof args?.id === 'string' ? args.id.trim() : ''
          return cancelNotification(id)
            ? 'Reminder cancelled.'
            : 'No reminder with that id was set.'
        },
      },
    ],
  }
}