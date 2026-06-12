// Verifies WebSocket auto-reconnect behavior:
// 1. Create session, add names, assert 'Live' badge.
// 2. Kill the backend; assert badge goes 'Offline' and reconnect attempts log.
// 3. Restart the backend (in-memory sessions are gone); assert the client
//    surfaces the lost-session error state deterministically.
import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'node:child_process'

const OUT = new URL('./shots/', import.meta.url).pathname
const BACKEND_BIN = '/tmp/wos-ws-reconnect/backend/target/debug/wheel-of-shame'
const APP = 'http://localhost:5178/'

function startBackend() {
  const p = spawn(BACKEND_BIN, [], {
    env: { ...process.env, PORT: '8085' },
    stdio: 'ignore',
  })
  return p
}

async function waitForBackend(up) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://localhost:8085/api/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'probe' }),
      })
      if (up && res.ok) return
    } catch {
      if (!up) return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`backend did not become ${up ? 'reachable' : 'unreachable'}`)
}

async function waitFor(page, fn, timeout, what) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout waiting for: ${what}`)
}

// Make sure no stray backend is running, then start ours.
try { execSync('pkill -f target/debug/wheel-of-shame') } catch {}
let backend = startBackend()
await waitForBackend(true)

const browser = await puppeteer.launch({
  executablePath:
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  headless: 'new',
  args: ['--window-size=1600,1000', '--use-angle=metal'],
  defaultViewport: { width: 1600, height: 1000 },
})

const page = await browser.newPage()
const consoleLines = []
page.on('console', (m) => {
  consoleLines.push(m.text())
  if (m.text().startsWith('[ws]')) console.log('PAGE:', m.text())
})

// Track WebSocket instances so we can forcibly drop the connection later.
await page.evaluateOnNewDocument(() => {
  window.__sockets = []
  const Orig = window.WebSocket
  window.WebSocket = function (...args) {
    const s = new Orig(...args)
    window.__sockets.push(s)
    return s
  }
  window.WebSocket.prototype = Orig.prototype
})

await page.goto(APP, { waitUntil: 'networkidle0' })

// Phase 1: create session, add names, expect Live.
await page.type('.title-input', 'Reconnect Verify')
await page.click('.btn-primary')
await page.waitForSelector('.list-section', { timeout: 5000 })
for (const n of ['Alice', 'Bob', 'Carol']) {
  await page.type('.list-section input', n)
  await page.keyboard.press('Enter')
}
await waitFor(
  page,
  () => document.querySelector('.ws-status')?.textContent.trim() === 'Live',
  5000,
  'Live badge',
)
console.log('PHASE1 OK: badge=Live, 3 names added')
await page.screenshot({ path: `${OUT}reconnect-1-live.png` })

// Phase 1b: transient outage via browser offline emulation. The backend (and
// the session) stay alive, so the client must reconnect and go Live again.
await page.evaluate(() => {
  window.__sockets[window.__sockets.length - 1].close()
})
await waitFor(
  page,
  () => document.querySelector('.ws-status')?.textContent.trim() === 'Offline',
  10000,
  'Offline badge during transient outage',
)
console.log('PHASE1b: badge=Offline after forced socket close')
await waitFor(
  page,
  () => document.querySelector('.ws-status')?.textContent.trim() === 'Live',
  15000,
  'Live badge after transient outage',
)
const names = await page.evaluate(() =>
  document.querySelector('.list-section').innerText,
)
if (!names.includes('Alice')) throw new Error('participants lost after resync')
console.log('PHASE1b OK: reconnected to Live, participants intact after resync')
await page.screenshot({ path: `${OUT}reconnect-1b-relive.png` })

// Phase 2: kill backend, expect Offline + reconnect attempts.
backend.kill('SIGKILL')
await waitForBackend(false)
await waitFor(
  page,
  () => document.querySelector('.ws-status')?.textContent.trim() === 'Offline',
  5000,
  'Offline badge',
)
console.log('PHASE2a OK: badge=Offline after backend kill')
// Wait until at least 3 reconnect attempts were logged.
const t0 = Date.now()
while (Date.now() - t0 < 15000) {
  const attempts = consoleLines.filter((l) =>
    l.includes('reconnect attempt'),
  ).length
  if (attempts >= 3) break
  await new Promise((r) => setTimeout(r, 250))
}
const attempts = consoleLines.filter((l) => l.includes('reconnect attempt'))
if (attempts.length < 3) throw new Error('expected >=3 reconnect attempts')
console.log(`PHASE2b OK: ${attempts.length} reconnect attempts observed`)
await page.screenshot({ path: `${OUT}reconnect-2-offline.png` })

// Phase 3: restart backend. Sessions are in-memory, so the REST re-fetch
// 404s and the client must surface the lost-session error state.
backend = startBackend()
await waitForBackend(true)
await waitFor(
  page,
  () => {
    const err = document.querySelector('.error')
    return !!err && err.textContent.includes('Session no longer exists')
  },
  20000,
  'lost-session error state',
)
const stillReconnecting = await page.evaluate(
  () => document.querySelector('.ws-status') !== null,
)
console.log(
  `PHASE3 OK: lost-session error surfaced, session screen shown=${stillReconnecting}`,
)
// Give it a moment, then verify reconnect attempts have stopped looping.
const before = consoleLines.filter((l) => l.includes('reconnect attempt')).length
await new Promise((r) => setTimeout(r, 4000))
const after = consoleLines.filter((l) => l.includes('reconnect attempt')).length
if (after !== before) throw new Error('reconnect loop did not stop after 404')
console.log('PHASE3b OK: reconnect loop stopped after 404')
await page.screenshot({ path: `${OUT}reconnect-3-lost-session.png` })

await browser.close()
backend.kill('SIGKILL')
console.log('ALL PHASES PASSED')
