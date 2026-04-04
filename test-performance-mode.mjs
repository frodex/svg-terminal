// Test performance detection and mode switching
import puppeteer from 'puppeteer';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('=== Performance Mode Integration Test ===\n');

  console.log('Test 1: Software renderer detection');
  var browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  var state = await page.evaluate(() => window._perfState());

  console.log('  GPU:', state.gpu?.renderer);
  console.log('  Software:', state.gpu?.isSoftware);
  console.log('  Tier:', state.perfTier);
  console.log('  Shadows:', state.shadowVisible);
  console.log('  Ring speed:', state.ringSpeed);

  if (state.gpu?.isSoftware && (state.perfTier >= 1)) {
    console.log('  PASS: Software renderer detected, Tier 1+ applied\n');
  } else {
    console.log('  FAIL: Expected tier >= 1 for software renderer\n');
  }

  console.log('Test 2: Manual mode cycling');
  // input-bar is off-screen until a terminal is focused — use script click, not Puppeteer hit-testing
  await page.evaluate(() => {
    var el = document.getElementById('perf-indicator');
    if (el) el.click();
  });
  await sleep(500);
  var full = await page.evaluate(() => window._perfState());
  console.log('  Full mode — perfTier:', full.perfTier, 'shadows:', full.shadowVisible, 'ring:', full.ringSpeed);
  if (full.perfTier === 0 && full.shadowVisible === true && full.ringSpeed > 0) {
    console.log('  PASS: Full mode restored all effects\n');
  } else {
    console.log('  FAIL: Full mode did not restore all effects\n');
  }

  console.log('Test 3: Tier 2 card visibility');
  await page.evaluate(() => {
    var el = document.getElementById('perf-indicator');
    if (el) { el.click(); }
  });
  await sleep(300);
  await page.evaluate(() => {
    var el = document.getElementById('perf-indicator');
    if (el) { el.click(); }
  });
  await sleep(500);
  var minState = await page.evaluate(() => window._perfState());
  console.log('  perfTier:', minState.perfTier, 'Hidden:', minState.hiddenCount, '/', minState.terminalCount);
  if (minState.perfTier === 2 && minState.hiddenCount === minState.terminalCount) {
    console.log('  PASS: All cards hidden in Tier 2 (no focused sessions)\n');
  } else if (minState.perfTier === 2 && minState.hiddenCount > 0) {
    console.log('  PASS: Tier 2 active, ' + minState.hiddenCount + ' unfocused cards hidden\n');
  } else {
    console.log('  FAIL: Expected Tier 2 with hidden cards\n');
  }

  await browser.close();
  console.log('=== Done ===');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
