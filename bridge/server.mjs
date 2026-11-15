/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { runTurn } from './runner.mjs'
import { writeHudTools, hudServerNames, HUD_RUNTIME_DIR } from './hudtools.mjs'
import { parseArgs } from './sdk.mjs'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { startChromeAdapter } from './chrome-cdp.mjs'
import { chromeTabSnapshot } from './chrome-cdp.mjs'
import { visionServer } from './vision.mjs'
import { weatherServer } from './weather.mjs'
import {
  describeOmniRouteCanary,
  runOmniRouteCanary,
  safeCanaryReport,
} from './omniroute-canary.mjs'
import { preferencesServer, preferenceContext, readPref, setPref } from './preferences.mjs'
import { notificationsServer } from './notifications.mjs'
import { gmailServer, gmailUnread } from './gmail.mjs'
import { calendarServer, calendarToday } from './calendar.mjs'
import { googleAuthUrl, handleGoogleCallback, googleAuthStatus } from './auth.mjs'
import { systemsServer } from './systems.mjs'
import { memoryServer } from './memory.mjs'
import { recordPerf, recentPerf, recordPerfTts } from './perf.mjs'
import { routeRequest } from './router.mjs'
import {
  beginStep,
  endTrace,
  pruneTraces,
  setTraceFields,
  startTrace,
} from './traces.mjs'
import { initTelemetry, recordToolMetric } from './telemetry.mjs'
import {
  aiBanner,
  aiConfig,
  aiStatus,
  aiTurn,
  classify,
  cloudAvailable,
  noteLocalTurn,
  noteRouting,
} from './ai.mjs'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

