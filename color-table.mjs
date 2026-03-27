// color-table.mjs
// 256-color index → hex string
// Indices 0-15: null (use CSS classes c0-c15 instead)
// Indices 16-231: 6×6×6 color cube
// Indices 232-255: grayscale ramp

const table = new Array(256);

// 0-15: standard colors → null (handled by CSS classes)
for (let i = 0; i < 16; i++) table[i] = null;

// 16-231: 6×6×6 color cube
const cubeLevels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
for (let i = 16; i < 232; i++) {
  const idx = i - 16;
  const r = cubeLevels[Math.floor(idx / 36)];
  const g = cubeLevels[Math.floor((idx % 36) / 6)];
  const b = cubeLevels[idx % 6];
  table[i] = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

// 232-255: grayscale ramp (8 to 238 in steps of 10)
for (let i = 232; i < 256; i++) {
  const g = 8 + (i - 232) * 10;
  table[i] = '#' + g.toString(16).padStart(2, '0').repeat(3);
}

// Standard foreground class names for indices 0-7 and 8-15
const fgClass = [
  'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7',
  'cb0', 'cb1', 'cb2', 'cb3', 'cb4', 'cb5', 'cb6', 'cb7'
];

// Standard background class names for indices 0-7 and 8-15
const bgClass = [
  'bc0', 'bc1', 'bc2', 'bc3', 'bc4', 'bc5', 'bc6', 'bc7',
  'bcb0', 'bcb1', 'bcb2', 'bcb3', 'bcb4', 'bcb5', 'bcb6', 'bcb7'
];

export { table, fgClass, bgClass };
