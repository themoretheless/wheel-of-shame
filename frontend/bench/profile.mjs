// CPU-profiles the shrink animation via CDP Profiler and prints the
// hottest functions by self time.
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  headless: 'new',
  args: ['--window-size=1600,1000', '--use-angle=metal'],
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' })
await page.type('.title-input', 'Profile')
await page.click('.btn-primary')
await page.waitForSelector('.list-section', { timeout: 5000 })
const names = ['Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Анна',
  'Николай', 'Ольга', 'Владимир', 'Татьяна', 'Андрей', 'Светлана']
for (const n of names) {
  await page.type('.list-section input', n)
  await page.keyboard.press('Enter')
}
await new Promise((r) => setTimeout(r, 3500))

// trigger spin by probing clicks
await page.evaluate(async () => {
  const canvas = document.querySelector('.wheel-bg canvas')
  const rect = canvas.getBoundingClientRect()
  for (let fx = 0.25; fx <= 0.75; fx += 0.02) {
    for (let fy = 0.7; fy <= 0.95; fy += 0.02) {
      canvas.dispatchEvent(new MouseEvent('click', {
        clientX: rect.left + rect.width * fx,
        clientY: rect.top + rect.height * fy,
        bubbles: true,
      }))
      await new Promise((r) => setTimeout(r, 5))
    }
  }
})
await page.waitForSelector('[class*=modal], .modal-overlay', { timeout: 10000 })

const cdp = await page.createCDPSession()
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')

await page.evaluate(() => {
  const btn = document.querySelector('[class*=modal] button, .modal-overlay button')
  if (btn) btn.click()
})
await new Promise((r) => setTimeout(r, 900))

const { profile } = await cdp.send('Profiler.stop')

// aggregate self time per function
const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
const selfMicros = new Map()
const dt = profile.timeDeltas
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i]
  selfMicros.set(id, (selfMicros.get(id) || 0) + (dt[i] || 0))
}
const rows = [...selfMicros.entries()]
  .map(([id, us]) => {
    const n = nodeById.get(id)
    const f = n.callFrame
    return { name: f.functionName || '(anonymous)', url: f.url.split('/').pop() + ':' + f.lineNumber, ms: us / 1000 }
  })
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 20)
for (const r of rows) console.log(`${r.ms.toFixed(1).padStart(7)} ms  ${r.name}  (${r.url})`)

await browser.close()
