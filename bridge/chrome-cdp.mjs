/**
 * A free, dependency-light stand-in for the Claude Chrome extension bridge.
 *
 * The extension's native host is a Unix socket that is never available on
 * Windows, and its session-free use now carries a Claude licence. So instead of
 * needing either, this adapter speaks the extension's own wire protocol — the
 * same 4-byte little-endian length-prefixed JSON frames carrying
 * `{ method: 'execute_tool', params: { tool, args } }`, answered with
 * `{ result: { content } }` or `{ error: { content } }` — over a local TCP
 * port, and translates every tool the bridge knows into plain Chrome DevTools
 * Protocol calls. chrome.mjs does not know the difference: it just connects.
 *
 * Chrome is discovered through its remote-debugging port (start Chrome with
 * --remote-debugging-port=9222 to reuse an already-signed-in profile), or
 * launched fresh with its own profile when nothing is listening.
 */

import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { db, many, nowMs } from './db.mjs'

const HTTP_RETRIES = 30
const RETRY_GAP_MS = 400

function log(...bits) {
  console.log('[jarvis] chrome:', ...bits)
}

async function json(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`cdp http ${res.status} on ${url}`)
  return res.json()
}

function chromeBinCandidates() {
  const fromEnv = process.env.JARVIS_CHROME_PATH
  const list = []
  if (fromEnv) list.push(fromEnv)
  for (const name of ['chrome.exe', 'msedge.exe']) {
    for (const base of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]) {
      if (!base) continue
      list.push(join(base, 'Google', 'Chrome', 'Application', name))
      list.push(join(base, 'Microsoft', 'Edge', 'Application', name))
    }
  }
  return [...new Set(list)]
}

function findChromeBin() {
  return chromeBinCandidates().find((p) => {
    try {
      // Cheap existence probe without importing fs/promises twice.
      return p && require('node:fs').existsSync(p)
    } catch {
      return false
    }
  })
}
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let launched = null

async function launchChrome(debugPort) {
  if (launched && launched.exitCode === null) return launched
  const bin = findChromeBin()
  if (!bin) throw new Error('no Chrome or Edge found — set JARVIS_CHROME_PATH')
  // A dedicated profile keeps the shared debugging port free of the singleton
  // lock a normal Chrome window holds.
  const dir = join(tmpdir(), `jarvis-chrome-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  log('launching', bin)
  launched = spawn(
    bin,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' },
  )
  launched.on('exit', () => {
    launched = null
  })
  return launched
}

async function withChrome(debugPort) {
  let last
  for (let i = 0; i < HTTP_RETRIES; i++) {
    try {
      const v = await json(`http://127.0.0.1:${debugPort}/json/version`)
      if (v?.Browser) return v
    } catch (err) {
      last = err
    }
    if (i === 0) {
      try {
        await launchChrome(debugPort)
      } catch (err) {
        last = err
      }
    }
    await new Promise((r) => setTimeout(r, RETRY_GAP_MS))
  }
  throw new Error(`Chrome did not open a debugging port: ${last?.message ?? 'timed out'}`)
}

/** Chrome may close on its own; the next browser call silently brings it back. */
async function ensureChrome() {
  try {
    const v = await json(`http://127.0.0.1:${CDP_PORT}/json/version`)
    if (v?.Browser) return
  } catch {
    /* not listening — cold or restarted */
  }
  return withChrome(CDP_PORT)
}

// --------------------------------------------------------------------------
// Per-tab CDP session.
// --------------------------------------------------------------------------

