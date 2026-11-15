# Screenshot capture checklist

This directory holds real screenshots of the running application. Captures must
come from an actual Chrome or Edge window after `npm start`; none should be
fabricated.

Committed captures:

- `jarvis-hud.png` - the running holographic HUD.

Capture these additional views:

1. **Boot sequence** — the four-beat ignition overlay.
2. **Standby HUD** — reactor, status rails, and the "Hey Jarvis" prompt.
3. **Conversation** — an answer streaming into the transcript.
4. **Tool activity** — a panel or blade opened by the `display` tool.
5. **Diagnostics** — press `D` to show the live audio/voice diagnostics.
6. **Hand tracking** — the MediaPipe skeleton and pinch cursor.
7. **Systems** — the `/systems` snapshot or the `services_status` reply.
8. **Weather or Gmail panel** — a fast-path result rendered on the HUD.

Save additional files here as:

```text
boot.png
standby-hud.png
conversation.png
tool-panel.png
diagnostics.png
hand-tracking.png
systems.png
weather-panel.png
```

Then add each capture to the gallery in `README.md`. Use PNG or WebP, keep each
file under 2 MB, and confirm no API keys, email addresses, calendar events,
tokens, or personal information are visible in the capture.
