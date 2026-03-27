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
