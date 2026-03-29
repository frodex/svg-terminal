import puppeteer from 'puppeteer';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--window-size=1920,1080'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(3000);

  // Focus resize-test
  await page.evaluate(() => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === 'resize-test') { item.click(); return; }
    }
  });
  await sleep(2000);

  // The resize-test session runs a loop. Ctrl+C should kill it.
  // Capture output before
  const before = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    if (!obj || !obj.contentDocument) return '';
    return obj.contentDocument.documentElement.textContent || '';
  });

  // Send Ctrl+C
  await page.keyboard.down('Control');
  await page.keyboard.press('c');
  await page.keyboard.up('Control');
  await sleep(2000);

  // After Ctrl+C, the loop should have stopped. Check if we see a shell prompt
  // or at least that the "Terminal:" lines stopped updating.
  const after = await page.evaluate(() => {
    const obj = document.querySelector('.focused object');
    if (!obj || !obj.contentDocument) return '';
    return obj.contentDocument.documentElement.textContent || '';
  });

  // Also check tmux directly
  const { execSync } = await import('child_process');
  const tmuxContent = execSync('tmux capture-pane -t resize-test -p').toString();

  console.log('Tmux content after Ctrl+C:');
  console.log(tmuxContent.split('\n').slice(-5).join('\n'));

  // If we see a prompt ($, #, %) the loop was killed
  const hasPrompt = /[$#%>]\s*$/.test(tmuxContent.trim());
  const hasLoop = tmuxContent.includes('Terminal:');

  if (hasPrompt) {
    console.log('✓ Ctrl+C killed the loop — shell prompt visible');
  } else if (hasLoop) {
    console.log('? Loop text present — checking if it stopped...');
    // Wait and check again
    await sleep(3000);
    const tmuxContent2 = execSync('tmux capture-pane -t resize-test -p').toString();
    if (tmuxContent2 === tmuxContent) {
      console.log('✓ Ctrl+C stopped the loop (output unchanged after 3s)');
    } else {
      console.log('✗ Loop still running — Ctrl+C may not have reached tmux');
    }
  }

  await browser.close();
}
run().catch(e => { console.error('Fatal:', e); process.exit(1); });
