/**
 * The free brain: `opencode run` streaming JSON events.
 *
 * Replaces the `query()` from @anthropic-ai/claude-agent-sdk. All the browser
 * and HUD plumbing stays put; only the sourcing of a turn changes. opencode is
 * driven in `--format json` mode and its events are normalised into exactly the
 * messages the bridge's stream pump already knows how to handle, so nothing
 * downstream had to learn opencode.
 *
 * The model is served by opencode Zen under the machine's existing opencode
 * login — the same free tier this project's own assistant runs on. It costs
 * nothing and needs no Anthropic key or Claude Code subscription.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const OPENCODE = process.env.JARVIS_OPENCODE ?? 'opencode'

/**
 * Spawn one turn of opencode.
 *
 * @param {object} opts
 * @param {string} opts.prompt           - user text for this turn
 * @param {string} [opts.sessionId]      - continue an existing opencode session
 * @param {string} opts.model            - e.g. opencode/big-pickle
 * @param {string} [opts.effort]         - provider variant, e.g. high
 * @param {string} opts.cwd              - working directory for file tools
 * @param {object} opts.env              - extra environment (config dir, HUD url/token)
 * @param {(id: string) => void} [opts.onSession]
 * @param {(v: unknown) => void} [opts.onExit]
 * @returns {{ stream: AsyncGenerator<object>, kill: () => void, pid: number }}
 */
export function runTurn(opts) {
  const args = ['run', '--format', 'json', '-m', opts.model]
  if (opts.sessionId) args.push('-s', opts.sessionId)
  if (opts.effort) args.push('--variant', opts.effort)

  const startedAt = Date.now()
  console.log(`[model] started — ${opts.model}${opts.sessionId ? ` (session ${opts.sessionId})` : ''}`)

  // The prompt goes over stdin, not argv. The composed turn — system prompt,
  // stored preferences, user text — is several kilobytes, and on Windows the
  // command line has a hard ceiling: a turn carried in argv dies with "the
  // command line is too long", visible only as opencode exiting silently a
  // hundred milliseconds in. Stdin has no such ceiling.
  const child = spawn(OPENCODE, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    windowsHide: true,
    // npm's global shim on Windows ships as a .cmd that plain spawn() will not
    // resolve — without a shell the child dies with ENOENT a millisecond after
    // boot and a turn ends instantly with no text at all.
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  child.stdin.on('error', () => {})
  child.stdin.write(opts.prompt)
  child.stdin.end()

  let killed = false
  let reportedError = false
  const kill = () => {
    if (killed || child.exitCode !== null) return
    killed = true
    try {
      // Flat kill() on Windows only stops the shell, not the tree opencode
      // spawned; a lingering Bash child would keep listening on a turn the
      // user already abandoned. taskkill /T takes the whole tree. Bare
      // `taskkill` is not always on PATH in this spawned context, so point at
      // the full binary under SystemRoot.
      if (process.platform === 'win32') {
        const taskkill =
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        }).on('error', () => {})
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* already gone */
    }
  }

  const stream = (async function* () {
    let buf = ''
    let sawText = ''
    let finished = false
    const finish = function* () {
      if (finished) return
      finished = true
      console.log(`[model] completed in ${Date.now() - startedAt} ms`)
      yield { type: '__end', text: sawText }
    }

    try {
      for await (const chunk of child.stdout) {
        buf += chunk.toString()
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }

          if (msg.sessionID) opts.onSession?.(msg.sessionID)

          switch (msg.type) {
            case 'text': {
              const text = msg.part?.text
              if (!text) break
              sawText += text
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text },
                },
              }
              break
            }
            case 'tool_use': {
              const part = msg.part
              if (!part?.callID || !part?.tool) break
              console.log(`[tool] ${part.tool} (${part.state?.status ?? 'pending'})`)
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', id: part.callID, name: part.tool },
                },
              }
              const ok = part.state?.status === 'completed'
              yield {
                type: 'user',
                message: {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: part.callID, is_error: !ok },
                  ],
                },
              }
              break
            }
            case 'error': {
              const detail = msg.error?.data?.message ?? msg.error?.message ?? 'the brain did not respond.'
              reportedError = true
              yield { type: '__error', message: String(detail) }
              kill()
              break
            }
            default:
              // step_start, step_finish, reasoning, session … nothing to surface.
              break
          }
        }
        if (finished) break
      }
    } catch {
      /* stream closed by kill */
    }

    yield* finish()
  })()

  child.on('error', () => opts.onExit?.(new Error('could not start opencode — is it installed?')))

  // opencode's own warnings end up here, and a failed turn otherwise exits
  // silent with nothing in the logs to say why — impossible to debug remotely.
  child.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) console.error(`[opencode] ${line}`)
  })

  child.on('close', (code) => {
    opts.onExit?.(code === 0 || killed || reportedError ? null : new Error(`opencode exited with code ${code}`))
  })

  return { stream, kill, pid: child.pid }
}