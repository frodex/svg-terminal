// Diagnose: does the terminal SVG actually fill the card?
// Measure card dimensions, object dimensions, SVG viewBox, and rendered area.
import puppeteer from 'puppeteer';
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3200/', { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(5000);

  // Focus a session that looks like greg's
  const sessions = await page.evaluate(() => {
    const items = document.querySelectorAll('.thumbnail-item');
    return Array.from(items).map(el => el.dataset.session);
  });

  // Pick cp-greg or first cp- session
  const target = sessions.find(s => s.includes('greg')) || sessions.find(s => s.startsWith('cp-')) || sessions[0];
  console.log('Targeting:', target);

  await page.evaluate((name) => {
    const items = document.querySelectorAll('.thumbnail-item');
    for (const item of items) {
      if (item.dataset.session === name) { item.click(); return; }
    }
  }, target);
  await sleep(2500);

  // Measure everything
  const measurements = await page.evaluate(() => {
    const card = document.querySelector('.focused');
    if (!card) return { error: 'no focused card' };

    const cardRect = card.getBoundingClientRect();
    const cardStyle = { w: card.style.width, h: card.style.height };

    const obj = card.querySelector('object');
    if (!obj) return { error: 'no object element', cardRect, cardStyle };

    const objRect = obj.getBoundingClientRect();
    const objStyle = {
      w: obj.style.width || window.getComputedStyle(obj).width,
      h: obj.style.height || window.getComputedStyle(obj).height,
      transform: obj.style.transform,
      maxW: window.getComputedStyle(obj).maxWidth,
      maxH: window.getComputedStyle(obj).maxHeight,
    };

    // Check for CSS constraints on the object
    const objComputed = window.getComputedStyle(obj);

    let svgInfo = null;
    try {
      const svgDoc = obj.contentDocument;
      const root = svgDoc && svgDoc.getElementById('root');
      if (root) {
        svgInfo = {
          viewBox: root.getAttribute('viewBox'),
          width: root.getAttribute('width'),
          height: root.getAttribute('height'),
          svgRect: root.getBoundingClientRect()
        };
      }
    } catch (e) {
      svgInfo = { error: e.message };
    }

    // Header height
    const header = card.querySelector('header');
    const headerRect = header ? header.getBoundingClientRect() : null;

    // Inner wrapper
    const inner = card.querySelector('.terminal-inner');
    const innerRect = inner ? inner.getBoundingClientRect() : null;
    const innerStyle = inner ? {
      w: inner.style.width || window.getComputedStyle(inner).width,
      h: inner.style.height || window.getComputedStyle(inner).height,
      transform: inner.style.transform
    } : null;

    return {
      cardRect: { x: Math.round(cardRect.x), y: Math.round(cardRect.y), w: Math.round(cardRect.width), h: Math.round(cardRect.height) },
      cardStyle,
      objRect: { x: Math.round(objRect.x), y: Math.round(objRect.y), w: Math.round(objRect.width), h: Math.round(objRect.height) },
      objStyle,
      objComputed: {
        width: objComputed.width,
        height: objComputed.height,
        maxWidth: objComputed.maxWidth,
        maxHeight: objComputed.maxHeight,
        position: objComputed.position,
      },
      headerRect: headerRect ? { h: Math.round(headerRect.height) } : null,
      innerRect: innerRect ? { w: Math.round(innerRect.width), h: Math.round(innerRect.height) } : null,
      innerStyle,
      svgInfo,
      // Calculate fill percentage
      fillW: objRect.width > 0 ? Math.round(objRect.width / cardRect.width * 100) : 0,
      fillH: objRect.height > 0 ? Math.round(objRect.height / cardRect.height * 100) : 0,
    };
  });

  console.log('\n=== Card Fill Diagnosis ===');
  console.log(JSON.stringify(measurements, null, 2));

  if (measurements.fillW && measurements.fillH) {
    console.log(`\nObject fills ${measurements.fillW}% of card width, ${measurements.fillH}% of card height`);
    if (measurements.fillW < 90 || measurements.fillH < 90) {
      console.log('ISSUE: Terminal is not filling the card!');
    }
  }

  await page.screenshot({ path: '/srv/svg-terminal/test-card-fill.png' });

  // Also screenshot unfocused to see the ring view
  await page.keyboard.press('Escape');
  await sleep(2000);
  await page.screenshot({ path: '/srv/svg-terminal/test-card-fill-unfocused.png' });

  await browser.close();
}
run().catch(e => { console.error('Fatal:', e); process.exit(1); });
