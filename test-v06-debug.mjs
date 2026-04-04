// test-v06-debug.mjs — Puppeteer diagnostic tests for shared WebSocket architecture
// Run: node test-v06-debug.mjs
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

const URL = 'http://localhost:3201/';
const SCREENSHOT_DIR = '/srv/svg-terminal/e2e-screenshots';

let page, browser;
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const results = [];
function pass(name, detail) { results.push({ name, ok: true, detail }); console.log(`  PASS: ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, reason) { results.push({ name, ok: false, reason }); console.log(`  FAIL: ${name} — ${reason}`); }

async function screenshot(name) {
  try { execSync(`mkdir -p ${SCREENSHOT_DIR}`); } catch {}
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
  console.log(`  [screenshot: ${name}]`);
}

// =========================================================================
// TEST 1: Do cards load with content?
// =========================================================================
async function test1_cardsLoadContent() {
  console.log('\n=== TEST 1: Do cards load with content? ===');

  // Navigate and wait for page to settle
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(6000); // Wait for SVG objects to load + WS to deliver data

  await screenshot('test1-after-load');

  // Get all terminal cards
  const cardInfo = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    const results = [];
    for (const card of cards) {
      const session = card.dataset.session;
      const obj = card.querySelector('object');
      let hasContent = false;
      let sharedWsActive = false;
      let renderMessageExists = false;
      let pendingCount = 0;
      let linesCount = 0;
      let error = null;

      try {
        if (obj && obj.contentWindow) {
          renderMessageExists = typeof obj.contentWindow.renderMessage === 'function';
          // Check if SVG has rendered content - look for text elements
          const svgDoc = obj.contentDocument;
          if (svgDoc) {
            const textEls = svgDoc.querySelectorAll('text');
            // Count text elements that have non-empty content
            let nonEmpty = 0;
            for (const t of textEls) {
              if (t.textContent.trim().length > 0) nonEmpty++;
            }
            hasContent = nonEmpty > 2; // More than just measure text
            linesCount = nonEmpty;
          }
        }
      } catch (e) {
        error = e.message;
      }

      results.push({ session, hasContent, renderMessageExists, linesCount, error });
    }
    return results;
  });

  console.log(`  Found ${cardInfo.length} cards`);

  let emptyCards = 0;
  let noRenderMsg = 0;
  for (const c of cardInfo) {
    if (!c.hasContent) {
      emptyCards++;
      console.log(`  EMPTY: ${c.session} (lines=${c.linesCount}, renderMessage=${c.renderMessageExists}, err=${c.error})`);
    }
    if (!c.renderMessageExists) {
      noRenderMsg++;
      console.log(`  NO renderMessage: ${c.session}`);
    }
  }

  if (emptyCards === 0) {
    pass('Cards load content', `All ${cardInfo.length} cards have content`);
  } else {
    fail('Cards load content', `${emptyCards}/${cardInfo.length} cards are empty`);
  }

  // Now check _sharedWsActive via frames
  const sharedWsInfo = [];
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const url = frame.url();
      if (!url.includes('terminal.svg')) continue;
      const info = await frame.evaluate(() => {
        // _sharedWsActive is a closure var, not on window. But we can check if
        // renderMessage has been called by testing if any lines were rendered.
        const textEls = document.querySelectorAll('text');
        let nonEmpty = 0;
        for (const t of textEls) {
          if (t.textContent.trim().length > 0) nonEmpty++;
        }
        return {
          wsReady: window._wsReady || false,
          hasScreenCallback: typeof window._screenCallback === 'function',
          hasRenderMessage: typeof window.renderMessage === 'function',
          hasSendToWs: typeof window.sendToWs === 'function',
          renderedLines: nonEmpty
        };
      });
      sharedWsInfo.push(info);
    } catch (e) {
      // frame may have detached
    }
  }

  console.log(`  SVG frames checked: ${sharedWsInfo.length}`);
  for (const info of sharedWsInfo.slice(0, 3)) {
    console.log(`    wsReady=${info.wsReady}, screenCallback=${info.hasScreenCallback}, renderMessage=${info.hasRenderMessage}, lines=${info.renderedLines}`);
  }

  // Check pending messages
  const pendingInfo = await page.evaluate(() => {
    // We can't access the module-level `terminals` Map directly, but we can
    // check the objects for pending messages
    const cards = document.querySelectorAll('.terminal-3d');
    const pending = [];
    for (const card of cards) {
      const session = card.dataset.session;
      const obj = card.querySelector('object');
      let hasPending = false;
      try {
        // _pendingMessages is on the terminal entry, not on the SVG
        // We can't access it from here. But we CAN check if the SVG loaded.
        if (obj && obj.contentDocument) {
          hasPending = false; // SVG loaded, so pending should have flushed
        } else {
          hasPending = true; // SVG not loaded — messages would be pending
        }
      } catch (e) {}
      pending.push({ session, svgLoaded: !hasPending });
    }
    return pending;
  });

  const notLoaded = pendingInfo.filter(p => !p.svgLoaded);
  if (notLoaded.length > 0) {
    fail('SVG objects loaded', `${notLoaded.length} SVGs not loaded: ${notLoaded.map(p => p.session).join(', ')}`);
  } else {
    pass('SVG objects loaded', `All ${pendingInfo.length} SVGs loaded`);
  }

  return { cardInfo, emptyCards };
}

// =========================================================================
// TEST 2: Does typing work on local tmux cards?
// =========================================================================
async function test2_typingLocal() {
  console.log('\n=== TEST 2: Does typing work on local tmux sessions? ===');

  // Find a local session (not cp-*), prefer test_control or demo
  const localSessions = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    const locals = [];
    for (const card of cards) {
      const s = card.dataset.session;
      if (s && !s.startsWith('cp-') && !s.startsWith('browser-')) {
        locals.push(s);
      }
    }
    return locals;
  });

  if (localSessions.length === 0) {
    fail('Typing on local session', 'No local sessions found');
    return;
  }

  const testSession = localSessions.find(s => s === 'test_control') || localSessions.find(s => s === 'demo') || localSessions[0];
  console.log(`  Testing with session: ${testSession}`);

  // Focus the session by clicking its thumbnail
  const focused = await page.evaluate((name) => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const i of items) {
      if (i.dataset.session === name) { i.click(); return true; }
    }
    return false;
  }, testSession);

  if (!focused) {
    fail('Typing on local session', `Could not focus ${testSession}`);
    return;
  }

  await sleep(1500); // Wait for focus animation

  // Get screen content before typing
  const beforeContent = await getFrameContent(testSession);
  console.log(`  Before: ${beforeContent ? beforeContent.substring(0, 80) + '...' : 'NO CONTENT'}`);

  // Type via page.keyboard (goes through dashboard keydown handler -> sendInput -> dashboard WS)
  for (const char of 'echo test123') {
    await page.keyboard.press(char === ' ' ? 'Space' : char);
    await sleep(30);
  }
  await page.keyboard.press('Enter');
  await sleep(1500); // Wait for tmux + server capture cycle

  const afterContent = await getFrameContent(testSession);
  console.log(`  After: ${afterContent ? afterContent.substring(0, 80) + '...' : 'NO CONTENT'}`);

  if (beforeContent !== afterContent) {
    pass('Typing on local session', `Screen updated after keystroke on ${testSession}`);
  } else {
    fail('Typing on local session', `Screen did NOT change after keystroke on ${testSession}`);
  }

  await screenshot('test2-after-typing');

  // Unfocus
  await page.keyboard.press('Escape');
  await sleep(500);
}

// =========================================================================
// TEST 3: Does typing work on cp-* sessions?
// =========================================================================
async function test3_typingCp() {
  console.log('\n=== TEST 3: Does typing work on cp-* sessions? ===');

  const cpSessions = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    const cps = [];
    for (const card of cards) {
      const s = card.dataset.session;
      if (s && s.startsWith('cp-')) cps.push(s);
    }
    return cps;
  });

  if (cpSessions.length === 0) {
    console.log('  SKIP: No cp-* sessions found');
    return;
  }

  const testSession = cpSessions[0];
  console.log(`  Testing with session: ${testSession}`);

  // Focus it
  const focused = await page.evaluate((name) => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const i of items) {
      if (i.dataset.session === name) { i.click(); return true; }
    }
    return false;
  }, testSession);

  if (!focused) {
    fail('Typing on cp-* session', `Could not focus ${testSession}`);
    return;
  }

  await sleep(1500);

  // Check for errors in console
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Try to type (just check it doesn't crash)
  await page.keyboard.press('Space');
  await sleep(500);

  if (consoleErrors.length === 0) {
    pass('Typing on cp-* session', `No errors when typing on ${testSession}`);
  } else {
    fail('Typing on cp-* session', `Errors: ${consoleErrors.join('; ')}`);
  }

  await screenshot('test3-cp-typing');

  await page.keyboard.press('Escape');
  await sleep(500);
}

// =========================================================================
// TEST 4: Connection count
// =========================================================================
async function test4_connectionCount() {
  console.log('\n=== TEST 4: WebSocket connection count ===');

  // Navigate fresh
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(6000);

  // Count WebSocket connections via CDP
  const client = await page.createCDPSession();

  // Get all WebSocket frames from performance logs
  const wsConnections = await page.evaluate(() => {
    // We can check performance entries for WS connections
    const entries = performance.getEntries();
    const wsEntries = entries.filter(e => e.name && (e.name.includes('ws://') || e.name.includes('wss://')));
    return wsEntries.map(e => e.name);
  });

  // Alternative: count from SVG frames
  const frameWsInfo = [];
  const frames = page.frames();
  let dashboardWsCount = 0;
  let perCardWsCount = 0;

  for (const frame of frames) {
    try {
      const url = frame.url();
      if (url.includes('terminal.svg')) {
        const info = await frame.evaluate(() => ({
          wsReady: window._wsReady || false,
          url: window.location.href
        }));
        if (info.wsReady) perCardWsCount++;
        frameWsInfo.push(info);
      }
    } catch (e) {}
  }

  // Check dashboard WS
  const dashboardWsReady = await page.evaluate(() => {
    // dashboardWs is module-level, can't access directly
    // But we can check via a side effect: if the input-bar exists and works
    return true; // Dashboard WS should be connected if page loaded
  });

  console.log(`  SVG frames with per-card WS ready: ${perCardWsCount}/${frameWsInfo.length}`);
  console.log(`  Total SVG frames (terminal objects): ${frameWsInfo.length}`);
  console.log(`  Expected: 1 dashboard WS + ${frameWsInfo.length} per-card WS connections`);
  console.log(`  Total WS connections: ~${1 + perCardWsCount} (dashboard + per-card with active WS)`);

  // The concern is too many connections. With shared WS, ideally we'd have just 1 + N
  // where N = number of per-card WS (which are still connecting during transition)
  const cardCount = await page.evaluate(() => document.querySelectorAll('.terminal-3d').length);

  if (perCardWsCount <= cardCount) {
    pass('Connection count', `${perCardWsCount} per-card WS for ${cardCount} cards (+ 1 dashboard WS)`);
  } else {
    fail('Connection count', `More per-card WS (${perCardWsCount}) than cards (${cardCount})`);
  }

  await screenshot('test4-connections');
}

// =========================================================================
// TEST 5: Race condition — screen data before SVG load
// =========================================================================
async function test5_raceCondition() {
  console.log('\n=== TEST 5: Race condition — screen before SVG load ===');

  // This test checks the fundamental issue: dashboard WS sends screen data
  // immediately, but SVG <object> may not be loaded yet.

  // Navigate with network throttling to make SVG load slower
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Check immediately — are there cards with pending messages?
  await sleep(500); // Brief wait for DOM to build

  const earlyState = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    const info = [];
    for (const card of cards) {
      const obj = card.querySelector('object');
      let svgLoaded = false;
      try {
        svgLoaded = obj && obj.contentDocument && obj.contentDocument.readyState === 'complete';
      } catch (e) {}
      info.push({
        session: card.dataset.session,
        svgLoaded,
        hasObject: !!obj
      });
    }
    return info;
  });

  const notYetLoaded = earlyState.filter(c => !c.svgLoaded);
  console.log(`  At 500ms: ${earlyState.length} cards, ${notYetLoaded.length} SVGs not yet loaded`);

  if (notYetLoaded.length > 0) {
    console.log(`  Not loaded: ${notYetLoaded.map(c => c.session).join(', ')}`);
  }

  // Wait for everything to settle
  await sleep(6000);

  // Now check — did all cards eventually get content?
  const lateState = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    const info = [];
    for (const card of cards) {
      const obj = card.querySelector('object');
      let hasContent = false;
      let svgLoaded = false;
      try {
        if (obj && obj.contentDocument) {
          svgLoaded = true;
          const texts = obj.contentDocument.querySelectorAll('text');
          let nonEmpty = 0;
          for (const t of texts) {
            if (t.textContent.trim().length > 0) nonEmpty++;
          }
          hasContent = nonEmpty > 2;
        }
      } catch (e) {}
      info.push({ session: card.dataset.session, svgLoaded, hasContent });
    }
    return info;
  });

  const emptyAfterSettle = lateState.filter(c => !c.hasContent);
  if (emptyAfterSettle.length === 0) {
    pass('Race condition', `All ${lateState.length} cards have content after settling`);
  } else {
    fail('Race condition', `${emptyAfterSettle.length} cards still empty after 6.5s: ${emptyAfterSettle.map(c => c.session).join(', ')}`);
  }

  await screenshot('test5-race');
}

// =========================================================================
// TEST 6: Server log analysis — check for crashes/errors
// =========================================================================
async function test6_serverLogs() {
  console.log('\n=== TEST 6: Server health check ===');

  try {
    // Check if server is still running
    const response = await fetch('http://localhost:3201/');
    if (response.ok) {
      pass('Server alive', 'Server responds on port 3201');
    } else {
      fail('Server alive', `Status ${response.status}`);
    }
  } catch (e) {
    fail('Server alive', `Cannot reach server: ${e.message}`);
  }

  // Check server log for errors
  try {
    const log = execSync('tail -50 /tmp/svg-terminal-server.log 2>/dev/null').toString();
    const errors = log.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('CRASH'));
    if (errors.length > 0) {
      console.log('  Server errors found:');
      for (const e of errors.slice(-5)) console.log(`    ${e}`);
      fail('Server errors', `${errors.length} errors in log`);
    } else {
      pass('Server errors', 'No errors in recent logs');
    }
  } catch (e) {
    console.log('  Could not read server log');
  }
}

// =========================================================================
// TEST 7: Comprehensive card content check with per-card detail
// =========================================================================
async function test7_detailedCardCheck() {
  console.log('\n=== TEST 7: Detailed per-card content audit ===');

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(7000); // Extra time for all cards

  const frames = page.frames();
  const svgFrames = [];

  for (const frame of frames) {
    try {
      const url = frame.url();
      if (!url.includes('terminal.svg')) continue;

      const detail = await frame.evaluate(() => {
        const params = new URLSearchParams(window.location.search || (window.location.href.split('?')[1] || ''));
        const session = params.get('session') || 'unknown';

        const textEls = document.querySelectorAll('text');
        let nonEmpty = 0;
        let sampleText = '';
        for (const t of textEls) {
          const txt = t.textContent.trim();
          if (txt.length > 0) {
            nonEmpty++;
            if (!sampleText && txt.length > 3) sampleText = txt.substring(0, 40);
          }
        }

        return {
          session,
          wsReady: window._wsReady || false,
          hasScreenCallback: typeof window._screenCallback === 'function',
          hasRenderMessage: typeof window.renderMessage === 'function',
          renderedLines: nonEmpty,
          sampleText,
        };
      });

      svgFrames.push(detail);
    } catch (e) {
      // frame detached
    }
  }

  console.log(`  Frames inspected: ${svgFrames.length}`);
  let allOk = true;
  for (const f of svgFrames) {
    const status = f.renderedLines > 2 ? 'OK' : 'EMPTY';
    if (status === 'EMPTY') allOk = false;
    console.log(`  ${status}: ${f.session} — lines=${f.renderedLines}, wsReady=${f.wsReady}, callback=${f.hasScreenCallback}, sample="${f.sampleText}"`);
  }

  if (allOk) {
    pass('Detailed card audit', `All ${svgFrames.length} frames have content`);
  } else {
    const empty = svgFrames.filter(f => f.renderedLines <= 2);
    fail('Detailed card audit', `${empty.length}/${svgFrames.length} frames empty`);
  }

  await screenshot('test7-detailed');
}

// =========================================================================
// Helpers
// =========================================================================
async function getFrameContent(sessionName) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const url = frame.url();
      if (!url.includes('terminal.svg')) continue;
      if (url.includes('thumb=1')) continue; // skip thumbnail frames
      if (!url.includes(`session=${encodeURIComponent(sessionName)}`)) continue;

      const content = await frame.evaluate(() => {
        const textEls = document.querySelectorAll('text');
        let text = '';
        for (const t of textEls) {
          const txt = t.textContent.trim();
          // Skip measure text and error overlay
          if (txt === 'MMMMMMMMMM' || txt === 'Connection lost \u2014 retrying') continue;
          if (txt) text += txt + '\n';
        }
        return text.trim();
      });
      return content;
    } catch (e) {}
  }
  return null;
}

// =========================================================================
// Main
// =========================================================================
async function run() {
  try { execSync(`mkdir -p ${SCREENSHOT_DIR}`); } catch {}

  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });

  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Collect console messages
  const consoleMsgs = [];
  page.on('console', msg => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
  });

  // Collect page errors
  const pageErrors = [];
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  try {
    await test1_cardsLoadContent();
    await test2_typingLocal();
    await test3_typingCp();
    await test4_connectionCount();
    await test5_raceCondition();
    await test6_serverLogs();
    await test7_detailedCardCheck();
  } catch (err) {
    console.error('Test error:', err);
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  ${passed} passed, ${failed} failed, ${results.length} total`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}: ${r.name}${r.ok ? (r.detail ? ' — ' + r.detail : '') : ' — ' + r.reason}`);
  }

  // Console errors
  if (pageErrors.length > 0) {
    console.log('\n=== PAGE ERRORS ===');
    for (const e of pageErrors.slice(0, 10)) {
      console.log(`  ${e}`);
    }
  }

  // Relevant console messages
  const wsMessages = consoleMsgs.filter(m => m.text.includes('WS') || m.text.includes('WebSocket') || m.text.includes('Dashboard'));
  if (wsMessages.length > 0) {
    console.log('\n=== WS-RELATED CONSOLE MESSAGES ===');
    for (const m of wsMessages.slice(0, 20)) {
      console.log(`  [${m.type}] ${m.text}`);
    }
  }

  await browser.close();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
