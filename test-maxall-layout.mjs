// Test: Max All layout pipeline — 2 cards, layout switching, slot preservation
// Run with: node test-maxall-layout.mjs
import puppeteer from 'puppeteer';
import { createSessionCookie } from './session-cookie.mjs';

const PORT = 3200;
const URL = `http://localhost:${PORT}/`;
const SECRET = process.env.AUTH_SECRET || '4cfe7fd26a830a2df25413b6aceb865c280eb45a42a097fd22fe88fdd67bffa2';
const SCREENSHOT_DIR = '/srv/svg-terminal/e2e-screenshots';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const cookie = createSessionCookie({ email: 'frodex310@gmail.com', linuxUser: 'root' }, SECRET, 3600);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Set auth cookie before loading
  await page.setCookie({
    name: 'cp_session',
    value: cookie,
    domain: 'localhost',
    path: '/',
    httpOnly: true
  });

  console.log('Loading dashboard...');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  console.log('Page URL:', page.url());
  console.log('Page title:', await page.title());
  // Wait for sessions to appear via WebSocket discovery
  console.log('Waiting for sessions to load...');
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const count = await page.evaluate(() => document.querySelectorAll('.thumbnail-item').length);
    console.log(`  ${i+1}s: ${count} sessions`);
    if (count >= 2) break;
  }

  // Get available sessions
  const sessions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.thumbnail-item')).map(el => el.dataset.session);
  });
  console.log('Available sessions:', sessions);

  if (sessions.length < 2) {
    console.log('Need at least 2 sessions for this test');
    await browser.close();
    return;
  }

  // Use the same cards the user is testing with
  const s1 = 'cp-SVG-UI-Doctor-02';
  const s2 = 'cp-battletech-braskin-1';
  console.log(`Using: ${s1}, ${s2}`);

  // Helper: focus two sessions
  async function focusTwo() {
    await page.evaluate((n) => {
      for (const i of document.querySelectorAll('.thumbnail-item'))
        if (i.dataset.session === n) { i.click(); return; }
    }, s1);
    await sleep(500);
    await page.evaluate((n) => {
      for (const i of document.querySelectorAll('.thumbnail-item'))
        if (i.dataset.session === n) { i.dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true})); return; }
    }, s2);
    await sleep(1500); // wait for layout
  }

  // Helper: set layout
  async function setLayout(key) {
    await page.evaluate((k) => {
      window._setActiveLayoutFromMenu && window._setActiveLayoutFromMenu(k);
      // Fallback: call directly
      if (typeof setActiveLayoutFromMenu === 'function') setActiveLayoutFromMenu(k);
    }, key);
    await sleep(1500);
  }

  // Helper: press Max All
  async function pressMaxAll() {
    await page.evaluate(() => {
      window._maxAllFocused && window._maxAllFocused();
    });
    await sleep(4000); // wait for resize responses + morph animation + render
  }

  // Helper: get card info with slot data
  async function getCardInfo() {
    return page.evaluate(() => {
      var result = [];
      for (var [name, t] of window._terminals || []) {
        if (!document.querySelector('.focused[data-session="' + name + '"]')) continue;
        var domW = parseInt(t.dom.style.width);
        var domH = parseInt(t.dom.style.height);
        var rect = t.dom.getBoundingClientRect();
        result.push({
          name: name,
          baseCardW: t.baseCardW,
          baseCardH: t.baseCardH,
          domStyleW: domW,
          domStyleH: domH,
          boundingRect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
          slotIndex: t._slotIndex,
          slotRect: t._slotRect,
          slotFit: t._slotFit,
          screenCols: t.screenCols,
          screenRows: t.screenRows,
        });
      }
      return result;
    });
  }

  // Helper: get slot rects
  async function getSlotRects() {
    return page.evaluate(() => window._allSlotRects || []);
  }

  // === TEST SEQUENCE ===

  // 1. Focus 2 cards
  console.log('\n--- Step 1: Focus 2 cards ---');
  await focusTwo();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-01-two-focused.png` });
  var info = await getCardInfo();
  console.log('Cards after focus:', JSON.stringify(info, null, 2));

  // 2. START with 1main-2side (the failing case)
  console.log('\n--- Step 2: 1 Main + 2 Side layout ---');
  await setLayout('1main-2side');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-02-1main-2side.png` });
  info = await getCardInfo();
  console.log('Cards in 1main-2side:', JSON.stringify(info, null, 2));

  // 3. Max All in 1main-2side (reported as broken when starting here)
  console.log('\n--- Step 3: Max All (1main-2side) ---');
  await pressMaxAll();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-03-1main-2side-maxed.png` });
  info = await getCardInfo();
  console.log('Cards after Max All:', JSON.stringify(info, null, 2));

  // 4. Switch to 2-up vertical
  console.log('\n--- Step 4: Switch to 2-Up Vertical ---');
  await setLayout('2up-v');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-04-2up-v.png` });
  info = await getCardInfo();
  console.log('Cards in 2up-v:', JSON.stringify(info, null, 2));

  // 5. Max All in 2-up vertical
  console.log('\n--- Step 5: Max All (2-up vertical) ---');
  await pressMaxAll();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-05-2up-v-maxed.png` });
  info = await getCardInfo();
  console.log('Cards after Max All:', JSON.stringify(info, null, 2));

  // 6. Back to 1main-2side
  console.log('\n--- Step 6: Back to 1 Main + 2 Side ---');
  await setLayout('1main-2side');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-06-1main-2side-again.png` });
  info = await getCardInfo();
  console.log('Cards in 1main-2side again:', JSON.stringify(info, null, 2));

  // 7. Max All again
  console.log('\n--- Step 7: Max All (1main-2side again) ---');
  await pressMaxAll();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/maxall-07-1main-2side-maxed-again.png` });
  info = await getCardInfo();
  console.log('Cards after final Max All:', JSON.stringify(info, null, 2));

  console.log('\nScreenshots saved to', SCREENSHOT_DIR);
  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
