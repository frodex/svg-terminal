// sgr-parser.mjs
// Parses a line of text containing ANSI SGR escape sequences into styled spans.

import { table, fgClass, bgClass } from './color-table.mjs';

function toHex2(n) {
  return n.toString(16).padStart(2, '0');
}

function defaultStyle() {
  return {
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
  };
}

function stylesEqual(a, b) {
  return (
    a.cls === b.cls &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bgCls === b.bgCls &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim &&
    a.strikethrough === b.strikethrough &&
    a.reverse === b.reverse &&
    a.hidden === b.hidden &&
    a.overline === b.overline &&
    a.underlineColor === b.underlineColor &&
    a.url === b.url
  );
}

function applyParams(params, style) {
  const next = { ...style };
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === 0) {
      // Reset all
      Object.assign(next, defaultStyle());
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 5 && params[i + 1] === 3) {
      // tmux colon sub-parameter: 5:3 → overline (SGR 53)
      next.overline = true;
      i++;
    } else if (code === 7) {
      next.reverse = true;
    } else if (code === 8) {
      next.hidden = true;
    } else if (code === 9) {
      next.strikethrough = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 27) {
      next.reverse = false;
    } else if (code === 28) {
      next.hidden = false;
    } else if (code === 29) {
      next.strikethrough = false;
    } else if (code === 53) {
      next.overline = true;
    } else if (code === 55) {
      next.overline = false;
    } else if (code >= 30 && code <= 37) {
      next.cls = fgClass[code - 30];
      next.fg = null;
    } else if (code === 38) {
      const sub = params[i + 1];
      if (sub === 5) {
        // 256-color fg
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) {
          if (n < 16) {
            next.cls = fgClass[n];
            next.fg = null;
          } else {
            next.fg = table[n];
            next.cls = null;
          }
          i += 2;
        }
      } else if (sub === 2) {
        // Truecolor fg
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          next.fg = '#' + toHex2(r) + toHex2(g) + toHex2(b);
          next.cls = null;
          i += 4;
        }
      }
    } else if (code === 39) {
      next.cls = null;
      next.fg = null;
    } else if (code >= 40 && code <= 47) {
      next.bgCls = bgClass[code - 40];
      next.bg = null;
    } else if (code === 48) {
      const sub = params[i + 1];
      if (sub === 5) {
        // 256-color bg
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) {
          if (n < 16) {
            next.bgCls = bgClass[n];
            next.bg = null;
          } else {
            next.bg = table[n];
            next.bgCls = null;
          }
          i += 2;
        }
      } else if (sub === 2) {
        // Truecolor bg
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          next.bg = '#' + toHex2(r) + toHex2(g) + toHex2(b);
          next.bgCls = null;
          i += 4;
        }
      }
    } else if (code === 49) {
      next.bgCls = null;
      next.bg = null;
    } else if (code === 58) {
      const sub = params[i + 1];
      if (sub === 5) {
        // 256-color underline color
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) {
          next.underlineColor = table[n];
          i += 2;
        }
      } else if (sub === 2) {
        // Truecolor underline color
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          next.underlineColor = '#' + toHex2(r) + toHex2(g) + toHex2(b);
          i += 4;
        }
      }
    } else if (code === 59) {
      next.underlineColor = null;
    } else if (code >= 90 && code <= 97) {
      next.cls = fgClass[8 + (code - 90)];
      next.fg = null;
    } else if (code >= 100 && code <= 107) {
      next.bgCls = bgClass[8 + (code - 100)];
      next.bg = null;
    }
    i++;
  }
  return next;
}

export function parseLine(line) {
  const spans = [];
  let style = defaultStyle();
  let text = '';

  let i = 0;
  while (i < line.length) {
    // Detect ESC [
    if (line[i] === '\x1b' && i + 1 < line.length && line[i + 1] === '[') {
      // Scan for final byte (letter)
      let j = i + 2;
      while (j < line.length && (line.charCodeAt(j) < 0x40 || line.charCodeAt(j) > 0x7e)) {
        j++;
      }
      const finalByte = j < line.length ? line[j] : null;
      const paramStr = line.slice(i + 2, j);

      if (finalByte === 'm') {
        // SGR sequence
        // Parse params
        const rawParams = paramStr === '' ? ['0'] : paramStr.split(/[;:]/);
        const params = rawParams.map(p => parseInt(p, 10));

        // Compute new style
        const newStyle = applyParams(params, style);

        // If style changed and we have text buffered, push a span
        if (!stylesEqual(newStyle, style) && text.length > 0) {
          spans.push({ text, ...style });
          text = '';
        }

        style = newStyle;
      }
      // Skip the whole escape sequence (both SGR and non-SGR)
      i = j + 1;
    } else {
      text += line[i];
      i++;
    }
  }

  // Push remaining text
  if (text.length > 0) {
    spans.push({ text, ...style });
  }

  return spans;
}