class PageSession {
  constructor(targetId) {
    this.targetId = targetId
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.consoleLogs = []
    this.ready = null
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    if (this.ready) return this.ready
    this.ready = (async () => {
      const list = await json(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const target = list.find((t) => t.id === this.targetId && t.type === 'page')
      if (!target?.webSocketDebuggerUrl) throw new Error('No tab available')
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      this.ws = ws
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        } else if (msg.method === 'Runtime.consoleAPICalled') {
          const type = msg.params?.type ?? 'log'
          const textB = msg.params?.args?.map((a) => a.value ?? a.description ?? '').join(' ')
          this.consoleLogs.push(`${type}: ${textB}`)
          if (this.consoleLogs.length > 300) this.consoleLogs.shift()
        }
      })
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      await this.send('Runtime.enable')
      await this.send('Page.enable')
    })()
    try {
      await this.ready
    } finally {
      this.ready = null
    }
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp ${method} timed out`))
      }, 20000)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    // A navigation tears the old execution context down mid-flight; evaluating
    // in that window fails with an opaque "Uncaught". The page settles right
    // after, so one short retry avoids surfacing a hiccup that cures itself.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })
        if (!out.exceptionDetails) return out.result?.value
        const reason = out.exceptionDetails.text ?? ''
        if (attempt === 0 && /uncaught|context/i.test(reason)) {
          await new Promise((r) => setTimeout(r, 350))
          continue
        }
        throw new Error(`page error: ${reason}`)
      } catch (err) {
        if (attempt === 0 && err?.message?.includes('context')) {
          await new Promise((r) => setTimeout(r, 350))
          continue
        }
        throw err
      }
    }
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
  }
}

// --------------------------------------------------------------------------
// Target ⇄ integer id map (chrome.mjs deals in small integers).
// --------------------------------------------------------------------------

const CDP_PORT = Number(process.env.JARVIS_CDP_PORT ?? 9222)
const PAGES = new Map() // intId -> PageSession
let idSeq = 1

async function targetList() {
  return (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).filter((t) => t.type === 'page')
}

async function targets() {
  await ensureChrome()
  return targetList()
}

/**
 * Page targets in tab order, each enriched with its stable integer id and a
 * short origin/title. This is the registry's source of truth; every browser
 * list call ends up here.
 */
async function orderedTabs() {
  const list = await targets()
  const seen = new Set()
  for (const target of list) {
    const existing = [...PAGES.values()].find((s) => s.targetId === target.id)
    if (existing) seen.add(existing.intId)
    else register(target)
  }
  for (const [id, session] of PAGES) {
    if (!list.some((t) => t.id === session.targetId)) session.close()
  }
  return list.map((target) => {
    const session = [...PAGES.values()].find((s) => s.targetId === target.id)
    let origin = ''
    try {
      origin = new URL(target.url).origin
    } catch {
      /* blank / about pages */
    }
    const title = String(target.title ?? '').trim().slice(0, 120)
    return {
      index: list.indexOf(target),
      intId: session?.intId ?? 0,
      targetId: target.id,
      origin,
      url: target.url,
      title,
    }
  })
}

/**
 * Write the current tab picture into SQLite — the browser_tabs registry that
 * voice tab commands and the performance dashboard read. Only facts: a target
 * that exists, its title, its url, its position. No invented "active" flag:
 * is_active only gets set when we actually switched a tab ourselves and know
 * it.
 */
function persistTabs(tabs) {
  const at = nowMs()
  const upsert = db.prepare(
    `INSERT INTO browser_tabs (target_id, title, url, tab_index, last_seen, is_active)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(target_id) DO UPDATE SET
       title = excluded.title, url = excluded.url,
       tab_index = excluded.tab_index, last_seen = excluded.last_seen`,
  )
  const seen = new Set()
  for (const tab of tabs) {
    upsert.run(tab.targetId, tab.title ?? '', tab.url ?? '', tab.index, at)
    seen.add(tab.targetId)
  }
  db.prepare('DELETE FROM browser_tabs WHERE last_seen < ?').run(at)
  return tabs.length
}

/** The registry, refreshed: ordered tabs persisted to SQLite. */
async function refreshTabRegistry() {
  const tabs = await orderedTabs()
  persistTabs(tabs)
  return tabs
}

/**
 * Activate a page target through the *browser* socket (the HTTP /json/list
 * endpoint has no "make this one current" call — that only exists on the
 * Target domain of the browser-level websocket).
 */
async function activateTarget(targetId) {
  const version = await json(`http://127.0.0.1:${CDP_PORT}/json/version`)
  if (!version?.webSocketDebuggerUrl) throw new Error('No browser websocket available')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const reply = await new Promise((resolve, reject) => {
    const id = 1
    const timer = setTimeout(() => reject(new Error('cdp activate timed out')), 10000)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    ws.send(JSON.stringify({ id, method: 'Target.activateTarget', params: { targetId } }))
  })
  ws.close()
  return reply
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null && `${tabId}`.trim() !== '') {
    const session = PAGES.get(Number(tabId))
    if (session) return session
  }
  const list = await targets()
  if (!list.length) throw new Error('No tab available')
  // Prefer the most recently active page.
  const target = lastActiveTarget !== null ? (list.find((t) => t.id === lastActiveTarget) ?? list[list.length - 1]) : list[list.length - 1]
  let session = [...PAGES.values()].find((s) => s.targetId === target.id)
  if (!session) session = register(target)
  lastActiveTarget = session.targetId
  return session
}

