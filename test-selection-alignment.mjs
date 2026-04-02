// Test: Selection alignment across terminal sizes and card mutations
// Verifies that drag-to-select highlights the correct characters at the correct positions.
// Uses checkerboard pattern (alternating █ and ─) so any row/col offset is visible.
//
// Test matrix:
//   6 terminal sizes × 2 configs (current SVG_CELL values vs runtime-measured)
//   For each: default, after ++++, after ----, after card resize, after optimize
//
// Usage: node test-selection-alignment.mjs [--config=current|measured]
import puppeteer from 'puppeteer';
import { execSync, execFileSync } from 'child_process';
import { writeFileSync } from 'fs';

const DASH_URL = 'http://localhost:3200/';
const SCREENSHOT_DIR = '/srv/svg-terminal/alignment-tests';
const CONFIG = process.argv.includes('--config=measured') ? 'measured' : 'current';

const TEST_TERMINALS = [
  { name: 'align-wide-lo',   cols: 120, rows: 10 },  // wide aspect, low count
  { name: 'align-wide-hi',   cols: 200, rows: 60 },  // wide aspect, high count
  { name: 'align-tall-lo',   cols: 30,  rows: 50 },  // tall aspect, low count
  { name: 'align-tall-hi',   cols: 40,  rows: 80 },  // tall aspect, high count
  { name: 'align-standard',  cols: 80,  rows: 24 },  // VT100
  { name: 'align-minimal',   cols: 20,  rows: 8  },  // minimal
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tmuxCmd(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' }).trim();
}

// Create a tmux session at specific size with checkerboard pattern
function setupTerminal(t) {
  // Kill if exists
  try { tmuxCmd(['kill-session', '-t', t.name]); } catch {}

  // Create session
  tmuxCmd(['new-session', '-d', '-s', t.name, '-x', String(t.cols), '-y', String(t.rows)]);
  // Wait for shell prompt
  execSync('sleep 0.5');

  // Clear screen first, then fill with checkerboard using a script that
  // outputs exactly rows-1 lines of alternating █/─ and leaves cursor at bottom
  tmuxCmd(['send-keys', '-t', t.name, 'clear', 'Enter']);
  execSync('sleep 0.3');

  // Write a python script to file, then run it — avoids shell escaping issues
  const scriptContent = `import sys
rows = ${t.rows - 1}
cols = ${t.cols}
for r in range(rows):
    line = ''
    for c in range(cols):
        if (r + c) % 2 == 0:
            line += chr(0x2588)
        else:
            line += chr(0x2500)
    sys.stdout.write(line + '\\n')
`;
  const scriptPath = `/tmp/checker-${t.name}.py`;
  writeFileSync(scriptPath, scriptContent);
  tmuxCmd(['send-keys', '-t', t.name, `python3 ${scriptPath}`, 'Enter']);
  execSync('sleep 0.5');
}

// Focus a terminal by clicking its thumbnail
async function focusTerminal(page, sessionName) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const ok = await page.evaluate((name) => {
      const items = document.querySelectorAll('.thumbnail-item');
      for (const item of items) {
        if (item.dataset.session === name) { item.click(); return true; }
      }
      return false;
    }, sessionName);
    if (ok) { await sleep(2500); return true; }
    await sleep(2000);
  }
  return false;
}

// Unfocus all terminals (press Escape twice)
async function unfocusAll(page) {
  await page.keyboard.press('Escape');
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(1500);
}

// Get the bounding rect of the focused terminal card
async function getCardRect(page) {
  return page.evaluate(() => {
    const focused = document.querySelector('.focused');
    if (!focused) return null;
    const r = focused.getBoundingClientRect();
    return {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height,
      domW: focused.style.width, domH: focused.style.height
    };
  });
}

// Perform a drag-to-select from roughly row 2, col 3 to row 5, col 15
// (selecting a known region of the checkerboard)
async function dragSelect(page, rect, t) {
  if (!rect || rect.width < 20 || rect.height < 20) {
    console.log('  SKIP: card rect too small or missing');
    return;
  }

  // Estimate character positions from the card's screen rect
  // The header takes some space at the top — estimate ~18px header in screen space
  // (72px DOM header / 4x scale = 18px apparent, but CSS3D scaling varies)
  // We'll use proportional positions instead:
  // Select from ~15% to ~40% vertically, ~5% to ~40% horizontally
  // This should reliably hit rows 2-5 and cols 3-15 in most terminal sizes

  const headerFrac = 0.08; // approximate header fraction of card height
  const bodyTop = rect.top + rect.height * headerFrac;
  const bodyHeight = rect.height * (1 - headerFrac);
  const bodyLeft = rect.left;
  const bodyWidth = rect.width;

  // Start: ~row 2, col 3
  const startX = bodyLeft + bodyWidth * (3 / t.cols);
  const startY = bodyTop + bodyHeight * (2 / t.rows);

  // End: ~row 5, col 15 (or proportional for small terminals)
  const endRow = Math.min(5, t.rows - 2);
  const endCol = Math.min(15, t.cols - 2);
  const endX = bodyLeft + bodyWidth * (endCol / t.cols);
  const endY = bodyTop + bodyHeight * (endRow / t.rows);

  // Perform the drag
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 15 });
  await sleep(200);
  // Don't mouse up yet — take screenshot with selection visible
}

