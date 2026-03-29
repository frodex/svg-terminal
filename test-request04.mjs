// Tests for request_04: tmux-only resize (no CSS fontScale)
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tmuxSize() {
  return execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
}

async function run() {
  const results = [];
  function pass(name, detail) { results.push({ name, ok: true }); console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`); }
  function fail(name, reason) { results.push({ name, ok: false, reason }); console.log(`  FAIL: ${name} — ${reason}`); }

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

  try {
    const initial = tmuxSize();
    console.log('  Initial: ' + initial);

    // ========================================
    // TEST 1: Alt+scroll UP → fewer cols (bigger text)
    // ========================================
    const rect = await page.evaluate(() => {
      const el = document.querySelector('.focused');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    });

    await page.mouse.move(rect.x, rect.y);
    await page.keyboard.down('Alt');
    await page.mouse.wheel({ deltaY: -100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: -100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: -100 });
    await page.keyboard.up('Alt');
    await sleep(1000);

    const afterZoomIn = tmuxSize();
    const [initCols] = initial.split('x').map(Number);
    const [zoomCols] = afterZoomIn.split('x').map(Number);
    if (zoomCols < initCols) {
      pass('Alt+scroll UP (zoom in)', `${initial} → ${afterZoomIn}`);
    } else {
      fail('Alt+scroll UP (zoom in)', `Expected fewer cols: ${initial} → ${afterZoomIn}`);
    }

    // ========================================
    // TEST 2: Alt+scroll DOWN → more cols (smaller text)
    // ========================================
    await page.keyboard.down('Alt');
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(300);
    await page.mouse.wheel({ deltaY: 100 });
    await page.keyboard.up('Alt');
    await sleep(1000);

    const afterZoomOut = tmuxSize();
    const [zoomOutCols] = afterZoomOut.split('x').map(Number);
    if (zoomOutCols > zoomCols) {
      pass('Alt+scroll DOWN (zoom out)', `${afterZoomIn} → ${afterZoomOut}`);
    } else {
      fail('Alt+scroll DOWN (zoom out)', `Expected more cols: ${afterZoomIn} → ${afterZoomOut}`);
    }

    // ========================================
    // TEST 3: No CSS transform on <object>
    // ========================================
    const objTransform = await page.evaluate(() => {
      const obj = document.querySelector('.focused object');
      return obj ? obj.style.transform : 'N/A';
    });
    if (!objTransform || objTransform === '' || objTransform === 'none') {
      pass('No CSS transform on <object>', `transform="${objTransform}"`);
    } else {
      fail('No CSS transform on <object>', `Found: "${objTransform}"`);
    }

    // ========================================
    // TEST 4: + button (bigger text = fewer cols)
    // ========================================
    const beforePlus = tmuxSize();
    // Click the + button in the controls overlay
    const plusClicked = await page.evaluate(() => {
      const bar = document.getElementById('term-controls-bar');
      if (!bar) return false;
      const btns = bar.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '+') { btn.click(); return true; }
      }
      return false;
    });
    await sleep(1000);
    const afterPlus = tmuxSize();
    const [beforePlusCols] = beforePlus.split('x').map(Number);
    const [afterPlusCols] = afterPlus.split('x').map(Number);

    if (plusClicked && afterPlusCols < beforePlusCols) {
      pass('+ button (bigger text)', `${beforePlus} → ${afterPlus}`);
    } else {
      fail('+ button', `clicked=${plusClicked}, ${beforePlus} → ${afterPlus}`);
    }

    // ========================================
    // TEST 5: − button (smaller text = more cols)
    // ========================================
    const beforeMinus = tmuxSize();
    const minusClicked = await page.evaluate(() => {
      const bar = document.getElementById('term-controls-bar');
      if (!bar) return false;
      const btns = bar.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '−') { btn.click(); return true; }
      }
      return false;
    });
    await sleep(1000);
    const afterMinus = tmuxSize();
    const [beforeMinusCols] = beforeMinus.split('x').map(Number);
    const [afterMinusCols] = afterMinus.split('x').map(Number);

    if (minusClicked && afterMinusCols > beforeMinusCols) {
      pass('− button (smaller text)', `${beforeMinus} → ${afterMinus}`);
    } else {
      fail('− button', `clicked=${minusClicked}, ${beforeMinus} → ${afterMinus}`);
    }

    // ========================================
    // TEST 6: Alt+drag resize → more cols
    // ========================================
    const beforeDrag = tmuxSize();
    const termRect = await page.evaluate(() => {
      const el = document.querySelector('.focused');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });

    if (termRect) {
      const startX = termRect.right - 30;
      const startY = termRect.bottom - 30;
      await page.mouse.move(startX, startY);
      await page.keyboard.down('Alt');
      await page.mouse.down();
      await page.mouse.move(startX + 150, startY + 80, { steps: 15 });
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await sleep(1500);

      const afterDrag = tmuxSize();
      const [beforeDragCols] = beforeDrag.split('x').map(Number);
      const [afterDragCols] = afterDrag.split('x').map(Number);

      if (afterDragCols > beforeDragCols) {
        pass('Alt+drag resize', `${beforeDrag} → ${afterDrag}`);
      } else {
        fail('Alt+drag resize', `${beforeDrag} → ${afterDrag}`);
      }
    }

    // ========================================
    // TEST 7: ⊡ Optimize fills card
    // ========================================
    const beforeOpt = tmuxSize();
    const optClicked = await page.evaluate(() => {
      const bar = document.getElementById('term-controls-bar');
      if (!bar) return false;
      const btns = bar.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '⊡') { btn.click(); return true; }
      }
      return false;
    });
    await sleep(1500);
    const afterOpt = tmuxSize();

    if (optClicked) {
      pass('⊡ Optimize', `${beforeOpt} → ${afterOpt}`);
    } else {
      fail('⊡ Optimize', 'Button not found');
    }

    await page.screenshot({ path: '/srv/svg-terminal/test-request04.png' });

  } catch (e) {
    fail('Unexpected error', e.message);
  } finally {
    await browser.close();
  }

  console.log('\n=== RESULTS ===');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);
  for (const r of results) {
    if (!r.ok) console.log(`  FAIL: ${r.name} — ${r.reason}`);
  }
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
