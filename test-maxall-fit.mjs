// Test: Max All then Fit Terminal to Card on main slot
import puppeteer from 'puppeteer';
import { createSessionCookie } from './session-cookie.mjs';

const URL = 'http://localhost:3200/';
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
  await page.setCookie({ name: 'cp_session', value: cookie, domain: 'localhost', path: '/', httpOnly: true });

  console.log('Loading dashboard...');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const count = await page.evaluate(() => document.querySelectorAll('.thumbnail-item').length);
    if (count >= 2) break;
  }

  const s1 = 'cp-SVG-UI-Doctor-02';
  const s2 = 'cp-battletech-braskin-1';

  // Focus s1
  await page.evaluate((n) => {
    for (const i of document.querySelectorAll('.thumbnail-item'))
      if (i.dataset.session === n) { i.click(); return; }
  }, s1);
  await sleep(500);

  // Ctrl+click s2
  await page.evaluate((n) => {
    for (const i of document.querySelectorAll('.thumbnail-item'))
      if (i.dataset.session === n) { i.dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true})); return; }
  }, s2);
  await sleep(1500);

  // Set 1main-2side layout
  await page.evaluate(() => window._setActiveLayoutFromMenu('1main-2side'));
  await sleep(1500);

  // Max All
  await page.evaluate(() => window._maxAllFocused());
  await sleep(4000);

  // Screenshot 1: after Max All
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fit-01-after-maxall.png` });
  console.log('Screenshot 1: after Max All');

  // Get info about which card is in slot 0 (main)
  var mainCard = await page.evaluate(() => {
    for (var [name, t] of window._terminals) {
      if (t._slotIndex === 0 && document.querySelector('.focused[data-session="' + name + '"]')) {
        return name;
      }
    }
    return null;
  });
  console.log('Main slot card:', mainCard);

  // Press fit-terminal-to-card on the main slot card
  if (mainCard) {
    await page.evaluate((name) => {
      var t = window._terminals.get(name);
      if (t) window._optimizeTermToCard(t);
    }, mainCard);
    await sleep(3000);
  }

  // Screenshot 2: after fit-terminal-to-card
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fit-02-after-fit-to-card.png` });
  console.log('Screenshot 2: after fit-terminal-to-card');

  // Get card info for comparison
  var info = await page.evaluate(() => {
    var result = [];
    for (var [name, t] of window._terminals) {
      if (!document.querySelector('.focused[data-session="' + name + '"]')) continue;
      var rect = t.dom.getBoundingClientRect();
      result.push({
        name, baseCardW: t.baseCardW, baseCardH: t.baseCardH,
        boundingRect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
        slotRect: t._slotRect, screenCols: t.screenCols, screenRows: t.screenRows
      });
    }
    return result;
  });
  console.log('Final card info:', JSON.stringify(info, null, 2));

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