function register(target) {
  const session = new PageSession(target.id)
  const intId = idSeq++
  PAGES.set(intId, session)
  session.intId = intId
  return session
}

/** The tab JARVIS most recently brought forward, so next/previous have a base. */
let lastActiveTarget = null

async function tabList() {
  const list = await orderedTabs()
  persistTabs(list)
  return { availableTabs: list.map((t) => ({ tabId: t.intId, origin: t.origin, url: t.url })) }
}

// --------------------------------------------------------------------------
// Tool implementations → MCP-shaped results.
// --------------------------------------------------------------------------

function textResult(text, isError) {
  return isError
    ? { error: { content: [{ type: 'text', text }] } }
    : { result: { content: [{ type: 'text', text }] } }
}

const REF_SNIPPET = `(() => {
  const sel = 'a[href],button,input,select,textarea,[role="button"],[role="checkbox"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable]';
  const els = [...document.querySelectorAll(sel)];
  const seen = new Set();
  const refs = [];
  for (const el of els) {
    if (seen.has(el)) continue;
    seen.add(el);
    let name = (el.getAttribute('aria-label') || el.title || ((el.innerText || '').trim()) || el.value || '').toString().trim().slice(0, 80);
    refs.push({ ref: 'ref_' + refs.length, tag: el.tagName.toLowerCase(), name, target: el.getAttribute('href') || '' });
  }
  return JSON.stringify({ url: location.href, refs });
})()`

async function refsOf(session) {
  const raw = await session.evaluate(REF_SNIPPET)
  try {
    return JSON.parse(raw)
  } catch {
    return { url: '', refs: [] }
  }
}

async function readPage(session, filter) {
  const page = await refsOf(session)
  const refs = filter === 'interactive' ? page.refs : page.refs
  const lines = [`URL: ${page.url}`, `${refs.length} interactive elements`]
  for (const r of refs) {
    lines.push(`[${r.ref}] ${r.tag}${r.target ? ` › ${r.target}` : ''}${r.name ? ` — ${r.name}` : ''}`)
  }
  return textResult(lines.join('\n'))
}

async function toolsContext(args) {
  const list = await tabList()
  return {
    result: {
      content: [
        { type: 'text', text: JSON.stringify(list) },
        { type: 'text', text: list.availableTabs.length ? list.availableTabs.map((t) => `Tab ${t.tabId} · ${t.origin} · ${t.url}`).join('\n') : 'No tabs.' },
      ],
    },
  }
}

