/**
 * The fast command router.
 *
 * Most of what makes a request slow is not the model — it is the price of
 * starting one. A direct command ("open Gmail", "remind me in five minutes")
 * needs neither startup nor reasoning: it is one deterministic action with a
 * known reply. The router catches those before the brain boots and answers in
 * milliseconds.
 *
 * Two levels:
 *   Level 1 — exact commands, answered with the browser alone plus the local
 *             clock (time, date) and state words (stop, sleep, wake).
 *   Level 2 — reminders, memory, preferences, plus Gmail/Calendar reads via
 *             their direct REST helpers, answered without the brain.
 * Anything the router is not sure of falls through to the brain untouched, so
 * a misread can never silently swallow a request.
 *
 * The router only acts on phrases the user has stated as commands. It is a
 * strict matcher, deliberately: the cost of a miss is a normal model turn, the
 * cost of a false hit is acting on something that was not asked.
 */

import { browserNavigate, browserNewTab, browserReachable, browserNextTab, browserPreviousTab, browserSwitchTab, browserCloseActiveTab, browserCloseTab, browserScroll, browserReload } from './chrome.mjs'
import { scheduleNotification } from './notifications.mjs'
import { setPref, preferItem, rememberNote } from './preferences.mjs'
import { saveProject, listProjects } from './memory.mjs'
import { quickWeather } from './weather.mjs'
import { gmailUnread, gmailLatest, gmailSearch } from './gmail.mjs'
import { calendarToday, calendarUpcoming } from './calendar.mjs'

/** Normalise a phrase for matching: lowercase, punctuation dropped, spaces kept. */
const compact = (s) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '') // G-strips so "what's" stays "whats", not "what s"
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Level 1: known sites, spoken or with a tld, spoken name optional. */
const SITES = {
  gmail: 'https://mail.google.com',
  mail: 'https://mail.google.com',
  youtube: 'https://www.youtube.com',
  yt: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  'git hub': 'https://github.com',
  maps: 'https://maps.google.com',
  map: 'https://maps.google.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  instagram: 'https://www.instagram.com',
  ig: 'https://www.instagram.com',
  linkedin: 'https://www.linkedin.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  bing: 'https://www.bing.com',
  amazon: 'https://www.amazon.com',
  drive: 'https://drive.google.com',
  calendar: 'https://calendar.google.com',
  gcal: 'https://calendar.google.com',
}

/**
 * Level 1 — direct browser commands. Matches the WHOLE phrase, so "open gmail"
 * answers instantly but "open gmail and check my mail" goes to the brain.
 */
