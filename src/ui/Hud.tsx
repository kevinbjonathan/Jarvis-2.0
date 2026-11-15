import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Phase } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'

const statusText: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: 'STANDBY — SAY “HEY JARVIS”',
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'RESPONDING',
}

function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <div className={`corner corner-${at}`} />
}

/* ------------------------------------------------------------------ decode */

/**
 * The glyphs the ghost is drawn from. Uppercase, digits and rules only: the
 * point is that the unresolved text reads as *machine*, so lowercase letters
 * and anything with a descender are left out — they look like badly rendered
 * words rather than an unfinished decode.
 */
const GLYPHS = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Characters of noise shown ahead of the resolved text. */
const GHOST = 22
/** Repaint interval for the scramble. ~24fps is plenty for glyph noise. */
const FRAME_MS = 42
/** Floor on the resolve rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

function scramble(s: string, seed: number) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Whitespace is left alone so word shapes and line breaks hold still while
    // the glyphs underneath churn.
    if (c === ' ' || c === '\n' || c === '\t') {
      out += c
      continue
    }
    out += GLYPHS[(seed * 7919 + i * 104729 + c.charCodeAt(0)) % GLYPHS.length]
  }
  return out
}

/**
 * JARVIS's lines, arriving the way a computer would produce them.
 *
 * The hard part is not the effect, it is that the text underneath is *live*.
 * The store appends a token at a time, so this component re-renders dozens of
 * times a second with a slightly longer string, and the naive implementation —
 * scramble the whole thing, resolve it over N milliseconds — restarts the
 * animation on every token and never finishes decoding anything.
 *
 * So the frontier is a ref and only ever moves forward. Everything behind it
 * has settled and is plain text that will never animate again; a short window
 * ahead of it is noise; the rest is present in the DOM but invisible, which
 * keeps the line wrapping identical to the finished paragraph and means the
 * accessibility tree always holds the real sentence. The rate scales with how
 * far behind the frontier has fallen, so a single token drips and a 300
 * character burst clears inside MAX_LAG_MS — the decode must never be the
 * reason the transcript trails the voice.
 *
 * The rAF loop repaints on a 42ms gate rather than every frame, and stops dead
 * the moment the frontier catches up.
 */
function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)

  useEffect(() => {
    // The running loop reads the length through this ref rather than through
    // its own closure, so a token landing mid-sweep simply extends the target
    // instead of leaving the loop chasing a length that is already stale.
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 120) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="decode-ghost">{scramble(text.slice(n, n + GHOST), tick)}</span>
      <span className="decode-veil">{text.slice(n + GHOST)}</span>
    </>
  )
}

/* ------------------------------------------------------------------- rail */

/** The live snapshot the bridge exposes at GET /systems (bridgeStatus). */
type SystemsStatus = {
  pid: number
  uptime_s: number
  model: string
  writes: boolean
  browser: boolean
  mediapipe: boolean
  hud: string[]
  mcp: string[]
  tabs: { title: string; url: string; index: number; active: boolean }[]
  google: {
    configured: boolean
    connected: boolean
    scopes: string[]
    connectedAt: string | null
  } | null
  recent: {
    command: string
    intent: string
    speech_ms: number
    routing_ms: number
    mcp_ms: number
    browser_ms: number
    ai_ms: number
    tts_ms: number
    total_ms: number
    success: number
    created_at: number
  }[]
}

/** One row: dot, label on the left, value on the right. `state` tints the dot. */
function StatusRow({
  label,
  value,
  state,
}: {
  label: string
  value: string
  state: 'ok' | 'alt' | 'down' | 'idle'
}) {
  return (
    <div className="rail-row">
      <span className={`do do-${state}`} />
      <span className="rail-label">{label}</span>
      <span className="rail-value">{value}</span>
    </div>
  )
}

function RailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rail-group">
      <div className="rail-title">{title}</div>
      {children}
    </div>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const mic = useStore((s) => s.mic)
  const voiceInfo = useStore((s) => s.voiceInfo)
  const error = useStore((s) => s.error)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const ui = useStore((s) => s.ui)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)

  // The SYSTEMS rail is fed by GET /systems, polled so tab counts, Gmail and
  // the performance averages stay live. A failed poll keeps the last good
  // picture on screen rather than flashing the panel away.
  const [status, setStatus] = useState<SystemsStatus | null>(null)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/systems`, {
          signal: AbortSignal.timeout(3500),
        })
        if (!res.ok || !alive) return
        setStatus((await res.json()) as SystemsStatus)
      } catch {
        // Bridge down or mid-boot — keep the previous snapshot.
      }
    }
    void tick()
    // Stage H Batch A: widened from 5 s — /systems is status info, not real-time data
    const id = setInterval(tick, 10000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

// Derived dashboard metrics — averages over successfully recorded commands.
  const perfRows = (status?.recent ?? []).filter((p) => p.success === 1)
  const mean = (ns: number[]) =>
    ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null
  const fmtMs = (ms: number | null) => (ms === null ? '--' : `${(ms / 1000).toFixed(2)}s`)
  const avgTotal = mean(perfRows.map((p) => p.total_ms))
  const fastest = perfRows.length
    ? Math.min(...perfRows.map((p) => p.total_ms))
    : null
  const slowest = perfRows.length
    ? Math.max(...perfRows.map((p) => p.total_ms))
    : null
  const avoided = perfRows.filter((p) => p.intent !== 'brain').length
  const avgWeather = mean(
    perfRows
      .filter((p) => p.intent === 'router' && /weather/i.test(p.command))
      .map((p) => p.total_ms),
  )
  const avgBrowser = mean(perfRows.filter((p) => p.browser_ms > 0).map((p) => p.browser_ms))
  const avgMcp = mean(perfRows.filter((p) => p.mcp_ms > 0).map((p) => p.mcp_ms))
  const avgSpeech = mean(perfRows.filter((p) => p.speech_ms > 0).map((p) => p.speech_ms))
  const avgTts = mean(perfRows.filter((p) => p.tts_ms > 0).map((p) => p.tts_ms))
  const avgAi = mean(perfRows.filter((p) => p.ai_ms > 0).map((p) => p.ai_ms))

  const hasWin = (k: 'SpeechRecognition' | 'webkitSpeechRecognition') =>
    typeof window !== 'undefined' &&
    Boolean((window as unknown as Record<string, unknown>)[k])
  const speechRecognitionAvailable =
    hasWin('SpeechRecognition') || hasWin('webkitSpeechRecognition')
  const cameraAvailable = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  return (
    <div className="hud" style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

      <header className="hud-top">
        {ui.chrome.brand && (
          <div className="brand">
            <span className="brand-mark">J.A.R.V.I.S.</span>
            <span className="brand-sub">Just A Rather Very Intelligent System</span>
          </div>
        )}

        <div className="status">
          <span className="dot" />
          <span className="status-text">
            {/* bootNote is the voice-model download readout. It is only ever
                the right thing to show during boot — as a general fallback a
                note that never got cleared (a stuck 'voice 97%') sits over
                LISTENING and PROCESSING for the rest of the session. */}
            {phase === 'boot' && bootNote ? bootNote : statusText[phase]}
          </span>
        </div>
      </header>

      {/* Left rail: what is actually functioning, grouped by subsystem */}
      {ui.chrome.systems && (
        <aside className="rail rail-left">
          <div className="rail-title">SYSTEMS</div>

          <RailGroup title="CORE">
            <StatusRow
              label="Bridge"
              value={status?.pid ? 'ONLINE' : '--'}
              state={status?.pid ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Database"
              value={status ? 'ONLINE' : '--'}
              state={status ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Big Pickle"
              value={status ? 'READY' : '--'}
              state={status ? 'ok' : 'idle'}
            />
          </RailGroup>

          <RailGroup title="BROWSER">
            <StatusRow
              label="Chrome"
              value={status ? (status.browser ? 'ONLINE' : 'OFF') : '--'}
              state={status ? (status.browser ? 'ok' : 'down') : 'idle'}
            />
            <StatusRow
              label="CDP"
              value={status ? (status.browser ? 'ONLINE' : 'OFF') : '--'}
              state={status ? (status.browser ? 'ok' : 'down') : 'idle'}
            />
            <StatusRow label="Tabs" value={status ? String(status.tabs.length) : '--'} state="ok" />
          </RailGroup>

          <RailGroup title="MCP">
            <StatusRow
              label="Gmail"
              value={status?.google ? (status.google.connected ? 'CONNECTED' : status.google.configured ? 'PAUSED' : 'NOT SET') : '--'}
              state={status?.google ? (status.google.connected ? 'ok' : status.google.configured ? 'alt' : 'idle') : 'idle'}
            />
            <StatusRow
              label="Calendar"
              value={status?.google ? (status.google.connected ? 'CONNECTED' : status.google.configured ? 'PAUSED' : 'NOT SET') : '--'}
              state={status?.google ? (status.google.connected ? 'ok' : status.google.configured ? 'alt' : 'idle') : 'idle'}
            />
            <StatusRow
              label="Notifications"
              value={status ? (status.hud.includes('jarvis_notify') ? 'ONLINE' : 'OFF') : '--'}
              state={status?.hud.includes('jarvis_notify') ? 'ok' : 'down'}
            />
            <StatusRow
              label="Preferences"
              value={status ? (status.hud.includes('jarvis_prefs') ? 'ONLINE' : 'OFF') : '--'}
              state={status?.hud.includes('jarvis_prefs') ? 'ok' : 'down'}
            />
          </RailGroup>

          <RailGroup title="VOICE">
            <StatusRow
              label="Microphone"
              value={mic ? 'READY' : 'STANDBY'}
              state={mic ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Speech Recognition"
              value={speechRecognitionAvailable ? 'READY' : 'UNAVAILABLE'}
              state={speechRecognitionAvailable ? 'ok' : 'down'}
            />
            <StatusRow
              label="Jarvis Voice"
              value={voiceInfo.engine ? 'READY' : 'STANDBY'}
              state={voiceInfo.engine ? 'ok' : 'idle'}
            />
          </RailGroup>

          <RailGroup title="VISION">
            <StatusRow
              label="Camera"
              value={cameraAvailable ? 'READY' : 'STANDBY'}
              state={cameraAvailable ? 'ok' : 'idle'}
            />
            <StatusRow
              label="Hand Tracking"
              value={gestures ? 'READY' : 'STANDBY'}
              state={gestures ? 'ok' : 'idle'}
            />
          </RailGroup>

          <RailGroup title="PERFORMANCE">
            <StatusRow label="Average Response" value={fmtMs(avgTotal)} state="ok" />
            <StatusRow label="Fastest" value={fmtMs(fastest)} state="ok" />
            <StatusRow label="Slowest" value={fmtMs(slowest)} state="alt" />
            <StatusRow
              label="AI-Avoided"
              value={String(avoided)}
              state={avoided ? 'ok' : 'idle'}
            />
            <StatusRow label="Weather" value={fmtMs(avgWeather)} state="ok" />
            <StatusRow label="Browser" value={fmtMs(avgBrowser)} state="ok" />
            <StatusRow label="MCP" value={fmtMs(avgMcp)} state="ok" />
            <StatusRow label="Speech" value={fmtMs(avgSpeech)} state="ok" />
            <StatusRow label="TTS" value={fmtMs(avgTts)} state="ok" />
            <StatusRow label="AI" value={fmtMs(avgAi)} state="ok" />
          </RailGroup>
        </aside>
      )}

      {/* Right rail: live telemetry, mostly for flavour */}
      <aside className="rail rail-right">
        <div className="rail-title">SIGNAL</div>
        <div className="meter">
          <div className="meter-fill" style={{ height: `${level * 100}%` }} />
        </div>
        <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div>
      </aside>

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && (
          <motion.div
            className="tool-badge"
            // Anchored to the TOP of the frame, not the middle. The old home was
            // viewport-centre plus a fixed drop, which on a tall or square
            // window landed the headline straight on top of the bottom
            // transcript — two elements pinned to different edges of the screen
            // were always going to meet somewhere. Up here it sits in its own
            // band with the rest of the status chrome and can never collide with
            // the log. Framer owns `transform` on an animated element, so the
            // centring (x: -50%) lives in these props, not the stylesheet.
            initial={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          >
            <span className="tool-kicker">
              <span className="spinner" />
              accessing
            </span>
            <span className="tool-name">{activeTool.replace(/[_-]/g, ' ')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Conversation log — last few turns, fading upward */}
      {ui.chrome.transcript && (
        <div className="log">
          <AnimatePresence initial={false}>
            {turns.slice(-4).map((t) => (
              <motion.div
                key={t.id}
                className={`log-line log-${t.role}`}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              >
                <span className="log-who">{t.role === 'user' ? 'YOU' : 'JARVIS'}</span>
                {/* Only his half decodes. What the user said was never
                    transmitted from anywhere — dressing it up as machine
                    output would be a lie about where the words came from. */}
                <span className="log-text">
                  {t.role === 'jarvis' ? <DecodeText text={t.text} /> : t.text}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {caption && (
          <motion.div
            className="caption"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {caption}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {ui.chrome.suggestions && <Suggestions />}

      {error && <div className="error">{error}</div>}

      <footer className="hud-bottom">
        <span className="hint">
          say <b>“hey jarvis”</b> · <kbd>Space</kbd> to talk · <kbd>G</kbd> hands
          {voice && (
            <>
              {' · '}
              <kbd>V</kbd> voice: {voice.replace(/\(.*?\)/g, '').trim()}
            </>
          )}
        </span>
      </footer>

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live">
          {looking ? `LOOKING — ${looking.toUpperCase()}` : 'CAMERA ON · G TO STOP'}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}
