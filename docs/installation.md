# Installation

This guide takes a clean machine to a working JARVIS: bridge, interface, voice,
memory, and optional Gmail/Calendar. It assumes the default loopback setup. For
the internals behind these steps, read [architecture.md](architecture.md).

---

## 1. Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| Windows 10/11 | Full launchers, native notifications, unattended Chrome flow | The bridge and web face are cross-platform; Windows is the first-class path. |
| Node.js 20+ | Bridge and Vite | `node --version`. Node 24 is tested. |
| opencode CLI | Default local brain | Install from <https://opencode.ai>, then `opencode auth login`. Free Zen tier is enough. |
| Chrome or Edge | Microphone, browser tools, CDP | Use a real browser window; embedded preview panes block the microphone. |
| Git | Clone and updates | Optional if you use a source archive. |
| ElevenLabs key | Optional premium voice and Scribe | Browser speech works without it. |
| Google OAuth client | Optional Gmail and Calendar | Desktop-app client in Google Cloud Console. |

No Anthropic subscription or paid API key is required for the default brain.

---

## 2. Clone and install

The URL below assumes the published `kevinbjonathan/Jarvis-2.0` repository.
Substitute your fork or mirror if it differs.

```bash
git clone https://github.com/kevinbjonathan/Jarvis-2.0.git
cd Jarvis-2.0
npm install
```

`npm install` also installs the MediaPipe runtime used by hand tracking. At
start, `scripts/start.mjs` copies the pinned WASM files into `public/mediapipe`;
that directory is git-ignored.

---

## 3. Preflight

```bash
npm run setup
```

This is advisory only. It checks Node, the opencode CLI, optional key files,
and a browser, and prints the start commands. It changes nothing and always
exits 0.

If opencode is missing:

1. Install it from <https://opencode.ai>.
2. Run `opencode auth login` once.
3. Confirm with `opencode --version`.

---

## 4. Start

### Foreground, read-only

```bash
npm start
```

This launches the bridge on `127.0.0.1:8787` and Vite on `localhost:5173`.
Open <http://localhost:5173> in Chrome or Edge, click **INITIALISE**, allow the
microphone, and say **“Hey Jarvis”**.

### Foreground, with actions

```bash
npm start -- --writes
```

This sets `JARVIS_ALLOW_WRITES=1`: sends, mutations, browser actions, and file
effects become available. Destructive tools still require a spoken confirmation.
Read the permission gate in `bridge/server.mjs` before enabling writes.

### Background, returns when healthy

```bash
npm run start:detached -- --writes
```

Both processes are detached. The command waits for `/health` and the Vite page,
then returns. Logs:

```text
%TEMP%\jarvis-logs\bridge.log
%TEMP%\jarvis-logs\face.log
```

Healthy services already running are reused, not duplicated.

### Separate terminals

```bash
npm run bridge          # read-only bridge
npm run bridge:writes   # effectful bridge
npm run dev             # Vite face
```

### Windows launchers

| File | Behavior |
|---|---|
| `start-jarvis.cmd` | Visible mode; starts the bridge and face, then opens Chrome. |
| `start-jarvis.vbs` | Hidden mode; starts the pair and parks Chrome off-screen. |
| `show-jarvis.vbs` | Brings the hidden Chrome window back on screen. |
| `stop-jarvis.vbs` | Stops only the processes JARVIS started. |

Both start modes run with writes enabled. The hidden mode uses a dedicated
Chrome profile and denies the camera; use the visible mode for camera work.

---

## 5. Configuration

Copy the example:

```bash
copy .env.example .env        # Windows
cp .env.example .env          # macOS / Linux
```

The bridge reads `.env` from the repository root. An already-exported
environment variable wins. Empty values are ignored. The bridge also parses
`jarvis-secrets.cmd` if it exists, which is useful for the Windows launchers.

The Vite frontend reads `VITE_*` values. Put frontend-only overrides in
`.env.local`; only `VITE_*` values reach the browser.

### Minimum useful configuration

```ini
JARVIS_MODEL=opencode/big-pickle
JARVIS_EFFORT=low
JARVIS_ALLOW_WRITES=0
```