async function levelOne(phrase) {
  const c = compact(phrase)

  // State words. The app intercepts these on its own, but the raw-wire path
  // must never spend a model turn on them either.
  if (/^(?:please\s+)?(?:stop|stop it|stop that|cancel|cancel that|halt|quiet|silence|shut up)[.!]*$/.test(c)) {
    return 'Stopped, sir.'
  }
  if (/^(?:please\s+)?(?:sleep|go to sleep|standby|stand by|power down)[.!]*$/.test(c)) {
    return 'Standing by, sir.'
  }
  if (/^(?:wake up|wake|resurrect)[.!]*$/.test(c)) {
    return 'Yes, sir?'
  }

  // The local clock, spoken out loud. No browser, no brain.
  const time = /^(?:whats? (?:the |the exact |the current |the time )?time|what (?:time|time is it)|tell me (?:the |the current )?time|the time|current time)$/.exec(c)
  if (time) return spokenClock()
  const date = /^(?:whats? (?:the )?(?:date|day)(?: today)?|what (?:is|s) (?:the )?(?:date|day)(?: today)?|what day is today|what day is it|whats today|what is today|todays date|today date|date today|tell me (?:the |todays |the )?date)$/.exec(c)
  if (date) return spokenDate()

  if (c === 'new tab' || c === 'open a new tab' || c === 'open a tab' || c === 'new page') {
    const err = await browserNewTab()
    return err ? `I could not open a tab: ${err}` : 'New tab opened.'
  }

  // Tab navigation.
  if (c === 'next tab' || c === 'go to the next tab' || c === 'switch to the next tab' || c === 'next' || c === 'forward tab' || c === 'the next tab') {
    const err = await browserNextTab()
    return err ? `Could not switch tabs: ${err}` : 'Next tab.'
  }
  if (c === 'previous tab' || c === 'go to the previous tab' || c === 'switch to the previous tab' || c === 'prev tab' || c === 'last tab' || c === 'back tab' || c === 'the previous tab') {
    const err = await browserPreviousTab()
    return err ? `Could not switch tabs: ${err}` : 'Previous tab.'
  }

  const toTab = /^(?:go to |go to the |switch to |switch to the |show me |open )?(?:tab|tabs?) (?:number )?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.exec(c)
  if (toTab) {
    const n = ordinal(toTab[1])
    if (!n) return 'I could not read that tab number.'
    if (n > 30) return `We only have ${n} — that is more tabs than anyone should have.`
    const err = await browserSwitchTab(n)
    return err ? `Could not switch tabs: ${err}` : `On tab ${n}.`
  }

  if (c === 'back' || c === 'go back' || c === 'go backwards' || c === 'previous page') {
    const err = await browserNavigate({ url: 'back' })
    return err ? `Going back failed: ${err}` : 'Going back.'
  }

  if (c === 'forward' || c === 'go forward' || c === 'forward page' || c === 'go to the next page' || c === 'next page' || c === 'next page please') {
    const err = await browserNavigate({ url: 'forward' })
    return err ? `Going forward failed: ${err}` : 'Going forward.'
  }

  // Closing tabs is destructive, so it lives in the router as a first-class
  // spoken action (this user asked for it directly) — but the model-initiated
  // chrome_close_tab tool stays behind the spoken-confirmation gate upstream.
  const closeThis = /^(?:close|kill) (?:this tab|the tab|the current tab|tab)(?: please| now| sir)?$/.exec(c)
  if (closeThis) {
    const err = await browserCloseActiveTab()
    return err ? `Could not close the tab: ${err}` : 'Tab closed.'
  }
  const closeN = /^close (?:the )?(?:tab|tabs?) (?:number )?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.exec(c)
  if (closeN) {
    const n = ordinal(closeN[1])
    if (!n) return 'I could not read that tab number.'
    if (n > 30) return `We only have ${n} — that is more tabs than anyone should have.`
    const err = await browserCloseTab(n)
    return err ? `Could not close that tab: ${err}` : `Closed tab ${n}.`
  }

  if (c === 'refresh' || c === 'reload' || c === 'refresh the page' || c === 'reload the page') {
    const err = await browserReload()
    return err ? `Refresh failed: ${err}` : 'Refreshing.'
  }

  // Scrolling the page the user is looking at. No brain, no model: one CDP
  // evaluate on the tab that is already open.
  const scroll = /^scroll (up|down|left|right)(?: (?:by |a |the )?(\d+)(?: (?:notches?|steps?|clicks?|lines?))?)?$/.exec(c)
  if (scroll) {
    const dir = scroll[1]
    const amount = scroll[2] ? Number(scroll[2]) : undefined
    const err = await browserScroll(dir, amount)
    return err ? err : `Scrolling ${dir}.`
  }

  // Bringing Chrome itself up. The CDP adapter owns the window, so a fresh tab
  // both proves the browser is running and puts it in front of the user.
  if (
    c === 'open chrome' ||
    c === 'launch chrome' ||
    c === 'open the browser' ||
    c === 'start chrome' ||
    c === 'start the browser'
  ) {
    const err = await browserNewTab()
    return err ? `I could not open Chrome: ${err}` : 'Chrome opened.'
  }

  // Weather fast path — one direct API call, no brain, cached 10 minutes.
  if (
    c === 'whats the weather' ||
    c === 'what is the weather' ||
    c === 'how is the weather' ||
    c === "what's the weather like" ||
    c === 'whats the weather like' ||
    c === 'weather' ||
    c === 'weather today' ||
    c === 'todays weather' ||
    c === 'today weather' ||
    c === 'is it raining' ||
    c === 'will it rain today' ||
    c === 'does it rain today' ||
    c === 'weather forecast' ||
    c === 'forecast'
  ) {
    return weatherReply(false)
  }
  if (
    c === 'refresh the weather' ||
    c === 'refresh weather' ||
    c === 'update the weather' ||
    c === 'get fresh weather'
  ) {
    return weatherReply(true)
  }

  // "what's the weather in <place>" — fast path too.
  const place = /^(?:whats the weather like|what is the weather like|what is the weather|whats the weather|hows the weather|how is the weather|is it raining|will it rain|does it rain)(?: today| now)? in (.+)$/.exec(c)
  if (place && place[1]) {
    return weatherReply(false, place[1])
  }

  const open = /^open (.+)$/.exec(c) ?? /^go (?:to|too) (.+)$/.exec(c) ?? /^(?:take me )?to (.+)$/.exec(c)
  if (open) {
    const target = compact(open[1])
    const bare = target.replace(/\.(com|org|net|io|dev|co|uk|ai|app|me)\b$/, '').trim()
    const url = SITES[bare] ??
      SITES[target.replace(/^www\./, '')] ??
      (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(target) ? `https://${target}` : null)
    if (!url) return null // "open the window" is not a command; leave it to the brain
    const err = await browserNavigate({ url })
    return err ? `I could not open ${target}: ${err}` : `Opening ${SITES[bare] ? shortName(bare) : target}.`
  }

  return null
}

