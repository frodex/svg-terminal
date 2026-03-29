// Test: alt+drag resize — card visually changes, cols/rows adjust, text same size
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function tmuxSize() {
  return execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(5000);

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

  const initial = tmuxSize();
  console.log('Initial tmux: ' + initial);

  // Get card dimensions and bounding rect
  const before = await page.evaluate(() => {
    const el = document.querySelector('.focused');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      domW: el.style.width, domH: el.style.height,
      screenW: Math.round(r.width), screenH: Math.round(r.height),
      right: r.right, bottom: r.bottom
    };
  });
  console.log('Before drag — DOM: ' + before.domW + 'x' + before.domH + ', Screen: ' + before.screenW + 'x' + before.screenH);

  // Alt+drag to make card wider and taller
  const startX = before.right - 30;
  const startY = before.bottom - 30;
  await page.mouse.move(startX, startY);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(startX + 200, startY + 100, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(2000);

  const afterDrag = tmuxSize();
  const after = await page.evaluate(() => {
    const el = document.querySelector('.focused');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      domW: el.style.width, domH: el.style.height,
      screenW: Math.round(r.width), screenH: Math.round(r.height)
    };
  });
  console.log('After drag  — DOM: ' + after.domW + 'x' + after.domH + ', Screen: ' + after.screenW + 'x' + after.screenH);
  console.log('After drag  — tmux: ' + afterDrag);

  // Check card visually got bigger
  if (after.screenW > before.screenW && after.screenH > before.screenH) {
    console.log('PASS: Card visually larger (' + before.screenW + '→' + after.screenW + ' x ' + before.screenH + '→' + after.screenH + ')');
  } else {
    console.log('FAIL: Card did not visually grow');
  }

  // Check tmux resized
  const [initCols, initRows] = initial.split('x').map(Number);
  const [afterCols, afterRows] = afterDrag.split('x').map(Number);
  if (afterCols > initCols && afterRows > initRows) {
    console.log('PASS: More cols/rows (' + initial + ' → ' + afterDrag + ')');
  } else {
    console.log('FAIL: Cols/rows did not increase (' + initial + ' → ' + afterDrag + ')');
  }

  // Now test optimize fills the card
  console.log('\nTesting ⊡ optimize...');
  const beforeOpt = tmuxSize();
  await page.evaluate(() => {
    const bar = document.getElementById('term-controls-bar');
    if (!bar) return;
    const btns = bar.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent.trim() === '⊡') { btn.click(); return; }
    }
  });
  await sleep(1500);
  const afterOpt = tmuxSize();
  console.log('Optimize: ' + beforeOpt + ' → ' + afterOpt);

  // No CSS transform on object
  const transform = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    return obj ? obj.style.transform : 'N/A';
  });
  console.log('Object transform: "' + transform + '"');

  await page.screenshot({ path: '/srv/svg-terminal/test-drag-v2.png' });
  await browser.close();
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
