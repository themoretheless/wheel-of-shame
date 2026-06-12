// Drives the running app with puppeteer-core: creates a session, adds
// participants, screenshots the wheel, spins, dismisses the winner and
// measures rAF frame times during the shrink animation.
import puppeteer from 'puppeteer-core'

const OUT = new URL('./shots/', import.meta.url).pathname
const label = process.argv[2] || 'run'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  headless: 'new',
  args: ['--window-size=1600,1000', '--use-angle=metal'],
  defaultViewport: { width: 1600, height: 1000 },
})

const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' })

// Create session
await page.type('.title-input', 'Perf Verify')
await page.click('.btn-primary')
await page.waitForSelector('.list-section', { timeout: 5000 })

// Add 12 participants via the name list input
const names = ['Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Анна',
  'Николай', 'Ольга', 'Владимир', 'Татьяна', 'Андрей', 'Светлана']
for (const n of names) {
  await page.type('.list-section input', n)
  await page.keyboard.press('Enter')
}
await new Promise((r) => setTimeout(r, 3500)) // let coin-drop intro finish
await page.screenshot({ path: `${OUT}${label}-1-wheel.png` })

// Start collecting rAF frame deltas
await page.evaluate(() => {
  window.__frames = []
  let last = performance.now()
  function tick(now) {
    window.__frames.push(now - last)
    last = now
    window.__raf = requestAnimationFrame(tick)
  }
  window.__raf = requestAnimationFrame(tick)
})

// Click the right 3D spin button (bottom-right arc of the wheel).
// Use the canvas center: wheel center is at viewport offset due to
// setViewOffset; pick via raycast by clicking known screen position is
// fragile — instead dispatch a flick-free click by probing a grid until
// spinning starts.
const spun = await page.evaluate(async () => {
  const canvas = document.querySelector('.wheel-bg canvas')
  const rect = canvas.getBoundingClientRect()
  // Probe points along the bottom arc area
  for (let fx = 0.25; fx <= 0.75; fx += 0.02) {
    for (let fy = 0.7; fy <= 0.95; fy += 0.02) {
      const x = rect.left + rect.width * fx
      const y = rect.top + rect.height * fy
      canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }))
      await new Promise((r) => setTimeout(r, 10))
      if (document.body.innerText.includes('Live') && window.__spinStarted) return true
    }
  }
  return false
})

// Detect spin via DOM: the modal appears at the end. Just wait mid-spin.
await new Promise((r) => setTimeout(r, 2000))
await page.screenshot({ path: `${OUT}${label}-2-spinning.png` })

// Wait for the winner modal (spin 4s + reveal 0.5s)
let modal = null
try {
  modal = await page.waitForSelector('.modal-overlay, .spin-result, [class*=modal]', { timeout: 8000 })
} catch {}
await page.screenshot({ path: `${OUT}${label}-3-winner.png` })

// Reset frame collection right before dismissing (shrink animation)
await page.evaluate(() => { window.__frames = [] })
if (modal) {
  await page.evaluate(() => {
    const btn = document.querySelector('[class*=modal] button, .modal-overlay button')
    if (btn) btn.click()
    else document.body.click()
  })
}
await new Promise((r) => setTimeout(r, 1200)) // shrink lasts 800ms
const frames = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf)
  return window.__frames
})
await page.screenshot({ path: `${OUT}${label}-4-after-shrink.png` })

const shrinkFrames = frames.slice(0, Math.min(frames.length, 60))
const sorted = [...shrinkFrames].sort((a, b) => a - b)
const avg = shrinkFrames.reduce((a, b) => a + b, 0) / shrinkFrames.length
const p95 = sorted[Math.floor(sorted.length * 0.95)]
const max = sorted[sorted.length - 1]
console.log(`label=${label} spunProbe=${spun} modal=${!!modal}`)
console.log(`shrink frames: n=${shrinkFrames.length} avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`)
console.log(`page errors: ${errors.length ? errors.join(' | ') : 'none'}`)

await browser.close()