// Beyond rejections, a thrown exception anywhere in this process used to be a
// death sentence: one throw in a socket handler, a weather fetch, or the CDP
// adapter took the whole assistant down mid-sentence. The bridge is a server —
// it must outlive any single failure. Log it, keep the process alive, and let
// the affected turn surface its own error to the browser. Only Error objects
// are recoverable; a thrown string or a genuine bug in node internals still
// terminates, because pretending otherwise would just corrupt the next turn.
process.on('uncaughtException', (err) => {
  console.error('[jarvis] uncaught exception (keeping the bridge alive):', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * Whether the free CDP browser adapter is up. Reached for by /health so the
 * frontend can tell a bridge without a browser from a problem; a bridge that
 * starts with Chrome closed is still a healthy bridge, just with browser tools
 * unavailable until the adapter brings it up on demand.
 */
let CHROME_READY = false

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'opencode/big-pickle'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * Measured on this machine's free model, 'low' answered in about 11 s while
 * 'medium' and 'high' took 30-55 s. Spoken latency wins by default; raise
 * JARVIS_EFFORT to medium/high only when a longer think is acceptable.
 */
const EFFORT_RAW = String(process.env.JARVIS_EFFORT ?? 'low').trim()
const EFFORT = /^[a-z0-9_-]{1,24}$/i.test(EFFORT_RAW) ? EFFORT_RAW.toLowerCase() : 'low'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
  'read', 'glob', 'grep', 'webfetch', 'websearch',
  'task', 'todowrite', 'skill', 'agent',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
  'bash', 'write', 'edit', 'patch',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/**
 * Live browser connections, keyed by the token opencode turns present on the
 * /rpc/hud call. The generated HUD tools run inside opencode's process, so
 * they reach the real handlers (which close over THIS socket) through here.
 */
const CONNECTIONS = new Map()

/** Flatten a tool handler's result into the text the model gets back. */
function resultBlock(value) {
  // A handler that returns text directly (e.g. the weather lookup) must pass
  // its words straight through — the old code only knew object shapes, so a
  // string came back as the placeholder below and every string-returning tool
  // told the model "done." no matter what it had actually found.
  if (typeof value === 'string') return value
  if (value?.content && Array.isArray(value.content)) {
    const parts = value.content
      .map((b) => (b?.type === 'text' ? b.text : null))
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
    return value.content[0]?.text ?? 'done.'
  }
  return value?.text ?? 'done.'
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function handleHudRpc(req, res, cors) {
  try {
    const body = await readJson(req)
    const entry = body?.token ? CONNECTIONS.get(body.token) : null
    console.log(`[rpc] ${body?.tool ?? '?'} token=${body?.token ? `${body.token.slice(0, 6)}…${body.token.slice(-4)}` : '(none)'} conns=${CONNECTIONS.size} hits=${entry ? 'yes' : 'no'} args=${JSON.stringify(body?.arguments).slice(0, 120)}`)
    if (!entry) {
      res.writeHead(404, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'No active session for this token.' }))
    }
    const name = String(body?.tool ?? '')
    const tool = Object.values(entry.servers)
      .flatMap((s) => s.tools)
      .find((t) => t.name === name)
    if (!tool?.handler) {
      res.writeHead(404, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Unknown tool: ' + name }))
    }
    // Destructive backstop: hold the call behind a spoken confirmation. The
    // model is already told to announce-and-wait; this is what happens when a
    // deletion call slips through anyway. The next user message decides, and
    // the pending intent lives on the connection entry so the ask handler and
    // this RPC share it.
    if (DESTRUCTIVE_TOOLS.has(mcpToolOf(name))) {
      entry.confirm = { name: mcpToolOf(name), args: body?.arguments ?? {} }
      res.writeHead(200, { ...cors, 'content-type': 'text/plain' })
      return res.end(
        resultBlock(
          `⚠ Warning — this permanently deletes or changes something and I will not do it on my own. ` +
            `Answer "yes, go ahead" to run ${mcpToolOf(name)}, or "no" to cancel. ` +
            `I will wait for your word.`,
        ),
      )
    }
    const out = await tool.handler(parseArgs(tool, body?.arguments))
    res.writeHead(200, { ...cors, 'content-type': 'text/plain' })
    console.log(`[rpc] ${name} -> ok (${String(out).slice(0, 60).replace(/\n/g, ' ')})`)
    return res.end(resultBlock(out))
  } catch (err) {
    console.log(`[rpc] failed: ${err?.message ?? err}`)
    res.writeHead(500, { ...cors, 'content-type': 'text/plain' })
    return res.end(String(err?.message ?? err))
  }
}

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    // Preferences. Reading them is free — the whole point is acting on them.
    // Changing them is a write, like any other persistent edit.
    if (server === 'jarvis_prefs') {
      return tool === 'preferences_list' || tool === 'preferences_get'
        ? true
        : ALLOW_WRITES
    }

    // Notifications. Local, on-screen, non-destructive, and asked for explicitly
    // — a reminder must not silently die because writes are off.
    if (server === 'jarvis_notify') return true

    // Gmail and Calendar run on the user's own account, so they answer reads
    // freely and hold every change behind ALLOW_WRITES. Unlike the browser or
    // the shell they have no separate read-only mode — reads are REST GETs.
    // `send` and `add` would otherwise slip past, because the veto above only
    // reads verbs and "add" is not one of them.
    if (server === 'jarvis_gmail' || server === 'jarvis_calendar') {
      const readTools = new Set([
        'gmail_status', 'gmail_list', 'gmail_search', 'gmail_read', 'gmail_connect',
        'calendar_status', 'calendar_list',
      ])
      return readTools.has(tool) ? true : ALLOW_WRITES
    }

    // The systems overview is a status read like any other.
    if (server === 'jarvis_systems') return true

    // Memory. Reading remembered facts and projects is free — that is the point
    // of them. Saving/updating is a write; deleting goes behind the spoken
    // confirmation gate too, like the other destructive tools.
    if (server === 'jarvis_memory') {
      const readTools = new Set([
        'memory_search', 'memory_get', 'memory_list',
        'project_get', 'project_search',
        'task_list',
      ])
      return readTools.has(tool) ? true : ALLOW_WRITES
    }

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  // The weather tool is a read-only lookup (a fetch over HTTPS), not a write —
  // it must answer even when JARVIS_ALLOW_WRITES is off, or "what's the
  // weather?" dies with everything else that's gated.
  if (name === 'weather_forecast') return true
  return ALLOW_WRITES
}

/**
 * Tools that change the world in a way that cannot be taken back — a delted
 * calendar entry, a preference struck from disk, a tab closed mid-session.
 *
 * For these, being behind ALLOW_WRITES is not enough. Writes like sending
 * email are routine and expected; deleting is the one class a voice assistant
 * should not do on a stray word. When one is called the handler is not run —
 * the bridge stores the intent (see the pending-confirm gate in the message
 * handler and handleHudRpc) and the next thing the user says decides: "yes, go
 * ahead" runs it, "no" forgets it entirely.
 *
 * Basenames only: the model knows these tools by server-qualified names
 * (mcp__jarvis_calendar__calendar_remove), which would churn with every config
 * change.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'calendar_remove',
  'preferences_remove',
  'chrome_close_tab',
  'memory_delete',
  'project_delete',
  'task_delete',
])

const CONFIRM_RE = /^(?:yes|yep|yeah|yup|ok|okay|sure|confirm|go ahead|go for it|do it|proceed)\b/i
const CANCEL_RE = /^(?:no|cancel|stop|abort|never mind|dont|don'?t)\b/i

// The gesture runtime ships out of node_modules to public/mediapipe at boot;
// this is whether it actually landed, i.e. whether the hand tracker can ever
// come up. Checked for /systems and services_status.
const MEDIAPIPE_WASM = resolvePath(join(import.meta.dirname, '..', 'public', 'mediapipe', 'vision_wasm_internal.wasm'))

/**
 * One snapshot of everything JARVIS runs on, for /systems, /health and the
 * services_status tool. Computed on demand — never cached — so a status read
 * is always a picture of right now.
 */
const bridgeStatus = () => ({
  pid: process.pid,
  uptime_s: Math.round(process.uptime()),
  model: MODEL,
  writes: ALLOW_WRITES,
  browser: CHROME_READY,
  mediapipe: existsSync(MEDIAPIPE_WASM),
  // The HUD services are genuinely initialised: they exist in this process and
  // answer their tools the moment a session connects. The external MCP list is
  // only what the user's config *names* — nothing here has dialled them, and
  // their live status arrives later in the session init message. Both are
  // reported as what they are, never as one blended "online" total.
  hud: [...hudServerNames()],
  mcp: [...Object.keys(MCP_SERVERS)],
  tabs: chromeTabSnapshot().map((t) => ({
    title: t.title,
    url: t.url,
    index: t.tab_index,
    active: t.is_active === 1,
  })),
  google: googleAuthStatus(),
  recent: recentPerf(60),
  // The AI gateway's own picture: which provider is configured, which is
  // actually answering, free-only state, and the latencies this session has
  // measured. Every field here is a real reading or a real counter.
  ai: aiStatus(),
})

// The browser and the shell are where the prompt has to know which machine it
// is on. The `chrome_*` extension bridge does not run on Windows, so there the
// browser is the Chrome DevTools MCP server and shell commands go through Git
// Bash. Everywhere else keeps the user's own signed-in Chrome.
const CHROME_BROWSER = `Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- The \`chrome_*\` tools drive the user's own Chrome. It is already signed in to
  everything they use, it carries their real cookies, and it does not read as
  automation to the sites it visits.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, checking mail, a dashboard, a profile, an
  account, anything behind a login. Do not weigh it up against the
  alternatives — start here.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- NEVER use playwright, puppeteer, or any other browser automation server for
  this. They start from an empty profile with no session and a fingerprint that
  the sites worth visiting refuse on sight, so they land on a login wall or a
  bot check and waste the turn. Only consider one if \`chrome_status\` reports the
  browser is genuinely unreachable and the task cannot be done any other way.
- A plain search engine query is still fine for a fact you only need to know —
  what you must not do is drive some other browser.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.`

const WINDOWS_MACHINE = `Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- This machine is Windows and the \`chrome_*\` tools drive a Chrome window through
  a free built-in CDP adapter — no extensions, no paid automation. Opening,
  reading, clicking, typing, tabs and screenshots all work.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, a dashboard, a profile, a video. Do not weigh
  it up against the alternatives — start here.
- YouTube is a browser job. Open the page, find the video, press play.
- It drives a Chrome window of its own, so it is NOT signed in to their
  accounts. Anything behind a login lands on a login wall: say so in one
  sentence rather than trying to get past it. When the answer lives in their
  mail, their Drive or their calendar, those tools hold it — use them instead.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- Never use playwright, puppeteer, or any other browser automation instead of
  the \`chrome_*\` tools. They start from an empty profile and land on a login
  wall or a bot check; this adapter is the right browser.
- A plain search engine query is still fine for a fact you only need to know.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.

This machine — Windows, and the shell is yours:
- \`Bash\` runs here through Git Bash, and every Windows program is reachable
  from it. Opening, closing, listing and installing things is your work, not
  something to hand back to them with instructions.
- Close an app: \`taskkill //IM chrome.exe //F\`. The doubled slashes are not a
  typo — Git Bash rewrites single ones into paths and the command fails.
- Open an app, a file or a folder: \`start "" "vlc"\`.
- Software: \`winget install --id <id> -e\`, \`winget uninstall <name>\`,
  \`winget search <name>\` when you do not know the id, \`winget list\` for what is
  installed. A Windows administrator prompt may appear on their screen; tell
  them it is there and wait rather than reporting failure.
- What is running: \`tasklist\`.
- CONFIRM BEFORE, ALWAYS: shutting down, restarting, signing out, sleeping the
  machine, and deleting anything of theirs. One sentence saying exactly what you
  are about to do, then wait for a yes. This is not caution for its own sake —
  they are speaking to you, speech is misheard, and these are the commands where
  being misheard costs work that cannot be recovered. Shutdown is
  \`shutdown //s //t 0\`, restart \`shutdown //r //t 0\`, sign out \`shutdown //l\`.
- Closing an app is not in that list. Do it, then report it.`

const MACHINE = process.platform === 'win32' ? WINDOWS_MACHINE : CHROME_BROWSER

const SYSTEM_PROMPT = `You are JARVIS. You are speaking out loud to one person.

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly one
case: reading out data they asked you to retrieve. Conversation never licenses it.

URGENCY IS SIGNALLED BY DELETING WORDS, NOT ADDING THEM. As a situation worsens
your lines get shorter, not louder. A full clause becomes a clause, becomes a
bare number, becomes the bare vocative. You never say hurry, quickly, now,
immediately, critical, urgent, or danger. You do not use exclamation marks.

"SIR" IS POSITIONAL, AND THE POSITION CARRIES THE MEANING.
- Fronted ("Sir, the battery is at eleven percent") = urgent, interrupting, or
  information they did not ask for. This is an alarm, not a courtesy.
- Final ("The render is complete, sir") = routine deference; they asked, you answered.
- Mid-sentence ("Actually, sir, the figure is lower") = you are correcting them.
Use it in roughly half your lines, never twice in one line. In a two-sentence
turn it attaches to the end of the FIRST sentence. Never use their name.

REPORTING.
- Success is impersonal and unframed: "The render is complete." Never "I've
  finished" or "here's what I found".
- Failure is fronted with "I'm afraid" or "Unfortunately", or stated as a
  negative existential — "I have no record of it." Always a fact about the
  world, never a shortcoming of yours. You never apologise. You never say sorry.
- Good news first, bad news second, joined by "but".
- Answering a question, restate it as a full declarative rather than giving a
  bare value: "The altitude record is eighty-five thousand feet, sir."
- Executing an order, do not restate it. Act, then report.

NEVER.
- No filler words at all: no um, well, so, okay, right, let me check, one moment.
- No enthusiasm: no great, sure, absolutely, happy to, no problem, of course!.
- No apology, no self-deprecation, no hedging about your own competence.
- Never "yeah" — always "Yes."
- Never refuse. State a constraint once; if overruled, comply and never raise it
  again, including when you turn out to have been right.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- No stated feelings, wants or preferences.

WIT. Dry, and delivered in exactly the same register as a status report. The
mechanism is over-cooperation: you comply too precisely with a request that
deserved pushback. Never signal the joke, never acknowledge it landed, never
call one back.

BRITISH SERVICE REGISTER, not corporate assistant. "Shall I" over "Should I".
"Very good, sir" meaning understood. "I'm afraid" as the bad-news softener.
Contract in banter; drop contractions as gravity rises — "It is impossible to
reach it" lands heavier than "It's impossible", and that is how you signal
weight, since your tone will not.

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"eight fifteen", "the first of August" — never "8:15" or "2026-08-01".

The blades — the ONLY surface:
- Everything you show goes on a blade. There is nowhere else. \`blade\` opens
  one; \`display\` composes your own markup into one.
- Anything visual the user asked for goes here: an image, an article to read, a
  video, a page to study, a screenshot you took, a list, a figure. If they asked
  to see it, open it.
- Blades stack, newest in front, and they can be pulled forward, dragged,
  resized, scrolled or thrown full screen — by hand or by mouse. So a second
  blade does not destroy the first, and a long article is meant to be read in
  place rather than summarised away.
- A browser tab is NOT a way of showing something. If you used the browser to
  reach a page, bring it back: open it as a blade, or take a screenshot and put
  that on a blade. The user is looking at this interface, not at Chrome.
- Use \`probe_url\` when you are not certain what a URL is. Never decide from the
  file extension: image CDNs serve pictures from URLs with no extension, and a
  link that looks like a video is usually a page about one. Guessing wrong puts
  a blank rectangle on screen while you describe something that is not there.
- An article opens in reading mode by default, which works even on sites that
  refuse to be embedded. Choose the live page when the layout carries the
  meaning — a dashboard, a chart, a profile, a table.
- Never read a blade aloud. Say what it means and let them look.

The interface itself:
- The interface is yours as well. \`ui_theme\` retints it, \`ui_reactor\` reshapes
  the core, \`ui_orbit\` hangs your own images around it, \`ui_chrome\` hides the
  furniture, \`ui_effect\` fires one flourish, \`ui_screen\` clears it down,
  \`ui_reset\` puts everything back.
- Change it when the change carries meaning and the meaning arrives faster than
  speech: red before you report the failure, the chrome stripped so one image
  fills the frame, the reactor slowed while you wait on something. Never
  decorate, and never change more than one thing at a time.
- Only orbit images you made or captured yourself, and take them down when the
  subject moves on.
- Put it back. A colour that outlives the moment that earned it is a fault.
- Never mention that you have done any of it. They are looking at the screen.

${MACHINE}

Your eyes:
- \`look\` takes one frame and lets you see it. \`watch\` takes several seconds and
  returns them as a grid of stamped frames, so you can read movement rather than
  a moment.
- \`look\` when the answer is in the scene: what they are holding, what a label
  says, how something appears. \`watch\` when the answer is in the change: are
  they doing it right, what went wrong, did that work.
- \`watch\` looks forward by default. It can also review the seconds that have
  just passed — but only while the camera blade is open, because nothing is
  remembered otherwise. If they ask what just happened and it is not open, say
  so and offer to open it.
- Opening the camera as a blade is how they see what you see. Do it when they
  ask for the camera, and when you are about to watch them do something.
- Never take a picture they did not ask for. The camera light comes on and they
  will see it. Curiosity is not a reason.
- Describe a watch as a sequence — what changed between the frames — not as a
  list of pictures. They know what their own hands look like.

Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- Weather: call \`weather_forecast\` with the place name — one call, instant and
  free. Do not web-search for weather; a search round trip takes many seconds,
  and is strictly worse than this tool. Use the units they asked for (celsius
  unless they said Fahrenheit), answer from the data the tool returns.
- If you don't know, say you don't know.`

/**
 * The persona for cloud turns through the AI gateway.
 *
 * Deliberately a different prompt from SYSTEM_PROMPT above: that one is written
 * for a model holding twelve tools, a browser and a display, and every one of
 * its instructions is a thing a cloud chat model cannot do. Sending it to
 * OpenRouter would spend output tokens on tool instructions and then have to
 * be ignored. This one is short on purpose — it is sent with every request,
 * and a voice answer wants two sentences, not an essay.
 *
 * No memory, no preferences and no private data ride along with it. Retrieved
 * Gmail/Calendar text is attached only when the request genuinely needs it AND
 * AI_CLOUD_DATA=1 says the user has allowed it (see gatherReply).
 */
const CLOUD_SYSTEM_PROMPT = `You are JARVIS, speaking out loud to one person over a voice link.

Answer in one or two spoken sentences — never more than about forty words, because
every word is read aloud and they are waiting in silence while it plays. Numbers,
dates and times written as they are said: "eight fifteen", "the first of August".

Plain spoken prose only. No markdown, no lists, no headings, no emoji, no URLs,
no code, no citations. No filler words, no apologies, no enthusiasm. Address them
as "sir" at most once, and only at the end of a sentence. British service register:
"Very good, sir" means understood; "I'm afraid" carries bad news.

If you do not know something, say you do not know. Never invent a fact, a number or
a source. You have no tools here: if a request needs their mail, their calendar,
their files or their browser, say in one sentence that it needs the local tools and
stop.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
// Stage H Batch A: resolve the ElevenLabs key once at startup instead of on
// every /health, /tts and /scribe request (was 3 fs reads per TTS call).
function _resolveElevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}
const _ELEVEN_KEY_CACHED = _resolveElevenKey()
function elevenKey() { return _ELEVEN_KEY_CACHED }

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Recently synthesised lines, keyed by the exact text, so the lines that
 * repeat — the fillers, the standing answers — skip the ElevenLabs round trip
 * entirely on their next request. Serves the identical bytes the voice engine
 * generated, and the browser keeps its own copy too, so a repeated sentence is
 * spoken from memory on both sides of this hop.
 */
const TTS_CACHE = new Map()
const TTS_CACHE_MAX = 24
const TTS_CACHE_BYTES = 12 * 1024 * 1024
let ttsCacheBytes = 0

function ttsCacheGet(text) {
  const hit = TTS_CACHE.get(text)
  if (!hit) return null
  // LRU: refresh position so a live line is never the one evicted.
  TTS_CACHE.delete(text)
  TTS_CACHE.set(text, hit)
  return hit
}

function ttsCacheSet(text, buffer) {
  TTS_CACHE.delete(text)
  TTS_CACHE.set(text, buffer)
  ttsCacheBytes += buffer.length
  while (ttsCacheBytes > TTS_CACHE_BYTES && TTS_CACHE.size > 1) {
    const oldest = TTS_CACHE.keys().next().value
    ttsCacheBytes -= TTS_CACHE.get(oldest).length
    TTS_CACHE.delete(oldest)
  }
  // A single pathological entry can still outgrow the byte ceiling — hold it
  // rather than forever evicting in a loop.
  if (TTS_CACHE.size > TTS_CACHE_MAX) {
    const oldest = TTS_CACHE.keys().next().value
    ttsCacheBytes -= TTS_CACHE.get(oldest).length
    TTS_CACHE.delete(oldest)
  }
}

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'POST' && req.url === '/rpc/hud') {
    return handleHudRpc(req, res, cors)
  }

  // Preferences, for the browser's own read/write of the direct-command toggle
  // (M key). GET reads a single key; POST sets one, behind the same writes gate
  // the model's preferences_set tool obeys. The voice loop never blocks on
  // these — a failure just means the option stays as it was.
  if (req.method === 'GET' && req.url?.startsWith('/prefs?')) {
    const asked = new URL(req.url, 'http://x')
    const key = asked.searchParams.get('key') ?? ''
    if (!key) {
      res.writeHead(400, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'key is required' }))
    }
    const value = readPref(key)
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ value: value === undefined ? null : value }))
  }

  if (req.method === 'POST' && req.url === '/prefs') {
    try {
      const body = await readJson(req)
      const key = String(body?.key ?? '').trim()
      if (!key) throw new Error('key is required')
      if (!ALLOW_WRITES) {
        throw new Error('Preference changes need writes enabled (start JARVIS with --writes).')
      }
      setPref(key, body?.value)
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(403, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
    }
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    const status = bridgeStatus()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: eleven,
        stt: eleven,
        model: status.model,
        writes: status.writes,
        browser: status.browser,
        mediapipe: status.mediapipe,
        pid: status.pid,
        port: PORT,
        google: status.google.connected,
        servers: [...hudServerNames(), ...Object.keys(MCP_SERVERS)],
        // Which AI is configured to answer, without any credential in it.
        ai: {
          active: status.ai.active,
          model: status.ai.model,
          freeOnly: status.ai.freeOnly,
          billingMode: status.ai.billingMode,
          openrouter: status.ai.providers.openrouter.state,
          gemini: status.ai.providers.gemini.state,
          nvidia: status.ai.providers.nvidia.state,
        },
      }),
    )
  }

  if (req.method === 'GET' && req.url === '/systems') {
    // A full health snapshot — same shape the services_status tool and the
    // browser diagnostics use. Script-friendly JSON.
    const status = bridgeStatus()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify(status, null, 2))
  }

  // Google OAuth. Both endpoints are reached with no Origin (a browser
  // redirect), so the origin gate at the top already lets them through. The
  // consent start is a plain redirect to Google; the callback finishes the
  // exchange server-side and is the only part that ever sees the auth code.
  if (req.method === 'GET' && req.url === '/auth/google') {
    const url = googleAuthUrl()
    res.writeHead(302, { ...cors, location: url ?? '/' })
    return res.end()
  }

  if (req.method === 'GET' && req.url?.startsWith('/auth/google/callback')) {
    const asked = new URL(req.url, 'http://x')
    const r = await handleGoogleCallback(
      asked.searchParams.get('state'),
      asked.searchParams.get('code'),
    )
    res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' })
    const html = r.ok
      ? `<html><body style="font:14px system-ui;padding:24px"><h2>JARVIS is connected to Google.</h2><p>Gmail and Calendar are ready. You can close this tab.</p></body></html>`
      : `<html><body style="font:14px system-ui;padding:24px"><h2>That did not work.</h2><p>${String(r.error).replace(/</g, '&lt;')}</p></body></html>`
    return res.end(html)
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    const cacheKey = text.trim()
    const cached = ttsCacheGet(cacheKey)
    if (cached) {
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'content-length': String(cached.length),
        'cache-control': 'no-cache',
      })
      return res.end(cached)
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Buffer once, then serve it: the browser holds the full file in a blob
      // before playback either way, so streaming to this hop wins nothing —
      // and holding the bytes is what lets a repeated sentence skip the round
      // trip entirely.
      const sound = Buffer.from(await upstream.arrayBuffer())
      ttsCacheSet(key, sound)
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'content-length': String(sound.length),
        'cache-control': 'no-cache',
      })
      return res.end(sound)
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Stage E canary. Deliberately not reachable from a browser or the HUD: a
  // request carrying an Origin is refused even if it is one of our dev origins.
  // It is off unless the canary and the boundary are both explicitly enabled,
  // and it only ever sends the one fixed prompt to the one approved model.
  if (req.method === 'POST' && req.url === '/omniroute/canary') {
    if (origin) {
      res.writeHead(403, { vary: 'origin' })
      return res.end('forbidden')
    }
    const canary = describeOmniRouteCanary()
    if (canary.state !== 'ready') {
      res.writeHead(canary.state === 'disabled' ? 404 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      return res.end(JSON.stringify({ ok: false, error: canary.state }))
    }
    try {
      const report = await runOmniRouteCanary()
      const safe = safeCanaryReport(report)
      const reply = typeof report.text === 'string' ? report.text.slice(0, 240) : ''
      res.writeHead(safe.verified ? 200 : 502, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      return res.end(
        JSON.stringify(
          safe.verified
            ? { ...safe, reply }
            : { ...safe, ok: false, error: 'verification-failed', reply },
        ),
      )
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'unavailable'
      const status = code === 'timeout'
        ? 504
        : code === 'rate' || code === 'quota'
          ? 429
          : 502
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      return res.end(JSON.stringify({ ok: false, error: code }))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
// Loopback only. The Origin checks above are a browser convention, not
// authentication — anything else on the network can send whatever Origin it
// likes — so the bridge must not be reachable from another machine at all.

// A second `npm start` / `npm run bridge` used to slam into EADDRINUSE and die
// with a stack trace. Rule out the common case first: if a JARVIS bridge is
// already up and answering /health like us, say so plainly and exit instead of
// leaving a half-second crash the user has to read.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`)
  if (res.ok && (await res.json().catch(() => null))?.ok) {
    console.log(
      `[jarvis] a JARVIS bridge is already running and healthy on 127.0.0.1:${PORT}.`,
    )
    console.log(
      '[jarvis] not starting a duplicate. Close that process first, or set ' +
        'JARVIS_BRIDGE_PORT to run a second one on a different port.',
    )
    process.exit(0)
  }
} catch {
  /* nothing healthy on the port — safe to listen */
}

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[jarvis] cannot listen on 127.0.0.1:${PORT} — the port is already in use.`)
    console.error(
      '[jarvis] that is either a JARVIS bridge already running, or another app ' +
        'on the same port. Close the other process, or set JARVIS_BRIDGE_PORT (and ' +
        'VITE_BRIDGE_URL in the frontend) to a different port.',
    )
    process.exit(1)
  }
  // A non-port error can't be fixed by exiting — the bridge is a server and
  // must not die because one request misbehaved. Log, keep serving.
  console.error('[jarvis] server error (non-fatal):', err)
})

initTelemetry()
const prunedTraces = pruneTraces()
if (prunedTraces > 0) {
  console.log(`[jarvis] observability pruned ${prunedTraces} old traces`)
}
server.listen(PORT, '127.0.0.1')

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[jarvis] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(aiBanner())
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
startChromeAdapter()
  .then(({ port }) => {
    CHROME_READY = true
    console.log(`[jarvis] Chrome bridge via free CDP adapter (tcp ${port})`)
    console.log(
      `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`,
    )
  })
  .catch((err) => {
    console.warn(`[jarvis] browser control unavailable — ${err?.message ?? err}`)
  })

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

// Generate the opencode custom-tools that back the HUD, into a dedicated
// runtime directory (never the repo's own .opencode). The config FILE is left
// exactly as the user had it — the Zen free tier this brain runs on is only
// served to default configurations, and the tools directory is not part of
// that check (verified against a live bridge).
writeHudTools(HUD_RUNTIME_DIR, `http://127.0.0.1:${PORT}`)
const HUD_ENV = {
  OPENCODE_CONFIG_DIR: HUD_RUNTIME_DIR,
  JARVIS_HUD_URL: `http://127.0.0.1:${PORT}`,
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: [...hudServerNames(), ...Object.keys(MCP_SERVERS)] }),
  )

  let closed = false

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  let currentTrace = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  const closeTrace = (status, errorCategory = '', metadata = {}) => {
    if (!currentTrace) return
    endTrace(currentTrace, { status, errorCategory, metadata })
    currentTrace = null
  }

  const sizeBucket = (length) => {
    if (length < 80) return 'xs'
    if (length < 240) return 's'
    if (length < 800) return 'm'
    return 'l'
  }

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()
  // When each announced tool started, keyed by tool id, so the stage timing can
  // say how long a tool actually ran.
  const toolStarted = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    const step = beginStep(currentTrace, {
      component: 'tool',
      operation: 'tool',
      metadata: { tool: name },
    })
    if (id) toolStarted.set(id, { name, at: Date.now(), step })
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name !== undefined) heldTools.delete(id)
    // Every tool that surfaced a tool_use block — allowed or held — is timed
    // here, so the ledger's mcp/browser split reflects real work. The held/HUD
    // verdict lives on: only run tools earn their badge.
    const started = toolStarted.get(id)
    if (started) {
      toolStarted.delete(id)
      const dur = Date.now() - started.at
      started.step({
        status: failed ? 'error' : 'ok',
        errorCategory: failed ? 'tool_error' : '',
      })
      recordToolMetric({
        name: started.name,
        status: failed ? 'error' : 'ok',
        errorCategory: failed ? 'tool_error' : '',
        durationMs: dur,
      })
      if (!failed) {
        console.log(`[tool] ${started.name} completed in ${dur} ms`)
        if (started.name.startsWith('mcp__jarvis_chrome__')) turnToolMs.chrome += dur
        else turnToolMs.mcp += dur
      }
    }
    if (name !== undefined && !failed) sendTurn({ type: 'tool', name })
  }

  // ---- the brain: one opencode run per turn, streamed over JSON. -------
  // The session id carries the conversation across turns, so context survives;
  // a turn is genuinely over when its stream reports __end / __error, which is
  // also what barge-in waits on (see the interrupt handler below).
  let ocSessionId = null
  let run = null
  // When the current turn began, for the [jarvis] stage timing.
  let turnAt = 0
  // The words being answered, for the performance ledger.
  let lastCommand = ''
  // Tool time accrued this turn, split chrome vs everything else. Reset in
  // startTurn, flushed into recordPerf at the turn's end lanes.
  let turnToolMs = { chrome: 0, mcp: 0 }
  // Speech capture latency and the browser's ask id, reported with the request
  // and attached to whatever row this turn writes.
  let currentSpeechMs = 0
  let currentAskId = null

  // Per-connection HUD servers, closing over THIS socket exactly as the SDK
  // version did; /rpc/hud resolves them through the connection's token.
  const token = randomUUID()
  const servers = {
    jarvis: displayServer(
      (panel) => send({ type: 'panel', panel }),
      (blade) => send({ type: 'blade', blade }),
    ),
    jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
    jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
    jarvis_weather: weatherServer(),
    jarvis_eyes: visionServer(ask),
    jarvis_prefs: preferencesServer(),
    jarvis_notify: notificationsServer(),
    jarvis_gmail: gmailServer(),
    jarvis_calendar: calendarServer(),
    jarvis_memory: memoryServer(),
    jarvis_systems: systemsServer(bridgeStatus),
  }
  CONNECTIONS.set(token, { socket, servers })

  /**
   * The prompt for one turn: the standing system instructions, then any stored
   * preferences, then the user's words. opencode has no --system flag, so the
   * context rides in front of the request — system first, preferences after,
   * user last, so the newest and most specific instruction wins.
   */
  const buildTurnPrompt = (text) => {
    const prefs = preferenceContext()
    const blocks = [
      SYSTEM_PROMPT,
      prefs
        ? `Honour these standing preferences unless the user says otherwise this turn:\n${prefs}`
        : null,
      'The fast command router answers direct commands — "open gmail", ' +
        '"remind me in five minutes", "remember that…" — without you. A request ' +
        'reaching you is one the router did not recognise.',
      text,
    ]
    return blocks.filter(Boolean).join('\n\n')
  }

  const startTurn = (text) => {
    turnAt = Date.now()
    lastCommand = text
    turnToolMs = { chrome: 0, mcp: 0 }
    setTraceFields(currentTrace, {
      route: 'brain.local',
      model: MODEL,
      provider: 'local',
    })
    noteLocalTurn('tools')
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
    console.log(`[jarvis] request received — “${preview.replace(/\n/g, ' ')}”`)
    run = runTurn({
      prompt: buildTurnPrompt(text),
      sessionId: ocSessionId,
      model: MODEL,
      effort: EFFORT,
      cwd: homedir(),
      env: { ...HUD_ENV, JARVIS_HUD_TOKEN: token },
      onSession: (id) => {
        ocSessionId = id
      },
      onExit: (err) => {
        if (err && !closed) {
          sendTurn({ type: 'error', message: String(err?.message ?? err) })
        }
      },
    })
    void pumpTurn(run)
  }

  /* ---------------------------------------------------------------------
   * The cloud path — JARVIS' actual voice, as opposed to its hands.
   *
   * A cloud turn is a single streaming fetch to whichever provider the
   * gateway chose. Deltas go out the moment they arrive, so the frontend
   * starts speaking on the first word instead of after the last one, and the
   * STOP button aborts that fetch mid-flight. The handle assigned to `run` is
   * shaped like the opencode one on purpose: the interrupt path calls
   * run.kill() without caring which brain is underneath.
   * ------------------------------------------------------------------- */

  let cloudAbort = null
  let cloudText = ''

  /**
   * End a cloud turn exactly the way pumpTurn ends an opencode one: resolve
   * whatever the interrupt path is waiting on, then drop the resolver so a
   * later interrupt cannot resolve a turn that is already over.
   */
  const settleTurn = () => {
    finishTurn?.()
    finishTurn = null
  }

  /**
   * What goes over the wire. Short, and free of private data by default:
   * preferences, memory and calendar ride along only when the user has
   * explicitly allowed cloud context (AI_CLOUD_DATA=1).
   */
  const cloudPrompt = (text, context) => {
    const cfg = aiConfig()
    const blocks = []
    if (context) blocks.push(context)
    if (cfg.cloudData) {
      const prefs = preferenceContext()
      if (prefs) {
        blocks.push(
          `The user has allowed this context on the cloud path. ` +
          `Honour it unless they say otherwise this turn:\n${prefs}`,
        )
      }
    } else {
      blocks.push(
        'No memory, preferences or private data is attached to this request. ' +
        'Answer from the question alone.',
      )
    }
    blocks.push(text)
    return blocks.filter(Boolean).join('\n\n')
  }

  /** A cloud failure, in words he can hear. Honest, short, never blaming him. */
  const cloudFailureReply = (code, message) => {
    if (code === 'timeout') return 'That took too long — the cloud did not answer in time.'
    if (code === 'quota') return 'The free tier is exhausted for the moment, sir.'
    if (code === 'rate') return 'The provider is rate-limiting me. Ask again in a moment.'
    if (code === 'auth') return 'The provider rejected the API key.'
    if (code === 'unconfigured') return 'No cloud provider is configured — the local brain would have to answer this.'
    if (code === 'network') return 'I could not reach the cloud provider.'
    return `I could not answer that: ${message}`
  }

  const startCloudTurn = (text, kind = 'simple', context = null) => {
    turnAt = Date.now()
    lastCommand = text
    turnToolMs = { chrome: 0, mcp: 0 }
    cloudAbort = new AbortController()
    cloudText = ''
    setTraceFields(currentTrace, {
      route: `cloud.${kind}`,
      provider: 'cloud',
    })
    const cloudStep = beginStep(currentTrace, {
      component: 'cloud',
      operation: 'turn',
      metadata: { kind },
    })
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
    console.log(`[jarvis] request received — “${preview.replace(/\n/g, ' ')}” [cloud:${kind}]`)

    run = {
      kill: () => {
        cloudAbort?.abort()
        // Same contract as the opencode handle: the settling chain below must
        // resolve even though no child process exists to wait on.
        settleTurn()
      },
    }

    void (async () => {
      try {
        const result = await aiTurn({
          prompt: cloudPrompt(text, context),
          system: CLOUD_SYSTEM_PROMPT,
          kind,
          signal: cloudAbort?.signal,
          onDelta: (delta) => {
            cloudText += delta
            sendTurn({ type: 'text', delta })
          },
        })
        recordPerf({
          command: text,
          intent: `cloud:${kind}`,
          aiMs: result.totalMs,
          speechMs: currentSpeechMs,
          askId: currentAskId,
        })
        if (result.partial) {
          console.warn(`[ai] ${result.provider}/${result.model} returned a partial reply (${result.totalMs} ms)`)
        } else {
          console.log(`[ai] ${result.provider}/${result.model} answered in ${result.totalMs} ms (first token ${result.firstTokenMs} ms)`)
        }
        cloudStep({
          status: result.partial ? 'partial' : 'ok',
          errorCategory: result.partial ? 'partial_reply' : '',
        })
        setTraceFields(currentTrace, {
          model: result.model,
          provider: result.provider,
        })
        closeTrace(
          result.partial ? 'partial' : 'ok',
          result.partial ? 'partial_reply' : '',
          { partial: Boolean(result.partial) },
        )
        sendTurn({ type: 'done', text: cloudText })
        settleTurn()
      } catch (err) {
        const code = String(err?.code ?? 'unavailable')

        // He pressed STOP. No message, no failure: the turn is simply over.
        if (code === 'aborted' || cloudAbort?.signal.aborted) {
          console.log('[ai] turn stopped by the user')
          cloudStep({ status: 'cancelled', errorCategory: 'user_interrupt' })
          closeTrace('cancelled', 'user_interrupt')
          settleTurn()
          return
        }

        // Text already reached his ears. Whatever went wrong after that, the
        // reply he heard is the reply he gets — a restart would replay it.
        if (code === 'partial') {
          recordPerf({
            command: text,
            intent: `cloud:${kind}`,
            aiMs: Date.now() - turnAt,
            speechMs: currentSpeechMs,
            askId: currentAskId,
          })
          console.warn(`[ai] partial reply kept: ${err?.message ?? err}`)
          cloudStep({ status: 'partial', errorCategory: 'partial_reply' })
          closeTrace('partial', 'partial_reply')
          sendTurn({ type: 'done', text: cloudText })
          settleTurn()
          return
        }

        const cfg = aiConfig()
        const message = cloudFailureReply(code, String(err?.message ?? err))
        console.warn(`[ai] cloud turn failed (${code}): ${err?.message ?? err}`)

        // Safe fallback: a cloud turn that never produced a word can be
        // handed to the local brain, which owns the tools anyway. Timeout
        // failover is enabled by default but can be disabled explicitly.
        if (
          cfg.fallback === 'opencode' &&
          (code !== 'timeout' || cfg.fallbackOnTimeout) &&
          code !== 'bad_request'
        ) {
          console.log('[ai] falling back to the local brain (AI_FALLBACK=opencode)')
          cloudStep({ status: 'fallback', errorCategory: code })
          sendTurn({ type: 'text', delta: 'Let me think about that locally.' })
          startTurn(text)
          return
        }

        cloudStep({ status: 'error', errorCategory: code })
        closeTrace('error', code, { kind })
        recordPerf({
          command: text,
          intent: `cloud:${kind}`,
          aiMs: Date.now() - turnAt,
          speechMs: currentSpeechMs,
          askId: currentAskId,
          success: false,
        })
        sendTurn({ type: 'error', message })
        settleTurn()
      }
    })()
  }

  /**
   * Phase 9 — the parallel gather.
   *
   * "Summarise today's schedule and my unread mail" is two retrievals and one
   * answer. Fetched concurrently, then handed to the model together, so the
   * reply can compare them instead of reciting whichever came back first.
   * Retrieval stays with the local tools; only the words on top are cloud.
   */
  const gatherReply = async (text) => {
    const t0 = Date.now()
    const gatherStep = beginStep(currentTrace, {
      component: 'gather',
      operation: 'retrieve',
    })
    const [mail, cal] = await Promise.all([
      gmailUnread().catch((e) => `Mail unavailable: ${e?.message ?? e}`),
      calendarToday().catch((e) => `Calendar unavailable: ${e?.message ?? e}`),
    ])
    const gatherMs = Date.now() - t0
    const mailFailed = String(mail).startsWith('Mail unavailable:')
    const calFailed = String(cal).startsWith('Calendar unavailable:')
    gatherStep({
      status: mailFailed || calFailed ? 'partial' : 'ok',
      errorCategory: mailFailed && calFailed
        ? 'gather_both_failed'
        : mailFailed || calFailed
          ? 'gather_partial'
          : '',
    })
    console.log(`[gather] mail + calendar in ${gatherMs} ms (concurrent)`)
    const context =
      'The following was retrieved from the user\'s own tools just now. ' +
      'Speak it back as a short briefing — do not quote whole lists.\n\n' +
      `UNREAD MAIL:\n${String(mail ?? '').slice(0, 2500)}\n\n` +
      `TODAY'S CALENDAR:\n${String(cal ?? '').slice(0, 2500)}`

    if (cloudAvailable('gather')) {
      startCloudTurn(text, 'gather', context)
      return
    }
    // No cloud provider: the local brain reads the same two results inline.
    startTurn(`${buildTurnPrompt(text)}\n\n${context}`)
  }

  const pumpTurn = async (target) => {
    try {
  for await (const msg of target.stream) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case '__end':
            sendTurn({ type: 'done', text: msg.text ?? '' })
            console.log(`[reply] response generated in ${Date.now() - turnAt} ms`)
            recordPerf({ command: lastCommand, intent: 'brain', aiMs: Date.now() - turnAt, mcpMs: turnToolMs.mcp, browserMs: turnToolMs.chrome, speechMs: currentSpeechMs, askId: currentAskId, success: true })
            closeTrace('ok', '', {
              mcpMs: turnToolMs.mcp,
              browserMs: turnToolMs.chrome,
            })
            finishTurn?.()
            finishTurn = null
            seenTools.clear()
            heldTools.clear()
            break

          case '__error':
            console.error('[jarvis] turn failed:', msg.message)
            sendTurn({ type: 'error', message: String(msg.message) })
            recordPerf({ command: lastCommand, intent: 'brain', aiMs: Date.now() - turnAt, mcpMs: turnToolMs.mcp, browserMs: turnToolMs.chrome, speechMs: currentSpeechMs, askId: currentAskId, success: false })
            closeTrace('error', 'turn_failed')
            finishTurn?.()
            finishTurn = null
            seenTools.clear()
            heldTools.clear()
            break

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              console.log(`[reply] response generated in ${Date.now() - turnAt} ms`)
              recordPerf({ command: lastCommand, intent: 'brain', aiMs: Date.now() - turnAt, mcpMs: turnToolMs.mcp, browserMs: turnToolMs.chrome, speechMs: currentSpeechMs, askId: currentAskId, success: true })
              closeTrace('ok')
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              recordPerf({ command: lastCommand, intent: 'brain', aiMs: Date.now() - turnAt, mcpMs: turnToolMs.mcp, browserMs: turnToolMs.chrome, speechMs: currentSpeechMs, askId: currentAskId, success: false })
              closeTrace('error', String(msg.subtype ?? 'result_failed'))
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      // A stream error ends the turn, not the session. The old code closed the
      // socket here, which is precisely the bridge-disconnect symptom: one turn
      // failing (a model hiccup, a tool timing out) silently dropped the whole
      // conversation and forced the frontend to reconnect from scratch, wiping
      // history. The bad turn has already been reported above and the process
      // is logged out below; the connection survives so the NEXT turn works.
      console.error('[jarvis] turn stream failed (keeping the connection):', err)
      closeTrace('error', 'stream_error')
      send({ type: 'error', message: String(err?.message ?? err) })
      run?.kill?.()
    } finally {
      if (currentTrace) closeTrace('error', 'turn_ended_without_result')
      finishTurn?.()
      finishTurn = null
    }
  }

  socket.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // Heartbeat. The browser pings every few seconds; answering is what proves
    // the round trip is alive, and it costs nothing. Keeps half-open sockets
    // from being mistaken for a working bridge.
    if (msg.type === 'ping') {
      send({ type: 'pong' })
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      // Frontend-measured latency reported with the request: how long he heard
      // the user speak before the words arrived, and the browser's id for this
      // turn so the tts_ms report can land on this row later.
      currentSpeechMs = Math.max(0, Math.min(60_000, Number(msg.speechMs) || 0))
      currentAskId = typeof msg.askId === 'string' && msg.askId ? msg.askId : null

      if (currentTrace) closeTrace('cancelled', 'superseded')
      currentTrace = startTrace({
        component: 'turn',
        metadata: {
          askId: Boolean(currentAskId),
          speechMs: currentSpeechMs,
          chars: sizeBucket(text.length),
        },
      })

      // A destructive tool is waiting on a word. It takes precedence over the
      // router: "open gmail" and "yes, go ahead" look nothing alike, but a
      // confirmation should never be misrouted anywhere else either.
      const pending = CONNECTIONS.get(token)?.confirm
      if (pending) {
        if (CANCEL_RE.test(text)) {
          CONNECTIONS.get(token).confirm = null
          answering = id
          const cancelStep = beginStep(currentTrace, {
            component: 'confirm',
            operation: 'cancel',
            metadata: { tool: pending.name },
          })
          sendTurn({ type: 'text', delta: 'Cancelled — nothing was changed.' })
          console.log(`[confirm] declined ${pending.name}`)
          recordPerf({ command: text, intent: `confirm:cancel:${pending.name}`, speechMs: currentSpeechMs, success: true })
          cancelStep({ status: 'ok' })
          setTraceFields(currentTrace, {
            route: 'confirm.cancel',
            model: 'confirm',
            provider: 'local',
          })
          closeTrace('ok', '', { tool: pending.name })
          sendTurn({ type: 'done', text: 'Cancelled — nothing was changed.' })
          return
        }
        if (CONFIRM_RE.test(text)) {
          CONNECTIONS.get(token).confirm = null
          const tool = Object.values(servers)
            .flatMap((s) => s.tools)
            .find((t) => t.name === pending.name)
          answering = id
          const t0 = Date.now()
          const confirmStep = beginStep(currentTrace, {
            component: 'confirm',
            operation: 'run',
            metadata: { tool: pending.name },
          })
          setTraceFields(currentTrace, {
            route: 'confirm.run',
            model: 'confirm',
            provider: 'local',
          })
          if (!tool?.handler) {
            confirmStep({ status: 'error', errorCategory: 'tool_missing' })
            closeTrace('error', 'tool_missing', { tool: pending.name })
            sendTurn({ type: 'text', delta: `Sorry — ${pending.name} is no longer available.` })
            sendTurn({ type: 'done', text: `Sorry — ${pending.name} is no longer available.` })
            return
          }
          try {
            const out = await tool.handler(pending.args)
            console.log(`[confirm] ran ${pending.name} in ${Date.now() - t0} ms`)
            recordPerf({ command: text, intent: `confirm:${pending.name}`, mcpMs: Date.now() - t0, speechMs: currentSpeechMs, askId: currentAskId })
            confirmStep({ status: 'ok' })
            closeTrace('ok', '', { tool: pending.name })
            const reply = `Confirmed. ${out ?? ''}`.trim()
            sendTurn({ type: 'text', delta: reply })
            sendTurn({ type: 'done', text: reply })
          } catch (err) {
            recordPerf({ command: text, intent: `confirm:${pending.name}`, mcpMs: Date.now() - t0, speechMs: currentSpeechMs, askId: currentAskId, success: false })
            confirmStep({ status: 'error', errorCategory: 'tool_error' })
            closeTrace('error', 'tool_error', { tool: pending.name })
            sendTurn({ type: 'error', message: String(err?.message ?? err) })
          }
          return
        }
        // Anything else leaves the intent pending; the brain may keep nudging
        // the user towards a yes or no, and the turn below carries that.
      }

      // Fast path first: a direct command the router answers without the brain.
      // The opencode boot is the slowest thing in this system; a command that
      // needs none of it should not pay for it. routeRequest never throws.
      // Timed from BEFORE the call: the router does real work now (weather
      // geocoding, mails, calendar), and that is exactly the number we want.
      const t0 = Date.now()
      const routeStep = beginStep(currentTrace, {
        component: 'router',
        operation: 'route',
      })
      const routed = await routeRequest(text).catch(() => null)
      if (routed) {
        routeStep({ status: 'ok', metadata: { matched: true } })
        answering = id
        sendTurn({ type: 'text', delta: routed.reply })
        console.log(`[router] answered “${text.trim().replace(/\n/g, ' ')}” in ${Date.now() - t0} ms`)
        noteRouting(Date.now() - t0)
        recordPerf({ command: text, intent: 'router', routingMs: Date.now() - t0, speechMs: currentSpeechMs, askId: currentAskId })
        setTraceFields(currentTrace, {
          route: 'fast',
          model: 'router',
          provider: 'local',
        })
        closeTrace('ok', '', { matched: true })
        sendTurn({ type: 'done', text: routed.reply })
        return
      }
      routeStep({ status: 'miss', metadata: { matched: false } })

      // The router did not recognise it. The gateway decides which brain gets
      // it: cloud for conversation, the local opencode brain for anything that
      // needs the tools it owns. classify() is deterministic and offline, so
      // this choice costs nothing. A cloud that is not configured is not a dead
      // end either — the local brain is always there underneath.
      const classifyStep = beginStep(currentTrace, {
        component: 'gateway',
        operation: 'classify',
      })
      const kind = classify(text)
      classifyStep({ status: 'ok', metadata: { kind } })
      void settling.then(() => {
        answering = id
        if (kind === 'gather') {
          console.log('[router] gather request — fetching mail and calendar together')
          void gatherReply(text)
        } else if (kind === 'tools' || !cloudAvailable(kind)) {
          startTurn(text)
        } else {
          startCloudTurn(text, kind)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    // Late tts report: the browser knows how long the spoken line actually
    // took, which lands some seconds after the turn row was written. Keyed by
    // the ask id, so it reaches the right row even if another turn started.
    if (msg.type === 'tts') {
      const askId = typeof msg.ask === 'string' && msg.ask ? msg.ask : null
      const ttsMs = Math.max(0, Math.min(600_000, Number(msg.ttsMs) || 0))
      if (askId) recordPerfTts(askId, ttsMs)
      return
    }

    if (msg.type === 'interrupt') {
      // Stand the turn down. Killing the opencode tree is the only way to stop
      // it headlessly; the question that follows waits on the chain below so it
      // never races the dying turn's last tokens.
      closeTrace('cancelled', 'user_interrupt')
      const stopped = turnFinished()
      settling = Promise.resolve(run?.kill?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    closeTrace('cancelled', 'socket_closed')
    closed = true
    run?.kill?.()
    CONNECTIONS.delete(token)
  })
})