async function navigate(args, session) {
  const url = String(args.url ?? '').trim()
  if (!url) return textResult('Nothing to navigate to.')
  if (url === 'back') {
    await session.evaluate('history.back()')
    return textResult('went back.')
  }
  if (url === 'forward') {
    await session.evaluate('history.forward()')
    return textResult('went forward.')
  }
  if (url === 'reload') {
    // location.reload() is the honest reload: it re-fetches the document the
    // tab is actually on, unlike a history hop that merely looks like one.
    await session.evaluate('location.reload()')
    return textResult('reloaded.')
  }
  const match = /^(https?|about|data):/i.exec(url)
  if (!match) return textResult('Only absolute http(s) URLs — or back / forward / reload.')
  await session.send('Page.navigate', { url })
  return textResult(`opening ${url}`)
}

async function getPageText(args, session) {
  const cap = Math.max(200, Number(args.max_chars ?? 4000) || 4000)
  const raw = await session.evaluate(
    `JSON.stringify({ url: location.href, text: (document.body ? document.body.innerText : document.documentElement.innerText) || '' })`,
  )
  let parsed = { url: '', text: '' }
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* fall back to empty */
  }
  const text = parsed.text.slice(0, cap)
  return textResult(`URL: ${parsed.url}\n${text}`)
}

async function findInPage(args, session) {
  const query = String(args.query ?? '').toLowerCase()
  if (!query) return textResult('Nothing to find.', true)
  const page = await refsOf(session)
  const refs = page.refs.filter(
    (r) => r.name.toLowerCase().includes(query) || r.target.toLowerCase().includes(query),
  )
  if (!refs.length) return textResult(`Could not find "${args.query}" on the page.`, true)
  const r = refs[0]
  return textResult(`[${r.ref}] ${r.tag} — ${r.name}${r.target ? ` (${r.target})` : ''}`)
}

async function formInput(args, session) {
  const ref = String(args.ref ?? '')
  const value = args.value
  const idx = Number(ref.replace('ref_', ''))
  const ok = await session.evaluate(
    `(() => { const els = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="checkbox"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable]')]; const el = els[${Number.isFinite(idx) ? idx : -1}]; if (!el || !('value' in el)) return false; el.value = ${JSON.stringify(`${value}`)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
  )
  return ok ? textResult(`set ${ref} to "${value}".`) : textResult('field not found.', true)
}

async function clickRef(session, ref) {
  const idx = Number((ref || '').replace('ref_', ''))
  if (!Number.isFinite(idx)) return false
  return session.evaluate(
    `(() => { const els = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="checkbox"],[role="menuitem"],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable]')]; const el = els[${idx}]; if (!el) return false; el.click(); return true; })()`,
  )
}

async function computer(args, session) {
  const action = args.action
  if (action === 'screenshot') {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' })
    return {
      result: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: shot.data },
          },
        ],
      },
    }
  }
  if (action === 'scroll') {
    const dir = args.scroll_direction ?? 'down'
    const amount = Number(args.scroll_amount ?? 3) * 300
    const dx = dir === 'right' ? amount : dir === 'left' ? -amount : 0
    const dy = dir === 'down' ? amount : dir === 'up' ? -amount : 0
    await session.evaluate(`window.scrollBy(${dx}, ${dy})`)
    return textResult(`scrolled ${dir}.`)
  }
  if (action === 'left_click') {
    if (args.ref && (await clickRef(session, args.ref))) return textResult(`clicked ${args.ref}.`)
    if (Array.isArray(args.coordinate) && args.coordinate.length >= 2) {
      const [x, y] = args.coordinate.map(Number)
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      return textResult(`clicked (${x}, ${y}).`)
    }
    return textResult('No ref or coordinate to click.', true)
  }
  if (action === 'type') {
    await session.evaluate(`(() => { const el = document.activeElement; if (!el) return false; const v = el.value || ''; el.value = v + ${JSON.stringify(String(args.text ?? ''))}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`)
    return textResult('typed.')
  }
  if (action === 'key') {
    const key = String(args.text ?? '')
    const parts = String(args.text ?? '')
      .toLowerCase()
      .split('+')
      .map((s) => s.trim())
    const modifiers = {
      Control: parts.includes('ctrl') || parts.includes('control'),
      Meta: parts.includes('meta') || parts.includes('cmd'),
      Alt: parts.includes('alt'),
      Shift: parts.includes('shift'),
    }
    const nameParts = ['Control', 'Meta', 'Alt', 'Shift'].filter((m) => modifiers[m])
    const keyName = parts
      .filter((p) => !['ctrl', 'control', 'meta', 'cmd', 'alt', 'shift'].includes(p))
      .pop()?.[0]
      .toUpperCase() + (parts.filter((p) => !['ctrl', 'control', 'meta', 'cmd', 'alt', 'shift'].includes(p)).pop()?.slice(1) ?? '')
    const text = String(key)
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: text,
      text: /[a-z]$/i.test(text) && !modifiers.Control && !modifiers.Meta && !modifiers.Alt ? text : undefined,
      modifiers: (modifiers.Control ? 2 : 0) | (modifiers.Meta ? 4 : 0) | (modifiers.Alt ? 1 : 0) | (modifiers.Shift ? 8 : 0),
    })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: text, modifiers: 0 })
    return textResult(`pressed ${key}.`)
  }
  return textResult('Unknown computer action.', true)
}

