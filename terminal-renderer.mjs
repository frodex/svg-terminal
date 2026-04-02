// terminal-renderer.mjs
// Inline SVG terminal renderer — replaces <object> embed of terminal.svg
// Single WebSocket, same DOM context as dashboard, no cross-frame issues.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Default cell dimensions — updated by measureFont() once rendered
let DEFAULT_CELL_W = 8.65;
let DEFAULT_CELL_H = 17;

/**
 * Create an inline SVG terminal element with all required layers.
 * Returns { svg, api } where api has methods to control the terminal.
 */
export function createInlineTerminal(sessionName, cols, rows) {
  const cellW = DEFAULT_CELL_W;
  const cellH = DEFAULT_CELL_H;

  // Create SVG root — match terminal.svg's root element exactly
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('class', 'terminal-svg');
  svg.setAttribute('data-session', sessionName);
  // Font attributes on root element, same as terminal.svg
  svg.setAttribute('font-family', "'TermFont', 'Cascadia Code', 'Fira Code', Consolas, monospace");
  svg.setAttribute('font-size', '14');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.display = 'block';
  svg.style.pointerEvents = 'none'; // same as <object> — dashboard handles events
  svg.style.backgroundColor = 'transparent';

  // Defs with terminal styles — match terminal.svg exactly
  const defs = document.createElementNS(SVG_NS, 'defs');
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `
    text { dominant-baseline: text-before-edge; white-space: pre; fill: #cccccc; }
    .bold { font-weight: bold; }
    .italic { font-style: italic; }
    .dim { opacity: 0.5; }
    .sel-highlight { fill: rgba(92, 92, 255, 0.3); }
  `;
  defs.appendChild(style);
  svg.appendChild(defs);

  // Hidden measure element for font metrics
  const measureG = document.createElementNS(SVG_NS, 'g');
  measureG.setAttribute('visibility', 'hidden');
  const measureText = document.createElementNS(SVG_NS, 'text');
  measureText.setAttribute('id', 'measure-' + sessionName);
  measureText.setAttribute('x', '0');
  measureText.setAttribute('y', '0');
  measureText.textContent = '0123456789';
  measureG.appendChild(measureText);
  svg.appendChild(measureG);

  // Background layer
  const bgLayer = document.createElementNS(SVG_NS, 'g');
  bgLayer.setAttribute('id', 'bg-' + sessionName);
  svg.appendChild(bgLayer);

  // Text layer
  const textLayer = document.createElementNS(SVG_NS, 'g');
  textLayer.setAttribute('id', 'text-' + sessionName);
  svg.appendChild(textLayer);

  // Link underline layer
  const linkLayer = document.createElementNS(SVG_NS, 'g');
  linkLayer.setAttribute('id', 'link-' + sessionName);
  svg.appendChild(linkLayer);

  // Selection layer
  const selLayer = document.createElementNS(SVG_NS, 'g');
  selLayer.setAttribute('id', 'sel-layer-' + sessionName);
  svg.appendChild(selLayer);

  // Cursor
  const cursor = document.createElementNS(SVG_NS, 'rect');
  cursor.setAttribute('id', 'cursor-' + sessionName);
  cursor.setAttribute('fill', '#ffffff');
  cursor.setAttribute('opacity', '0.7');
  cursor.setAttribute('width', String(cellW));
  cursor.setAttribute('height', String(cellH));
  svg.appendChild(cursor);

  // Blinking cursor animation
  const animate = document.createElementNS(SVG_NS, 'animate');
  animate.setAttribute('attributeName', 'opacity');
  animate.setAttribute('values', '0.7;0;0.7');
  animate.setAttribute('dur', '1.2s');
  animate.setAttribute('repeatCount', 'indefinite');
  cursor.appendChild(animate);

  // State
  let measuredCellW = cellW;
  let measuredCellH = cellH;
  let currentCols = cols;
  let currentRows = rows;
  let allLines = [];
  let ws = null;
  let wsReconnectTimer = null;

  // Measure font after SVG is in the DOM
  function measureFont() {
    try {
      const bbox = measureText.getBBox();
      if (bbox.width > 0) {
        measuredCellW = bbox.width / 10;
        measuredCellH = bbox.height;
      }
    } catch (e) {}
  }

  function initLayout(width, height) {
    currentCols = width;
    currentRows = height;
    while (textLayer.firstChild) textLayer.removeChild(textLayer.firstChild);

    svg.setAttribute('viewBox', '0 0 ' +
      (width * measuredCellW).toFixed(2) + ' ' + (height * measuredCellH));
    cursor.setAttribute('width', measuredCellW.toFixed(2));
    cursor.setAttribute('height', measuredCellH.toFixed(2));

    for (let row = 0; row < height; row++) {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('id', 'r-' + sessionName + '-' + row);
      text.setAttribute('y', String(row * measuredCellH));
      textLayer.appendChild(text);
    }
    allLines = new Array(height).fill(null).map(() => ({ spans: [] }));
  }

  function updateLine(index, spans) {
    const text = textLayer.children[index];
    if (!text) return;
    while (text.firstChild) text.removeChild(text.firstChild);
    let charOffset = 0;
    for (const span of spans) {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.textContent = span.text;
      tspan.setAttribute('x', (charOffset * measuredCellW).toFixed(2));
      const classes = [];
      if (span.cls) classes.push(span.cls);
      if (span.bold) classes.push('bold');
      if (span.italic) classes.push('italic');
      if (span.dim) classes.push('dim');
      if (classes.length) tspan.setAttribute('class', classes.join(' '));
      if (span.fg) tspan.setAttribute('fill', span.fg);
      if (span.underline) tspan.setAttribute('text-decoration', 'underline');
      if (span.strikethrough) tspan.setAttribute('text-decoration', 'line-through');
      text.appendChild(tspan);
      charOffset += span.text.length;
    }
  }

  function rebuildBgLayer(lines) {
    while (bgLayer.firstChild) bgLayer.removeChild(bgLayer.firstChild);
    for (let row = 0; row < lines.length; row++) {
      const spans = lines[row].spans;
      let colOffset = 0;
      for (const span of spans) {
        if (span.bg || span.bgCls) {
          const rect = document.createElementNS(SVG_NS, 'rect');
          rect.setAttribute('x', (colOffset * measuredCellW).toFixed(2));
          rect.setAttribute('y', String(row * measuredCellH));
          rect.setAttribute('width', (span.text.length * measuredCellW).toFixed(2));
          rect.setAttribute('height', String(measuredCellH));
          if (span.bgCls) rect.setAttribute('class', span.bgCls);
          else rect.setAttribute('fill', span.bg);
          bgLayer.appendChild(rect);
        }
        colOffset += span.text.length;
      }
    }
  }

  function rebuildLinkLayer(lines) {
    while (linkLayer.firstChild) linkLayer.removeChild(linkLayer.firstChild);
    for (let row = 0; row < lines.length; row++) {
      const spans = lines[row].spans;
      let colOffset = 0;
      for (const span of spans) {
        if (span.url) {
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', (colOffset * measuredCellW).toFixed(2));
          line.setAttribute('y1', ((row + 1) * measuredCellH - 1).toFixed(2));
          line.setAttribute('x2', ((colOffset + span.text.length) * measuredCellW).toFixed(2));
          line.setAttribute('y2', ((row + 1) * measuredCellH - 1).toFixed(2));
          line.setAttribute('stroke', '#5c8fff');
          line.setAttribute('stroke-width', '1');
          line.setAttribute('opacity', '0.6');
          linkLayer.appendChild(line);
        }
        colOffset += span.text.length;
      }
    }
  }

  function handleMessage(msg) {
    if (msg.type === 'screen') {
      if (currentCols !== msg.width || currentRows !== msg.height) {
        initLayout(msg.width, msg.height);
      }
      allLines = msg.lines;
      for (let i = 0; i < msg.lines.length; i++) {
        updateLine(i, msg.lines[i].spans);
      }
      rebuildBgLayer(msg.lines);
      rebuildLinkLayer(msg.lines);
      if (msg.cursor) {
        cursor.setAttribute('x', (msg.cursor.x * measuredCellW).toFixed(2));
        cursor.setAttribute('y', String(msg.cursor.y * measuredCellH));
      }
    } else if (msg.type === 'delta' && msg.changed) {
      for (const [idx, lineData] of Object.entries(msg.changed)) {
        const spans = lineData.spans || lineData;
        const i = parseInt(idx);
        updateLine(i, spans);
        allLines[i] = { spans };
      }
      rebuildBgLayer(allLines);
      rebuildLinkLayer(allLines);
      if (msg.cursor) {
        cursor.setAttribute('x', (msg.cursor.x * measuredCellW).toFixed(2));
        cursor.setAttribute('y', String(msg.cursor.y * measuredCellH));
      }
    }
  }

  function connect() {
    // Wait for TermFont to load before connecting — measurements depend on it
    document.fonts.ready.then(() => {
      measureFont();
      initLayout(currentCols, currentRows);
      _connectWs();
    });
  }

  function _connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + location.host + '/ws/terminal?session=' +
      encodeURIComponent(sessionName) + '&pane=0';
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
      // Re-measure in case font wasn't ready on first try
      measureFont();
      initLayout(currentCols, currentRows);
    };

    ws.onmessage = function(e) {
      handleMessage(JSON.parse(e.data));
    };

    ws.onclose = function() {
      ws = null;
      wsReconnectTimer = setTimeout(_connectWs, 2000);
    };

    ws.onerror = function() {};
  }

  function sendMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function destroy() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  // API returned to the dashboard
  const api = {
    svg,
    connect,
    destroy,
    sendMessage,
    measureFont,
    get allLines() { return allLines; },
    get cols() { return currentCols; },
    get rows() { return currentRows; },
    get cellW() { return measuredCellW; },
    get cellH() { return measuredCellH; },
    get selLayer() { return selLayer; },
    get textLayer() { return textLayer; },
    get websocket() { return ws; },

    // For screenToCell — direct access, no contentDocument needed
    screenToCell(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      if (rect.width < 10) return null;
      const fracX = (clientX - rect.left) / rect.width;
      const fracY = (clientY - rect.top) / rect.height;
      const vb = svg.getAttribute('viewBox');
      if (!vb) return null;
      const parts = vb.split(/\s+/);
      const vbW = parseFloat(parts[2]);
      const vbH = parseFloat(parts[3]);
      const col = Math.floor((fracX * vbW) / measuredCellW);
      const row = Math.floor((fracY * vbH) / measuredCellH);
      return {
        row: Math.max(0, Math.min(row, currentRows - 1)),
        col: Math.max(0, Math.min(col, currentCols - 1)),
        _render: { cols: currentCols, rows: currentRows }
      };
    },

    // Read text content from SVG for copy
    getLineText(row) {
      const text = textLayer.children[row];
      return text ? text.textContent : '';
    }
  };

  // Initial layout
  initLayout(cols, rows);

  return api;
}