### Common bridge variables

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | WebSocket/HTTP port. Keep `VITE_BRIDGE_URL` in step. |
| `JARVIS_MODEL` | `opencode/big-pickle` | Local brain model. |
| `JARVIS_OPENCODE` | `opencode` | opencode executable. |
| `JARVIS_EFFORT` | `low` | Reasoning variant. |
| `JARVIS_ALLOW_WRITES` | `0` | Effectful tools. |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins. |
| `JARVIS_ALLOW_NO_ORIGIN` | `0` | Accept clients without an `Origin` header. |
| `JARVIS_FILE_ROOTS` | none | Extra roots for `/file`. |
| `JARVIS_VOICE_ID` | built-in default | ElevenLabs voice id. |
| `ELEVENLABS_API_KEY` | none | Premium speech and transcription. |
| `JARVIS_GOOGLE_CLIENT_ID` | none | Google OAuth client id. |
| `JARVIS_GOOGLE_CLIENT_SECRET` | none | Google OAuth client secret. |

Full reference: [`.env.example`](../.env.example). Never commit `.env`.

---

## 6. Database

There is no migration command to run by hand. On first start the bridge:

1. Creates `data/jarvis.db`.
2. Enables WAL mode and foreign keys.
3. Applies the four ordered migrations tracked by `PRAGMA user_version`.

The database holds preferences, memory, projects, tasks, notifications, browser
tab state, performance logs, traces, and telemetry counters. It is personal data
and is git-ignored.

To back up, stop the bridge and copy `data/jarvis.db` plus any `-wal`/`-shm`
files. To start fresh, stop the bridge and move the database aside; do not delete
it while the bridge is running.

`JARVIS_DB_PATH` overrides the path. It is used by the privacy test and by
advanced local setups; most users should leave it unset.

---

## 7. Google OAuth (optional)

Gmail and Calendar remain disconnected until you complete this flow. The rest of
JARVIS works without it.

1. Open Google Cloud Console and create or select a project.
2. Enable **Gmail API** and **Google Calendar API**.
3. Configure the OAuth consent screen. Add your own account as a test user if
   the app is in testing.
4. Create an OAuth client of type **Desktop app**.
5. Put the client id and secret in `.env` or `jarvis-secrets.cmd`:

   ```ini
   JARVIS_GOOGLE_CLIENT_ID=...
   JARVIS_GOOGLE_CLIENT_SECRET=...
   ```

6. Start the bridge on the default port.
7. Open <http://127.0.0.1:8787/auth/google> in the same browser and complete
   consent.

The redirect is fixed to:

```text
http://127.0.0.1:8787/auth/google/callback
```

Desktop-app clients accept loopback redirects without manual registration. If
you change `JARVIS_BRIDGE_PORT`, this build's OAuth flow will not match the
fixed callback; keep `8787` for Google.

The token is stored server-side at `bridge/.oc/auth/google.json`. It is
git-ignored. Scopes requested are Gmail read-only, Gmail send, Calendar events,
and Calendar read-only. JARVIS never sends the token to the page.

---

## 8. Cloud intelligence (optional)

The default configuration spends nothing and still answers through the local
brain. Add a cloud provider only for faster or stronger ordinary conversation.

```ini
AI_PROVIDER=auto
AI_BILLING_MODE=free_only
AI_FALLBACK=opencode

OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free
```

