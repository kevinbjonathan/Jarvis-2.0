# Screenshot capture checklist

This directory is reserved for real screenshots of the running application. No
screenshots are committed yet, and none should be fabricated.

Capture these views from a real Chrome or Edge window after `npm start`:

1. **Boot sequence** — the four-beat ignition overlay.
2. **Standby HUD** — reactor, status rails, and the "Hey Jarvis" prompt.
3. **Conversation** — an answer streaming into the transcript.
4. **Tool activity** — a panel or blade opened by the `display` tool.
5. **Diagnostics** — press `D` to show the live audio/voice diagnostics.
6. **Hand tracking** — the MediaPipe skeleton and pinch cursor.
7. **Systems** — the `/systems` snapshot or the `services_status` reply.
8. **Weather or Gmail panel** — a fast-path result rendered on the HUD.

Save files here as:

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

Then replace the placeholder block in `README.md` with a real gallery. Use PNG
or WebP, keep each file under 2 MB, and confirm no API keys, email addresses,
calendar events, tokens, or personal information are visible in the capture.
