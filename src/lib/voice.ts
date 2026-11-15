import { BRIDGE_HTTP_URL } from '../config'
import { getMic } from './audio'
import { speakingNow, speakingSince } from './tts'
import { startVad, type Vad } from './vad'
import { caps } from './capabilities'

/**
 * The voice loop.
 *
 * One recogniser, running for the life of the page. It is never torn down for
 * a turn, and that single fact is most of what separates this from a kiosk:
 * the microphone is still open while JARVIS is talking, so you can cut him off
 * the way you would cut off a person.
 *
 * The obvious design — one recogniser hunting for the wake word, a second one
 * capturing the command, stopping the first to start the second because the
 * browser only hands out one at a time — is what this replaces. It works, but
 * nothing is listening during an answer, so barge-in is impossible, and every
 * restart leaves a quarter-second of deafness that eats whole wake words.
 *
 * Keeping the mic open costs one thing: JARVIS hears himself through the
 * speakers. That is handled here in text rather than in acoustics — see
 * `isEcho` — because the browser gives SpeechRecognition its own capture and
 * won't let us put a canceller in front of it.
 */

export type VoiceMode =
  /** Powered down. Only his name matters. */
  | 'wake'
  /** He is expecting you to speak. Everything is a command. */
  | 'command'
  /** He is thinking or talking. Anything you say is an interruption. */
  | 'guard'
  /** Something is playing that must not be transcribed at all. */
  | 'deaf'

export type VoiceHandlers = {
  /** Read fresh on every result, so the app never has to re-subscribe. */
  mode: () => VoiceMode
  /** Fired on his name, from a partial — waiting for endpointing feels slow.
   *  `trailing` is whatever followed it, so "Jarvis, what's the weather" is
   *  one breath rather than two turns. */
  onWake: (trailing: string) => void
  /** The user has genuinely started talking. This is the barge-in trigger. */
  onSpeechStart: () => void
  /** Live transcript, for the caption under the reactor. */
  onPartial: (text: string) => void
  /** A complete, endpointed utterance. */
  onUtterance: (text: string) => void
  /** The recogniser is unusable. Distinct from the user saying nothing. */
  onError: (message: string) => void
}

export type Voice = {
  stop: () => void
  /** True while a recogniser is actually running. */
  live: () => boolean
}

// ---------------------------------------------------------------------------
// Endpointing
// ---------------------------------------------------------------------------

/** One utterance often produces several partials containing his name. */
const WAKE_DEBOUNCE = 1500

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
const WAKE =
  /\b(?:hey|hi|ok|okay|yo)?\s*(?:jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)\b(?!'s)/i

/** Everything after the wake phrase, which is usually the actual command. */
function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Assembling one utterance out of several segments
// ---------------------------------------------------------------------------

/**
 * Why this exists.
 *
 * The voice-activity detector is an energy gate, and energy is a fact about the
 * room rather than about the sentence. It ends a segment after a fixed quiet
 * gap, so "what's the weather in — " *pause* " — London" is two segments, two
 * transcripts and, before this, two turns: the first one asking the model a
 * truncated question, the second arriving as a bare noun with no question left
 * to attach it to. People pause. They pause to think of the word, to look at
 * something, mid-list, before the important part. An assistant that treats the
 * first gap as the end of the thought is one you have to talk to carefully, and
 * having to talk carefully is the whole failure.
 *
 * So the segment is no longer the turn. Transcripts accumulate here, and the
 * turn fires only when the text looks finished AND the room has gone quiet.
 *
 * Crucially this costs nothing in the common case. A complete sentence with no
 * one speaking fires immediately — `holdFor` returns 0 — so the latency of an
 * ordinary question is exactly what it was. The waiting only happens when there
 * is a reason to wait.
 */

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/

/**
 * Openers that are complete as soon as they scan.
 *
 * The default instinct for a two-word phrase is "keep listening" — a pause
 * after "what's the weather" usually means another clause is coming — but the
 * fast command router's shapes ("open gmail", "go back", "is it raining")
 * are a closed, whole-sentence list. Making the assembler hold those for the
 * continuation nobody is coming with turns every quick command into a second
 * and a half of dead air. Fire them the moment they arrive; the router's own
 * strictness still decides whether the words actually were a command.
 */
const EAGER =
  /^(?:please\s+)?(?:open\b|go to\b|go back\b|go forward\b|new tab\b|next tab\b|previous tab\b|refresh\b|reload\b|close\b|check\b|whats the weather\b|what is the weather\b|how is the weather\b|is it raining\b|will it rain\b|whats the time\b|what is the time\b|weather\b|time\b|date\b|stop\b|sleep\b|remind me\b)/i

/**
 * A barge-in this soon after he starts a sentence is him, not you.
 *
 * Echo cancellation and the raised guard threshold stop most of his playback
 * reaching the detector, but the attack of the very first syllable is the
 * loudest, least-cancelled thing in the whole answer — it arrives before the
 * canceller has adapted to it. Without this, a long answer could interrupt
 * itself on its own first word, which reads as JARVIS refusing to speak.
 *
 * Kept short deliberately. This is the one window where a genuine interruption
 * is also least likely: the user has not yet heard enough to want to stop him.
 */
const SELF_GUARD_MS = 350

/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (CONTINUES.test(words[words.length - 1])) return CONTINUE_MS
  // A router-shaped command is complete on arrival. See EAGER.
  if (EAGER.test(text)) return 0
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !OVERRIDE.test(text)) return CONTINUE_MS
  return SETTLE_MS
}

