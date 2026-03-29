import puppeteer from 'puppeteer';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--window-size=1920,1080'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(3000);

  // Focus resize-test
  await page.evaluate(() => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === 'resize-test') { item.click(); return; }
    }
  });
  await sleep(2000);

  // Screenshot single focus
  await page.screenshot({ path: '/srv/svg-terminal/multi-single.png' });
  console.log('Single focus screenshot saved');

  // Ctrl+click resize-test2
  await page.evaluate(() => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === 'resize-test2') {
        const evt = new MouseEvent('click', { bubbles: true, ctrlKey: true });
        item.dispatchEvent(evt);
        return;
      }
    }
  });
  await sleep(2500);
  await page.screenshot({ path: '/srv/svg-terminal/multi-two.png' });

  // Get layout details
  const info = await page.evaluate(() => {
    const focused = document.querySelectorAll('.focused');
    const rects = Array.from(focused).map(el => {
      const r = el.getBoundingClientRect();
      return { session: el.dataset.session, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rects,
      sidebarWidth: document.getElementById('sidebar')?.getBoundingClientRect().width || 0
    };
  });

  console.log('Viewport:', info.viewport);
  console.log('Sidebar width:', info.sidebarWidth);
  console.log('Focused terminals:');
  for (const r of info.rects) {
    console.log(`  ${r.session}: ${r.w}x${r.h} at (${r.x}, ${r.y})`);
    const usableW = info.viewport.w - info.sidebarWidth;
    console.log(`    Card covers ${(r.w / usableW * 100).toFixed(1)}% of usable width, ${(r.h / info.viewport.h * 100).toFixed(1)}% of height`);
  }

  // Try 3 and 4 terminals
  await page.evaluate(() => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === 'font-test') {
        const evt = new MouseEvent('click', { bubbles: true, ctrlKey: true });
        item.dispatchEvent(evt);
        return;
      }
    }
  });
  await sleep(2500);
  await page.screenshot({ path: '/srv/svg-terminal/multi-three.png' });

  const info3 = await page.evaluate(() => {
    const focused = document.querySelectorAll('.focused');
    return { count: focused.length, rects: Array.from(focused).map(el => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })};
  });
  console.log(`\n3 terminals: ${JSON.stringify(info3)}`);

  await browser.close();
}
run().catch(e => { console.error('Fatal:', e); process.exit(1); });
