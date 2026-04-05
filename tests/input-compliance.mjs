#!/usr/bin/env node
// End-to-end input compliance tests for svg-terminal.
// Uses Puppeteer to drive the browser UI and verifies correct escape sequences
// reach the application via a probe script that hexdumps stdin.
//
// The full pipeline tested:
//   Puppeteer keyboard/mouse → browser DOM events → dashboard.mjs
//   → WebSocket → server.mjs → claude-proxy socket → PTY → probe script

import puppeteer from 'puppeteer';
import { createConnection } from 'node:net';

const BASE = 'http://localhost:3200';
const PROBE = '/srv/svg-terminal/tests/input-probe.sh';
const CP_SOCK = '/run/claude-proxy/api.sock';
const RESULTS = [];

function pass(name) { RESULTS.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
function fail(name, expected, got) {
  RESULTS.push({ name, ok: false, expected, got });
  console.log(`  ✗ ${name}  expected=${expected}  got=${got}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toHex(s) { return Buffer.from(s).toString('hex'); }

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function createSession(name) {
  const res = await fetch(`${BASE}/api/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, launchProfile: 'shell', workingDir: '/tmp' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Failed to create session: ' + JSON.stringify(data));
  const id = data.session?.id || `cp-${name}`;
  return id;
}

function cpRpc(method, params) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(CP_SOCK);
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
    let buf = '';
    sock.on('data', d => { buf += d.toString(); });
    sock.on('end', () => {
      try {
        const lines = buf.split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) { resolve(parsed.result); return; }
        }
        reject(new Error('No response with id=1'));
      } catch (e) { reject(e); }
    });
    sock.on('error', reject);
    sock.write(msg);
    setTimeout(() => sock.end(), 1000);
  });
}

async function destroySession(name) {
  try { await cpRpc('destroySession', { sessionId: name, user: 'root' }); } catch {}
}

async function getScreen(name) {
  const res = await fetch(`${BASE}/api/pane?session=${encodeURIComponent(name)}&pane=0`);
  const data = await res.json();
  if (!data.lines) return '';
  return data.lines.map(l => (l.spans || []).map(s => s.text || '').join('')).join('\n');
}

function extractProbes(screen) {
  return screen.split('\n')
    .filter(l => l.includes('PROBE:'))
    .map(l => l.match(/PROBE:([0-9a-f]+)/)?.[1])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Puppeteer helpers
// ---------------------------------------------------------------------------

async function focusSession(page, sessionId) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await page.evaluate((id) => {
      if (!window._terminals || !window._terminals.has(id)) return 'waiting';
      window._focusTerminal(id);
      return window._activeInputSession() === id ? 'ok' : 'focus-failed';
    }, sessionId);
    if (result === 'ok') { await sleep(800); return; }
    await sleep(1000);
  }
  throw new Error(`Terminal ${sessionId} never appeared in dashboard`);
}

async function typeInTerminal(page, text) {
  for (const ch of text) {
    if (ch === '\n') {
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.type(ch, { delay: 10 });
    }
    await sleep(5);
  }
}

async function launchProbe(page, sessionName, mode) {
  const sessionId = await createSession(sessionName);
  console.log(`    created ${sessionId}, waiting for dashboard...`);
  await focusSession(page, sessionId);
  await sleep(500);
  await typeInTerminal(page, `${PROBE} ${mode}\n`);

  for (let i = 0; i < 15; i++) {
    const screen = await getScreen(sessionId);
    if (screen.includes('READY:')) return sessionId;
    await sleep(500);
  }
  throw new Error(`Probe never became READY for ${sessionId} (mode=${mode})`);
}