async function moveTab(forward) {
  const tabs = await orderedTabs()
  if (!tabs.length) return textResult('No tab available.', true)
  const base = lastActiveTarget ?? tabs[tabs.length - 1].targetId
  let i = tabs.findIndex((t) => t.targetId === base)
  if (i === -1) i = tabs.length - 1
  const next = tabs[forward ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length]
  await activateTarget(next.targetId)
  lastActiveTarget = next.targetId
  db.prepare('UPDATE browser_tabs SET is_active = 0').run()
  db.prepare('UPDATE browser_tabs SET is_active = 1 WHERE target_id = ?').run(next.targetId)
  return textResult(next.title || next.origin ? `now on ${next.title || next.origin}.` : `now on tab ${next.index + 1}.`)
}

const TOOLS = {
  tabs_context_mcp: toolsContext,
  /** Switch to a specific tab by its integer id, or by 1-based position. */
  tabs_activate_mcp: async (args) => {
    const tabs = await orderedTabs()
    if (!tabs.length) return textResult('No tab available.', true)
    let targetId = null
    if (args?.tabId !== undefined && args?.tabId !== null && `${args.tabId}`.trim() !== '') {
      const session = PAGES.get(Number(args.tabId))
      if (session) targetId = session.targetId
    }
    if (!targetId && Number.isFinite(Number(args?.index))) {
      const i = Number(args.index) - 1
      if (tabs[i]) targetId = tabs[i].targetId
    }
    if (!targetId) return textResult('No tab by that number.', true)
    await activateTarget(targetId)
    lastActiveTarget = targetId
    db.prepare('UPDATE browser_tabs SET is_active = 0').run()
    db.prepare('UPDATE browser_tabs SET is_active = 1 WHERE target_id = ?').run(targetId)
    const tab = tabs.find((t) => t.targetId === targetId)
    return textResult(tab ? `on ${tab.title || tab.origin || `tab ${tab.index + 1}`}.` : 'Switched.')
  },
  tabs_next_mcp: async () => moveTab(true),
  tabs_previous_mcp: async () => moveTab(false),
  navigate,
  get_page_text: getPageText,
  read_page: (args, s) => readPage(s, args.filter),
  find: findInPage,
  form_input: formInput,
  computer,
  tabs_create_mcp: async () => {
    // Every other tab operation recovers the (dedicated, dedicated-profile)
    // control browser through ensureChrome when it is gone — closing the last
    // tab exits Chrome entirely. Creating a tab is no different; without this
    // recovery the very first "new tab" after the last close throws fetch
    // failed while navigation happily brings the browser back.
    await ensureChrome()
    const res = await json(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    const session = new PageSession(res.id)
    const intId = idSeq++
    PAGES.set(intId, session)
    session.intId = intId
    return toolsContext({})
  },
  tabs_close_mcp: async (args) => {
    const session = await (args?.tabId ? resolveTab(args.tabId) : null)
    if (session) {
      await json(`http://127.0.0.1:${CDP_PORT}/json/close/${session.targetId}`).catch(() => {})
      session.close()
      PAGES.delete(session.intId)
      return textResult(`closed tab ${session.intId}.`)
    }
    return textResult('No tab available.', true)
  },
  read_console_messages: async (args, s) => {
    await s.connect()
    let logs = s.consoleLogs
    if (args?.onlyErrors) logs = logs.filter((l) => l.startsWith('error'))
    const cap = Math.max(1, Number(args?.limit ?? 50) || 50)
    return textResult(logs.slice(-cap).join('\n') || 'No console output.')
  },
  read_network_requests: async (args) => {
    const cap = Math.max(1, Number(args?.limit ?? 30) || 30)
    const raw = await args._s.evaluate(
      `JSON.stringify(performance.getEntriesByType('resource').map((e) => ({ url: e.name, ms: Math.round(e.duration), bytes: e.transferSize || null })).slice(-${cap}))`,
    )
    let entries = []
    try {
      entries = JSON.parse(raw)
    } catch {
      /* empty */
    }
    if (args?.urlPattern) {
      entries = entries.filter((e) => e.url.includes(args.urlPattern))
    }
    if (args?.requestId) {
      const hit = entries.find((e) => e.url.includes(args.requestId))
      if (hit) entries = [hit]
    }
    return textResult(entries.map((e) => `${e.url} — ${e.ms}ms${e.bytes ? ` · ${e.bytes}b` : ''}`).join('\n') || 'No network entries.')
  },
}

async function runTool(tool, args) {
  const fn = TOOLS[tool]
  if (!fn) return textResult(`Unknown tool ${tool}.`, true)
  let session = null
  try {
    if (['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp'].includes(tool)) {
      return await fn(args ?? {})
    }
    session = await resolveTab(args?.tabId)
    await session.connect()
    // Wire network calls to the live session through a hidden carrier key.
    return await fn({ ...(args ?? {}), _s: session }, session)
  } catch (err) {
    return textResult(String(err?.message ?? err), true)
  }
}

// --------------------------------------------------------------------------
// The adapter's TCP server (the wire protocol chrome.mjs expects).
// --------------------------------------------------------------------------

function handleConnection(socket) {
  let buf = Buffer.alloc(0)
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length, 0)
    socket.write(Buffer.concat([header, body]))
  }
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 4) return
      const length = buf.readUInt32LE(0)
      if (length > 64 * 1024 * 1024) return socket.destroy()
      if (buf.length < 4 + length) return
      const body = buf.subarray(4, 4 + length).toString('utf8')
      buf = buf.subarray(4 + length)
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      const tool = msg?.params?.tool
      const args = msg?.params?.args
      const reply = (value) => (msg?.id !== undefined ? { id: msg.id, ...value } : value)
      runTool(tool, args)
        .then((out) => send(reply(out)))
        .catch((err) => send(reply(textResult(String(err?.message ?? err), true))))
    }
  })
  socket.on('error', () => socket.destroy())
}

/**
 * Last-known tab picture for /systems and the performance dashboard. Read
 * only, never touches the browser — this is "as last seen", and says so.
 */
export function chromeTabSnapshot() {
  return many(
    'SELECT target_id, title, url, tab_index, is_active, last_seen FROM browser_tabs ORDER BY tab_index',
  )
}

/**
 * Bring up Chrome (or attach to one already debugging) and start accepting the
 * bridge's browser calls on 127.0.0.1:<port>.
 */
export async function startChromeAdapter(port = Number(process.env.JARVIS_CHROME_PORT ?? 9333)) {
  await withChrome(CDP_PORT)
  const server = createServer(handleConnection)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  log(`adapter listening on tcp 127.0.0.1:${port} · cdp :${CDP_PORT}`)
  return { port }
}