// Tests for request_03 fixes:
// 1. Alt+scroll auto-optimize (debounced)
// 2. Alt+drag resize sends correct PTY resize
// 3. Title bar resizes with card
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  // Capture console for debugging
  page.on('console', msg => {
    if (msg.text().includes('RESIZE')) console.log('    [browser] ' + msg.text());
  });

  try {
    await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
    // Wait for session discovery — dashboard polls /api/sessions periodically
    await sleep(5000);

    // Focus resize-test — retry a few times in case session hasn't appeared yet
    let focused = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      focused = await page.evaluate(() => {
        const items = document.querySelectorAll('.thumbnail-item');
        for (const item of items) {
          if (item.dataset.session === 'resize-test') { item.click(); return true; }
        }
        return false;
      });
      if (focused) break;
      console.log('  Waiting for resize-test to appear in sidebar... attempt ' + (attempt + 1));
      await sleep(3000);
    }
    if (!focused) { fail('Setup', 'Could not focus resize-test'); await browser.close(); return; }
    await sleep(2500);

    // Get initial terminal size from tmux
    const initialSize = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
    console.log('  Initial tmux size: ' + initialSize);

    // ========================================
    // TEST 1: Alt+scroll auto-optimize
    // ========================================
    try {
      const focusedRect = await page.evaluate(() => {
        const el = document.querySelector('.focused');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      });

      if (focusedRect) {
        // Alt+scroll to zoom in
        await page.mouse.move(focusedRect.x, focusedRect.y);
        await page.keyboard.down('Alt');
        await page.mouse.wheel({ deltaY: -300 });
        await sleep(100);
        await page.mouse.wheel({ deltaY: -300 });
        await page.keyboard.up('Alt');

        // Check scale is applied
        const scaleAfterZoom = await page.evaluate(() => {
          const obj = document.querySelector('.focused object');
          return obj ? obj.style.transform : 'none';
        });
        console.log('  Scale after zoom: ' + scaleAfterZoom);

        // Wait for debounce (500ms) + resize propagation
        await sleep(2000);

        // Check scale was reset to 1.0 by auto-optimize
        const scaleAfterOptimize = await page.evaluate(() => {
          const obj = document.querySelector('.focused object');
          return obj ? obj.style.transform : 'none';
        });
        console.log('  Scale after auto-optimize: ' + scaleAfterOptimize);

        // Check tmux resized
        const sizeAfterZoom = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
        console.log('  Tmux size after auto-optimize: ' + sizeAfterZoom);

        if (scaleAfterOptimize === 'scale(1)' && sizeAfterZoom !== initialSize) {
          pass('Alt+scroll auto-optimize', `${initialSize} → ${sizeAfterZoom}, scale reset`);
        } else if (scaleAfterOptimize === 'scale(1)') {
          pass('Alt+scroll auto-optimize', `scale reset to 1, size: ${sizeAfterZoom}`);
        } else {
          fail('Alt+scroll auto-optimize', `scale=${scaleAfterOptimize}, size=${sizeAfterZoom}`);
        }
      } else {
        fail('Alt+scroll auto-optimize', 'No focused element');
      }
    } catch (e) { fail('Alt+scroll auto-optimize', e.message); }

    // Wait for PTY to settle
    await sleep(1000);

    // Get size before drag test
    const sizeBeforeDrag = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
    console.log('  Size before drag: ' + sizeBeforeDrag);

    // ========================================
    // TEST 2: Alt+drag card resize
    // ========================================
    try {
      const termRect = await page.evaluate(() => {
        const el = document.querySelector('.focused');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      });

      if (termRect) {
        const startX = termRect.right - 50;
        const startY = termRect.bottom - 50;

        await page.mouse.move(startX, startY);
        await page.keyboard.down('Alt');
        await page.mouse.down();
        // Drag right and down to make card bigger
        await page.mouse.move(startX + 150, startY + 100, { steps: 15 });
        await page.mouse.up();
        await page.keyboard.up('Alt');
        await sleep(2000);

        const sizeAfterDrag = execSync('tmux display-message -t resize-test -p "#{window_width}x#{window_height}"').toString().trim();
        console.log('  Tmux size after drag: ' + sizeAfterDrag);

        if (sizeAfterDrag !== sizeBeforeDrag) {
          pass('Alt+drag resize', `${sizeBeforeDrag} → ${sizeAfterDrag}`);
        } else {
          fail('Alt+drag resize', `Size unchanged: ${sizeAfterDrag}`);
        }
      } else {
        fail('Alt+drag resize', 'No focused element');
      }
    } catch (e) { fail('Alt+drag resize', e.message); }

    // ========================================
    // TEST 3: Title bar resizes with card
    // ========================================
    try {
      // Get card width and inner width
      const dims = await page.evaluate(() => {
        const el = document.querySelector('.focused');
        const inner = el ? el.querySelector('.terminal-inner') : null;
        return {
          cardW: el ? el.style.width : 'none',
          innerW: inner ? inner.style.width : 'none',
          cardH: el ? el.style.height : 'none',
          innerH: inner ? inner.style.height : 'none'
        };
      });
      console.log('  Card dims: ' + JSON.stringify(dims));

      if (dims.cardW !== 'none' && dims.innerW !== 'none' && dims.cardW === dims.innerW) {
        pass('Title bar resizes with card', `card=${dims.cardW}, inner=${dims.innerW}`);
      } else if (dims.innerW === 'none' || dims.innerW === '') {
        fail('Title bar resize', `inner width not set: ${JSON.stringify(dims)}`);
      } else {
        fail('Title bar resize', `Mismatch: card=${dims.cardW}, inner=${dims.innerW}`);
      }
    } catch (e) { fail('Title bar resize', e.message); }

    // Screenshot
    await page.screenshot({ path: '/srv/svg-terminal/test-request03.png' });
    console.log('\n  Screenshot: test-request03.png');

  } catch (e) {
    fail('Setup', e.message);
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