function shortName(bare) {
  const map = { gmail: 'Gmail', mail: 'Gmail', youtube: 'YouTube', 'git hub': 'GitHub', maps: 'Maps', twitter: 'X', instagram: 'Instagram', reddit: 'Reddit', wikipedia: 'Wikipedia', drive: 'Drive', calendar: 'Calendar' }
  return map[bare] ?? bare
}

/** Fetch a forecast directly for the fast path; never throws permissively. */
async function weatherReply(refresh, place) {
  try {
    return await quickWeather({ refresh, location: place })
  } catch (err) {
    return `I could not fetch the weather${place ? ` for ${place}` : ''}: ${String(err?.message ?? err)}`
  }
}

/** Level 2 — reminders, memory, preferences, and Gmail/Calendar reads. */
async function levelTwo(phrase) {
  const c = compact(phrase)
  const raw = phrase.trim()

  const remindTo = /^remind (?:me )?to (.+?) in (\d+(?:\.\d+)?) (minutes?|mins?|hours?|hrs?|hr)$/.exec(c)
  if (remindTo) {
    return setReminder(raw, c, remindTo[1], Number(remindTo[2]) * (remindTo[3][0] === 'h' ? 60 : 1))
  }
  const remindAbout = /^remind (?:me )?about (.+?) in (\d+(?:\.\d+)?) (minutes?|mins?|hours?|hrs?|hr)$/.exec(c)
  if (remindAbout) {
    return setReminder(raw, c, remindAbout[1], Number(remindAbout[2]) * (remindAbout[3][0] === 'h' ? 60 : 1))
  }
  const remindToAt = /^remind (?:me )?to (.+?) at (\d{1,2}(?:[:.]\d{2})?)( am| pm)?$/.exec(c)
  if (remindToAt) {
    const at = clock(remindToAt[2], remindToAt[3])
    if (at === null) return `I could not read the time in "${raw}".`
    try {
      scheduleNotification({ text: remindToAt[1], at: at.toISOString() })
      return `Reminder set for ${at.toLocaleString()}.`
    } catch (err) {
      return `Could not set that reminder: ${err.message}`
    }
  }
  const callMe = /^call me (?:back )?at (\d{1,2}(?:[:.]\d{2})?)( am| pm)? (?:to|about) (.+)$/.exec(c)
  if (callMe) {
    const at = clock(callMe[1], callMe[2])
    if (at === null) return `I could not read the time in "${raw}".`
    try {
      scheduleNotification({ text: callMe[3], at: at.toISOString() })
      return `Calling you at ${at.toLocaleString()}.`
    } catch (err) {
      return `Could not set that reminder: ${err.message}`
    }
  }

  // "What am I working on" — project memory read, instant, no brain.
  if (
    c === 'what am i working on' ||
    c === 'what am i working on now' ||
    c === 'what projects do i have' ||
    c === 'what projects are there' ||
    c === 'do you remember my projects' ||
    c === 'do you remember any projects' ||
    c === 'do you remember any of my projects' ||
    c === 'list my projects' ||
    c === 'my projects' ||
    c === 'show my projects'
  ) {
    try {
      return listProjects()
    } catch (err) {
      return `I could not read my projects: ${err.message}`
    }
  }

  // "My main project is Jarvis" — project memory, more structured than a note.
  const project = /^(?:my (?:main |top |biggest )?project is|remember that my (?:main |top |biggest )?project is|i(?:'?m| am) working on a (?:project|thing) (?:called )|i made a project (?:called )|i(?:'?m| am) building (?:a project (?:called )|the project ))(.+)$/.exec(c)
  if (project && project[1]) {
    try {
      const out = saveProject(project[1])
      return out ?? 'What project is it?'
    } catch (err) {
      return err.message
    }
  }

  const remember = /^(?:remember|note that|note) (?:that )?(.+)$/.exec(c)
  if (remember && remember[1]) {
    try {
      const n = rememberNote(remember[1])
      return n > 0
        ? `Remembered. You now have ${n} note${n === 1 ? '' : 's'} stored.`
        : 'Remembered.'
    } catch (err) {
      return err.message
    }
  }

  const prefer = /^(?:from now on |going forward |in future |always |please )?prefer (?:to use |using |to )?(.+)$/.exec(c)
  if (prefer && prefer[1]) {
    const item = prefer[1]
    try {
      preferItem(item)
      return `Noted — preferring ${item} from now on.`
    } catch (err) {
      return err.message
    }
  }

  // "set my weather location to Bengaluru" / "my city is Bengaluru" — the
  // default place used by bare "what's the weather?".
  const setLocation =
    /^(?:set (?:my |the )?weather location|set (?:my |the )?location|set my city|my weather location is|my location is|my city is|use) (?:to )?(.+)$/.exec(c)
  if (setLocation && setLocation[1]) {
    const city = setLocation[1].trim()
    try {
      setPref('weather_location', city)
      return `Got it — weather for ${city} from now on.`
    } catch (err) {
      return err.message
    }
  }

  // "set weather to fahrenheit" / "use celsius" / "celsius please".
  const setUnits = /^(?:set |use )?(?:the )?(?:weather (?:to )?|temperature in |unit to |units to )?(celsius|fahrenheit)(?: now| from now on| please)?$/.exec(c)
  if (setUnits && setUnits[1]) {
    try {
      setPref('temperature_unit', setUnits[1] === 'fahrenheit' ? 'fahrenheit' : 'celsius')
      return `Weather will be in ${setUnits[1] === 'fahrenheit' ? 'Fahrenheit' : 'Celsius'} from now on.`
    } catch (err) {
      return err.message
    }
  }

  // Gmail reads — one REST call, instantly spoken. "Not connected" (or "not
  // set up") is a fast honest sentence; the model never boots for a read.
  const MAIL_ASK = new Set([
    'do i have any mail',
    'do i have any emails',
    'do i have any email',
    'do i have any new mail',
    'do i have any new emails',
    'do i have any new email',
    'do i have any unread mail',
    'do i have any unread emails',
    'have i got any mail',
    'have i got any emails',
    'have i got any new mail',
    'any mail',
    'any emails',
    'any email',
    'any new mail',
    'any new emails',
    'any new email',
    'any unread mail',
    'any unread emails',
    'unread mail',
    'unread emails',
    'check my mail',
    'check my email',
    'check my emails',
    'check mail',
    'check gmail',
    'check my gmail',
    'new mail',
    'new emails',
    'new email',
    'any mail for me',
    'any emails for me',
  ])
  if (MAIL_ASK.has(c)) {
    try {
      return await gmailUnread()
    } catch (err) {
      return `I could not check your mail: ${String(err?.message ?? err)}`
    }
  }

  const readLatest = /^(?:read|open|show|hear|what is|whats) (?:my )?(?:latest|newest|most recent) (?:email|e-mail|mail)(?: please| now| sir)?$/.exec(c)
  if (readLatest) {
    try {
      return await gmailLatest()
    } catch (err) {
      return `I could not read your latest email: ${String(err?.message ?? err)}`
    }
  }

  const searchFrom = /^emails? (?:from|about) (.+)$/.exec(c)
  if (searchFrom && searchFrom[1]) {
    try {
      return await gmailSearch(`from:${searchFrom[1]}`)
    } catch (err) {
      return `I could not search your mail: ${String(err?.message ?? err)}`
    }
  }
  const mailSearch = /^(?:search|find|look for) (?:my )?(?:emails?|mail|gmail|messages?) (?:for|by|about|matching) (.+)$/.exec(c)
  if (mailSearch && mailSearch[1]) {
    try {
      return await gmailSearch(mailSearch[1])
    } catch (err) {
      return `I could not search your mail: ${String(err?.message ?? err)}`
    }
  }

  // Calendar reads — same direct-REST arrangement as Gmail above.
  const CAL_TODAY = new Set([
    'whats on my calendar today',
    'what is on my calendar today',
    'whats on my calendar for today',
    'anything on my calendar today',
    'do i have anything today',
    'do i have anything on today',
    'do i have anything on my calendar today',
    'do i have any meetings today',
    'do i have any meetings on today',
    'any meetings today',
    'any events today',
    'whats my schedule today',
    'what do i have today',
    'what is on my schedule today',
    'whats on my schedule today',
    'whats on today',
    'what is on today',
    'calendar today',
    'todays calendar',
    'whats happening today',
  ])
  if (CAL_TODAY.has(c)) {
    try {
      return await calendarToday()
    } catch (err) {
      return `I could not read your calendar: ${String(err?.message ?? err)}`
    }
  }

  const CAL_UPCOMING = new Set([
    'whats on my calendar',
    'what is on my calendar',
    'whats on my schedule',
    'what is on my schedule',
    'whats next on my calendar',
    'what is next on my calendar',
    'what is my next meeting',
    'when is my next meeting',
    'whats my next meeting',
    'next meeting',
    'upcoming events',
    'whats coming up on my calendar',
    'do i have anything coming up',
    'any meetings soon',
    'whats on later today',
    'whats on my calendar this week',
    'whats happening soon',
  ])
  if (CAL_UPCOMING.has(c)) {
    try {
      return await calendarUpcoming()
    } catch (err) {
      return `I could not read your calendar: ${String(err?.message ?? err)}`
    }
  }

  return null
}

