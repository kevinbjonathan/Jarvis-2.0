import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const ws = new WebSocket('ws://127.0.0.1:8787', {
  headers: { Origin: 'http://localhost:5173' },
})

let settled = false
const bail = (reason) => {
  if (settled) return
  settled = true
  console.error('ABORT', reason)
  process.exit(1)
}

const phase = process.argv[2] ?? 'router'
const text = process.argv[3] ?? 'open gmail'
const timeout = setTimeout(() => bail(`no reply within ${phase === 'model' ? 120 : 25}s`), phase === 'model' ? 120000 : 25000)

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'ask', text, id: 't-1' }))
  console.log(`[test] sent: ${text}`)
})

let out = ''
ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.type === 'text') out += msg.delta ?? ''
  if (msg.type === 'done') {
    clearTimeout(timeout)
    console.log(`[test] reply: ${out || msg.text}`)
    console.log(`[test] latency: ${phase === 'router' ? 'router (instant)' : 'model turn'} done`)
    ws.close()
    settled = true
    process.exit(0)
  }
  if (msg.type === 'error') {
    clearTimeout(timeout)
    console.log(`[test] error: ${msg.message}`)
    ws.close()
    process.exit(1)
  }
})

ws.on('error', (e) => bail(`ws error: ${e.message}`))