// Reports renderer.info and scene object counts after build and during shrink.
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  headless: 'new',
  args: ['--window-size=1600,1000', '--use-angle=metal'],
  defaultViewport: { width: 1600, height: 1000 },
})
const page = await browser.newPage()
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' })
await page.type('.title-input', 'Inspect')
await page.click('.btn-primary')
await page.waitForSelector('.list-section', { timeout: 5000 })
const names = ['Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Анна',
  'Николай', 'Ольга', 'Владимир', 'Татьяна', 'Андрей', 'Светлана']
for (const n of names) {
  await page.type('.list-section input', n)
  await page.keyboard.press('Enter')
}
await new Promise((r) => setTimeout(r, 3500))

async function snap(tag) {
  const info = await page.evaluate(() => {
    const d = window.__wheelDebug
    if (!d) return null
    let objects = 0
    d.scene.traverse(() => objects++)
    let wheelObjects = 0
    d.wheelGroup.traverse(() => wheelObjects++)
    const i = d.renderer.info
    return {
      objects, wheelObjects,
      calls: i.render.calls, triangles: i.render.triangles,
      geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs.length,
    }
  })
  console.log(tag, JSON.stringify(info))
}

await snap('idle:')

// spin
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
await snap('modal:')

await page.evaluate(() => {
  const btn = document.querySelector('[class*=modal] button, .modal-overlay button')
  if (btn) btn.click()
})
await new Promise((r) => setTimeout(r, 400))
await snap('mid-shrink:')
await new Promise((r) => setTimeout(r, 800))
await snap('post-shrink:')

await browser.close()
