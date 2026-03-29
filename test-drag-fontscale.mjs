// Verify: alt+drag resize preserves fontScale, adjusts cols/rows
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

  // First zoom in so fontScale != 1.0
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.focused');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, right: r.right, bottom: r.bottom };
  });

  await page.mouse.move(rect.x, rect.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel({ deltaY: -300 });
  await sleep(50);
  await page.mouse.wheel({ deltaY: -300 });
  await page.keyboard.up('Alt');
  await sleep(2500); // wait for debounce + optimize

  const scaleBeforeDrag = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    return obj ? obj.style.transform : 'none';
  });
  const sizeBeforeDrag = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
  console.log('Before drag — scale: ' + scaleBeforeDrag + ', tmux: ' + sizeBeforeDrag);

  // Now alt+drag to make card bigger
  const rect2 = await page.evaluate(() => {
    const el = document.querySelector('.focused');
    const r = el.getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, x: r.x + r.width/2, y: r.y + r.height/2 };
  });

  await page.mouse.move(rect2.right - 30, rect2.bottom - 30);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(rect2.right + 120, rect2.bottom + 80, { steps: 15 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(2000);

  const scaleAfterDrag = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    return obj ? obj.style.transform : 'none';
  });
  const sizeAfterDrag = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
  console.log('After drag  — scale: ' + scaleAfterDrag + ', tmux: ' + sizeAfterDrag);

  // Verify
  if (scaleBeforeDrag === scaleAfterDrag) {
    console.log('\nPASS: fontScale preserved through drag (' + scaleAfterDrag + ')');
  } else {
    console.log('\nFAIL: fontScale changed: ' + scaleBeforeDrag + ' → ' + scaleAfterDrag);
  }

  if (sizeBeforeDrag !== sizeAfterDrag) {
    console.log('PASS: PTY resized (' + sizeBeforeDrag + ' → ' + sizeAfterDrag + ')');
  } else {
    console.log('FAIL: PTY size unchanged (' + sizeAfterDrag + ')');
  }

  await page.screenshot({ path: '/srv/svg-terminal/test-drag-fontscale.png' });
  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
