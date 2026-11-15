# Changelog

All notable changes to JARVIS are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and intends to use [Semantic Versioning](https://semver.org/) once it has
tagged releases. The current package version is `0.0.0`; the entries below
describe the publication snapshot rather than a numbered release.

---

## [Unreleased]

### Added

- Hybrid intelligence gateway with provider-independent classification and a
  free-first policy across OpenRouter, Google Gemini, and NVIDIA NIM.
- Local opencode brain (`opencode run --format json`) as the default tool-using
  model, with session continuation, stdin prompt delivery, and process-tree
  cancellation.
- Deterministic fast router for exact browser, tab, scroll, clock, weather,
  reminder, memory, preference, project, Gmail-read, and calendar-read commands.
- Generated opencode HUD tool servers for interface control, browser automation,
  camera, weather, preferences, notifications, Gmail, Calendar, memory, projects,
  tasks, and system status.
- Voice loop with browser wake phrase, local energy VAD, barge-in, echo
  rejection, and TTS degradation through ElevenLabs, Kokoro, and system speech.
- SQLite persistence for preferences, memory, projects, tasks, notifications,
  browser tabs, performance logs, traces, and telemetry counters.
- Local observability foundation: one trace per turn, ordered metadata-only
  steps, aggregate counters, retention, and redaction. Content is off by default.
- Chrome DevTools Protocol adapter for navigation, page reads, screenshots, tab
  control, and gated browser actions.
- Optional Gmail and Google Calendar tools using a server-side Desktop-app OAuth
  flow.
- Windows notification queue with boot catch-up and native balloons.
- Keyless Open-Meteo weather with geocoding, a ten-minute cache, saved location,
  and a model-free fast path.
- MediaPipe hand tracking with a full skeleton, pinch press, drag/resize
  gestures, and camera tools.
- Holographic HUD with boot sequence, reactor, orbits, panels, blades, themes,
  effects, diagnostics, and sanitized model-authored content.
- Windows launchers for visible, hidden, show, stop, and detached modes.
- OmniRoute loopback boundary and canary, disabled by default and outside normal
  routing.
- Architecture, installation, contributing, security, and changelog
  documentation.
- Animated README assets, feature icons, status badges, and a labeled screenshot
  placeholder.

### Changed

- Default brain is `opencode/big-pickle` on the free opencode Zen tier; no
  Anthropic subscription or paid key is required.
- The README now describes implemented behavior and clearly marks partial,
  planned, and absent capabilities.
- The environment example now documents the bridge's `.env` loading, opencode,
  Google OAuth, observability, free-only billing, provider timeouts, and
  frontend variables.
- The setup preflight checks opencode and local key files instead of the legacy
  Claude CLI flow.
- Repository ignore rules now cover local databases, runtime notifications,
  OAuth tokens, and generated opencode tools.
- Package description reflects the current assistant rather than the original
  Claude Code prototype.

### Security

- The bridge remains loopback-only with an origin allowlist and no-origin
  rejection by default.
- Effectful tools remain default-deny; destructive tools also require spoken
  confirmation.
- File and media endpoints confine paths and refuse private/loopback addresses;
  outbound fetches use an SSRF guard.
- Model-authored HUD HTML is sanitized with DOMPurify, a class allowlist, and a
  strict Content Security Policy.
- Cloud turns exclude preferences and retrieved mail/calendar text unless
  `AI_CLOUD_DATA=1`.
- Observability stores metadata only; prompts, replies, tool payloads, and
  secrets are not stored in Phase 1.
- Repository hygiene excludes `data/`, SQLite files, `bridge/.oc/auth/`, runtime
  notification/preference state, and generated tools.

### Known limitations

- Memory retrieval uses `LIKE`, not FTS5/BM25. Trace FTS is not implemented.
- No CPU, RAM, disk, or battery telemetry; `systems` is service-level.
- Wake word uses browser `SpeechRecognition`; Porcupine is present but not wired
  into the wake path.
- No phone-control bridge and no built-in image generation in the current tree.
- No application screenshots are committed; the README uses a labeled
  placeholder.
- Windows is the first-class platform for launchers, native notifications, and
  the unattended Chrome flow.
- Single-user only. The bridge must not be exposed to a network.

---

## Attribution

JARVIS began from the MIT-licensed
[adewaskar/jarvis](https://github.com/adewaskar/jarvis) project by Aditya
Dewaskar. The original license and attribution are preserved in
[LICENSE](LICENSE). JARVIS 2.0 additions are released under the same MIT license.

Music credits are in [`public/audio/CREDITS.md`](public/audio/CREDITS.md).
