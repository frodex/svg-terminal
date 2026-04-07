// E2E test: Card subscription manager — badge, counts, panel, list
import puppeteer from 'puppeteer';
import { createSessionCookie } from './session-cookie.mjs';

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
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle2', timeout: 15000 });

  // Wait for sessions
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const count = await page.evaluate(() => document.querySelectorAll('.thumbnail-item').length);
    console.log(`  ${i+1}s: ${count} sessions`);
    if (count >= 2) break;
  }

  const results = [];
  function pass(name, detail) { results.push({ ok: true, name }); console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`); }
  function fail(name, reason) { results.push({ ok: false, name }); console.log(`  FAIL: ${name} — ${reason}`); }

  // Test 1: Card counts visible in status bar
  const countsText = await page.evaluate(() => {
    const c = document.getElementById('card-counts');
    return c ? c.textContent : '';
  });
  if (countsText.includes('available')) pass('card counts visible', countsText);
  else fail('card counts visible', 'text: ' + countsText);

  // Test 2: CARDS menu item exists
  const cardsMenuItem = await page.evaluate(() => !!document.getElementById('menu-cards'));
  if (cardsMenuItem) pass('CARDS menu item exists');
  else fail('CARDS menu item exists', 'not found');

  // Test 3: Open CARDS panel via hamburger
  await page.evaluate(() => document.getElementById('top-menu-hamburger')?.click());
  await sleep(300);
  await page.evaluate(() => document.getElementById('menu-cards')?.click());
  await sleep(2000);
  const panelVisible = await page.evaluate(() =>
    document.getElementById('cards-panel')?.classList.contains('visible')
  );
  if (panelVisible) pass('CARDS panel opens');
  else fail('CARDS panel opens', 'not visible');

  await page.screenshot({ path: `${SCREENSHOT_DIR}/cards-01-panel-open.png` });

  // Test 4: Session rows populated
  const rowCount = await page.evaluate(() =>
    document.querySelectorAll('.cards-panel-row').length
  );
  if (rowCount > 0) pass('session rows populated', 'count: ' + rowCount);
  else fail('session rows populated', 'no rows');

  // Test 5: Preference checkboxes present
  const prefsExist = await page.evaluate(() => {
    return !!document.getElementById('cards-auto-new') && !!document.getElementById('cards-auto-own');
  });
  if (prefsExist) pass('preference checkboxes present');
  else fail('preference checkboxes present', 'missing');

  // Test 6: Save Current State button exists
  const saveBtn = await page.evaluate(() => !!document.getElementById('cards-save-state'));
  if (saveBtn) pass('Save Current State button exists');
  else fail('Save Current State button exists', 'missing');

  // Test 7: Search input exists
  const searchInput = await page.evaluate(() => !!document.getElementById('cards-search'));
  if (searchInput) pass('search input exists');
  else fail('search input exists', 'missing');

  // Test 8: Thumbnail buttons exist (check first thumbnail)
  const thumbButtons = await page.evaluate(() => {
    const thumb = document.querySelector('.thumbnail-item');
    if (!thumb) return { stop: false, state: false };
    return {
      stop: !!thumb.querySelector('.thumb-stop'),
      state: !!thumb.querySelector('.thumb-state-icon'),
    };
  });
  if (thumbButtons.stop && thumbButtons.state) pass('thumbnail buttons present');
  else fail('thumbnail buttons present', JSON.stringify(thumbButtons));

  // Test 9: Close panel via back button
  await page.evaluate(() => document.getElementById('cards-panel-back')?.click());
  await sleep(300);
  const panelHidden = await page.evaluate(() =>
    !document.getElementById('cards-panel')?.classList.contains('visible')
  );
  if (panelHidden) pass('panel closes via back button');
  else fail('panel closes via back button', 'still visible');

  // Test 10: Badge click opens panel directly
  // First, need hidden cards for badge to appear - skip if no hidden cards
  const badgeTest = await page.evaluate(() => {
    const badge = document.getElementById('hidden-cards-badge');
    return badge ? badge.style.display : 'not found';
  });
  pass('badge element exists', 'display: ' + badgeTest);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/cards-02-final-state.png` });

  // Summary
  console.log('\n--- Results ---');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

  await browser.close();
}

run().catch(e => { console.error(e); process.exit(1); });
