import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from './sgr-parser.mjs';

// Helper: default span fields
function span(overrides) {
  return {
    text: '',
    cls: null,
    fg: null,
    bg: null,
    bgCls: null,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    strikethrough: false,
    reverse: false,
    hidden: false,
    overline: false,
    underlineColor: null,
    url: null,
    ...overrides,
  };
}

// 1. Plain text with no escapes → single span with all defaults
test('plain text no escapes', () => {
  const result = parseLine('hello world');
  assert.deepEqual(result, [span({ text: 'hello world' })]);
});

// 2. Bold text with reset → two spans, first bold, second not
test('bold text with reset', () => {
  const result = parseLine('\x1b[1mBOLD\x1b[0m normal');
  assert.deepEqual(result, [
    span({ text: 'BOLD', bold: true }),
    span({ text: ' normal' }),
  ]);
});

// 3. Standard foreground colors (31=c1, 32=c2)
test('standard foreground colors', () => {
  const result = parseLine('\x1b[31mred\x1b[32mgreen\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'red', cls: 'c1' }),
    span({ text: 'green', cls: 'c2' }),
  ]);
});

// 4. Bright foreground colors (91=cb1)
test('bright foreground colors', () => {
  const result = parseLine('\x1b[91mbright\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'bright', cls: 'cb1' }),
  ]);
});

// 5. Standard background colors (41=bc1)
test('standard background colors', () => {
  const result = parseLine('\x1b[41mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bgCls: 'bc1' }),
  ]);
});

// 6. Bright background colors (101=bcb1)
test('bright background colors', () => {
  const result = parseLine('\x1b[101mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bgCls: 'bcb1' }),
  ]);
});

// 7. 256-color foreground (38;5;82 = #5fff00) → fg field set, cls null
test('256-color foreground high index', () => {
  const result = parseLine('\x1b[38;5;82mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', fg: '#5fff00' }),
  ]);
});

// 8. 256-color foreground for standard colors (38;5;1) → cls=c1, fg=null
test('256-color foreground standard color index', () => {
  const result = parseLine('\x1b[38;5;1mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', cls: 'c1' }),
  ]);
});

// 9. Truecolor foreground (38;2;255;128;0 = #ff8000)
test('truecolor foreground', () => {
  const result = parseLine('\x1b[38;2;255;128;0mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', fg: '#ff8000' }),
  ]);
});

// 10. 256-color background (48;5;196 = #ff0000)
test('256-color background', () => {
  const result = parseLine('\x1b[48;5;196mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bg: '#ff0000' }),
  ]);
});

// 11. Truecolor background (48;2;0;0;255 = #0000ff)
test('truecolor background', () => {
  const result = parseLine('\x1b[48;2;0;0;255mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bg: '#0000ff' }),
  ]);
});

// 12. Multiple attributes (1;3;4 = bold+italic+underline)
test('multiple attributes in one sequence', () => {
  const result = parseLine('\x1b[1;3;4mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bold: true, italic: true, underline: true }),
  ]);
});

// 13. Dim and strikethrough (2;9)
test('dim and strikethrough', () => {
  const result = parseLine('\x1b[2;9mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', dim: true, strikethrough: true }),
  ]);
});

// 14. Cancel codes (22 cancels bold, 23 cancels italic)
test('cancel bold and italic', () => {
  const result = parseLine('\x1b[1;3mtext\x1b[22;23mmore\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', bold: true, italic: true }),
    span({ text: 'more' }),
  ]);
});

// 15. Default fg/bg reset codes (39, 49)
test('default fg and bg reset', () => {
  const result = parseLine('\x1b[31;41mtext\x1b[39;49mmore\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', cls: 'c1', bgCls: 'bc1' }),
    span({ text: 'more' }),
  ]);
});

// 16. Combined fg and bg in same sequence
test('combined fg and bg in same sequence', () => {
  const result = parseLine('\x1b[32;42mtext\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'text', cls: 'c2', bgCls: 'bc2' }),
  ]);
});

// 17. Empty string → empty array
test('empty string', () => {
  const result = parseLine('');
  assert.deepEqual(result, []);
});

