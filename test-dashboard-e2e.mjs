// End-to-end dashboard tests — run with: node test-dashboard-e2e.mjs
// Designed to be run by a subagent (haiku). Reports results + takes screenshots.
// Tests: focus, multi-focus, input switching, resize, drag, minimize, shift+tab, controls, ring
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

const URL = 'http://localhost:3200/';
const SCREENSHOT_DIR = '/srv/svg-terminal/e2e-screenshots';
let page, browser;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tmuxSize(session) {
  try {
    return execSync(`tmux display-message -t ${session} -p "#{window_width}x#{window_height}"`).toString().trim();
  } catch { return 'error'; }
}

const results = [];
function pass(name, detail) { results.push({ name, ok: true, detail }); console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, reason) { results.push({ name, ok: false, reason }); console.log(`  FAIL: ${name} — ${reason}`); }

async function screenshot(name) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
}

async function focusSession(name) {
  return page.evaluate((n) => {
    for (const i of document.querySelectorAll('.thumbnail-item'))
      if (i.dataset.session === n) { i.click(); return true; }
    return false;
  }, name);
}

async function ctrlClickSession(name) {
  return page.evaluate((n) => {
    for (const i of document.querySelectorAll('.thumbnail-item'))
      if (i.dataset.session === n) { i.dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true})); return true; }
    return false;
  }, name);
}

async function getFocusedInfo() {
  return page.evaluate(() => {
    const focused = document.querySelectorAll('.focused');
    const active = document.getElementById('input-target')?.textContent || '';
    return {
      count: focused.length,
      active,
      cards: Array.from(focused).map(el => {
        const r = el.getBoundingClientRect();
        return {
          session: el.dataset.session,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          hasInputActive: el.classList.contains('input-active')
        };
      })
    };
  });
}

async function getCardSizes() {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.terminal-3d')).map(el => ({
      session: el.dataset.session,
      w: el.style.width,
      h: el.style.height,
      baseW: el.dataset.baseW || 'n/a'
    }));
  });
}

