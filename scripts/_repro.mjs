import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const src = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8')
const sp = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`/)[1]
const prefs =
  'Honour these standing preferences unless the user says otherwise this turn:\n' +
  '- preferred: ["brief answers"]'
const note =
  'The fast command router answers direct commands - "open gmail", ' +
  '"remind me in five minutes", "remember that..." - without you. A request ' +
  'reaching you is one the router did not recognise.'
const prompt = [sp, prefs, note, 'hello there'].filter(Boolean).join('\n\n')

console.log('prompt length:', prompt.length)
const child = spawn('opencode', ['run', '--format', 'json', '-m', 'opencode/big-pickle', prompt], {
  shell: true,
  cwd: process.env.USERPROFILE,
  env: {
    ...process.env,
    OPENCODE_CONFIG_DIR: 'D:/Github/jarvis/bridge/.oc',
    JARVIS_HUD_URL: 'http://127.0.0.1:8787',
    JARVIS_HUD_TOKEN: 'repro',
  },
})
let out = ''
let err = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (err += d))
const timer = setTimeout(() => {
  console.log('TIMEOUT (no exit in 90s)')
  child.kill()
}, 90000)
child.on('close', (code) => {
  clearTimeout(timer)
  console.log('exit code:', code)
  console.log('--- stderr (last 1500 chars) ---')
  console.log(err.slice(-1500))
  console.log('--- stdout (last 800 chars) ---')
  console.log(out.slice(-800))
})