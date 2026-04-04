// test-v06-typing.mjs — Focused test for typing via shared WebSocket
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

const URL = 'http://localhost:3201/';
const SCREENSHOT_DIR = '/srv/svg-terminal/e2e-screenshots';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  try { execSync(`mkdir -p ${SCREENSHOT_DIR}`); } catch {}

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // Collect console
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Dashboard') || text.includes('WS') || text.includes('input') || text.includes('send')) {
      console.log(`  [console.${msg.type()}] ${text}`);
    }
  });

  page.on('pageerror', err => console.log(`  [pageerror] ${err.message}`));

  console.log('Loading page...');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await sleep(5000);

  // Find a local session with a shell prompt
  const sessions = await page.evaluate(() => {
    const cards = document.querySelectorAll('.terminal-3d');
    return Array.from(cards)
      .map(c => c.dataset.session)
      .filter(s => s && !s.startsWith('cp-') && !s.startsWith('browser-'));
  });

  console.log(`Local sessions: ${sessions.join(', ')}`);

  // Use test_control which likely has a shell prompt
  const testSession = sessions.find(s => s === 'test_control') || sessions.find(s => s === 'demo') || sessions[0];
  if (!testSession) {
    console.log('No local session found!');
    await browser.close();
    return;
  }

  console.log(`\nTesting typing on: ${testSession}`);

  // Focus the session
  const focused = await page.evaluate((name) => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const i of items) {
      if (i.dataset.session === name) { i.click(); return true; }
    }
    return false;
  }, testSession);
  console.log(`Focused: ${focused}`);
  await sleep(2000);

  // Check focus state
  const focusState = await page.evaluate(() => {
    const bar = document.getElementById('input-bar');
    const target = document.getElementById('input-target');
    return {
      barVisible: bar ? bar.classList.contains('visible') : false,
      targetSession: target ? target.textContent : 'none',
      // Can we find activeInputSession?
    };
  });
  console.log(`Focus state: ${JSON.stringify(focusState)}`);

  // Get content of the MAIN card frame (not thumbnail)
  async function getMainFrameContent(session) {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const url = frame.url();
        if (!url.includes('terminal.svg')) continue;
        if (url.includes('thumb=1')) continue; // skip thumbnails
        if (!url.includes(`session=${encodeURIComponent(session)}`)) continue;

        return await frame.evaluate(() => {
          const textEls = document.querySelectorAll('text');
          let text = '';
          for (const t of textEls) {
            const content = t.textContent.trim();
            if (content && content !== 'MMMMMMMMMM') text += content + '\n';
          }
          return text.trim();
        });
      } catch (e) {}
    }
    return null;
  }

  const before = await getMainFrameContent(testSession);
  console.log(`\nBefore typing:\n${before ? before.substring(0, 200) : 'NO CONTENT'}`);

  // Send keystroke via page keyboard (this goes through the dashboard keydown handler)
  console.log('\nSending "echo hi" + Enter via page.keyboard...');
  for (const char of 'echo hi') {
    await page.keyboard.press(char === ' ' ? 'Space' : char);
    await sleep(50);
  }
  await page.keyboard.press('Enter');
  await sleep(1500);

  const after = await getMainFrameContent(testSession);
  console.log(`\nAfter typing:\n${after ? after.substring(0, 200) : 'NO CONTENT'}`);

  if (before !== after) {
    console.log('\nRESULT: PASS — Screen content changed after typing');
  } else {
    console.log('\nRESULT: FAIL — Screen content did NOT change');

    // Debug: check if sendDashboardMessage works
    const sendTest = await page.evaluate((session) => {
      // Check dashboardWs state
      const bar = document.getElementById('input-bar');
      const visible = bar ? bar.classList.contains('visible') : false;
      return { inputBarVisible: visible };
    }, testSession);
    console.log(`Debug: ${JSON.stringify(sendTest)}`);

    // Try sending directly via evaluate
    console.log('\nTrying direct sendInput via evaluate...');
    const directResult = await page.evaluate((session) => {
      try {
        // Access terminals Map - it's module-level, not accessible directly
        // But we can check if keydown events reach the handler
        const e = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true });
        document.dispatchEvent(e);
        return 'dispatched synthetic keydown';
      } catch (err) {
        return 'error: ' + err.message;
      }
    }, testSession);
    console.log(`Direct result: ${directResult}`);
    await sleep(1000);

    const afterDirect = await getMainFrameContent(testSession);
    console.log(`\nAfter direct dispatch:\n${afterDirect ? afterDirect.substring(0, 200) : 'NO CONTENT'}`);
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/typing-test-final.png`, fullPage: true });

  // Also check server logs for the input message
  try {
    const log = execSync('tail -20 /tmp/svg-terminal-server.log 2>/dev/null').toString();
    const inputLines = log.split('\n').filter(l => l.includes('input') || l.includes('send-keys'));
    if (inputLines.length > 0) {
      console.log('\nServer log (input-related):');
      for (const l of inputLines) console.log(`  ${l}`);
    } else {
      console.log('\nNo input-related lines in server log');
    }
  } catch (e) {}

  await browser.close();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