Free-only rules are described in
[architecture.md](architecture.md#6-ai-gateway). In short: a model is used only
when it is verified free. Set `AI_BILLING_MODE=standard` deliberately if you
want paid models; that can spend money.

For Gemini or NVIDIA models without a `:free` suffix, list the exact id in
`AI_FREE_MODELS` after confirming it is free for your account. For NVIDIA, you
can alternatively declare `NVIDIA_FREE=1`.

Cloud turns do not include preferences or retrieved mail/calendar text unless
`AI_CLOUD_DATA=1`. Leave it at `0` unless you intend to send that context.

Verify provider status without exposing keys:

```bash
npm run check
```

---

## 9. OmniRoute (experimental)

OmniRoute is a loopback-only adapter for a local OpenAI-compatible router. It is
disabled by default and does not join normal routing. Enable it only if you run
the matching router:

```ini
JARVIS_OMNIROUTE_ENABLED=1
JARVIS_OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
JARVIS_OMNIROUTE_API_KEY=...
JARVIS_OMNIROUTE_MODEL=vendor/exact-model
JARVIS_OMNIROUTE_ALLOWED_MODELS=vendor/exact-model
```

It rejects non-loopback hosts, wrong ports or paths, query strings, `auto/*`,
wildcards, missing allowlists, and unapproved models. The canary is separately
gated and uses a fixed synthetic prompt:

```bash
npm run canary:omniroute
```

---

## 10. Verification

```bash
npm test                 # classifier, gateway, free-only policy, redaction
npm run test:privacy     # trace/log privacy and OmniRoute policy
npm run test:omniroute   # OmniRoute boundary and canary
npm run lint             # oxlint
npm run build            # TypeScript + Vite production build
npm run check            # bridge health; start the bridge first
```

The audit machine reports:

```text
npm test              58/58 passed
npm run test:privacy  39/39 passed
npm run lint          warnings only (unused bindings), no errors
```

`npm run check` probes the running bridge. It is not a static test.

---

## 11. Troubleshooting

### “Cannot reach the bridge”

- Confirm the bridge is running: `npm run check`.
- Check `JARVIS_BRIDGE_PORT` and `VITE_BRIDGE_URL`.
- Do not start two bridges on one port.
- If you use detached mode, read `%TEMP%\jarvis-logs\bridge.log`.

### Voice does not work

- Use a real Chrome or Edge window, not an embedded preview.
- Allow microphone permission for `http://localhost:5173`.
- Press `D` for diagnostics and `T` for an audio self-test.
- A wake phrase needs a short pause before the command.

### No answer, but the HUD is alive

- The WebSocket handshake may have been rejected by the origin check. Use the
  default `localhost:5173` origin or add the origin explicitly.
- Check that opencode is installed and logged in.
- Run `npm run check` and inspect the model/provider state.

### Gmail or Calendar says “not connected”

- Confirm the Google client id and secret are present in `.env` or
  `jarvis-secrets.cmd`.
- Confirm Gmail API and Calendar API are enabled.
- Complete consent at <http://127.0.0.1:8787/auth/google>.
- Keep the bridge on port `8787` for the fixed callback.

### Browser tools fail

- Install Chrome or Edge.
- Use the visible launcher if the hidden profile has trouble.
- Check the adapter port (`JARVIS_CHROME_PORT`, default `9333`) and any other
  Chrome instance using the same debugging port.

### No native notifications

- Native balloons are Windows-only. Other systems log the notification.
- Confirm the bridge is running; the reminder queue ticks every five seconds.

### The model is slow

- Lower `JARVIS_EFFORT`.
- Check the free-tier status of your provider.
- Set `AI_PROVIDER=none` to force the local brain and avoid cloud timeouts.
- Use the fast router for exact commands; it does not call a model.

### The database is unexpected

- Stop the bridge before inspecting or copying it.
- The bridge refuses to open a database newer than the build's known migrations.
- Back up before changing schema. Do not delete the database to “fix” a
  migration; restore a copy instead.

---

## 12. Updating

```bash
git pull
npm install
npm test
npm run test:privacy
npm run build
```

Migrations are append-only and run at bridge start. Back up `data/jarvis.db`
before updating if the database matters to you.

---

## 13. Uninstall or reset

To remove the application, delete the cloned directory and the dedicated Chrome
profile at `%LOCALAPPDATA%\JarvisApp` if the hidden launcher created it.

To reset memory and preferences, stop the bridge and move `data/jarvis.db` out
of the repository. JARVIS recreates an empty database on the next start. This is
irreversible for that database; back it up first.

OAuth tokens live at `bridge/.oc/auth/google.json`. Delete that file to force a
new consent flow. Revoke access in your Google account if you want to remove the
grant itself.

Generated opencode tools live in `bridge/.oc/tools` and are recreated at boot.
They are ignored by Git.