// 18. Reset with no prior style → no extra spans
test('reset with no prior style', () => {
  const result = parseLine('\x1b[0mhello');
  assert.deepEqual(result, [
    span({ text: 'hello' }),
  ]);
});

// 19. Non-SGR escape sequences skipped (e.g., \x1b[H is cursor positioning)
test('non-SGR escape sequences skipped', () => {
  const result = parseLine('ab\x1b[Hcd');
  assert.deepEqual(result, [
    span({ text: 'abcd' }),
  ]);
});

// 20. Truncated truecolor fg (38;2;255;128 — missing blue) → no color applied
test('handles truncated truecolor fg gracefully', () => {
  const spans = parseLine('\x1b[38;2;255;128mtext');
  assert.equal(spans[0].text, 'text');
  assert.equal(spans[0].fg, null);
});

// 21. Truncated truecolor bg (48;2;255 — missing green and blue) → no color applied
test('handles truncated truecolor bg gracefully', () => {
  const spans = parseLine('\x1b[48;2;255mtext');
  assert.equal(spans[0].text, 'text');
  assert.equal(spans[0].bg, null);
});

// 22. 38;5 with missing index → no color applied
test('handles 38;5 with missing index gracefully', () => {
  const spans = parseLine('\x1b[38;5mtext');
  assert.equal(spans[0].text, 'text');
  assert.equal(spans[0].fg, null);
  assert.equal(spans[0].cls, null);
});

test('SGR 7 reverse video', () => {
  const result = parseLine('\x1b[7mREVERSE\x1b[27m normal');
  assert.deepEqual(result, [
    span({ text: 'REVERSE', reverse: true }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 8 hidden text', () => {
  const result = parseLine('\x1b[8mHIDDEN\x1b[28m visible');
  assert.deepEqual(result, [
    span({ text: 'HIDDEN', hidden: true }),
    span({ text: ' visible' }),
  ]);
});

test('SGR 53 overline', () => {
  const result = parseLine('\x1b[53mOVER\x1b[55m normal');
  assert.deepEqual(result, [
    span({ text: 'OVER', overline: true }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 58;5;N underline color 256', () => {
  const result = parseLine('\x1b[4;58;5;196mCOLORED\x1b[59;24m normal');
  assert.deepEqual(result, [
    span({ text: 'COLORED', underline: true, underlineColor: '#ff0000' }),
    span({ text: ' normal' }),
  ]);
});

test('SGR 58;2;R;G;B underline color truecolor', () => {
  const result = parseLine('\x1b[4;58;2;255;128;0mTC\x1b[59;24m normal');
  assert.deepEqual(result, [
    span({ text: 'TC', underline: true, underlineColor: '#ff8000' }),
    span({ text: ' normal' }),
  ]);
});

test('tmux colon sub-parameter for overline (5:3)', () => {
  const result = parseLine('\x1b[5:3mOVER\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'OVER', overline: true }),
  ]);
});

test('OSC 8 hyperlink sets span.url', () => {
  const result = parseLine('\x1b]8;;http://example.com\x1b\\Click Here\x1b]8;;\x1b\\');
  assert.deepEqual(result, [
    span({ text: 'Click Here', url: 'http://example.com' }),
  ]);
});

test('OSC 8 with styled text preserves both', () => {
  const result = parseLine('\x1b[1m\x1b]8;;http://test.com\x1b\\BOLD LINK\x1b]8;;\x1b\\\x1b[0m');
  assert.deepEqual(result, [
    span({ text: 'BOLD LINK', bold: true, url: 'http://test.com' }),
  ]);
});

test('OSC 8 with params field (ignored)', () => {
  const result = parseLine('\x1b]8;id=123;http://example.com\x1b\\Link\x1b]8;;\x1b\\');
  assert.deepEqual(result, [
    span({ text: 'Link', url: 'http://example.com' }),
  ]);
});

test('unknown OSC stripped cleanly', () => {
  const result = parseLine('before\x1b]99;some data\x07after');
  assert.deepEqual(result, [
    span({ text: 'beforeafter' }),
  ]);
});

test('OSC terminated by BEL', () => {
  const result = parseLine('\x1b]8;;http://bel.com\x07Link\x1b]8;;\x07');
  assert.deepEqual(result, [
    span({ text: 'Link', url: 'http://bel.com' }),
  ]);
});
