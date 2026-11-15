# Contributing

Thanks for considering a contribution. JARVIS is a personal, local-first
assistant with a small trusted core and a deliberately narrow security boundary.
Changes are welcome when they preserve that design.

Read [architecture.md](docs/architecture.md) and [SECURITY.md](SECURITY.md) before
changing the bridge, the permission gate, the tool surface, or anything that
touches credentials or user data.

---

## Ground rules

1. **Never commit secrets or personal data.** That includes `.env`,
   `jarvis-secrets.cmd`, `bridge/.oc/auth/`, `data/`, SQLite files, OAuth
   tokens, browser profiles, mail or calendar content, and real screenshots
   containing private information.
2. **Preserve the local boundary.** The bridge binds to loopback. Do not add a
   public bind, a wildcard origin, or a “convenience” remote mode.
3. **Preserve the permission model.** Effectful tools stay default-deny.
   Destructive tools keep their spoken confirmation. Do not move a write behind
   a read-only path or a gather path.
4. **Keep the deterministic router.** Exact commands should not require a model
   call. New fast paths need a narrow matcher and a clear fallthrough.
5. **Keep fallbacks intact.** A cloud failure must not break a turn when the
   local brain can answer.
6. **Do not rewrite history or existing migrations.** Append a new migration.
   Never renumber one.

---

## Development setup

```bash
git clone <your-fork-url>
cd Jarvis-2.0
npm install
npm run setup
npm start
```

For effectful work:

```bash
npm start -- --writes
```

Useful separate commands:

```bash
npm run bridge          # read-only bridge
npm run bridge:writes   # effectful bridge
npm run dev             # Vite face
npm run check           # health of a running bridge
```

Node 20 or newer is required. The bridge is ESM (`.mjs`); the face is React +
TypeScript.

---

## What to run before opening a pull request

```bash
npm test
npm run test:privacy
npm run test:omniroute
npm run lint
npm run build
```

`npm test` covers classification, provider policy, free-only billing, timeouts,
redaction, and stream handling. `npm run test:privacy` covers trace/log privacy
and OmniRoute policy. If your change touches a running service, also start the
bridge and run `npm run check`.

Lint warnings are acceptable only when they are pre-existing. Do not introduce
new warnings or errors.

---

## Architecture contracts

These are compatibility surfaces. Changing them requires an explicit migration
or a clearly justified protocol change.

| Contract | Location | Notes |
|---|---|---|
| WebSocket/HTTP protocol | `bridge/server.mjs`, `src/lib/bridge.ts` | `ask`, `cancel`, stream, tool, panel, activity events |
| Database schema | `bridge/db.mjs` | Append-only migrations, `PRAGMA user_version` |
| Tool names and schemas | `bridge/hudtools.mjs`, tool modules | The model calls these names; renaming breaks prompts and tests |
| Permission classes | `bridge/server.mjs` `decideTool()` | Read, write, destructive |
| Provider policy | `bridge/ai.mjs`, `bridge/providers.mjs` | Free-only, timeout, cooldown, redaction |
| Trace metadata | `bridge/traces.mjs` | Metadata-only; content off by default |
| HUD sanitization | `src/ui/`, CSP | DOMPurify and class allowlist stay in place |

If you add a tool, register it in the appropriate generated server, classify it
in the gate, and add a test or a reproducible check. If you add a table, append a
migration and update the architecture table.

---

## Code style

- Match the surrounding file. The bridge uses plain ESM `.mjs` with JSDoc where
  it clarifies a contract. The face uses TypeScript and React function
  components.
- Prefer small modules and explicit data flow over hidden globals.
- Keep comments for non-obvious constraints, especially security, Windows
  behavior, and protocol quirks. Do not add narration for obvious code.
- Use the existing helpers for environment parsing, redaction, error
  categorization, and SSRF-safe fetch instead of creating parallel versions.
- Do not add a dependency for a small utility that the Node standard library
  already covers.
- Keep UI text and documentation in the existing voice: direct, technical, no
  inflated claims.

---

## Data, privacy, and tests

- Test fixtures must be synthetic. Never use a real email, calendar event,
  token, name, address, or database row.
- Observability changes must preserve content-off behavior. If you add a field,
  prove it is redacted or metadata-only.
- Privacy tests should assert that raw commands, prompts, replies, and secrets
  are absent, not merely that a row was written.
- Provider tests should never call a real API. Use empty keys, fake endpoints,
  and injected responses.
- If a change affects cost, state it in the pull request: which provider, which
  model, whether free-only still holds.

---

## Commit and pull request style

- Keep commits focused. One logical change per commit is easier to review than a
  mixed refactor and feature.
- Use an imperative subject line, for example:
  - `fix: keep voice id when launchers load secrets`
  - `docs: document the Google OAuth callback`
  - `test: assert trace metadata is redacted`
- Explain **why** in the body when the change is not obvious. Include the user
  visible effect, privacy impact, and test commands.
- Do not include generated files, logs, screenshots with private data, or
  unrelated formatting churn.
- Link an issue when one exists. If there is no issue, describe the problem and
  the smallest acceptable fix.

### Pull request checklist

- [ ] The change preserves loopback binding and the origin policy.
- [ ] Effectful tools still cross the permission gate.
- [ ] Destructive tools still require confirmation.
- [ ] No secrets, tokens, personal data, or local databases are included.
- [ ] Migrations are appended, not edited.
- [ ] Tests pass: `npm test`, `npm run test:privacy`, `npm run test:omniroute`.
- [ ] Lint and build pass: `npm run lint`, `npm run build`.
- [ ] Documentation is updated for user-visible behavior.
- [ ] The pull request states privacy and cost impact.

---

## Feature proposals

Open an issue before a large change. The most useful proposals include:

- the user problem, in one or two sentences;
- the smallest path through the existing architecture;
- whether it needs a model, a tool, or no model at all;
- the failure and fallback behavior;
- the privacy and cost impact;
- how it will be tested without real credentials or personal data.

Changes that add phone control, image generation, a remote server mode, or a
paid-by-default provider are not automatically rejected, but they need an
explicit design discussion because they change the product boundary.

---

## Documentation

- Keep the README accurate. If a feature is partial, say partial.
- Do not claim screenshots, benchmarks, or integrations that are not in the
  repository.
- Use relative links so the docs work on GitHub and in a local checkout.
- Keep installation commands copy-pasteable on Windows and, where practical,
  on macOS/Linux.

---

## Security reports

Do not open a public issue with a vulnerability, token, email content, calendar
event, or database row. Follow [SECURITY.md](SECURITY.md).

---

## License

By contributing, you agree that your contribution is released under the
repository's MIT license. See [LICENSE](LICENSE). The original project is by
Aditya Dewaskar; retain the existing attribution.
