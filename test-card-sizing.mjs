// Verify cards are sized from tmux cols×rows, not all 1280×992
import puppeteer from 'puppeteer';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(5000);

  const cards = await page.evaluate(() => {
    const items = document.querySelectorAll('.terminal-3d');
    return Array.from(items).map(el => ({
      session: el.dataset.session,
      w: el.style.width || el.offsetWidth + 'px',
      h: el.style.height || el.offsetHeight + 'px'
    }));
  });

  console.log('Card sizes:');
  const sizes = new Set();
  for (const c of cards) {
    console.log(`  ${c.session}: ${c.w} × ${c.h}`);
    sizes.add(c.w + 'x' + c.h);
  }

  if (sizes.size > 1) {
    console.log(`\nPASS: ${sizes.size} different card sizes (not all identical)`);
  } else {
    console.log(`\nFAIL: All cards same size (${[...sizes][0]})`);
  }

  await page.screenshot({ path: '/srv/svg-terminal/test-card-sizing.png' });
  await browser.close();
}
run().catch(e => { console.error('Fatal:', e); process.exit(1); });
