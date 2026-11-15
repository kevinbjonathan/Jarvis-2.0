import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
  engine: string
  onDevice: string
  network: string
  nextRetry: number
  direct: boolean
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

/**
 * The AI gateway's own picture, as the bridge sees it.
 *
 * This is the shape of the `ai` block from GET /systems — the routing decision
 * the last turn actually took, which provider answered it, and the latencies.
 * Read it to answer "which brain just talked to me, and was it the fast one?".
 */
type AiProvider = { state: string; model: string | null; detail: string }
type AiDiag = {
  configured: string
  active: string
  model: string | null
  billingMode: string
  freeOnly: boolean
  cloudData: boolean
  fallback: string
  fallbackOnTimeout: boolean
  timeoutMs: number
  reasoningTimeoutMs: number
  providers: { openrouter: AiProvider; gemini: AiProvider; nvidia: AiProvider; opencode: { state: string; detail: string } }
  firstTokenMs: number
  totalMs: number
  routingMs: number
  intent: string | null
  bypassed: boolean
  completed: number
  failures: number
  fallbacks: number
  lastError: string | null
  lastAt: number | null
}

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  // The gateway's status lives on the bridge, not in this process, so it is
  // fetched rather than read. Polled slower than the local panels: a provider
  // section is a slow-moving fact, and hitting /systems four times a second
  // would spend real work drawing a mostly unchanged picture.
  const [ai, setAi] = useState<AiDiag | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    const load = async () => {
      try {
        const res = await fetch(`${BRIDGE_HTTP_URL}/systems`)
        const body = await res.json()
        if (live && body?.ai) setAi(body.ai as AiDiag)
      } catch {
        // Bridge down — leave the last reading up rather than blanking it.
        // The listening panel above already reports that.
      }
    }
    void load()
    const id = setInterval(load, 2000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">LISTENING</div>
      <Row k="engine" v={String(v.engine ?? 'browser')} />
      <Row k="recogniser" v={v.running ? 'running' : v.network === 'offline' ? 'paused (offline)' : 'STOPPED'} bad={!v.running && v.network !== 'offline'} />
      <Row
        k="network"
        v={String(v.network ?? '—')}
        bad={v.network === 'offline' || v.network === 'degraded'}
      />
      <Row k="on-device" v={v.onDevice ? String(v.onDevice) : 'not supported'} bad={v.onDevice === 'unavailable'} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row k="direct mode" v={v.direct ? 'on' : 'off'} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 65000}
      />
      <Row k="retry in" v={v.nextRetry && v.nextRetry > 0 ? `${(v.nextRetry / 1000).toFixed(1)}s` : '—'} bad={(v.nextRetry ?? 0) > 0} />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="wakes" v={String(v.wakes ?? 0)} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to OS" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k="cloud rescues" v={String(t.rescued ?? 0)} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />

      <div className="diag-sec">AI GATEWAY</div>
      {ai ? (
        <>
          <Row k="want" v={ai.configured} />
          <Row k="active" v={ai.model ? `${ai.active} · ${ai.model}` : ai.active} />
          <Row
            k="billing"
            v={ai.freeOnly ? `${ai.billingMode} (free only)` : ai.billingMode}
          />
          <Row k="cloud data" v={ai.cloudData ? 'allowed' : 'blocked'} />
          <Row
            k="openrouter"
            v={
              ai.providers.openrouter.state === 'ready'
                ? `ready · ${ai.providers.openrouter.model}`
                : ai.providers.openrouter.state
            }
            bad={!['ready', 'cooldown', 'not-configured'].includes(ai.providers.openrouter.state)}
          />
          <Row
            k="gemini"
            v={
              ai.providers.gemini.state === 'ready'
                ? `ready · ${ai.providers.gemini.model}`
                : ai.providers.gemini.state
            }
            bad={!['ready', 'cooldown', 'not-configured'].includes(ai.providers.gemini.state)}
          />
          <Row
            k="nvidia"
            v={
              ai.providers.nvidia.state === 'ready'
                ? `ready · ${ai.providers.nvidia.model}`
                : ai.providers.nvidia.state
            }
            bad={!['ready', 'cooldown', 'not-configured'].includes(ai.providers.nvidia.state)}
          />
          <Row k="local brain" v={ai.providers.opencode.state} />
          <Row k="fallback" v={ai.fallback} />
          <Row k="timeout failover" v={ai.fallbackOnTimeout ? 'on' : 'off'} />
          <Row k="model timeout" v={`${Math.round(ai.timeoutMs / 1000)}s / ${Math.round(ai.reasoningTimeoutMs / 1000)}s reasoning`} />
          <Row
            k="last route"
            v={
              ai.intent
                ? ai.bypassed
                  ? `${ai.intent} · no model call`
                  : ai.intent
                : '— nothing yet'
            }
            bad={!ai.intent}
          />
          <Row
            k="last turn"
            v={
              ai.totalMs
                ? `${ai.totalMs} ms (first token ${ai.firstTokenMs} ms)`
                : ai.routingMs
                  ? `router ${ai.routingMs} ms`
                  : '—'
            }
          />
          <Row
            k="turns / fails"
            v={`${ai.completed} / ${ai.failures}`}
            bad={ai.failures > 0}
          />
          <Row k="failovers" v={String(ai.fallbacks)} bad={ai.fallbacks > 0} />
          <Row k="error" v={ai.lastError || '—'} bad={Boolean(ai.lastError)} />
        </>
      ) : (
        <Row k="status" v="bridge not reachable" bad />
      )}
    </div>
  )
}