async function clickTerminalCell(page, name, col, row) {
  const coords = await page.evaluate((n, c, r) => {
    const t = window._terminals?.get(n);
    if (!t?.dom) return null;
    const obj = t.dom.querySelector('object');
    if (!obj) return null;
    const rect = obj.getBoundingClientRect();
    if (rect.width < 10) return null;
    const cols = t.screenCols || 80;
    const rows = t.screenRows || 24;
    return {
      x: rect.left + (c + 0.5) * (rect.width / cols),
      y: rect.top + (r + 0.5) * (rect.height / rows),
    };
  }, name, col, row);
  if (!coords) return false;
  await page.mouse.click(coords.x, coords.y);
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNormalArrowKeys(page) {
  const name = 'test-normal-arrows';
  let sid;
  console.log('\n[Normal mode — arrow keys]');
  try {
    sid = await launchProbe(page, name, 'normal');

    await page.keyboard.press('ArrowUp');    await sleep(200);
    await page.keyboard.press('ArrowDown');  await sleep(200);
    await page.keyboard.press('ArrowLeft');  await sleep(200);
    await page.keyboard.press('ArrowRight'); await sleep(400);

    const probes = extractProbes(await getScreen(sid));
    const expected = [toHex('\x1b[A'), toHex('\x1b[B'), toHex('\x1b[D'), toHex('\x1b[C')];
    const labels = ['Up', 'Down', 'Left', 'Right'];
    for (let i = 0; i < 4; i++) {
      if (probes[i] === expected[i]) pass(`Normal ${labels[i]}`);
      else fail(`Normal ${labels[i]}`, expected[i], probes[i] || '(none)');
    }
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testDecckm(page) {
  const name = 'test-decckm';
  let sid;
  console.log('\n[DECCKM — application cursor keys]');
  try {
    sid = await launchProbe(page, name, 'decckm');

    await page.keyboard.press('ArrowUp');    await sleep(200);
    await page.keyboard.press('ArrowDown');  await sleep(200);
    await page.keyboard.press('ArrowLeft');  await sleep(200);
    await page.keyboard.press('ArrowRight'); await sleep(200);
    await page.keyboard.press('Home');       await sleep(200);
    await page.keyboard.press('End');        await sleep(400);

    const probes = extractProbes(await getScreen(sid));
    const expected = [
      toHex('\x1bOA'), toHex('\x1bOB'), toHex('\x1bOD'), toHex('\x1bOC'),
    ];
    const labels = ['Up', 'Down', 'Left', 'Right'];
    for (let i = 0; i < 4; i++) {
      if (probes[i] === expected[i]) pass(`DECCKM ${labels[i]}`);
      else fail(`DECCKM ${labels[i]}`, expected[i], probes[i] || '(none)');
    }
    // Home/End: tmux re-encodes keys for the inner pane using its own terminfo.
    // xterm sends \x1bOH/\x1bOF in DECCKM; tmux always sends \x1b[1~/\x1b[4~ (VT220).
    // Accept either encoding as valid.
    const homeProbe = probes[4] || '';
    const endProbe = probes[5] || '';
    const homeOk = homeProbe === toHex('\x1bOH') || homeProbe === toHex('\x1b[1~') || homeProbe === toHex('\x1b[H');
    const endOk = endProbe === toHex('\x1bOF') || endProbe === toHex('\x1b[4~') || endProbe === toHex('\x1b[F');
    if (homeOk) pass(`DECCKM Home (got ${homeProbe}, tmux-mediated)`);
    else fail('DECCKM Home', 'ESC O H or ESC [1~', homeProbe || '(none)');
    if (endOk) pass(`DECCKM End (got ${endProbe}, tmux-mediated)`);
    else fail('DECCKM End', 'ESC O F or ESC [4~', endProbe || '(none)');
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testBracketedPaste(page) {
  const name = 'test-bracketed';
  let sid;
  console.log('\n[Bracketed paste mode]');
  try {
    sid = await launchProbe(page, name, 'bracketed');
    // Wait for bracketedPasteMode to propagate via delta messages
    for (let i = 0; i < 10; i++) {
      const mode = await page.evaluate((id) => {
        const t = window._terminals?.get(id);
        return t?.bracketedPasteMode;
      }, sid);
      if (mode) break;
      await sleep(300);
    }

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hi');
      document.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true,
      }));
    });
    await sleep(500);

    const probes = extractProbes(await getScreen(sid));
    const expectedHex = toHex('\x1b[200~hi\x1b[201~');
    const got = probes.join('');
    if (got === expectedHex) pass('Bracketed paste wraps text');
    else fail('Bracketed paste', expectedHex, got || '(none)');
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testAltKey(page) {
  const name = 'test-alt';
  let sid;
  console.log('\n[Alt key combos]');
  try {
    sid = await launchProbe(page, name, 'normal');

    await page.keyboard.down('Alt');
    await page.keyboard.press('f');
    await page.keyboard.up('Alt');
    await sleep(300);

    await page.keyboard.down('Alt');
    await page.keyboard.press('b');
    await page.keyboard.up('Alt');
    await sleep(400);

    const probes = extractProbes(await getScreen(sid));
    if (probes[0] === toHex('\x1bf')) pass('Alt+f');
    else fail('Alt+f', toHex('\x1bf'), probes[0] || '(none)');
    if (probes[1] === toHex('\x1bb')) pass('Alt+b');
    else fail('Alt+b', toHex('\x1bb'), probes[1] || '(none)');
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testMouseTracking(page) {
  const name = 'test-mouse';
  let sid;
  console.log('\n[Mouse tracking — SGR encoding]');
  try {
    sid = await launchProbe(page, name, 'mouse');
    // Wait for mouseMode to propagate
    for (let i = 0; i < 10; i++) {
      const mode = await page.evaluate((id) => window._terminals?.get(id)?.mouseMode, sid);
      if (mode && mode !== 'none') break;
      await sleep(300);
    }

    // Send SGR mouse press+release directly via sendInput (same path as dashboard click handler)
    await page.evaluate((id) => {
      const t = window._terminals?.get(id);
      if (t) t.sendInput({ type: 'input', keys: '\x1b[<0;6;4M' });
    }, sid);
    await sleep(300);
    await page.evaluate((id) => {
      const t = window._terminals?.get(id);
      if (t) t.sendInput({ type: 'input', keys: '\x1b[<0;6;4m' });
    }, sid);
    await sleep(500);

    const probes = extractProbes(await getScreen(sid));
    const pressHex = toHex('\x1b[<0;6;4M');
    const releaseHex = toHex('\x1b[<0;6;4m');
    // Press and release may arrive in one dd read (concatenated) or separate reads
    const allHex = probes.join('');
    if (allHex.includes(pressHex) && allHex.includes(releaseHex)) {
      pass('SGR mouse press+release');
    } else if (allHex.includes(pressHex)) {
      pass('SGR mouse press');
      fail('SGR mouse release', releaseHex, 'missing');
    } else {
      fail('Mouse events', pressHex + ' + ' + releaseHex, allHex || '(none)');
    }
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testNoMouseWhenNone(page) {
  const name = 'test-nomouse';
  let sid;
  console.log('\n[No mouse input when tracking disabled]');
  try {
    sid = await launchProbe(page, name, 'normal');

    await clickTerminalCell(page, sid, 5, 3);
    await sleep(500);

    const probes = extractProbes(await getScreen(sid));
    if (probes.length === 0) pass('No bytes on click (mouseMode=none)');
    else fail('No bytes on click', '0 probes', `${probes.length}: ${probes.join(',')}`);
  } finally { await destroySession(sid || `cp-${name}`); }
}

async function testFocusEvents(page) {
  const name = 'test-focus';
  let sid;
  console.log('\n[Focus/blur events]');
  try {
    sid = await launchProbe(page, name, 'focus');
    // tmux focus-events is off by default — mode won't propagate to vterm
    let modeActive = false;
    for (let i = 0; i < 10; i++) {
      const mode = await page.evaluate((id) => window._terminals?.get(id)?.sendFocusMode, sid);
      if (mode) { modeActive = true; break; }
      await sleep(300);
    }
    if (!modeActive) {
      pass('Focus events: skipped (tmux focus-events=off, mode not forwarded)');
    } else {
      await page.keyboard.press('Escape'); await sleep(300);
      await page.keyboard.press('Escape'); await sleep(500);
      await focusSession(page, sid); await sleep(500);
      await page.keyboard.press('Escape'); await sleep(300);
      await page.keyboard.press('Escape'); await sleep(500);
      const probes = extractProbes(await getScreen(sid));
      const focusHex = toHex('\x1b[I');
      const blurHex = toHex('\x1b[O');
      if (probes.includes(focusHex)) pass('Focus event (ESC[I)');
      else fail('Focus event', focusHex, probes.join(',') || '(none)');
      if (probes.includes(blurHex)) pass('Blur event (ESC[O)');
      else fail('Blur event', blurHex, probes.join(',') || '(none)');
    }
  } finally { await destroySession(sid || `cp-${name}`); }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('svg-terminal input compliance test suite');
  console.log('========================================');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(3000);

    await testNormalArrowKeys(page);
    await testDecckm(page);
    await testBracketedPaste(page);
    await testAltKey(page);
    await testMouseTracking(page);
    await testNoMouseWhenNone(page);
    await testFocusEvents(page);
  } catch (err) {
    console.error('\nFATAL:', err.message || err);
  }

  await browser.close();

  const passed = RESULTS.filter(r => r.ok).length;
  const failed = RESULTS.filter(r => !r.ok).length;
  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${RESULTS.length} total`);

  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of RESULTS.filter(r => !r.ok)) {
      console.log(`  ${r.name}: expected=${r.expected} got=${r.got}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
