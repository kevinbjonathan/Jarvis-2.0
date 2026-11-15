import { rememberNote, preferItem, preferenceContext, readAllPrefs, preferencesServer } from '../bridge/preferences.mjs'
import { scheduleNotification, listNotifications, cancelNotification } from '../bridge/notifications.mjs'
import { routeRequest } from '../bridge/router.mjs'

let pass = 0
let fail = 0
const check = (name, cond, detail) => {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail ?? ''}`)
  }
}

rememberNote('stretch in the morning')
preferItem('celsius')
preferItem('evening briefings')
const all = readAllPrefs()

check('notes stored', Array.isArray(all.notes) && all.notes.length === 1, JSON.stringify(all))
check('preferred stored', Array.isArray(all.preferred) && all.preferred.includes('celsius'), JSON.stringify(all.preferred))
check('context shows celsius', preferenceContext().includes('celsius'), preferenceContext())
check('context skips notes', !preferenceContext().includes('stretch'), preferenceContext())

let secretRefused = false
try {
  rememberNote('my wifi password is banana')
} catch {
  secretRefused = true
}
check('secrets refused', secretRefused)

const things = preferencesServer().tools.map((t) => t.name)
check('4 preferences tools', things.length === 4 && things.every((n) => n.startsWith('preferences_')), things.join(','))

const id = scheduleNotification({ text: 'take the bread out', inMinutes: 5 })
check('notification scheduled', listNotifications().length === 1 && listNotifications()[0].id === id)
check('notification cancelled', cancelNotification(id) && listNotifications().length === 0)

const r1 = await routeRequest('remind me to stretch in 1 minutes')
check('router: remind in minutes', r1?.reply.includes('Reminder set'), r1?.reply)
const r2 = await routeRequest('remember that I prefer chess')
check('router: remember', r2?.reply.includes('Remembered'), r2?.reply)
const r3 = await routeRequest('prefer metric units')
check('router: prefer', r3?.reply.includes('Noted'), r3?.reply)
const r4 = await routeRequest('hello there')
check('router: falls through (null)', r4 === null, String(r4))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)