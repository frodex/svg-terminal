// Resize baseline test — observe and document resize behavior
import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tmuxDims() {
  return execSync("tmux display-message -t resize-test -p '#{window_width} #{window_height}'")
    .toString().trim();
}

function tmuxResize(cols, rows) {
  execSync(`tmux resize-window -t resize-test -x ${cols} -y ${rows}`);
}

async function getCardDims(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.terminal-3d[data-session="resize-test"]');
    if (!el) return null;
    return {
      styleWidth: el.style.width,
      styleHeight: el.style.height,
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight,
      boundingWidth: Math.round(el.getBoundingClientRect().width),
      boundingHeight: Math.round(el.getBoundingClientRect().height),
    };
  });
}

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  console.log('=== Loading dashboard ===');
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(3000);

  // ──────────────────────────────────────────
  // TEST 1: External resize while card NOT focused
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('TEST 1: External resize while card NOT focused');
  console.log('══════════════════════════════════');

  await page.screenshot({ path: 'e2e-screenshots/resize-t1-before.png', fullPage: true });
  const t1_tmux_before = tmuxDims();
  const t1_before = await getCardDims(page);
  console.log('tmux before:', t1_tmux_before);
  console.log('card before:', JSON.stringify(t1_before));

  console.log('Resizing tmux to 120x40...');
  tmuxResize(120, 40);
  await sleep(2000);

  const t1_tmux_after = tmuxDims();
  const t1_after = await getCardDims(page);
  console.log('tmux after:', t1_tmux_after);
  console.log('card after:', JSON.stringify(t1_after));
  await page.screenshot({ path: 'e2e-screenshots/resize-t1-after.png', fullPage: true });

  const t1_changed = (t1_before.styleWidth !== t1_after.styleWidth ||
                       t1_before.styleHeight !== t1_after.styleHeight);
  console.log('RESULT: card dimensions changed?', t1_changed ? 'YES' : 'NO');

  // ──────────────────────────────────────────
  // TEST 2: Focus a terminal, then external resize
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('TEST 2: Focus terminal, then external resize');
  console.log('══════════════════════════════════');

  console.log('Clicking thumbnail to focus...');
  const thumb = await page.$('.thumbnail-item[data-session="resize-test"]');
  if (!thumb) {
    console.log('ERROR: thumbnail not found');
  } else {
    await thumb.click();
  }
  await sleep(1000);
  await page.screenshot({ path: 'e2e-screenshots/resize-t2-focused.png', fullPage: true });

  const t2_tmux_before = tmuxDims();
  const t2_before = await getCardDims(page);
  console.log('tmux before:', t2_tmux_before);
  console.log('card before (focused):', JSON.stringify(t2_before));

  console.log('Resizing tmux to 80x24...');
  tmuxResize(80, 24);
  await sleep(2000);

  const t2_tmux_after = tmuxDims();
  const t2_after = await getCardDims(page);
  console.log('tmux after:', t2_tmux_after);
  console.log('card after:', JSON.stringify(t2_after));
  await page.screenshot({ path: 'e2e-screenshots/resize-t2-after-resize.png', fullPage: true });

  const t2_changed = (t2_before.styleWidth !== t2_after.styleWidth ||
                       t2_before.styleHeight !== t2_after.styleHeight);
  console.log('RESULT: focused card dimensions changed?', t2_changed ? 'YES' : 'NO');

  // ──────────────────────────────────────────
  // TEST 3: +/- button while focused
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('TEST 3: + button while focused');
  console.log('══════════════════════════════════');

  const t3_tmux_before = tmuxDims();
  const t3_before = await getCardDims(page);
  console.log('tmux before:', t3_tmux_before);
  console.log('card before:', JSON.stringify(t3_before));

  // Find the + button
  const plusBtn = await page.$('.terminal-3d[data-session="resize-test"] .header-controls button[title*="Bigger"]');
  if (!plusBtn) {
    // Try broader search
    const allBtns = await page.$$('.terminal-3d[data-session="resize-test"] .header-controls button');
    console.log('Bigger button not found directly. Found', allBtns.length, 'header buttons total');
    // Try clicking by evaluating
    const clicked = await page.evaluate(() => {
      const card = document.querySelector('.terminal-3d[data-session="resize-test"]');
      if (!card) return 'no card';
      const btns = card.querySelectorAll('.header-controls button');
      for (const b of btns) {
        if (b.title && b.title.includes('Bigger')) {
          b.click(); b.click(); b.click();
          return 'clicked 3x via title match: ' + b.title;
        }
        if (b.textContent === '+') {
          b.click(); b.click(); b.click();
          return 'clicked 3x via text match';
        }
      }
      return 'no match among ' + btns.length + ' buttons: ' +
        Array.from(btns).map(b => `"${b.textContent}" title="${b.title}"`).join(', ');
    });
    console.log('Button search result:', clicked);
  } else {
    console.log('Found + button, clicking 3 times...');
    await plusBtn.click();
    await sleep(200);
    await plusBtn.click();
    await sleep(200);
    await plusBtn.click();
  }
  await sleep(1000);

  const t3_tmux_after = tmuxDims();
  const t3_after = await getCardDims(page);
  console.log('tmux after:', t3_tmux_after);
  console.log('card after:', JSON.stringify(t3_after));
  await page.screenshot({ path: 'e2e-screenshots/resize-t3-after-plus.png', fullPage: true });

  const t3_tmux_changed = (t3_tmux_before !== t3_tmux_after);
  const t3_card_changed = (t3_before.styleWidth !== t3_after.styleWidth ||
                            t3_before.styleHeight !== t3_after.styleHeight);
  console.log('RESULT: tmux dimensions changed?', t3_tmux_changed ? 'YES' : 'NO');
  console.log('RESULT: card DOM dimensions changed?', t3_card_changed ? 'YES' : 'NO');

  // ──────────────────────────────────────────
  // TEST 4: Unfocus after +/- changes
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('TEST 4: Unfocus after +/- changes');
  console.log('══════════════════════════════════');

  console.log('Pressing Escape...');
  await page.keyboard.press('Escape');
  await sleep(1000);

  const t4_after = await getCardDims(page);
  console.log('card after unfocus:', JSON.stringify(t4_after));
  await page.screenshot({ path: 'e2e-screenshots/resize-t4-unfocused.png', fullPage: true });

  const t4_snap = (t3_after.styleWidth !== t4_after.styleWidth ||
                    t3_after.styleHeight !== t4_after.styleHeight);
  console.log('RESULT: card snapped to new dims on unfocus?', t4_snap ? 'YES' : 'NO');

  // ──────────────────────────────────────────
  // TEST 5: Restore original size
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('TEST 5: Restore original size');
  console.log('══════════════════════════════════');

  tmuxResize(111, 42);
  const t5_dims = tmuxDims();
  console.log('Restored tmux to:', t5_dims);

  // ──────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────
  console.log('\n══════════════════════════════════');
  console.log('SUMMARY');
  console.log('══════════════════════════════════');
  console.log('T1 (unfocused external resize): card changed?', t1_changed ? 'YES' : 'NO');
  console.log('T2 (focused external resize): card changed?', t2_changed ? 'YES' : 'NO');
  console.log('T3 (+button): tmux changed?', t3_tmux_changed ? 'YES' : 'NO',
              '| card changed?', t3_card_changed ? 'YES' : 'NO');
  console.log('T4 (unfocus snap): card snapped?', t4_snap ? 'YES' : 'NO');

  await browser.close();
  console.log('\nDone. Screenshots in e2e-screenshots/');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