// Press + button N times (terminal resize = apparent font size change)
// + = "Bigger text (fewer cols)" — label is '+', decreases cols/rows
async function pressPlus(page, n) {
  for (let i = 0; i < n; i++) {
    const clicked = await page.evaluate(() => {
      const focused = document.querySelector('.focused');
      if (!focused) return false;
      const btns = focused.querySelectorAll('.header-controls button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '+') { btn.click(); return true; }
      }
      return false;
    });
    if (!clicked) console.log('    WARNING: + button not found');
    await sleep(800);
  }
  await sleep(1000);
}

// Press − button N times
// − = "Smaller text (more cols)" — label is '−' (U+2212), increases cols/rows
async function pressMinus(page, n) {
  for (let i = 0; i < n; i++) {
    const clicked = await page.evaluate(() => {
      const focused = document.querySelector('.focused');
      if (!focused) return false;
      const btns = focused.querySelectorAll('.header-controls button');
      for (const btn of btns) {
        if (btn.textContent.trim() === '−' || btn.textContent.trim() === '-') { btn.click(); return true; }
      }
      return false;
    });
    if (!clicked) console.log('    WARNING: − button not found');
    await sleep(800);
  }
  await sleep(1000);
}

// Click the optimize terminal-to-card button (⊡)
async function optimizeTermToCard(page) {
  await page.evaluate(() => {
    const focused = document.querySelector('.focused');
    if (!focused) return;
    const btns = focused.querySelectorAll('.header-controls button');
    for (const btn of btns) {
      if (btn.textContent.trim() === '⊡' || btn.title?.includes('Fit terminal')) {
        btn.click(); return;
      }
    }
  });
  await sleep(1500);
}

// Click the optimize card-to-terminal button (⊞)
async function optimizeCardToTerm(page) {
  await page.evaluate(() => {
    const focused = document.querySelector('.focused');
    if (!focused) return;
    const btns = focused.querySelectorAll('.header-controls button');
    for (const btn of btns) {
      if (btn.textContent.trim() === '⊞' || btn.title?.includes('Fit card')) {
        btn.click(); return;
      }
    }
  });
  await sleep(1500);
}

// Alt+drag to resize the card
async function altDragResize(page, dx, dy) {
  const rect = await getCardRect(page);
  if (!rect) return;
  const startX = rect.right - 30;
  const startY = rect.bottom - 30;
  await page.mouse.move(startX, startY);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 15 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(1500);
}

async function runSelectionTest(page, t, label) {
  const rect = await getCardRect(page);
  if (!rect) {
    console.log(`  ${label}: NO CARD RECT — skipping`);
    return;
  }

  console.log(`  ${label}: card screen ${Math.round(rect.width)}×${Math.round(rect.height)}`);

  // Do the drag select
  await dragSelect(page, rect, t);

  // Screenshot with selection visible
  const filename = `${SCREENSHOT_DIR}/${CONFIG}-${t.name}-${label}.png`;
  await page.screenshot({ path: filename });
  console.log(`    saved: ${filename}`);

  // Release mouse to clear selection
  await page.mouse.up();
  await sleep(500);
}

async function run() {
  // Create screenshot directory
  execSync(`mkdir -p ${SCREENSHOT_DIR}`);

  console.log(`\n=== Selection Alignment Test — Config: ${CONFIG} ===\n`);

  // Setup all test terminals
  console.log('Setting up test terminals...');
  for (const t of TEST_TERMINALS) {
    setupTerminal(t);
    console.log(`  ${t.name}: ${t.cols}×${t.rows}`);
  }
  await sleep(3000); // Let checkerboard patterns render

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(DASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(6000); // Let all terminals load

  // Take overview screenshot
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${CONFIG}-overview.png` });
  console.log('Overview saved.\n');

  // Test each terminal
  for (const t of TEST_TERMINALS) {
    console.log(`\n--- Testing ${t.name} (${t.cols}×${t.rows}) ---`);

    // 1. Default size
    if (!await focusTerminal(page, t.name)) {
      console.log('  SKIP: Could not focus terminal');
      continue;
    }
    await runSelectionTest(page, t, 'default');

    // 2. After +,+,+,+ (increase cols/rows = smaller apparent font)
    await pressPlus(page, 4);
    await runSelectionTest(page, t, 'plus4');

    // 3. After -,-,-,-,-,-,-,- (decrease back and beyond = larger apparent font)
    await pressMinus(page, 8);
    await runSelectionTest(page, t, 'minus4');

    // Reset with +4 to get back to roughly default
    await pressPlus(page, 4);
    await sleep(500);

    // 4. After alt+drag resize (make card wider/taller)
    await altDragResize(page, 150, 80);
    await runSelectionTest(page, t, 'resized');

    // 5. After optimize terminal→card (⊡)
    await optimizeTermToCard(page);
    await runSelectionTest(page, t, 'opt-term-to-card');

    // 6. After optimize card→terminal (⊞)
    await optimizeCardToTerm(page);
    await runSelectionTest(page, t, 'opt-card-to-term');

    // Unfocus before next terminal
    await unfocusAll(page);
  }

  // Summary
  console.log(`\n=== Done — ${CONFIG} config ===`);
  console.log(`Screenshots in: ${SCREENSHOT_DIR}/`);
  console.log(`Review: look for selection highlight offset from checkerboard characters.`);
  console.log(`Compare ${CONFIG} screenshots against the other config.\n`);

  await browser.close();

  // Cleanup test sessions
  for (const t of TEST_TERMINALS) {
    try { tmuxCmd(['kill-session', '-t', t.name]); } catch {}
  }
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