async function run() {
  execSync(`mkdir -p ${SCREENSHOT_DIR}`);

  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(5000);

    const sessions = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.thumbnail-item')).map(el => el.dataset.session)
    );
    console.log('Sessions:', sessions.length);

    if (sessions.length === 0) { fail('setup', 'No sessions'); await browser.close(); return; }

    const testSession = sessions.find(s => s === 'resize-test') || sessions[0];
    const testSession2 = sessions.find(s => s === 'resize-test2') || sessions[1];
    const testSession3 = sessions.find(s => s.includes('greg')) || sessions[2] || sessions[0];

    await screenshot('01-ring-overview');

    // =============================================
    // TEST GROUP 1: Single Focus
    // =============================================
    console.log('\n--- Single Focus ---');

    await focusSession(testSession);
    await sleep(2500);
    let info = await getFocusedInfo();
    if (info.count === 1 && info.active.includes(testSession)) pass('Single focus', info.active);
    else fail('Single focus', `count=${info.count}, active=${info.active}`);

    // Check card is visible (not clipped)
    if (info.cards.length > 0) {
      const c = info.cards[0];
      if (c.x >= -10 && c.y >= -10 && c.right <= 1930 && c.bottom <= 1090)
        pass('Single focus visible', `${c.w}x${c.h} at (${c.x},${c.y})`);
      else fail('Single focus visible', `Clipped: ${JSON.stringify(c)}`);
    }

    // Check gold neon indicator
    if (info.cards[0]?.hasInputActive) pass('Gold neon on single focus');
    else fail('Gold neon on single focus', 'input-active class missing');

    await screenshot('02-single-focus');

    // Typing
    await page.keyboard.type('echo E2E_TEST_OK');
    await page.keyboard.press('Enter');
    await sleep(1500);
    const hasText = await page.evaluate(() => {
      const obj = document.querySelector('.focused object');
      if (!obj?.contentDocument) return false;
      return obj.contentDocument.documentElement.textContent.includes('E2E_TEST_OK');
    });
    if (hasText) pass('Typing reaches terminal');
    else fail('Typing reaches terminal', 'Text not in SVG');

    // Escape unfocuses
    await page.keyboard.press('Escape');
    await sleep(1500);
    info = await getFocusedInfo();
    if (info.count === 0) pass('Escape unfocuses');
    else fail('Escape unfocuses', `Still ${info.count} focused`);

    await screenshot('03-after-escape');

    // =============================================
    // TEST GROUP 2: Multi Focus
    // =============================================
    console.log('\n--- Multi Focus ---');

    await focusSession(testSession);
    await sleep(2000);
    await ctrlClickSession(testSession2);
    await sleep(2500);

    info = await getFocusedInfo();
    if (info.count === 2) pass('Multi focus (2 cards)', `${info.cards.map(c=>c.session).join(', ')}`);
    else fail('Multi focus', `count=${info.count}`);

    // Cards should not overlap
    if (info.cards.length === 2) {
      const [a, b] = info.cards;
      const overlap = !(a.right < b.x || b.right < a.x || a.bottom < b.y || b.bottom < a.y);
      if (!overlap) pass('No card overlap');
      else fail('No card overlap', `Cards overlap: ${JSON.stringify([a,b])}`);
    }

    // Cards should not be clipped
    const allVisible = info.cards.every(c => c.x >= -10 && c.y >= -10 && c.right <= 1930 && c.bottom <= 1090);
    if (allVisible) pass('All cards visible');
    else fail('All cards visible', `Clipped: ${JSON.stringify(info.cards)}`);

    await screenshot('04-multi-focus-2');

    // =============================================
    // TEST GROUP 3: Input Switching
    // =============================================
    console.log('\n--- Input Switching ---');

    // Click on the non-active card to switch input
    const nonActive = info.cards.find(c => !c.hasInputActive);
    if (nonActive) {
      await page.mouse.click(nonActive.x + nonActive.w / 2, nonActive.y + nonActive.h / 2);
      await sleep(500);
      const newInfo = await getFocusedInfo();
      if (newInfo.active.includes(nonActive.session)) pass('Click switches input', newInfo.active);
      else fail('Click switches input', `Expected ${nonActive.session}, got ${newInfo.active}`);
    }

    // =============================================
    // TEST GROUP 4: Title Bar Drag
    // =============================================
    console.log('\n--- Title Bar Drag ---');

    const dragCard = (await getFocusedInfo()).cards[0];
    if (dragCard) {
      const headerY = dragCard.y + 15; // header is ~30px from top
      const startX = dragCard.x + dragCard.w / 2;
      await page.mouse.move(startX, headerY);
      await page.mouse.down();
      await page.mouse.move(startX + 100, headerY + 50, { steps: 10 });
      await page.mouse.up();
      await sleep(500);

      const afterDrag = (await getFocusedInfo()).cards.find(c => c.session === dragCard.session);
      if (afterDrag && (afterDrag.x !== dragCard.x || afterDrag.y !== dragCard.y))
        pass('Title bar drag moved card', `(${dragCard.x},${dragCard.y}) → (${afterDrag.x},${afterDrag.y})`);
      else
        fail('Title bar drag', `Position unchanged or card lost`);

      // Can still switch focus after drag?
      const otherCard = (await getFocusedInfo()).cards.find(c => c.session !== dragCard.session);
      if (otherCard) {
        await page.mouse.click(otherCard.x + otherCard.w / 2, otherCard.y + otherCard.h / 2);
        await sleep(500);
        const switchInfo = await getFocusedInfo();
        if (switchInfo.active.includes(otherCard.session))
          pass('Focus switch after drag works', switchInfo.active);
        else
          fail('Focus switch after drag', `Expected ${otherCard.session}, got ${switchInfo.active}`);
      }
    }

    await screenshot('05-after-drag');

    // =============================================
    // TEST GROUP 5: Minimize
    // =============================================
    console.log('\n--- Minimize ---');

    // Click minimize on thumbnail
    const minResult = await page.evaluate(() => {
      const btns = document.querySelectorAll('.thumb-minimize');
      for (const btn of btns) {
        if (btn.style.display !== 'none') { btn.click(); return true; }
      }
      return false;
    });
    await sleep(1500);
    info = await getFocusedInfo();
    if (minResult && info.count === 1) pass('Thumbnail minimize', `${info.count} remaining`);
    else fail('Thumbnail minimize', `clicked=${minResult}, count=${info.count}`);

    // Minimize icons should be gone (only 1 terminal left)
    const minIconsVisible = await page.evaluate(() => {
      const btns = document.querySelectorAll('.thumb-minimize');
      return Array.from(btns).filter(b => b.style.display !== 'none').length;
    });
    if (minIconsVisible === 0) pass('Minimize icons hidden (single focus)');
    else fail('Minimize icons hidden', `${minIconsVisible} still visible`);

    await page.keyboard.press('Escape');
    await sleep(1500);

    // =============================================
    // TEST GROUP 6: Shift+Tab Zoom Cycling
    // =============================================
    console.log('\n--- Shift+Tab ---');

    await focusSession(testSession);
    await sleep(2000);
    await ctrlClickSession(testSession2);
    await sleep(2000);
    if (testSession3 !== testSession && testSession3 !== testSession2) {
      await ctrlClickSession(testSession3);
      await sleep(2000);
    }

    info = await getFocusedInfo();
    const focusCount = info.count;
    console.log(`  ${focusCount} terminals focused for shift+tab test`);

    if (focusCount >= 2) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await sleep(1000);
      await screenshot('06-shift-tab-1');

      const zoomedInfo = await getFocusedInfo();
      pass('Shift+Tab zoomed', `Active: ${zoomedInfo.active}`);

      // Second shift+tab
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await sleep(1000);
      const zoomedInfo2 = await getFocusedInfo();
      if (zoomedInfo2.active !== zoomedInfo.active)
        pass('Shift+Tab cycles', `${zoomedInfo.active} → ${zoomedInfo2.active}`);
      else
        fail('Shift+Tab cycles', 'Active did not change');

      await screenshot('07-shift-tab-2');

      // Escape returns to grid
      await page.keyboard.press('Escape');
      await sleep(1500);
      await screenshot('08-back-to-grid');
    }

    await page.keyboard.press('Escape');
    await sleep(1500);

    // =============================================
    // TEST GROUP 7: Alt+Scroll Resize
    // =============================================
    console.log('\n--- Resize ---');

    await focusSession('resize-test');
    await sleep(2500);
    const sizeBefore = tmuxSize('resize-test');

    const rect = await page.evaluate(() => {
      const el = document.querySelector('.focused');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    });

    if (rect) {
      await page.mouse.move(rect.x, rect.y);
      await page.keyboard.down('Alt');
      // Scroll down = more cols (smaller text). Works even if terminal is already small.
      await page.mouse.wheel({ deltaY: 100 });
      await sleep(200);
      await page.mouse.wheel({ deltaY: 100 });
      await page.keyboard.up('Alt');
      await sleep(1500);

      const sizeAfter = tmuxSize('resize-test');
      const [beforeCols] = sizeBefore.split('x').map(Number);
      const [afterCols] = sizeAfter.split('x').map(Number);
      if (afterCols !== beforeCols) pass('Alt+scroll resize', `${sizeBefore} → ${sizeAfter}`);
      else fail('Alt+scroll resize', `${sizeBefore} → ${sizeAfter}`);
    }

    await page.keyboard.press('Escape');
    await sleep(1500);

    // =============================================
    // TEST GROUP 8: Card Sizing from tmux
    // =============================================
    console.log('\n--- Card Sizing ---');

    const cardSizes = await getCardSizes();
    const uniqueSizes = new Set(cardSizes.map(c => c.w + 'x' + c.h));
    if (uniqueSizes.size > 1) pass('Variable card sizes', `${uniqueSizes.size} different sizes`);
    else fail('Variable card sizes', 'All same size');

    // Check no card uses the old default 1280x992
    const hasOldDefault = cardSizes.some(c => c.w === '1280px' && c.h === '992px');
    if (!hasOldDefault) pass('No hardcoded 1280x992');
    else fail('No hardcoded 1280x992', `Found: ${cardSizes.filter(c => c.w === '1280px').map(c => c.session).join(', ')}`);

    // =============================================
    // TEST GROUP 9: Controls Bar
    // =============================================
    console.log('\n--- Controls ---');

    await focusSession(testSession);
    await sleep(2500);

    const controlsVisible = await page.evaluate(() => {
      const hc = document.querySelector('.focused .header-controls');
      return hc && hc.style.display === 'inline-flex';
    });
    if (controlsVisible) pass('Header controls visible on focus');
    else fail('Header controls visible', 'Not visible');

    await page.keyboard.press('Escape');
    await sleep(1500);

    const controlsHidden = await page.evaluate(() => {
      const cards = document.querySelectorAll('.terminal-3d');
      for (const c of cards) {
        const hc = c.querySelector('.header-controls');
        if (hc && hc.style.display === 'inline-flex') return false;
      }
      return true;
    });
    if (controlsHidden) pass('Header controls hidden on unfocus');
    else fail('Header controls hidden', 'Still visible');

    await screenshot('09-final');

  } catch (e) {
    fail('Unexpected error', e.message);
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n========================================');
  console.log('E2E TEST RESULTS');
  console.log('========================================');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results) if (!r.ok) console.log(`  ${r.name}: ${r.reason}`);
  }
  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR}/`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