type Assembler = {
  /** Add a transcript. `active` is true if the user is audibly still going. */
  feed: (text: string, active: boolean) => void
  /** Send whatever is held right now, if anything. */
  flush: () => void
  /** Throw away whatever is held — used when he stands down. */
  cancel: () => void
  held: () => string
}

function makeAssembler(h: {
  emit: (text: string) => void
  partial: (text: string) => void
}): Assembler {
  let held = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0

  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const fire = () => {
    clear()
    const text = held.trim()
    held = ''
    firstAt = 0
    if (text) h.emit(text)
  }

  return {
    feed(text, active) {
      if (!text.trim()) return
      held = `${held} ${text}`.replace(/\s+/g, ' ').trim()
      if (!firstAt) firstAt = Date.now()
      // The caption shows the whole thought as it assembles, not just the
      // fragment that happened to arrive last.
      h.partial(held)
      diag.holding = held
      clear()

      // Already talking again. Decide nothing now — the next transcript is
      // part of this same sentence and will bring more of it.
      if (active) {
        timer = setTimeout(fire, MAX_HOLD_MS)
        return
      }

      const wait = Math.min(
        holdFor(held),
        Math.max(0, MAX_HOLD_MS - (Date.now() - firstAt)),
      )
      diag.waitedMs = wait
      if (wait === 0) {
        fire()
        return
      }
      timer = setTimeout(fire, wait)
    },
    flush: fire,
    cancel() {
      clear()
      held = ''
      firstAt = 0
      diag.holding = ''
    },
    held: () => held,
  }
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (OVERRIDE.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Live state of the voice loop, published on `window.__voice`.
 *
 * When someone says the wake word and nothing happens there are only a handful
 * of possible causes — the recogniser never started, it started and died, it is
 * running but hearing silence, or it is hearing you and transcribing the name
 * as something else. From outside the page those are indistinguishable, which
 * makes the failure impossible to report and impossible to fix. This tells them
 * apart in one glance.
 */
export const diag = {
  /** Which input engine is running: 'elevenlabs' (VAD+Scribe) or 'browser'. */
  engine: 'browser',
  /** The locale currently handed to the recogniser ("en-IN (local)"), for
   *  diagnosing "it insists on English accents" complaints. */
  lang: '',
  /** Whether the microphone pipeline is live. */
  running: false,
  /** Speech segments captured since load. */
  sessions: 0,
  /** The most recent transcript, whatever the mode. */
  heard: '',
  heardAt: 0,
  /** Last failure — a transcription error, or a capture error. */
  lastError: '',
  /** Times the wake word matched. */
  wakes: 0,
  /** Current mode, as the app last reported it. */
  mode: '',
  /** Why the last transcript was ignored — '' when it was accepted. */
  dropped: '',
  /** Transcripts accepted and passed to the app. */
  accepted: 0,
  /** Text assembled but not yet sent, because the thought looks unfinished. */
  holding: '',
  /** How long the assembler decided to wait before sending, in ms. */
  waitedMs: 0,
  /** Barge-ins suppressed because he had only just started the sentence. */
  selfGuarded: 0,
  /** Transcription failures (network, or the bridge speech proxy). */
  restarts: 0,
  /** Milliseconds the last transcription round-trip took. */
  idleMs: 0,
  /** On-device recognition status: 'available' | 'downloadable' |
   *  'unavailable' | '' (this browser has no such API). Read from
   *  SpeechRecognition.available() when it exists. */
  onDevice: '',
  /** The connection as the voice loop last saw it: online / offline /
   *  degraded (cloud recognition failing while the page is online). */
  network: 'online',
  /** Milliseconds until the next recognition attempt, when backing off a
   *  network failure. 0 means nothing is being held. */
  nextRetry: 0,
  /** Direct-command mode: while dormant, anything heard is a command, not
   *  just his name. The app toggles this and persists it as a preference. */
  direct: false,
}

/**
 * Turn direct-command mode on or off. The app owns the preference; this just
 * keeps the diagnostics panel honest about which mode the recogniser is in.
 */
export function setDirectMode(on: boolean): void {
  diag.direct = on
}

/** Record why a transcript went nowhere. Silence always has a reason; this is
 *  the difference between debugging it and speculating about it. */
function drop(why: string) {
  diag.dropped = why
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__voice = diag
}

/**
 * Pick the voice engine and start it.
 *
 * Two engines, chosen by what the bridge reported at boot (see capabilities.ts):
 *   - ElevenLabs available -> local voice-activity detection for instant
 *     barge-in, and ElevenLabs Scribe for the words. The reliable path.
 *   - nothing configured -> the browser's own SpeechRecognition, so a student
 *     with no keys still has a working assistant. Less robust, but free and
 *     zero-setup, and guarded by a heartbeat so its silent death is recovered.
 *
 * The microphone is opened once here so a denied permission is reported loudly
 * rather than surfacing later as an unexplained deafness, whichever engine runs.
 */
export async function startVoice(h: VoiceHandlers): Promise<Voice> {
  try {
    await getMic()
  } catch (err) {
    diag.lastError = 'mic'
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return { stop: () => {}, live: () => false }
  }
  diag.engine = caps().stt ? 'elevenlabs' : 'browser'
  return caps().stt ? startElevenVoice(h) : startBrowserVoice(h)
}

/** VAD + ElevenLabs Scribe. */
async function startElevenVoice(h: VoiceHandlers): Promise<Voice> {
  let lastWake = 0
  let vad: Vad | null = null

  /**
   * Segments waiting for the transcriber, oldest first.
   *
   * This was a boolean — `if (transcribing) return` — and that single line was
   * the worst bug in the pause story. Segments arrive faster than Scribe
   * answers whenever someone speaks in bursts, which is exactly what pausing
   * mid-sentence looks like, so the second half of the thought was not merely
   * mis-timed, it was silently discarded. Queue instead: nothing a person says
   * out loud gets thrown away because the network was busy.
   *
   * Order is preserved because the drain is single-flight, which matters —
   * "London" arriving before "what's the weather in" is worse than either.
   */
  const pendingAudio: Blob[] = []
  let draining = false

  /**
   * Transcripts become turns here rather than one-per-segment.
   * See makeAssembler for why.
   */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  /**
   * Send one captured segment to the bridge and act on the words.
   *
   * The mode is re-read here, not at capture time, because a barge-in flips the
   * machine from 'guard' to 'listening' between the segment starting and its
   * transcript arriving — and the transcript belongs to the mode the user is in
   * now, not the one they interrupted.
   */
  const transcribe = async (blob: Blob) => {
    const mode = h.mode()
    if (mode === 'deaf') return
    const t0 = performance.now()
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/stt`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
        // A transcription that hangs must not wedge the segment drain. Fifteen
        // seconds is far more than Scribe has ever needed here; the cost of a
        // genuinely slow model is one dropped segment rather than a stuck loop.
        signal: AbortSignal.timeout(15000),
      })
      diag.idleMs = Math.round(performance.now() - t0)
      if (!res.ok) {
        diag.restarts++
        diag.lastError = `stt ${res.status}`
        drop(`transcription failed (${res.status})`)
        return
      }
      const { text } = (await res.json()) as { text?: string }
      const said = (text ?? '').trim()
      diag.lastError = ''

      if (!said) {
        drop('nothing intelligible in the segment')
        return
      }

      // His own voice, come back through the microphone. The raised guard
      // threshold stops most of it at the door; this catches the rest.
      if (isEcho(said, speakingNow())) {
        drop('echo of his own voice')
        return
      }

      diag.heard = said
      diag.heardAt = Date.now()

      if (mode === 'wake') {
        if (WAKE.test(said) && Date.now() - lastWake > WAKE_DEBOUNCE) {
          lastWake = Date.now()
          diag.wakes++
          diag.dropped = ''
          diag.accepted++
          h.onWake(afterWake(said))
        } else {
          drop(`heard "${said.slice(-40)}" — not his name`)
        }
        return
      }

      // Not a turn yet — a piece of one. The assembler decides when the thought
      // is finished, reading the words and whether the room is still noisy.
      assemble.feed(said, vad?.meter().speaking ?? false)
    } catch (err) {
      diag.restarts++
      diag.lastError = String(err)
      drop('could not reach the speech service')
    }
  }

  /** One transcription at a time, in the order the segments were spoken. */
  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pendingAudio.length) {
        await transcribe(pendingAudio.shift()!)
      }
    } finally {
      draining = false
    }
  }

  vad = await startVad({
    onStart: () => {
      const mode = h.mode()
      diag.mode = mode
      diag.sessions++
      if (mode === 'deaf') return
      // Standing down mid-thought throws the thought away with it. Otherwise
      // held text would surface as the opening of the *next* conversation.
      if (mode === 'wake') assemble.cancel()
      // The barge-in. In guard mode the user has started talking over him, and
      // because the guard threshold is high this is a real interruption rather
      // than leaked playback — so cut him off now, do not wait for the words.
      if (mode === 'guard') {
        const since = speakingSince()
        if (since && Date.now() - since < SELF_GUARD_MS) {
          diag.selfGuarded++
          return
        }
        h.onSpeechStart()
      }
    },
    onEnd: (blob) => {
      pendingAudio.push(blob)
      void drain()
    },
    onLevel: (v) => {
      // Only paint the live level while actually listening for a command, so a
      // dormant reactor stays calm and does not twitch at every room noise.
      const mode = h.mode()
      if (mode !== 'command') return
      // Never over the assembled text. This used to run unconditionally and
      // overwrote a half-built sentence with an ellipsis sixty times a second,
      // so a pause looked like the interface had forgotten what you just said.
      if (assemble.held()) return
      h.onPartial(v > 0.04 ? '…' : '')
    },
    onError: (message) => {
      diag.lastError = 'capture'
      diag.running = false
      h.onError(message)
    },
  })
  diag.running = vad.live()

  // Raise the trigger bar exactly while he speaks. The mode is polled rather
  // than pushed because nothing in the app pushes phase changes here, and a
  // 200ms lag on the echo gate is imperceptible.
  const guardPoll = setInterval(() => {
    const mode = h.mode()
    vad?.setGuard(mode === 'guard')
    // He has stood down — by Escape, by the idle timeout, or by dropping back
    // to the wake word. Anything half-said belonged to a conversation that is
    // over, and letting the hold expire later would open the next one with a
    // fragment of the last.
    if ((mode === 'wake' || mode === 'deaf') && assemble.held()) assemble.cancel()
  }, 200)

  return {
    stop: () => {
      clearInterval(guardPoll)
      assemble.cancel()
      vad?.stop()
      diag.running = false
    },
    live: () => vad?.live() ?? false,
  }
}

/* -------------------------------------------------------------------------- */
/* Browser fallback: SpeechRecognition                                        */
/* -------------------------------------------------------------------------- */

/**
 * The keyless path. Uses the browser's own SpeechRecognition for both detection
 * and transcription, so a student who has configured nothing still gets voice.
 *
 * It is the flakier engine — Chrome throttles it and it can go silent with no
 * event to catch — so a heartbeat watches it and forces a fresh session
 * whenever it stops showing signs of life. That single guard is the difference
 * between "the wake word stopped working halfway through the lesson" and an
 * assistant that keeps listening.
 */
function startBrowserVoice(h: VoiceHandlers): Voice {
  const Ctor =
    (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  if (!Ctor) {
    h.onError('This browser has no speech recognition — use Chrome or Edge, or add an ElevenLabs key.')
    return { stop: () => {}, live: () => false }
  }

  let stopped = false
  let running = false
  let rec: any = null
  let settled = ''
  let interim = ''
  let started = false
  let barged = false
  let lastWake = 0
  let lastAlive = Date.now()
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  /** A retry, a language roll or a re-dial held back by backoff. */
  let spinTimer: ReturnType<typeof setTimeout> | null = null
  /** The recogniser sits parked while the network is down. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  /** True while a `network` error is the reason we are not running. */
  let backingOff = false
  /** Set when the connection dropped; cleared by the next online event. */
  let offUntilOnline = false
  /** Consecutive hard failures, for the exponential backoff curve. */
  let consecutiveFailures = 0
  /** The on-device model install was kicked off (only once per page). */
  let installDone = false

  const online = () => globalThis.navigator?.onLine !== false
  diag.network = online() ? 'online' : 'offline'

  /**
   * Ask the platform whether on-device recognition is possible here.
   *
   * The current SpeechRecognition exposes a static available() that answers
   * offline/on-device support; the older webkitSpeechRecognition knows nothing
   * about it and returns ''. Never throws — the whole probe is informational.
   */
  const probeOnDevice = (ctor: any): string => {
    try {
      if (typeof ctor.available === 'function') {
        const r = ctor.available({ lang: 'en-US', processLocally: true, quality: 'command' })
        if (r === 'available' || r === 'downloadable' || r === 'unavailable') return r
      }
    } catch {
      /* probe is informational only */
    }
    return ''
  }

  /** Kick off the on-device model download when the platform offers it. */
  const ensureOnDevice = (ctor: any) => {
    if (diag.onDevice !== 'downloadable' || installDone) return
    installDone = true
    try {
      void ctor
        .install({ lang: 'en-US', processLocally: true })
        .then(() => {
          diag.onDevice = probeOnDevice(ctor)
        })
        .catch(() => {
          diag.onDevice = 'unavailable'
        })
    } catch {
      diag.onDevice = 'unavailable'
    }
  }

  /** The backoff delay for the current failure count: 1s, 2s, 4s, 8s, then a
   *  10s cap. Reset on any successful result. */
  const backoffMs = () =>
    Math.min(1000 * 2 ** Math.min(consecutiveFailures, 3), 10_000)

  const clearHold = () => {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
  }

  /** Delay a fresh spin with backoff, and publish the wait for diagnostics. */
  const scheduleSpin = (delay: number) => {
    clearHold()
    diag.nextRetry = delay
    if (spinTimer) clearTimeout(spinTimer)
    spinTimer = setTimeout(() => {
      spinTimer = null
      diag.nextRetry = 0
      if (!stopped) spin()
    }, delay)
  }

  /**
   * The network came back — whatever was parked gets moving again at once.
   * Registered once per voice loop, torn down with it.
   */
  const onOnline = () => {
    diag.network = 'online'
    offUntilOnline = false
    if (stopped) return
    clearHold()
    if (spinTimer) {
      clearTimeout(spinTimer)
      spinTimer = null
    }
    if (!running && !backingOff) scheduleSpin(150)
  }

  const onOffline = () => {
    diag.network = 'offline'
    offUntilOnline = true
    if (running) {
      try {
        rec?.abort()
      } catch {
        /* already gone */
      }
      rec = null
      running = false
      diag.running = false
    }
    if (spinTimer) {
      clearTimeout(spinTimer)
      spinTimer = null
    }
    clearHold()
    // Park. spin() re-checks online every two seconds; the online event above
    // makes it instant. Not trying is the whole point of handling offline.
  }

  /**
   * Command-mode recognition settings, tried in order.
   *
   * The accent is the point. An Indian assistant whose ear expects Received
   * Pronunciation spends the whole question assuming it misheard; an en-IN
   * model transcribing is materially closer to the user's enunciation. When a
   * language is not supported we roll forward rather than give up, and the
   * last attempt (en-US) is close enough to everything to almost never be
   * reached. local:true asks Chrome for on-device recognition — free, offline,
   * and its own (small) accuracy cost, so it is best-effort: if the engine
   * rejects it we simply fall forward to the network model, same accent.
   */
  const VOICE_ATTEMPTS = [
    { lang: 'en-IN', local: true },
    { lang: 'en-IN', local: false },
    { lang: 'en-GB', local: false },
    { lang: 'en-US', local: false },
  ]
  let voiceAttempt = 0
  diag.lang = VOICE_ATTEMPTS[0].local ? `${VOICE_ATTEMPTS[0].lang} (local)` : VOICE_ATTEMPTS[0].lang

  /** Same assembly rules as the premium path — a pause is not a full stop. */
  const assemble = makeAssembler({
    emit: (text) => {
      diag.dropped = ''
      diag.accepted++
      diag.holding = ''
      h.onUtterance(text)
    },
    partial: (text) => h.onPartial(text),
  })

  const touch = () => {
    lastAlive = Date.now()
  }

  const clearSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = null
  }

  const reset = () => {
    clearSilence()
    settled = ''
    interim = ''
    started = false
    barged = false
  }

  const emit = () => {
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    const mode = h.mode()
    reset()
    if (!text || mode === 'deaf') return
    if (isEcho(text, speakingNow())) {
      drop('echo of his own voice')
      return
    }
    diag.heard = text
    diag.heardAt = Date.now()
    if (mode === 'wake') {
      assemble.cancel()
      if (WAKE.test(text) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        diag.dropped = ''
        diag.accepted++
        h.onWake(afterWake(text))
      } else {
        drop(`heard "${text.slice(-40)}" — not his name`)
      }
      return
    }
    // The recogniser has already endpointed on its own 900ms gap; the assembler
    // decides whether that gap actually ended the thought. `false` because a
    // result only reaches here once the recogniser has gone quiet.
    assemble.feed(text, false)
  }

  const bumpSilence = () => {
    clearSilence()
    // A router-shaped command ("open gmail", "is it raining") is complete the
    // moment it scans — with interimResults off this is always a final result,
    // so the speaker is done and the recogniser has already endpointed it.
    // Waiting out a 900ms quiet gap would only add lag to the commands whose
    // whole point is being quick.
    const text = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (EAGER.test(text)) {
      emit()
      return
    }
    // Endpoint on a short quiet gap; the ElevenLabs path tunes this more
    // finely, but a fixed window is plenty for the fallback.
    silenceTimer = setTimeout(emit, 900)
  }

  const onResult = (e: any) => {
    touch()
    // Recognition got words back — whatever failures sat in the queue are
    // behind us, so the backoff curve starts over and the state reads healthy.
    if (consecutiveFailures) {
      consecutiveFailures = 0
      diag.network = online() ? 'online' : 'offline'
    }
    const mode = h.mode()
    diag.mode = mode
    if (mode === 'deaf') {
      interim = ''
      return
    }
    let fresh = ''
    interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript as string
      if (e.results[i].isFinal) fresh += chunk
      else interim += chunk
    }
    const heard = `${settled}${fresh} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!heard) return
    if (isEcho(`${fresh} ${interim}`, speakingNow())) {
      interim = ''
      return
    }

    if (mode === 'wake') {
      settled += fresh
      if (WAKE.test(heard) && Date.now() - lastWake > WAKE_DEBOUNCE) {
        lastWake = Date.now()
        diag.wakes++
        const trailing = afterWake(heard)
        reset()
        h.onWake(trailing)
      } else if (settled.length > 400) {
        settled = ''
      }
      return
    }

    settled += fresh
    const full = `${settled} ${interim}`.replace(/\s+/g, ' ').trim()
    if (!started || (mode === 'guard' && !barged)) {
      const words = full.split(/\s+/).filter(Boolean).length
      if (mode === 'guard') {
        // An override word cuts through everything below it — "stop" has to
        // work on the first syllable or it is not a stop button.
        if (!OVERRIDE.test(full)) {
          // His own first syllable, same as the premium path. This engine has
          // no energy gate, so without the clock the only defence is the word
          // count below, and a single clear word is exactly what leaks first.
          const since = speakingSince()
          if (since && Date.now() - since < SELF_GUARD_MS) {
            diag.selfGuarded++
            return
          }
          // Two words before this engine believes an interruption. The energy
          // path can be instant because it triggers on loudness the canceller
          // has already had a pass at; here the evidence is a transcript of
          // audio that includes his own playback, and one word of that is not
          // evidence of anything.
          if (words < 2) return
        }
      }
      started = true
      if (mode === 'guard') barged = true
      h.onSpeechStart()
    }
    diag.dropped = ''
    // Show the whole thought, not just the fragment being spoken now — there
    // may be an earlier half of it held by the assembler.
    const carried = assemble.held()
    h.onPartial(carried ? `${carried} ${full}` : full)
    bumpSilence()
  }

  const spin = () => {
    if (stopped || running) return
    if (offUntilOnline || !online()) {
      // Offline: nothing worth burning sessions on. The cloud recogniser
      // cannot work, and a tight retry loop is exactly what used to make a
      // missing connection look like a wall of network errors. Sit still,
      // checking every two seconds, and let the online event wake us instantly.
      diag.running = false
      diag.network = 'offline'
      if (!holdTimer) {
        holdTimer = setTimeout(() => {
          holdTimer = null
          if (!stopped && !offUntilOnline && online()) spin()
        }, 2000)
      }
      return
    }
    if (diag.onDevice === 'downloadable') ensureOnDevice(Ctor)

    const attempt = VOICE_ATTEMPTS[Math.min(voiceAttempt, VOICE_ATTEMPTS.length - 1)]
    diag.lang = attempt.local ? `${attempt.lang} (local)` : attempt.lang
    rec = new Ctor()
    // continuous=true keeps the mic open across answers so barge-in works and
    // no restart ever swallows a wake word — the one deliberate deviation from
    // the documented settings. The command-mode flags below are yours truly.
    rec.continuous = true
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.lang = attempt.lang
    try {
      // Offline handling is best-effort per the comments on VOICE_ATTEMPTS,
      // so set it only when this attempt asked for it, and never fail hard.
      if ('processLocally' in rec) rec.processLocally = attempt.local
    } catch {
      /* property exists but was not assignable — fine, network it is */
    }
    rec.onstart = () => {
      running = true
      diag.running = true
      diag.sessions++
      touch()
    }
    rec.onresult = onResult
    rec.onerror = onError
    rec.onend = () => {
      running = false
      diag.running = false
      touch()
      rec = null
      if (stopped) return
      // A network error ended this session and already booked its retry —
      // don't let the end event overwrite the backoff with an eager 80 ms.
      if (backingOff) {
        backingOff = false
        return
      }
      scheduleSpin(80)
    }
    try {
      rec.start()
    } catch {
      // Bad property (unknown lang locale, rejected local model) throws here
      // synchronously in some builds. Try the next attempt in line.
      if (voiceAttempt < VOICE_ATTEMPTS.length - 1) voiceAttempt++
      running = false
      scheduleSpin(250)
    }
  }

  /**
   * The error policy, per failure type.
   *
   * `network` is the one this whole loop used to mishandle: the browser's
   * cloud recogniser went down, the session ended, and the 80ms respin — with
   * nothing checking whether the network belonged to us — hammered it into a
   * retry storm that made a flaky connection look like a hard down. Now it
   * backs off exponentially (1s/2s/4s/8s, capped at 10s) and holds entirely
   * while offline, resuming the moment the network returns.
   */
  const onError = (ev: any) => {
    const code = String(ev.error ?? '')
    diag.lastError = code

    if (code === 'not-allowed' || code === 'service-not-allowed') {
      stopped = true
      diag.running = false
      rec = null
      h.onError('Microphone access was refused — voice input is unavailable.')
      return
    }

    if (code === 'language-not-supported' && voiceAttempt < VOICE_ATTEMPTS.length - 1) {
      // This browser does not have our accent. Roll forward rather than
      // stand deaf; the try above may also have handed it a local model it
      // does not ship, and the same roll covers that case too.
      voiceAttempt++
      rec = null
      running = false
      diag.running = false
      scheduleSpin(80)
      return
    }

    if (code === 'network') {
      // Cloud transcription is unreachable. Back off rather than bounce.
      consecutiveFailures++
      backingOff = true
      rec = null
      running = false
      diag.running = false
      if (offUntilOnline || !online()) {
        diag.network = 'offline'
        offUntilOnline = true
        // Hold, then gently recheck inside the backoff window.
        clearHold()
        holdTimer = setTimeout(() => {
          holdTimer = null
          offUntilOnline = false
          if (!stopped) scheduleSpin(backoffMs())
        }, backoffMs())
      } else {
        diag.network = 'degraded'
        scheduleSpin(backoffMs())
      }
      diag.lastError = `network (retry in ~${Math.max(1, Math.round(backoffMs() / 1000))}s)`
      return
    }

    if (code === 'audio-capture') {
      // The mic died mid-session. Say so once and retry gently — a replugged
      // or re-permitted headset should not need a page reload.
      consecutiveFailures++
      diag.running = false
      rec = null
      running = false
      h.onError('Microphone capture failed — check the microphone, sir.')
      scheduleSpin(Math.min(backoffMs(), 30_000))
      return
    }

    // no-speech, aborted and anything unclassified just ended the session.
    // Nothing is the matter; onend respins at the normal pace.
  }

  // Name the engine for the diagnostics panel before the loop starts. When the
  // platform offers a downloadable on-device model, start it fetching now — if
  // the network drops later, the offline path has something to fall back on.
  const ocDevice = probeOnDevice(Ctor)
  diag.onDevice = ocDevice
  if (ocDevice === 'available') diag.engine = 'browser on-device'
  else if (ocDevice === 'downloadable') ensureOnDevice(Ctor)

  spin()

  // The heartbeat. If nothing has been heard from the engine for a long stretch
  // it has gone quiet on us — tear it down and build a fresh one. With a
  // continuous recogniser, silence is NORMAL outside a conversation, so this
  // threshold is generous: the old 15s figure rebuilt the recogniser every few
  // breaths, and each rebuild is a fresh chance for a network flake.
  const health = setInterval(() => {
    if (stopped || !online() || offUntilOnline) return
    const idle = Date.now() - lastAlive
    diag.idleMs = idle
    if (idle < 60000) return
    diag.restarts++
    try {
      rec?.abort()
    } catch {
      /* already gone */
    }
    rec = null
    running = false
    diag.running = false
    touch()
    scheduleSpin(120)
  }, 5000)

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  return {
    stop: () => {
      stopped = true
      clearInterval(health)
      clearSilence()
      clearHold()
      if (spinTimer) {
        clearTimeout(spinTimer)
        spinTimer = null
      }
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      assemble.cancel()
      diag.running = false
      try {
        rec?.abort()
      } catch {
        /* noop */
      }
    },
    live: () => running,
  }
}
