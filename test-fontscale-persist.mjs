// Verify fontScale persists after auto-optimize
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

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

  // Focus resize-test
  for (let i = 0; i < 5; i++) {
    const ok = await page.evaluate(() => {
      const items = document.querySelectorAll('.thumbnail-item');
      for (const item of items) {
        if (item.dataset.session === 'resize-test') { item.click(); return true; }
      }
      return false;
    });
    if (ok) break;
    await sleep(3000);
  }
  await sleep(2500);

  const initialSize = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
  console.log('Initial tmux size: ' + initialSize);

  // Alt+scroll to zoom in (3 clicks for noticeable zoom)
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.focused');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  });

  await page.mouse.move(rect.x, rect.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel({ deltaY: -300 });
  await sleep(50);
  await page.mouse.wheel({ deltaY: -300 });
  await sleep(50);
  await page.mouse.wheel({ deltaY: -300 });
  await page.keyboard.up('Alt');

  // Check scale immediately after zoom
  const scaleAfterZoom = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    return obj ? obj.style.transform : 'none';
  });
  console.log('Scale after zoom: ' + scaleAfterZoom);

  // Wait for debounce + resize
  await sleep(2500);

  // Check scale AFTER optimize — should STILL be zoomed
  const scaleAfterOptimize = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    return obj ? obj.style.transform : 'none';
  });
  const sizeAfterOptimize = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
  console.log('Scale after optimize: ' + scaleAfterOptimize);
  console.log('Tmux size after optimize: ' + sizeAfterOptimize);

  // Verify
  if (scaleAfterOptimize === scaleAfterZoom && scaleAfterOptimize !== 'scale(1)') {
    console.log('\nPASS: fontScale persisted after optimize (' + scaleAfterOptimize + ')');
    console.log('PASS: PTY resized to fit zoomed view (' + initialSize + ' → ' + sizeAfterOptimize + ')');
  } else if (scaleAfterOptimize === 'scale(1)') {
    console.log('\nFAIL: fontScale was reset to 1.0 — optimize should preserve user zoom');
  } else {
    console.log('\nWARN: scale changed unexpectedly: ' + scaleAfterZoom + ' → ' + scaleAfterOptimize);
  }

  await page.screenshot({ path: '/srv/svg-terminal/test-fontscale-persist.png' });
  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