/** Ordinal word -> number; digits pass through. Returns null when unreadable. */
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 }
function ordinal(word) {
  const w = String(word ?? '').trim().toLowerCase()
  if (/^\d+$/.test(w)) return Number(w)
  return ORDINALS[w] ?? null
}

/* --- spoken numbers, because "It is 14:37" does not scan --- */

const NUM_WORDS = {
  0: '',
  1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
  6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
  11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
  16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty',
  30: 'thirty', 40: 'forty', 50: 'fifty',
}
const ORDINAL_WORDS = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth',
  6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth',
  11: 'eleventh', 12: 'twelfth', 13: 'thirteenth', 14: 'fourteenth', 15: 'fifteenth',
  16: 'sixteenth', 17: 'seventeenth', 18: 'eighteenth', 19: 'nineteenth', 20: 'twentieth',
  21: 'twenty-first', 22: 'twenty-second', 23: 'twenty-third', 24: 'twenty-fourth',
  25: 'twenty-fifth', 26: 'twenty-sixth', 27: 'twenty-seventh', 28: 'twenty-eighth',
  29: 'twenty-ninth', 30: 'thirtieth', 31: 'thirty-first',
}
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_WORDS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function word(n) {
  if (NUM_WORDS[n] !== undefined && n <= 20) return NUM_WORDS[n]
  const tens = Math.floor(n / 10) * 10
  const ones = n % 10
  const t = NUM_WORDS[tens] ?? ''
  const o = NUM_WORDS[ones] ?? ''
  return `${t}${t && o ? ' ' : ''}${o}`.trim()
}

