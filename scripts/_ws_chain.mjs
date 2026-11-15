import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const ws = new WebSocket('ws://127.0.0.1:8787', {
  headers: { Origin: 'http://localhost:5173' },
})

let out = ''
let step = 0
const texts = process.argv.slice(2)
// One ask id per command, so the late tts_ms report lands on the right row.
const base = Date.now().toString(36)
const askIds = texts.map((_, i) => `bench-${base}-${i}`)

const done = (code) => {
  ws.close()
  process.exit(code)
}

ws.on('open', () => sendNext())

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.type === 'text') out += msg.delta ?? ''
  if (msg.type === 'done') {
    console.log(`[${step}] reply: ${out || msg.text}`)
    out = ''
    // The app reports tts_ms a beat late, after the line has played; the
    // harness fakes that message so the ask_id correlation is exercised.
    try {
      ws.send(JSON.stringify({ type: 'tts', ask: askIds[step], ttsMs: 4200 }))
    } catch {
      /* reporting must never break the chain */
    }
    step += 1
    if (step >= texts.length) return done(0)
    sendNext()
  }
  if (msg.type === 'error') {
    console.log(`[${step}] error: ${msg.message}`)
    done(1)
  }
})

function sendNext() {
  const t = texts[step]
  if (!t) return
  console.log(`[${step}] sending: ${t}`)
  // speechMs stands in for a real voice capture; the real app measures it.
  ws.send(
    JSON.stringify({
      type: 'ask',
      text: t,
      id: `t-${step}`,
      speechMs: 1400,
      askId: askIds[step],
    }),
  )
}