/** "It is eight fifteen a.m." — the half already carries its period. */
function spokenClock(now = new Date()) {
  let h = now.getHours()
  const half = h < 12 ? 'a.m.' : 'p.m.'
  let hh = h % 12
  if (hh === 0) hh = 12
  const m = now.getMinutes()
  if (m === 0) return `It is ${word(hh)} ${half}`
  return `It is ${word(hh)} ${word(m)} ${half}`
}

/** "Today is Friday, the twenty-first of March." */
function spokenDate(now = new Date()) {
  const ord = ORDINAL_WORDS[now.getDate()] ?? String(now.getDate())
  return `Today is ${DAY_WORDS[now.getDay()]}, the ${ord} of ${MONTH_WORDS[now.getMonth()]}.`
}

/** Build a Date for "3:30" with optional "am/pm"; 24-hour when no suffix. */
function clock(part, suffix) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(part)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? '0')
  const half = suffix?.trim()
  if (half === 'pm' && h < 12) h += 12
  if (half === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  const d = new Date()
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= Date.now() + 30_000) d.setDate(d.getDate() + 1)
  return d
}

function setReminder(raw, c, task, minutes) {
  try {
    scheduleNotification({ text: task, inMinutes: Math.max(1, minutes) })
  } catch (err) {
    return `Could not set that reminder: ${err.message}`
  }
  return `Reminder set for ${minutes} minute${minutes === 1 ? '' : 's'} from now.`
}

/**
 * Try the router. Returns { reply } when handled, or null to fall through.
 * Never throws: every failure is a reply the user can act on.
 */
export async function routeRequest(text) {
  if (typeof text !== 'string') return null
  const phrase = text.trim()
  if (!phrase) return null

  let reply = null
  try {
    reply = (await levelOne(phrase)) ?? (await levelTwo(phrase))
  } catch (err) {
    return { reply: `I could not do that: ${String(err?.message ?? err)}` }
  }
  if (reply === null) return null

  // Present-tense verbs should only claim success for actions that actually
  // ran. The navigation calls above already did the work; this is just a guard
  // so the browser being gone shows up as a real message.
  if (/^(Opening|New tab|Going back|Refreshing|Scrolling|Chrome)/.test(reply) && !(await browserReachable())) {
    return { reply: 'The browser is not reachable right now.' }
  }
  return { reply }
}